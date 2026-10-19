/*
 * This file is part of paged (https://paged.media).
 *
 * paged is free software: you may redistribute it and/or modify it under the
 * terms of the GNU Affero General Public License, version 3, as published by
 * the Free Software Foundation, OR under the Paged Media Enterprise License
 * (PMEL), a commercial license available from And The Next GmbH. Full
 * copyright and license information is available in LICENSE.md, distributed
 * with this source code.
 *
 * paged is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the licenses for details.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

//! CPU rasterizer on `vello_cpu`.
//!
//! The CPU lane draws the model the GPU lane draws: the display list
//! becomes kurbo paths, peniko paints, strokes and blend modes through
//! [`crate::vello_map`], the one mapping both lanes share, and
//! `vello_cpu` (the CPU renderer of Vello's release train) rasterizes
//! them with the same area-coverage antialiasing, gradient ramps, image
//! sampling and blend formulae Vello runs on the GPU. This lane is the
//! path of record: the fidelity gates hold it to InDesign, and the GPU
//! lane is held to it (`corpus/generated/parity-diff.sh`).
//!
//! # How a page is composed
//!
//! The page is one isolated group over the paper, as in the GPU lane
//! and as PDF defines it: everything draws into a transparent page
//! buffer and the result is composited over `RasterOptions::background`
//! at the end. A blend mode over a pixel nothing has painted reads an
//! empty backdrop and shows the source unchanged — a `Multiply` or
//! `Screen` object on blank paper keeps its own colour — while over a
//! painted pixel, white included, it blends.
//!
//! Each transparency group, layer and soft-mask capture draws into a
//! [`Surface`] of its own, sized to its bounds, and composites onto the
//! surface under it when it closes, with its blend mode and opacity.
//! Clips are clip paths on the surface they were pushed on; a soft mask
//! is a coverage mask on it. Drawing is deferred: commands accumulate in
//! the surface's `vello_cpu::RenderContext` and only rasterize when
//! something needs the pixels.
//!
//! What a Vello layer cannot express, this lane computes on pixels,
//! reading the surface it draws into:
//!
//!  * a non-isolated `Normal` group whose members blend starts as a
//!    copy of its backdrop and fades the backdrop toward its result by
//!    its opacity, so a `Multiply` member multiplies with the page;
//!  * a knockout group composites each member onto the group's initial
//!    backdrop, and the result replaces what the members before it drew;
//!  * a `*Overprint` draw composites per ink (see [`crate::ink_planes`]);
//!  * a feather fades the object toward what was behind it before it
//!    painted (a copy of the target taken at the start of its run);
//!  * a gradient feather, a Gaussian-blur layer and a drop shadow are
//!    convolutions and masks over buffers.
//!
//! A non-isolated `Normal` group whose members only paint `Normal`
//! needs none of that — its copy-and-fade result IS the isolated
//! composite — so it composites like any group, and at full opacity it
//! is drawn straight into its parent under a clip of its bounds.

use std::sync::Arc;

use image::{Rgba, RgbaImage};
use paged_compose::{
    BlendMode, Color as ComposeColor, DirectionalFeather, DisplayCommand, DisplayList, Feather,
    FeatherCornerType, GradientFeather, GradientFeatherKind, LayerEffect, Paint, PathData,
    Transform as CTransform,
};
use vello_cpu::kurbo::{Affine, BezPath, Rect as KRect, Shape};
use vello_cpu::peniko::{
    BlendMode as PenikoBlendMode, Compose, Extend, Fill, ImageAlphaType, ImageQuality,
    ImageSampler, Mix,
};
use vello_cpu::{
    Image, ImageSource, Level, Mask, PixelMetadata, Pixmap, RasterizerSettings, RenderContext,
    RenderMode, RenderSettings, Resources, TargetInit,
};

use crate::ink_planes::{self, CmykPlanes, Coverage};
use crate::vello_map::{self, PaintBrush};
use crate::{PathRasterizer, RasterOptions};

/// `PathRasterizer` backed by `vello_cpu`. No GPU required.
#[derive(Debug, Default, Clone, Copy)]
pub struct CpuRasterizer;

impl PathRasterizer for CpuRasterizer {
    fn name(&self) -> &'static str {
        "cpu/vello_cpu"
    }

    fn rasterize(&self, list: &DisplayList, options: &RasterOptions) -> Vec<u8> {
        rasterize(list, options).into_raw()
    }
}

/// Rasterise `list` to an 8-bit sRGB RGBA image at the configured DPI.
///
/// The buffer is premultiplied — over an opaque background, as every
/// caller in this workspace uses, that is the same as straight alpha.
pub fn rasterize(list: &DisplayList, options: &RasterOptions) -> RgbaImage {
    rasterize_inner(list, options, false).0
}

/// Rasterise AND hand back the ink separation the render produced.
///
/// The image is bit-identical to [`rasterize`]'s for the same input:
/// the plane state only ever feeds the overprint composite, which both
/// entry points run the same way, and is read out after the last draw.
/// See [`crate::separations`] for what a separation does and does not
/// know.
pub fn rasterize_with_separation(
    list: &DisplayList,
    options: &RasterOptions,
) -> (RgbaImage, crate::separations::Separation) {
    let (px_w, px_h) = options.pixel_size();
    let (image, planes) = rasterize_inner(list, options, true);
    let separation = crate::separations::Separation::from_planes(planes.as_ref(), list, px_w, px_h);
    (image, separation)
}

/// The largest buffer side `vello_cpu` addresses (its sizes are `u16`).
const MAX_SIDE: u32 = u16::MAX as u32;

fn render_settings() -> RenderSettings {
    RenderSettings {
        level: Level::try_detect().unwrap_or(Level::baseline()),
        num_threads: 0,
    }
}

fn raster_settings(target_init: TargetInit) -> RasterizerSettings {
    RasterizerSettings {
        render_mode: RenderMode::OptimizeSpeed,
        target_init,
        ..RasterizerSettings::default()
    }
}

/// Linear-light colour → premultiplied sRGB RGBA8, the pixel the paper
/// and the effect stamps are written as.
fn premul_rgba8(c: ComposeColor) -> [u8; 4] {
    let s = vello_map::linear_to_peniko(c).to_rgba8();
    let a = s.a as u32;
    let pre = |v: u8| ((v as u32 * a + 127) / 255) as u8;
    [pre(s.r), pre(s.g), pre(s.b), s.a]
}

/// A clip on a surface: a page-space path, or a coverage mask (a soft
/// mask) in the surface's own pixels.
enum Clip {
    Path(BezPath),
    Mask,
}

/// One render target: a premultiplied RGBA8 buffer plus the draws not
/// yet rasterized into it.
struct Surface {
    w: u32,
    h: u32,
    /// Top-left in page pixels.
    offset: (i32, i32),
    /// Page pt → this surface's pixels.
    xform: Affine,
    px: Pixmap,
    /// The buffer holds pixels (it is not known to be blank).
    has_base: bool,
    ctx: RenderContext,
    /// `ctx` holds draws the buffer does not show yet.
    dirty: bool,
    /// `ctx` begins by drawing the buffer's previous content, so it
    /// renders into a cleared buffer.
    injected: bool,
    clips: Vec<Clip>,
    /// Running product of the soft masks on the clip stack, one entry
    /// per `Clip::Mask` — the top is what draws are masked by.
    masks: Vec<Arc<Vec<u8>>>,
    id: u64,
}

impl Surface {
    fn new(w: u32, h: u32, offset: (i32, i32), scale: f32, id: u64) -> Self {
        let (w, h) = (w.clamp(1, MAX_SIDE), h.clamp(1, MAX_SIDE));
        let xform = Affine::translate((-offset.0 as f64, -offset.1 as f64))
            * Affine::scale(scale as f64);
        let mut s = Self {
            w,
            h,
            offset,
            xform,
            px: Pixmap::new(w as u16, h as u16),
            has_base: false,
            ctx: RenderContext::new_with(w as u16, h as u16, render_settings()),
            dirty: false,
            injected: false,
            clips: Vec::new(),
            masks: Vec::new(),
            id,
        };
        s.apply_state();
        s
    }

    /// Re-establish the transform, fill rule, clip paths and mask on a
    /// freshly reset context.
    fn apply_state(&mut self) {
        self.ctx.set_transform(self.xform);
        self.ctx.set_fill_rule(Fill::NonZero);
        for clip in &self.clips {
            if let Clip::Path(p) = clip {
                self.ctx.push_clip_path(p);
            }
        }
        if let Some(m) = self.masks.last() {
            self.ctx
                .set_mask(Mask::from_parts(m.as_ref().clone(), self.w as u16, self.h as u16));
        }
    }

    /// Rasterize every pending draw into the buffer.
    fn flush(&mut self, res: &mut Resources) {
        if !self.dirty {
            return;
        }
        self.ctx.flush();
        let init = if self.injected || !self.has_base {
            TargetInit::Clear(vello_cpu::color::AlphaColor::TRANSPARENT)
        } else {
            TargetInit::SrcOver
        };
        self.ctx
            .render_with(self.px.as_mut(), res, raster_settings(init));
        self.ctx.reset();
        self.dirty = false;
        self.injected = false;
        self.has_base = true;
        self.apply_state();
    }

    /// The buffer, every pending draw rasterized into it.
    fn pixels(&mut self, res: &mut Resources) -> &mut [u8] {
        self.flush(res);
        self.has_base = true;
        self.px.data_as_u8_slice_mut()
    }

    /// Before a draw that blends with what it lands on: `vello_cpu`
    /// treats the root of a context as an isolated group as soon as
    /// something blends into it, so a buffer that already holds pixels
    /// is first drawn INTO the context — the blend then reads them as
    /// the draws before it would.
    fn before_blend(&mut self, res: &mut Resources) {
        if !self.has_base || self.injected {
            return;
        }
        self.flush(res);
        let base = std::mem::replace(&mut self.px, Pixmap::new(self.w as u16, self.h as u16));
        self.ctx.reset();
        self.ctx.set_transform(Affine::IDENTITY);
        self.ctx.set_paint(Image {
            image: ImageSource::Pixmap(Arc::new(base)),
            sampler: nearest(),
        });
        self.ctx
            .fill_rect(&KRect::new(0.0, 0.0, self.w as f64, self.h as f64));
        self.dirty = true;
        self.injected = true;
        self.apply_state();
    }

    fn ctx(&mut self) -> &mut RenderContext {
        self.dirty = true;
        &mut self.ctx
    }

    fn set_brush(&mut self, brush: PaintBrush) {
        set_brush(self.ctx(), brush);
    }

    fn fill(&mut self, res: &mut Resources, path: &BezPath, brush: PaintBrush, blend: PenikoBlendMode) {
        let blends = blend != PenikoBlendMode::default();
        if blends {
            self.before_blend(res);
        }
        self.set_brush(brush);
        let ctx = self.ctx();
        if blends {
            ctx.set_blend_mode(blend);
        }
        ctx.fill_path(path);
        if blends {
            ctx.set_blend_mode(PenikoBlendMode::default());
        }
    }

    fn stroke(&mut self, path: &BezPath, stroke: vello_cpu::kurbo::Stroke, brush: PaintBrush) {
        self.set_brush(brush);
        let ctx = self.ctx();
        ctx.set_stroke(stroke);
        ctx.stroke_path(path);
    }

    /// Draw `img` with `to_px` mapping its pixel grid to this surface's
    /// pixels.
    fn draw_image(
        &mut self,
        res: &mut Resources,
        img: Arc<Pixmap>,
        to_px: Affine,
        sampler: ImageSampler,
        blend: PenikoBlendMode,
    ) {
        let blends = blend != PenikoBlendMode::default();
        if blends {
            self.before_blend(res);
        }
        let (iw, ih) = (img.width() as f64, img.height() as f64);
        let xform = self.xform;
        let ctx = self.ctx();
        ctx.set_transform(to_px);
        ctx.set_paint(Image {
            image: ImageSource::Pixmap(img),
            sampler,
        });
        if blends {
            ctx.set_blend_mode(blend);
        }
        ctx.fill_rect(&KRect::new(0.0, 0.0, iw, ih));
        if blends {
            ctx.set_blend_mode(PenikoBlendMode::default());
        }
        ctx.set_transform(xform);
    }

    fn push_clip(&mut self, path: BezPath) {
        self.ctx.push_clip_path(&path);
        self.clips.push(Clip::Path(path));
    }

    /// Push a soft mask (`w × h` coverage in this surface's pixels).
    fn push_mask(&mut self, mut mask: Vec<u8>) {
        if let Some(parent) = self.masks.last() {
            for (m, p) in mask.iter_mut().zip(parent.iter()) {
                *m = ((*m as u16 * *p as u16 + 127) / 255) as u8;
            }
        }
        self.ctx
            .set_mask(Mask::from_parts(mask.clone(), self.w as u16, self.h as u16));
        self.masks.push(Arc::new(mask));
        self.clips.push(Clip::Mask);
    }

    fn pop_clip(&mut self) {
        match self.clips.pop() {
            Some(Clip::Path(_)) => self.ctx.pop_clip(),
            Some(Clip::Mask) => {
                self.masks.pop();
                match self.masks.last() {
                    Some(m) => self.ctx.set_mask(Mask::from_parts(
                        m.as_ref().clone(),
                        self.w as u16,
                        self.h as u16,
                    )),
                    None => self.ctx.reset_mask(),
                }
            }
            None => {}
        }
    }

    fn has_clip(&self) -> bool {
        !self.clips.is_empty()
    }

    /// The clip's coverage over a `w × h` region at `(x, y)` (this
    /// surface's pixels): clip paths and soft masks multiplied. `None`
    /// when nothing clips.
    fn clip_coverage(
        &self,
        scratch: &mut Scratch,
        res: &mut Resources,
        x: i32,
        y: i32,
        w: u32,
        h: u32,
    ) -> Option<Vec<u8>> {
        if !self.has_clip() {
            return None;
        }
        let paths: Vec<&BezPath> = self
            .clips
            .iter()
            .filter_map(|c| match c {
                Clip::Path(p) => Some(p),
                Clip::Mask => None,
            })
            .collect();
        let region = Affine::translate((-x as f64, -y as f64)) * self.xform;
        let mut cov = if paths.is_empty() {
            vec![255u8; (w as usize) * (h as usize)]
        } else {
            let pix = scratch.render(res, w, h, |ctx| {
                ctx.set_transform(region);
                for p in &paths {
                    ctx.push_clip_path(p);
                }
                ctx.set_transform(Affine::IDENTITY);
                ctx.set_paint(vello_cpu::color::palette::css::WHITE);
                ctx.fill_rect(&KRect::new(0.0, 0.0, w as f64, h as f64));
            })?;
            alpha_of(&pix)
        };
        if let Some(m) = self.masks.last() {
            for j in 0..h as i32 {
                for i in 0..w as i32 {
                    let (sx, sy) = (x + i, y + j);
                    let v = if sx < 0 || sy < 0 || sx >= self.w as i32 || sy >= self.h as i32 {
                        0
                    } else {
                        m[(sy as u32 * self.w + sx as u32) as usize]
                    };
                    let c = &mut cov[(j as u32 * w + i as u32) as usize];
                    *c = ((*c as u16 * v as u16 + 127) / 255) as u8;
                }
            }
        }
        Some(cov)
    }
}

fn set_brush(ctx: &mut RenderContext, brush: PaintBrush) {
    match brush {
        PaintBrush::Solid(c) => ctx.set_paint(c),
        PaintBrush::Gradient(g) => ctx.set_paint(g),
    }
}

fn nearest() -> ImageSampler {
    ImageSampler::new()
        .with_extend(Extend::Pad)
        .with_quality(ImageQuality::Low)
}

fn alpha_of(pix: &Pixmap) -> Vec<u8> {
    pix.data().iter().map(|p| p.a).collect()
}

/// A reusable context for small offscreen renders: draw coverage,
/// shadow stamps, clip coverage.
struct Scratch {
    ctx: Option<RenderContext>,
}

impl Scratch {
    /// Render `draw` into a fresh, transparent `w × h` buffer.
    fn render(
        &mut self,
        res: &mut Resources,
        w: u32,
        h: u32,
        draw: impl FnOnce(&mut RenderContext),
    ) -> Option<Pixmap> {
        if w == 0 || h == 0 || w > MAX_SIDE || h > MAX_SIDE {
            return None;
        }
        let ctx = match self.ctx.as_mut() {
            Some(ctx) => {
                ctx.reset_and_resize(w as u16, h as u16);
                ctx
            }
            None => self
                .ctx
                .insert(RenderContext::new_with(w as u16, h as u16, render_settings())),
        };
        ctx.set_fill_rule(Fill::NonZero);
        draw(ctx);
        ctx.flush();
        let mut pix = Pixmap::new(w as u16, h as u16);
        ctx.render_with(
            pix.as_mut(),
            res,
            raster_settings(TargetInit::Clear(vello_cpu::color::AlphaColor::TRANSPARENT)),
        );
        Some(pix)
    }
}

/// What a frame on the group stack is.
enum FrameKind {
    /// A transparency group or layer with a buffer of its own.
    Group {
        blend: BlendMode,
        opacity: f32,
        /// The buffer started as a copy of its backdrop: the pop fades
        /// the parent toward it by `opacity`.
        backdrop_copied: bool,
        /// A knockout group's initial backdrop. Each member group
        /// composites onto this, and the result replaces the group's
        /// buffer where the member covers it.
        knockout_base: Option<Vec<u8>>,
        /// Pixel σ of a Gaussian-blur layer, 0 for none.
        blur_sigma_px: f32,
        /// A `PushLayer` (an effect layer), not a `BeginBlendGroup`: a
        /// knockout parent does not knock it out.
        layer: bool,
    },
    /// Capturing soft-mask artwork until `BeginMaskedContent`.
    SoftMask {
        mask_type: paged_compose::SoftMaskType,
        invert: bool,
    },
    /// A group drawn straight into the surface under it: a clip of its
    /// bounds pushed there, popped (with anything above it) at the end.
    Direct { clip_floor: usize },
}

struct Frame {
    surface: Option<Surface>,
    kind: FrameKind,
}

/// The target as it stood before a feathered object painted itself,
/// over exactly the region its feather touches. A feather takes
/// opacity away from the object's OWN paint, so at mask 0 the pixel
/// returns to this.
struct FeatherBackdrop {
    off: (i32, i32),
    w: u32,
    h: u32,
    pixels: Vec<u8>,
    surface: u64,
}

/// Per-group facts the walk needs before the group's members draw.
#[derive(Clone, Copy, Default)]
struct GroupInfo {
    /// Some member reads what it lands on (a non-`Normal` blend, an
    /// overprint, an effect stamp with its own blend mode, a knockout
    /// group): a non-isolated parent must hold its real backdrop.
    reads_backdrop: bool,
}

/// For every `BeginBlendGroup` / `PushLayer` index, the facts about the
/// commands up to its matching end.
fn group_infos(list: &DisplayList) -> std::collections::HashMap<usize, GroupInfo> {
    let mut out = std::collections::HashMap::new();
    let mut open: Vec<(usize, GroupInfo)> = Vec::new();
    for (i, cmd) in list.commands.iter().enumerate() {
        let reads = match cmd {
            DisplayCommand::FillPathBlend { blend_mode, .. } => *blend_mode != BlendMode::Normal,
            DisplayCommand::FillPathOverprint { .. } | DisplayCommand::StrokePathOverprint { .. } => true,
            DisplayCommand::InnerShadow { .. }
            | DisplayCommand::OuterGlow { .. }
            | DisplayCommand::InnerGlow { .. }
            | DisplayCommand::BevelEmboss { .. }
            | DisplayCommand::Satin { .. } => true,
            DisplayCommand::BeginBlendGroup {
                blend_mode, knockout, ..
            } => *blend_mode != BlendMode::Normal || *knockout,
            DisplayCommand::PushLayer { blend_mode, .. } => *blend_mode != BlendMode::Normal,
            _ => false,
        };
        if reads {
            for (_, info) in open.iter_mut() {
                info.reads_backdrop = true;
            }
        }
        match cmd {
            DisplayCommand::BeginBlendGroup { .. } | DisplayCommand::PushLayer { .. } => {
                open.push((i, GroupInfo::default()));
            }
            DisplayCommand::EndBlendGroup(_) | DisplayCommand::PopLayer(_) => {
                if let Some((start, info)) = open.pop() {
                    out.insert(start, info);
                }
            }
            _ => {}
        }
    }
    for (start, info) in open {
        out.insert(start, info);
    }
    out
}

/// Does any `*Overprint` draw carry a CMYK paint? Plane state is only
/// read by those, so without one (and without a separation asked for)
/// the walk skips it.
fn has_cmyk_overprint(list: &DisplayList) -> bool {
    list.commands.iter().any(|c| match c {
        DisplayCommand::FillPathOverprint { paint, .. }
        | DisplayCommand::StrokePathOverprint { paint, .. } => matches!(paint, Paint::Cmyk { .. }),
        _ => false,
    })
}

struct Raster<'a> {
    list: &'a DisplayList,
    scale: f32,
    px_w: u32,
    px_h: u32,
    paper: [u8; 4],
    res: Resources,
    scratch: Scratch,
    page: Surface,
    frames: Vec<Frame>,
    planes: Option<CmykPlanes>,
    want_planes: bool,
    next_id: u64,
}

impl Raster<'_> {
    /// The active surface, the renderer resources and the scratch
    /// context, borrowed together.
    fn split(&mut self) -> (&mut Surface, &mut Resources, &mut Scratch) {
        let surface = self
            .frames
            .iter_mut()
            .rev()
            .find_map(|f| f.surface.as_mut())
            .unwrap_or(&mut self.page);
        (surface, &mut self.res, &mut self.scratch)
    }

    fn active(&mut self) -> &mut Surface {
        self.frames
            .iter_mut()
            .rev()
            .find_map(|f| f.surface.as_mut())
            .unwrap_or(&mut self.page)
    }

    /// The active surface is the page (no buffered group is open).
    fn on_page(&self) -> bool {
        self.frames.iter().all(|f| f.surface.is_none())
    }

    fn new_surface(&mut self, w: u32, h: u32, offset: (i32, i32)) -> Surface {
        self.next_id += 1;
        Surface::new(w, h, offset, self.scale, self.next_id)
    }

    /// The innermost direct frame's clip floor on the active surface:
    /// a stray pop may not reach below it.
    fn clip_floor(&self) -> usize {
        for f in self.frames.iter().rev() {
            match f.kind {
                FrameKind::Direct { clip_floor } if f.surface.is_none() => return clip_floor,
                _ if f.surface.is_some() => return 0,
                _ => {}
            }
        }
        0
    }

    /// Render a draw's coverage through the active surface's clip into a
    /// scratch sized to `bbox_pt` (page pt) padded by `pad_pt`. Returns
    /// the scratch and its top-left in the active surface's pixels.
    fn coverage_scratch(
        &mut self,
        bbox_pt: KRect,
        pad_pt: f64,
        draw: impl FnOnce(&mut RenderContext),
    ) -> Option<(Pixmap, i32, i32)> {
        let surface = self.frames
            .iter()
            .rev()
            .find_map(|f| f.surface.as_ref())
            .unwrap_or(&self.page);
        let (ox, oy, w, h) = scratch_bbox(surface.xform, bbox_pt, pad_pt)?;
        let to_scratch = Affine::translate((-ox as f64, -oy as f64)) * surface.xform;
        let clips: Vec<BezPath> = surface
            .clips
            .iter()
            .filter_map(|c| match c {
                Clip::Path(p) => Some(p.clone()),
                Clip::Mask => None,
            })
            .collect();
        let mask = surface.masks.last().cloned();
        let (sw, sh) = (surface.w, surface.h);
        let mut pix = self.scratch.render(&mut self.res, w, h, |ctx| {
            ctx.set_transform(to_scratch);
            for p in &clips {
                ctx.push_clip_path(p);
            }
            draw(ctx);
        })?;
        if let Some(m) = mask {
            let data = pix.data_as_u8_slice_mut();
            for j in 0..h as i32 {
                for i in 0..w as i32 {
                    let (sx, sy) = (ox + i, oy + j);
                    let v = if sx < 0 || sy < 0 || sx >= sw as i32 || sy >= sh as i32 {
                        0u16
                    } else {
                        m[(sy as u32 * sw + sx as u32) as usize] as u16
                    };
                    let q = ((j as u32 * w + i as u32) * 4) as usize;
                    for c in &mut data[q..q + 4] {
                        *c = ((*c as u16 * v + 127) / 255) as u8;
                    }
                }
            }
        }
        Some((pix, ox, oy))
    }

    /// Splat a page-level CMYK draw into the plane state.
    fn splat(&mut self, paint: &Paint, bbox_pt: KRect, pad_pt: f64, draw: impl FnOnce(&mut RenderContext)) {
        if !self.want_planes || !self.on_page() || !matches!(paint, Paint::Cmyk { .. }) {
            return;
        }
        let Some((scratch, ox, oy)) = self.coverage_scratch(bbox_pt, pad_pt, draw) else {
            return;
        };
        let alpha = alpha_of(&scratch);
        let cov = Coverage {
            alpha: &alpha,
            w: scratch.width() as u32,
            h: scratch.height() as u32,
            off: (ox, oy),
        };
        let (pw, ph) = (self.px_w, self.px_h);
        let planes = self.planes.get_or_insert_with(|| CmykPlanes::new(pw, ph));
        ink_planes::splat_cmyk_draw(planes, self.list, paint, &cov);
    }

    /// An overprint draw: per-ink composite for a CMYK paint, a
    /// `Darken` stamp (the per-channel max of RGB) for any other.
    fn overprint(&mut self, paint: &Paint, transform: &CTransform, path: &BezPath, stroke: Option<vello_cpu::kurbo::Stroke>) {
        let Some(brush) = vello_map::resolve_paint(paint, self.list, transform) else {
            return;
        };
        let bbox = path.bounding_box();
        let pad = stroke.as_ref().map(|s| s.width * 0.5 + 1.0).unwrap_or(1.0);
        if !matches!(paint, Paint::Cmyk { .. }) {
            let (surface, res, _) = self.split();
            surface.before_blend(res);
            surface.set_brush(brush);
            let ctx = surface.ctx();
            ctx.set_blend_mode(PenikoBlendMode::new(Mix::Darken, Compose::SrcOver));
            match stroke {
                Some(s) => {
                    ctx.set_stroke(s);
                    ctx.stroke_path(path);
                }
                None => ctx.fill_path(path),
            }
            ctx.set_blend_mode(PenikoBlendMode::default());
            return;
        }
        let draw = |ctx: &mut RenderContext| {
            set_brush(ctx, brush.clone());
            match &stroke {
                Some(s) => {
                    ctx.set_stroke(s.clone());
                    ctx.stroke_path(path);
                }
                None => ctx.fill_path(path),
            }
        };
        let Some((scratch, ox, oy)) = self.coverage_scratch(bbox, pad, draw) else {
            return;
        };
        let alpha = alpha_of(&scratch);
        let on_page = self.on_page();
        let paper = self.paper;
        let (pw, ph) = (self.px_w, self.px_h);
        if on_page && self.planes.is_none() {
            self.planes = Some(CmykPlanes::new(pw, ph));
        }
        let cov = Coverage {
            alpha: &alpha,
            w: scratch.width() as u32,
            h: scratch.height() as u32,
            off: (ox, oy),
        };
        let list = self.list;
        let planes = if on_page { self.planes.as_mut() } else { None };
        let surface = self
            .frames
            .iter_mut()
            .rev()
            .find_map(|f| f.surface.as_mut())
            .unwrap_or(&mut self.page);
        let res = &mut self.res;
        let (w, h) = (surface.w, surface.h);
        let data = surface.pixels(res);
        ink_planes::compose_overprint(
            ink_planes::Target {
                data,
                w,
                h,
                paper: on_page.then_some(paper),
            },
            planes,
            list,
            paint,
            &cov,
        );
    }

    fn run(&mut self, options: &RasterOptions) {
        let list = self.list;
        let scale = self.scale;
        let infos = group_infos(list);
        let feather_starts = paged_compose::mask::feather_run_starts(list);
        let mut feather_backdrop: Option<FeatherBackdrop> = None;

        let snapped: std::collections::HashSet<usize> = match &list.glyph_runs {
            Some(table) if options.snap_glyph_origins => table
                .entries
                .iter()
                .filter(|e| !e.is_stroke)
                .map(|e| e.command_index as usize)
                .collect(),
            _ => Default::default(),
        };
        // Splash's glyph cache: four horizontal sub-pixel phases, none
        // vertical (measured against this gate's references).
        let snap = |idx: usize, t: &CTransform| -> CTransform {
            if !snapped.contains(&idx) {
                return *t;
            }
            let mut m = t.0;
            m[4] = (m[4] * scale * 4.0).floor() / (scale * 4.0);
            m[5] = (m[5] * scale).floor() / scale;
            CTransform(m)
        };

        for (idx, cmd) in list.commands.iter().enumerate() {
            if let Some(feather_idx) = feather_starts.get(&idx).copied() {
                feather_backdrop = self.feather_snapshot(feather_idx);
            }
            match cmd {
                DisplayCommand::FillPath {
                    path_id,
                    paint,
                    transform,
                }
                | DisplayCommand::FillPathBlend {
                    path_id,
                    paint,
                    transform,
                    ..
                } => {
                    let blend = match cmd {
                        DisplayCommand::FillPathBlend { blend_mode, .. } => *blend_mode,
                        _ => BlendMode::Normal,
                    };
                    let transform = snap(idx, transform);
                    let Some(data) = list.paths.get(*path_id) else {
                        continue;
                    };
                    let path = vello_map::path_to_bez(data, &transform);
                    let Some(brush) = vello_map::resolve_paint(paint, list, &transform) else {
                        continue;
                    };
                    let splat_brush = (blend == BlendMode::Normal).then(|| brush.clone());
                    let (surface, res, _) = self.split();
                    surface.fill(res, &path, brush, vello_map::blend_to_peniko(blend));
                    if let Some(brush) = splat_brush {
                        self.splat(paint, path.bounding_box(), 1.0, |ctx| {
                            set_brush(ctx, brush);
                            ctx.fill_path(&path);
                        });
                    }
                }
                DisplayCommand::StrokePath {
                    path_id,
                    paint,
                    stroke,
                    transform,
                } => {
                    let Some(data) = list.paths.get(*path_id) else {
                        continue;
                    };
                    let path = vello_map::path_to_bez(data, transform);
                    let Some(brush) = vello_map::resolve_paint(paint, list, transform) else {
                        continue;
                    };
                    let ks = vello_map::kurbo_stroke(stroke);
                    self.active().stroke(&path, ks.clone(), brush.clone());
                    let pad = ks.width * 0.5 + 1.0;
                    self.splat(paint, path.bounding_box(), pad, |ctx| {
                        set_brush(ctx, brush);
                        ctx.set_stroke(ks);
                        ctx.stroke_path(&path);
                    });
                }
                DisplayCommand::FillPathOverprint {
                    path_id,
                    paint,
                    transform,
                } => {
                    let Some(data) = list.paths.get(*path_id) else {
                        continue;
                    };
                    let path = vello_map::path_to_bez(data, transform);
                    self.overprint(paint, transform, &path, None);
                }
                DisplayCommand::StrokePathOverprint {
                    path_id,
                    paint,
                    stroke,
                    transform,
                } => {
                    let Some(data) = list.paths.get(*path_id) else {
                        continue;
                    };
                    let path = vello_map::path_to_bez(data, transform);
                    self.overprint(paint, transform, &path, Some(vello_map::kurbo_stroke(stroke)));
                }
                DisplayCommand::DropShadow {
                    path_id,
                    transform,
                    shadow,
                }
                | DisplayCommand::PathShadow {
                    path_id,
                    transform,
                    shadow,
                } => {
                    let Some(data) = list.paths.get(*path_id) else {
                        continue;
                    };
                    let mut shifted = *transform;
                    shifted.0[4] += shadow.offset_x;
                    shifted.0[5] += shadow.offset_y;
                    let path = vello_map::path_to_bez(data, &shifted);
                    let mut color = shadow.color;
                    color.a *= shadow.opacity.clamp(0.0, 1.0);
                    // PathShadow (glyph and stroke-only shadows, one per
                    // glyph at full alpha in a Normal group) takes a wider
                    // Gaussian than the rect stamp, so the tails reach
                    // into the gaps between glyphs before the group fades
                    // the patch. The rect stamp takes InDesign's measured
                    // mapping: `Size` is the width of the band, σ half it.
                    let sigma_pt = match cmd {
                        DisplayCommand::PathShadow { .. } => shadow.blur_radius.max(0.0) * 3.5,
                        _ => paged_compose::mask::outer_sigma_pt(shadow.blur_radius),
                    };
                    self.drop_shadow(&path, color, sigma_pt, shadow.spread, shadow.noise);
                }
                DisplayCommand::Image {
                    image_id,
                    transform,
                } => {
                    let Some(img) = list.image(*image_id) else {
                        continue;
                    };
                    if img.width == 0 || img.height == 0 {
                        continue;
                    }
                    let Some(pixmap) = image_pixmap(img) else {
                        continue;
                    };
                    let [a, b, c, d, tx, ty] = transform.0;
                    let unit_to_page = Affine::new([
                        a as f64, b as f64, c as f64, d as f64, tx as f64, ty as f64,
                    ]);
                    let pixel_to_unit =
                        Affine::scale_non_uniform(1.0 / img.width as f64, 1.0 / img.height as f64);
                    let (surface, res, _) = self.split();
                    let to_px = surface.xform * unit_to_page * pixel_to_unit;
                    surface.draw_image(
                        res,
                        Arc::new(pixmap),
                        to_px,
                        image_sampler(),
                        PenikoBlendMode::default(),
                    );
                }
                DisplayCommand::PushClip { path_id, transform } => {
                    let path = list
                        .paths
                        .get(*path_id)
                        .map(|data| vello_map::path_to_bez(data, transform))
                        // A missing path clips nothing — but still pushes,
                        // so the matching pop balances.
                        .unwrap_or_else(|| KRect::new(-1.0e6, -1.0e6, 1.0e6, 1.0e6).to_path(0.1));
                    self.active().push_clip(path);
                }
                DisplayCommand::PopClip(_) | DisplayCommand::EndSoftMask(_) => {
                    let floor = self.clip_floor();
                    let surface = self.active();
                    if surface.clips.len() > floor {
                        surface.pop_clip();
                    }
                }
                DisplayCommand::BeginSoftMask {
                    mask_type, invert, ..
                } => {
                    // Captured at the size of the ACTIVE target, so the
                    // mask is pixel-aligned with it.
                    let (w, h, off) = {
                        let s = self.active();
                        (s.w, s.h, s.offset)
                    };
                    let surface = self.new_surface(w, h, off);
                    self.frames.push(Frame {
                        surface: Some(surface),
                        kind: FrameKind::SoftMask {
                            mask_type: *mask_type,
                            invert: *invert,
                        },
                    });
                }
                DisplayCommand::BeginMaskedContent(_) => {
                    if !matches!(self.frames.last(), Some(Frame { kind: FrameKind::SoftMask { .. }, .. }))
                    {
                        continue; // stray marker — tolerated
                    }
                    let Some(Frame {
                        surface: Some(mut art),
                        kind: FrameKind::SoftMask { mask_type, invert },
                    }) = self.frames.pop()
                    else {
                        continue;
                    };
                    let data = art.pixels(&mut self.res);
                    // Unpainted artwork resolves to 0 = hidden, PDF's
                    // default for both mask types.
                    let mut mask: Vec<u8> = data
                        .as_chunks::<4>()
                        .0
                        .iter()
                        .map(|p| match mask_type {
                            paged_compose::SoftMaskType::Alpha => p[3],
                            paged_compose::SoftMaskType::Luminosity => {
                                // Luma of the premultiplied colour — the
                                // demultiplied luma weighted by alpha.
                                let luma = p[0] as f32 * 0.2126
                                    + p[1] as f32 * 0.7152
                                    + p[2] as f32 * 0.0722;
                                (luma + 0.5).min(255.0) as u8
                            }
                        })
                        .collect();
                    if invert {
                        for m in &mut mask {
                            *m = 255 - *m;
                        }
                    }
                    let surface = self.active();
                    if mask.len() == (surface.w as usize) * (surface.h as usize) {
                        surface.push_mask(mask);
                    } else {
                        // Sizes disagree only for a malformed bracket;
                        // push a clip that hides nothing so the pop still
                        // balances.
                        surface.push_clip(KRect::new(-1.0e6, -1.0e6, 1.0e6, 1.0e6).to_path(0.1));
                    }
                }
                DisplayCommand::BeginBlendGroup {
                    bounds,
                    blend_mode,
                    opacity,
                    isolated,
                    knockout,
                    ..
                } => {
                    let info = infos.get(&idx).copied().unwrap_or_default();
                    self.begin_group(*bounds, *blend_mode, *opacity, *isolated, *knockout, None, info);
                }
                DisplayCommand::PushLayer {
                    bounds,
                    effect,
                    blend_mode,
                    opacity,
                    ..
                } => {
                    let info = infos.get(&idx).copied().unwrap_or_default();
                    self.begin_group(*bounds, *blend_mode, *opacity, true, false, Some(*effect), info);
                }
                DisplayCommand::InnerShadow {
                    path_id,
                    transform,
                    params,
                } => {
                    if let Some(data) = list.paths.get(*path_id) {
                        let stamps = paged_compose::mask::inner_shadow_stamps(
                            data,
                            transform,
                            params,
                            (scale * 72.0).max(72.0),
                        );
                        self.effect_stamps(&stamps);
                    }
                }
                DisplayCommand::OuterGlow {
                    path_id,
                    transform,
                    params,
                } => {
                    if let Some(data) = list.paths.get(*path_id) {
                        let stamps = paged_compose::mask::outer_glow_stamps(
                            data,
                            transform,
                            params,
                            (scale * 72.0).max(72.0),
                        );
                        self.effect_stamps(&stamps);
                    }
                }
                DisplayCommand::InnerGlow {
                    path_id,
                    transform,
                    params,
                } => {
                    if let Some(data) = list.paths.get(*path_id) {
                        let stamps = paged_compose::mask::inner_glow_stamps(
                            data,
                            transform,
                            params,
                            (scale * 72.0).max(72.0),
                        );
                        self.effect_stamps(&stamps);
                    }
                }
                DisplayCommand::BevelEmboss {
                    path_id,
                    transform,
                    params,
                } => {
                    if let Some(data) = list.paths.get(*path_id) {
                        let stamps = paged_compose::mask::bevel_emboss_stamps(
                            data,
                            transform,
                            params,
                            (scale * 72.0).max(72.0),
                        );
                        self.effect_stamps(&stamps);
                    }
                }
                DisplayCommand::Satin {
                    path_id,
                    transform,
                    params,
                } => {
                    if let Some(data) = list.paths.get(*path_id) {
                        let stamps = paged_compose::mask::satin_stamps(
                            data,
                            transform,
                            params,
                            (scale * 72.0).max(72.0),
                        );
                        self.effect_stamps(&stamps);
                    }
                }
                DisplayCommand::Feather {
                    path_id,
                    transform,
                    params,
                } => {
                    if let Some(data) = list.paths.get(*path_id) {
                        let backdrop = feather_backdrop.take();
                        self.feather(data, transform, FeatherKind::Plain(params), backdrop);
                    }
                }
                DisplayCommand::DirectionalFeather {
                    path_id,
                    transform,
                    params,
                } => {
                    if let Some(data) = list.paths.get(*path_id) {
                        let backdrop = feather_backdrop.take();
                        self.feather(data, transform, FeatherKind::Directional(params), backdrop);
                    }
                }
                DisplayCommand::GradientFeather {
                    path_id,
                    transform,
                    params,
                } => {
                    if let Some(data) = list.paths.get(*path_id) {
                        let backdrop = feather_backdrop.take();
                        self.feather(data, transform, FeatherKind::Gradient(params), backdrop);
                    }
                }
                DisplayCommand::EndBlendGroup(_) | DisplayCommand::PopLayer(_) => {
                    self.end_group();
                }
            }
        }
        // A malformed list can leave frames open; close them so their
        // content still lands.
        while !self.frames.is_empty() {
            if matches!(self.frames.last(), Some(Frame { kind: FrameKind::SoftMask { .. }, .. })) {
                // Artwork that never reached its content: drop it rather
                // than paint the mask geometry onto the page.
                self.frames.pop();
                continue;
            }
            self.end_group();
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn begin_group(
        &mut self,
        bounds: paged_compose::Rect,
        blend: BlendMode,
        opacity: f32,
        isolated: bool,
        knockout: bool,
        effect: Option<LayerEffect>,
        info: GroupInfo,
    ) {
        let scale = self.scale;
        let opacity = opacity.clamp(0.0, 1.0);
        let bounds_path = KRect::new(
            bounds.x as f64,
            bounds.y as f64,
            (bounds.x + bounds.w) as f64,
            (bounds.y + bounds.h) as f64,
        )
        .to_path(0.1);
        let parent_knockout = matches!(
            self.frames.last(),
            Some(Frame {
                kind: FrameKind::Group {
                    knockout_base: Some(_),
                    ..
                },
                ..
            })
        );
        let sigma_pt = effect.map(|e| e.sigma_pt()).unwrap_or(0.0);

        // A non-isolated Normal group at full opacity whose members only
        // paint Normal is its parent with a clip of its bounds.
        if effect.is_none()
            && !isolated
            && !knockout
            && !parent_knockout
            && blend == BlendMode::Normal
            && opacity >= 1.0
            && !info.reads_backdrop
        {
            let surface = self.active();
            surface.push_clip(bounds_path);
            let clip_floor = surface.clips.len();
            self.frames.push(Frame {
                surface: None,
                kind: FrameKind::Direct { clip_floor },
            });
            return;
        }

        // The buffer: the bounds projected to pixels, snapped outward,
        // with a pixel of antialiasing slack — plus 3σ for a blur's
        // tails. The slack is allocation only: the group's extent is
        // `bounds`, and a clip of it bounds every draw.
        let pad_pt = 3.0 * sigma_pt + 1.0 / scale.max(1e-6);
        let off_x = ((bounds.x - pad_pt) * scale).floor() as i32;
        let off_y = ((bounds.y - pad_pt) * scale).floor() as i32;
        let max_x = ((bounds.x + bounds.w + pad_pt) * scale).ceil() as i32;
        let max_y = ((bounds.y + bounds.h + pad_pt) * scale).ceil() as i32;
        let w = (max_x - off_x).max(1) as u32;
        let h = (max_y - off_y).max(1) as u32;
        let mut surface = self.new_surface(w, h, (off_x, off_y));

        // R-10: a non-isolated Normal group outside a knockout group whose
        // members blend starts as a copy of its backdrop, so a Multiply
        // inside it multiplies with the page (`transparency-targets` 37,
        // 45). Inside a knockout group a member keeps a transparent
        // buffer: its COVERAGE is what knocks the earlier members out.
        let backdrop_copied = effect.is_none()
            && !isolated
            && !parent_knockout
            && blend == BlendMode::Normal
            && (info.reads_backdrop || knockout);
        if backdrop_copied {
            let copy = self.snapshot(off_x, off_y, w, h, true);
            surface.px.data_as_u8_slice_mut().copy_from_slice(&copy);
            surface.has_base = true;
        }
        let knockout_base = knockout.then(|| surface.px.data_as_u8_slice().to_vec());
        // Clip to `bounds` — except a blurred layer, whose blur
        // legitimately paints outside them.
        if sigma_pt <= 0.5 {
            surface.push_clip(bounds_path);
        }
        self.frames.push(Frame {
            surface: Some(surface),
            kind: FrameKind::Group {
                blend,
                opacity,
                backdrop_copied,
                knockout_base,
                blur_sigma_px: if effect.is_some() { sigma_pt * scale } else { 0.0 },
                layer: effect.is_some(),
            },
        });
    }

    /// A copy of the active surface's pixels over a region given in PAGE
    /// pixels (`page_coords`) or the active surface's own. Out-of-buffer
    /// pixels come back transparent.
    fn snapshot(&mut self, x: i32, y: i32, w: u32, h: u32, page_coords: bool) -> Vec<u8> {
        let (surface, res, _) = self.split();
        let (dx, dy) = if page_coords {
            (x - surface.offset.0, y - surface.offset.1)
        } else {
            (x, y)
        };
        let (sw, sh) = (surface.w as i32, surface.h as i32);
        let src = surface.pixels(res);
        copy_region(src, sw, sh, dx, dy, w, h)
    }

    fn end_group(&mut self) {
        let Some(frame) = self.frames.pop() else {
            return;
        };
        let Frame { surface, kind } = frame;
        let (blend, opacity, backdrop_copied, blur_sigma_px, layer) = match kind {
            FrameKind::Direct { clip_floor } => {
                let surface = self.active();
                while surface.clips.len() >= clip_floor && !surface.clips.is_empty() {
                    surface.pop_clip();
                }
                return;
            }
            FrameKind::SoftMask { .. } => {
                // A capture frame is consumed by BeginMaskedContent; one
                // that reaches here came from a malformed list — composite
                // it as an ordinary group rather than lose it.
                (BlendMode::Normal, 1.0, false, 0.0, true)
            }
            FrameKind::Group {
                blend,
                opacity,
                backdrop_copied,
                blur_sigma_px,
                layer,
                ..
            } => (blend, opacity, backdrop_copied, blur_sigma_px, layer),
        };
        let Some(mut group) = surface else {
            return;
        };
        let (gw, gh, goff) = (group.w, group.h, group.offset);
        group.flush(&mut self.res);
        let mut pixmap = std::mem::replace(&mut group.px, Pixmap::new(1, 1));
        if blur_sigma_px > 0.5 {
            let kernel = gaussian_kernel(blur_sigma_px);
            gaussian_blur_premul(pixmap.data_as_u8_slice_mut(), gw, gh, &kernel);
        }

        // R-10: a member of a knockout group composites onto the group's
        // INITIAL backdrop, and the result replaces the group's buffer
        // where the member covers it.
        let parent_has_knockout = matches!(
            self.frames.last(),
            Some(Frame {
                surface: Some(_),
                kind: FrameKind::Group { knockout_base: Some(_), .. },
            })
        );
        if !layer && parent_has_knockout {
            self.knockout_member(pixmap, goff, blend, opacity);
            return;
        }

        if backdrop_copied {
            // The buffer holds the backdrop with the members drawn on
            // it: fade the parent toward it.
            let (parent, res, scratch) = self.split();
            let dst = (goff.0 - parent.offset.0, goff.1 - parent.offset.1);
            let clip = parent.clip_coverage(scratch, res, dst.0, dst.1, gw, gh);
            let (pw, ph) = (parent.w, parent.h);
            let data = parent.pixels(res);
            lerp_region(
                data,
                pw,
                ph,
                dst,
                pixmap.data_as_u8_slice(),
                gw,
                gh,
                opacity,
                None,
                clip.as_deref(),
            );
            return;
        }

        let (parent, res, _) = self.split();
        let dst = (goff.0 - parent.offset.0, goff.1 - parent.offset.1);
        parent.draw_image(
            res,
            Arc::new(pixmap),
            Affine::translate((dst.0 as f64, dst.1 as f64)),
            nearest().with_alpha(opacity),
            vello_map::blend_to_peniko(blend),
        );
    }

    fn knockout_member(&mut self, member: Pixmap, goff: (i32, i32), blend: BlendMode, opacity: f32) {
        let (gw, gh) = (member.width() as u32, member.height() as u32);
        let (base, parent_off, pw, ph) = {
            let Some(Frame {
                surface: Some(parent),
                kind: FrameKind::Group { knockout_base: Some(base), .. },
            }) = self.frames.last()
            else {
                return;
            };
            (base.clone(), parent.offset, parent.w, parent.h)
        };
        let dst = (goff.0 - parent_off.0, goff.1 - parent_off.1);
        // The member over the group's initial backdrop.
        let mut element = self.new_surface(gw, gh, goff);
        let start = copy_region(&base, pw as i32, ph as i32, dst.0, dst.1, gw, gh);
        element.px.data_as_u8_slice_mut().copy_from_slice(&start);
        element.has_base = true;
        let coverage = member.data_as_u8_slice().to_vec();
        element.draw_image(
            &mut self.res,
            Arc::new(member),
            Affine::IDENTITY,
            nearest().with_alpha(opacity),
            vello_map::blend_to_peniko(blend),
        );
        element.flush(&mut self.res);
        let res = &mut self.res;
        let scratch = &mut self.scratch;
        let Some(Frame {
            surface: Some(parent),
            ..
        }) = self.frames.last_mut()
        else {
            return;
        };
        let clip = parent.clip_coverage(scratch, res, dst.0, dst.1, gw, gh);
        let data = parent.pixels(res);
        lerp_region(
            data,
            pw,
            ph,
            dst,
            element.px.data_as_u8_slice(),
            gw,
            gh,
            1.0,
            Some(&coverage),
            clip.as_deref(),
        );
    }

    /// A drop shadow: the shape, offset, filled in the shadow colour,
    /// blurred by a separable Gaussian of `sigma_pt`, choked by `spread`
    /// and grained by `noise`, composited source-over.
    fn drop_shadow(&mut self, path: &BezPath, color: ComposeColor, sigma_pt: f32, spread: f32, noise: f32) {
        let scale = self.scale;
        let brush = vello_map::linear_to_peniko(color);
        let sigma_px = sigma_pt * scale;
        if sigma_px <= 0.5 {
            // Sub-pixel blur: the hard-edged fill is indistinguishable.
            let (s, res, _) = self.split();
            s.fill(res, path, PaintBrush::Solid(brush), PenikoBlendMode::default());
            return;
        }
        let surface_xform = self.active().xform;
        let pad_pt = 3.0 * sigma_pt as f64 + 1.0;
        let Some((ox, oy, w, h)) = scratch_bbox(surface_xform, path.bounding_box(), pad_pt) else {
            return;
        };
        let to_scratch = Affine::translate((-ox as f64, -oy as f64)) * surface_xform;
        let Some(mut stamp) = self.scratch.render(&mut self.res, w, h, |ctx| {
            ctx.set_transform(to_scratch);
            ctx.set_paint(brush);
            ctx.fill_path(path);
        }) else {
            return;
        };
        // Blur premultiplied RGBA: blurring straight alpha would brighten
        // the edges into a halo.
        let kernel = gaussian_kernel(sigma_px);
        gaussian_blur_premul(stamp.data_as_u8_slice_mut(), w, h, &kernel);
        shape_shadow_alpha(stamp.data_as_u8_slice_mut(), w, spread, noise, scale);
        let (s, res, _) = self.split();
        s.draw_image(
            res,
            Arc::new(stamp),
            Affine::translate((ox as f64, oy as f64)),
            nearest(),
            PenikoBlendMode::default(),
        );
    }

    /// Paint the stamps one effect produces: each a page-space coverage
    /// raster painted through in a colour with its blend mode, the
    /// shared arithmetic of `paged_compose::mask` that the PDF exporter
    /// and the GPU lane run too.
    fn effect_stamps(&mut self, stamps: &[paged_compose::mask::EffectStamp]) {
        for stamp in stamps {
            if stamp.mask.is_empty() {
                continue;
            }
            let grid = stamp.mask.grid;
            let (w, h) = (grid.width_px, grid.height_px);
            if w == 0 || h == 0 || w > MAX_SIDE || h > MAX_SIDE {
                continue;
            }
            let c = premul_rgba8(ComposeColor::rgba(stamp.color.r, stamp.color.g, stamp.color.b, 1.0));
            let ca = stamp.color.a.clamp(0.0, 1.0);
            let mut rgba = vec![0u8; (w as usize) * (h as usize) * 4];
            for (i, &m) in stamp.mask.data.iter().enumerate() {
                let a = (m as f32 / 255.0) * ca;
                let q = i * 4;
                rgba[q] = (c[0] as f32 * a).round().clamp(0.0, 255.0) as u8;
                rgba[q + 1] = (c[1] as f32 * a).round().clamp(0.0, 255.0) as u8;
                rgba[q + 2] = (c[2] as f32 * a).round().clamp(0.0, 255.0) as u8;
                rgba[q + 3] = (a * 255.0).round().clamp(0.0, 255.0) as u8;
            }
            let pixmap = Pixmap::from_parts(
                rgba,
                w as u16,
                h as u16,
                PixelMetadata::new(ImageAlphaType::AlphaPremultiplied, true),
            );
            let inv = 1.0 / grid.scale.max(1e-6) as f64;
            let blend = vello_map::blend_to_peniko(stamp.blend_mode);
            let (surface, res, _) = self.split();
            let place = surface.xform
                * Affine::translate((grid.origin_pt.0 as f64, grid.origin_pt.1 as f64))
                * Affine::scale(inv);
            surface.draw_image(res, Arc::new(pixmap), place, stamp_sampler(), blend);
        }
    }

    /// Photograph the active target where the feather at `feather_idx`
    /// will touch, before its object paints.
    fn feather_snapshot(&mut self, feather_idx: usize) -> Option<FeatherBackdrop> {
        let fcmd = self.list.commands.get(feather_idx)?;
        let pad_pt = paged_compose::mask::feather_pad_pt(fcmd)?;
        let (pid, xf) = paged_compose::mask::cmd_path_and_transform(fcmd)?;
        let data = self.list.paths.get(pid)?;
        let path = vello_map::path_to_bez(data, xf);
        let surface = self.active();
        let (xform, id) = (surface.xform, surface.id);
        let (ox, oy, w, h) = effect_scratch_bounds(xform, path.bounding_box(), pad_pt as f64)?;
        let pixels = self.snapshot(ox, oy, w, h, false);
        Some(FeatherBackdrop {
            off: (ox, oy),
            w,
            h,
            pixels,
            surface: id,
        })
    }

    fn feather(
        &mut self,
        data: &PathData,
        transform: &CTransform,
        kind: FeatherKind<'_>,
        backdrop: Option<FeatherBackdrop>,
    ) {
        let scale = self.scale;
        let path = vello_map::path_to_bez(data, transform);
        let pad_pt = match kind {
            FeatherKind::Plain(p) => p.width.abs() * 3.0 + 1.0,
            FeatherKind::Directional(p) => {
                p.left_width
                    .max(p.right_width)
                    .max(p.top_width)
                    .max(p.bottom_width)
                    .max(0.0)
                    * 3.0
                    + 1.0
            }
            FeatherKind::Gradient(_) => 1.0,
        };
        let (xform, id) = {
            let s = self.active();
            (s.xform, s.id)
        };
        let Some((ox, oy, w, h)) = effect_scratch_bounds(xform, path.bounding_box(), pad_pt as f64) else {
            return;
        };
        let to_scratch = Affine::translate((-ox as f64, -oy as f64)) * xform;
        let Some(interior) = self.scratch.render(&mut self.res, w, h, |ctx| {
            ctx.set_transform(to_scratch);
            ctx.set_paint(vello_cpu::color::palette::css::WHITE);
            ctx.fill_path(&path);
        }) else {
            return;
        };
        let interior = alpha_of(&interior);
        let bbox = path.bounding_box();
        let factors: Vec<f32> = match kind {
            FeatherKind::Plain(p) => plain_feather_mask(interior, w, h, p, scale)
                .into_iter()
                .map(|m| m as f32 / 255.0)
                .collect(),
            FeatherKind::Directional(p) => directional_feather_mask(interior, w, h, (ox, oy), bbox, p, scale)
                .into_iter()
                .map(|m| m as f32 / 255.0)
                .collect(),
            FeatherKind::Gradient(p) => {
                if p.stops.is_empty() {
                    return;
                }
                gradient_feather_factors(&interior, w, h, (ox, oy), transform, p, scale)
            }
        };
        let backdrop = backdrop.filter(|b| b.surface == id);
        let paper_fallback = [0u8; 4];
        let (surface, res, scratch) = self.split();
        let clip = surface.clip_coverage(scratch, res, ox, oy, w, h);
        let (sw, sh) = (surface.w as i32, surface.h as i32);
        let target = surface.pixels(res);
        for j in 0..h as i32 {
            let ty = oy + j;
            if ty < 0 || ty >= sh {
                continue;
            }
            for i in 0..w as i32 {
                let tx = ox + i;
                if tx < 0 || tx >= sw {
                    continue;
                }
                let k = (j as u32 * w + i as u32) as usize;
                let mut factor = factors[k];
                if factor >= 1.0 {
                    continue;
                }
                if let Some(c) = clip.as_deref() {
                    let mv = c[k];
                    if mv == 0 {
                        continue;
                    }
                    factor = 1.0 + (factor - 1.0) * (mv as f32 / 255.0);
                }
                let under = backdrop
                    .as_ref()
                    .and_then(|b| {
                        let (bx, by) = (tx - b.off.0, ty - b.off.1);
                        if bx < 0 || by < 0 || bx >= b.w as i32 || by >= b.h as i32 {
                            return None;
                        }
                        let q = ((by as u32 * b.w + bx as u32) * 4) as usize;
                        Some([b.pixels[q], b.pixels[q + 1], b.pixels[q + 2], b.pixels[q + 3]])
                    })
                    .unwrap_or(paper_fallback);
                let q = ((ty * sw + tx) * 4) as usize;
                let f = factor.clamp(0.0, 1.0);
                for ch in 0..4 {
                    target[q + ch] =
                        (target[q + ch] as f32 * f + under[ch] as f32 * (1.0 - f)).clamp(0.0, 255.0) as u8;
                }
            }
        }
    }
}

enum FeatherKind<'a> {
    Plain(&'a Feather),
    Directional(&'a DirectionalFeather),
    Gradient(&'a GradientFeather),
}

/// Placed-image sampling: bilinear, as the GPU lane samples
/// (`ImageQuality::Medium`, peniko's default); an integer-aligned
/// unscaled image is copied exactly (`vello_cpu` drops to nearest).
fn image_sampler() -> ImageSampler {
    ImageSampler::new().with_extend(Extend::Pad)
}

/// Effect stamps are rasters on a grid at the render's own resolution;
/// bilinear places them at their sub-pixel origin, as the GPU lane does.
fn stamp_sampler() -> ImageSampler {
    ImageSampler::new().with_extend(Extend::Pad)
}

/// A placed image as a `vello_cpu` pixmap: the eagerly decoded RGBA when
/// the build kept it (native), else decoded from the encoded bytes now
/// (the wasm32 lazy path, which keeps one decoded image alive at a
/// time). Straight alpha in, premultiplied out.
fn image_pixmap(img: &paged_compose::DecodedImage) -> Option<Pixmap> {
    if img.width > MAX_SIDE || img.height > MAX_SIDE {
        return None;
    }
    let expected = img.width as usize * img.height as usize * 4;
    let rgba = if img.rgba.len() == expected {
        img.rgba.as_ref().to_vec()
    } else if !img.encoded.is_empty() {
        decode_image_for_render(&img.encoded, img.width, img.height)?
    } else {
        return None;
    };
    Some(Pixmap::from_parts(
        rgba,
        img.width as u16,
        img.height as u16,
        PixelMetadata::new(ImageAlphaType::Alpha, true),
    ))
}

/// Decode encoded image bytes to RGBA8 at the dimensions the build
/// recorded, resizing when a DCT-scaled JPEG decodes at another size.
fn decode_image_for_render(bytes: &[u8], expected_w: u32, expected_h: u32) -> Option<Vec<u8>> {
    let img = image::load_from_memory(bytes).ok()?;
    let raw = if img.width() == expected_w && img.height() == expected_h {
        img.to_rgba8()
    } else {
        image::imageops::resize(
            &img.to_rgba8(),
            expected_w,
            expected_h,
            image::imageops::FilterType::Triangle,
        )
    };
    Some(raw.into_raw())
}

/// A scratch rectangle for `bbox_pt` padded by `pad_pt`, in the pixels
/// `xform` maps to, snapped outward: `(x, y, w, h)`.
fn scratch_bbox(xform: Affine, bbox_pt: KRect, pad_pt: f64) -> Option<(i32, i32, u32, u32)> {
    if !bbox_pt.is_finite() {
        return None;
    }
    let r = xform.transform_rect_bbox(bbox_pt.inflate(pad_pt, pad_pt));
    let x0 = r.x0.floor();
    let y0 = r.y0.floor();
    let w = (r.x1.ceil() - x0).max(1.0);
    let h = (r.y1.ceil() - y0).max(1.0);
    if w > MAX_SIDE as f64 || h > MAX_SIDE as f64 {
        return None;
    }
    Some((x0 as i32, y0 as i32, w as u32, h as u32))
}

/// [`scratch_bbox`] with the effect lane's 8192 px cap.
fn effect_scratch_bounds(xform: Affine, bbox_pt: KRect, pad_pt: f64) -> Option<(i32, i32, u32, u32)> {
    let (x, y, w, h) = scratch_bbox(xform, bbox_pt, pad_pt)?;
    (w <= 8192 && h <= 8192).then_some((x, y, w, h))
}

/// Copy a `w × h` region at `(x, y)` out of a `sw × sh` RGBA8 buffer;
/// pixels outside it come back transparent.
fn copy_region(src: &[u8], sw: i32, sh: i32, x: i32, y: i32, w: u32, h: u32) -> Vec<u8> {
    let mut out = vec![0u8; (w as usize) * (h as usize) * 4];
    for j in 0..h as i32 {
        let sy = y + j;
        if sy < 0 || sy >= sh {
            continue;
        }
        let x0 = x.max(0);
        let x1 = (x + w as i32).min(sw);
        if x1 <= x0 {
            continue;
        }
        let si = ((sy * sw + x0) * 4) as usize;
        let di = ((j * w as i32 + (x0 - x)) * 4) as usize;
        let n = ((x1 - x0) * 4) as usize;
        out[di..di + n].copy_from_slice(&src[si..si + n]);
    }
    out
}

/// R-10 — fade `dst` toward `src` (both premultiplied) over `src`'s
/// extent at `at`: `dst += (src − dst) · t`, `t = opacity × coverage α
/// × clip`. `coverage` (a buffer of `src`'s size) weighs each pixel by
/// its alpha — a knockout member's own coverage; `clip` is the target's
/// clip over the same region.
#[allow(clippy::too_many_arguments)]
fn lerp_region(
    dst: &mut [u8],
    dw: u32,
    dh: u32,
    at: (i32, i32),
    src: &[u8],
    sw: u32,
    sh: u32,
    opacity: f32,
    coverage: Option<&[u8]>,
    clip: Option<&[u8]>,
) {
    let opacity = opacity.clamp(0.0, 1.0);
    for j in 0..sh as i32 {
        let py = j + at.1;
        if py < 0 || py >= dh as i32 {
            continue;
        }
        for i in 0..sw as i32 {
            let px = i + at.0;
            if px < 0 || px >= dw as i32 {
                continue;
            }
            let s_idx = (j as u32 * sw + i as u32) as usize;
            let mut t = opacity;
            if let Some(cov) = coverage {
                t *= cov[s_idx * 4 + 3] as f32 / 255.0;
            }
            if let Some(c) = clip {
                t *= c[s_idx] as f32 / 255.0;
            }
            if t <= 0.0 {
                continue;
            }
            let d = ((py as u32 * dw + px as u32) * 4) as usize;
            let s = s_idx * 4;
            let mix = |dc: u8, sc: u8| -> u8 {
                (dc as f32 + (sc as f32 - dc as f32) * t)
                    .round()
                    .clamp(0.0, 255.0) as u8
            };
            let a = mix(dst[d + 3], src[s + 3]);
            for ch in 0..3 {
                // Premultiplied channels never exceed alpha.
                dst[d + ch] = mix(dst[d + ch], src[s + ch]).min(a);
            }
            dst[d + 3] = a;
        }
    }
}

/// R-11 — a drop shadow's `Spread` and `Noise` on its blurred stamp
/// (premultiplied, one colour). Spread chokes the blur: the alpha is
/// scaled by `1 / (1 − spread)` and clamped, so that share of the band
/// is solid before it fades. Noise multiplies the alpha by grain hashed
/// per page-space cell (the pattern does not change with the dpi),
/// `1 − noise · h` for `h` in 0..1.
fn shape_shadow_alpha(stamp: &mut [u8], w: u32, spread: f32, noise: f32, scale: f32) {
    let spread = spread.clamp(0.0, 0.99);
    let noise = noise.clamp(0.0, 1.0);
    if spread <= 0.0 && noise <= 0.0 {
        return;
    }
    let w = w as usize;
    let gain = 1.0 / (1.0 - spread);
    // One grain per ~0.5 pt.
    let cell = (scale * 0.5).max(1.0);
    for (i, px) in stamp.as_chunks_mut::<4>().0.iter_mut().enumerate() {
        let a = px[3];
        if a == 0 {
            continue;
        }
        let mut factor = gain.min(255.0 / a as f32);
        if noise > 0.0 {
            let (x, y) = ((i % w) as f32 / cell, (i / w) as f32 / cell);
            let k = (x as u32).wrapping_mul(73_856_093) ^ (y as u32).wrapping_mul(19_349_663);
            let h = (k.wrapping_mul(2_654_435_761) >> 16) as f32 / 65_535.0;
            factor *= 1.0 - noise * h;
        }
        let scale_c = |c: u8| (c as f32 * factor).round().clamp(0.0, 255.0) as u8;
        let na = scale_c(a);
        px[0] = scale_c(px[0]).min(na);
        px[1] = scale_c(px[1]).min(na);
        px[2] = scale_c(px[2]).min(na);
        px[3] = na;
    }
}

/// 1-D Gaussian kernel sampled at integer pixel offsets, truncated at
/// 3σ on each side and normalised to sum to 1.
fn gaussian_kernel(sigma: f32) -> Vec<f32> {
    let radius = (3.0 * sigma).ceil().max(1.0) as i32;
    let two_sigma_sq = 2.0 * sigma * sigma;
    let mut k = Vec::with_capacity(2 * radius as usize + 1);
    let mut sum = 0.0f32;
    for i in -radius..=radius {
        let v = (-(i as f32) * (i as f32) / two_sigma_sq).exp();
        k.push(v);
        sum += v;
    }
    if sum > 0.0 {
        for v in &mut k {
            *v /= sum;
        }
    }
    k
}

/// Separable Gaussian over a premultiplied RGBA8 buffer, edges clamped
/// (the caller pads by 3σ, so the clamp reads the empty margin).
fn gaussian_blur_premul(data: &mut [u8], width: u32, height: u32, kernel: &[f32]) {
    if kernel.len() < 2 || width == 0 || height == 0 {
        return;
    }
    let (w, h) = (width as usize, height as usize);
    let radius = (kernel.len() / 2) as isize;
    let mut tmp = vec![0u8; data.len()];
    for y in 0..h {
        let row = y * w * 4;
        for x in 0..w {
            let mut acc = [0.0f32; 4];
            for (k, &coeff) in kernel.iter().enumerate() {
                let sx = (x as isize + k as isize - radius).clamp(0, w as isize - 1) as usize;
                let p = row + sx * 4;
                for c in 0..4 {
                    acc[c] += data[p + c] as f32 * coeff;
                }
            }
            let q = row + x * 4;
            for c in 0..4 {
                tmp[q + c] = acc[c].round().clamp(0.0, 255.0) as u8;
            }
        }
    }
    for y in 0..h {
        for x in 0..w {
            let mut acc = [0.0f32; 4];
            for (k, &coeff) in kernel.iter().enumerate() {
                let sy = (y as isize + k as isize - radius).clamp(0, h as isize - 1) as usize;
                let p = (sy * w + x) * 4;
                for c in 0..4 {
                    acc[c] += tmp[p + c] as f32 * coeff;
                }
            }
            let q = (y * w + x) * 4;
            for c in 0..4 {
                data[q + c] = acc[c].round().clamp(0.0, 255.0) as u8;
            }
        }
    }
}

/// Separable Gaussian over a single-channel mask, edges clamped.
fn gaussian_blur_mask(mask: &mut [u8], width: u32, height: u32, kernel: &[f32]) {
    if kernel.len() < 2 || width == 0 || height == 0 {
        return;
    }
    let (w, h) = (width as usize, height as usize);
    let radius = (kernel.len() / 2) as isize;
    let mut tmp = vec![0u8; mask.len()];
    for y in 0..h {
        let row = y * w;
        for x in 0..w {
            let mut acc = 0.0f32;
            for (k, &coeff) in kernel.iter().enumerate() {
                let sx = (x as isize + k as isize - radius).clamp(0, w as isize - 1) as usize;
                acc += mask[row + sx] as f32 * coeff;
            }
            tmp[row + x] = acc.round().clamp(0.0, 255.0) as u8;
        }
    }
    for y in 0..h {
        for x in 0..w {
            let mut acc = 0.0f32;
            for (k, &coeff) in kernel.iter().enumerate() {
                let sy = (y as isize + k as isize - radius).clamp(0, h as isize - 1) as usize;
                acc += tmp[sy * w + x] as f32 * coeff;
            }
            mask[y * w + x] = acc.round().clamp(0.0, 255.0) as u8;
        }
    }
}

/// Choke shifts the half-alpha point: `m' = clamp((m − choke·255) / (1 −
/// choke))`. Negative choke pushes outward.
fn apply_choke(mask: &mut [u8], choke: f32) {
    let choke = choke.clamp(-0.99, 0.99);
    if choke == 0.0 {
        return;
    }
    let shift = choke * 255.0;
    let back = (1.0 - choke).max(1e-6);
    for v in mask.iter_mut() {
        *v = ((*v as f32 - shift) / back).clamp(0.0, 255.0) as u8;
    }
}

/// Diffusion grain: a deterministic per-pixel hash modulating the mask.
fn apply_diffusion(mask: &mut [u8], noise: f32) {
    let amp = noise.clamp(0.0, 1.0);
    for (i, v) in mask.iter_mut().enumerate() {
        let h = ((i.wrapping_mul(2_654_435_761)) & 0xFFFF) as f32 / 65535.0;
        let factor = 1.0 - amp * (h - 0.5);
        *v = (*v as f32 * factor).clamp(0.0, 255.0) as u8;
    }
}

/// Feather: the object's interior, blurred by σ from the corner type,
/// choked and (for Diffusion) grained.
fn plain_feather_mask(mut mask: Vec<u8>, w: u32, h: u32, params: &Feather, scale: f32) -> Vec<u8> {
    let sigma_px = match params.corner_type {
        FeatherCornerType::Sharp => params.width.max(0.0) * 0.5 * scale,
        FeatherCornerType::Rounded => params.width.max(0.0) * 0.75 * scale,
        FeatherCornerType::Diffusion => params.width.max(0.0) * scale,
    };
    if sigma_px > 0.5 {
        gaussian_blur_mask(&mut mask, w, h, &gaussian_kernel(sigma_px));
    }
    apply_choke(&mut mask, params.choke);
    if matches!(params.corner_type, FeatherCornerType::Diffusion) && params.noise > 0.0 {
        apply_diffusion(&mut mask, params.noise);
    }
    mask
}

/// Directional feather: the interior with a linear ramp per side of the
/// (rotated) bounding box, combined by product, then the plain
/// feather's smoothing, choke and grain.
fn directional_feather_mask(
    mut mask: Vec<u8>,
    w: u32,
    h: u32,
    off: (i32, i32),
    bbox: KRect,
    params: &DirectionalFeather,
    scale: f32,
) -> Vec<u8> {
    let max_w = params
        .left_width
        .max(params.right_width)
        .max(params.top_width)
        .max(params.bottom_width)
        .max(0.0);
    let (lw, rw, tw, bw) = (
        params.left_width.max(0.0),
        params.right_width.max(0.0),
        params.top_width.max(0.0),
        params.bottom_width.max(0.0),
    );
    let inv_scale = 1.0 / scale.max(1e-6);
    let cx = ((bbox.x0 + bbox.x1) * 0.5) as f32;
    let cy = ((bbox.y0 + bbox.y1) * 0.5) as f32;
    let hw = ((bbox.x1 - bbox.x0) * 0.5) as f32;
    let hh = ((bbox.y1 - bbox.y0) * 0.5) as f32;
    let (sin_a, cos_a) = (-params.angle_deg.to_radians()).sin_cos();
    let ramp = |d: f32, width: f32| if width > 0.0 { (d / width).clamp(0.0, 1.0) } else { 1.0 };
    if lw + rw + tw + bw > 0.0 {
        for j in 0..h {
            for i in 0..w {
                let idx = (j * w + i) as usize;
                let m = mask[idx];
                if m == 0 {
                    continue;
                }
                let px_pt = (off.0 as f32 + i as f32 + 0.5) * inv_scale;
                let py_pt = (off.1 as f32 + j as f32 + 0.5) * inv_scale;
                let (dx, dy) = (px_pt - cx, py_pt - cy);
                let rx = dx * cos_a - dy * sin_a;
                let ry = dx * sin_a + dy * cos_a;
                let combined =
                    ramp(rx + hw, lw) * ramp(hw - rx, rw) * ramp(ry + hh, tw) * ramp(hh - ry, bw);
                mask[idx] = (m as f32 * combined).clamp(0.0, 255.0) as u8;
            }
        }
    }
    let sigma_px = match params.corner_type {
        FeatherCornerType::Sharp => 0.0,
        FeatherCornerType::Rounded => max_w * 0.25 * scale,
        FeatherCornerType::Diffusion => max_w * 0.5 * scale,
    };
    if sigma_px > 0.5 {
        gaussian_blur_mask(&mut mask, w, h, &gaussian_kernel(sigma_px));
    }
    apply_choke(&mut mask, params.choke);
    if matches!(params.corner_type, FeatherCornerType::Diffusion) && params.noise > 0.0 {
        apply_diffusion(&mut mask, params.noise);
    }
    mask
}

/// Gradient feather: per pixel, `factor = (1 − aa) + aa · α(t)` — the
/// path's antialiased interior `aa` masks the gradient alpha `α` at the
/// pixel's position `t` along the (linear or radial) axis. Outside the
/// path the factor is 1.
fn gradient_feather_factors(
    interior: &[u8],
    w: u32,
    h: u32,
    off: (i32, i32),
    transform: &CTransform,
    params: &GradientFeather,
    scale: f32,
) -> Vec<f32> {
    let (sx, sy) = transform.apply(params.start_x, params.start_y);
    let (ex, ey) = transform.apply(params.end_x, params.end_y);
    let (dx, dy) = (ex - sx, ey - sy);
    let len_sq = dx * dx + dy * dy;
    let mut stops: Vec<(f32, f32)> = params
        .stops
        .iter()
        .map(|s| (s.location.clamp(0.0, 1.0), s.alpha.clamp(0.0, 1.0)))
        .collect();
    stops.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    let inv_scale = 1.0 / scale.max(1e-6);
    let radius = if len_sq > 1e-12 { len_sq.sqrt() } else { 0.0 };
    let inv_len_sq = if len_sq > 1e-6 { 1.0 / len_sq } else { 0.0 };
    let degenerate = len_sq < 1e-6;
    let mut out = vec![1.0f32; (w as usize) * (h as usize)];
    for j in 0..h {
        for i in 0..w {
            let k = (j * w + i) as usize;
            let aa = interior[k];
            if aa == 0 {
                continue;
            }
            let px_pt = (off.0 as f32 + i as f32 + 0.5) * inv_scale;
            let py_pt = (off.1 as f32 + j as f32 + 0.5) * inv_scale;
            let alpha = if degenerate {
                stops[0].1
            } else {
                let t = match params.kind {
                    GradientFeatherKind::Linear => {
                        (((px_pt - sx) * dx + (py_pt - sy) * dy) * inv_len_sq).clamp(0.0, 1.0)
                    }
                    GradientFeatherKind::Radial => {
                        let (rx, ry) = (px_pt - sx, py_pt - sy);
                        ((rx * rx + ry * ry).sqrt() / radius).clamp(0.0, 1.0)
                    }
                };
                sample_gradient_alpha(&stops, t)
            };
            out[k] = 1.0 - (aa as f32 / 255.0) * (1.0 - alpha);
        }
    }
    out
}

/// Gradient alpha at `t` over sorted `(location, alpha)` stops; outside
/// the stops' range it holds the nearest endpoint.
fn sample_gradient_alpha(stops: &[(f32, f32)], t: f32) -> f32 {
    if t <= stops[0].0 {
        return stops[0].1;
    }
    if t >= stops[stops.len() - 1].0 {
        return stops[stops.len() - 1].1;
    }
    for pair in stops.windows(2) {
        let ((l_loc, l_alpha), (r_loc, r_alpha)) = (pair[0], pair[1]);
        if t <= r_loc {
            let f = (t - l_loc) / (r_loc - l_loc).max(1e-6);
            return l_alpha + (r_alpha - l_alpha) * f;
        }
    }
    stops[stops.len() - 1].1
}

fn rasterize_inner(
    list: &DisplayList,
    options: &RasterOptions,
    want_separation: bool,
) -> (RgbaImage, Option<CmykPlanes>) {
    let (px_w, px_h) = options.pixel_size();
    let scale = options.dpi / 72.0;
    let paper = premul_rgba8(options.background);
    let mut raster = Raster {
        list,
        scale,
        px_w,
        px_h,
        paper,
        res: Resources::new(),
        scratch: Scratch { ctx: None },
        page: Surface::new(px_w, px_h, (0, 0), scale, 0),
        frames: Vec::new(),
        planes: None,
        want_planes: want_separation || has_cmyk_overprint(list),
        next_id: 0,
    };
    raster.run(options);
    let Raster {
        mut page,
        mut res,
        planes,
        ..
    } = raster;
    page.flush(&mut res);
    let (page_w, page_h) = (page.w, page.h);
    // The page over the paper.
    let mut data = page.px.take_rgba8(ImageAlphaType::AlphaPremultiplied);
    for px in data.as_chunks_mut::<4>().0 {
        let inv = 255 - px[3] as u32;
        if inv == 0 {
            continue;
        }
        for ch in 0..4 {
            px[ch] = (px[ch] as u32 + (paper[ch] as u32 * inv + 127) / 255).min(255) as u8;
        }
    }
    // The page buffer is at most `u16::MAX` wide; a larger request
    // (never made in practice) is padded with the paper.
    let image = if page_w == px_w && page_h == px_h {
        RgbaImage::from_raw(px_w, px_h, data)
    } else {
        let mut img = RgbaImage::from_pixel(px_w, px_h, Rgba(paper));
        for y in 0..page_h.min(px_h) {
            for x in 0..page_w.min(px_w) {
                let q = ((y * page_w + x) * 4) as usize;
                img.put_pixel(x, y, Rgba([data[q], data[q + 1], data[q + 2], data[q + 3]]));
            }
        }
        Some(img)
    }
    .unwrap_or_else(|| RgbaImage::from_pixel(px_w, px_h, Rgba([0, 0, 0, 0])));
    (image, planes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rgb_to_naive_cmyk_8bit;

    fn linear_to_srgb(c: f32) -> f32 {
        if c <= 0.003_130_8 {
            12.92 * c
        } else {
            1.055 * c.powf(1.0 / 2.4) - 0.055
        }
    }
    use paged_compose::{
        emit_rect, emit_stroke_rect, BevelDirection, BevelStyle, BevelTechnique, Color,
        DisplayList, Paint, Rect,
    };

    fn at(img: &RgbaImage, x: u32, y: u32) -> [u8; 4] {
        img.get_pixel(x, y).0
    }

    /// A unit-square "glyph" at `origin`, at 3 pt across, filled black.
    fn glyph_list(origin: (f32, f32), as_glyph: bool) -> DisplayList {
        use paged_compose::{DisplayCommand as Cmd, PathData, PathSegment, Transform as XF};
        let mut list = DisplayList::new();
        let mut p = PathData::default();
        p.segments.push(PathSegment::MoveTo { x: 0.0, y: 0.0 });
        p.segments.push(PathSegment::LineTo { x: 1.0, y: 0.0 });
        p.segments.push(PathSegment::LineTo { x: 1.0, y: 1.0 });
        p.segments.push(PathSegment::LineTo { x: 0.0, y: 1.0 });
        p.segments.push(PathSegment::Close);
        let path_id = list.paths.push_anon(p);
        let transform = XF([3.0, 0.0, 0.0, 3.0, origin.0, origin.1]);
        let paint = Paint::Solid(Color::rgba(0.0, 0.0, 0.0, 1.0));
        list.commands.push(Cmd::FillPath {
            path_id,
            paint,
            transform,
        });
        if as_glyph {
            let mut table = paged_compose::GlyphRunTable::default();
            table.push(paged_compose::GlyphRunEntry {
                command_index: 0,
                font_id: 0,
                face_id: None,
                glyph_id: 1,
                font_size: 3.0,
                transform,
                paint,
                unicode: Some('x'),
                is_stroke: false,
                structure: table.current,
            });
            list.glyph_runs = Some(table);
        }
        list
    }

    // `snap_glyph_origins` draws a glyph where poppler's Splash would:
    // origin floored to a quarter pixel across and a whole pixel down.
    // At 144 dpi (2 px/pt) an origin of (10.3, 20.6) pt is (20.6, 41.2)
    // px, drawn at (20.5, 41) px = (10.25, 20.5) pt.
    #[test]
    fn snapped_glyphs_land_on_splash_phase() {
        let mut opts = RasterOptions::new(40.0, 40.0);
        opts.dpi = 144.0;
        opts.snap_glyph_origins = true;
        let snapped = rasterize(&glyph_list((10.3, 20.6), true), &opts);
        let mut plain = opts;
        plain.snap_glyph_origins = false;
        let expected = rasterize(&glyph_list((10.25, 20.5), true), &plain);
        assert_eq!(snapped.as_raw(), expected.as_raw());
        // Off, and for a path that is not a glyph, nothing moves.
        let unsnapped = rasterize(&glyph_list((10.3, 20.6), true), &plain);
        assert_ne!(unsnapped.as_raw(), expected.as_raw());
        let not_glyph = rasterize(&glyph_list((10.3, 20.6), false), &opts);
        assert_eq!(not_glyph.as_raw(), unsnapped.as_raw());
    }

    #[test]
    fn empty_list_renders_background() {
        let list = DisplayList::new();
        let opts = RasterOptions::new(10.0, 10.0);
        let img = rasterize(&list, &opts);
        let p = at(&img, 2, 2);
        assert_eq!(p[3], 255, "alpha");
        assert!(
            p[0] > 240 && p[1] > 240 && p[2] > 240,
            "bg white, got {p:?}"
        );
    }

    #[test]
    fn red_rect_fills_expected_pixels() {
        let mut list = DisplayList::new();
        let red = Paint::Solid(Color::rgba(1.0, 0.0, 0.0, 1.0));
        emit_rect(
            Rect {
                x: 10.0,
                y: 10.0,
                w: 30.0,
                h: 20.0,
            },
            red,
            &mut list,
        );
        let mut opts = RasterOptions::new(50.0, 50.0);
        opts.dpi = 72.0; // 1 px = 1 pt, so rect covers x=10..40, y=10..30.
        let img = rasterize(&list, &opts);

        // Sample inside the rect: should be ~(255, 0, 0).
        let inside = at(&img, 20, 20);
        assert!(inside[0] > 240, "inside red channel {inside:?}");
        assert!(inside[1] < 15, "inside green {inside:?}");
        assert!(inside[2] < 15, "inside blue {inside:?}");

        // Sample outside the rect: background white.
        let outside = at(&img, 2, 2);
        assert!(outside[0] > 240 && outside[1] > 240 && outside[2] > 240);
    }

    #[test]
    fn stroke_draws_around_rect_perimeter() {
        let mut list = DisplayList::new();
        let black = Paint::Solid(Color::rgba(0.0, 0.0, 0.0, 1.0));
        emit_stroke_rect(
            Rect {
                x: 10.0,
                y: 10.0,
                w: 30.0,
                h: 20.0,
            },
            paged_compose::Stroke::new(2.0),
            black,
            &mut list,
        );
        let mut opts = RasterOptions::new(50.0, 50.0);
        opts.dpi = 72.0;
        let img = rasterize(&list, &opts);
        // The stroke straddles the boundary — the horizontal edge at
        // y=10 should be dark.
        let on_edge = at(&img, 20, 10);
        assert!(
            on_edge[0] < 100 && on_edge[1] < 100 && on_edge[2] < 100,
            "edge should be dark; got {on_edge:?}"
        );
        // Outside the stroke: still background white.
        let outside = at(&img, 2, 2);
        assert!(outside[0] > 240, "expected white bg; got {outside:?}");
    }

    #[test]
    fn dpi_scaling_changes_image_size() {
        let list = DisplayList::new();
        let mut opts = RasterOptions::new(100.0, 50.0);
        opts.dpi = 144.0; // 2 px/pt
        let img = rasterize(&list, &opts);
        assert_eq!(img.width(), 200);
        assert_eq!(img.height(), 100);
    }

    #[test]
    fn cpu_rasterizer_trait_returns_correct_pixel_count() {
        let r = CpuRasterizer;
        let list = paged_compose::DisplayList::new();
        let mut opts = RasterOptions::new(40.0, 30.0);
        opts.dpi = 72.0;
        let buf = r.rasterize(&list, &opts);
        assert_eq!(buf.len(), 40 * 30 * 4);
        assert_eq!(r.name(), "cpu/vello_cpu");
    }

    #[test]
    fn blend_group_lighten_against_yellow_bg_keeps_yellow() {
        // Lighten of a black rect on a yellow rect underneath should
        // yield yellow where the black rect overlaps (max channel
        // gives yellow), exercising the BeginBlendGroup /
        // EndBlendGroup primitive end-to-end through the CPU
        // rasterizer.
        let mut list = DisplayList::new();
        let yellow = Paint::Solid(Color::rgba(1.0, 1.0, 0.0, 1.0));
        let black = Paint::Solid(Color::rgba(0.0, 0.0, 0.0, 1.0));
        // Yellow background rect at (5, 5, 30, 30).
        emit_rect(
            Rect {
                x: 5.0,
                y: 5.0,
                w: 30.0,
                h: 30.0,
            },
            yellow,
            &mut list,
        );
        // Black rect at (10, 10, 20, 20) wrapped in a Lighten group.
        list.commands
            .push(paged_compose::DisplayCommand::BeginBlendGroup {
                bounds: paged_compose::Rect {
                    x: 10.0,
                    y: 10.0,
                    w: 20.0,
                    h: 20.0,
                },
                blend_mode: paged_compose::BlendMode::Lighten,
                opacity: 1.0,
                isolated: false,
                knockout: false,
                transform: paged_compose::Transform::IDENTITY,
            });
        emit_rect(
            Rect {
                x: 10.0,
                y: 10.0,
                w: 20.0,
                h: 20.0,
            },
            black,
            &mut list,
        );
        list.commands
            .push(paged_compose::DisplayCommand::EndBlendGroup(
                paged_compose::Transform::IDENTITY,
            ));
        let mut opts = RasterOptions::new(40.0, 40.0);
        opts.dpi = 72.0;
        let img = rasterize(&list, &opts);
        // Inside the overlap (15, 15): Lighten(black, yellow) = yellow.
        let p = at(&img, 15, 15);
        assert!(
            p[0] > 240 && p[1] > 240 && p[2] < 15,
            "overlap should be yellow, got {p:?}"
        );
        // Outside the rects (2, 2): background white.
        let bg = at(&img, 2, 2);
        assert!(bg[0] > 240 && bg[1] > 240 && bg[2] > 240, "bg = {bg:?}");
    }

    /// R-10 — a group of `mode` around `rect` filled with `paint`.
    fn grouped_rect(
        list: &mut DisplayList,
        rect: Rect,
        paint: Paint,
        mode: paged_compose::BlendMode,
    ) {
        list.commands
            .push(paged_compose::DisplayCommand::BeginBlendGroup {
                bounds: rect,
                blend_mode: mode,
                opacity: 1.0,
                isolated: false,
                knockout: false,
                transform: paged_compose::Transform::IDENTITY,
            });
        emit_rect(rect, paint, list);
        list.commands
            .push(paged_compose::DisplayCommand::EndBlendGroup(
                paged_compose::Transform::IDENTITY,
            ));
    }

    /// R-10 — a yellow backdrop, then a group with `isolated` /
    /// `knockout` / `opacity` holding a Multiply magenta square and a
    /// Multiply cyan square that overlap at x 15..20.
    fn two_multiply_squares(isolated: bool, knockout: bool, opacity: f32) -> RgbaImage {
        let mut list = DisplayList::new();
        let r = |x: f32, w: f32| Rect {
            x,
            y: 10.0,
            w,
            h: 20.0,
        };
        emit_rect(
            Rect {
                x: 5.0,
                y: 5.0,
                w: 30.0,
                h: 30.0,
            },
            Paint::Solid(Color::rgba(1.0, 1.0, 0.0, 1.0)),
            &mut list,
        );
        list.commands
            .push(paged_compose::DisplayCommand::BeginBlendGroup {
                bounds: r(10.0, 15.0),
                blend_mode: paged_compose::BlendMode::Normal,
                opacity,
                isolated,
                knockout,
                transform: paged_compose::Transform::IDENTITY,
            });
        let multiply = paged_compose::BlendMode::Multiply;
        grouped_rect(
            &mut list,
            r(10.0, 10.0),
            Paint::Solid(Color::rgba(1.0, 0.0, 1.0, 1.0)),
            multiply,
        );
        grouped_rect(
            &mut list,
            r(15.0, 10.0),
            Paint::Solid(Color::rgba(0.0, 1.0, 1.0, 1.0)),
            multiply,
        );
        list.commands
            .push(paged_compose::DisplayCommand::EndBlendGroup(
                paged_compose::Transform::IDENTITY,
            ));
        let mut opts = RasterOptions::new(40.0, 40.0);
        opts.dpi = 72.0;
        rasterize(&list, &opts)
    }

    /// Asked of InDesign (`transparency-targets` cases 41–48): members of
    /// a NON-isolated group multiply with the page under the group; an
    /// isolated group's see only each other; a knockout group's later
    /// member replaces the earlier one where they overlap.
    #[test]
    fn groups_isolate_and_knock_out_as_indesign_composites_them() {
        // Non-isolated, no knockout, 50 %: magenta × yellow = red, faded
        // halfway back toward yellow — green at half, no blue. (An
        // isolated buffer would multiply magenta with nothing and show
        // magenta's blue.)
        let img = two_multiply_squares(false, false, 0.5);
        let p = at(&img, 12, 15);
        assert!(
            p[0] > 240 && (100..160).contains(&p[1]) && p[2] < 20,
            "{p:?}"
        );
        // Isolated: the magenta member alone shows as magenta over yellow.
        let img = two_multiply_squares(true, false, 1.0);
        let p = at(&img, 12, 15);
        assert!(p[0] > 240 && p[1] < 15 && p[2] > 240, "{p:?}");
        // Overlap, isolated: magenta × cyan = blue.
        let p = at(&img, 17, 15);
        assert!(p[0] < 15 && p[1] < 15 && p[2] > 240, "{p:?}");
        // Knockout, non-isolated: in the overlap the cyan member replaces
        // the magenta one and multiplies with the yellow page alone:
        // green (not black, which the three-way multiply would give).
        let img = two_multiply_squares(false, true, 1.0);
        let p = at(&img, 17, 15);
        assert!(p[0] < 15 && p[1] > 240 && p[2] < 15, "{p:?}");
        // …and outside it the magenta member still multiplies: red.
        let p = at(&img, 12, 15);
        assert!(p[0] > 240 && p[1] < 15 && p[2] < 15, "{p:?}");
        // Knockout, isolated: plain cyan over magenta in the overlap.
        let img = two_multiply_squares(true, true, 1.0);
        let p = at(&img, 17, 15);
        assert!(p[0] < 15 && p[1] > 240 && p[2] > 240, "{p:?}");
    }

    /// R-11 — a shadow's spread chokes its blurred alpha; noise grains it.
    #[test]
    fn shadow_spread_chokes_and_noise_grains_the_stamp() {
        let stamp: Vec<u8> = [0u8, 0, 0, 100].repeat(64);
        let alphas = |b: &[u8]| -> Vec<u8> { b.as_chunks::<4>().0.iter().map(|p| p[3]).collect() };
        let mut spread = stamp.clone();
        shape_shadow_alpha(&mut spread, 8, 0.5, 0.0, 1.0);
        assert!(alphas(&spread).iter().all(|a| *a == 200));
        shape_shadow_alpha(&mut spread, 8, 0.9, 0.0, 1.0);
        assert!(alphas(&spread).iter().all(|a| *a == 255), "clamped");
        let mut grain = stamp.clone();
        shape_shadow_alpha(&mut grain, 8, 0.0, 0.2, 1.0);
        let set: std::collections::HashSet<u8> = alphas(&grain).into_iter().collect();
        assert!(
            set.len() > 1 && set.iter().all(|a| (80..=100).contains(a)),
            "{set:?}"
        );
    }

    #[test]
    fn clip_inside_blend_group_masks_to_smaller_buffer() {
        // Mirrors the Lighten test above but adds a Push/Pop clip
        // pair *inside* the blend group: a clip rect that only
        // covers the left half of the inner black rect. The right
        // half should be unclipped (Lighten(black, yellow) = yellow);
        // outside the clip and inside the inner rect should fall
        // back to the yellow background (clip masks the inner fill,
        // so the group buffer stays empty there and the lighten
        // composite is a no-op against the page); outside the inner
        // rect should still be background white.
        //
        // This exercises the clip stack inside a smaller-than-page
        // group buffer: before the fix, the CPU lane panicked because
        // a page-sized mask was being applied to a sub-pixmap.
        let mut list = DisplayList::new();
        let yellow = Paint::Solid(Color::rgba(1.0, 1.0, 0.0, 1.0));
        let black = Paint::Solid(Color::rgba(0.0, 0.0, 0.0, 1.0));
        // Yellow background rect covering the entire visible area
        // so the page underneath the group is yellow, not white.
        emit_rect(
            Rect {
                x: 5.0,
                y: 5.0,
                w: 30.0,
                h: 30.0,
            },
            yellow,
            &mut list,
        );
        // Begin a Lighten blend group sized to (10, 10, 20, 20).
        list.commands
            .push(paged_compose::DisplayCommand::BeginBlendGroup {
                bounds: paged_compose::Rect {
                    x: 10.0,
                    y: 10.0,
                    w: 20.0,
                    h: 20.0,
                },
                blend_mode: paged_compose::BlendMode::Lighten,
                opacity: 1.0,
                isolated: false,
                knockout: false,
                transform: paged_compose::Transform::IDENTITY,
            });
        // Push a clip covering only the left half (x in 10..20) of
        // the group buffer. The clip path is in page-space pt; the
        // rasterizer is responsible for re-anchoring it to the
        // group's local pixel grid.
        let mut clip_path = paged_compose::PathData::default();
        clip_path
            .segments
            .push(paged_compose::PathSegment::MoveTo { x: 0.0, y: 0.0 });
        clip_path
            .segments
            .push(paged_compose::PathSegment::LineTo { x: 1.0, y: 0.0 });
        clip_path
            .segments
            .push(paged_compose::PathSegment::LineTo { x: 1.0, y: 1.0 });
        clip_path
            .segments
            .push(paged_compose::PathSegment::LineTo { x: 0.0, y: 1.0 });
        clip_path.segments.push(paged_compose::PathSegment::Close);
        let clip_id = list.paths.push_anon(clip_path);
        // unit-rect [0,1]² → page rect [10,10..20,30] (left half of
        // the inner rect, full vertical extent).
        let clip_xform = paged_compose::Transform([10.0, 0.0, 0.0, 20.0, 10.0, 10.0]);
        list.commands.push(paged_compose::DisplayCommand::PushClip {
            path_id: clip_id,
            transform: clip_xform,
        });
        // Black rect at (10, 10, 20, 20) — wider than the clip.
        emit_rect(
            Rect {
                x: 10.0,
                y: 10.0,
                w: 20.0,
                h: 20.0,
            },
            black,
            &mut list,
        );
        list.commands.push(paged_compose::DisplayCommand::PopClip(
            paged_compose::Transform::IDENTITY,
        ));
        list.commands
            .push(paged_compose::DisplayCommand::EndBlendGroup(
                paged_compose::Transform::IDENTITY,
            ));
        let mut opts = RasterOptions::new(40.0, 40.0);
        opts.dpi = 72.0;
        let img = rasterize(&list, &opts);
        // (12, 15): inside clip + inside inner rect ⇒ Lighten(black,
        // yellow) = yellow.
        let inside_clip = at(&img, 12, 15);
        assert!(
            inside_clip[0] > 240 && inside_clip[1] > 240 && inside_clip[2] < 15,
            "inside clip+inner: expected yellow, got {inside_clip:?}"
        );
        // (25, 15): outside clip but inside inner rect ⇒ group buffer
        // empty there, Lighten composite no-op, page yellow shows.
        let outside_clip = at(&img, 25, 15);
        assert!(
            outside_clip[0] > 240 && outside_clip[1] > 240 && outside_clip[2] < 15,
            "outside clip+inner: expected yellow page, got {outside_clip:?}"
        );
        // (2, 2): outside the yellow background ⇒ canvas white.
        let bg = at(&img, 2, 2);
        assert!(
            bg[0] > 240 && bg[1] > 240 && bg[2] > 240,
            "page bg = white, got {bg:?}"
        );
    }

    #[test]
    fn blend_group_opacity_50_halves_alpha_against_white() {
        // A black rect inside a 50% opacity group composited onto
        // white should yield mid-gray, exercising group-level alpha
        // (PixmapPaint::opacity).
        let mut list = DisplayList::new();
        list.commands
            .push(paged_compose::DisplayCommand::BeginBlendGroup {
                bounds: paged_compose::Rect {
                    x: 10.0,
                    y: 10.0,
                    w: 20.0,
                    h: 20.0,
                },
                blend_mode: paged_compose::BlendMode::Normal,
                opacity: 0.5,
                isolated: false,
                knockout: false,
                transform: paged_compose::Transform::IDENTITY,
            });
        let black = Paint::Solid(Color::rgba(0.0, 0.0, 0.0, 1.0));
        emit_rect(
            Rect {
                x: 10.0,
                y: 10.0,
                w: 20.0,
                h: 20.0,
            },
            black,
            &mut list,
        );
        list.commands
            .push(paged_compose::DisplayCommand::EndBlendGroup(
                paged_compose::Transform::IDENTITY,
            ));
        let mut opts = RasterOptions::new(40.0, 40.0);
        opts.dpi = 72.0;
        let img = rasterize(&list, &opts);
        // 50% black on white = ~127 per channel. Allow some slack
        // for sRGB gamma round-trip.
        let p = at(&img, 15, 15);
        assert!(p[0] > 100 && p[0] < 180, "expected mid-gray, got {p:?}");
    }

    #[test]
    fn path_shadow_paints_dark_pixels_at_offset() {
        // Stamp a small unit-rect path as a `PathShadow` at a known
        // page offset, with a non-zero shadow offset and visible
        // blur radius. Inside the shadow's projected bounds the
        // page should darken; far away from the path the page
        // should remain near-white background. This mirrors the
        // existing DropShadow code path; we render the new
        // PathShadow variant so the shared lowering survives any
        // future divergence.
        use paged_compose::{
            DisplayCommand as Cmd, DisplayList, DropShadow as DS, PathData, PathSegment,
            Transform as XF,
        };
        let mut list = DisplayList::new();
        // Anonymous unit-rect path (avoids the interned-key
        // collision with later test isolation).
        let mut p = PathData::default();
        p.segments.push(PathSegment::MoveTo { x: 0.0, y: 0.0 });
        p.segments.push(PathSegment::LineTo { x: 1.0, y: 0.0 });
        p.segments.push(PathSegment::LineTo { x: 1.0, y: 1.0 });
        p.segments.push(PathSegment::LineTo { x: 0.0, y: 1.0 });
        p.segments.push(PathSegment::Close);
        let path_id = list.paths.push_anon(p);
        // Place the unit rect at (10, 10) with size 10×10, shadow
        // offset (4, 4), blur 2pt, 60% black.
        let xform = XF([10.0, 0.0, 0.0, 10.0, 10.0, 10.0]);
        let shadow = DS {
            offset_x: 4.0,
            offset_y: 4.0,
            blur_radius: 2.0,
            color: paged_compose::Color::rgba(0.0, 0.0, 0.0, 1.0),
            opacity: 0.6,
            blend_mode: paged_compose::BlendMode::Normal,
            spread: 0.0,
            noise: 0.0,
        };
        list.commands.push(Cmd::PathShadow {
            path_id,
            transform: xform,
            shadow,
        });
        let mut opts = RasterOptions::new(40.0, 40.0);
        opts.dpi = 72.0;
        let img = rasterize(&list, &opts);
        // The shadow centre lands around (10+4 + 5, 10+4 + 5) =
        // (19, 19): rect spans x=10..20, y=10..20 in pt; shadow
        // offsets +4 → x=14..24, y=14..24; centre at (19, 19).
        let centre = at(&img, 19, 19);
        // Shadow should darken the pixel meaningfully; ~0.6 alpha
        // black on white → ~102 per channel mid-rect, and the
        // Gaussian blur softens edges. Expect well under 220 in
        // the rect interior.
        assert!(
            centre[0] < 220 && centre[1] < 220 && centre[2] < 220,
            "shadow centre should darken page; got {centre:?}"
        );
        // Far outside the shadow footprint: still white background.
        let far = at(&img, 2, 2);
        assert!(
            far[0] > 240 && far[1] > 240 && far[2] > 240,
            "far-away pixel should be white bg; got {far:?}"
        );
    }

    #[test]
    fn push_layer_with_gaussian_blur_softens_filled_rect_edge() {
        // PushLayer { effect: GaussianBlur { sigma_pt: 3.0 } } around
        // a black rect: the rect's hard edge should bleed outward,
        // producing a soft alpha falloff in the buffer's padded
        // border. We verify the kernel ran by sampling *outside*
        // the rect's geometric bounds (where a hard-edge fill would
        // leave white pixels) and checking that the pixel has been
        // darkened by the blur halo.
        let mut list = DisplayList::new();
        let black = Paint::Solid(Color::rgba(0.0, 0.0, 0.0, 1.0));
        list.commands
            .push(paged_compose::DisplayCommand::PushLayer {
                bounds: paged_compose::Rect {
                    x: 10.0,
                    y: 10.0,
                    w: 20.0,
                    h: 20.0,
                },
                effect: paged_compose::LayerEffect::GaussianBlur { sigma_pt: 3.0 },
                blend_mode: paged_compose::BlendMode::Normal,
                opacity: 1.0,
                transform: paged_compose::Transform::IDENTITY,
            });
        emit_rect(
            Rect {
                x: 10.0,
                y: 10.0,
                w: 20.0,
                h: 20.0,
            },
            black,
            &mut list,
        );
        list.commands.push(paged_compose::DisplayCommand::PopLayer(
            paged_compose::Transform::IDENTITY,
        ));
        let mut opts = RasterOptions::new(50.0, 50.0);
        opts.dpi = 72.0;
        let img = rasterize(&list, &opts);
        // Pixel a few pt outside the rect's right edge (rect spans
        // x=10..30, y=10..30; sample at x=33, y=20): hard-edge fill
        // would leave white here, blurred edge should be a soft mid-
        // gray. Allow generous slack on the exact value — the test's
        // job is to assert the blur ran, not to pin a precise σ.
        let halo = at(&img, 33, 20);
        assert!(
            halo[0] < 230,
            "blur halo should darken pixel outside rect; got {halo:?}"
        );
        // Pixel at the rect's centre: should still be (nearly)
        // opaque black — blur softens edges, not the interior.
        let centre = at(&img, 20, 20);
        assert!(
            centre[0] < 100,
            "blurred rect centre should stay dark; got {centre:?}"
        );
        // Pixel far outside the layer's padded bounds: untouched
        // white background. Layer bounds + 3σ padding ≈ 10..40 pt
        // — sample at (46, 46), well outside.
        let far = at(&img, 46, 46);
        assert!(
            far[0] > 240 && far[1] > 240 && far[2] > 240,
            "far pixel should be background white; got {far:?}"
        );
    }

    #[test]
    fn push_layer_none_effect_behaves_like_blend_group() {
        // PushLayer { effect: None } should produce the same composite
        // as a `BeginBlendGroup` with matching blend_mode/opacity —
        // a transparency-group fallback for callers that want the
        // generic plumbing without an effect.
        let mut list = DisplayList::new();
        list.commands
            .push(paged_compose::DisplayCommand::PushLayer {
                bounds: paged_compose::Rect {
                    x: 10.0,
                    y: 10.0,
                    w: 20.0,
                    h: 20.0,
                },
                effect: paged_compose::LayerEffect::None,
                blend_mode: paged_compose::BlendMode::Normal,
                opacity: 0.5,
                transform: paged_compose::Transform::IDENTITY,
            });
        let black = Paint::Solid(Color::rgba(0.0, 0.0, 0.0, 1.0));
        emit_rect(
            Rect {
                x: 10.0,
                y: 10.0,
                w: 20.0,
                h: 20.0,
            },
            black,
            &mut list,
        );
        list.commands.push(paged_compose::DisplayCommand::PopLayer(
            paged_compose::Transform::IDENTITY,
        ));
        let mut opts = RasterOptions::new(40.0, 40.0);
        opts.dpi = 72.0;
        let img = rasterize(&list, &opts);
        // 50% black on white through the layer's group composite
        // should be ~mid-gray, exactly like the blend_group_opacity_50
        // test above.
        let p = at(&img, 15, 15);
        assert!(
            p[0] > 100 && p[0] < 180,
            "expected mid-gray (50% black on white), got {p:?}"
        );
    }

    /// A blend group cuts at its `bounds` rect — not at the buffer
    /// allocated for it, which is deliberately larger (outward pixel
    /// snapping plus a device pixel of AA slack).
    ///
    /// Sampled at two dpi because the slack is a DEVICE pixel: letting
    /// the buffer edge be the clip made the amount of overflowing
    /// paint that survived a function of the output resolution, and
    /// made it unreproducible in the Vello backend, which encodes a
    /// page scene once at identity and re-uses it at every zoom. The
    /// cross-backend half of this lives in
    /// `vello_rs::tests::a_blend_group_cuts_at_its_bounds_in_both_back_ends`
    /// (feature `vello-backend`, off by default).
    #[test]
    fn blend_group_paint_is_cut_at_bounds_not_at_the_padded_buffer() {
        for dpi in [72.0f32, 288.0] {
            let scale = dpi / 72.0;
            let mut list = DisplayList::new();
            // Page-wide red, then a Multiply group over x/y 20..60 /
            // 10..40 whose content covers the WHOLE page. Multiply of
            // green over red is black, so every pixel reads either
            // black (inside the group) or red (cut).
            emit_rect(
                Rect {
                    x: 0.0,
                    y: 0.0,
                    w: 100.0,
                    h: 60.0,
                },
                Paint::Solid(Color::rgba(1.0, 0.0, 0.0, 1.0)),
                &mut list,
            );
            list.commands
                .push(paged_compose::DisplayCommand::BeginBlendGroup {
                    bounds: Rect {
                        x: 20.0,
                        y: 10.0,
                        w: 40.0,
                        h: 30.0,
                    },
                    blend_mode: paged_compose::BlendMode::Multiply,
                    opacity: 1.0,
                    isolated: false,
                    knockout: false,
                    transform: paged_compose::Transform::IDENTITY,
                });
            emit_rect(
                Rect {
                    x: 0.0,
                    y: 0.0,
                    w: 100.0,
                    h: 60.0,
                },
                Paint::Solid(Color::rgba(0.0, 1.0, 0.0, 1.0)),
                &mut list,
            );
            list.commands
                .push(paged_compose::DisplayCommand::EndBlendGroup(
                    paged_compose::Transform::IDENTITY,
                ));

            let mut opts = RasterOptions::new(100.0, 60.0);
            opts.dpi = dpi;
            opts.background = Color::rgba(1.0, 1.0, 1.0, 1.0);
            let img = rasterize(&list, &opts);
            let px = |x_pt: f32, y_pt: f32| at(&img, (x_pt * scale) as u32, (y_pt * scale) as u32);

            assert_eq!(
                px(40.0, 25.0),
                [0, 0, 0, 255],
                "inside the group the Multiply must land ({dpi} dpi)"
            );
            // The first pixel column/row past each edge. These are the
            // pixels the padded buffer used to paint.
            for (x, y, edge) in [
                (60.0, 25.0, "right"),
                (19.0, 25.0, "left"),
                (40.0, 40.0, "bottom"),
                (40.0, 9.0, "top"),
            ] {
                assert_eq!(
                    px(x, y),
                    [255, 0, 0, 255],
                    "paint past the group's {edge} edge must be cut ({dpi} dpi)"
                );
            }
        }
    }

    #[test]
    fn unmatched_pop_layer_is_a_noop() {
        // A stray `PopLayer` without a matching `PushLayer` must not
        // panic or underflow the group stack — matches the
        // `EndBlendGroup` / `PopClip` tolerance policy.
        let mut list = DisplayList::new();
        list.commands.push(paged_compose::DisplayCommand::PopLayer(
            paged_compose::Transform::IDENTITY,
        ));
        let opts = RasterOptions::new(10.0, 10.0);
        let img = rasterize(&list, &opts);
        // Background still rendered cleanly.
        let p = at(&img, 2, 2);
        assert!(p[0] > 240 && p[3] == 255, "expected white bg, got {p:?}");
    }

    /// Helper: install an anonymous unit-rect path in `list` and
    /// return the `(path_id, page-space transform)` that places it at
    /// `(x, y)` with size `(w, h)`. Used by the per-effect tests
    /// below to build a stand-alone path command without going
    /// through the `emit_*` helpers.
    fn unit_rect_at(
        list: &mut paged_compose::DisplayList,
        x: f32,
        y: f32,
        w: f32,
        h: f32,
    ) -> (paged_compose::PathId, paged_compose::Transform) {
        use paged_compose::{PathData, PathSegment, Transform as XF};
        let mut p = PathData::default();
        p.segments.push(PathSegment::MoveTo { x: 0.0, y: 0.0 });
        p.segments.push(PathSegment::LineTo { x: 1.0, y: 0.0 });
        p.segments.push(PathSegment::LineTo { x: 1.0, y: 1.0 });
        p.segments.push(PathSegment::LineTo { x: 0.0, y: 1.0 });
        p.segments.push(PathSegment::Close);
        let path_id = list.paths.push_anon(p);
        let xform = XF([w, 0.0, 0.0, h, x, y]);
        (path_id, xform)
    }

    #[test]
    fn inner_shadow_darkens_inside_edge_keeps_outside_white() {
        // Stamp a 20x20 pt rectangle inner shadow at (10, 10) with
        // offset +4,+4 and 3pt blur, 80% black. The shadow lives
        // *inside* the path: pixels just inside the top-left edge
        // (where the offset stamp's complement is strongest) should
        // darken; pixels outside the path stay at the white
        // background.
        use paged_compose::{DisplayCommand as Cmd, DisplayList, InnerShadow as IS};
        let mut list = DisplayList::new();
        let (path_id, xform) = unit_rect_at(&mut list, 10.0, 10.0, 20.0, 20.0);
        let params = IS {
            offset_x: 4.0,
            offset_y: 4.0,
            blur_radius: 3.0,
            color: paged_compose::Color::rgba(0.0, 0.0, 0.0, 1.0),
            opacity: 0.8,
            choke: 0.0,
            blend_mode: paged_compose::BlendMode::Normal,
        };
        list.commands.push(Cmd::InnerShadow {
            path_id,
            transform: xform,
            params,
        });
        let mut opts = RasterOptions::new(40.0, 40.0);
        opts.dpi = 72.0;
        let img = rasterize(&list, &opts);
        // Inside the path, top-left corner (just inside the edge):
        // shadow source is the area outside the offset path, so the
        // top-left receives the strongest shadow. (12, 12) sits a
        // couple of pixels inside the path's interior.
        let inside_tl = at(&img, 12, 12);
        assert!(
            inside_tl[0] < 200,
            "inner shadow should darken inside top-left; got {inside_tl:?}"
        );
        // Outside the path entirely (well beyond the rect): still
        // white. The path occupies pt-space [10..30] × [10..30].
        let outside = at(&img, 2, 2);
        assert!(
            outside[0] > 240 && outside[1] > 240 && outside[2] > 240,
            "outside path should stay white; got {outside:?}"
        );
        // Inside the path, far from the shadow source (bottom-right
        // corner inside the path is far from the offset stamp's
        // complement) — should be near-white (no fill emitted).
        let inside_far = at(&img, 28, 28);
        assert!(
            inside_far[0] > 220,
            "inner shadow should not paint deep interior; got {inside_far:?}"
        );
    }

    #[test]
    fn outer_glow_paints_outside_path_not_inside() {
        // 20x20 pt rectangle at (10, 10), blue glow with 4pt blur,
        // 90% opacity. Just outside the rect's edge the glow should
        // tint the page blue; inside the rect the glow is masked
        // out (no fill emitted, page stays background-white).
        use paged_compose::{DisplayCommand as Cmd, DisplayList, OuterGlow as OG};
        let mut list = DisplayList::new();
        let (path_id, xform) = unit_rect_at(&mut list, 10.0, 10.0, 20.0, 20.0);
        let params = OG {
            blur_radius: 4.0,
            color: paged_compose::Color::rgba(0.0, 0.0, 1.0, 1.0),
            opacity: 0.9,
            blend_mode: paged_compose::BlendMode::Normal,
            spread: 0.0,
        };
        list.commands.push(Cmd::OuterGlow {
            path_id,
            transform: xform,
            params,
        });
        let mut opts = RasterOptions::new(40.0, 40.0);
        opts.dpi = 72.0;
        let img = rasterize(&list, &opts);
        // Just outside the rect's left edge (8, 20): the glow is
        // strongest one blur-radius away from the edge.
        let outside = at(&img, 8, 20);
        // Blue should dominate (B channel > R/G).
        assert!(
            outside[2] > outside[0] + 10 && outside[2] > outside[1] + 10,
            "outer glow should tint blue just outside path; got {outside:?}"
        );
        // Inside the rect, well clear of the edge (20, 20): the
        // outer-glow masks itself out of the path interior, so the
        // page stays white.
        let inside = at(&img, 20, 20);
        assert!(
            inside[0] > 220 && inside[1] > 220 && inside[2] > 220,
            "outer glow should not paint inside path; got {inside:?}"
        );
        // Far outside: untouched white background.
        let far = at(&img, 2, 2);
        assert!(
            far[0] > 240 && far[1] > 240 && far[2] > 240,
            "far-away pixel should stay white; got {far:?}"
        );
    }

    #[test]
    fn inner_glow_lights_inside_edge_keeps_outside_white() {
        // 20x20 rectangle, yellow inner glow, 4pt blur, 80% opacity.
        // Just inside the edge of the path, the page should pick up
        // a yellow tint; outside the path stays white.
        use paged_compose::{DisplayCommand as Cmd, DisplayList, InnerGlow as IG};
        let mut list = DisplayList::new();
        let (path_id, xform) = unit_rect_at(&mut list, 10.0, 10.0, 20.0, 20.0);
        let params = IG {
            blur_radius: 4.0,
            color: paged_compose::Color::rgba(1.0, 1.0, 0.0, 1.0),
            opacity: 0.8,
            blend_mode: paged_compose::BlendMode::Normal,
            choke: 0.0,
        };
        list.commands.push(Cmd::InnerGlow {
            path_id,
            transform: xform,
            params,
        });
        let mut opts = RasterOptions::new(40.0, 40.0);
        opts.dpi = 72.0;
        let img = rasterize(&list, &opts);
        // Just inside the path's top-left edge: yellow tint.
        // Yellow = R high, G high, B low.
        let inside_edge = at(&img, 12, 12);
        assert!(
            inside_edge[2] < inside_edge[0],
            "inner glow should reduce B inside edge (yellow tint); got {inside_edge:?}"
        );
        // Outside the path: still white.
        let outside = at(&img, 2, 2);
        assert!(
            outside[0] > 240 && outside[1] > 240 && outside[2] > 240,
            "outside path stays white; got {outside:?}"
        );
    }

    #[test]
    fn bevel_emboss_lights_one_edge_darkens_opposite() {
        // Bevel-and-emboss with a top-left light (angle=135°,
        // altitude=30°) on a 30x30 pt rectangle. Top-left edge
        // should lighten; bottom-right edge should darken. Far
        // outside should remain background white.
        use paged_compose::{BevelEmboss as BE, DisplayCommand as Cmd, DisplayList};
        let mut list = DisplayList::new();
        let (path_id, xform) = unit_rect_at(&mut list, 10.0, 10.0, 30.0, 30.0);
        let params = BE {
            depth: 1.0,
            size: 4.0,
            angle_deg: 135.0,
            altitude_deg: 30.0,
            highlight_color: paged_compose::Color::rgba(1.0, 1.0, 1.0, 1.0),
            shadow_color: paged_compose::Color::rgba(0.0, 0.0, 0.0, 1.0),
            highlight_opacity: 1.0,
            shadow_opacity: 1.0,
            ..BE::default_soft()
        };
        list.commands.push(Cmd::BevelEmboss {
            path_id,
            transform: xform,
            params,
        });
        let mut opts = RasterOptions::new(50.0, 50.0);
        opts.dpi = 72.0;
        let img = rasterize(&list, &opts);
        // Top-left edge inside the path (12, 12): highlight present
        // means the page stays bright (or gets brighter than it
        // would without the bevel). The page is white so the
        // highlight doesn't lighten it visibly; instead, check the
        // shadow side.
        // Bottom-right edge inside the path (37, 37): the shadow
        // colour darkens the page.
        let br_edge = at(&img, 37, 37);
        // Anywhere on the shadow side should darken below 220.
        let darkest = (br_edge[0] as i32) + (br_edge[1] as i32) + (br_edge[2] as i32);
        assert!(
            darkest < 240 * 3,
            "bevel shadow side should darken bottom-right; got {br_edge:?}"
        );
        // Far outside the path: untouched.
        let far = at(&img, 2, 2);
        assert!(
            far[0] > 240 && far[1] > 240 && far[2] > 240,
            "outside path stays background white; got {far:?}"
        );
    }

    #[test]
    fn satin_paints_inside_path_only() {
        // Satin: a 30x30 rect with a 5pt blur, distance 8pt, angle
        // 45°. The wave intensity peaks where the two offset
        // stamps disagree (near the path's edge along the
        // satin direction); should be visible inside the path but
        // not outside it.
        use paged_compose::{DisplayCommand as Cmd, DisplayList, Satin as ST};
        let mut list = DisplayList::new();
        let (path_id, xform) = unit_rect_at(&mut list, 10.0, 10.0, 30.0, 30.0);
        let params = ST {
            blur_radius: 5.0,
            angle_deg: 45.0,
            distance: 8.0,
            color: paged_compose::Color::rgba(0.0, 0.0, 0.0, 1.0),
            opacity: 0.9,
            blend_mode: paged_compose::BlendMode::Normal,
            invert: false,
        };
        list.commands.push(Cmd::Satin {
            path_id,
            transform: xform,
            params,
        });
        let mut opts = RasterOptions::new(50.0, 50.0);
        opts.dpi = 72.0;
        let img = rasterize(&list, &opts);
        // Inside the path: satin should darken at least one
        // sample point. Pick a pixel along the leading edge of the
        // wave (top-left interior).
        let mut found_dark = false;
        for x in 11..40 {
            for y in 11..40 {
                let p = at(&img, x as u32, y as u32);
                if p[0] < 200 && p[1] < 200 && p[2] < 200 {
                    found_dark = true;
                    break;
                }
            }
            if found_dark {
                break;
            }
        }
        assert!(
            found_dark,
            "satin should darken at least one interior pixel"
        );
        // Outside the path: stays background white.
        let outside = at(&img, 2, 2);
        assert!(
            outside[0] > 240 && outside[1] > 240 && outside[2] > 240,
            "satin should not paint outside path; got {outside:?}"
        );
    }

    #[test]
    fn feather_softens_path_edge() {
        // A feather fades the object's OWN paint out toward its edge —
        // it does not add ink. So: fill a 20×20 black rect, feather it,
        // and require the centre to stay dark while the edge lightens
        // toward the paper. (This used to assert a 50%-grey tint on an
        // EMPTY page, which was the placeholder's behaviour, not
        // InDesign's.)
        use paged_compose::{
            Color, DisplayCommand as Cmd, DisplayList, Feather as F, FeatherCornerType, Paint,
        };
        let mut list = DisplayList::new();
        let (path_id, xform) = unit_rect_at(&mut list, 10.0, 10.0, 20.0, 20.0);
        list.commands.push(Cmd::FillPath {
            path_id,
            paint: Paint::Solid(Color::BLACK),
            transform: xform,
        });
        list.commands.push(Cmd::Feather {
            path_id,
            transform: xform,
            params: F {
                width: 4.0,
                corner_type: FeatherCornerType::Sharp,
                noise: 0.0,
                choke: 0.0,
            },
        });
        let mut opts = RasterOptions::new(40.0, 40.0);
        opts.dpi = 72.0;
        let img = rasterize(&list, &opts);
        let centre = at(&img, 20, 20);
        assert!(
            centre[0] < 80,
            "the feathered object keeps its paint at the centre; got {centre:?}"
        );
        // One point inside the edge the fade has started, so it is
        // lighter than the centre but still darker than paper.
        let edge = at(&img, 11, 20);
        assert!(
            edge[0] > centre[0] && edge[0] < 250,
            "the edge fades toward paper; centre={centre:?} edge={edge:?}"
        );
        let far = at(&img, 2, 2);
        assert!(
            far[0] > 240 && far[1] > 240 && far[2] > 240,
            "outside the object stays paper; got {far:?}"
        );
    }

    #[test]
    fn a_feather_reveals_the_backdrop_and_spares_what_is_beside_it() {
        // The feather's scratch rectangle is padded well past the
        // object (3 x width), and everything in that rectangle used to
        // be faded to PAPER — so a caption sitting beside a feathered
        // panel was erased, and a feather over a tinted ground faded
        // to white instead of to the ground. Both are fixed by fading
        // toward a photograph of the target taken before the object
        // painted itself.
        use paged_compose::{
            Color, DisplayCommand as Cmd, DisplayList, Feather as F, FeatherCornerType, Paint,
        };
        let mut list = DisplayList::new();
        // A wide mid-grey ground the feathered object sits on.
        let (ground, ground_xf) = unit_rect_at(&mut list, 0.0, 0.0, 60.0, 30.0);
        list.commands.push(Cmd::FillPath {
            path_id: ground,
            paint: Paint::Solid(Color::rgba(0.5, 0.5, 0.5, 1.0)),
            transform: ground_xf,
        });
        // A black bar OUTSIDE the object but inside the feather's pad.
        let (bar, bar_xf) = unit_rect_at(&mut list, 46.0, 12.0, 10.0, 6.0);
        list.commands.push(Cmd::FillPath {
            path_id: bar,
            paint: Paint::Solid(Color::BLACK),
            transform: bar_xf,
        });
        // The feathered object: a white square on the grey ground.
        let (obj, obj_xf) = unit_rect_at(&mut list, 6.0, 6.0, 24.0, 18.0);
        list.commands.push(Cmd::FillPath {
            path_id: obj,
            paint: Paint::Solid(Color::WHITE),
            transform: obj_xf,
        });
        list.commands.push(Cmd::Feather {
            path_id: obj,
            transform: obj_xf,
            params: F {
                width: 6.0,
                corner_type: FeatherCornerType::Sharp,
                noise: 0.0,
                choke: 0.0,
            },
        });
        let mut opts = RasterOptions::new(60.0, 30.0);
        opts.dpi = 72.0;
        let img = rasterize(&list, &opts);

        // The bar is 16pt from the object but only 10pt from the edge
        // of its 19pt pad — it must come through untouched.
        let on_bar = at(&img, 50, 15);
        assert!(
            on_bar[0] < 40,
            "a feather leaves ink beside its object alone; got {on_bar:?}"
        );
        // The object's centre keeps its own white paint.
        let centre = at(&img, 18, 15);
        assert!(
            centre[0] > 230,
            "the object keeps its paint at the centre; got {centre:?}"
        );
        // At the faded edge the GROUND shows through, not the paper:
        // mid-grey, not white.
        // Along the fading edge the object gives way to the GROUND.
        // Fading to paper instead would leave white-on-white here and
        // never dip below the object's own value.
        // Read the ground where no effect reaches, as the reference.
        let plain_ground = at(&img, 58, 27)[0] as i32;
        let profile: Vec<u8> = (5..14).map(|x| at(&img, x, 15)[0]).collect();
        let dip = profile.iter().copied().min().unwrap_or(255) as i32;
        assert!(
            (dip - plain_ground).abs() <= 6,
            "the fade lands on the grey ground, not the paper; \
             profile={profile:?} ground={plain_ground}"
        );
        // And the ground inside the feather's pad but outside the
        // object is bit-identical to the ground outside it.
        let padded_ground = at(&img, 40, 27)[0] as i32;
        assert_eq!(
            padded_ground, plain_ground,
            "the ground inside the feather's pad is untouched"
        );
    }

    #[test]
    fn directional_feather_on_ellipse_softens_left_more_than_right() {
        // Phase 6 — directional feather on an ELLIPSE (non-rectangle
        // shape). The per-edge widths apply to the path's bounding
        // box, so a left-only feather softens the left half of the
        // ellipse interior while the right half stays opaque.
        use paged_compose::{
            DirectionalFeather, DisplayCommand as Cmd, FeatherCornerType, Transform as XF,
        };
        let mut list = DisplayList::new();
        let (path_id, _) = list.paths.intern(
            paged_compose::UNIT_ELLIPSE_KEY,
            paged_compose::unit_ellipse(),
        );
        let xform = XF([20.0, 0.0, 0.0, 20.0, 10.0, 10.0]);
        let params = DirectionalFeather {
            left_width: 8.0,
            right_width: 0.0,
            top_width: 0.0,
            bottom_width: 0.0,
            angle_deg: 0.0,
            noise: 0.0,
            choke: 0.0,
            corner_type: FeatherCornerType::Sharp,
        };
        list.commands.push(Cmd::FillPath {
            path_id,
            paint: paged_compose::Paint::Solid(paged_compose::Color::rgba(0.5, 0.5, 0.5, 1.0)),
            transform: xform,
        });
        list.commands.push(Cmd::DirectionalFeather {
            path_id,
            transform: xform,
            params,
        });
        let mut opts = RasterOptions::new(40.0, 40.0);
        opts.dpi = 72.0;
        let img = rasterize(&list, &opts);
        // The ellipse fills the unit-square mapped to (10..30, 10..30).
        // Vertical centre = y=20. Sample interior pixels along that
        // row; "near left" is heavily feathered, "mid"/"near right"
        // is opaque grey.
        let near_left = at(&img, 12, 20);
        let mid = at(&img, 20, 20);
        let near_right = at(&img, 27, 20);
        assert!(
            near_left[0] > mid[0],
            "ellipse: left edge should be less tinted than mid; near_left={near_left:?} mid={mid:?}"
        );
        assert!(
            near_right[0] <= mid[0] + 15,
            "ellipse: right edge shouldn't fade; near_right={near_right:?} mid={mid:?}"
        );
    }

    #[test]
    fn directional_feather_softens_left_edge_more_than_right() {
        // Per-side widths: the left edge fades over 8 pt, the right not
        // at all. With the object's own paint under it, the left side
        // must therefore be LIGHTER than the middle and the right side
        // must keep the fill.
        use paged_compose::{
            Color, DirectionalFeather as DF, DisplayCommand as Cmd, DisplayList, FeatherCornerType,
            Paint,
        };
        let mut list = DisplayList::new();
        let (path_id, xform) = unit_rect_at(&mut list, 10.0, 10.0, 20.0, 20.0);
        list.commands.push(Cmd::FillPath {
            path_id,
            paint: Paint::Solid(Color::BLACK),
            transform: xform,
        });
        list.commands.push(Cmd::DirectionalFeather {
            path_id,
            transform: xform,
            params: DF {
                left_width: 8.0,
                right_width: 0.0,
                top_width: 0.0,
                bottom_width: 0.0,
                angle_deg: 0.0,
                noise: 0.0,
                choke: 0.0,
                corner_type: FeatherCornerType::Sharp,
            },
        });
        let mut opts = RasterOptions::new(40.0, 40.0);
        opts.dpi = 72.0;
        let img = rasterize(&list, &opts);
        let near_left = at(&img, 11, 20);
        let mid = at(&img, 20, 20);
        let near_right = at(&img, 28, 20);
        assert!(
            near_left[0] > mid[0],
            "the left edge fades; near_left={near_left:?} mid={mid:?}"
        );
        assert!(
            near_right[0] <= mid[0] + 15,
            "the right edge keeps its paint; near_right={near_right:?} mid={mid:?}"
        );
        let far = at(&img, 2, 2);
        assert!(far[0] > 240, "outside the object stays paper; got {far:?}");
    }

    #[test]
    fn gradient_feather_linear_alpha_decreases_along_axis() {
        // Stack: a black-filled rect at (10, 10) covered by a
        // horizontal gradient feather with α=1.0 at x=0 and α=0.0
        // at x=1 (in unit-rect coords). The gradient feather alpha-
        // modulates the underlying fill, so pixels near the left
        // edge stay black (α≈1.0 → multiplier ≈1.0 → black through);
        // pixels near the right edge fade toward the white page
        // background (α≈0.1 → multiplier ≈0.1 → mostly background).
        // Far outside the rect: untouched white background.
        use paged_compose::{
            Color, DisplayCommand as Cmd, GradientFeather, GradientFeatherKind,
            GradientFeatherStop, Paint,
        };
        let mut list = DisplayList::new();
        let (path_id, xform) = unit_rect_at(&mut list, 10.0, 10.0, 20.0, 20.0);
        // Underlying black fill the gradient will modulate.
        list.commands.push(Cmd::FillPath {
            path_id,
            paint: Paint::Solid(Color::rgba(0.0, 0.0, 0.0, 1.0)),
            transform: xform,
        });
        let params = GradientFeather {
            kind: GradientFeatherKind::Linear,
            start_x: 0.0,
            start_y: 0.5,
            end_x: 1.0,
            end_y: 0.5,
            stops: vec![
                GradientFeatherStop {
                    location: 0.0,
                    alpha: 1.0,
                },
                GradientFeatherStop {
                    location: 1.0,
                    alpha: 0.0,
                },
            ],
            radial_aspect: 1.0,
        };
        list.commands.push(Cmd::GradientFeather {
            path_id,
            transform: xform,
            params,
        });
        let mut opts = RasterOptions::new(40.0, 40.0);
        opts.dpi = 72.0;
        let img = rasterize(&list, &opts);
        // x=12: near-start, gradient α ≈ 0.9, black fill stays
        // mostly opaque → output R ≈ 0.1*0 + 0.9*255 ≈ 25 (mostly
        // black still, blended toward paper-white).
        // x=28: near-end, gradient α ≈ 0.1, black fill mostly
        // faded to paper → output R ≈ 0.9*0 + 0.1*255 ≈ 230
        // (mostly paper-white).
        // The rasterizer blends each interior pixel toward
        // `paper_premul` (page background = white) by `1 - α`, so
        // the output is fully opaque (alpha = 255) and the RGB
        // channels carry the fade. Asserting on R captures the
        // gradient direction without assuming anything about the
        // viewer's compositing.
        let near_start = at(&img, 12, 20);
        let near_end = at(&img, 28, 20);
        // R increases left→right as black fades toward paper-white.
        assert!(
            near_start[0] < near_end[0],
            "linear gradient feather should fade left→right; near_start={near_start:?} near_end={near_end:?}"
        );
        // Near-start stays mostly black (R close to 0).
        assert!(
            near_start[0] < 80,
            "near-start should stay mostly black; got {near_start:?}"
        );
        // Near-end is mostly paper (R close to 255).
        assert!(
            near_end[0] > 180,
            "near-end should be mostly paper; got {near_end:?}"
        );
        // Output remains opaque after the fade — gradient feather
        // blends toward paper, not toward transparent.
        assert!(
            near_start[3] > 240 && near_end[3] > 240,
            "gradient feather should keep pixels opaque; near_start={near_start:?} near_end={near_end:?}"
        );
        // Far outside the rect: untouched white background.
        let far = at(&img, 2, 2);
        assert!(
            far[0] > 240 && far[3] > 240,
            "outside gradient feather should be opaque white; got {far:?}"
        );
    }

    /// Sum the shaded-bevel darkness in a small window around a
    /// corner: a larger return means more shadow tint landed there.
    /// Used by the Up/Down and Inner/Outer bevel parity tests to
    /// compare which corner carries the shadow.
    fn bevel_darkness(img: &RgbaImage, cx: u32, cy: u32) -> i64 {
        let mut acc = 0i64;
        for dy in 0..4 {
            for dx in 0..4 {
                let p = at(img, cx + dx, cy + dy);
                // White page = 255; darker = the shadow tint. Sum the
                // "missing brightness" so a darker corner scores higher.
                acc += (255 - p[0] as i64) + (255 - p[1] as i64) + (255 - p[2] as i64);
            }
        }
        acc
    }

    fn bevel_img(style: BevelStyle, direction: BevelDirection) -> RgbaImage {
        use paged_compose::{BevelEmboss as BE, DisplayCommand as Cmd, DisplayList};
        let mut list = DisplayList::new();
        let (path_id, xform) = unit_rect_at(&mut list, 10.0, 10.0, 30.0, 30.0);
        let params = BE {
            depth: 1.0,
            size: 4.0,
            angle_deg: 135.0,
            altitude_deg: 30.0,
            highlight_color: paged_compose::Color::rgba(1.0, 1.0, 1.0, 1.0),
            shadow_color: paged_compose::Color::rgba(0.0, 0.0, 0.0, 1.0),
            highlight_opacity: 1.0,
            shadow_opacity: 1.0,
            style,
            direction,
            technique: BevelTechnique::Smooth,
            soften: 0.0,
            highlight_blend: paged_compose::BlendMode::Screen,
            shadow_blend: paged_compose::BlendMode::Multiply,
        };
        list.commands.push(Cmd::BevelEmboss {
            path_id,
            transform: xform,
            params,
        });
        let mut opts = RasterOptions::new(50.0, 50.0);
        opts.dpi = 72.0;
        rasterize(&list, &opts)
    }

    #[test]
    fn bevel_direction_down_flips_highlight_side() {
        // W1.4 parity — `Direction="Down"` flips the light's elevation
        // sign, so the shadow that landed on the bottom-right corner
        // for the (Up) raised bevel moves to the top-left corner for
        // the (Down) carved-in bevel. We compare shadow darkness at
        // the two corners across the two directions.
        let up = bevel_img(BevelStyle::InnerBevel, BevelDirection::Up);
        let down = bevel_img(BevelStyle::InnerBevel, BevelDirection::Down);
        // Top-left corner interior ≈ (12,12); bottom-right ≈ (35,35).
        let up_tl = bevel_darkness(&up, 12, 12);
        let up_br = bevel_darkness(&up, 35, 35);
        let down_tl = bevel_darkness(&down, 12, 12);
        let down_br = bevel_darkness(&down, 35, 35);
        // Up: shadow on bottom-right (br darker than tl).
        assert!(
            up_br > up_tl,
            "Up bevel shadow should sit bottom-right: tl={up_tl}, br={up_br}"
        );
        // Down: shadow flips to top-left (tl darker than br).
        assert!(
            down_tl > down_br,
            "Down bevel shadow should sit top-left: tl={down_tl}, br={down_br}"
        );
    }

    #[test]
    fn an_outer_bevel_puts_its_facet_outside_the_object() {
        // This test used to assert that OuterBevel "inverts the height
        // field" and moves the shadow to the opposite corner INSIDE
        // the object. InDesign does no such thing: measured, an outer
        // bevel lays its facet on the page AROUND the outline, lit on
        // the same side as an inner bevel, and leaves the interior
        // alone. Our old code masked every style to the interior, so
        // an outer bevel drew nothing whatsoever.
        let inner = bevel_img(BevelStyle::InnerBevel, BevelDirection::Up);
        let outer = bevel_img(BevelStyle::OuterBevel, BevelDirection::Up);
        // The rect spans 10..40 with a 4 pt facet; 35 is inside the
        // bottom-right corner and 41 just outside it.
        assert!(
            bevel_darkness(&inner, 35, 35) > bevel_darkness(&inner, 12, 12),
            "the light comes from the upper left, so an inner bevel shades bottom-right"
        );
        assert!(
            bevel_darkness(&outer, 41, 41) > bevel_darkness(&outer, 5, 5),
            "and an outer bevel shades the page just outside that same corner"
        );
        assert_eq!(
            bevel_darkness(&outer, 22, 22),
            0,
            "with nothing at all inside the object"
        );
    }

    #[test]
    fn bevel_chisel_technique_sharpens_bevel_band() {
        // W1.4 parity — `ChiselHard` narrows the height-field smoothing
        // band, concentrating the shaded ramp into a thinner strip near
        // the edge. Deep in the interior (far from any edge) a chisel
        // bevel should be essentially untouched (white) while the
        // smooth bevel still bleeds a faint tint there.
        use paged_compose::{BevelEmboss as BE, DisplayCommand as Cmd, DisplayList};
        let make = |technique| {
            let mut list = DisplayList::new();
            let (path_id, xform) = unit_rect_at(&mut list, 10.0, 10.0, 30.0, 30.0);
            let params = BE {
                depth: 1.0,
                size: 8.0,
                angle_deg: 135.0,
                altitude_deg: 30.0,
                highlight_color: paged_compose::Color::rgba(1.0, 1.0, 1.0, 1.0),
                shadow_color: paged_compose::Color::rgba(0.0, 0.0, 0.0, 1.0),
                highlight_opacity: 1.0,
                shadow_opacity: 1.0,
                style: BevelStyle::InnerBevel,
                direction: BevelDirection::Up,
                technique,
                soften: 0.0,
                highlight_blend: paged_compose::BlendMode::Screen,
                shadow_blend: paged_compose::BlendMode::Multiply,
            };
            list.commands.push(Cmd::BevelEmboss {
                path_id,
                transform: xform,
                params,
            });
            let mut opts = RasterOptions::new(50.0, 50.0);
            opts.dpi = 72.0;
            rasterize(&list, &opts)
        };
        let smooth = make(BevelTechnique::Smooth);
        let chisel = make(BevelTechnique::ChiselHard);
        // Centre of the rect (25, 25) — far from every edge. Tint here
        // is the bevel "bleed". Chisel's narrower band should bleed
        // less (centre stays brighter / closer to white).
        let smooth_centre = bevel_darkness(&smooth, 23, 23);
        let chisel_centre = bevel_darkness(&chisel, 23, 23);
        assert!(
            chisel_centre <= smooth_centre,
            "chisel should bleed no more into the interior than smooth: chisel={chisel_centre}, smooth={smooth_centre}"
        );
    }

    #[test]
    fn satin_invert_flips_wave_band() {
        // W1.4 parity — `invert` flips the satin wave mask from
        // `|am - bm|` (bright contour band) to `1 - |am - bm|` (dark
        // interior plateau). At a pixel where the two stamps agree
        // (deep interior), the non-inverted satin paints ~nothing
        // (wave ≈ 0) while the inverted satin paints heavily
        // (wave ≈ 1). So a deep-interior sample is darker under invert.
        use paged_compose::{DisplayCommand as Cmd, DisplayList, Satin as ST};
        let make = |invert| {
            let mut list = DisplayList::new();
            let (path_id, xform) = unit_rect_at(&mut list, 10.0, 10.0, 40.0, 40.0);
            let params = ST {
                blur_radius: 3.0,
                angle_deg: 45.0,
                distance: 6.0,
                color: paged_compose::Color::rgba(0.0, 0.0, 0.0, 1.0),
                opacity: 1.0,
                blend_mode: paged_compose::BlendMode::Normal,
                invert,
            };
            list.commands.push(Cmd::Satin {
                path_id,
                transform: xform,
                params,
            });
            let mut opts = RasterOptions::new(60.0, 60.0);
            opts.dpi = 72.0;
            rasterize(&list, &opts)
        };
        let plain = make(false);
        let inverted = make(true);
        // Deep interior (30, 30): the two offset stamps fully overlap,
        // so |am - bm| ≈ 0. Plain satin leaves it ~white; inverted
        // satin paints it dark.
        let plain_c = at(&plain, 30, 30);
        let inv_c = at(&inverted, 30, 30);
        assert!(
            plain_c[0] > 200,
            "plain satin should leave the deep interior near-white; got {plain_c:?}"
        );
        assert!(
            inv_c[0] < plain_c[0].saturating_sub(60),
            "inverted satin should darken the deep interior vs plain; plain={plain_c:?}, inv={inv_c:?}"
        );
        // Both leave the outside untouched white.
        assert!(at(&plain, 2, 2)[0] > 240 && at(&inverted, 2, 2)[0] > 240);
    }

    #[test]
    fn directional_feather_angle_rotates_fade_edge() {
        // W1.4 parity — the directional feather rotates each pixel into
        // the rect's intrinsic frame by `angle_deg` before computing
        // per-side fades. With a left-only feather and angle = 90°, the
        // "left" edge points where the *top* edge was, so the fade
        // moves from the left edge to the top edge.
        use paged_compose::{DirectionalFeather, DisplayCommand as Cmd, FeatherCornerType};
        let make = |angle: f32| {
            let mut list = DisplayList::new();
            let (path_id, xform) = unit_rect_at(&mut list, 10.0, 10.0, 24.0, 24.0);
            let params = DirectionalFeather {
                left_width: 10.0,
                right_width: 0.0,
                top_width: 0.0,
                bottom_width: 0.0,
                angle_deg: angle,
                noise: 0.0,
                choke: 0.0,
                corner_type: FeatherCornerType::Sharp,
            };
            list.commands.push(Cmd::FillPath {
                path_id,
                paint: paged_compose::Paint::Solid(paged_compose::Color::BLACK),
                transform: xform,
            });
            list.commands.push(Cmd::DirectionalFeather {
                path_id,
                transform: xform,
                params,
            });
            let mut opts = RasterOptions::new(44.0, 44.0);
            opts.dpi = 72.0;
            rasterize(&list, &opts)
        };
        // Tint = how much of the object's own paint survives. The
        // feathered edge fades toward paper (less tint); the untouched
        // edge keeps the fill (more tint).
        let tint = |img: &RgbaImage, x: u32, y: u32| 255i32 - at(img, x, y)[0] as i32;
        let a0 = make(0.0);
        let a90 = make(90.0);
        // angle=0: left edge feathered (light), top edge opaque (dark).
        let left0 = tint(&a0, 12, 22);
        let top0 = tint(&a0, 22, 12);
        assert!(
            left0 < top0,
            "angle=0: left edge should fade more than top; left={left0}, top={top0}"
        );
        // angle=90: the fade rotates onto the top edge (light), left
        // edge becomes opaque (dark).
        let left90 = tint(&a90, 12, 22);
        let top90 = tint(&a90, 22, 12);
        assert!(
            top90 < left90,
            "angle=90: fade should rotate onto the top edge; left={left90}, top={top90}"
        );
    }

    /// CMYK overprint (Stage A): a 100% cyan rectangle with overprint
    /// over a 100% magenta rectangle must produce a pixel whose CMYK
    /// equivalent is `(C=100, M=100, Y=0, K=0)` — i.e. blue — rather
    /// than `min(cyan_rgb, magenta_rgb)`'s coincidentally-also-blue
    /// answer. We can't read the pixel's CMYK directly (the pixmap
    /// is RGB), so we pin the pixel value and assert it round-trips
    /// to the right CMYK through `rgb_to_naive_cmyk_8bit`.
    ///
    /// Critical contrast vs. Stage 3: this test is *direction*-blind
    /// to whether the path used CMYK-max or RGB-min; both happen to
    /// produce blue here. But the assertion below additionally checks
    /// that *both* C and M channels are 100% in the recovered CMYK
    /// of the resulting pixel — that's the per-channel-ink invariant
    /// the brief calls out and which RGB Darken would still satisfy
    /// here by coincidence (cyan+magenta is one of the easy cases).
    /// A harder case (e.g. mid-tone CMYK pairs where RGB-darken
    /// diverges from per-channel-max) would expose the difference;
    /// here we lock in the no-regression invariant.
    #[test]
    fn cmyk_overprint_cyan_on_magenta_produces_per_channel_max() {
        let mut list = DisplayList::new();
        // Bottom: magenta full-page rectangle. We hand-craft the
        // `rgb` cache via the naive forward map so the rendered RGB
        // is what `rgb_to_naive_cmyk_8bit` can decode losslessly —
        // the test asserts the per-channel-max contract is exact in
        // 8-bit space, which only holds for that round trip.
        let magenta_rgb = crate::cmyk_unit_to_linear_rgb(0.0, 1.0, 0.0, 0.0);
        let cyan_rgb = crate::cmyk_unit_to_linear_rgb(1.0, 0.0, 0.0, 0.0);
        let magenta = Paint::Cmyk {
            c: 0.0,
            m: 1.0,
            y: 0.0,
            k: 0.0,
            rgb: magenta_rgb,
            spot: None,
        };
        let cyan = Paint::Cmyk {
            c: 1.0,
            m: 0.0,
            y: 0.0,
            k: 0.0,
            rgb: cyan_rgb,
            spot: None,
        };
        emit_rect(
            Rect {
                x: 0.0,
                y: 0.0,
                w: 100.0,
                h: 100.0,
            },
            magenta,
            &mut list,
        );
        // Top: cyan inner rectangle with overprint. emit_rect always
        // produces FillPath, so we manually upgrade the appended
        // command to FillPathOverprint.
        emit_rect(
            Rect {
                x: 20.0,
                y: 20.0,
                w: 60.0,
                h: 60.0,
            },
            cyan,
            &mut list,
        );
        let last = list.commands.len() - 1;
        if let paged_compose::DisplayCommand::FillPath {
            path_id,
            paint,
            transform,
        } = list.commands[last]
        {
            list.commands[last] = paged_compose::DisplayCommand::FillPathOverprint {
                path_id,
                paint,
                transform,
            };
        }
        let mut opts = RasterOptions::new(100.0, 100.0);
        opts.dpi = 72.0;
        let img = rasterize(&list, &opts);
        let center = at(&img, 50, 50);
        // Recover CMYK from the rendered pixel via the same inverse
        // the rasterizer uses internally — this is exact for naive
        // CMYK→RGB round trips at 8-bit precision.
        let (c, m, y, k) = rgb_to_naive_cmyk_8bit(center[0], center[1], center[2]);
        assert!(
            c >= 250,
            "overprint should leave cyan ink at ~100%; got CMYK=({c}, {m}, {y}, {k}) from pixel {center:?}"
        );
        assert!(
            m >= 250,
            "overprint should preserve magenta ink at ~100%; got CMYK=({c}, {m}, {y}, {k}) from pixel {center:?}"
        );
        assert!(
            y <= 5 && k <= 5,
            "overprint should not invent Y or K; got CMYK=({c}, {m}, {y}, {k}) from pixel {center:?}"
        );
        // And the rendered RGB should be blue-ish (B high, R and G low).
        assert!(
            center[2] > 200 && center[0] < 30 && center[1] < 30,
            "cyan-on-magenta overprint should be blue ≈ (0,0,255); got {center:?}"
        );
    }

    /// Sanity: ordinary (non-overprint) CMYK draws still produce the
    /// same visible pixels as before. A 100% cyan CMYK rectangle on a
    /// white background should be ≈ (0, 255, 255).
    #[test]
    fn cmyk_paint_non_overprint_renders_identically_to_solid_path() {
        let mut list = DisplayList::new();
        let cyan_rgb = crate::cmyk_unit_to_linear_rgb(1.0, 0.0, 0.0, 0.0);
        let cyan = Paint::Cmyk {
            c: 1.0,
            m: 0.0,
            y: 0.0,
            k: 0.0,
            rgb: cyan_rgb,
            spot: None,
        };
        emit_rect(
            Rect {
                x: 20.0,
                y: 20.0,
                w: 60.0,
                h: 60.0,
            },
            cyan,
            &mut list,
        );
        let mut opts = RasterOptions::new(100.0, 100.0);
        opts.dpi = 72.0;
        let img = rasterize(&list, &opts);
        let p = at(&img, 50, 50);
        assert!(
            p[0] < 15 && p[1] > 240 && p[2] > 240,
            "pure-cyan CMYK should render ~(0,255,255); got {p:?}"
        );
    }

    /// Stage B regression: three CMYK draws stacked. Background paper,
    /// then a 100% magenta CMYK rect (NORMAL — knockout-style draw),
    /// then a 100% yellow CMYK rect on top with OVERPRINT. The
    /// expected result over the overlap is `max(M, Y) = (0, 100, 100,
    /// 0)` ⇒ red — Stage A would have inferred destination CMYK from
    /// the RGB framebuffer correctly for this 100/100 case (it
    /// round-trips), but the plane state is what proves the pipeline
    /// is end-to-end. We verify by recovering CMYK from the output
    /// pixel and asserting both ink channels are ~100%.
    #[test]
    fn cmyk_plane_pipeline_overprint_after_normal_cmyk_layer_yields_per_channel_max() {
        let mut list = DisplayList::new();
        let magenta_rgb = crate::cmyk_unit_to_linear_rgb(0.0, 1.0, 0.0, 0.0);
        let yellow_rgb = crate::cmyk_unit_to_linear_rgb(0.0, 0.0, 1.0, 0.0);
        let magenta = Paint::Cmyk {
            c: 0.0,
            m: 1.0,
            y: 0.0,
            k: 0.0,
            rgb: magenta_rgb,
            spot: None,
        };
        let yellow = Paint::Cmyk {
            c: 0.0,
            m: 0.0,
            y: 1.0,
            k: 0.0,
            rgb: yellow_rgb,
            spot: None,
        };
        // Normal CMYK draw (no overprint) — feeds the plane state.
        emit_rect(
            Rect {
                x: 0.0,
                y: 0.0,
                w: 100.0,
                h: 100.0,
            },
            magenta,
            &mut list,
        );
        // Overprint CMYK draw on top.
        emit_rect(
            Rect {
                x: 20.0,
                y: 20.0,
                w: 60.0,
                h: 60.0,
            },
            yellow,
            &mut list,
        );
        let last = list.commands.len() - 1;
        if let paged_compose::DisplayCommand::FillPath {
            path_id,
            paint,
            transform,
        } = list.commands[last]
        {
            list.commands[last] = paged_compose::DisplayCommand::FillPathOverprint {
                path_id,
                paint,
                transform,
            };
        }
        let mut opts = RasterOptions::new(100.0, 100.0);
        opts.dpi = 72.0;
        let img = rasterize(&list, &opts);
        let center = at(&img, 50, 50);
        let (c, m, y, k) = rgb_to_naive_cmyk_8bit(center[0], center[1], center[2]);
        assert!(
            m >= 250,
            "overprint after normal CMYK should keep magenta ink; got CMYK=({c}, {m}, {y}, {k}) pixel={center:?}"
        );
        assert!(
            y >= 250,
            "overprint should add yellow ink; got CMYK=({c}, {m}, {y}, {k}) pixel={center:?}"
        );
        assert!(
            c <= 5 && k <= 5,
            "overprint shouldn't invent C/K; got CMYK=({c}, {m}, {y}, {k}) pixel={center:?}"
        );
        // Outside the inner rect we still see pure magenta from the
        // normal-blend bottom layer.
        let outer = at(&img, 5, 5);
        let (oc, om, oy, ok) = rgb_to_naive_cmyk_8bit(outer[0], outer[1], outer[2]);
        assert!(
            om >= 250 && oy <= 5 && oc <= 5 && ok <= 5,
            "outside overlap should be pure magenta; got CMYK=({oc}, {om}, {oy}, {ok}) pixel={outer:?}"
        );
    }

    /// Stage B regression: pixels NEVER touched by a CMYK draw must
    /// stay at the RGB framebuffer's value verbatim. A pure RGB
    /// `Paint::Solid` rectangle (no CMYK draws at all) must render
    /// identical to the same scene without Stage B's plane plumbing
    /// — i.e. the flush pass mustn't touch coverage=0 pixels.
    #[test]
    fn cmyk_plane_flush_leaves_non_cmyk_pixels_unchanged() {
        use paged_compose::Color;
        let mut list = DisplayList::new();
        let teal = Paint::Solid(Color::rgba(0.0, 0.5, 0.5, 1.0));
        emit_rect(
            Rect {
                x: 10.0,
                y: 10.0,
                w: 80.0,
                h: 80.0,
            },
            teal,
            &mut list,
        );
        let mut opts = RasterOptions::new(100.0, 100.0);
        opts.dpi = 72.0;
        let img = rasterize(&list, &opts);
        let center = at(&img, 50, 50);
        // Linear (0, 0.5, 0.5) → sRGB ≈ (0, 188, 188). We just need
        // the green & blue channels to be non-trivial and red to be
        // ~0 — Stage B's flush must not have stamped any plane-based
        // ICC conversion over the top.
        assert!(
            center[0] < 5 && center[1] > 150 && center[2] > 150,
            "RGB-only fill should render unchanged; got {center:?}"
        );
    }

    /// Stage B regression: stacked CMYK overprint draws must
    /// accumulate per-channel. Magenta with overprint on top of
    /// yellow with overprint should produce red. This is the *core*
    /// invariant Stage A couldn't express because once the first
    /// CMYK overprint completed, the next overprint had to recover
    /// CMYK from inferred RGB; Stage B reads the plane state
    /// directly, so the second overprint sees `(M=0, Y=1.0, K=0)`
    /// from the planes and produces the right max.
    #[test]
    fn cmyk_plane_pipeline_chained_overprints_accumulate_ink_per_channel() {
        let mut list = DisplayList::new();
        let yellow_rgb = crate::cmyk_unit_to_linear_rgb(0.0, 0.0, 1.0, 0.0);
        let magenta_rgb = crate::cmyk_unit_to_linear_rgb(0.0, 1.0, 0.0, 0.0);
        let yellow = Paint::Cmyk {
            c: 0.0,
            m: 0.0,
            y: 1.0,
            k: 0.0,
            rgb: yellow_rgb,
            spot: None,
        };
        let magenta = Paint::Cmyk {
            c: 0.0,
            m: 1.0,
            y: 0.0,
            k: 0.0,
            rgb: magenta_rgb,
            spot: None,
        };
        // First overprint draw: yellow on paper.
        emit_rect(
            Rect {
                x: 0.0,
                y: 0.0,
                w: 100.0,
                h: 100.0,
            },
            yellow,
            &mut list,
        );
        let last = list.commands.len() - 1;
        if let paged_compose::DisplayCommand::FillPath {
            path_id,
            paint,
            transform,
        } = list.commands[last]
        {
            list.commands[last] = paged_compose::DisplayCommand::FillPathOverprint {
                path_id,
                paint,
                transform,
            };
        }
        // Second overprint draw: magenta over yellow.
        emit_rect(
            Rect {
                x: 20.0,
                y: 20.0,
                w: 60.0,
                h: 60.0,
            },
            magenta,
            &mut list,
        );
        let last = list.commands.len() - 1;
        if let paged_compose::DisplayCommand::FillPath {
            path_id,
            paint,
            transform,
        } = list.commands[last]
        {
            list.commands[last] = paged_compose::DisplayCommand::FillPathOverprint {
                path_id,
                paint,
                transform,
            };
        }
        let mut opts = RasterOptions::new(100.0, 100.0);
        opts.dpi = 72.0;
        let img = rasterize(&list, &opts);
        let center = at(&img, 50, 50);
        let (c, m, y, k) = rgb_to_naive_cmyk_8bit(center[0], center[1], center[2]);
        assert!(
            m >= 250 && y >= 250,
            "chained overprint should accumulate M+Y; got CMYK=({c}, {m}, {y}, {k}) pixel={center:?}"
        );
        assert!(
            c <= 5 && k <= 5,
            "chained overprint shouldn't invent C/K; got CMYK=({c}, {m}, {y}, {k}) pixel={center:?}"
        );
    }

    /// Stage C: a non-overprint spot draw must render bit-identical
    /// pixels to a process CMYK draw using the same CMYK alternate.
    /// The spot ink is plumbed through `Paint::Cmyk { spot: Some(id) }`
    /// — the rasterizer should paint the cached `rgb` colour exactly
    /// like Stage A/B, and the spot plane should accumulate the tint
    /// separately for any later overprint.
    #[test]
    fn spot_paint_non_overprint_renders_like_process_cmyk_alternate() {
        use paged_compose::{SpotInk, SpotInkId};
        let mut list = DisplayList::new();
        // 100% PANTONE 286 C alternate = (100, 75, 0, 0) percent.
        let alt_rgb = crate::cmyk_unit_to_linear_rgb(1.0, 0.75, 0.0, 0.0);
        let spot_id = list.push_spot_ink(SpotInk {
            name: "Color/Pantone286".to_string(),
            cmyk_alternate: [255, 191, 0, 0], // 100/75/0/0% → 255/191/0/0 in 8-bit
        });
        let _ = SpotInkId(0); // proves the type is re-exported and Copy
        let spot = Paint::Cmyk {
            c: 1.0,
            m: 0.75,
            y: 0.0,
            k: 0.0,
            rgb: alt_rgb,
            spot: Some(spot_id),
        };
        emit_rect(
            Rect {
                x: 20.0,
                y: 20.0,
                w: 60.0,
                h: 60.0,
            },
            spot,
            &mut list,
        );
        let mut opts = RasterOptions::new(100.0, 100.0);
        opts.dpi = 72.0;
        let img = rasterize(&list, &opts);
        let center = at(&img, 50, 50);
        // Expected RGB is the alternate-CMYK ICC-resolved colour the
        // paint baked in. The cached `rgb` field on the paint is what
        // `paint_to_ts` reads — the rasterizer painted *that*, so the
        // sRGB-encoded version of `alt_rgb` is what we expect on the
        // framebuffer (within rounding).
        let expected_r = (linear_to_srgb(alt_rgb.r) * 255.0).round() as i32;
        let expected_g = (linear_to_srgb(alt_rgb.g) * 255.0).round() as i32;
        let expected_b = (linear_to_srgb(alt_rgb.b) * 255.0).round() as i32;
        let diff = |a: u8, b: i32| (a as i32 - b).abs();
        assert!(
            diff(center[0], expected_r) <= 2
                && diff(center[1], expected_g) <= 2
                && diff(center[2], expected_b) <= 2,
            "non-overprint spot should render its CMYK alternate verbatim; got {:?}, expected ~({}, {}, {})",
            center,
            expected_r,
            expected_g,
            expected_b
        );
    }

    /// Stage C invariant 1: two runs of the SAME spot ink overprinting
    /// each other compose per-pixel `max(top_tint, bottom_tint)` in
    /// the spot's own plane. Rendering 50% PANTONE 286 over 30%
    /// PANTONE 286 (same alternate) yields 50% in the overlap — NOT
    /// `max(50%-alt, 30%-alt)` channel-wise (Stage B's process CMYK
    /// path, which would give the same answer here but for the wrong
    /// reason). We pin the visible RGB to what 50% of the alternate
    /// converts to, asserting the spot plane composed the heavier
    /// tint rather than additively combining the two.
    #[test]
    fn spot_overprint_same_ink_takes_max_tint() {
        use paged_compose::SpotInk;
        let mut list = DisplayList::new();
        // Spot ink with full-strength CMYK alternate of (100, 75, 0, 0)%.
        let alt = [255u8, 191, 0, 0];
        let spot_id = list.push_spot_ink(SpotInk {
            name: "Color/Pantone286".to_string(),
            cmyk_alternate: alt,
        });
        let rgb_30 = crate::cmyk_unit_to_linear_rgb(0.30, 0.225, 0.0, 0.0);
        let rgb_50 = crate::cmyk_unit_to_linear_rgb(0.50, 0.375, 0.0, 0.0);
        let spot_30 = Paint::Cmyk {
            c: 0.30,
            m: 0.225,
            y: 0.0,
            k: 0.0,
            rgb: rgb_30,
            spot: Some(spot_id),
        };
        let spot_50 = Paint::Cmyk {
            c: 0.50,
            m: 0.375,
            y: 0.0,
            k: 0.0,
            rgb: rgb_50,
            spot: Some(spot_id),
        };
        emit_rect(
            Rect {
                x: 0.0,
                y: 0.0,
                w: 100.0,
                h: 100.0,
            },
            spot_30,
            &mut list,
        );
        emit_rect(
            Rect {
                x: 20.0,
                y: 20.0,
                w: 60.0,
                h: 60.0,
            },
            spot_50,
            &mut list,
        );
        // Upgrade the top draw to overprint.
        let last = list.commands.len() - 1;
        if let paged_compose::DisplayCommand::FillPath {
            path_id,
            paint,
            transform,
        } = list.commands[last]
        {
            list.commands[last] = paged_compose::DisplayCommand::FillPathOverprint {
                path_id,
                paint,
                transform,
            };
        }
        let mut opts = RasterOptions::new(100.0, 100.0);
        opts.dpi = 72.0;
        let img = rasterize(&list, &opts);
        let center = at(&img, 50, 50);
        // The overlap pixel: max(50%, 30%) = 50% of the alternate.
        // Resulting CMYK is (50, 37, 0, 0) — recover and compare.
        // Note alt[1] = 191 ⇒ 50% of 191 ≈ 95 (which is 0.50 * 0.75 ≈ 0.375).
        let (rc, rm, ry, rk) = rgb_to_naive_cmyk_8bit(center[0], center[1], center[2]);
        // 50% spot composed via alternate × tint gives CMYK ≈ (128, 95, 0, 0).
        assert!(
            (rc as i32 - 128).abs() <= 6,
            "overlap should carry 50% spot's C ≈ 128; got CMYK=({rc},{rm},{ry},{rk}) pixel={center:?}"
        );
        assert!(
            (rm as i32 - 95).abs() <= 6,
            "overlap should carry 50% spot's M ≈ 95; got CMYK=({rc},{rm},{ry},{rk}) pixel={center:?}"
        );
        assert!(
            ry <= 5 && rk <= 5,
            "overlap should not invent Y or K; got CMYK=({rc},{rm},{ry},{rk}) pixel={center:?}"
        );
    }

    /// Stage C invariant 2: two DIFFERENT spot inks overprinting
    /// each other accumulate independently in their own planes. The
    /// visible pixel is the per-channel max of each ink's CMYK
    /// contribution. Spot A with alternate (100, 0, 0, 0) over spot B
    /// with alternate (0, 100, 0, 0) at 100% each should produce
    /// CMYK=(100, 100, 0, 0) — i.e. blue.
    #[test]
    fn spot_overprint_different_inks_accumulate_independently() {
        use paged_compose::SpotInk;
        let mut list = DisplayList::new();
        let spot_a = list.push_spot_ink(SpotInk {
            name: "Color/InkA".to_string(),
            cmyk_alternate: [255, 0, 0, 0],
        });
        let spot_b = list.push_spot_ink(SpotInk {
            name: "Color/InkB".to_string(),
            cmyk_alternate: [0, 255, 0, 0],
        });
        let rgb_a = crate::cmyk_unit_to_linear_rgb(1.0, 0.0, 0.0, 0.0);
        let rgb_b = crate::cmyk_unit_to_linear_rgb(0.0, 1.0, 0.0, 0.0);
        let paint_a = Paint::Cmyk {
            c: 1.0,
            m: 0.0,
            y: 0.0,
            k: 0.0,
            rgb: rgb_a,
            spot: Some(spot_a),
        };
        let paint_b = Paint::Cmyk {
            c: 0.0,
            m: 1.0,
            y: 0.0,
            k: 0.0,
            rgb: rgb_b,
            spot: Some(spot_b),
        };
        emit_rect(
            Rect {
                x: 0.0,
                y: 0.0,
                w: 100.0,
                h: 100.0,
            },
            paint_a,
            &mut list,
        );
        emit_rect(
            Rect {
                x: 20.0,
                y: 20.0,
                w: 60.0,
                h: 60.0,
            },
            paint_b,
            &mut list,
        );
        let last = list.commands.len() - 1;
        if let paged_compose::DisplayCommand::FillPath {
            path_id,
            paint,
            transform,
        } = list.commands[last]
        {
            list.commands[last] = paged_compose::DisplayCommand::FillPathOverprint {
                path_id,
                paint,
                transform,
            };
        }
        let mut opts = RasterOptions::new(100.0, 100.0);
        opts.dpi = 72.0;
        let img = rasterize(&list, &opts);
        let center = at(&img, 50, 50);
        let (c, m, y, k) = rgb_to_naive_cmyk_8bit(center[0], center[1], center[2]);
        assert!(
            c >= 250 && m >= 250,
            "different-ink spot overprint should accumulate both inks; got CMYK=({c},{m},{y},{k}) pixel={center:?}"
        );
        assert!(
            y <= 5 && k <= 5,
            "different-ink spot overprint shouldn't invent Y/K; got CMYK=({c},{m},{y},{k}) pixel={center:?}"
        );
    }

    /// Stage C invariant 3: spot ink overprinting a process CMYK
    /// paint accumulates both inks in their respective planes — the
    /// process CMYK plane stays at its prior values and the spot
    /// plane stores the new tint. Visible pixel is the union.
    /// Magenta (process CMYK) covered with spot-ink-yellow (alternate
    /// = pure Y) at 100% overprint should produce CMYK=(0,100,100,0)
    /// i.e. red.
    #[test]
    fn spot_overprint_over_process_cmyk_is_union_of_inks() {
        use paged_compose::SpotInk;
        let mut list = DisplayList::new();
        let yellow_spot = list.push_spot_ink(SpotInk {
            name: "Color/CustomYellow".to_string(),
            cmyk_alternate: [0, 0, 255, 0],
        });
        let magenta_rgb = crate::cmyk_unit_to_linear_rgb(0.0, 1.0, 0.0, 0.0);
        let yellow_rgb = crate::cmyk_unit_to_linear_rgb(0.0, 0.0, 1.0, 0.0);
        let magenta = Paint::Cmyk {
            c: 0.0,
            m: 1.0,
            y: 0.0,
            k: 0.0,
            rgb: magenta_rgb,
            spot: None,
        };
        let yellow_spot_paint = Paint::Cmyk {
            c: 0.0,
            m: 0.0,
            y: 1.0,
            k: 0.0,
            rgb: yellow_rgb,
            spot: Some(yellow_spot),
        };
        emit_rect(
            Rect {
                x: 0.0,
                y: 0.0,
                w: 100.0,
                h: 100.0,
            },
            magenta,
            &mut list,
        );
        emit_rect(
            Rect {
                x: 20.0,
                y: 20.0,
                w: 60.0,
                h: 60.0,
            },
            yellow_spot_paint,
            &mut list,
        );
        let last = list.commands.len() - 1;
        if let paged_compose::DisplayCommand::FillPath {
            path_id,
            paint,
            transform,
        } = list.commands[last]
        {
            list.commands[last] = paged_compose::DisplayCommand::FillPathOverprint {
                path_id,
                paint,
                transform,
            };
        }
        let mut opts = RasterOptions::new(100.0, 100.0);
        opts.dpi = 72.0;
        let img = rasterize(&list, &opts);
        let center = at(&img, 50, 50);
        let (c, m, y, k) = rgb_to_naive_cmyk_8bit(center[0], center[1], center[2]);
        assert!(
            m >= 250 && y >= 250,
            "spot over process CMYK should compose both inks; got CMYK=({c},{m},{y},{k}) pixel={center:?}"
        );
        assert!(
            c <= 5 && k <= 5,
            "should not invent C/K; got CMYK=({c},{m},{y},{k}) pixel={center:?}"
        );
    }

    #[test]
    fn q05_multiply_group_over_transparent_paper_renders_as_multiply_on_white() {
        // Q-05 regression: a 50%-grey Multiply rect over virgin
        // (un-painted) page area should composite as Multiply onto
        // opaque paper-white — InDesign treats paper as α=1 even
        // though the device-space pixel beneath is α=0.
        //
        // Without the snapshot-substitute-paper bypass, the snapshot
        // captures α=0 pixels, `near_paper` rejects them (alpha diff
        // 255), and the Multiply composites against transparent
        // black → annihilates: Multiply(grey, transparent) = grey,
        // but the source-over result against opaque paper afterwards
        // ends up showing grey-over-paper anyway only because
        // the former CPU rasterizer's Multiply clamped to SourceOver
        // when the dst was fully transparent.
        // The cycle-2 unit-test guard is the inverse case:
        // Multiply 50%-grey over snapshot-substituted-paper should
        // produce ~50% grey, not transparent.
        use paged_compose::{BlendMode, Color, DisplayCommand as Cmd, Paint, Transform as XF};
        let mut list = DisplayList::new();
        // Begin a Multiply blend group covering (10,10)-(40,40).
        let bounds = Rect {
            x: 10.0,
            y: 10.0,
            w: 30.0,
            h: 30.0,
        };
        list.commands.push(Cmd::BeginBlendGroup {
            bounds,
            blend_mode: BlendMode::Multiply,
            opacity: 1.0,
            isolated: false,
            knockout: false,
            transform: XF([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]),
        });
        // Inside the group: 50%-grey opaque fill over the same bounds.
        let (path_id, xform) = unit_rect_at(&mut list, 10.0, 10.0, 30.0, 30.0);
        list.commands.push(Cmd::FillPath {
            path_id,
            paint: Paint::Solid(Color::rgba(0.5, 0.5, 0.5, 1.0)),
            transform: xform,
        });
        list.commands
            .push(Cmd::EndBlendGroup(XF([1.0, 0.0, 0.0, 1.0, 0.0, 0.0])));
        let mut opts = RasterOptions::new(50.0, 50.0);
        opts.dpi = 72.0;
        let img = rasterize(&list, &opts);
        // Centre of the Multiply rect: should be ~50% grey, not paper-white
        // (the rect contributed) and not transparent.
        let centre = at(&img, 25, 25);
        assert_eq!(centre[3], 255, "alpha must stay opaque; got {centre:?}");
        // Multiply(linear 0.5, linear 1.0) = linear 0.5 → sRGB ≈ 188.
        // The key guard is opaque-and-darker-than-paper; without the
        // Q-05 snapshot-substitute-paper path the centre stays at the
        // paper colour (alpha would still be 255 because the bypass
        // wouldn't run, leaving the underlying paper untouched).
        assert!(
            centre[0] < 230,
            "Multiply over paper should darken the page; got R={} pixel={centre:?}",
            centre[0]
        );
        assert!(
            centre[0] >= 100,
            "Multiply 50% × paper-white shouldn't go black; got R={} pixel={centre:?}",
            centre[0]
        );
        // Far outside the group: untouched paper.
        let outside = at(&img, 2, 2);
        assert!(
            outside[0] > 240 && outside[3] == 255,
            "outside should be paper white; got {outside:?}"
        );
    }

    #[test]
    fn scene_sweep_gradient_fill_rasterises_angular_colour_variation() {
        // C-1.4 SWEEP: a conic gradient red→green→blue→red around the
        // centre of a square must paint DIFFERENT colours at different
        // polar angles. We lower a SceneItem::FillPathGradient(Sweep)
        // through emit_scene_layer (the real plugin path) and sample
        // four cardinal directions from the centre.
        use paged_compose::{
            emit_scene_layer, SceneGradient, SceneGradientStop, SceneItem, SceneLayer,
            ScenePathSeg, Transform as CTransform,
        };

        let stop = |offset: f32, r: f32, g: f32, b: f32| SceneGradientStop {
            offset,
            r,
            g,
            b,
            a: 1.0,
        };
        // 60×60 square centred at (30,30); sweep starts at angle 0 (+x).
        let square = vec![
            ScenePathSeg::MoveTo { x: 0.0, y: 0.0 },
            ScenePathSeg::LineTo { x: 60.0, y: 0.0 },
            ScenePathSeg::LineTo { x: 60.0, y: 60.0 },
            ScenePathSeg::LineTo { x: 0.0, y: 60.0 },
            ScenePathSeg::Close,
        ];
        let layer = SceneLayer {
            items: vec![SceneItem::FillPathGradient {
                path: square,
                gradient: SceneGradient::Sweep {
                    cx: 30.0,
                    cy: 30.0,
                    start_angle: 0.0,
                    stops: vec![
                        stop(0.0, 1.0, 0.0, 0.0),
                        stop(0.33, 0.0, 1.0, 0.0),
                        stop(0.66, 0.0, 0.0, 1.0),
                        stop(1.0, 1.0, 0.0, 0.0),
                    ],
                },
            }],
        };
        let mut list = DisplayList::new();
        // No clip (size 0) so the fill isn't bracketed; geometry already
        // in page space.
        emit_scene_layer(
            &mut list,
            &layer,
            CTransform::IDENTITY,
            (0.0, 0.0),
            |_, _, _| {},
        );

        let mut opts = RasterOptions::new(60.0, 60.0);
        opts.dpi = 72.0;
        let img = rasterize(&list, &opts);

        // Sample points a few px out from the centre along +x, +y, -x.
        // A sweep gradient must give these distinct hues — assert the
        // dominant channel differs between at least two of them.
        let east = at(&img, 50, 30); // angle ≈ 0  → near red stop
        let south = at(&img, 30, 50); // angle ≈ 90° → into the ramp
        let west = at(&img, 10, 30); // angle ≈ 180° → further along
        let dominant = |p: [u8; 4]| -> usize {
            let (mut idx, mut best) = (0usize, p[0]);
            for (i, &v) in p[..3].iter().enumerate() {
                if v > best {
                    best = v;
                    idx = i;
                }
            }
            idx
        };
        // Angular variation: not all three samples share one dominant
        // channel (a solid/linear fill would, a sweep won't).
        let de = dominant(east);
        let ds = dominant(south);
        let dw = dominant(west);
        assert!(
            !(de == ds && ds == dw),
            "sweep gradient must vary by angle; east={east:?} south={south:?} west={west:?}"
        );
        // And the raw pixels differ around the ring.
        assert!(
            east != south || south != west,
            "expected angular colour variation; east={east:?} south={south:?} west={west:?}"
        );
    }

    #[test]
    fn scene_drop_shadow_rasterises_blurred_offset_stamp() {
        // C-1.5 DROP SHADOW: a SceneItem::DropShadow lowered through
        // emit_scene_layer must paint a soft, OFFSET stamp — pixels at
        // the shadow's offset position are darkened (non-paper), and the
        // blur leaves a soft tail just outside the offset rect.
        use paged_compose::{
            emit_scene_layer, SceneItem, SceneLayer, ScenePathSeg, Transform as CTransform,
        };

        // A 20×20 box at (10,10); shadow offset (+12,+12), blur 3pt.
        let box_path = vec![
            ScenePathSeg::MoveTo { x: 10.0, y: 10.0 },
            ScenePathSeg::LineTo { x: 30.0, y: 10.0 },
            ScenePathSeg::LineTo { x: 30.0, y: 30.0 },
            ScenePathSeg::LineTo { x: 10.0, y: 30.0 },
            ScenePathSeg::Close,
        ];
        let layer = SceneLayer {
            items: vec![SceneItem::DropShadow {
                path: box_path,
                offset_x: 12.0,
                offset_y: 12.0,
                blur_radius: 3.0,
                r: 0.0,
                g: 0.0,
                b: 0.0,
                a: 1.0,
            }],
        };
        let mut list = DisplayList::new();
        emit_scene_layer(
            &mut list,
            &layer,
            CTransform::IDENTITY,
            (0.0, 0.0),
            |_, _, _| {},
        );

        let mut opts = RasterOptions::new(80.0, 80.0);
        opts.dpi = 72.0;
        let img = rasterize(&list, &opts);

        // Centre of the offset shadow rect: box (10..30) + offset 12 =>
        // (22..42); sample (32,32) sits inside the offset stamp and must
        // be darkened from paper white.
        let in_shadow = at(&img, 32, 32);
        assert!(
            in_shadow[0] < 220 && in_shadow[1] < 220 && in_shadow[2] < 220,
            "offset shadow stamp should darken the page; got {in_shadow:?}"
        );
        // The ORIGINAL (un-offset) box position is NOT stamped (this item
        // emits only the shadow, not a fill) — paper-ish white there.
        let at_origin = at(&img, 20, 20);
        assert!(
            at_origin[0] > 230,
            "no fill at the un-offset box position; got {at_origin:?}"
        );
        // Blur tail: just outside the hard offset rect (x≈43) is
        // softer than dead centre but still darkened below paper. The
        // tail is one σ = Size/2 = 1.5 pt wide, InDesign's own mapping
        // — it used to be sampled at 45, which is 2σ out and now sits
        // in the last 1 % of the kernel.
        let tail = at(&img, 43, 32);
        assert!(
            tail[0] < 250,
            "blur should leave a soft tail outside the offset rect; got {tail:?}"
        );
        // Far from everything: untouched paper.
        let far = at(&img, 70, 5);
        assert!(far[0] > 240, "far corner should be paper; got {far:?}");
    }

    // ---------------------------------------------------------------
    // C-28 — opacity masks. These are the correctness gate: every
    // assertion below FAILS if the soft mask is ignored, because an
    // ignored mask leaves the target fully painted where the mask says
    // it should be gone.
    // ---------------------------------------------------------------

    /// Emit a full-coverage soft mask over `region`, painted with
    /// `mask_paint`, then a black rect over `target`.
    fn soft_masked_black_rect(
        list: &mut DisplayList,
        mask_type: paged_compose::SoftMaskType,
        invert: bool,
        region: Rect,
        mask_paint: Paint,
        target: Rect,
    ) {
        list.commands
            .push(paged_compose::DisplayCommand::BeginSoftMask {
                mask_type,
                invert,
                transform: paged_compose::Transform::IDENTITY,
            });
        emit_rect(region, mask_paint, list);
        list.commands
            .push(paged_compose::DisplayCommand::BeginMaskedContent(
                paged_compose::Transform::IDENTITY,
            ));
        emit_rect(target, Paint::Solid(Color::rgba(0.0, 0.0, 0.0, 1.0)), list);
        list.commands
            .push(paged_compose::DisplayCommand::EndSoftMask(
                paged_compose::Transform::IDENTITY,
            ));
    }

    /// A WHITE luminosity mask shows the content; the area the mask
    /// never painted hides it. Ignoring the mask would paint the whole
    /// 40×40 target black and the "outside" sample would be black too.
    #[test]
    fn luminosity_soft_mask_shows_under_white_and_hides_outside() {
        let mut list = DisplayList::new();
        soft_masked_black_rect(
            &mut list,
            paged_compose::SoftMaskType::Luminosity,
            false,
            // Mask artwork: a WHITE square covering only the left half.
            Rect {
                x: 0.0,
                y: 0.0,
                w: 20.0,
                h: 40.0,
            },
            Paint::Solid(Color::rgba(1.0, 1.0, 1.0, 1.0)),
            // Target: black over the WHOLE page.
            Rect {
                x: 0.0,
                y: 0.0,
                w: 40.0,
                h: 40.0,
            },
        );
        let mut opts = RasterOptions::new(40.0, 40.0);
        opts.dpi = 72.0;
        let img = rasterize(&list, &opts);

        let shown = at(&img, 10, 20);
        assert!(
            shown[0] < 15 && shown[1] < 15 && shown[2] < 15,
            "under a white luminosity mask the black target must paint; got {shown:?}"
        );
        let hidden = at(&img, 30, 20);
        assert!(
            hidden[0] > 240 && hidden[1] > 240 && hidden[2] > 240,
            "outside the mask artwork the target must be fully hidden (paper); got {hidden:?}"
        );
    }

    /// A BLACK luminosity mask hides the content even though it is
    /// fully opaque — this is the assertion that distinguishes a real
    /// luminosity mask from a hard clip. A `PushClip` over the same
    /// geometry would show the target; the mask must not.
    #[test]
    fn black_luminosity_mask_hides_what_a_clip_would_show() {
        let mut list = DisplayList::new();
        soft_masked_black_rect(
            &mut list,
            paged_compose::SoftMaskType::Luminosity,
            false,
            Rect {
                x: 0.0,
                y: 0.0,
                w: 40.0,
                h: 40.0,
            },
            // Opaque BLACK artwork: full alpha, zero luminance.
            Paint::Solid(Color::rgba(0.0, 0.0, 0.0, 1.0)),
            Rect {
                x: 0.0,
                y: 0.0,
                w: 40.0,
                h: 40.0,
            },
        );
        let mut opts = RasterOptions::new(40.0, 40.0);
        opts.dpi = 72.0;
        let img = rasterize(&list, &opts);
        let p = at(&img, 20, 20);
        assert!(
            p[0] > 240 && p[1] > 240 && p[2] > 240,
            "opaque BLACK artwork must hide the target under a luminosity mask \
             (a clip over the same geometry would show it); got {p:?}"
        );
    }

    /// The same opaque-black artwork under an ALPHA mask SHOWS the
    /// content — alpha reads opacity and ignores colour. Run back to
    /// back with the test above, this pins that the two mask types are
    /// genuinely wired to different resolutions rather than both
    /// falling through to one default.
    #[test]
    fn alpha_soft_mask_reads_opacity_not_colour() {
        let mut list = DisplayList::new();
        soft_masked_black_rect(
            &mut list,
            paged_compose::SoftMaskType::Alpha,
            false,
            Rect {
                x: 0.0,
                y: 0.0,
                w: 20.0,
                h: 40.0,
            },
            Paint::Solid(Color::rgba(0.0, 0.0, 0.0, 1.0)),
            Rect {
                x: 0.0,
                y: 0.0,
                w: 40.0,
                h: 40.0,
            },
        );
        let mut opts = RasterOptions::new(40.0, 40.0);
        opts.dpi = 72.0;
        let img = rasterize(&list, &opts);
        let shown = at(&img, 10, 20);
        assert!(
            shown[0] < 15,
            "opaque artwork must SHOW under an alpha mask; got {shown:?}"
        );
        let hidden = at(&img, 30, 20);
        assert!(
            hidden[0] > 240,
            "unpainted area must hide under an alpha mask; got {hidden:?}"
        );
    }

    /// `invert` flips the coverage: the white half now hides and the
    /// unpainted half shows.
    #[test]
    fn inverted_soft_mask_flips_coverage() {
        let mut list = DisplayList::new();
        soft_masked_black_rect(
            &mut list,
            paged_compose::SoftMaskType::Luminosity,
            true,
            Rect {
                x: 0.0,
                y: 0.0,
                w: 20.0,
                h: 40.0,
            },
            Paint::Solid(Color::rgba(1.0, 1.0, 1.0, 1.0)),
            Rect {
                x: 0.0,
                y: 0.0,
                w: 40.0,
                h: 40.0,
            },
        );
        let mut opts = RasterOptions::new(40.0, 40.0);
        opts.dpi = 72.0;
        let img = rasterize(&list, &opts);
        let under_white = at(&img, 10, 20);
        assert!(
            under_white[0] > 240,
            "inverted: the white half must now HIDE; got {under_white:?}"
        );
        let outside = at(&img, 30, 20);
        assert!(
            outside[0] < 15,
            "inverted: the unpainted half must now SHOW; got {outside:?}"
        );
    }

    /// The headline case: a black→white gradient produces CONTINUOUS
    /// coverage. Sampling across the ramp must give a monotonically
    /// darkening series — a binary clip could not.
    #[test]
    fn gradient_soft_mask_produces_a_continuous_ramp() {
        let mut list = DisplayList::new();
        let grad = list.push_linear_gradient(paged_compose::LinearGradient {
            start: (0.0, 0.0),
            end: (1.0, 0.0),
            stops: vec![
                paged_compose::GradientStop {
                    offset: 0.0,
                    color: Color::rgba(0.0, 0.0, 0.0, 1.0),
                },
                paged_compose::GradientStop {
                    offset: 1.0,
                    color: Color::rgba(1.0, 1.0, 1.0, 1.0),
                },
            ],
        });
        soft_masked_black_rect(
            &mut list,
            paged_compose::SoftMaskType::Luminosity,
            false,
            Rect {
                x: 0.0,
                y: 0.0,
                w: 40.0,
                h: 40.0,
            },
            Paint::LinearGradient(grad),
            Rect {
                x: 0.0,
                y: 0.0,
                w: 40.0,
                h: 40.0,
            },
        );
        let mut opts = RasterOptions::new(40.0, 40.0);
        opts.dpi = 72.0;
        let img = rasterize(&list, &opts);
        let samples: Vec<u8> = [3u32, 12, 20, 28, 37]
            .iter()
            .map(|&x| at(&img, x, 20)[0])
            .collect();
        for w in samples.windows(2) {
            assert!(
                w[1] < w[0],
                "coverage must ramp continuously (each sample darker than the last); \
                 got {samples:?}"
            );
        }
        assert!(
            samples[0] > 230,
            "the black end of the ramp must be near-paper; got {samples:?}"
        );
        assert!(
            samples[4] < 40,
            "the white end of the ramp must be near-black; got {samples:?}"
        );
    }

    /// A soft mask composes with an enclosing clip: the clip-stack
    /// entry the mask pushes must MULTIPLY the parent's coverage, not
    /// replace it. Without the composition step the region outside the
    /// clip but inside the mask would paint.
    #[test]
    fn soft_mask_multiplies_with_an_enclosing_clip() {
        let mut list = DisplayList::new();
        let mut clip_path = paged_compose::PathData::default();
        for (x, y) in [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)] {
            if clip_path.segments.is_empty() {
                clip_path
                    .segments
                    .push(paged_compose::PathSegment::MoveTo { x, y });
            } else {
                clip_path
                    .segments
                    .push(paged_compose::PathSegment::LineTo { x, y });
            }
        }
        clip_path.segments.push(paged_compose::PathSegment::Close);
        let clip_id = list.paths.push_anon(clip_path);
        // unit square → the TOP half of the page (y 0..20).
        list.commands.push(paged_compose::DisplayCommand::PushClip {
            path_id: clip_id,
            transform: paged_compose::Transform([40.0, 0.0, 0.0, 20.0, 0.0, 0.0]),
        });
        // Mask shows the LEFT half.
        soft_masked_black_rect(
            &mut list,
            paged_compose::SoftMaskType::Luminosity,
            false,
            Rect {
                x: 0.0,
                y: 0.0,
                w: 20.0,
                h: 40.0,
            },
            Paint::Solid(Color::rgba(1.0, 1.0, 1.0, 1.0)),
            Rect {
                x: 0.0,
                y: 0.0,
                w: 40.0,
                h: 40.0,
            },
        );
        list.commands.push(paged_compose::DisplayCommand::PopClip(
            paged_compose::Transform::IDENTITY,
        ));
        let mut opts = RasterOptions::new(40.0, 40.0);
        opts.dpi = 72.0;
        let img = rasterize(&list, &opts);
        // Top-left: inside clip AND inside mask ⇒ painted.
        assert!(at(&img, 10, 10)[0] < 15, "clip ∩ mask must paint");
        // Top-right: inside clip, outside mask ⇒ hidden.
        assert!(at(&img, 30, 10)[0] > 240, "clip minus mask must be hidden");
        // Bottom-left: outside clip, inside mask ⇒ hidden.
        assert!(at(&img, 10, 30)[0] > 240, "mask minus clip must be hidden");
    }

    /// Structural tolerance, mirroring the `PopClip` / `EndBlendGroup`
    /// policy: stray markers must not panic and must not corrupt the
    /// page.
    #[test]
    fn stray_soft_mask_markers_are_tolerated() {
        let mut list = DisplayList::new();
        list.commands
            .push(paged_compose::DisplayCommand::BeginMaskedContent(
                paged_compose::Transform::IDENTITY,
            ));
        list.commands
            .push(paged_compose::DisplayCommand::EndSoftMask(
                paged_compose::Transform::IDENTITY,
            ));
        emit_rect(
            Rect {
                x: 5.0,
                y: 5.0,
                w: 10.0,
                h: 10.0,
            },
            Paint::Solid(Color::rgba(0.0, 0.0, 0.0, 1.0)),
            &mut list,
        );
        let mut opts = RasterOptions::new(40.0, 40.0);
        opts.dpi = 72.0;
        let img = rasterize(&list, &opts);
        assert!(
            at(&img, 10, 10)[0] < 15,
            "stray markers must leave the page drawable"
        );
    }
}

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

//! A placed PDF (or Illustrator `.ai`, which is a PDF) drawn from its own
//! drawing operations (ADR 154).
//!
//! `hayro-interpret` walks the placed page and hands each operation to
//! [`ListDevice`], which writes it into the page's display list at the
//! placement's transform: paths as fills and strokes, clips, transparency
//! groups, images as decoded RGBA, text as its glyph outlines. The page
//! stays vector on the canvas, on both rasterizers and in the PDF export.

use hayro_interpret::font::GlyphRun;
use hayro_interpret::hayro_syntax::object::dict::keys::{ART_BOX, BLEED_BOX, TRIM_BOX};
use hayro_interpret::hayro_syntax::object::Rect as PdfRect;
use hayro_interpret::hayro_syntax::page::Page;
use hayro_interpret::hayro_syntax::Pdf;
use hayro_interpret::{
    interpret_page, BlendMode as PdfBlend, ClipPath, Context, Device, DrawMode, DrawProps,
    FillRule as PdfFillRule, Image, ImageDrawProps, InterpreterCache, InterpreterSettings,
    Paint as PdfPaint, SoftMask,
};
use kurbo13::{Affine, BezPath, PathEl};
use paged_compose::{
    BlendMode, Color, DisplayCommand, DisplayList, FillRule, LineCap, LineJoin, Paint, PathData,
    PathSegment, Rect as ListRect, Stroke, Transform,
};
use paged_model::PdfCropBox;

/// True for bytes that open as a PDF: `%PDF-` within the first KB (an
/// Illustrator file may carry a header before it).
pub(crate) fn is_pdf(bytes: &[u8]) -> bool {
    bytes[..bytes.len().min(1024)]
        .windows(5)
        .any(|w| w == b"%PDF-")
}

/// Which page of a placed PDF a frame shows, and the box of that page it
/// is cropped to (engine ADR 1003): the model's `<PDFAttribute>`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct PdfView {
    /// 0-based. A page past the document's last shows its first, as the
    /// renderer always did for a page it could not find.
    pub page: usize,
    pub crop: PdfCropBox,
}

impl Default for PdfView {
    fn default() -> Self {
        PdfView {
            page: 0,
            crop: PdfCropBox::Crop,
        }
    }
}

impl PdfView {
    pub(crate) fn of(placed: Option<&paged_model::PlacedPdf>) -> PdfView {
        placed.map_or_else(PdfView::default, |p| PdfView {
            page: p.page_index(),
            crop: p.crop_box(),
        })
    }
}

/// The number of pages `bytes` holds, or `None` for bytes that do not
/// open as a PDF.
pub fn page_count(bytes: &[u8]) -> Option<usize> {
    if !is_pdf(bytes) {
        return None;
    }
    let pdf = Pdf::new(bytes.to_vec()).ok()?;
    Some(pdf.pages().len())
}

/// The size (pt) of the viewed page's box, or `None`.
pub(crate) fn page_size(bytes: &[u8], view: PdfView) -> Option<(f32, f32)> {
    let pdf = Pdf::new(bytes.to_vec()).ok()?;
    let pages = pdf.pages();
    let page = pages.get(view.page).or_else(|| pages.first())?;
    let (_, w, h, _) = geometry(page, view.crop);
    Some((w, h))
}

/// The transform from the page's PDF space to the viewed box's top-left
/// origin (y down), and the box's size. The crop box is hayro's own
/// mapping, rotation included; another box is that mapping with the box's
/// corners as its extent (a page rotates by quarter turns, so the box
/// stays axis-aligned), cropped to the media box as PDF 32000 §14.11.2
/// asks. A box with no area falls back to the crop box. The flag says the
/// box is not the crop box, so what lies outside it is cropped away.
fn geometry(page: &Page<'_>, crop: PdfCropBox) -> (Affine, f32, f32, bool) {
    let base = Affine::new(page.initial_transform(true).as_coeffs());
    let (w, h) = page.render_dimensions();
    let raw = page.raw();
    let crop_box = page.intersected_crop_box();
    let chosen = match crop {
        PdfCropBox::Crop => return (base, w, h, false),
        PdfCropBox::Media => page.media_box(),
        PdfCropBox::Trim => raw.get::<PdfRect>(TRIM_BOX).unwrap_or(crop_box),
        PdfCropBox::Bleed => raw.get::<PdfRect>(BLEED_BOX).unwrap_or(crop_box),
        PdfCropBox::Art => raw.get::<PdfRect>(ART_BOX).unwrap_or(crop_box),
    };
    let b = chosen.intersect(page.media_box());
    if b.width() < 1e-3 || b.height() < 1e-3 {
        return (base, w, h, false);
    }
    let same = |a: f64, c: f64| (a - c).abs() < 1e-3;
    if same(b.x0, crop_box.x0)
        && same(b.y0, crop_box.y0)
        && same(b.x1, crop_box.x1)
        && same(b.y1, crop_box.y1)
    {
        return (base, w, h, false);
    }
    let corners = [(b.x0, b.y0), (b.x1, b.y0), (b.x0, b.y1), (b.x1, b.y1)]
        .map(|(x, y)| base * kurbo13::Point::new(x, y));
    let min_x = corners.iter().map(|p| p.x).fold(f64::INFINITY, f64::min);
    let min_y = corners.iter().map(|p| p.y).fold(f64::INFINITY, f64::min);
    let max_x = corners
        .iter()
        .map(|p| p.x)
        .fold(f64::NEG_INFINITY, f64::max);
    let max_y = corners
        .iter()
        .map(|p| p.y)
        .fold(f64::NEG_INFINITY, f64::max);
    (
        Affine::translate((-min_x, -min_y)) * base,
        (max_x - min_x) as f32,
        (max_y - min_y) as f32,
        true,
    )
}

/// Interpret the viewed page of `bytes` into `list`, under `transform`
/// (the box's top-left-origin points into page space). `false` when the bytes are not a PDF this interpreter reads.
pub(crate) fn draw_placed_pdf(
    bytes: &[u8],
    view: PdfView,
    transform: Transform,
    list: &mut DisplayList,
) -> bool {
    draw(bytes, view, transform, list).is_some()
}

fn draw(bytes: &[u8], view: PdfView, transform: Transform, list: &mut DisplayList) -> Option<()> {
    let pdf = Pdf::new(bytes.to_vec()).ok()?;
    let pages = pdf.pages();
    let page = pages.get(view.page).or_else(|| pages.first())?;
    let (initial, w, h, boxed) = geometry(page, view.crop);
    let cache = InterpreterCache::new();
    let mut ctx = Context::new(
        initial,
        kurbo13::Rect::new(0.0, 0.0, w as f64, h as f64),
        &cache,
        pdf.xref(),
        InterpreterSettings::default(),
    );
    // A box other than the crop box is a crop: what lies outside it is
    // not shown. (The crop box draws as it always did, unclipped.)
    if boxed {
        let (path_id, _) = list.paths.intern(UNIT_RECT_KEY, unit_rect());
        list.push(DisplayCommand::PushClip {
            path_id,
            transform: Transform::for_rect_in(
                ListRect {
                    x: 0.0,
                    y: 0.0,
                    w,
                    h,
                },
                transform,
            ),
        });
    }
    let mut device = ListDevice {
        list,
        outer: transform,
        clips: 0,
        groups: Vec::new(),
    };
    interpret_page(page, &mut ctx, &mut device);
    // Close what the page left open, so the list stays balanced.
    while device.groups.pop().is_some() {
        device.list.push(DisplayCommand::EndBlendGroup(transform));
    }
    for _ in 0..device.clips {
        device.list.push(DisplayCommand::PopClip(transform));
    }
    if boxed {
        device.list.push(DisplayCommand::PopClip(transform));
    }
    Some(())
}

/// The unit square, interned under the key the frame clips share
/// (`images.rs`), so a box clip adds no path of its own.
const UNIT_RECT_KEY: u64 = 0x1d_4c_69_70_5f_72_65_63;

fn unit_rect() -> PathData {
    PathData::new(vec![
        PathSegment::MoveTo { x: 0.0, y: 0.0 },
        PathSegment::LineTo { x: 1.0, y: 0.0 },
        PathSegment::LineTo { x: 1.0, y: 1.0 },
        PathSegment::LineTo { x: 0.0, y: 1.0 },
        PathSegment::Close,
    ])
}

struct ListDevice<'l> {
    list: &'l mut DisplayList,
    /// Placed-page points → page space.
    outer: Transform,
    /// Clips pushed and not yet popped.
    clips: usize,
    /// Groups pushed and not yet popped.
    groups: Vec<()>,
}

fn affine(a: Affine) -> Transform {
    let c = a.as_coeffs();
    Transform([
        c[0] as f32,
        c[1] as f32,
        c[2] as f32,
        c[3] as f32,
        c[4] as f32,
        c[5] as f32,
    ])
}

fn path_data(p: &BezPath) -> PathData {
    let mut segments = Vec::new();
    for el in p.elements() {
        segments.push(match *el {
            PathEl::MoveTo(a) => PathSegment::MoveTo {
                x: a.x as f32,
                y: a.y as f32,
            },
            PathEl::LineTo(a) => PathSegment::LineTo {
                x: a.x as f32,
                y: a.y as f32,
            },
            PathEl::QuadTo(c, a) => PathSegment::QuadTo {
                cx: c.x as f32,
                cy: c.y as f32,
                x: a.x as f32,
                y: a.y as f32,
            },
            PathEl::CurveTo(c1, c2, a) => PathSegment::CubicTo {
                cx1: c1.x as f32,
                cy1: c1.y as f32,
                cx2: c2.x as f32,
                cy2: c2.y as f32,
                x: a.x as f32,
                y: a.y as f32,
            },
            PathEl::ClosePath => PathSegment::Close,
        });
    }
    PathData::new(segments)
}

fn fill_rule(r: &PdfFillRule) -> FillRule {
    match r {
        PdfFillRule::NonZero => FillRule::NonZero,
        PdfFillRule::EvenOdd => FillRule::EvenOdd,
    }
}

fn paint(p: &PdfPaint<'_>) -> Paint {
    match p {
        // hayro hands colours over as sRGB; the list composites in
        // linear light.
        PdfPaint::Color(c) => {
            let [r, g, b, a] = c.to_rgba().components();
            Paint::Solid(Color::rgba(linear(r), linear(g), linear(b), a))
        }
        // A pattern (a shading or a tile) is not modelled yet: its
        // average-free stand-in is mid grey, which the fixture will show.
        PdfPaint::Pattern(_) => Paint::Solid(Color::rgba(0.5, 0.5, 0.5, 1.0)),
    }
}

/// sRGB-encoded `c` (0..1) in linear light.
fn linear(c: f32) -> f32 {
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

fn blend(b: PdfBlend) -> BlendMode {
    match b {
        PdfBlend::Multiply => BlendMode::Multiply,
        PdfBlend::Screen => BlendMode::Screen,
        PdfBlend::Overlay => BlendMode::Overlay,
        PdfBlend::Darken => BlendMode::Darken,
        PdfBlend::Lighten => BlendMode::Lighten,
        PdfBlend::ColorDodge => BlendMode::ColorDodge,
        PdfBlend::ColorBurn => BlendMode::ColorBurn,
        PdfBlend::HardLight => BlendMode::HardLight,
        PdfBlend::SoftLight => BlendMode::SoftLight,
        PdfBlend::Difference => BlendMode::Difference,
        PdfBlend::Exclusion => BlendMode::Exclusion,
        PdfBlend::Hue => BlendMode::Hue,
        PdfBlend::Saturation => BlendMode::Saturation,
        PdfBlend::Color => BlendMode::Color,
        PdfBlend::Luminosity => BlendMode::Luminosity,
        _ => BlendMode::Normal,
    }
}

impl ListDevice<'_> {
    fn emit(&mut self, path: &BezPath, props: &DrawProps<'_>, mode: &DrawMode) {
        // `f*` and `B*` fill by the even-odd rule (engine ADR 1006); a
        // stroke ignores the rule, so the shared path can carry it.
        let rule = match mode {
            DrawMode::Fill(r) | DrawMode::FillAndStroke(r, _) => fill_rule(r),
            _ => FillRule::NonZero,
        };
        let id = self
            .list
            .paths
            .push_anon(path_data(path).with_fill_rule(rule));
        let transform = self.outer.compose(&affine(props.transform));
        let p = paint(&props.paint);
        let fill = |list: &mut DisplayList| {
            list.push(DisplayCommand::FillPath {
                path_id: id,
                paint: p,
                transform,
            })
        };
        match mode {
            DrawMode::Fill(_) => fill(self.list),
            DrawMode::Stroke(s) => self.stroke(id, p, s, transform),
            DrawMode::FillAndStroke(_, s) => {
                fill(self.list);
                self.stroke(id, p, s, transform);
            }
            DrawMode::Invisible => {}
        }
    }

    fn stroke(
        &mut self,
        id: paged_compose::PathId,
        p: Paint,
        s: &hayro_interpret::StrokeProps,
        transform: Transform,
    ) {
        let mut stroke = Stroke::new(s.line_width);
        stroke.cap = match s.line_cap {
            kurbo13::Cap::Butt => LineCap::Butt,
            kurbo13::Cap::Round => LineCap::Round,
            kurbo13::Cap::Square => LineCap::Square,
        };
        stroke.join = match s.line_join {
            kurbo13::Join::Miter => LineJoin::Miter,
            kurbo13::Join::Round => LineJoin::Round,
            kurbo13::Join::Bevel => LineJoin::Bevel,
        };
        stroke.miter_limit = s.miter_limit;
        if !s.dash_array.is_empty() {
            stroke.dash = paged_compose::DashPattern::from_slice(&s.dash_array);
        }
        self.list.push(DisplayCommand::StrokePath {
            path_id: id,
            paint: p,
            stroke,
            transform,
        });
    }
}

impl<'a> Device<'a> for ListDevice<'_> {
    fn draw_path(&mut self, path: &BezPath, props: DrawProps<'a>, mode: &DrawMode) {
        self.emit(path, &props, mode);
    }

    fn push_clip_path(&mut self, clip: &ClipPath) {
        // `W*` clips even-odd (engine ADR 1006).
        let id = self
            .list
            .paths
            .push_anon(path_data(&clip.path).with_fill_rule(fill_rule(&clip.fill)));
        self.list.push(DisplayCommand::PushClip {
            path_id: id,
            transform: self.outer,
        });
        self.clips += 1;
    }

    fn push_transparency_group(
        &mut self,
        opacity: f32,
        _mask: Option<SoftMask<'a>>,
        mode: PdfBlend,
    ) {
        self.list.push(DisplayCommand::BeginBlendGroup {
            bounds: ListRect {
                x: -1.0e6,
                y: -1.0e6,
                w: 2.0e6,
                h: 2.0e6,
            },
            blend_mode: blend(mode),
            opacity,
            isolated: true,
            knockout: false,
            transform: self.outer,
        });
        self.groups.push(());
    }

    fn draw_glyph_run(&mut self, run: &GlyphRun<'_, 'a>, props: DrawProps<'a>, mode: &DrawMode) {
        for glyph in run.glyphs() {
            // A Type 3 glyph is itself drawing operations; not drawn yet.
            let hayro_interpret::font::Glyph::Outline(outline) = &**glyph else {
                continue;
            };
            let props = DrawProps {
                transform: props.transform * glyph.transform(),
                ..props.clone()
            };
            self.emit(&outline.outline(), &props, mode);
        }
    }

    fn draw_image(&mut self, image: Image<'a, '_>, props: ImageDrawProps<'a>) {
        // A stencil mask (an image painted in the current colour) is not
        // drawn yet.
        let Image::Raster(raster) = image else {
            return;
        };
        let mut decoded = None;
        raster.with_rgba(|data, alpha| decoded = rgba8(data, alpha), None);
        let Some((w, h, rgba)) = decoded else {
            return;
        };
        let image_id = self.list.push_image(paged_compose::DecodedImage {
            width: w,
            height: h,
            encoded: bytes::Bytes::new(),
            rgba: bytes::Bytes::from(rgba),
            icc: None,
            rendering: None,
        });
        // hayro's transform maps the image's pixels (top row first); the
        // list's image command maps the unit square.
        let transform = self
            .outer
            .compose(&affine(props.transform))
            .compose(&Transform::scale(w as f32, h as f32));
        self.list.push(DisplayCommand::Image {
            image_id,
            transform,
        });
    }

    fn pop_clip(&mut self) {
        if self.clips > 0 {
            self.clips -= 1;
            self.list.push(DisplayCommand::PopClip(self.outer));
        }
    }

    fn pop_transparency_group(&mut self) {
        if self.groups.pop().is_some() {
            self.list.push(DisplayCommand::EndBlendGroup(self.outer));
        }
    }
}

/// A decoded PDF image as tightly packed RGBA8, its alpha from `alpha`
/// when that matches the image's size.
fn rgba8(
    data: hayro_interpret::ImageData,
    alpha: Option<hayro_interpret::LumaData>,
) -> Option<(u32, u32, Vec<u8>)> {
    let (w, h) = (data.width(), data.height());
    let n = (w as usize) * (h as usize);
    let mut out = Vec::with_capacity(n * 4);
    match &data {
        hayro_interpret::ImageData::Rgb(rgb) if rgb.data.len() >= n * 3 => {
            for px in rgb.data.as_chunks::<3>().0.iter().take(n) {
                out.extend_from_slice(&[px[0], px[1], px[2], 255]);
            }
        }
        hayro_interpret::ImageData::Luma(l) if l.data.len() >= n => {
            for &v in l.data.iter().take(n) {
                out.extend_from_slice(&[v, v, v, 255]);
            }
        }
        _ => return None,
    }
    if let Some(a) = alpha.filter(|a| a.width == w && a.height == h && a.data.len() >= n) {
        for (px, &v) in out.as_chunks_mut::<4>().0.iter_mut().zip(a.data.iter()) {
            px[3] = v;
        }
    }
    Some((w, h, out))
}

#[cfg(test)]
mod tests {
    use super::*;

    const ART: &[u8] =
        include_bytes!("../../../../corpus/generated/placed-pdf-Links/placed-art.pdf");

    #[test]
    fn a_pdf_is_recognised_behind_a_header() {
        assert!(is_pdf(ART));
        let mut ai = b"%!PS-Adobe-3.0 header\n".to_vec();
        ai.extend_from_slice(ART);
        assert!(is_pdf(&ai));
        assert!(!is_pdf(b"\x89PNG\r\n\x1a\n"));
        assert_eq!(page_size(ART, PdfView::default()), Some((200.0, 120.0)));
    }

    #[test]
    fn the_placed_art_draws_its_paths_stroke_and_clip() {
        let mut list = DisplayList::default();
        assert!(draw_placed_pdf(
            ART,
            PdfView::default(),
            Transform::IDENTITY,
            &mut list
        ));
        let count = |f: fn(&DisplayCommand) -> bool| list.commands.iter().filter(|c| f(c)).count();
        // Two rectangles, the curve, the clipped square, the 50 % panel.
        assert_eq!(count(|c| matches!(c, DisplayCommand::FillPath { .. })), 5);
        let dashed = list.commands.iter().find_map(|c| match c {
            DisplayCommand::StrokePath { stroke, .. } => Some(stroke),
            _ => None,
        });
        assert!(dashed.is_some_and(|s| s.width == 2.0 && s.dash.as_slice() == [6.0, 3.0]));
        assert_eq!(count(|c| matches!(c, DisplayCommand::PushClip { .. })), 1);
        assert_eq!(count(|c| matches!(c, DisplayCommand::PopClip(_))), 1);
        // The DeviceRGB red arrives in linear light, opaque.
        assert!(list.commands.iter().any(|c| matches!(
            c,
            DisplayCommand::FillPath { paint: Paint::Solid(col), .. }
                if (col.r - 1.0).abs() < 1e-6 && col.g == 0.0 && col.b == 0.0 && col.a == 1.0
        )));
    }

    #[test]
    fn bytes_that_are_not_a_pdf_draw_nothing() {
        let mut list = DisplayList::default();
        assert!(!draw_placed_pdf(
            b"%PDF-1.4 truncated",
            PdfView::default(),
            Transform::IDENTITY,
            &mut list
        ));
        assert!(list.commands.is_empty());
    }
}

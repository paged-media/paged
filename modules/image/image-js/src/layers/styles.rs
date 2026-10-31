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

//! LAYER STYLES in the fold (WP5.4): each effect of a layer's style is a
//! step around the layer's own pixels, drawn on the GPU with the
//! `style.*` kernels and blended with the `compose.*` ones.
//!
//! # The order, and why
//!
//! A styled pixel layer folds as (`LayerStack::plan_fold`):
//!
//! 1. `Save` — the backdrop `B`, when the layer's opacity or a mask that
//!    hides effects will be applied to everything at the end.
//! 2. EXTERIOR effects onto the accumulator, each in its own mode and
//!    opacity: Drop Shadow(s), Outer Glow.
//! 3. The BODY. Without interior effects and clipped layers it is the
//!    layer's own `Pixel` step at its FILL opacity. With them it is a
//!    clipping group whose base is the layer made opaque, closed onto the
//!    backdrop with the layer's mode at its fill opacity but WITHOUT the
//!    layer's shape (`ClipClose { shape: false }`); then the INTERIOR
//!    effects (Pattern, Gradient and Color Overlay, Satin, Inner Glow,
//!    Inner Shadow, bottom up) blend onto that; then `BodyClose` mixes the
//!    result into `B'` (the backdrop with the exterior effects) through the
//!    layer's shape. That is what Photoshop draws: a Normal 100 % overlay on
//!    a soft edge is `mix(B, overlay, α)` (the layer-effects fixtures
//!    agree within a level), and at fill 0 a Multiply Inner Shadow
//!    multiplies the backdrop. With Blend Interior Effects as Group the
//!    interior effects join the group before it closes instead, so the
//!    layer's mode and fill apply to them too.
//! 4. TOP effects: Stroke(s), Bevel & Emboss (highlight, then shadow).
//! 5. `StyleClose` — `mix(B, result, opacity × mask)`: the layer's opacity
//!    fades its effects with it, as a unit (a shadow does not show
//!    through a half-transparent layer), and a mask that hides effects
//!    hides them here. Compositing is linear in the source alpha, so for
//!    an unstyled layer this is exactly blending it at its opacity.
//!
//! An effect's SOURCE is the layer's alpha, times its mask unless the
//! mask hides effects (then the mask applies only at `StyleClose`).
//!
//! # Coverage
//!
//! Sizes and distances are in pixels times the style's Scale. A spread
//! (choke) of `p` % turns `p` % of the size into a hard dilation
//! (erosion) through the signed distance field (`style.distance`) and
//! blurs the rest; a precise glow and the chisel bevels fall off with
//! the distance itself. The blur, the contour, noise and the light all
//! follow the conventions recorded against Photoshop in
//! `image-conformance/tests/it/psd_layer_styles.rs`.

use std::sync::Arc;

use image_core::Region;
use image_gpu::{GpuBatch, GpuContext, Resident, TexFormat};
use image_kernels::families::arithmetic::{MathDivParams, MathMulParams, MATH_DIV, MATH_MUL};
use image_kernels::families::band::{
    BandBroadcastAlphaParams, BandTakeParams, BAND_BROADCAST_ALPHA, BAND_TAKE,
};
use image_kernels::families::compose::{ComposeParams, COMPOSE_NORMAL};
use image_kernels::families::gen::{
    GenAngularGradientParams, GenDiamondGradientParams, GenLinearGradientParams, GenPatternParams,
    GenRadialGradientParams, GenReflectedGradientParams, GenSolidParams, GEN_ANGULAR_GRADIENT,
    GEN_DIAMOND_GRADIENT, GEN_LINEAR_GRADIENT, GEN_PATTERN, GEN_RADIAL_GRADIENT,
    GEN_REFLECTED_GRADIENT, GEN_SOLID,
};
use image_kernels::families::minmax::{
    MathClampParams, MathMaxConstParams, MathMaxParams, MATH_CLAMP, MATH_MAX, MATH_MAX_CONST,
};
use image_kernels::families::style::*;
use image_kernels::KernelDef;
use image_psd::effects::{
    Bevel, BevelStyle, BevelTechnique, BlendMode, ColorFill, Contour, GlobalLight, Glow, GlowFill,
    GlowSource, GlowTechnique, GradientFill, GradientOverlay, GradientStyle, LayerStyle,
    PatternFill as StylePattern, PatternOverlay, Satin, Shadow, Stroke, StrokeFill, StrokePosition,
};

use super::kinds::PatternFill;
use crate::ingest::IngestError;

fn gpu_err(e: image_gpu::GpuError) -> IngestError {
    IngestError::Pipeline(e.to_string())
}

/// A pattern a style draws, resolved from the stack's pattern table.
pub type PatternTile = Arc<PatternFill>;

/// One effect as the fold draws it: the effect, the style's scale, the
/// light it is lit by (Global Light resolved), the layer's bounds
/// (gradients and patterns aligned with the layer) and, for a pattern,
/// its tile.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct EffectStep {
    pub fx: Fx,
    pub scale: f32,
    pub light: GlobalLight,
    pub bounds: Region,
    pub pattern: Option<PatternTile>,
    /// The noise stream's seed (the layer id).
    pub seed: u32,
    /// The layer's fill opacity (0–1): a drop shadow is knocked out by the
    /// part of the layer its fill leaves transparent.
    pub fill: f32,
    /// How far the style's (first) stroke reaches outside the layer's
    /// edge, px — where a Stroke Emboss bevel's edge lies.
    pub stroke_reach: f32,
}

/// How far the first enabled stroke of `style` reaches outside the edge.
pub(super) fn stroke_reach(style: &LayerStyle) -> f32 {
    let k = style.scale / 100.0;
    style
        .strokes
        .iter()
        .find(|s| s.enabled)
        .map_or(0.0, |s| match s.position {
            StrokePosition::Outside => s.size * k,
            StrokePosition::Center => s.size * k / 2.0,
            StrokePosition::Inside => 0.0,
        })
}

#[derive(Debug, Clone, PartialEq)]
pub(super) enum Fx {
    DropShadow(Shadow),
    InnerShadow(Shadow),
    OuterGlow(Glow),
    InnerGlow(Glow),
    Satin(Satin),
    ColorOverlay(ColorFill),
    GradientOverlay(GradientOverlay),
    PatternOverlay(PatternOverlay),
    Stroke(Stroke, StrokePart),
    Bevel(Bevel),
}

/// Which side of the layer's edge a stroke draws on. Photoshop draws a
/// stroke's OUTER part beneath the layer (the layer's anti-aliased edge
/// blends over it) and its INNER part inside the layer, replacing the
/// layer's pixels there (an inside stroke's edge texel shows the stroke
/// over the backdrop, not over the layer) — measured on its strokes of an
/// anti-aliased ellipse.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) enum StrokePart {
    /// The shape grown by this many px, beneath the layer.
    Outer(f32),
    /// This many px inward from the edge, inside the layer.
    Inner(f32),
}

/// A style's effects in the fold's places, each bottom-up: beneath the
/// layer, inside it (with Blend Interior Effects as Group: before its
/// mode applies), inside it always after, and on top.
#[derive(Default)]
pub(super) struct StylePlan {
    pub exterior: Vec<Fx>,
    pub interior: Vec<Fx>,
    pub interior_top: Vec<Fx>,
    pub top: Vec<Fx>,
}

impl StylePlan {
    pub fn of(style: &LayerStyle) -> StylePlan {
        let mut p = StylePlan::default();
        if !style.enabled {
            return p;
        }
        // Several instances: the first listed is the top-most (the
        // dialog's order), so they are drawn last first.
        for s in style.drop_shadows.iter().rev().filter(|s| s.enabled) {
            p.exterior.push(Fx::DropShadow(s.clone()));
        }
        if let Some(g) = style.outer_glow.as_ref().filter(|g| g.enabled) {
            p.exterior.push(Fx::OuterGlow(g.clone()));
        }
        let strokes: Vec<&Stroke> = style.strokes.iter().rev().filter(|s| s.enabled).collect();
        let k = style.scale / 100.0;
        for s in &strokes {
            let size = s.size * k;
            match s.position {
                StrokePosition::Outside => p
                    .exterior
                    .push(Fx::Stroke((*s).clone(), StrokePart::Outer(size))),
                StrokePosition::Center => p
                    .exterior
                    .push(Fx::Stroke((*s).clone(), StrokePart::Outer(size / 2.0))),
                StrokePosition::Inside => {}
            }
        }
        if let Some(o) = style.pattern_overlay.as_ref().filter(|o| o.enabled) {
            p.interior.push(Fx::PatternOverlay(o.clone()));
        }
        for o in style.gradient_overlays.iter().rev().filter(|o| o.enabled) {
            p.interior.push(Fx::GradientOverlay(o.clone()));
        }
        for o in style.color_overlays.iter().rev().filter(|o| o.enabled) {
            p.interior.push(Fx::ColorOverlay(o.clone()));
        }
        if let Some(s) = style.satin.as_ref().filter(|s| s.enabled) {
            p.interior.push(Fx::Satin(s.clone()));
        }
        if let Some(g) = style.inner_glow.as_ref().filter(|g| g.enabled) {
            p.interior.push(Fx::InnerGlow(g.clone()));
        }
        for s in style.inner_shadows.iter().rev().filter(|s| s.enabled) {
            p.interior_top.push(Fx::InnerShadow(s.clone()));
        }
        for s in &strokes {
            let size = s.size * k;
            match s.position {
                StrokePosition::Inside => p
                    .interior_top
                    .push(Fx::Stroke((*s).clone(), StrokePart::Inner(size))),
                StrokePosition::Center => p
                    .interior_top
                    .push(Fx::Stroke((*s).clone(), StrokePart::Inner(size / 2.0))),
                StrokePosition::Outside => {}
            }
        }
        if let Some(b) = style.bevel.as_ref().filter(|b| b.enabled) {
            p.top.push(Fx::Bevel(b.clone()));
        }
        p
    }

    pub fn is_empty(&self) -> bool {
        self.exterior.is_empty()
            && self.interior.is_empty()
            && self.interior_top.is_empty()
            && self.top.is_empty()
    }
}

impl Fx {
    /// The pattern this effect draws, if any.
    pub fn pattern(&self) -> Option<&StylePattern> {
        match self {
            Fx::PatternOverlay(o) => Some(&o.fill),
            Fx::Stroke(s, _) => match &s.fill {
                StrokeFill::Pattern(p) => Some(p),
                _ => None,
            },
            Fx::Bevel(b) => b.texture.as_ref().filter(|t| t.enabled).map(|t| &t.fill),
            _ => None,
        }
    }

    /// Does it need the layer's bounds (a gradient or pattern aligned
    /// with the layer)?
    pub fn needs_bounds(&self) -> bool {
        match self {
            Fx::GradientOverlay(o) => o.fill.align,
            Fx::Stroke(s, _) => matches!(&s.fill, StrokeFill::Gradient(g) if g.align),
            _ => self.pattern().is_some(),
        }
    }
}

/// The bounding box of the texels with any alpha in a canvas-sized RGBA8
/// plate (the whole canvas when it is empty).
pub(super) fn alpha_bounds(px: &[u8], w: u32, h: u32) -> Region {
    let (mut x0, mut y0, mut x1, mut y1) = (u32::MAX, u32::MAX, 0u32, 0u32);
    for y in 0..h {
        let row = &px[(y * w * 4) as usize..((y + 1) * w * 4) as usize];
        for (x, p) in row.as_chunks::<4>().0.iter().enumerate() {
            if p[3] != 0 {
                let x = x as u32;
                x0 = x0.min(x);
                x1 = x1.max(x);
                y0 = y0.min(y);
                y1 = y1.max(y);
            }
        }
    }
    if x0 == u32::MAX {
        return Region::new(0, 0, w, h);
    }
    Region::new(x0 as i32, y0 as i32, x1 - x0 + 1, y1 - y0 + 1)
}

// ───────────────────────────── conventions ─────────────────────────────

/// The blur a Photoshop effect SIZE is: two passes of a box `size` px
/// wide (radius `(size − 1) / 2`), a tent reaching `size − 1` px. Fitted
/// to the edge profiles of Photoshop's size-3, -10 and -20 drop shadows
/// (`psd_layer_styles.rs`): the best box radii were 1.0, 4.5 and 9.1, where
/// the best Gaussian is twice as far off.
pub fn size_box_radius(size: f32) -> f32 {
    ((size - 1.0) / 2.0).max(0.0)
}

/// A light from `angle` (degrees, counter-clockwise from 3 o'clock) casts
/// a shadow `distance` px the other way: the offset in image axes (y down).
fn shadow_offset(angle: f32, distance: f32) -> (f32, f32) {
    let a = angle.to_radians();
    ((-distance * a.cos()).round(), (distance * a.sin()).round())
}

fn rgb01(c: [u8; 3]) -> [f32; 3] {
    c.map(|v| f32::from(v) / 255.0)
}

fn blend_def(b: BlendMode) -> &'static KernelDef {
    crate::stroke::blend_kernel(b.name()).unwrap_or(&COMPOSE_NORMAL)
}

// ───────────────────────────── the recorder ─────────────────────────────

/// The textures one styled layer's effects share within a composite: its
/// source alpha, and the signed distance field once one effect asked.
pub(super) struct Source {
    pub alpha: Resident,
    sd: Option<(f32, Resident)>,
}

impl Source {
    pub fn new(alpha: Resident) -> Source {
        Source { alpha, sd: None }
    }
}

struct Rec<'a, 'c> {
    ctx: &'c GpuContext,
    batch: &'a mut GpuBatch<'c>,
    w: u32,
    h: u32,
    /// Where these textures lie on the canvas, and the canvas's size: a
    /// tile of the tiled fold (ADR 480) draws its gradients, patterns and
    /// noise in canvas coordinates, so a tile shows what the whole fold
    /// shows there.
    frame: super::fold::Frame,
}

impl<'a, 'c> Rec<'a, 'c> {
    fn run(
        &mut self,
        def: &'static KernelDef,
        inputs: &[&Resident],
        params: &[u8],
    ) -> Result<Resident, IngestError> {
        let out = self.batch.target(self.w, self.h);
        self.batch
            .dispatch(def, inputs, params, None, &out)
            .map_err(gpu_err)?;
        Ok(out)
    }

    fn masked(
        &mut self,
        def: &'static KernelDef,
        inputs: &[&Resident],
        params: &[u8],
        mask: Option<&Resident>,
    ) -> Result<Resident, IngestError> {
        let out = self.batch.target(self.w, self.h);
        self.batch
            .dispatch(def, inputs, params, mask, &out)
            .map_err(gpu_err)?;
        Ok(out)
    }

    fn invert(&mut self, x: &Resident) -> Result<Resident, IngestError> {
        self.run(
            &STYLE_CONTOUR,
            &[x],
            StyleContourParams::identity(true, 0).as_bytes(),
        )
    }

    fn max(&mut self, a: &Resident, b: &Resident) -> Result<Resident, IngestError> {
        self.run(&MATH_MAX, &[a, b], MathMaxParams::new().as_bytes())
    }

    fn shift(
        &mut self,
        x: &Resident,
        d: (f32, f32),
        invert: bool,
        outside: f32,
    ) -> Result<Resident, IngestError> {
        if d.0 == 0.0 && d.1 == 0.0 && !invert {
            return Ok(x.clone());
        }
        self.run(
            &STYLE_SHIFT,
            &[x],
            StyleShiftParams::new(d.0, d.1, 0, invert, outside).as_bytes(),
        )
    }

    fn blur(&mut self, x: &Resident, sigma: f32, outside: f32) -> Result<Resident, IngestError> {
        if sigma <= 0.05 {
            return Ok(x.clone());
        }
        let p = StyleBlurParams::new(sigma, (sigma * 3.0).ceil() as u32, outside);
        let h = self.run(&STYLE_BLUR_H, &[x], p.as_bytes())?;
        self.run(&STYLE_BLUR_V, &[&h], p.as_bytes())
    }

    /// An effect's SIZE as a blur ([`size_box_radius`]).
    fn size_blur(
        &mut self,
        x: &Resident,
        size: f32,
        outside: f32,
    ) -> Result<Resident, IngestError> {
        let r = size_box_radius(size);
        if r <= 0.01 {
            return Ok(x.clone());
        }
        let p = StyleBlurParams::boxed(r, outside);
        let mut cur = x.clone();
        for _ in 0..2 {
            let h = self.run(&STYLE_BLUR_H, &[&cur], p.as_bytes())?;
            cur = self.run(&STYLE_BLUR_V, &[&h], p.as_bytes())?;
        }
        Ok(cur)
    }

    /// The signed distance field of coverage `cov` (`.r`), accurate to
    /// `reach` px from the edge (farther it may read as "far").
    fn sdf(&mut self, cov: &Resident, reach: f32) -> Result<Resident, IngestError> {
        let mut field = self.run(
            &STYLE_JFA_SEED,
            &[cov],
            StyleJfaSeedParams::new(0.5).as_bytes(),
        )?;
        let reach = reach.clamp(1.0, 1024.0).ceil() as i32;
        let mut step = (reach as u32).next_power_of_two() as i32;
        // The canvas's, not the tile's: a tile runs the same passes.
        let longest = self.frame.cw.max(self.frame.ch) as i32;
        while step > longest && step > 1 {
            step /= 2;
        }
        let mut steps = Vec::new();
        while step >= 1 {
            steps.push(step);
            step /= 2;
        }
        steps.push(1);
        for s in steps {
            field = self.run(
                &STYLE_JFA_STEP,
                &[&field],
                StyleJfaStepParams::new(s).as_bytes(),
            )?;
        }
        self.run(
            &STYLE_DISTANCE,
            &[&field, cov],
            StyleDistanceParams::new().as_bytes(),
        )
    }

    fn source_sd(&mut self, src: &mut Source, reach: f32) -> Result<Resident, IngestError> {
        if let Some((r, sd)) = &src.sd {
            if *r >= reach {
                return Ok(sd.clone());
            }
        }
        let sd = self.sdf(&src.alpha.clone(), reach)?;
        src.sd = Some((reach, sd.clone()));
        Ok(sd)
    }

    fn ramp(&mut self, sd: &Resident, p: StyleRampParams) -> Result<Resident, IngestError> {
        self.run(&STYLE_RAMP, &[sd], p.as_bytes())
    }

    fn contour(
        &mut self,
        x: &Resident,
        c: &Contour,
        lo: f32,
        hi: f32,
        invert: bool,
    ) -> Result<Resident, IngestError> {
        if c.is_linear() && lo == 0.0 && hi == 1.0 && !invert {
            return Ok(x.clone());
        }
        self.run(
            &STYLE_CONTOUR,
            &[x],
            StyleContourParams::new(&c.lut(), lo, hi, invert, 0).as_bytes(),
        )
    }

    /// A coverage → the effect's premultiplied colour plate.
    fn colorize(
        &mut self,
        cov: &Resident,
        p: StyleColorizeParams,
    ) -> Result<Resident, IngestError> {
        let p = p.at(self.frame.ox, self.frame.oy);
        self.run(&STYLE_COLORIZE, &[cov], p.as_bytes())
    }

    /// An opaque plate of one colour.
    fn solid(&mut self, rgb: [u8; 3]) -> Result<Resident, IngestError> {
        let c = rgb01(rgb);
        let zeros = self.ctx.zeros(self.w, self.h);
        self.run(
            &GEN_SOLID,
            &[&zeros],
            GenSolidParams::new(0, 0, c[0], c[1], c[2], 1.0).as_bytes(),
        )
    }

    /// Blend `plate` onto `acc` in `mode` at `opacity` (0–1), through
    /// `mask` (`.r`).
    fn blend(
        &mut self,
        acc: &Resident,
        plate: &Resident,
        mode: BlendMode,
        opacity: f32,
        mask: Option<&Resident>,
    ) -> Result<Resident, IngestError> {
        self.masked(
            blend_def(mode),
            &[acc, plate],
            ComposeParams::new(opacity.clamp(0.0, 1.0)).as_bytes(),
            mask,
        )
    }

    /// The `t` ramp (black → white) of a gradient fill over `area`.
    fn gradient_t(&mut self, g: &GradientFill, area: Region) -> Result<Resident, IngestError> {
        let zeros = self.ctx.zeros(self.w, self.h);
        let (ox, oy) = (self.frame.ox, self.frame.oy);
        let (black, white) = ([0.0, 0.0, 0.0, 1.0], [1.0, 1.0, 1.0, 1.0]);
        let (rw, rh) = (area.w as f32, area.h as f32);
        let c = (
            area.x as f32 + rw / 2.0 + g.offset.0 / 100.0 * rw,
            area.y as f32 + rh / 2.0 + g.offset.1 / 100.0 * rh,
        );
        let t = g.angle.to_radians();
        let d = (t.cos(), -t.sin());
        let scale = (g.scale / 100.0).max(0.01);
        let half = ((rw / 2.0 * d.0.abs() + rh / 2.0 * d.1.abs()) * scale).max(0.5);
        let angle = d.1.atan2(d.0);
        match g.style {
            GradientStyle::Linear => self.run(
                &GEN_LINEAR_GRADIENT,
                &[&zeros],
                GenLinearGradientParams::new(
                    ox,
                    oy,
                    c.0 - d.0 * half,
                    c.1 - d.1 * half,
                    c.0 + d.0 * half,
                    c.1 + d.1 * half,
                    black,
                    white,
                )
                .as_bytes(),
            ),
            GradientStyle::Radial => {
                let radius = half;
                self.run(
                    &GEN_RADIAL_GRADIENT,
                    &[&zeros],
                    GenRadialGradientParams::new(ox, oy, c.0, c.1, radius, black, white).as_bytes(),
                )
            }
            GradientStyle::Angle => self.run(
                &GEN_ANGULAR_GRADIENT,
                &[&zeros],
                // The kernel's sweep starts opposite Photoshop's seam.
                GenAngularGradientParams::new(
                    ox,
                    oy,
                    c.0,
                    c.1,
                    angle + std::f32::consts::PI,
                    black,
                    white,
                )
                .as_bytes(),
            ),
            GradientStyle::Reflected => self.run(
                &GEN_REFLECTED_GRADIENT,
                &[&zeros],
                GenReflectedGradientParams::new(
                    ox,
                    oy,
                    c.0,
                    c.1,
                    c.0 + d.0 * half,
                    c.1 + d.1 * half,
                    black,
                    white,
                )
                .as_bytes(),
            ),
            GradientStyle::Diamond => self.run(
                &GEN_DIAMOND_GRADIENT,
                &[&zeros],
                GenDiamondGradientParams::new(ox, oy, c.0, c.1, angle, half, black, white)
                    .as_bytes(),
            ),
        }
    }

    /// A gradient fill's premultiplied plate.
    fn gradient_plate(&mut self, g: &GradientFill, area: Region) -> Result<Resident, IngestError> {
        let t = self.gradient_t(g, area)?;
        self.colorize(
            &t,
            StyleColorizeParams::new(g.gradient.lut(g.reverse), COLORIZE_LOOKUP, 0, 0.0, 0.0, 0),
        )
    }

    /// A pattern's premultiplied plate over the canvas.
    fn pattern_plate(
        &mut self,
        fill: &StylePattern,
        tile: &PatternFill,
        origin: (f32, f32),
    ) -> Result<Resident, IngestError> {
        let (w, h) = (self.w, self.h);
        // The tile's extent as the canvas cuts it, uploaded at that size
        // (the kernel reads `in1` only inside it, so this is the texture
        // the canvas-sized upload was, without its padding).
        let (tw, th) = (
            tile.width.min(self.frame.cw).max(1),
            tile.height.min(self.frame.ch).max(1),
        );
        let mut bytes = vec![0u8; tw as usize * th as usize * 8];
        for y in 0..th.min(tile.height) as usize {
            for x in 0..tw.min(tile.width) as usize {
                let s = (y * tile.width as usize + x) * 4;
                let d = (y * tw as usize + x) * 8;
                let a = f32::from(tile.tile[s + 3]) / 255.0;
                for c in 0..4 {
                    let v = f32::from(tile.tile[s + c]) / 255.0;
                    let v = if c < 3 { v * a } else { v };
                    bytes[d + c * 2..d + c * 2 + 2]
                        .copy_from_slice(&half::f16::from_f32(v).to_le_bytes());
                }
            }
        }
        let tex = self.batch.upload(tw, th, TexFormat::Rgba16Float, &bytes);
        let zeros = self.ctx.zeros(w, h);
        self.run(
            &GEN_PATTERN,
            &[&zeros, &tex],
            GenPatternParams::new(
                self.frame.ox,
                self.frame.oy,
                (fill.scale / 100.0).max(0.01),
                0.0,
                origin.0 + fill.phase.0,
                origin.1 + fill.phase.1,
                1.0,
                tw,
                th,
            )
            .as_bytes(),
        )
    }
}

/// Draw one effect onto `acc`; returns the new accumulator.
pub(super) fn draw<'c>(
    ctx: &'c GpuContext,
    batch: &mut GpuBatch<'c>,
    acc: &Resident,
    src: &mut Source,
    e: &EffectStep,
    frame: super::fold::Frame,
) -> Result<Resident, IngestError> {
    let mut r = Rec {
        ctx,
        batch,
        w: frame.w,
        h: frame.h,
        frame,
    };
    // The whole canvas, in canvas coordinates (the tile's origin moves
    // the gradient kernels onto it).
    let (cw, ch) = (frame.cw, frame.ch);
    let k = (e.scale / 100.0).max(0.0);
    let a = src.alpha.clone();
    match &e.fx {
        Fx::DropShadow(s) => {
            let angle = if s.use_global_light {
                e.light.angle
            } else {
                s.angle
            };
            let size = s.size * k;
            let spread = size * s.spread.clamp(0.0, 100.0) / 100.0;
            let shifted = r.shift(&a, shadow_offset(angle, s.distance * k), false, 0.0)?;
            let grown = if spread > 0.0 {
                let sd = r.sdf(&shifted, spread + 2.0)?;
                r.ramp(&sd, StyleRampParams::band(-4096.0, spread))?
            } else {
                shifted
            };
            let soft = r.size_blur(&grown, size - spread, 0.0)?;
            let cov = r.contour(&soft, &s.contour, 0.0, 1.0, false)?;
            let plate = r.colorize(
                &cov,
                StyleColorizeParams::solid(rgb01(s.color), 0, s.noise / 100.0, e.seed),
            )?;
            // LAYER KNOCKS OUT DROP SHADOW: the shadow is hidden under the
            // layer's shape as far as its fill leaves it transparent
            // (at fill 100 % the layer itself covers the shadow, and an
            // anti-aliased edge shows the shadow through it, as
            // Photoshop's does).
            let mask = if s.knocks_out && e.fill < 1.0 {
                let lut: [f32; 256] =
                    std::array::from_fn(|i| 1.0 - i as f32 / 255.0 * (1.0 - e.fill));
                Some(r.run(
                    &STYLE_CONTOUR,
                    &[&a],
                    StyleContourParams::new(&lut, 0.0, 1.0, false, 0).as_bytes(),
                )?)
            } else {
                None
            };
            r.blend(acc, &plate, s.blend, s.opacity / 100.0, mask.as_ref())
        }
        Fx::InnerShadow(s) => {
            let angle = if s.use_global_light {
                e.light.angle
            } else {
                s.angle
            };
            let size = s.size * k;
            let choke = size * s.spread.clamp(0.0, 100.0) / 100.0;
            // The inverse of the shape, moved, grown by the choke, blurred:
            // beyond the canvas counts as outside the shape.
            let hole = r.shift(&a, shadow_offset(angle, s.distance * k), true, 1.0)?;
            let grown = if choke > 0.0 {
                let sd = r.sdf(&hole, choke + 2.0)?;
                r.ramp(&sd, StyleRampParams::band(-4096.0, choke))?
            } else {
                hole
            };
            let soft = r.size_blur(&grown, size - choke, 1.0)?;
            let cov = r.contour(&soft, &s.contour, 0.0, 1.0, false)?;
            let plate = r.colorize(
                &cov,
                StyleColorizeParams::solid(rgb01(s.color), 0, s.noise / 100.0, e.seed),
            )?;
            r.blend(acc, &plate, s.blend, s.opacity / 100.0, None)
        }
        Fx::OuterGlow(g) => {
            let size = g.size * k;
            let spread = size * g.spread.clamp(0.0, 100.0) / 100.0;
            let falloff = match g.technique {
                GlowTechnique::Softer => {
                    let grown = if spread > 0.0 {
                        let sd = r.source_sd(src, spread + 2.0)?;
                        r.ramp(&sd, StyleRampParams::band(-4096.0, spread))?
                    } else {
                        a.clone()
                    };
                    r.size_blur(&grown, size - spread, 0.0)?
                }
                GlowTechnique::Precise => {
                    // Linear in the distance: (size + ½ − d) / (size + 1)
                    // from the spread out (measured on a size-10 square).
                    let sd = r.source_sd(src, size + 2.0)?;
                    r.ramp(&sd, StyleRampParams::falloff(spread - 0.5, size + 0.5))?
                }
            };
            glow(&mut r, acc, &falloff, g, e.seed, false)
        }
        Fx::InnerGlow(g) => {
            let size = g.size * k;
            let choke = size * g.spread.clamp(0.0, 100.0) / 100.0;
            let edge = match g.technique {
                GlowTechnique::Softer => {
                    let hole = r.invert(&a)?;
                    let grown = if choke > 0.0 {
                        let sd = r.sdf(&hole, choke + 2.0)?;
                        r.ramp(&sd, StyleRampParams::band(-4096.0, choke))?
                    } else {
                        hole
                    };
                    r.size_blur(&grown, size - choke, 1.0)?
                }
                GlowTechnique::Precise => {
                    // Distance inward from the edge, as the outer one.
                    let sd = r.source_sd(src, size + 2.0)?;
                    let inside =
                        r.ramp(&sd, StyleRampParams::falloff(-size - 0.5, -choke + 0.5))?;
                    r.invert(&inside)?
                }
            };
            glow(
                &mut r,
                acc,
                &edge,
                g,
                e.seed,
                g.source == GlowSource::Center,
            )
        }
        Fx::Satin(s) => {
            let size = s.size * k;
            let (dx, dy) = shadow_offset(s.angle, s.distance * k);
            let one = r.shift(&a, (dx, dy), false, 0.0)?;
            let two = r.shift(&a, (-dx, -dy), false, 0.0)?;
            let one = r.size_blur(&one, size, 0.0)?;
            let two = r.size_blur(&two, size, 0.0)?;
            let diff = r.run(
                &STYLE_ABSDIFF,
                &[&one, &two],
                StyleAbsDiffParams::new().as_bytes(),
            )?;
            let cov = r.contour(&diff, &s.contour, 0.0, 1.0, s.invert)?;
            let plate = r.colorize(
                &cov,
                StyleColorizeParams::solid(rgb01(s.color), 0, 0.0, e.seed),
            )?;
            r.blend(acc, &plate, s.blend, s.opacity / 100.0, None)
        }
        Fx::ColorOverlay(c) => {
            let plate = r.solid(c.color)?;
            r.blend(acc, &plate, c.blend, c.opacity / 100.0, None)
        }
        Fx::GradientOverlay(o) => {
            let area = if o.fill.align {
                e.bounds
            } else {
                Region::new(0, 0, cw, ch)
            };
            let plate = r.gradient_plate(&o.fill, area)?;
            r.blend(acc, &plate, o.blend, o.opacity / 100.0, None)
        }
        Fx::PatternOverlay(o) => {
            let Some(tile) = &e.pattern else {
                return Ok(acc.clone());
            };
            let origin = if o.fill.link {
                (e.bounds.x as f32, e.bounds.y as f32)
            } else {
                (0.0, 0.0)
            };
            let plate = r.pattern_plate(&o.fill, tile, origin)?;
            r.blend(acc, &plate, o.blend, o.opacity / 100.0, None)
        }
        Fx::Stroke(s, part) => {
            let reach = match part {
                StrokePart::Outer(d) | StrokePart::Inner(d) => d.max(0.0),
            };
            let sd = r.source_sd(src, reach + 2.0)?;
            let cov = match part {
                // The grown shape, beneath the layer — knocked out by the
                // part of the layer its fill leaves transparent, as a
                // drop shadow is.
                StrokePart::Outer(d) => {
                    let grown = r.ramp(&sd, StyleRampParams::band(-4096.0, *d))?;
                    if e.fill < 1.0 {
                        let lut: [f32; 256] =
                            std::array::from_fn(|i| 1.0 - i as f32 / 255.0 * (1.0 - e.fill));
                        let knock = r.run(
                            &STYLE_CONTOUR,
                            &[&a],
                            StyleContourParams::new(&lut, 0.0, 1.0, false, 0).as_bytes(),
                        )?;
                        r.run(
                            &MATH_MUL,
                            &[&grown, &knock],
                            MathMulParams::new().as_bytes(),
                        )?
                    } else {
                        grown
                    }
                }
                // Inside the layer: the band over the layer's alpha, so
                // that once the body's shape applies the band is what
                // shows (and the layer under it is gone).
                StrokePart::Inner(d) => {
                    let band = r.ramp(&sd, StyleRampParams::band(-*d, 0.0))?;
                    let floor = r.run(
                        &MATH_MAX_CONST,
                        &[&a],
                        MathMaxConstParams::new(1.0 / 512.0).as_bytes(),
                    )?;
                    let ratio =
                        r.run(&MATH_DIV, &[&band, &floor], MathDivParams::new().as_bytes())?;
                    r.run(
                        &MATH_CLAMP,
                        &[&ratio],
                        MathClampParams::new(0.0, 1.0).as_bytes(),
                    )?
                }
            };
            let plate = match &s.fill {
                StrokeFill::Color { rgb } => r.solid(*rgb)?,
                StrokeFill::Gradient(g) => {
                    let area = if g.align {
                        e.bounds
                    } else {
                        Region::new(0, 0, cw, ch)
                    };
                    r.gradient_plate(g, area)?
                }
                StrokeFill::Pattern(p) => match &e.pattern {
                    Some(tile) => {
                        let origin = if p.link {
                            (e.bounds.x as f32, e.bounds.y as f32)
                        } else {
                            (0.0, 0.0)
                        };
                        r.pattern_plate(p, tile, origin)?
                    }
                    None => return Ok(acc.clone()),
                },
            };
            r.blend(acc, &plate, s.blend, s.opacity / 100.0, Some(&cov))
        }
        Fx::Bevel(b) => bevel(&mut r, acc, src, b, e, k),
    }
}

/// A glow's falloff through its range and contour, coloured (one colour,
/// or the gradient across the falloff, its start at the edge) and blended.
fn glow(
    r: &mut Rec<'_, '_>,
    acc: &Resident,
    falloff: &Resident,
    g: &Glow,
    seed: u32,
    center: bool,
) -> Result<Resident, IngestError> {
    // RANGE: the contour spans the falloff from 0 to `range` — at the
    // default 50 % a softer glow is twice its blurred shape (measured:
    // Photoshop's size-10 glow of a square is exactly that, clamped).
    // A precise glow's linear falloff is drawn as is at 50 %.
    let range = (g.range / 100.0).clamp(0.01, 1.0);
    let hi = match g.technique {
        GlowTechnique::Softer => range,
        GlowTechnique::Precise => (2.0 * range).min(1.0),
    };
    // An inner glow from the CENTRE is the edge glow's complement, taken
    // after the range (measured: 1 − 2·blur at 50 %).
    let cov = if center {
        let c = r.run(
            &STYLE_CONTOUR,
            &[falloff],
            StyleContourParams::new(&Contour::linear().lut(), 0.0, hi, true, 0).as_bytes(),
        )?;
        r.contour(&c, &g.contour, 0.0, 1.0, false)?
    } else {
        r.contour(falloff, &g.contour, 0.0, hi, false)?
    };
    let (lut, mode) = match &g.fill {
        GlowFill::Color { rgb } => {
            let c = rgb01(*rgb);
            ([[c[0], c[1], c[2], 1.0]; 256], COLORIZE_COVERAGE)
        }
        // The gradient's start at the edge.
        GlowFill::Gradient { gradient } => (gradient.lut(false), COLORIZE_GLOW_GRADIENT),
    };
    let plate = r.colorize(
        &cov,
        StyleColorizeParams::new(lut, mode, 0, g.noise / 100.0, g.jitter / 100.0, seed),
    )?;
    r.blend(acc, &plate, g.blend, g.opacity / 100.0, None)
}

fn bevel(
    r: &mut Rec<'_, '_>,
    acc: &Resident,
    src: &mut Source,
    b: &Bevel,
    e: &EffectStep,
    k: f32,
) -> Result<Resident, IngestError> {
    let size = (b.size * k).max(0.5);
    let reach = if b.style == BevelStyle::StrokeEmboss {
        e.stroke_reach
    } else {
        0.0
    };
    let sd = r.source_sd(src, size * 2.0 + reach + 2.0)?;
    // A STROKE EMBOSS bevels the stroke: its shape is the layer grown by
    // the stroke's reach, bevelled inward like an inner bevel.
    let a = if reach > 0.0 {
        r.ramp(&sd, StyleRampParams::band(-4096.0, reach))?
    } else {
        src.alpha.clone()
    };
    let sd = if reach > 0.0 {
        r.sdf(&a, size * 2.0 + 2.0)?
    } else {
        sd
    };
    // The HEIGHT field (0 low, 1 high) and the REGION it shows in. Every
    // style is steepest at the layer's edge: Photoshop's shading falls
    // off linearly from the edge across the band (measured on its size-8
    // and size-10 bevels). SMOOTH is the layer's alpha blurred by the
    // effect's size (`size_blur`, a tent) and remapped — a tent-blurred
    // step IS that quadratic profile, and its corners come out rounded, as
    // Photoshop's do; a CHISEL is linear in the distance, its corners
    // mitred, as Photoshop's are.
    let smooth = b.technique == BevelTechnique::Smooth;
    let band = match b.style {
        BevelStyle::InnerBevel | BevelStyle::OuterBevel | BevelStyle::StrokeEmboss => size,
        _ => size / 2.0,
    };
    // A smooth inner or outer bevel is half the blurred step: its slope
    // counts twice (the blur is not clamped at the edge, so a corner, where
    // the blurred alpha stays below one half, still slopes — Photoshop's
    // corners shade so).
    let slope = if smooth
        && matches!(
            b.style,
            BevelStyle::InnerBevel
                | BevelStyle::OuterBevel
                | BevelStyle::PillowEmboss
                | BevelStyle::StrokeEmboss
        ) {
        2.0
    } else {
        1.0
    };
    let height = if smooth {
        let f = r.size_blur(&a, band, 0.0)?;
        match b.style {
            // Up inside, down outside: `f` inside the shape, `1 − f`
            // outside it — a trough along the edge, unclamped at corners.
            BevelStyle::PillowEmboss => {
                let inv = r.invert(&f)?;
                let out = r.batch.target(r.w, r.h);
                r.batch
                    .dispatch(
                        &BAND_TAKE,
                        &[&inv, &f],
                        BandTakeParams::new().as_bytes(),
                        Some(&a),
                        &out,
                    )
                    .map_err(gpu_err)?;
                out
            }
            _ => f,
        }
    } else {
        match b.style {
            BevelStyle::InnerBevel => r.ramp(&sd, StyleRampParams::falloff(-size, 0.0))?,
            BevelStyle::OuterBevel => r.ramp(&sd, StyleRampParams::falloff(0.0, size))?,
            BevelStyle::Emboss => r.ramp(&sd, StyleRampParams::falloff(-band, band))?,
            BevelStyle::StrokeEmboss => r.ramp(&sd, StyleRampParams::falloff(-size, 0.0))?,
            BevelStyle::PillowEmboss => {
                let inner = r.ramp(&sd, StyleRampParams::falloff(-band, 0.0))?;
                let outer = r.ramp(&sd, StyleRampParams::falloff(0.0, band))?;
                let outer = r.invert(&outer)?;
                r.max(&inner, &outer)?
            }
        }
    };
    let region = match b.style {
        BevelStyle::InnerBevel | BevelStyle::StrokeEmboss => Some(a.clone()),
        BevelStyle::OuterBevel => Some(r.invert(&a)?),
        _ => None,
    };
    let height = if b.technique == BevelTechnique::ChiselSoft {
        r.blur(&height, 1.0, -1.0)?
    } else {
        height
    };
    // CONTOUR (the sub-pane) reshapes the profile across the band: the
    // part of the height the RANGE selects (at 50 % the inner bevel's
    // inner half of a smooth profile — the band itself) runs through it.
    let (height, slope) = match &b.contour {
        Some(c) if c.enabled => {
            let range = (c.range / 100.0).clamp(0.01, 1.0);
            let (lo, hi) = match (smooth, b.style) {
                (true, BevelStyle::InnerBevel) => (1.0 - range, 1.0),
                (true, BevelStyle::OuterBevel) => (0.0, range),
                _ => (0.0, 1.0),
            };
            (r.contour(&height, &c.contour, lo, hi, false)?, 1.0)
        }
        _ => (height, slope),
    };
    let height = if b.down { r.invert(&height)? } else { height };
    let (angle, altitude) = if b.use_global_light {
        (e.light.angle, e.light.altitude)
    } else {
        (b.angle, b.altitude)
    };
    // DEPTH: at 100 % a chisel's face rises 0.45 px per px (measured from
    // the shading of Photoshop's size-10 chisel bevel, all four faces).
    let depth = 0.45 * b.depth / 100.0 * size * slope;
    let shade = r.run(
        &STYLE_BEVEL,
        &[&height],
        StyleBevelParams::new(depth, angle, altitude).as_bytes(),
    )?;
    let shade = r.contour(&shade, &b.gloss, 0.0, 1.0, false)?;
    let shade = r.blur(&shade, b.soften * k * 0.5, -1.0)?;
    // The flat surface's shade is the light's own (the gloss contour bends
    // the shading, not the reference it splits at: Photoshop's cone gloss
    // turns a flat top into highlight).
    let flat = altitude.to_radians().sin().clamp(0.0, 1.0);
    let split = r.run(
        &STYLE_SPLIT,
        &[&shade],
        StyleSplitParams::new(flat).as_bytes(),
    )?;
    let mut out = acc.clone();
    for (channel, light) in [(0u32, &b.highlight), (1, &b.shadow)] {
        let c = rgb01(light.color);
        let p = StyleColorizeParams::solid(c, channel, 0.0, 0);
        let plate = r.colorize(&split, p)?;
        out = r.blend(
            &out,
            &plate,
            light.blend,
            light.opacity / 100.0,
            region.as_ref(),
        )?;
    }
    Ok(out)
}

/// The source alpha of a layer: its premultiplied plate's alpha, through
/// `mask` when the mask shapes the effects.
pub(super) fn source_alpha(
    ctx: &GpuContext,
    batch: &mut GpuBatch<'_>,
    plate: &Resident,
    mask: Option<&Resident>,
    w: u32,
    h: u32,
) -> Result<Resident, IngestError> {
    let a = batch.target(w, h);
    batch
        .dispatch(
            &BAND_BROADCAST_ALPHA,
            &[plate],
            BandBroadcastAlphaParams::new().as_bytes(),
            None,
            &a,
        )
        .map_err(gpu_err)?;
    let Some(m) = mask else {
        return Ok(a);
    };
    let zeros = ctx.zeros(w, h);
    let out = batch.target(w, h);
    batch
        .dispatch(
            &BAND_TAKE,
            &[&zeros, &a],
            BandTakeParams::new().as_bytes(),
            Some(m),
            &out,
        )
        .map_err(gpu_err)?;
    Ok(out)
}

impl super::LayerStack {
    /// The tile an effect's pattern refers to, from the document's
    /// pattern table (by id, else by name).
    pub(super) fn style_pattern(&self, fx: &Fx) -> Option<PatternTile> {
        let want = fx.pattern()?;
        self.styles
            .patterns
            .iter()
            .find(|p| !want.pattern.id.is_empty() && p.name == want.pattern.id)
            .or_else(|| {
                self.styles
                    .patterns
                    .iter()
                    .find(|p| p.name == want.pattern.name)
            })
            .cloned()
    }
}

impl super::LayerStack {
    /// The document's Global Light and style patterns.
    pub fn style_doc(&self) -> &super::StyleDoc {
        &self.styles
    }
}

fn refuse(why: &str) -> IngestError {
    IngestError::Unsupported(why.to_string())
}

/// THE STYLE VERBS (Layer ▸ Layer Style). Each is one edit; the caller
/// records it (`LayerStack::recorded`), so each is one undo step.
impl super::LayerStack {
    /// Set (or, with `None`, clear) a pixel layer's style. A style coming
    /// in without the descriptors it was read from (the dialog's edit)
    /// keeps the old one's, so a save keeps the keys the model does not
    /// carry.
    pub fn set_style(
        &mut self,
        index: usize,
        style: Option<LayerStyle>,
    ) -> Result<(), IngestError> {
        let layer = self.layer_mut(index)?;
        layer.appearance_editable()?;
        if style.is_some() && !layer.is_pixels() {
            return Err(refuse(
                "a layer style needs a layer with pixels (an adjustment layer has none)",
            ));
        }
        layer.ext.style = style.map(|mut s| {
            if let Some(old) = &layer.ext.style {
                s.adopt_sources(old);
            }
            Arc::new(s)
        });
        Ok(())
    }

    /// The same style on several layers at once (Paste Layer Style).
    pub fn paste_style(
        &mut self,
        indices: &[usize],
        style: &LayerStyle,
    ) -> Result<(), IngestError> {
        for &i in indices {
            self.set_style(i, Some(style.clone()))?;
        }
        Ok(())
    }

    /// Blending Options ▸ Advanced Blending's style switches.
    pub fn set_style_options(
        &mut self,
        index: usize,
        o: super::StyleOptions,
    ) -> Result<(), IngestError> {
        let layer = self.layer_mut(index)?;
        layer.appearance_editable()?;
        layer.ext.style_options = o;
        Ok(())
    }

    /// Layer ▸ Layer Style ▸ Global Light: the angle and altitude every
    /// effect with Use Global Light shares.
    pub fn set_global_light(&mut self, light: GlobalLight) -> Result<(), IngestError> {
        if !(light.angle.is_finite() && light.altitude.is_finite()) {
            return Err(refuse("a global light needs a finite angle and altitude"));
        }
        self.styles.global_light = GlobalLight {
            angle: ((light.angle + 180.0).rem_euclid(360.0)) - 180.0,
            altitude: light.altitude.clamp(0.0, 90.0),
        };
        Ok(())
    }

    /// Layer ▸ Layer Style ▸ Scale Effects: every size and distance of the
    /// layer's style by `percent`.
    pub fn scale_effects(&mut self, index: usize, percent: f32) -> Result<(), IngestError> {
        let layer = self.layer_mut(index)?;
        layer.appearance_editable()?;
        let Some(style) = &layer.ext.style else {
            return Err(refuse("the layer has no style to scale"));
        };
        let mut s = (**style).clone();
        s.scale = percent.clamp(1.0, 1000.0);
        layer.ext.style = Some(Arc::new(s));
        Ok(())
    }

    /// Layer ▸ Layer Style ▸ Hide All Effects / Show All Effects: the
    /// style's master switch.
    pub fn set_effects_visible(&mut self, index: usize, on: bool) -> Result<(), IngestError> {
        let layer = self.layer_mut(index)?;
        layer.appearance_editable()?;
        let Some(style) = &layer.ext.style else {
            return Err(refuse("the layer has no style"));
        };
        let mut s = (**style).clone();
        s.enabled = on;
        layer.ext.style = Some(Arc::new(s));
        Ok(())
    }

    /// Add (or replace, by name) a pattern the styles can draw.
    pub fn define_style_pattern(&mut self, p: PatternFill) -> Result<(), IngestError> {
        if p.width == 0 || p.height == 0 || p.tile.len() != p.width as usize * p.height as usize * 4
        {
            return Err(refuse("a style pattern needs a non-empty, RGBA8 tile"));
        }
        let p = Arc::new(p);
        match self.styles.patterns.iter_mut().find(|q| q.name == p.name) {
            Some(slot) => *slot = p,
            None => self.styles.patterns.push(p),
        }
        Ok(())
    }
}

/// A style from the dialog's JSON (`paged-psd`'s model, serde form);
/// `null` or empty is no style.
pub fn style_from_json(json: &str) -> Result<Option<LayerStyle>, IngestError> {
    let t = json.trim();
    if t.is_empty() || t == "null" {
        return Ok(None);
    }
    serde_json::from_str(t)
        .map(Some)
        .map_err(|e| IngestError::Decode(format!("layer style: {e}")))
}

/// The style as the dialog's JSON (`null` for none).
pub fn style_to_json(style: Option<&LayerStyle>) -> String {
    match style {
        None => "null".into(),
        Some(s) => serde_json::to_string(s).unwrap_or_else(|_| "null".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layers::{LayerStack, StyleOptions};
    use image_psd::effects::{ColorFill, Shadow, Stroke};

    fn device() -> Option<&'static GpuContext> {
        image_gpu::test_support::device_or_skip("layer styles")
    }

    const W: u32 = 32;
    const H: u32 = 32;

    /// White background, a red square (8..24) on a layer above.
    fn square() -> LayerStack {
        let white: Vec<u8> = (0..W * H).flat_map(|_| [255u8, 255, 255, 255]).collect();
        let mut s =
            LayerStack::from_image(W, H, Arc::from(white.into_boxed_slice())).expect("stack");
        let px: Vec<u8> = (0..W * H)
            .flat_map(|i| {
                let (x, y) = (i % W, i / W);
                if (8..24).contains(&x) && (8..24).contains(&y) {
                    [200u8, 0, 0, 255]
                } else {
                    [0, 0, 0, 0]
                }
            })
            .collect();
        s.add("square");
        s.edit_active(
            "p",
            Region::new(0, 0, W, H),
            crate::pixels::Pixels::from_rgba8(Arc::from(px.into_boxed_slice())),
        )
        .expect("paint");
        s
    }

    fn fold(s: &LayerStack, ctx: &GpuContext) -> Arc<[u8]> {
        pollster::block_on(s.composite(Some(ctx), None)).expect("composite")
    }

    fn at(px: &[u8], x: u32, y: u32) -> [u8; 4] {
        let i = ((y * W + x) * 4) as usize;
        [px[i], px[i + 1], px[i + 2], px[i + 3]]
    }

    fn shadow() -> LayerStyle {
        LayerStyle {
            drop_shadows: vec![Shadow {
                blend: BlendMode::Normal,
                opacity: 100.0,
                use_global_light: false,
                angle: -90.0,
                distance: 4.0,
                size: 0.0,
                ..Shadow::drop_default()
            }],
            ..LayerStyle::default()
        }
    }

    #[test]
    #[allow(non_snake_case)]
    fn a_drop_shadow_falls_opposite_the_light_and_is_one_undo_step__feat__image_layers_styles() {
        let Some(ctx) = device() else { return };
        let mut s = square();
        let top = s.len() - 1;
        let before = fold(&s, ctx);
        s.recorded("Layer Style", None, |s| s.set_style(top, Some(shadow())))
            .expect("style");
        let out = fold(&s, ctx);
        // Light from below (−90°): the shadow falls 4 px up, above the square.
        assert_eq!(at(&out, 16, 5), [0, 0, 0, 255]);
        assert_eq!(at(&out, 16, 26), [255, 255, 255, 255], "nothing below");
        assert_eq!(
            at(&out, 16, 16),
            [200, 0, 0, 255],
            "the layer covers its shadow"
        );
        s.undo().expect("undo");
        assert_eq!(fold(&s, ctx)[..], before[..]);
    }

    #[test]
    #[allow(non_snake_case)]
    fn layer_opacity_fades_the_layer_and_its_effects_as_one__feat__image_layers_styles() {
        let Some(ctx) = device() else { return };
        let mut s = square();
        let top = s.len() - 1;
        s.set_style(top, Some(shadow())).expect("style");
        s.layer_mut(top).expect("layer").opacity = 0.5;
        let out = fold(&s, ctx);
        let near = |a: [u8; 4], b: [u8; 4]| a.iter().zip(b).all(|(x, y)| x.abs_diff(y) <= 1);
        // The shadow under the square does not show through it.
        assert!(
            near(at(&out, 16, 16), [228, 128, 128, 255]),
            "{:?}",
            at(&out, 16, 16)
        );
        assert!(
            near(at(&out, 16, 5), [128, 128, 128, 255]),
            "{:?}",
            at(&out, 16, 5)
        );
    }

    #[test]
    #[allow(non_snake_case)]
    fn an_overlay_and_a_stroke_draw_and_fill_opacity_spares_them__feat__image_layers_styles() {
        let Some(ctx) = device() else { return };
        let mut s = square();
        let top = s.len() - 1;
        let style = LayerStyle {
            color_overlays: vec![ColorFill {
                color: [0, 0, 255],
                ..ColorFill::default()
            }],
            strokes: vec![Stroke {
                size: 2.0,
                fill: StrokeFill::Color { rgb: [0, 255, 0] },
                ..Stroke::default()
            }],
            ..LayerStyle::default()
        };
        s.set_style(top, Some(style)).expect("style");
        s.set_fill_opacity(top, 0.0).expect("fill");
        let out = fold(&s, ctx);
        assert_eq!(
            at(&out, 16, 16),
            [0, 0, 255, 255],
            "the overlay ignores fill"
        );
        assert_eq!(
            at(&out, 6, 16),
            [0, 255, 0, 255],
            "the stroke outside the edge"
        );
        assert_eq!(at(&out, 3, 16), [255, 255, 255, 255]);
    }

    #[test]
    #[allow(non_snake_case)]
    fn styles_survive_persistence_and_json__feat__image_layers_styles() {
        let mut s = square();
        let top = s.len() - 1;
        s.set_style(top, Some(shadow())).expect("style");
        s.set_style_options(
            top,
            StyleOptions {
                blend_interior: true,
                ..StyleOptions::default()
            },
        )
        .expect("options");
        s.set_global_light(GlobalLight {
            angle: 45.0,
            altitude: 60.0,
        })
        .expect("light");
        let (manifest, buffers) = s.export();
        let back = LayerStack::import(&manifest, &buffers).expect("import");
        let l = &back.layers()[top];
        assert_eq!(
            l.ext.style.as_deref().map(|s| s.drop_shadows.len()),
            Some(1)
        );
        assert!(l.ext.style_options.blend_interior);
        assert_eq!(back.style_doc().global_light.angle, 45.0);
        let json = style_to_json(l.ext.style.as_deref());
        let again = style_from_json(&json).expect("json").expect("a style");
        assert_eq!(again.drop_shadows[0].distance, 4.0);
        assert!(style_from_json("null").expect("null").is_none());
        assert!(style_from_json("{\"dropShadows\": 3}").is_err());
    }

    #[test]
    #[allow(non_snake_case)]
    fn each_style_verb_is_one_undo_step__feat__image_layers_styles() {
        let mut s = square();
        let top = s.len() - 1;
        let depth = |s: &LayerStack| s.history().depth;
        let d0 = depth(&s);
        s.recorded("Layer Style", None, |s| s.set_style(top, Some(shadow())))
            .unwrap();
        s.recorded("Scale Effects", None, |s| s.scale_effects(top, 50.0))
            .unwrap();
        s.recorded("Hide All Effects", None, |s| {
            s.set_effects_visible(top, false)
        })
        .unwrap();
        s.recorded("Global Light", None, |s| {
            s.set_global_light(GlobalLight {
                angle: 10.0,
                altitude: 20.0,
            })
        })
        .unwrap();
        s.recorded("Paste Layer Style", None, |s| {
            s.paste_style(&[top], &shadow())
        })
        .unwrap();
        assert_eq!(depth(&s), d0 + 5);
        for _ in 0..5 {
            s.undo().unwrap();
        }
        assert!(s.layers()[top].ext.style.is_none());
        // An adjustment layer takes no style.
        assert!(
            s.set_style(0, Some(shadow())).is_ok(),
            "the background is pixels"
        );
    }
}

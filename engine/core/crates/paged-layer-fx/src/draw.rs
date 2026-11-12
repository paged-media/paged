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

//! The evaluator: each effect of a layer style drawn onto an accumulator
//! as a sequence of kernel dispatches on a [`FxDevice`].
//!
//! # Coverage
//!
//! Sizes and distances are device pixels. A spread (choke) of `p` %
//! turns `p` % of the size into a hard dilation (erosion) through the
//! signed distance field (`style.distance`) and blurs the rest; a precise
//! glow and the chisel bevels fall off with the distance itself. The
//! blur, the contour, noise and the light all follow the conventions
//! recorded against Photoshop in paged.image's
//! `image-conformance/tests/it/psd_layer_styles.rs`.

use paged_blend::BlendMode;
use paged_kernels::def::KernelDef;
use paged_kernels::families::arithmetic::{MathDivParams, MathMulParams, MATH_DIV, MATH_MUL};
use paged_kernels::families::band::{
    BandBroadcastAlphaParams, BandTakeParams, BAND_BROADCAST_ALPHA, BAND_TAKE,
};
use paged_kernels::families::compose::{self, ComposeParams, COMPOSE_NORMAL};
use paged_kernels::families::gen::{
    GenAngularGradientParams, GenDiamondGradientParams, GenLinearGradientParams, GenPatternParams,
    GenRadialGradientParams, GenReflectedGradientParams, GenSolidParams, GEN_ANGULAR_GRADIENT,
    GEN_DIAMOND_GRADIENT, GEN_LINEAR_GRADIENT, GEN_PATTERN, GEN_RADIAL_GRADIENT,
    GEN_REFLECTED_GRADIENT, GEN_SOLID,
};
use paged_kernels::families::minmax::{
    MathClampParams, MathMaxConstParams, MathMaxParams, MATH_CLAMP, MATH_MAX, MATH_MAX_CONST,
};
use paged_kernels::families::style::*;
use paged_model::layer_style::{FxContour, FxGradientFill, FxGradientShape, FxPatternFill};

use crate::lut::{contour_lut, ramp_lut};
use crate::plan::{
    Bevel, BevelStyle, BevelTechnique, EffectStep, Fx, Glow, GlowFill, GlowTechnique, PatternTile,
    Rect, StrokeFill, StrokePart,
};

/// Where a device's textures lie on the canvas: their size `w × h`, their
/// origin `(ox, oy)` on a `cw × ch` canvas. A tile of a tiled fold draws
/// its gradients, patterns and noise in canvas coordinates, so a tile
/// shows what the whole canvas shows there.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Frame {
    pub w: u32,
    pub h: u32,
    pub ox: i32,
    pub oy: i32,
    pub cw: u32,
    pub ch: u32,
}

impl Frame {
    /// The whole canvas: origin 0, the canvas's size.
    pub fn whole(w: u32, h: u32) -> Frame {
        Frame {
            w,
            h,
            ox: 0,
            oy: 0,
            cw: w,
            ch: h,
        }
    }
}

/// What runs the kernels: paged.image's GPU batch, or [`crate::cpu`]'s
/// scalar twins. Every texture is `frame().w × frame().h`, premultiplied
/// RGBA (or a coverage in every channel), stored as rgba16float.
/// A texture of a device: a handle the device resolves.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Tex(pub u32);

/// Why a device could not run a kernel.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FxError(pub String);

impl std::fmt::Display for FxError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

pub trait FxDevice {
    /// The textures' frame.
    fn frame(&self) -> Frame;

    /// Dispatch `def` over `inputs` with `params`, through `mask` (`.r`)
    /// when given: `mix(in0, result, mask)`.
    fn run(
        &mut self,
        def: &'static KernelDef,
        inputs: &[&Tex],
        params: &[u8],
        mask: Option<&Tex>,
    ) -> Result<Tex, FxError>;

    /// A texture of zeros.
    fn zeros(&mut self) -> Tex;

    /// A `w × h` rgba16float texture of these little-endian f16 texels.
    fn upload(&mut self, w: u32, h: u32, f16_rgba: &[u8]) -> Tex;
}

/// A device's own textures behind the handles: what lets the one
/// evaluator (compiled once, over `dyn FxDevice`) run on any device.
pub trait Textures {
    type Native: Clone;
    /// Hand a native texture to the device; its handle.
    fn put(&mut self, t: Self::Native) -> Tex;
    /// The native texture of a handle.
    fn get(&self, t: Tex) -> &Self::Native;
}

fn put_source<D: FxDevice + Textures>(dev: &mut D, src: &Source<D::Native>) -> Source<Tex> {
    Source {
        alpha: dev.put(src.alpha.clone()),
        sd: src.sd.as_ref().map(|(r, t)| (*r, dev.put(t.clone()))),
    }
}

fn take_source<D: FxDevice + Textures>(dev: &D, s: Source<Tex>, src: &mut Source<D::Native>) {
    src.sd = s.sd.map(|(r, t)| (r, dev.get(t).clone()));
}

/// [`draw`] over a device's own textures.
pub fn draw_native<D: FxDevice + Textures>(
    dev: &mut D,
    acc: &D::Native,
    src: &mut Source<D::Native>,
    e: &EffectStep,
) -> Result<D::Native, FxError> {
    let mut s = put_source(dev, src);
    let acc = dev.put(acc.clone());
    let out = draw(dev, &acc, &mut s, e)?;
    take_source(dev, s, src);
    Ok(dev.get(out).clone())
}

/// [`paints`] over a device's own textures.
pub fn paints_native<D: FxDevice + Textures>(
    dev: &mut D,
    src: &mut Source<D::Native>,
    e: &EffectStep,
) -> Result<Vec<FxPaint<D::Native>>, FxError> {
    let mut s = put_source(dev, src);
    let ps = paints(dev, &mut s, e)?;
    take_source(dev, s, src);
    Ok(ps
        .into_iter()
        .map(|p| FxPaint {
            plate: dev.get(p.plate).clone(),
            blend: p.blend,
            opacity: p.opacity,
            mask: p.mask.map(|m| dev.get(m).clone()),
        })
        .collect())
}

/// [`source_alpha`] over a device's own textures.
pub fn source_alpha_native<D: FxDevice + Textures>(
    dev: &mut D,
    plate: &D::Native,
    mask: Option<&D::Native>,
) -> Result<D::Native, FxError> {
    let plate = dev.put(plate.clone());
    let mask = mask.map(|m| dev.put(m.clone()));
    let out = source_alpha(dev, &plate, mask.as_ref())?;
    Ok(dev.get(out).clone())
}

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

/// The `compose.*` kernel of a blend mode (Normal for one without).
pub fn blend_def(b: BlendMode) -> &'static KernelDef {
    let id = b.id();
    compose::FAMILY
        .iter()
        .copied()
        .find(|k| k.id.strip_prefix("compose.") == Some(id))
        .unwrap_or(&COMPOSE_NORMAL)
}

/// The bounding box of the texels with any alpha in an RGBA8 plate
/// (the whole plate when it is empty).
pub fn alpha_bounds(px: &[u8], w: u32, h: u32) -> Rect {
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
        return Rect::new(0, 0, w, h);
    }
    Rect::new(x0 as i32, y0 as i32, x1 - x0 + 1, y1 - y0 + 1)
}

/// The textures one styled layer's effects share: its source alpha, and
/// the signed distance field once one effect asked.
pub struct Source<T> {
    pub alpha: T,
    pub sd: Option<(f32, T)>,
}

impl<T> Source<T> {
    pub fn new(alpha: T) -> Source<T> {
        Source { alpha, sd: None }
    }
}

/// The source alpha of a layer: its premultiplied plate's alpha, through
/// `mask` when the mask shapes the effects.
pub fn source_alpha(
    dev: &mut dyn FxDevice,
    plate: &Tex,
    mask: Option<&Tex>,
) -> Result<Tex, FxError> {
    let a = dev.run(
        &BAND_BROADCAST_ALPHA,
        &[plate],
        BandBroadcastAlphaParams::new().as_bytes(),
        None,
    )?;
    let Some(m) = mask else {
        return Ok(a);
    };
    let zeros = dev.zeros();
    dev.run(
        &BAND_TAKE,
        &[&zeros, &a],
        BandTakeParams::new().as_bytes(),
        Some(m),
    )
}

struct Rec<'d> {
    dev: &'d mut dyn FxDevice,
    frame: Frame,
}

impl Rec<'_> {
    fn run(
        &mut self,
        def: &'static KernelDef,
        inputs: &[&Tex],
        params: &[u8],
    ) -> Result<Tex, FxError> {
        self.dev.run(def, inputs, params, None)
    }

    fn invert(&mut self, x: &Tex) -> Result<Tex, FxError> {
        self.run(
            &STYLE_CONTOUR,
            &[x],
            StyleContourParams::identity(true, 0).as_bytes(),
        )
    }

    fn max(&mut self, a: &Tex, b: &Tex) -> Result<Tex, FxError> {
        self.run(&MATH_MAX, &[a, b], MathMaxParams::new().as_bytes())
    }

    fn shift(
        &mut self,
        x: &Tex,
        d: (f32, f32),
        invert: bool,
        outside: f32,
    ) -> Result<Tex, FxError> {
        if d.0 == 0.0 && d.1 == 0.0 && !invert {
            return Ok(*x);
        }
        self.run(
            &STYLE_SHIFT,
            &[x],
            StyleShiftParams::new(d.0, d.1, 0, invert, outside).as_bytes(),
        )
    }

    fn blur(&mut self, x: &Tex, sigma: f32, outside: f32) -> Result<Tex, FxError> {
        if sigma <= 0.05 {
            return Ok(*x);
        }
        let p = StyleBlurParams::new(sigma, (sigma * 3.0).ceil() as u32, outside);
        let h = self.run(&STYLE_BLUR_H, &[x], p.as_bytes())?;
        self.run(&STYLE_BLUR_V, &[&h], p.as_bytes())
    }

    /// An effect's SIZE as a blur ([`size_box_radius`]).
    fn size_blur(&mut self, x: &Tex, size: f32, outside: f32) -> Result<Tex, FxError> {
        let r = size_box_radius(size);
        if r <= 0.01 {
            return Ok(*x);
        }
        let p = StyleBlurParams::boxed(r, outside);
        let mut cur = *x;
        for _ in 0..2 {
            let h = self.run(&STYLE_BLUR_H, &[&cur], p.as_bytes())?;
            cur = self.run(&STYLE_BLUR_V, &[&h], p.as_bytes())?;
        }
        Ok(cur)
    }

    /// The signed distance field of coverage `cov` (`.r`), accurate to
    /// `reach` px from the edge (farther it may read as "far").
    fn sdf(&mut self, cov: &Tex, reach: f32) -> Result<Tex, FxError> {
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

    fn source_sd(&mut self, src: &mut Source<Tex>, reach: f32) -> Result<Tex, FxError> {
        if let Some((r, sd)) = &src.sd {
            if *r >= reach {
                return Ok(*sd);
            }
        }
        let sd = self.sdf(&src.alpha.clone(), reach)?;
        src.sd = Some((reach, sd));
        Ok(sd)
    }

    fn ramp(&mut self, sd: &Tex, p: StyleRampParams) -> Result<Tex, FxError> {
        self.run(&STYLE_RAMP, &[sd], p.as_bytes())
    }

    fn contour(
        &mut self,
        x: &Tex,
        c: &FxContour,
        lo: f32,
        hi: f32,
        invert: bool,
    ) -> Result<Tex, FxError> {
        if c.is_linear() && lo == 0.0 && hi == 1.0 && !invert {
            return Ok(*x);
        }
        self.run(
            &STYLE_CONTOUR,
            &[x],
            StyleContourParams::new(&contour_lut(c), lo, hi, invert, 0).as_bytes(),
        )
    }

    /// A coverage → the effect's premultiplied colour plate.
    fn colorize(&mut self, cov: &Tex, p: StyleColorizeParams) -> Result<Tex, FxError> {
        let p = p.at(self.frame.ox, self.frame.oy);
        self.run(&STYLE_COLORIZE, &[cov], p.as_bytes())
    }

    /// An opaque plate of one colour.
    fn solid(&mut self, rgb: [u8; 3]) -> Result<Tex, FxError> {
        let c = rgb01(rgb);
        let zeros = self.dev.zeros();
        self.run(
            &GEN_SOLID,
            &[&zeros],
            GenSolidParams::new(0, 0, c[0], c[1], c[2], 1.0).as_bytes(),
        )
    }

    /// The `t` ramp (black → white) of a gradient fill over `area`.
    fn gradient_t(&mut self, g: &FxGradientFill, area: Rect) -> Result<Tex, FxError> {
        let zeros = self.dev.zeros();
        let (ox, oy) = (self.frame.ox, self.frame.oy);
        let (black, white) = ([0.0, 0.0, 0.0, 1.0], [1.0, 1.0, 1.0, 1.0]);
        let (rw, rh) = (area.w as f32, area.h as f32);
        let c = (
            area.x as f32 + rw / 2.0 + g.offset_pct[0] / 100.0 * rw,
            area.y as f32 + rh / 2.0 + g.offset_pct[1] / 100.0 * rh,
        );
        let t = g.angle_deg.to_radians();
        let d = (t.cos(), -t.sin());
        let scale = (g.scale_pct / 100.0).max(0.01);
        let half = ((rw / 2.0 * d.0.abs() + rh / 2.0 * d.1.abs()) * scale).max(0.5);
        let angle = d.1.atan2(d.0);
        match g.shape {
            FxGradientShape::Linear => self.run(
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
            FxGradientShape::Radial => self.run(
                &GEN_RADIAL_GRADIENT,
                &[&zeros],
                GenRadialGradientParams::new(ox, oy, c.0, c.1, half, black, white).as_bytes(),
            ),
            FxGradientShape::Angle => self.run(
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
            FxGradientShape::Reflected => self.run(
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
            FxGradientShape::Diamond => self.run(
                &GEN_DIAMOND_GRADIENT,
                &[&zeros],
                GenDiamondGradientParams::new(ox, oy, c.0, c.1, angle, half, black, white)
                    .as_bytes(),
            ),
        }
    }

    /// A gradient fill's premultiplied plate.
    fn gradient_plate(&mut self, g: &FxGradientFill, area: Rect) -> Result<Tex, FxError> {
        let t = self.gradient_t(g, area)?;
        self.colorize(
            &t,
            StyleColorizeParams::new(
                ramp_lut(&g.ramp, g.reverse),
                COLORIZE_LOOKUP,
                0,
                0.0,
                0.0,
                0,
            ),
        )
    }

    /// A pattern's premultiplied plate over the canvas.
    fn pattern_plate(
        &mut self,
        fill: &FxPatternFill,
        tile: &PatternTile,
        origin: (f32, f32),
    ) -> Result<Tex, FxError> {
        // The tile's extent as the canvas cuts it, uploaded at that size
        // (the kernel reads `in1` only inside it).
        let (tw, th) = (
            tile.width.min(self.frame.cw).max(1),
            tile.height.min(self.frame.ch).max(1),
        );
        let mut bytes = vec![0u8; tw as usize * th as usize * 8];
        for y in 0..th.min(tile.height) as usize {
            for x in 0..tw.min(tile.width) as usize {
                let s = (y * tile.width as usize + x) * 4;
                let d = (y * tw as usize + x) * 8;
                let a = f32::from(tile.rgba[s + 3]) / 255.0;
                for c in 0..4 {
                    let v = f32::from(tile.rgba[s + c]) / 255.0;
                    let v = if c < 3 { v * a } else { v };
                    bytes[d + c * 2..d + c * 2 + 2]
                        .copy_from_slice(&half::f16::from_f32(v).to_le_bytes());
                }
            }
        }
        let tex = self.dev.upload(tw, th, &bytes);
        let zeros = self.dev.zeros();
        self.run(
            &GEN_PATTERN,
            &[&zeros, &tex],
            GenPatternParams::new(
                self.frame.ox,
                self.frame.oy,
                (fill.scale_pct / 100.0).max(0.01),
                0.0,
                origin.0 + fill.phase[0],
                origin.1 + fill.phase[1],
                1.0,
                tw,
                th,
            )
            .as_bytes(),
        )
    }
}

/// One plate an effect paints: premultiplied colour, composited onto
/// what lies under it in `blend` at `opacity` (0–1), through `mask` (`.r`).
pub struct FxPaint<T> {
    pub plate: T,
    pub blend: BlendMode,
    pub opacity: f32,
    pub mask: Option<T>,
}

fn paint<T>(plate: T, blend: BlendMode, opacity: f32, mask: Option<T>) -> FxPaint<T> {
    FxPaint {
        plate,
        blend,
        opacity: opacity.clamp(0.0, 1.0),
        mask,
    }
}

/// Draw one effect onto `acc`; returns the new accumulator: the effect's
/// [`paints`], each blended in turn.
pub fn draw(
    dev: &mut dyn FxDevice,
    acc: &Tex,
    src: &mut Source<Tex>,
    e: &EffectStep,
) -> Result<Tex, FxError> {
    let mut out = *acc;
    for p in paints(dev, src, e)? {
        out = dev.run(
            blend_def(p.blend),
            &[&out, &p.plate],
            ComposeParams::new(p.opacity).as_bytes(),
            p.mask.as_ref(),
        )?;
    }
    Ok(out)
}

/// The plates one effect paints, bottom first (a bevel paints two: the
/// highlight, then the shadow).
pub fn paints(
    dev: &mut dyn FxDevice,
    src: &mut Source<Tex>,
    e: &EffectStep,
) -> Result<Vec<FxPaint<Tex>>, FxError> {
    let frame = dev.frame();
    let mut r = Rec { dev, frame };
    // The whole canvas, in canvas coordinates (the tile's origin moves
    // the gradient kernels onto it).
    let (cw, ch) = (frame.cw, frame.ch);
    let a = src.alpha;
    match &e.fx {
        Fx::DropShadow(s) => {
            let angle = if s.use_global_light {
                e.light.angle
            } else {
                s.angle
            };
            let size = s.size;
            let spread = size * s.spread.clamp(0.0, 100.0) / 100.0;
            let shifted = r.shift(&a, shadow_offset(angle, s.distance), false, 0.0)?;
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
            Ok(vec![paint(plate, s.blend, s.opacity / 100.0, mask)])
        }
        Fx::InnerShadow(s) => {
            let angle = if s.use_global_light {
                e.light.angle
            } else {
                s.angle
            };
            let size = s.size;
            let choke = size * s.spread.clamp(0.0, 100.0) / 100.0;
            // The inverse of the shape, moved, grown by the choke, blurred:
            // beyond the canvas counts as outside the shape.
            let hole = r.shift(&a, shadow_offset(angle, s.distance), true, 1.0)?;
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
            Ok(vec![paint(plate, s.blend, s.opacity / 100.0, None)])
        }
        Fx::OuterGlow(g) => {
            let size = g.size;
            let spread = size * g.spread.clamp(0.0, 100.0) / 100.0;
            let falloff = match g.technique {
                GlowTechnique::Softer => {
                    let grown = if spread > 0.0 {
                        let sd = r.source_sd(src, spread + 2.0)?;
                        r.ramp(&sd, StyleRampParams::band(-4096.0, spread))?
                    } else {
                        a
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
            glow(&mut r, &falloff, g, e.seed)
        }
        Fx::InnerGlow(g) => {
            let size = g.size;
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
            glow(&mut r, &edge, g, e.seed)
        }
        Fx::Satin(s) => {
            let size = s.size;
            let (dx, dy) = shadow_offset(s.angle, s.distance);
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
            Ok(vec![paint(plate, s.blend, s.opacity / 100.0, None)])
        }
        Fx::ColorOverlay(p, color) => {
            let plate = r.solid(*color)?;
            Ok(vec![paint(plate, p.blend, p.opacity / 100.0, None)])
        }
        Fx::GradientOverlay(p, g) => {
            let area = if g.align {
                e.bounds
            } else {
                Rect::new(0, 0, cw, ch)
            };
            let plate = r.gradient_plate(g, area)?;
            Ok(vec![paint(plate, p.blend, p.opacity / 100.0, None)])
        }
        Fx::PatternOverlay(p, fill) => {
            let Some(tile) = &e.pattern else {
                return Ok(Vec::new());
            };
            let origin = if fill.link {
                (e.bounds.x as f32, e.bounds.y as f32)
            } else {
                (0.0, 0.0)
            };
            let plate = r.pattern_plate(fill, tile, origin)?;
            Ok(vec![paint(plate, p.blend, p.opacity / 100.0, None)])
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
                StrokeFill::Color(rgb) => r.solid(*rgb)?,
                StrokeFill::Gradient(g) => {
                    let area = if g.align {
                        e.bounds
                    } else {
                        Rect::new(0, 0, cw, ch)
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
                    None => return Ok(Vec::new()),
                },
            };
            Ok(vec![paint(
                plate,
                s.paint.blend,
                s.paint.opacity / 100.0,
                Some(cov),
            )])
        }
        Fx::Bevel(b) => bevel(&mut r, src, b, e),
    }
}

/// A glow's falloff through its range and contour, coloured (one colour,
/// or the ramp across the falloff, its start at the edge) and blended.
fn glow(r: &mut Rec<'_>, falloff: &Tex, g: &Glow, seed: u32) -> Result<Vec<FxPaint<Tex>>, FxError> {
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
    let cov = if g.center {
        let c = r.run(
            &STYLE_CONTOUR,
            &[falloff],
            StyleContourParams::new(&contour_lut(&FxContour::linear()), 0.0, hi, true, 0)
                .as_bytes(),
        )?;
        r.contour(&c, &g.contour, 0.0, 1.0, false)?
    } else {
        r.contour(falloff, &g.contour, 0.0, hi, false)?
    };
    let (lut, mode) = match &g.fill {
        GlowFill::Color(rgb) => {
            let c = rgb01(*rgb);
            ([[c[0], c[1], c[2], 1.0]; 256], COLORIZE_COVERAGE)
        }
        // The ramp's start at the edge.
        GlowFill::Ramp(ramp) => (ramp_lut(ramp, false), COLORIZE_GLOW_GRADIENT),
    };
    let plate = r.colorize(
        &cov,
        StyleColorizeParams::new(lut, mode, 0, g.noise / 100.0, g.jitter / 100.0, seed),
    )?;
    Ok(vec![paint(plate, g.blend, g.opacity / 100.0, None)])
}

fn bevel(
    r: &mut Rec<'_>,
    src: &mut Source<Tex>,
    b: &Bevel,
    e: &EffectStep,
) -> Result<Vec<FxPaint<Tex>>, FxError> {
    let size = b.size.max(0.5);
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
        src.alpha
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
                r.dev.run(
                    &BAND_TAKE,
                    &[&inv, &f],
                    BandTakeParams::new().as_bytes(),
                    Some(&a),
                )?
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
        BevelStyle::InnerBevel | BevelStyle::StrokeEmboss => Some(a),
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
            let range = (c.range_pct / 100.0).clamp(0.01, 1.0);
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
    let shade = r.blur(&shade, b.soften * 0.5, -1.0)?;
    // The flat surface's shade is the light's own (the gloss contour bends
    // the shading, not the reference it splits at: Photoshop's cone gloss
    // turns a flat top into highlight).
    let flat = altitude.to_radians().sin().clamp(0.0, 1.0);
    let split = r.run(
        &STYLE_SPLIT,
        &[&shade],
        StyleSplitParams::new(flat).as_bytes(),
    )?;
    let mut out = Vec::with_capacity(2);
    for (channel, light) in [(0u32, &b.highlight), (1, &b.shadow)] {
        let c = rgb01(light.color);
        let p = StyleColorizeParams::solid(c, channel, 0.0, 0);
        let plate = r.colorize(&split, p)?;
        out.push(paint(plate, light.blend, light.opacity / 100.0, region));
    }
    Ok(out)
}

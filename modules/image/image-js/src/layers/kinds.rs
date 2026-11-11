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

//! The layer KINDS and PROPERTIES Photoshop's Layers panel has and the
//! plain pixel stack did not: typed adjustment layers, fill layers,
//! blending ranges (Blend If), fill opacity, knockout, the four locks,
//! colour labels, links and layer comps.
//!
//! Adjustment layers hold engine `RasterOp`s (`adjust_ops`).
//!
//! # Fill layers
//!
//! A fill layer's pixels are a RENDER of its source (a colour, a gradient,
//! a pattern) at the canvas, by the `gen.*` kernels — the layer keeps the
//! source and the render, like a smart object keeps its source and its
//! render. Every reader of layer pixels (the fold, merge, save-back) reads
//! the render; an edit re-renders. A render that no longer matches its
//! source is STALE and is rendered before the next composite.

use std::sync::Arc;

use image_kernels::KernelDef;

use crate::fill::GradientKind;
use crate::ingest::IngestError;

/// A colour stop of a gradient: where (0–1) and which colour.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ColorStop {
    pub at: f32,
    pub rgb: [u8; 3],
}

/// The 256-entry RGB ramp of `stops` (sorted by position, linear between
/// them, flat beyond the ends), reversed when asked: the gradient map's
/// ramp (`paged_image_adjust::tables::gradient_ramp`).
pub fn stop_ramp(stops: &[ColorStop], reverse: bool) -> [[f32; 3]; 256] {
    let stops: Vec<paged_model::GradientMapStop> = stops
        .iter()
        .map(|s| paged_model::GradientMapStop {
            at: s.at,
            color: s.rgb.map(|v| f32::from(v) / 255.0),
        })
        .collect();
    paged_image_adjust::tables::gradient_ramp(&stops, reverse)
}

// ───────────────────────────── fill layers ─────────────────────────────

/// What a fill layer paints.
#[derive(Debug, Clone, PartialEq)]
pub enum FillSource {
    /// One colour everywhere.
    Solid {
        rgb: [u8; 3],
    },
    Gradient(GradientFill),
    Pattern(PatternFill),
}

/// A gradient fill, as Photoshop's Gradient Fill dialog sets it: the
/// style, the angle (degrees, counter-clockwise from 3 o'clock), the scale
/// (percent of the span across the canvas at that angle), reverse, the
/// offset of the centre (percent of the canvas) and the colour stops.
#[derive(Debug, Clone, PartialEq)]
pub struct GradientFill {
    pub style: GradientKind,
    pub angle: f32,
    pub scale: f32,
    pub reverse: bool,
    pub offset: (f32, f32),
    pub stops: Vec<ColorStop>,
}

/// A pattern fill: the tile (straight RGBA8, `width × height`), the name
/// it is known by, its scale (percent) and angle (degrees).
#[derive(Debug, Clone, PartialEq)]
pub struct PatternFill {
    pub name: String,
    pub tile: Arc<[u8]>,
    pub width: u32,
    pub height: u32,
    pub scale: f32,
    pub angle: f32,
}

/// A fill layer: its source and whether its render is out of date.
#[derive(Debug, Clone, PartialEq)]
pub struct FillLayer {
    pub source: FillSource,
    /// The layer's pixels no longer show `source` (it was edited, or the
    /// canvas changed); the next composite renders it.
    pub stale: bool,
}

impl FillSource {
    /// The wire name: `solid`, `gradient` or `pattern`.
    pub fn kind_name(&self) -> &'static str {
        match self {
            FillSource::Solid { .. } => "solid",
            FillSource::Gradient(_) => "gradient",
            FillSource::Pattern(_) => "pattern",
        }
    }

    /// Photoshop's name for a new layer of this fill.
    pub fn default_layer_name(&self) -> &'static str {
        match self {
            FillSource::Solid { .. } => "Color Fill",
            FillSource::Gradient(_) => "Gradient Fill",
            FillSource::Pattern(_) => "Pattern Fill",
        }
    }

    /// The flat parameter block:
    ///
    /// ```text
    /// solid     r, g, b
    /// gradient  style (0 linear, 1 radial, 2 angle, 3 reflected, 4 diamond),
    ///           angle, scale, reverse, offset x, offset y, n, n × (at, r, g, b)
    /// pattern   scale, angle   (the tile is a buffer of its own)
    /// ```
    pub fn values(&self) -> Vec<f32> {
        match self {
            FillSource::Solid { rgb } => rgb.map(f32::from).to_vec(),
            FillSource::Gradient(g) => {
                let style = match g.style {
                    GradientKind::Linear => 0.0,
                    GradientKind::Radial => 1.0,
                    GradientKind::Angular => 2.0,
                    GradientKind::Reflected => 3.0,
                    GradientKind::Diamond => 4.0,
                };
                let mut v = vec![
                    style,
                    g.angle,
                    g.scale,
                    if g.reverse { 1.0 } else { 0.0 },
                    g.offset.0,
                    g.offset.1,
                    g.stops.len() as f32,
                ];
                for s in &g.stops {
                    v.push(s.at);
                    v.extend(s.rgb.map(f32::from));
                }
                v
            }
            FillSource::Pattern(p) => vec![p.scale, p.angle],
        }
    }

    /// Rebuild from [`values`](Self::values); a pattern takes its tile
    /// and name alongside (`tile` is `(rgba, width, height)`).
    pub fn from_wire(
        kind: &str,
        values: &[f32],
        tile: Option<(Arc<[u8]>, u32, u32)>,
        name: &str,
    ) -> Result<FillSource, IngestError> {
        let c = |v: f32, lo: f32, hi: f32| {
            if v.is_finite() {
                v.clamp(lo, hi)
            } else {
                lo.max(0.0).min(hi)
            }
        };
        let byte = |v: f32| c(v, 0.0, 255.0).round() as u8;
        let bad = |d: String| IngestError::Unsupported(format!("{kind} fill: {d}"));
        Ok(match kind {
            "solid" => {
                if values.len() != 3 {
                    return Err(bad(format!("{} values, expected 3", values.len())));
                }
                FillSource::Solid {
                    rgb: [byte(values[0]), byte(values[1]), byte(values[2])],
                }
            }
            "gradient" => {
                if values.len() < 7 {
                    return Err(bad(format!("{} values, expected 7 or more", values.len())));
                }
                let n = c(values[6], 0.0, 64.0) as usize;
                if values.len() != 7 + n * 4 || n < 2 {
                    return Err(bad(format!(
                        "{} values for {n} stops (two at least, four values each)",
                        values.len()
                    )));
                }
                let style = match values[0].round() as i32 {
                    0 => GradientKind::Linear,
                    1 => GradientKind::Radial,
                    2 => GradientKind::Angular,
                    3 => GradientKind::Reflected,
                    4 => GradientKind::Diamond,
                    s => return Err(bad(format!("style {s}"))),
                };
                FillSource::Gradient(GradientFill {
                    style,
                    angle: c(values[1], -360.0, 360.0),
                    scale: c(values[2], 10.0, 1000.0),
                    reverse: values[3] >= 0.5,
                    offset: (c(values[4], -100.0, 100.0), c(values[5], -100.0, 100.0)),
                    stops: values[7..]
                        .as_chunks::<4>()
                        .0
                        .iter()
                        .map(|s| ColorStop {
                            at: c(s[0], 0.0, 1.0),
                            rgb: [byte(s[1]), byte(s[2]), byte(s[3])],
                        })
                        .collect(),
                })
            }
            "pattern" => {
                if values.len() != 2 {
                    return Err(bad(format!("{} values, expected 2", values.len())));
                }
                let (tile, width, height) =
                    tile.ok_or_else(|| bad("no pattern tile (define a pattern first)".into()))?;
                if width == 0 || height == 0 || tile.len() != width as usize * height as usize * 4 {
                    return Err(bad(format!(
                        "a {width}×{height} tile of {} bytes",
                        tile.len()
                    )));
                }
                FillSource::Pattern(PatternFill {
                    name: name.to_string(),
                    tile,
                    width,
                    height,
                    scale: c(values[0], 1.0, 1000.0),
                    angle: c(values[1], -360.0, 360.0),
                })
            }
            other => {
                return Err(IngestError::Unsupported(format!(
                    "unknown fill kind \"{other}\" (solid | gradient | pattern)"
                )))
            }
        })
    }
}

// ─────────────────────────── blending options ───────────────────────────

/// One channel's blending ranges: This Layer's and the Underlying
/// Layer's `[black low, black high, white low, white high]` (0–255; an
/// unsplit slider has low = high).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BlendIfChannel {
    pub this: [u8; 4],
    pub under: [u8; 4],
}

/// The sliders that pass everything.
pub const BLEND_IF_OPEN: [u8; 4] = [0, 0, 255, 255];

impl Default for BlendIfChannel {
    fn default() -> Self {
        BlendIfChannel {
            this: BLEND_IF_OPEN,
            under: BLEND_IF_OPEN,
        }
    }
}

/// BLEND IF — gray, red, green, blue.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct BlendIf {
    pub channels: [BlendIfChannel; 4],
}

impl BlendIf {
    /// Every slider open: no effect.
    pub fn is_open(&self) -> bool {
        self.channels
            .iter()
            .all(|c| c.this == BLEND_IF_OPEN && c.under == BLEND_IF_OPEN)
    }

    /// Does anything depend on what lies beneath?
    pub fn uses_underlying(&self) -> bool {
        self.channels.iter().any(|c| c.under != BLEND_IF_OPEN)
    }

    /// The `band.blend_if` parameter block: each slider pair as a ramp
    /// `clamp(v·k + o)` on the 0–1 value. A pair rises (black) or falls
    /// (white) over `high − low + 1` levels — a one-level step when the
    /// slider is not split, so an 8-bit level at the slider is in and the
    /// one beyond it is out — and an open pair is `k = 0, o = 1`.
    pub fn kernel_params(&self) -> image_kernels::families::band::BandBlendIfParams {
        let rise = |lo: u8, hi: u8| -> (f32, f32) {
            if lo == 0 && hi == 0 {
                return (0.0, 1.0);
            }
            let (lo, hi) = (f32::from(lo), f32::from(hi.max(lo)));
            let span = hi - lo + 1.0;
            (255.0 / span, -(lo - 1.0) / span)
        };
        let fall = |lo: u8, hi: u8| -> (f32, f32) {
            if lo == 255 && hi == 255 {
                return (0.0, 1.0);
            }
            let (lo, hi) = (f32::from(lo.min(hi)), f32::from(hi));
            let span = hi - lo + 1.0;
            (-255.0 / span, (hi + 1.0) / span)
        };
        let mut v = [0f32; 32];
        for (side, pick) in [0usize, 1].iter().zip([true, false]) {
            for ch in 0..4 {
                let s = if pick {
                    self.channels[ch].this
                } else {
                    self.channels[ch].under
                };
                let (lk, lo) = rise(s[0], s[1]);
                let (hk, ho) = fall(s[2], s[3]);
                // Field order: per side, lk0..3, lo0..3, hk0..3, ho0..3.
                let base = side * 16;
                v[base + ch] = lk;
                v[base + 4 + ch] = lo;
                v[base + 8 + ch] = hk;
                v[base + 12 + ch] = ho;
            }
        }
        image_kernels::families::band::BandBlendIfParams::new(
            v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7], v[8], v[9], v[10], v[11], v[12], v[13],
            v[14], v[15], v[16], v[17], v[18], v[19], v[20], v[21], v[22], v[23], v[24], v[25],
            v[26], v[27], v[28], v[29], v[30], v[31],
        )
    }

    /// As 32 bytes: per channel, This Layer's four then the Underlying's.
    pub fn to_bytes(&self) -> [u8; 32] {
        let mut out = [0u8; 32];
        for (ch, c) in self.channels.iter().enumerate() {
            out[ch * 8..ch * 8 + 4].copy_from_slice(&c.this);
            out[ch * 8 + 4..ch * 8 + 8].copy_from_slice(&c.under);
        }
        out
    }

    /// [`to_bytes`](Self::to_bytes)' inverse; a pair out of order is put
    /// in order.
    pub fn from_bytes(b: &[u8; 32]) -> BlendIf {
        let fix = |s: [u8; 4]| {
            let (b0, b1) = (s[0].min(s[1]), s[0].max(s[1]));
            let (w0, w1) = (s[2].min(s[3]), s[2].max(s[3]));
            [b0, b1, w0, w1]
        };
        let mut bi = BlendIf::default();
        for (ch, c) in bi.channels.iter_mut().enumerate() {
            c.this = fix(b[ch * 8..ch * 8 + 4].try_into().expect("4"));
            c.under = fix(b[ch * 8 + 4..ch * 8 + 8].try_into().expect("4"));
        }
        bi
    }
}

/// KNOCKOUT — where a layer's pixels are, the layers beneath it inside its
/// group (shallow) or down to the Background layer (deep) are cut away, so
/// the layer blends onto what is under them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Knockout {
    #[default]
    None,
    Shallow,
    Deep,
}

impl Knockout {
    pub fn from_wire(s: &str) -> Option<Knockout> {
        Some(match s {
            "none" => Knockout::None,
            "shallow" => Knockout::Shallow,
            "deep" => Knockout::Deep,
            _ => return None,
        })
    }

    pub fn as_wire(self) -> &'static str {
        match self {
            Knockout::None => "none",
            Knockout::Shallow => "shallow",
            Knockout::Deep => "deep",
        }
    }

    pub fn code(self) -> u8 {
        match self {
            Knockout::None => 0,
            Knockout::Shallow => 1,
            Knockout::Deep => 2,
        }
    }

    pub fn from_code(c: u8) -> Knockout {
        match c {
            1 => Knockout::Shallow,
            2 => Knockout::Deep,
            _ => Knockout::None,
        }
    }
}

/// The locks beyond the image-pixels lock (`Layer::locked`). The artboard
/// lock is not offered: the stack has no artboards to lock.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct LayerLocks {
    /// Paint, fills and filters keep each pixel's alpha.
    pub transparency: bool,
    /// The layer does not move (Move, nudge, align, distribute).
    pub position: bool,
    /// Everything: pixels, transparency, position and the blending
    /// properties (opacity, fill, mode, blend-if, knockout).
    pub all: bool,
}

impl LayerLocks {
    pub fn bits(self) -> u8 {
        u8::from(self.transparency) | u8::from(self.position) << 1 | u8::from(self.all) << 2
    }

    pub fn from_bits(b: u8) -> LayerLocks {
        LayerLocks {
            transparency: b & 1 != 0,
            position: b & 2 != 0,
            all: b & 4 != 0,
        }
    }
}

/// Photoshop's colour labels, in its order (0 = none).
pub const COLOR_LABELS: [&str; 8] = [
    "none", "red", "orange", "yellow", "green", "blue", "violet", "gray",
];

/// The Photoshop-parity properties every layer carries, in one place so a
/// layer literal names them once.
#[derive(Debug, Clone, PartialEq)]
pub struct LayerExt {
    /// FILL opacity, 0–1: the layer's own pixels, apart from its opacity.
    /// Outside the eight special modes it multiplies with the opacity; on
    /// them it acts inside the blend (`band.fade_neutral`).
    pub fill_opacity: f32,
    /// BLEND IF; `None` (or all open) passes everything.
    pub blend_if: Option<Box<BlendIf>>,
    pub knockout: Knockout,
    pub locks: LayerLocks,
    /// An index into [`COLOR_LABELS`].
    pub color: u8,
    /// The LINK this layer belongs to: linked layers move together.
    pub link: Option<u32>,
    /// The layer's STYLE (Photoshop's layer effects, `paged-psd`'s model);
    /// `None` for none. Shared: a snapshot copies the pointer.
    pub style: Option<Arc<image_psd::effects::LayerStyle>>,
    /// The blending options that change how a style composites.
    pub style_options: StyleOptions,
    /// The layer's VECTOR MASK (image ADR 476): paths drawn as coverage
    /// and multiplied with its user mask. On a fill layer it makes a
    /// SHAPE LAYER.
    pub vector_mask: Option<std::sync::Arc<crate::vectors::LayerVectorMask>>,
    /// The PSD record this layer was read from and the state the import
    /// left it in (`crate::psd_source`); `None` for a layer made here.
    pub source: Option<Arc<crate::psd_source::PsdSource>>,
    /// A CMYK layer's own inks (image ADR 481), while it holds the pixels
    /// they were read with.
    pub inks: InkCell,
}

/// A layer's retained inks. Derived data: two layers are the same layer
/// whatever their cells hold (the pixels decide), so it always compares
/// equal and is never persisted.
#[derive(Debug, Clone, Default)]
pub struct InkCell(pub Option<Arc<crate::planes::InkPlanes>>);

impl PartialEq for InkCell {
    fn eq(&self, _: &InkCell) -> bool {
        true
    }
}

/// Blending Options ▸ Advanced Blending: the switches that change how a
/// layer's STYLE composites (Photoshop's `infx`, `clbl`, `tsly`, `lmgm`
/// and `vmgm` blocks).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StyleOptions {
    /// Blend Interior Effects as Group: the overlays, satin and inner glow
    /// join the layer before its mode and fill opacity apply.
    pub blend_interior: bool,
    /// Blend Clipped Layers as Group (the default, and the only way the
    /// stack draws a clipping group).
    pub blend_clipped: bool,
    /// Transparency Shapes Layer (the default; effects follow the layer's
    /// transparency).
    pub transparency_shapes: bool,
    /// Layer Mask Hides Effects: the mask hides the drawn effects instead
    /// of shaping them.
    pub mask_hides_effects: bool,
    /// Vector Mask Hides Effects (the stack keeps the vector mask in the
    /// layer's one mask, so either switch hides through it).
    pub vector_mask_hides_effects: bool,
}

impl Default for StyleOptions {
    fn default() -> Self {
        StyleOptions {
            blend_interior: false,
            blend_clipped: true,
            transparency_shapes: true,
            mask_hides_effects: false,
            vector_mask_hides_effects: false,
        }
    }
}

impl StyleOptions {
    /// Does the mask hide the effects (rather than shape them)?
    pub fn hides(&self) -> bool {
        self.mask_hides_effects || self.vector_mask_hides_effects
    }

    /// The five switches as bits (persistence): 1 interior, 2 clipped,
    /// 4 transparency shapes, 8 mask hides, 16 vector mask hides.
    pub fn bits(&self) -> u8 {
        u8::from(self.blend_interior)
            | u8::from(self.blend_clipped) << 1
            | u8::from(self.transparency_shapes) << 2
            | u8::from(self.mask_hides_effects) << 3
            | u8::from(self.vector_mask_hides_effects) << 4
    }

    pub fn from_bits(b: u8) -> StyleOptions {
        StyleOptions {
            blend_interior: b & 1 != 0,
            blend_clipped: b & 2 != 0,
            transparency_shapes: b & 4 != 0,
            mask_hides_effects: b & 8 != 0,
            vector_mask_hides_effects: b & 16 != 0,
        }
    }
}

impl Default for LayerExt {
    fn default() -> Self {
        LayerExt {
            fill_opacity: 1.0,
            blend_if: None,
            knockout: Knockout::None,
            locks: LayerLocks::default(),
            color: 0,
            link: None,
            style: None,
            style_options: StyleOptions::default(),
            vector_mask: None,
            source: None,
            inks: InkCell::default(),
        }
    }
}

/// Photoshop's eight special blend modes and each one's NEUTRAL colour —
/// the source value that blends to the backdrop unchanged, toward which
/// fill opacity moves the source. `None` for every other mode.
pub fn special_fill_neutral(blend: &KernelDef) -> Option<f32> {
    Some(match blend.id {
        "compose.color_dodge" | "compose.linear_dodge" | "compose.difference" => 0.0,
        "compose.color_burn" | "compose.linear_burn" => 1.0,
        "compose.vivid_light" | "compose.linear_light" | "compose.hard_mix" => 0.5,
        _ => return None,
    })
}

// ───────────────────────────── layer comps ─────────────────────────────

/// What a layer comp recorded about one layer.
#[derive(Debug, Clone)]
pub struct CompEntry {
    /// The layer's stable id.
    pub id: u32,
    pub visible: bool,
    /// POSITION: the layer's pixels as they were placed. The stack's
    /// layers have no position apart from their pixels, so a comp keeps
    /// the pixels (a shared buffer, not a copy) and applying it puts them
    /// back.
    pub pixels: Option<crate::pixels::LayerPixels>,
    pub appearance: Option<CompAppearance>,
}

/// APPEARANCE: the blending properties.
#[derive(Debug, Clone, PartialEq)]
pub struct CompAppearance {
    pub opacity: f32,
    pub fill_opacity: f32,
    pub blend: &'static KernelDef,
    pub blend_if: Option<Box<BlendIf>>,
    pub knockout: Knockout,
}

/// A LAYER COMP: a named record of the layers' visibility, position and
/// appearance (Photoshop's three), applied in one undo step.
#[derive(Debug, Clone)]
pub struct LayerComp {
    pub id: u32,
    pub name: String,
    pub visibility: bool,
    pub position: bool,
    pub appearance: bool,
    pub entries: Vec<CompEntry>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[allow(non_snake_case)]
    fn a_stop_ramp_interpolates_and_reverses__feat__image_layers_photoshop_parity() {
        let stops = [
            ColorStop {
                at: 0.0,
                rgb: [0, 0, 0],
            },
            ColorStop {
                at: 1.0,
                rgb: [255, 0, 255],
            },
        ];
        let r = stop_ramp(&stops, false);
        assert_eq!(r[0], [0.0, 0.0, 0.0]);
        assert_eq!(r[255], [1.0, 0.0, 1.0]);
        assert!((r[128][0] - 128.0 / 255.0).abs() < 1e-5);
        let rev = stop_ramp(&stops, true);
        assert_eq!(rev[0], [1.0, 0.0, 1.0]);
    }

    /// The ramps the kernel gets: open passes everything; an unsplit black
    /// slider at 64 lets 64 through and stops 63; a split one rises across
    /// its span.
    #[test]
    #[allow(non_snake_case)]
    fn blend_if_sliders_become_ramps__feat__image_layers_photoshop_parity() {
        let ramp = |k: f32, o: f32, level: f32| (level / 255.0 * k + o).clamp(0.0, 1.0);
        let open = BlendIf::default();
        assert!(open.is_open());
        let p = open.kernel_params();
        assert_eq!((p.slk0, p.slo0, p.shk0, p.sho0), (0.0, 1.0, 0.0, 1.0));
        let mut bi = BlendIf::default();
        bi.channels[0].this = [64, 64, 255, 255];
        bi.channels[1].under = [0, 0, 200, 220];
        let p = bi.kernel_params();
        assert!(ramp(p.slk0, p.slo0, 64.0) >= 0.999);
        assert!(ramp(p.slk0, p.slo0, 63.0) <= 0.001);
        assert!(ramp(p.dhk1, p.dho1, 200.0) >= 0.999);
        assert!(ramp(p.dhk1, p.dho1, 221.0) <= 0.001);
        let mid = ramp(p.dhk1, p.dho1, 210.0);
        assert!(mid > 0.3 && mid < 0.7, "{mid}");
        assert_eq!(BlendIf::from_bytes(&bi.to_bytes()), bi);
        assert!(bi.uses_underlying());
    }
}

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

//! The SELECT family — kernels whose output is a SELECTION, not an image
//! (image ADR 470). One kernel so far: `select.color_range`, Photoshop's
//! Select ▸ Color Range.
//!
//! The output is a coverage field written as `(m, m, m, 1)` in the
//! rgba16float target; the caller reads the red channel. The kernel
//! never reads the ABI's `mask` binding: a selection-producing kernel
//! has no selection to be scoped by (the conformance lane derives that
//! from the source and skips the mask properties for it).
//!
//! THE MODEL was fitted to Photoshop 27.10's recorded answers
//! (`scripts/photoshop/probes/selection.jsx`, replayed by
//! `image-conformance/tests/it/oracle_photoshop_selection.rs`):
//!
//! * SAMPLED colours: the samples span a Lab (D50) BOX; a pixel's
//!   distance to it is the CHEBYSHEV distance with L weighted 0.85
//!   (`max(0.85·|ΔL|, |Δa|, |Δb|)`, 0 inside). Coverage falls off as
//!   the quadratic ease `g(3·d / fuzziness)` — `1 − 2u²` up to u = ½,
//!   `2(1 − u)²` after, 0 from u = 1 — so a fuzziness of F reaches out
//!   to a distance of F/3. Agrees with Photoshop within 3/255.
//! * The HUE presets (Reds … Magentas): a triangle 60° wide either side
//!   of the preset's HSV hue, times the HSV chroma (max − min), times
//!   (2 − V). Agrees within 1/255.
//! * The TONAL presets (Highlights, Midtones, Shadows): Rec. 601 luma of
//!   the encoded values on 0…255; inside [lower, upper] fully selected,
//!   outside falling off with `g(d / w)` where the width w is the
//!   fuzziness times the distance from the limit to the far end of the
//!   scale (Midtones: the nearer of its two ends). Agrees within the
//!   quantisation of an 8-bit luma.
//! * SKIN TONES: Photoshop's model is not published and selects bright
//!   near-neutrals as well; ours is the classical elliptical skin cluster
//!   in Cb/Cr (Hsu, Abdel-Mottaleb and Jain 2002, without their
//!   luma-dependent transform), softened by the fuzziness and gated off
//!   in the deep shadows. A stated convention, not an agreement.
//! * LOCALIZED colour clusters: each sample selects around its own colour
//!   (the sampled rule with a one-colour box), weighted by `g(r / range)`
//!   of the distance to where it was sampled; the samples combine by max.
//!
//! The scalar twin ([`color_range_px`]) is the same function in Rust:
//! the test-only reference (`reference`) and the shipped no-GPU path
//! (`cpu`, ADR 465 as amended by ADR 470).

use crate::{KernelClass, KernelDef, ParamField, ParamsLayout, Tolerance};

/// Most samples a Color Range carries (eyedropper clicks).
pub const COLOR_RANGE_MAX_SAMPLES: usize = 8;

/// What a Color Range selects by.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum ColorRangeMode {
    /// The sampled colours (eyedropper).
    Sampled = 0,
    /// A hue preset (Reds … Magentas); `hue_center` names it.
    Hue = 1,
    /// A tonal preset (Highlights, Midtones, Shadows).
    Tonal = 2,
    /// Skin tones.
    Skin = 3,
}

impl ColorRangeMode {
    pub fn from_u32(v: u32) -> Option<Self> {
        Some(match v {
            0 => Self::Sampled,
            1 => Self::Hue,
            2 => Self::Tonal,
            3 => Self::Skin,
            _ => return None,
        })
    }
}

/// The param block. Every value travels as f32 inside `vec4`s, so the
/// WGSL struct is uniform-layout-safe without padding rules.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, ::bytemuck::Pod, ::bytemuck::Zeroable)]
pub struct ColorRangeParams {
    /// mode, fuzziness, invert (0/1), sample count.
    pub cfg: [f32; 4],
    /// localized (0/1), range in px, hue centre (degrees), midtones (0/1).
    pub cfg2: [f32; 4],
    /// tonal lower limit, tonal upper limit (0…255), _, _.
    pub tone: [f32; 4],
    /// The sampled box: min L, a, b.
    pub box_min: [f32; 4],
    /// The sampled box: max L, a, b.
    pub box_max: [f32; 4],
    /// Per sample two vec4s: `[L, a, b, _]`, `[x, y, _, _]`.
    pub samples: [[f32; 4]; 2 * COLOR_RANGE_MAX_SAMPLES],
}

impl ColorRangeParams {
    fn base(mode: ColorRangeMode, fuzziness: f32, invert: bool) -> Self {
        let mut p: Self = ::bytemuck::Zeroable::zeroed();
        p.cfg = [
            mode as u32 as f32,
            fuzziness,
            f32::from(u8::from(invert)),
            0.0,
        ];
        p
    }

    /// Sampled colours (Lab D50) at image positions, Photoshop's
    /// fuzziness (0…200). Without `localized` the samples only span the
    /// box; with it, each one also weighs by its distance (`range` px).
    pub fn sampled(
        samples: &[([f32; 3], [f32; 2])],
        fuzziness: f32,
        invert: bool,
        localized: Option<f32>,
    ) -> Self {
        let mut p = Self::base(ColorRangeMode::Sampled, fuzziness, invert);
        let n = samples.len().min(COLOR_RANGE_MAX_SAMPLES);
        p.cfg[3] = n as f32;
        let mut lo = [f32::INFINITY; 3];
        let mut hi = [f32::NEG_INFINITY; 3];
        for (i, (lab, xy)) in samples.iter().take(n).enumerate() {
            p.samples[2 * i] = [lab[0], lab[1], lab[2], 0.0];
            p.samples[2 * i + 1] = [xy[0], xy[1], 0.0, 0.0];
            for c in 0..3 {
                lo[c] = lo[c].min(lab[c]);
                hi[c] = hi[c].max(lab[c]);
            }
        }
        if n > 0 {
            p.box_min = [lo[0], lo[1], lo[2], 0.0];
            p.box_max = [hi[0], hi[1], hi[2], 0.0];
        }
        if let Some(range) = localized {
            p.cfg2[0] = 1.0;
            p.cfg2[1] = range.max(0.0);
        }
        p
    }

    /// A Lab box directly (what Photoshop's descriptor carries).
    pub fn sampled_box(min: [f32; 3], max: [f32; 3], fuzziness: f32, invert: bool) -> Self {
        let mut p = Self::base(ColorRangeMode::Sampled, fuzziness, invert);
        p.cfg[3] = 1.0;
        p.box_min = [min[0], min[1], min[2], 0.0];
        p.box_max = [max[0], max[1], max[2], 0.0];
        p
    }

    /// A hue preset centred on `hue` degrees (0 reds, 60 yellows, …).
    pub fn hue(hue: f32, invert: bool) -> Self {
        let mut p = Self::base(ColorRangeMode::Hue, 0.0, invert);
        p.cfg2[2] = hue;
        p
    }

    /// A tonal preset: [lower, upper] on 0…255, fuzziness 0…1 (the
    /// dialog's percent / 100); `midtones` selects the two-sided width.
    pub fn tonal(lower: f32, upper: f32, fuzziness: f32, midtones: bool, invert: bool) -> Self {
        let mut p = Self::base(ColorRangeMode::Tonal, fuzziness, invert);
        p.cfg2[3] = f32::from(u8::from(midtones));
        p.tone = [lower, upper, 0.0, 0.0];
        p
    }

    /// Skin tones; fuzziness 0…200 (the falloff outside the cluster).
    pub fn skin(fuzziness: f32, invert: bool) -> Self {
        Self::base(ColorRangeMode::Skin, fuzziness, invert)
    }

    pub fn as_bytes(&self) -> &[u8] {
        ::bytemuck::bytes_of(self)
    }
}

const COLOR_RANGE_FIELDS: &[ParamField] = &[
    ParamField {
        name: "cfg",
        wgsl_ty: "vec4<f32>",
    },
    ParamField {
        name: "cfg2",
        wgsl_ty: "vec4<f32>",
    },
    ParamField {
        name: "tone",
        wgsl_ty: "vec4<f32>",
    },
    ParamField {
        name: "box_min",
        wgsl_ty: "vec4<f32>",
    },
    ParamField {
        name: "box_max",
        wgsl_ty: "vec4<f32>",
    },
    ParamField {
        name: "samples",
        wgsl_ty: "array<vec4<f32>, 16>",
    },
];

/// Select ▸ Color Range: the coverage of every pixel under the model in
/// the module docs, written as `(m, m, m, 1)`.
pub static SELECT_COLOR_RANGE: KernelDef = KernelDef {
    id: "select.color_range",
    class: KernelClass::Point,
    inputs: 1,
    params: ParamsLayout {
        size: ::core::mem::size_of::<ColorRangeParams>(),
        fields: COLOR_RANGE_FIELDS,
    },
    wgsl: SELECT_COLOR_RANGE_WGSL,
    module: true,
    mip_exact: false,
    gpu_tolerance: Tolerance::ChannelEpsF16(16),
};

const SELECT_COLOR_RANGE_WGSL: &str = "\
// paged.image kernel `select.color_range` — handwritten under ABI v1.1.
// AGPL-3.0-only OR LicenseRef-PMEL; (c) And The Next GmbH.

struct Params {
    cfg: vec4<f32>,
    cfg2: vec4<f32>,
    tone: vec4<f32>,
    box_min: vec4<f32>,
    box_max: vec4<f32>,
    samples: array<vec4<f32>, 16>,
}

@group(0) @binding(0) var in0 : texture_2d<f32>;
@group(1) @binding(0) var<uniform> params : Params;
@group(3) @binding(0) var outp : texture_storage_2d<rgba16float, write>;

fn ease(u: f32) -> f32 {
    let v = clamp(u, 0.0, 1.0);
    if (v < 0.5) { return 1.0 - 2.0 * v * v; }
    let w = 1.0 - v;
    return 2.0 * w * w;
}

fn lin(c: f32) -> f32 {
    if (c <= 0.04045) { return c / 12.92; }
    return pow((c + 0.055) / 1.055, 2.4);
}

fn lab_f(t: f32) -> f32 {
    if (t > 0.008856452) { return pow(t, 1.0 / 3.0); }
    return (903.2963 * t + 16.0) / 116.0;
}

fn to_lab(c: vec3<f32>) -> vec3<f32> {
    let r = lin(c.r);
    let g = lin(c.g);
    let b = lin(c.b);
    let x = (0.4360747 * r + 0.3850649 * g + 0.1430804 * b) / 0.96422;
    let y = 0.2225045 * r + 0.7168786 * g + 0.0606169 * b;
    let z = (0.0139322 * r + 0.0971045 * g + 0.7141733 * b) / 0.82521;
    let fx = lab_f(x);
    let fy = lab_f(y);
    let fz = lab_f(z);
    return vec3<f32>(116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz));
}

fn box_distance(lab: vec3<f32>, lo: vec3<f32>, hi: vec3<f32>) -> f32 {
    let d = max(max(lo - lab, lab - hi), vec3<f32>(0.0));
    return max(0.85 * d.x, max(d.y, d.z));
}

fn by_distance(d: f32, fuzz: f32) -> f32 {
    if (fuzz <= 0.0) {
        if (d <= 0.0) { return 1.0; }
        return 0.0;
    }
    return ease(3.0 * d / fuzz);
}

fn sampled(c: vec3<f32>, xy: vec2<f32>) -> f32 {
    let lab = to_lab(c);
    let fuzz = params.cfg.y;
    let n = i32(params.cfg.w);
    if (params.cfg2.x < 0.5) {
        if (n <= 0) { return 0.0; }
        return by_distance(box_distance(lab, params.box_min.xyz, params.box_max.xyz), fuzz);
    }
    let range = params.cfg2.y;
    var best = 0.0;
    for (var i = 0; i < 8; i = i + 1) {
        if (i >= n) { break; }
        let s = params.samples[2 * i].xyz;
        let at = params.samples[2 * i + 1].xy;
        var w = 1.0;
        if (range > 0.0) { w = ease(distance(xy, at) / range); }
        best = max(best, w * by_distance(box_distance(lab, s, s), fuzz));
    }
    return best;
}

fn hue_band(c: vec3<f32>) -> f32 {
    let mx = max(c.r, max(c.g, c.b));
    let mn = min(c.r, min(c.g, c.b));
    let ch = mx - mn;
    if (ch <= 0.0) { return 0.0; }
    var h = 0.0;
    if (mx == c.r) {
        h = (c.g - c.b) / ch;
        if (h < 0.0) { h = h + 6.0; }
    } else if (mx == c.g) {
        h = (c.b - c.r) / ch + 2.0;
    } else {
        h = (c.r - c.g) / ch + 4.0;
    }
    h = h * 60.0;
    var dh = abs(h - params.cfg2.z);
    if (dh > 180.0) { dh = 360.0 - dh; }
    let t = clamp(1.0 - dh / 60.0, 0.0, 1.0);
    return clamp(t * ch * (2.0 - mx), 0.0, 1.0);
}

fn tonal(c: vec3<f32>) -> f32 {
    let y = (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) * 255.0;
    let lo = params.tone.x;
    let hi = params.tone.y;
    let f = params.cfg.y;
    var w_lo = f * lo;
    var w_hi = f * (255.0 - hi);
    if (params.cfg2.w > 0.5) {
        w_lo = f * min(lo, 255.0 - hi);
        w_hi = w_lo;
    }
    var d = 0.0;
    var w = 0.0;
    if (y < lo) {
        d = lo - y;
        w = w_lo;
    } else if (y > hi) {
        d = y - hi;
        w = w_hi;
    }
    if (d <= 0.0) { return 1.0; }
    if (w <= 0.0) { return 0.0; }
    return ease(d / w);
}

fn skin(c: vec3<f32>) -> f32 {
    let y8 = (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) * 255.0;
    let cb = 128.0 + (-0.168736 * c.r - 0.331264 * c.g + 0.5 * c.b) * 255.0;
    let cr = 128.0 + (0.5 * c.r - 0.418688 * c.g - 0.081312 * c.b) * 255.0;
    let ct = -0.8191915;
    let st = 0.57352;
    let u = ct * (cb - 109.38) + st * (cr - 152.02) - 1.60;
    let v = -st * (cb - 109.38) + ct * (cr - 152.02) - 2.41;
    let r = sqrt((u * u) / (25.39 * 25.39) + (v * v) / (14.03 * 14.03));
    var m = 1.0;
    if (r > 1.0) {
        let w = max(params.cfg.y, 0.0) / 100.0;
        if (w <= 0.0) { m = 0.0; } else { m = ease((r - 1.0) / w); }
    }
    if (y8 < 40.0) { m = m * ease((40.0 - y8) / 20.0); }
    return m;
}

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let d = textureDimensions(outp);
    if (gid.x >= d.x || gid.y >= d.y) { return; }
    let xy = vec2<i32>(i32(gid.x), i32(gid.y));
    let a = textureLoad(in0, xy, 0);
    var c = a.rgb;
    if (a.a > 0.0) { c = clamp(a.rgb / a.a, vec3<f32>(0.0), vec3<f32>(1.0)); }
    let pos = vec2<f32>(f32(gid.x) + 0.5, f32(gid.y) + 0.5);
    let mode = i32(params.cfg.x + 0.5);
    var m = 0.0;
    if (mode == 0) {
        m = sampled(c, pos);
    } else if (mode == 1) {
        m = hue_band(c);
    } else if (mode == 2) {
        m = tonal(c);
    } else {
        m = skin(c);
    }
    if (params.cfg.z > 0.5) { m = 1.0 - m; }
    m = clamp(m, 0.0, 1.0);
    textureStore(outp, xy, vec4<f32>(m, m, m, 1.0));
}
";

pub static FAMILY: &[&KernelDef] = &[&SELECT_COLOR_RANGE];

// ─────────────────────────── the scalar twin ───────────────────────────

#[cfg(any(feature = "reference", feature = "cpu"))]
mod twin {
    use super::ColorRangeParams;

    fn ease(u: f32) -> f32 {
        let v = u.clamp(0.0, 1.0);
        if v < 0.5 {
            1.0 - 2.0 * v * v
        } else {
            let w = 1.0 - v;
            2.0 * w * w
        }
    }

    fn lin(c: f32) -> f32 {
        if c <= 0.04045 {
            c / 12.92
        } else {
            ((c + 0.055) / 1.055).powf(2.4)
        }
    }

    fn lab_f(t: f32) -> f32 {
        if t > 0.008_856_452 {
            t.powf(1.0 / 3.0)
        } else {
            (903.2963 * t + 16.0) / 116.0
        }
    }

    /// sRGB (encoded, 0…1) to CIE Lab under D50, the Bradford-adapted
    /// sRGB matrix Photoshop's working space uses.
    pub fn to_lab(c: [f32; 3]) -> [f32; 3] {
        let (r, g, b) = (lin(c[0]), lin(c[1]), lin(c[2]));
        let x = (0.436_074_7 * r + 0.385_064_9 * g + 0.143_080_4 * b) / 0.96422;
        let y = 0.222_504_5 * r + 0.716_878_6 * g + 0.060_616_9 * b;
        let z = (0.013_932_2 * r + 0.097_104_5 * g + 0.714_173_3 * b) / 0.82521;
        let (fx, fy, fz) = (lab_f(x), lab_f(y), lab_f(z));
        [116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz)]
    }

    fn box_distance(lab: [f32; 3], lo: [f32; 3], hi: [f32; 3]) -> f32 {
        let d: Vec<f32> = (0..3)
            .map(|i| (lo[i] - lab[i]).max(lab[i] - hi[i]).max(0.0))
            .collect();
        (0.85 * d[0]).max(d[1].max(d[2]))
    }

    fn by_distance(d: f32, fuzz: f32) -> f32 {
        if fuzz <= 0.0 {
            if d <= 0.0 {
                1.0
            } else {
                0.0
            }
        } else {
            ease(3.0 * d / fuzz)
        }
    }

    fn xyz(v: [f32; 4]) -> [f32; 3] {
        [v[0], v[1], v[2]]
    }

    fn sampled(c: [f32; 3], pos: [f32; 2], p: &ColorRangeParams) -> f32 {
        let lab = to_lab(c);
        let fuzz = p.cfg[1];
        let n = p.cfg[3] as i32;
        if p.cfg2[0] < 0.5 {
            if n <= 0 {
                return 0.0;
            }
            return by_distance(box_distance(lab, xyz(p.box_min), xyz(p.box_max)), fuzz);
        }
        let range = p.cfg2[1];
        let mut best = 0.0f32;
        for i in 0..(n.clamp(0, 8) as usize) {
            let s = xyz(p.samples[2 * i]);
            let at = p.samples[2 * i + 1];
            let w = if range > 0.0 {
                ease((pos[0] - at[0]).hypot(pos[1] - at[1]) / range)
            } else {
                1.0
            };
            best = best.max(w * by_distance(box_distance(lab, s, s), fuzz));
        }
        best
    }

    fn hue_band(c: [f32; 3], p: &ColorRangeParams) -> f32 {
        let mx = c[0].max(c[1].max(c[2]));
        let mn = c[0].min(c[1].min(c[2]));
        let ch = mx - mn;
        if ch <= 0.0 {
            return 0.0;
        }
        let mut h = if mx == c[0] {
            let h = (c[1] - c[2]) / ch;
            if h < 0.0 {
                h + 6.0
            } else {
                h
            }
        } else if mx == c[1] {
            (c[2] - c[0]) / ch + 2.0
        } else {
            (c[0] - c[1]) / ch + 4.0
        };
        h *= 60.0;
        let mut dh = (h - p.cfg2[2]).abs();
        if dh > 180.0 {
            dh = 360.0 - dh;
        }
        let t = (1.0 - dh / 60.0).clamp(0.0, 1.0);
        (t * ch * (2.0 - mx)).clamp(0.0, 1.0)
    }

    fn tonal(c: [f32; 3], p: &ColorRangeParams) -> f32 {
        let y = (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) * 255.0;
        let (lo, hi, f) = (p.tone[0], p.tone[1], p.cfg[1]);
        let (w_lo, w_hi) = if p.cfg2[3] > 0.5 {
            let w = f * lo.min(255.0 - hi);
            (w, w)
        } else {
            (f * lo, f * (255.0 - hi))
        };
        let (d, w) = if y < lo {
            (lo - y, w_lo)
        } else if y > hi {
            (y - hi, w_hi)
        } else {
            (0.0, 0.0)
        };
        if d <= 0.0 {
            1.0
        } else if w <= 0.0 {
            0.0
        } else {
            ease(d / w)
        }
    }

    fn skin(c: [f32; 3], p: &ColorRangeParams) -> f32 {
        let y8 = (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) * 255.0;
        let cb = 128.0 + (-0.168_736 * c[0] - 0.331_264 * c[1] + 0.5 * c[2]) * 255.0;
        let cr = 128.0 + (0.5 * c[0] - 0.418_688 * c[1] - 0.081_312 * c[2]) * 255.0;
        let (ct, st) = (-0.819_191_5_f32, 0.573_52_f32);
        let u = ct * (cb - 109.38) + st * (cr - 152.02) - 1.60;
        let v = -st * (cb - 109.38) + ct * (cr - 152.02) - 2.41;
        let r = ((u * u) / (25.39 * 25.39) + (v * v) / (14.03 * 14.03)).sqrt();
        let mut m = 1.0;
        if r > 1.0 {
            let w = p.cfg[1].max(0.0) / 100.0;
            m = if w <= 0.0 { 0.0 } else { ease((r - 1.0) / w) };
        }
        if y8 < 40.0 {
            m *= ease((40.0 - y8) / 20.0);
        }
        m
    }

    /// The coverage of one pixel: `rgb` straight, encoded 0…1; `pos`
    /// its centre in image px.
    pub fn color_range_px(rgb: [f32; 3], pos: [f32; 2], p: &ColorRangeParams) -> f32 {
        let m = match p.cfg[0].round() as i32 {
            0 => sampled(rgb, pos, p),
            1 => hue_band(rgb, p),
            2 => tonal(rgb, p),
            _ => skin(rgb, p),
        };
        let m = if p.cfg[2] > 0.5 { 1.0 - m } else { m };
        m.clamp(0.0, 1.0)
    }

    /// The whole coverage field of a straight RGBA8 buffer, one byte per
    /// pixel (rounded) — the CPU path where no GPU exists.
    pub fn color_range_rgba8(rgba: &[u8], width: u32, p: &ColorRangeParams) -> Vec<u8> {
        let w = width.max(1) as usize;
        rgba.as_chunks::<4>()
            .0
            .iter()
            .enumerate()
            .map(|(i, px)| {
                let rgb = [
                    f32::from(px[0]) / 255.0,
                    f32::from(px[1]) / 255.0,
                    f32::from(px[2]) / 255.0,
                ];
                let pos = [(i % w) as f32 + 0.5, (i / w) as f32 + 0.5];
                (color_range_px(rgb, pos, p) * 255.0).round() as u8
            })
            .collect()
    }
}

#[cfg(any(feature = "reference", feature = "cpu"))]
pub use twin::{color_range_px, color_range_rgba8, to_lab};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn select_module_naga_validates() {
        for def in FAMILY {
            let src = crate::abi::assemble(def);
            let module = naga::front::wgsl::parse_str(&src)
                .unwrap_or_else(|e| panic!("{}: WGSL parse failed: {e}\n{src}", def.id));
            naga::valid::Validator::new(
                naga::valid::ValidationFlags::all(),
                naga::valid::Capabilities::default(),
            )
            .validate(&module)
            .unwrap_or_else(|e| panic!("{}: WGSL validation failed: {e:?}", def.id));
        }
    }

    #[test]
    fn params_are_twenty_one_vec4s() {
        assert_eq!(::core::mem::size_of::<ColorRangeParams>(), 21 * 16);
        assert_eq!(SELECT_COLOR_RANGE.params.size, 336);
        let p = ColorRangeParams::sampled(
            &[
                ([50.0, 10.0, -5.0], [3.0, 4.0]),
                ([60.0, 0.0, 5.0], [1.0, 1.0]),
            ],
            40.0,
            false,
            None,
        );
        assert_eq!(p.cfg, [0.0, 40.0, 0.0, 2.0]);
        assert_eq!(p.box_min[..3], [50.0, 0.0, -5.0]);
        assert_eq!(p.box_max[..3], [60.0, 10.0, 5.0]);
        assert_eq!(ColorRangeMode::from_u32(3), Some(ColorRangeMode::Skin));
        assert_eq!(ColorRangeMode::from_u32(4), None);
    }

    #[cfg(any(feature = "reference", feature = "cpu"))]
    #[test]
    #[allow(non_snake_case)]
    fn twin_follows_the_fitted_model__feat__image_selection_select_and_mask() {
        // Pure red is Lab (54.29, 80.81, 69.89).
        let lab = to_lab([1.0, 0.0, 0.0]);
        assert!((lab[0] - 54.29).abs() < 0.02 && (lab[1] - 80.81).abs() < 0.05);
        let red = ColorRangeParams::sampled_box(lab, lab, 40.0, false);
        assert!((color_range_px([1.0, 0.0, 0.0], [0.0, 0.0], &red) - 1.0).abs() < 1e-5);
        // Half way out (d = F/6) is exactly half selected.
        assert_eq!(color_range_px([0.0, 0.0, 1.0], [0.0, 0.0], &red), 0.0);
        let inv = ColorRangeParams::sampled_box(lab, lab, 40.0, true);
        assert_eq!(color_range_px([0.0, 0.0, 1.0], [0.0, 0.0], &inv), 1.0);
        // Reds: hue 0 at full chroma is 1; 30 degrees off is half.
        let reds = ColorRangeParams::hue(0.0, false);
        assert!((color_range_px([1.0, 0.0, 0.0], [0.0, 0.0], &reds) - 1.0).abs() < 1e-6);
        assert!((color_range_px([1.0, 0.5, 0.0], [0.0, 0.0], &reds) - 0.5).abs() < 1e-6);
        assert_eq!(color_range_px([0.5, 0.5, 0.5], [0.0, 0.0], &reds), 0.0);
        // Shadows (0…65, fuzziness 20%): luma 65 in, 65 + 19 (half the
        // 38-level width) half, 103 out.
        let sh = ColorRangeParams::tonal(0.0, 65.0, 0.2, false, false);
        let grey = |l: f32| [l / 255.0; 3];
        assert_eq!(color_range_px(grey(60.0), [0.0, 0.0], &sh), 1.0);
        assert!((color_range_px(grey(84.0), [0.0, 0.0], &sh) - 0.5).abs() < 1e-3);
        assert_eq!(color_range_px(grey(110.0), [0.0, 0.0], &sh), 0.0);
        // Skin: a typical skin tone in, saturated green out, black out.
        let sk = ColorRangeParams::skin(40.0, false);
        assert!(color_range_px([0.87, 0.67, 0.55], [0.0, 0.0], &sk) > 0.9);
        assert_eq!(color_range_px([0.0, 1.0, 0.0], [0.0, 0.0], &sk), 0.0);
        assert_eq!(color_range_px([0.0, 0.0, 0.0], [0.0, 0.0], &sk), 0.0);
        // Localized: the same colour far from the sample is not selected.
        let loc = ColorRangeParams::sampled(&[(lab, [0.5, 0.5])], 40.0, false, Some(10.0));
        assert_eq!(color_range_px([1.0, 0.0, 0.0], [0.5, 0.5], &loc), 1.0);
        assert_eq!(color_range_px([1.0, 0.0, 0.0], [50.5, 0.5], &loc), 0.0);
        let buf = color_range_rgba8(&[255, 0, 0, 255, 0, 0, 255, 255], 2, &red);
        assert_eq!(buf, vec![255, 0]);
    }
}

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

//! Colour encoding — preserve native spaces, don't collapse to
//! display (concept E3/E5):
//!
//! - `Paint::Cmyk{spot:None}` → ICCBased `/N 4` (working profile
//!   registered) else `DeviceCMYK`; channel numbers byte-equal
//!   under Preserve Numbers — pure 100%-K stays pure K.
//! - `Paint::Cmyk{spot:Some}` → `/Separation [/name alt tint]`
//!   with a Type-4 calculator tint transform; the Ink Manager's
//!   alias/convert-to-process settings collapse or bypass plates.
//! - `Paint::Solid` (source space lost at list level) → sRGB,
//!   ICCBased `/N 3` when an sRGB profile is supplied, else
//!   DeviceRGB. Linear→sRGB encode happens here (the list carries
//!   linear light).
//! - Gradients → `/Shading` type 2/3 with Type-3 stitching honouring
//!   midpoints (sRGB stops v1; native-space shadings = v2). A conic
//!   (sweep) gradient → a type-1 function shading over a Type-4
//!   calculator function of the angle (engine ADR 1007). A ramp whose
//!   stops are translucent paints its colour shading under a
//!   luminosity soft mask of the same geometry in DeviceGray, whose
//!   value is the stops' alpha ([`ShadeChannels::Alpha`]).
//! - Mesh shadings (engine ADR 1040) → a type-6 (Coons) or type-7
//!   (tensor-product) patch shading, its colours sRGB-encoded; a freeform
//!   gradient as the type-6 grid `FreeformShading::to_patches` samples
//!   from the evaluator the rasterisers draw; translucent colours under
//!   a luminosity soft mask of the same patches in DeviceGray.

use paged_compose::{Color, GradientStop, LinearGradient, Paint, RadialGradient, SpotInk};
use pdf_writer::{Content, Finish, Name, Ref};

use crate::writer::{DocState, PageResources};
use crate::{ExportInkSettings, ExportInput};

/// Linear-light → sRGB-encoded component.
pub fn linear_to_srgb(v: f32) -> f32 {
    let v = v.clamp(0.0, 1.0);
    if v <= 0.003_130_8 {
        12.92 * v
    } else {
        1.055 * v.powf(1.0 / 2.4) - 0.055
    }
}

fn srgb_of(c: Color) -> [f32; 3] {
    [
        linear_to_srgb(c.r),
        linear_to_srgb(c.g),
        linear_to_srgb(c.b),
    ]
}

/// Resolve the effective spot handling for a paint after the Ink
/// Manager settings: `None` ⇒ paint as plain process CMYK;
/// `Some(name)` ⇒ paint on the named separation plate.
fn effective_spot<'a>(
    spot: &'a SpotInk,
    inks: &'a ExportInkSettings,
    spot_table: &'a [SpotInk],
) -> Option<&'a SpotInk> {
    if inks.convert_to_process.contains(&spot.name) {
        return None;
    }
    if let Some((_, target)) = inks.aliases.iter().find(|(from, _)| *from == spot.name) {
        if let Some(t) = spot_table.iter().find(|s| s.name == *target) {
            return Some(t);
        }
    }
    Some(spot)
}

/// Emit fill-colour ops for `paint`. Returns true when the paint
/// could be set (gradient paints are handled by the caller through
/// shading patterns instead).
pub fn set_fill_paint(
    content: &mut Content,
    state: &mut DocState,
    resources: &mut PageResources,
    input: &ExportInput<'_>,
    list_spot_inks: &[SpotInk],
    paint: &Paint,
) -> bool {
    match paint {
        Paint::Solid(c) => {
            set_solid(content, state, resources, input, *c, false);
            true
        }
        Paint::Cmyk {
            c,
            m,
            y,
            k,
            spot,
            rgb: _,
        } => {
            let spot_ink = spot
                .and_then(|id| list_spot_inks.get(id.0 as usize))
                .and_then(|s| effective_spot(s, &input.inks, list_spot_inks));
            match spot_ink {
                Some(ink) => {
                    let cs_name = separation_space(state, resources, input, ink);
                    content.set_fill_color_space(pdf_writer::types::ColorSpaceOperand::Named(
                        Name(cs_name.as_bytes()),
                    ));
                    // Tint on a Separation plate: the ink coverage.
                    // The display channels already carry the tinted
                    // alternate; the plate value is the max channel
                    // ratio vs the full-strength alternate — for v1
                    // the paint's k-folded scale is captured by the
                    // dominant channel ratio. Full-strength = 1.0.
                    let t = separation_tint(ink, [*c, *m, *y, *k]);
                    content.set_fill_color([t]);
                }
                None => {
                    set_cmyk(content, state, resources, input, [*c, *m, *y, *k], false);
                }
            }
            true
        }
        Paint::LinearGradient(_) | Paint::RadialGradient(_) | Paint::SweepGradient(_) => false,
    }
}

/// Emit stroke-colour ops (the `SCN`/`CS` family).
pub fn set_stroke_paint(
    content: &mut Content,
    state: &mut DocState,
    resources: &mut PageResources,
    input: &ExportInput<'_>,
    list_spot_inks: &[SpotInk],
    paint: &Paint,
) -> bool {
    match paint {
        Paint::Solid(c) => {
            set_solid(content, state, resources, input, *c, true);
            true
        }
        Paint::Cmyk {
            c,
            m,
            y,
            k,
            spot,
            rgb: _,
        } => {
            let spot_ink = spot
                .and_then(|id| list_spot_inks.get(id.0 as usize))
                .and_then(|s| effective_spot(s, &input.inks, list_spot_inks));
            match spot_ink {
                Some(ink) => {
                    let cs_name = separation_space(state, resources, input, ink);
                    content.set_stroke_color_space(pdf_writer::types::ColorSpaceOperand::Named(
                        Name(cs_name.as_bytes()),
                    ));
                    let t = separation_tint(ink, [*c, *m, *y, *k]);
                    content.set_stroke_color([t]);
                }
                None => {
                    set_cmyk(content, state, resources, input, [*c, *m, *y, *k], true);
                }
            }
            true
        }
        Paint::LinearGradient(_) | Paint::RadialGradient(_) | Paint::SweepGradient(_) => false,
    }
}

fn set_solid(
    content: &mut Content,
    state: &mut DocState,
    resources: &mut PageResources,
    input: &ExportInput<'_>,
    c: Color,
    stroke: bool,
) {
    // The list carries linear light; encode to sRGB, then hand the
    // value to the CMM's export seam — under ConvertToDestination
    // it comes back as destination CMYK, under Preserve Numbers it
    // passes through and encodes as sRGB ICCBased.
    let rgb = srgb_of(c);
    match input
        .cmm
        .convert_for_export(paged_color::WorkingColor::Rgb(rgb))
    {
        paged_color::WorkingColor::Cmyk(out) => {
            let cmyk = [out.c / 100.0, out.m / 100.0, out.y / 100.0, out.k / 100.0];
            set_cmyk(content, state, resources, input, cmyk, stroke);
        }
        paged_color::WorkingColor::Gray(pct) => {
            // Defensive — the seam never returns Gray today.
            set_cmyk(
                content,
                state,
                resources,
                input,
                [0.0, 0.0, 0.0, pct / 100.0],
                stroke,
            );
        }
        // Rgb passthrough (and Lab, which cannot arise from an Rgb
        // input — encode its analytic sRGB if it ever does).
        wc => {
            let [r, g, b] = match wc {
                paged_color::WorkingColor::Rgb(rgb) => rgb,
                paged_color::WorkingColor::Lab { l, a, b } => {
                    paged_color::lab::lab_d50_to_srgb_encoded(l, a, b)
                }
                _ => unreachable!(),
            };
            match srgb_space(state, resources, input) {
                Some(name) => {
                    let operand =
                        pdf_writer::types::ColorSpaceOperand::Named(Name(name.as_bytes()));
                    if stroke {
                        content.set_stroke_color_space(operand);
                        content.set_stroke_color([r, g, b]);
                    } else {
                        content.set_fill_color_space(operand);
                        content.set_fill_color([r, g, b]);
                    }
                }
                None => {
                    if stroke {
                        content.set_stroke_rgb(r, g, b);
                    } else {
                        content.set_fill_rgb(r, g, b);
                    }
                }
            }
        }
    }
}

fn set_cmyk(
    content: &mut Content,
    state: &mut DocState,
    resources: &mut PageResources,
    input: &ExportInput<'_>,
    cmyk: [f32; 4],
    stroke: bool,
) {
    match cmyk_space(state, resources, input) {
        Some(name) => {
            let operand = pdf_writer::types::ColorSpaceOperand::Named(Name(name.as_bytes()));
            if stroke {
                content.set_stroke_color_space(operand);
                content.set_stroke_color(cmyk);
            } else {
                content.set_fill_color_space(operand);
                content.set_fill_color(cmyk);
            }
        }
        None if stroke => {
            content.set_stroke_cmyk(cmyk[0], cmyk[1], cmyk[2], cmyk[3]);
        }
        None => {
            content.set_fill_cmyk(cmyk[0], cmyk[1], cmyk[2], cmyk[3]);
        }
    }
}

/// The Separation tint for the painted channels: the display list
/// folded swatch tint into the CMYK alternate, so the plate value
/// is the ratio of the painted channels to the full-strength
/// alternate (max over channels for robustness; 1.0 when the
/// alternate is degenerate).
fn separation_tint(ink: &SpotInk, painted: [f32; 4]) -> f32 {
    let alt = ink.cmyk_alternate;
    let mut best = 0.0f32;
    let mut found = false;
    for i in 0..4 {
        let full = alt[i] as f32 / 255.0;
        if full > 1e-4 {
            best = best.max((painted[i] / full).clamp(0.0, 1.0));
            found = true;
        }
    }
    if found {
        best
    } else {
        1.0
    }
}

/// ICCBased /N 4 colour space for process CMYK (interned per page
/// + per document). `None` ⇒ caller uses DeviceCMYK operators.
fn cmyk_space(
    state: &mut DocState,
    resources: &mut PageResources,
    input: &ExportInput<'_>,
) -> Option<String> {
    let bytes = input.profiles.cmyk_working?;
    let icc_ref = match state.icc_refs.get("cmyk") {
        Some(r) => *r,
        None => {
            let stream_ref = state.refs.alloc();
            let mut s = state.pdf.icc_profile(stream_ref, bytes);
            s.n(4);
            s.finish();
            let array_ref = state.refs.alloc();
            let mut arr = state.pdf.indirect(array_ref).array();
            arr.item(Name(b"ICCBased"));
            arr.item(stream_ref);
            arr.finish();
            state.icc_refs.insert("cmyk", array_ref);
            array_ref
        }
    };
    Some(intern_space(resources, "CsCmyk", icc_ref))
}

/// ICCBased /N 3 sRGB space. `None` ⇒ DeviceRGB.
fn srgb_space(
    state: &mut DocState,
    resources: &mut PageResources,
    input: &ExportInput<'_>,
) -> Option<String> {
    let bytes = input.profiles.srgb?;
    let icc_ref = match state.icc_refs.get("srgb") {
        Some(r) => *r,
        None => {
            let stream_ref = state.refs.alloc();
            let mut s = state.pdf.icc_profile(stream_ref, bytes);
            s.n(3);
            s.finish();
            let array_ref = state.refs.alloc();
            let mut arr = state.pdf.indirect(array_ref).array();
            arr.item(Name(b"ICCBased"));
            arr.item(stream_ref);
            arr.finish();
            state.icc_refs.insert("srgb", array_ref);
            array_ref
        }
    };
    Some(intern_space(resources, "CsSrgb", icc_ref))
}

/// `/Separation [/InkName altSpace tintTransform]` — interned per
/// colorant. The tint transform is a Type-4 PostScript calculator
/// mapping t → t·alternate (linear toward paper white), evaluated
/// in DeviceCMYK.
fn separation_space(
    state: &mut DocState,
    resources: &mut PageResources,
    input: &ExportInput<'_>,
    ink: &SpotInk,
) -> String {
    // Human-readable colorant name: the palette's swatch Name when
    // resolvable (spot names ARE the colourant identity), else the
    // raw id.
    let colorant = input
        .palette
        .colors
        .get(&ink.name)
        .and_then(|c| c.name.clone())
        .unwrap_or_else(|| ink.name.clone());

    let cs_ref = match state.separation_pool.get(&colorant) {
        Some(r) => *r,
        None => {
            // Type-4 calculator: { dup c mul exch dup m mul exch
            //                      dup y mul exch k mul }
            let alt = ink.cmyk_alternate;
            let [c, m, y, k] = [
                alt[0] as f32 / 255.0,
                alt[1] as f32 / 255.0,
                alt[2] as f32 / 255.0,
                alt[3] as f32 / 255.0,
            ];
            let ps = format!(
                "{{ dup {c:.4} mul exch dup {m:.4} mul exch dup {y:.4} mul exch {k:.4} mul }}"
            );
            let fn_ref = state.refs.alloc();
            {
                let mut f = state.pdf.post_script_function(fn_ref, ps.as_bytes());
                f.domain([0.0, 1.0]);
                f.range([0.0, 1.0, 0.0, 1.0, 0.0, 1.0, 0.0, 1.0]);
                f.finish();
            }
            let cs_ref = state.refs.alloc();
            {
                let mut arr = state.pdf.indirect(cs_ref).array();
                arr.item(Name(b"Separation"));
                arr.item(Name(sanitize_name(&colorant).as_bytes()));
                arr.item(Name(b"DeviceCMYK"));
                arr.item(fn_ref);
                arr.finish();
            }
            state.separation_pool.insert(colorant.clone(), cs_ref);
            cs_ref
        }
    };
    intern_space(
        resources,
        &format!("CsSep{}", short_hash(&colorant)),
        cs_ref,
    )
}

/// `/Separation /All` for registration content (printer marks hit
/// every plate).
pub fn registration_all_space(state: &mut DocState, resources: &mut PageResources) -> String {
    let cs_ref = match state.separation_pool.get("\u{0}All") {
        Some(r) => *r,
        None => {
            let fn_ref = state.refs.alloc();
            {
                let mut f = state.pdf.post_script_function(fn_ref, b"{ dup dup dup }");
                f.domain([0.0, 1.0]);
                f.range([0.0, 1.0, 0.0, 1.0, 0.0, 1.0, 0.0, 1.0]);
                f.finish();
            }
            let cs_ref = state.refs.alloc();
            {
                let mut arr = state.pdf.indirect(cs_ref).array();
                arr.item(Name(b"Separation"));
                arr.item(Name(b"All"));
                arr.item(Name(b"DeviceCMYK"));
                arr.item(fn_ref);
                arr.finish();
            }
            state.separation_pool.insert("\u{0}All".into(), cs_ref);
            cs_ref
        }
    };
    intern_space(resources, "CsAll", cs_ref)
}

fn intern_space(resources: &mut PageResources, name: &str, r: Ref) -> String {
    resources.color_spaces.entry(name.to_string()).or_insert(r);
    name.to_string()
}

fn sanitize_name(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

fn short_hash(s: &str) -> u32 {
    // FNV-1a, deterministic.
    let mut h: u32 = 0x811c_9dc5;
    for b in s.as_bytes() {
        h ^= *b as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    h
}

/// Engine ADR 1007 — what a shading carries: the stops' colour
/// (DeviceRGB, sRGB-encoded) or their alpha (DeviceGray, for the
/// luminosity soft mask of a translucent ramp).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShadeChannels {
    Color,
    Alpha,
}

impl ShadeChannels {
    fn values(self, c: Color) -> Vec<f32> {
        match self {
            ShadeChannels::Color => srgb_of(c).to_vec(),
            ShadeChannels::Alpha => vec![c.a.clamp(0.0, 1.0)],
        }
    }

    fn range(self) -> &'static [f32] {
        match self {
            ShadeChannels::Color => &[0.0, 1.0, 0.0, 1.0, 0.0, 1.0],
            ShadeChannels::Alpha => &[0.0, 1.0],
        }
    }
}

/// Whether any stop of a ramp is less than opaque (engine ADR 1007).
pub fn stops_translucent(stops: &[GradientStop]) -> bool {
    stops.iter().any(|s| s.color.a < 0.999)
}

/// Write a `/Shading` dict (type 2 linear / type 3 radial) for a
/// gradient, with a Type-3 stitching function over the stops. v1
/// emits sRGB-encoded stops (DeviceRGB / ICCBased sRGB); native
/// CMYK/Lab shadings are the documented v2.
pub fn write_linear_shading(
    state: &mut DocState,
    input: &ExportInput<'_>,
    g: &LinearGradient,
    bbox: paged_compose::Rect,
) -> Ref {
    write_linear_shading_of(state, input, g, bbox, ShadeChannels::Color)
}

/// [`write_linear_shading`] carrying `channels`.
pub fn write_linear_shading_of(
    state: &mut DocState,
    input: &ExportInput<'_>,
    g: &LinearGradient,
    bbox: paged_compose::Rect,
    channels: ShadeChannels,
) -> Ref {
    let coords = [
        bbox.x + g.start.0 * bbox.w,
        bbox.y + g.start.1 * bbox.h,
        bbox.x + g.end.0 * bbox.w,
        bbox.y + g.end.1 * bbox.h,
    ];
    write_shading(
        state,
        input,
        &g.stops,
        ShadingGeometry::Axial(coords),
        channels,
    )
}

pub fn write_radial_shading(
    state: &mut DocState,
    input: &ExportInput<'_>,
    g: &RadialGradient,
    bbox: paged_compose::Rect,
) -> Ref {
    write_radial_shading_of(state, input, g, bbox, ShadeChannels::Color)
}

/// [`write_radial_shading`] carrying `channels`.
pub fn write_radial_shading_of(
    state: &mut DocState,
    input: &ExportInput<'_>,
    g: &RadialGradient,
    bbox: paged_compose::Rect,
    channels: ShadeChannels,
) -> Ref {
    let cx = bbox.x + g.center.0 * bbox.w;
    let cy = bbox.y + g.center.1 * bbox.h;
    let r = g.radius * bbox.w.max(bbox.h);
    write_shading(
        state,
        input,
        &g.stops,
        ShadingGeometry::Radial([cx, cy, 0.0, cx, cy, r]),
        channels,
    )
}

/// Engine ADR 1007 — a conic (sweep) gradient as a type-1 function
/// shading over `domain` (the painted area, in the current user space):
/// a Type-4 calculator function takes `(x, y)` to the angle about
/// `center` (PostScript `atan`, degrees, turning from +x toward +y —
/// clockwise in the display list's y-down page space, the sweep pool's
/// own convention), less `start_angle`, as the ramp's parameter `t`,
/// and evaluates the stops piecewise linearly at `t`. Same stops, same
/// geometry as the rasterisers' `peniko` sweep.
pub fn write_sweep_shading(
    state: &mut DocState,
    stops: &[GradientStop],
    center: (f32, f32),
    start_angle: f32,
    domain: paged_compose::Rect,
    channels: ShadeChannels,
) -> Ref {
    let mut sorted: Vec<&GradientStop> = stops.iter().collect();
    sorted.sort_by(|a, b| a.offset.total_cmp(&b.offset));
    let code = sweep_function_code(&sorted, center, start_angle, channels);
    let fn_ref = state.refs.alloc();
    let x0 = domain.x;
    let x1 = domain.x + domain.w.max(1e-3);
    let y0 = domain.y;
    let y1 = domain.y + domain.h.max(1e-3);
    {
        let mut f = state.pdf.post_script_function(fn_ref, code.as_bytes());
        f.domain([x0, x1, y0, y1]);
        f.range(channels.range().iter().copied());
        f.finish();
    }
    let shading_ref = state.refs.alloc();
    let mut sh = state.pdf.function_shading(shading_ref);
    sh.shading_type(pdf_writer::types::FunctionShadingType::Function);
    match channels {
        ShadeChannels::Color => sh.color_space().device_rgb(),
        ShadeChannels::Alpha => sh.color_space().device_gray(),
    };
    sh.domain([x0, x1, y0, y1]);
    sh.function(fn_ref);
    sh.finish();
    shading_ref
}

/// The calculator function of [`write_sweep_shading`].
pub(crate) fn sweep_function_code(
    sorted: &[&GradientStop],
    center: (f32, f32),
    start_angle: f32,
    channels: ShadeChannels,
) -> String {
    let n = |v: f32| {
        let s = format!("{v:.5}");
        let s = s.trim_end_matches('0').trim_end_matches('.').to_string();
        if s == "-0" || s.is_empty() {
            "0".to_string()
        } else {
            s
        }
    };
    let start_deg = start_angle.to_degrees().rem_euclid(360.0);
    // (x y) → t in [0, 1).
    let mut code = format!(
        "{{ {} sub exch {} sub atan {} sub dup 0 lt {{ 360 add }} if 360 div ",
        n(center.1),
        n(center.0),
        n(start_deg)
    );
    let push_const = |c: Color| -> String {
        let v = channels.values(c);
        let mut s = String::from("pop");
        for x in v {
            s.push(' ');
            s.push_str(&n(x));
        }
        s
    };
    if sorted.is_empty() {
        code.push_str(&push_const(Color::BLACK));
        code.push_str(" }");
        return code;
    }
    // Nested `ifelse`: below the first stop its colour, each segment's
    // linear blend, past the last stop its colour.
    let mut tail = push_const(sorted[sorted.len() - 1].color);
    for i in (0..sorted.len().saturating_sub(1)).rev() {
        let (a, b) = (sorted[i], sorted[i + 1]);
        let span = b.offset - a.offset;
        let seg = if span <= 1e-6 {
            push_const(b.color)
        } else {
            let (ca, cb) = (channels.values(a.color), channels.values(b.color));
            let mut s = format!("{} sub {} mul", n(a.offset), n(1.0 / span));
            let k = ca.len();
            for (j, (va, vb)) in ca.iter().zip(&cb).enumerate() {
                let d = vb - va;
                if j + 1 < k {
                    s.push_str(&format!(" dup {} mul {} add exch", n(d), n(*va)));
                } else {
                    s.push_str(&format!(" {} mul {} add", n(d), n(*va)));
                }
            }
            s
        };
        tail = format!("dup {} le {{ {seg} }} {{ {tail} }} ifelse", n(b.offset));
    }
    let first = push_const(sorted[0].color);
    code.push_str(&format!(
        "dup {} le {{ {first} }} {{ {tail} }} ifelse }}",
        n(sorted[0].offset)
    ));
    code
}

fn shade_space(sh: &mut pdf_writer::writers::FunctionShading<'_>, channels: ShadeChannels) {
    match channels {
        ShadeChannels::Color => sh.color_space().device_rgb(),
        ShadeChannels::Alpha => sh.color_space().device_gray(),
    };
}

enum ShadingGeometry {
    Axial([f32; 4]),
    Radial([f32; 6]),
}

fn write_shading(
    state: &mut DocState,
    _input: &ExportInput<'_>,
    stops: &[paged_compose::GradientStop],
    geometry: ShadingGeometry,
    channels: ShadeChannels,
) -> Ref {
    // Build the colour function: a single Type-2 for two stops, a
    // Type-3 stitch otherwise. Stops are sRGB-encoded here.
    let mut sorted: Vec<&paged_compose::GradientStop> = stops.iter().collect();
    sorted.sort_by(|a, b| {
        a.offset
            .partial_cmp(&b.offset)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let fn_ref = state.refs.alloc();
    if sorted.len() <= 1 {
        let c = channels.values(sorted.first().map(|s| s.color).unwrap_or(Color::BLACK));
        let mut f = state.pdf.exponential_function(fn_ref);
        f.domain([0.0, 1.0]);
        f.range(channels.range().iter().copied());
        f.c0(c.iter().copied());
        f.c1(c.iter().copied());
        f.n(1.0);
        f.finish();
    } else if sorted.len() == 2 {
        let mut f = state.pdf.exponential_function(fn_ref);
        f.domain([0.0, 1.0]);
        f.range(channels.range().iter().copied());
        f.c0(channels.values(sorted[0].color));
        f.c1(channels.values(sorted[1].color));
        f.n(1.0);
        f.finish();
    } else {
        // Type-3 stitching over Type-2 segments.
        let mut seg_refs = Vec::new();
        for pair in sorted.windows(2) {
            let seg_ref = state.refs.alloc();
            let mut f = state.pdf.exponential_function(seg_ref);
            f.domain([0.0, 1.0]);
            f.range(channels.range().iter().copied());
            f.c0(channels.values(pair[0].color));
            f.c1(channels.values(pair[1].color));
            f.n(1.0);
            f.finish();
            seg_refs.push(seg_ref);
        }
        let mut f = state.pdf.stitching_function(fn_ref);
        f.domain([0.0, 1.0]);
        f.range(channels.range().iter().copied());
        f.functions(seg_refs.iter().copied());
        let bounds: Vec<f32> = sorted[1..sorted.len() - 1]
            .iter()
            .map(|s| s.offset)
            .collect();
        f.bounds(bounds.iter().copied());
        let encode: Vec<f32> = seg_refs.iter().flat_map(|_| [0.0, 1.0]).collect();
        f.encode(encode.iter().copied());
        f.finish();
    }

    let shading_ref = state.refs.alloc();
    let mut sh = state.pdf.function_shading(shading_ref);
    match geometry {
        ShadingGeometry::Axial(coords) => {
            sh.shading_type(pdf_writer::types::FunctionShadingType::Axial);
            shade_space(&mut sh, channels);
            sh.coords(coords);
        }
        ShadingGeometry::Radial(coords) => {
            sh.shading_type(pdf_writer::types::FunctionShadingType::Radial);
            shade_space(&mut sh, channels);
            sh.coords(coords);
        }
    }
    sh.function(fn_ref);
    sh.extend([true, true]);
    sh.finish();
    shading_ref
}

/// How many patches a freeform gradient's type-6 grid has along each
/// side (engine ADR 1040).
pub const FREEFORM_PDF_GRID: usize = 32;

/// Engine ADR 1040 — a mesh shading as a PDF patch shading in the
/// shading's own (local) space: type 7 when any patch has its own
/// interior points, type 6 otherwise. `None` when it paints nothing.
pub fn write_mesh_shading(
    state: &mut DocState,
    mesh: &paged_compose::MeshShading,
    channels: ShadeChannels,
) -> Option<Ref> {
    use paged_compose::MeshKind;
    let owned;
    let patches: &[paged_compose::ShadePatch] = match &mesh.kind {
        MeshKind::Patches(p) => p,
        MeshKind::Freeform(f) => {
            owned = f.to_patches(FREEFORM_PDF_GRID);
            &owned
        }
    };
    if patches.is_empty() {
        return None;
    }
    let tensor = patches.iter().any(|p| p.tensor);
    let (mut x0, mut y0, mut x1, mut y1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
    for p in patches {
        for &(x, y) in p.points.iter().flatten() {
            if x.is_finite() && y.is_finite() {
                x0 = x0.min(x);
                y0 = y0.min(y);
                x1 = x1.max(x);
                y1 = y1.max(y);
            }
        }
    }
    if x0 > x1 || y0 > y1 {
        return None;
    }
    // A degenerate side still needs a non-empty decode range.
    let (x1, y1) = (x1.max(x0 + 1e-3), y1.max(y0 + 1e-3));
    let data = mesh_stream(patches, tensor, [x0, x1, y0, y1], channels);
    let compressed = {
        use std::io::Write as _;
        let mut enc = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        let _ = enc.write_all(&data);
        enc.finish().unwrap_or_default()
    };
    let r = state.refs.alloc();
    let mut sh = state.pdf.stream_shading(r, &compressed);
    sh.filter(pdf_writer::Filter::FlateDecode);
    sh.shading_type(if tensor {
        pdf_writer::writers::StreamShadingType::TensorProductPatch
    } else {
        pdf_writer::writers::StreamShadingType::CoonsPatch
    });
    match channels {
        ShadeChannels::Color => sh.color_space().device_rgb(),
        ShadeChannels::Alpha => sh.color_space().device_gray(),
    };
    sh.bits_per_coordinate(32);
    sh.bits_per_component(16);
    sh.bits_per_flag(8);
    sh.anti_alias(true);
    let mut decode = vec![x0, x1, y0, y1];
    decode.extend_from_slice(channels.range());
    sh.decode(decode);
    sh.finish();
    Some(r)
}

/// The packed patch data of [`write_mesh_shading`]: per patch a flag
/// byte (0, a free patch), the control points as 32-bit fractions of
/// `decode`'s box — `p00 p01 p02 p03 p13 p23 p33 p32 p31 p30 p20 p10`,
/// then `p11 p12 p22 p21` for type 7 — and the colours of `p00 p03 p33
/// p30` as 16-bit components.
pub(crate) fn mesh_stream(
    patches: &[paged_compose::ShadePatch],
    tensor: bool,
    decode: [f32; 4],
    channels: ShadeChannels,
) -> Vec<u8> {
    const ORDER: [(usize, usize); 16] = [
        (0, 0),
        (0, 1),
        (0, 2),
        (0, 3),
        (1, 3),
        (2, 3),
        (3, 3),
        (3, 2),
        (3, 1),
        (3, 0),
        (2, 0),
        (1, 0),
        (1, 1),
        (1, 2),
        (2, 2),
        (2, 1),
    ];
    let [x0, x1, y0, y1] = decode;
    let q32 = |v: f32, lo: f32, hi: f32| -> u32 {
        let t = (f64::from(v) - f64::from(lo)) / (f64::from(hi) - f64::from(lo));
        (t.clamp(0.0, 1.0) * f64::from(u32::MAX)).round() as u32
    };
    let q16 = |v: f32| -> u16 { (v.clamp(0.0, 1.0) * 65535.0).round() as u16 };
    let points = if tensor { 16 } else { 12 };
    let mut out = Vec::with_capacity(patches.len() * (1 + points * 8 + 4 * 6));
    for p in patches {
        out.push(0u8);
        let net = if tensor && !p.tensor {
            paged_compose::mesh::coons_points(p)
        } else {
            p.points
        };
        for &(i, j) in &ORDER[..points] {
            let (x, y) = net[i][j];
            out.extend_from_slice(&q32(x, x0, x1).to_be_bytes());
            out.extend_from_slice(&q32(y, y0, y1).to_be_bytes());
        }
        for c in [p.colors[0], p.colors[1], p.colors[3], p.colors[2]] {
            for v in channels.values(c) {
                out.extend_from_slice(&q16(v).to_be_bytes());
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ink(alt: [u8; 4]) -> SpotInk {
        SpotInk {
            name: "Color/test".into(),
            cmyk_alternate: alt,
        }
    }

    #[test]
    fn separation_tint_endpoints() {
        // Full-strength paint over a full-strength alternate = 1.0.
        let pantone = ink([255, 191, 0, 0]);
        let full = separation_tint(&pantone, [1.0, 0.75, 0.0, 0.0]);
        assert!((full - 1.0).abs() < 1e-4, "full = {full}");
        // Paper (no ink painted) = 0.0.
        let none = separation_tint(&pantone, [0.0, 0.0, 0.0, 0.0]);
        assert!(none.abs() < 1e-4, "none = {none}");
        // 50% swatch tint — channels at half the alternate.
        let half = separation_tint(&pantone, [0.5, 0.375, 0.0, 0.0]);
        assert!((half - 0.5).abs() < 1e-2, "half = {half}");
        // Degenerate alternate (registration-ish): tint pins to 1.
        let degenerate = ink([0, 0, 0, 0]);
        assert!((separation_tint(&degenerate, [0.2, 0.0, 0.0, 0.0]) - 1.0).abs() < 1e-4);
    }

    #[test]
    fn separation_colorant_names_sanitise() {
        assert_eq!(sanitize_name("PANTONE 286 C"), "PANTONE-286-C");
        assert_eq!(sanitize_name("Größe/50%"), "Gr--e-50-");
    }

    #[test]
    fn linear_srgb_round_trip_endpoints() {
        assert_eq!(linear_to_srgb(0.0), 0.0);
        assert!((linear_to_srgb(1.0) - 1.0).abs() < 1e-6);
        // The 0.5-linear grey encodes to ~0.7354 sRGB.
        assert!((linear_to_srgb(0.5) - 0.7354).abs() < 1e-3);
    }
}

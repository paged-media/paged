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

//! Paints: solid colours, and shadings as native ramps, native meshes or
//! sampled images.

use hayro_interpret::color::{Color, ColorComponents};
use hayro_interpret::pattern::ShadingPattern;
use hayro_interpret::shading::{ShadingFunction, ShadingType};
use kurbo::{Affine, Point, Rect, Vec2};

use super::encode;
use super::ir::{ImageItem, MeshPatchIr, Paint, Stop};
use super::ReadOptions;

/// A solid colour, sRGB, with its alpha as the paint's opacity.
pub(super) fn solid(c: &Color) -> Paint {
    let [r, g, b, a] = c.to_rgba().components();
    Paint::Solid {
        rgb: [r, g, b],
        opacity: a,
    }
}

/// What a shading becomes.
pub(super) enum Shaded {
    /// A native ramp, with the losses its mapping took.
    Native(Paint, Vec<&'static str>),
    /// Sampled over the region, with why.
    Sampled(ImageItem, &'static str),
    /// Nothing to draw (a shading with no area, or one hayro cannot read).
    Nothing,
}

/// How many points a ramp is sampled at before it is simplified.
const RAMP_SAMPLES: usize = 64;
/// The largest channel error (0..1) a dropped stop may leave. The samples
/// arrive quantised to 8 bits, so a straight ramp wobbles by up to one
/// step around its line.
const RAMP_TOLERANCE: f32 = 1.5 / 255.0;

/// `sp` over `region` (device space): an axial shading as a linear ramp, a
/// radial one whose circles share a centre as a radial ramp, and anything
/// else sampled to an image over `region`.
pub(super) fn shading(sp: &ShadingPattern, region: Rect, opts: &ReadOptions) -> Shaded {
    if region.width() <= 0.0 || region.height() <= 0.0 {
        return Shaded::Nothing;
    }
    match sp.shading.shading_type.as_ref() {
        ShadingType::RadialAxial {
            coords,
            extend,
            axial: true,
            ..
        } => {
            let enc = sp.encode();
            match linear(sp, &enc, *coords, *extend, region) {
                Some(n) => n,
                None => sampled(&enc, region, opts, "shading.degenerate"),
            }
        }
        ShadingType::RadialAxial {
            coords,
            extend,
            axial: false,
            ..
        } => radial(sp, &sp.encode(), *coords, *extend, region, opts),
        ShadingType::Dummy => Shaded::Nothing,
        ShadingType::FunctionBased { .. } => {
            sampled(&sp.encode(), region, opts, "shading.function_sampled")
        }
        ShadingType::CoonsPatchMesh { .. }
        | ShadingType::TensorProductPatchMesh { .. }
        | ShadingType::TriangleMesh { .. } => match mesh(sp) {
            Ok(Some(shaded)) => shaded,
            Ok(None) => Shaded::Nothing,
            Err(why) => sampled(&sp.encode(), region, opts, why),
        },
    }
}

/// The most patches one shading maps to a native mesh. Past it the
/// shading is sampled (`shading.mesh_too_large`): a triangle mesh of tens
/// of thousands of triangles is a raster in all but name, and each of its
/// patches would be a grid of its own in the document.
pub const MAX_MESH_PATCHES: usize = 4096;

/// The largest channel error (0..1) a mesh shading's colour function may
/// show against the corner colours' bilinear blend before the mapping
/// reports it: the native mesh blends colours, the PDF blends the
/// function's input and maps it.
const MESH_FUNCTION_TOLERANCE: f32 = 2.5 / 255.0;

/// The PDF's stream order of a patch's control points (ISO 32000-1,
/// 8.7.4.5.7): the twelve edge points `p00 p01 p02 p03 p13 p23 p33 p32
/// p31 p30 p20 p10`, then a tensor patch's interior `p11 p12 p22 p21`,
/// as `(row, column)` of [`MeshPatchIr::points`]. It is the order the
/// engine's PDF export writes (`paged-export-pdf`'s `mesh_stream`), so a
/// mesh the engine wrote reads back as the patches it had.
const PATCH_ORDER: [(usize, usize); 16] = [
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

/// A patch as hayro reads it, before its colours are converted: its
/// control points in the shading's space, its corner colours in the
/// shading's colour space (or the function's input) as `[c00, c03, c30,
/// c33]`.
struct RawPatch<'a> {
    points: [[Point; 4]; 4],
    colors: [&'a ColorComponents; 4],
    tensor: bool,
}

/// The points of a patch from its control points in stream order.
fn net(cp: &[Point]) -> [[Point; 4]; 4] {
    let mut p = [[Point::ZERO; 4]; 4];
    for (k, &(i, j)) in PATCH_ORDER.iter().enumerate().take(cp.len()) {
        p[i][j] = cp[k];
    }
    if cp.len() < 16 {
        // A Coons patch: its interior is its edges' (ISO 32000-1,
        // 8.7.4.5.8), so that a reader that takes the sixteen points as
        // a tensor patch paints the same surface.
        let f = |q: Point| [q.x as f32, q.y as f32];
        let edges = p.map(|row| row.map(f));
        let inner = paged_model::mesh::coons_interior(&edges);
        let g = |v: [f32; 2]| Point::new(v[0] as f64, v[1] as f64);
        p[1][1] = g(inner[0]);
        p[1][2] = g(inner[1]);
        p[2][1] = g(inner[2]);
        p[2][2] = g(inner[3]);
    }
    p
}

/// A triangle `a b c` as a Coons patch whose last edge has collapsed into
/// `c`: rows run from the edge `a → b` to the point `c`, every edge
/// straight. Its surface is the bilinear patch of the corners `a b c c`,
/// whose weights at any point are that point's barycentric coordinates;
/// the colours blend with the same weights, so the patch paints the
/// triangle's Gouraud shading exactly (ISO 32000-1, 8.7.4.5.5).
fn triangle_net(a: Point, b: Point, c: Point) -> [[Point; 4]; 4] {
    let mut p = [[Point::ZERO; 4]; 4];
    for (i, row) in p.iter_mut().enumerate() {
        let v = i as f64 / 3.0;
        let l = a.lerp(c, v);
        let r = b.lerp(c, v);
        for (j, q) in row.iter_mut().enumerate() {
            *q = l.lerp(r, j as f64 / 3.0);
        }
    }
    p
}

/// A patch or triangle mesh shading (types 4–7) as a native mesh: the
/// patches mapped into device space, the colours converted to sRGB.
/// `Ok(None)`: it paints nothing. `Err`: it is sampled instead, and why.
fn mesh(sp: &ShadingPattern) -> Result<Option<Shaded>, &'static str> {
    let (raw, function): (Vec<RawPatch<'_>>, Option<&ShadingFunction>) =
        match sp.shading.shading_type.as_ref() {
            ShadingType::CoonsPatchMesh { patches, function } => (
                patches
                    .iter()
                    .map(|p| RawPatch {
                        points: net(&p.control_points),
                        colors: [&p.colors[0], &p.colors[1], &p.colors[3], &p.colors[2]],
                        tensor: false,
                    })
                    .collect(),
                function.as_ref(),
            ),
            ShadingType::TensorProductPatchMesh { patches, function } => (
                patches
                    .iter()
                    .map(|p| RawPatch {
                        points: net(&p.control_points),
                        colors: [&p.colors[0], &p.colors[1], &p.colors[3], &p.colors[2]],
                        tensor: true,
                    })
                    .collect(),
                function.as_ref(),
            ),
            ShadingType::TriangleMesh {
                triangles,
                function,
            } => (
                triangles
                    .iter()
                    .map(|t| RawPatch {
                        points: triangle_net(t.p0.point, t.p1.point, t.p2.point),
                        colors: [&t.p0.colors, &t.p1.colors, &t.p2.colors, &t.p2.colors],
                        tensor: false,
                    })
                    .collect(),
                function.as_ref(),
            ),
            _ => return Err("shading.mesh_sampled"),
        };
    if raw.is_empty() {
        return Ok(None);
    }
    if raw.len() > MAX_MESH_PATCHES {
        return Err("shading.mesh_too_large");
    }
    let space = &sp.shading.color_space;
    let rgb = |c: &ColorComponents| -> Option<[f32; 3]> {
        let comps = match function {
            Some(f) => f.eval(c)?,
            None => c.clone(),
        };
        let [r, g, b, _] = space.to_rgba(&comps, 1.0).components();
        [r, g, b].iter().all(|v| v.is_finite()).then_some([r, g, b])
    };
    let mut losses = Vec::new();
    let mut nonlinear = false;
    let mut patches = Vec::with_capacity(raw.len());
    for p in &raw {
        let mut colors = [[0.0f32; 3]; 4];
        for (k, c) in p.colors.iter().enumerate() {
            colors[k] = rgb(c).ok_or("shading.mesh_sampled")?;
        }
        if let (Some(_), false) = (function, nonlinear) {
            nonlinear = !function_is_linear(p.colors, &colors, &rgb);
        }
        let mut points = [[[0.0f32; 2]; 4]; 4];
        for (i, row) in p.points.iter().enumerate() {
            for (j, q) in row.iter().enumerate() {
                let d = sp.matrix * *q;
                if !(d.x.is_finite() && d.y.is_finite()) {
                    return Err("shading.mesh_sampled");
                }
                points[i][j] = [d.x as f32, d.y as f32];
            }
        }
        patches.push(MeshPatchIr {
            points,
            colors,
            tensor: p.tensor,
        });
    }
    if nonlinear {
        losses.push("shading.mesh_function");
    }
    if sp.shading.background.is_some() {
        losses.push("shading.mesh_background");
    }
    Ok(Some(Shaded::Native(
        Paint::Mesh {
            patches,
            opacity: sp.opacity,
        },
        losses,
    )))
}

/// Whether a patch's colour function maps its input linearly enough that
/// blending the mapped corner colours (the native mesh) paints what
/// blending the input and then mapping it (the PDF) paints: checked at
/// the middle of each edge and at the centre.
fn function_is_linear(
    input: [&ColorComponents; 4],
    corners: &[[f32; 3]; 4],
    rgb: &impl Fn(&ColorComponents) -> Option<[f32; 3]>,
) -> bool {
    // (weights of c00, c03, c30, c33)
    const AT: [[f32; 4]; 5] = [
        [0.5, 0.5, 0.0, 0.0],
        [0.0, 0.0, 0.5, 0.5],
        [0.5, 0.0, 0.5, 0.0],
        [0.0, 0.5, 0.0, 0.5],
        [0.25, 0.25, 0.25, 0.25],
    ];
    AT.iter().all(|w| {
        let n = input[0].len();
        let mut t = ColorComponents::new();
        for k in 0..n {
            t.push(
                (0..4)
                    .map(|c| w[c] * input[c].get(k).copied().unwrap_or(0.0))
                    .sum(),
            );
        }
        let Some(mapped) = rgb(&t) else {
            return false;
        };
        (0..3).all(|ch| {
            let blend: f32 = (0..4).map(|c| w[c] * corners[c][ch]).sum();
            (blend - mapped[ch]).abs() <= MESH_FUNCTION_TOLERANCE
        })
    })
}

fn pt(p: Point) -> [f32; 2] {
    [p.x as f32, p.y as f32]
}

fn linear(
    sp: &ShadingPattern,
    enc: &hayro_interpret::encode::EncodedShadingPattern,
    coords: [f32; 6],
    extend: [bool; 2],
    region: Rect,
) -> Option<Shaded> {
    let [x0, y0, x1, y1, ..] = coords;
    let d = Vec2::new((x1 - x0) as f64, (y1 - y0) as f64);
    let dd = d.hypot2();
    if dd < 1e-12 {
        return None;
    }
    // t(x) = ((M⁻¹x − p0)·d) / |d|² is affine in device x: its gradient is
    // g = M⁻ᵀd / |d|², so the ramp runs along g from M·p0 for 1/|g|.
    let m = sp.matrix;
    let inv = m.inverse();
    let c = inv.as_coeffs();
    let g = Vec2::new(c[0] * d.x + c[1] * d.y, c[2] * d.x + c[3] * d.y) / dd;
    let gg = g.hypot2();
    if gg.is_nan() || gg <= 1e-18 || !gg.is_finite() {
        return None;
    }
    let start = m * Point::new(x0 as f64, y0 as f64);
    let end = start + g / gg;
    let mut losses = Vec::new();
    if shows_unextended(start, end, extend, region) {
        losses.push("shading.no_extend");
    }
    // `sample` reads the shading's own space: map the device point in.
    let stops = ramp(|u| enc.sample(enc.base_transform * (start + (end - start) * u as f64)));
    Some(Shaded::Native(
        Paint::Linear {
            start: pt(start),
            end: pt(end),
            stops,
            opacity: sp.opacity,
            extend,
        },
        losses,
    ))
}

/// Does `region` reach past a ramp end the PDF does not extend? A native
/// ramp pads both ends, so that part paints where the PDF painted nothing.
fn shows_unextended(start: Point, end: Point, extend: [bool; 2], region: Rect) -> bool {
    let axis = end - start;
    let len2 = axis.hypot2();
    if len2 <= 0.0 {
        return false;
    }
    let us = [
        Point::new(region.x0, region.y0),
        Point::new(region.x1, region.y0),
        Point::new(region.x0, region.y1),
        Point::new(region.x1, region.y1),
    ]
    .map(|p| (p - start).dot(axis) / len2);
    let lo = us.iter().copied().fold(f64::INFINITY, f64::min);
    let hi = us.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    (!extend[0] && lo < -1e-3) || (!extend[1] && hi > 1.0 + 1e-3)
}

/// The uniform scale of `m`'s linear part, or `None` when it is not a
/// similarity (it shears or scales unevenly).
fn similarity_scale(m: Affine) -> Option<f64> {
    let [a, b, c, d, ..] = m.as_coeffs();
    let sx = a.hypot(b);
    let sy = c.hypot(d);
    let dot = a * c + b * d;
    let tol = 1e-4 * sx.max(sy).max(1e-9);
    ((sx - sy).abs() <= tol && dot.abs() <= tol * sx.max(sy)).then_some(sx)
}

fn radial(
    sp: &ShadingPattern,
    enc: &hayro_interpret::encode::EncodedShadingPattern,
    coords: [f32; 6],
    extend: [bool; 2],
    region: Rect,
    opts: &ReadOptions,
) -> Shaded {
    let [x0, y0, r0, x1, y1, r1] = coords.map(|v| v as f64);
    let Some(s) = similarity_scale(sp.matrix) else {
        return sampled(enc, region, opts, "shading.skewed_sampled");
    };
    let rmax = r0.max(r1);
    if rmax <= 0.0 || (r1 - r0).abs() < 1e-9 {
        return sampled(enc, region, opts, "shading.degenerate");
    }
    if (x1 - x0).hypot(y1 - y0) > 1e-4 * rmax {
        // Two centres: Illustrator's radial with a moved highlight. One
        // circle cannot say it, so it is sampled.
        return sampled(enc, region, opts, "shading.focal_sampled");
    }
    let center = sp.matrix * Point::new(x1, y1);
    let radius = s * rmax;
    // Sample along one radius of the device circle; the native ramp is
    // 0 at the centre and 1 at `radius`.
    let dir = Vec2::new(1.0, 0.0);
    // `extend` is indexed by circle: [0] the r0 circle, [1] the r1 one.
    let (inner_end, outer_end) = if r0 <= r1 { (0, 1) } else { (1, 0) };
    let inner = s * r0.min(r1);
    let reach = [
        Point::new(region.x0, region.y0),
        Point::new(region.x1, region.y0),
        Point::new(region.x0, region.y1),
        Point::new(region.x1, region.y1),
    ]
    .iter()
    .map(|p| (*p - center).hypot())
    .fold(0.0, f64::max);
    let mut losses = Vec::new();
    // Inside the inner circle and past the outer one the PDF paints only
    // where it extends; a native ramp pads both.
    if (inner > 1e-6 && !extend[inner_end]) || (!extend[outer_end] && reach > radius * (1.0 + 1e-3))
    {
        losses.push("shading.no_extend");
    }
    let stops = ramp(|u| enc.sample(enc.base_transform * (center + dir * (u as f64 * radius))));
    Shaded::Native(
        Paint::Radial {
            center: pt(center),
            radius: radius as f32,
            stops,
            opacity: sp.opacity,
            extend,
        },
        losses,
    )
}

/// Sample a ramp at [`RAMP_SAMPLES`] offsets and keep the stops a linear
/// interpolation cannot recover within [`RAMP_TOLERANCE`]. A sample the
/// shading paints nothing at (outside an unextended end) takes its
/// nearest painted neighbour's colour.
fn ramp(sample: impl Fn(f32) -> [f32; 4]) -> Vec<Stop> {
    let n = RAMP_SAMPLES;
    let raw: Vec<(f32, Option<[f32; 3]>)> = (0..=n)
        .map(|i| {
            let u = i as f32 / n as f32;
            let [r, g, b, a] = sample(u);
            (u, (a > 1e-4).then_some([r, g, b]))
        })
        .collect();
    let mut filled: Vec<(f32, [f32; 3])> = Vec::with_capacity(raw.len());
    let first = raw.iter().find_map(|(_, c)| *c).unwrap_or([0.0; 3]);
    let mut last = first;
    for (u, c) in &raw {
        if let Some(c) = c {
            last = *c;
        }
        filled.push((*u, c.unwrap_or(last)));
    }
    // Leading gaps took `first`; trailing ones the last painted colour.
    let mut keep = vec![filled[0]];
    let mut i = 0;
    while i < filled.len() - 1 {
        // Extend the segment from `i` as far as every sample in between
        // stays on the line.
        let mut j = i + 1;
        while j + 1 < filled.len() && on_line(&filled[i..=j + 1]) {
            j += 1;
        }
        keep.push(filled[j]);
        i = j;
    }
    keep.into_iter()
        .map(|(offset, rgb)| Stop { offset, rgb })
        .collect()
}

/// Every interior sample of `seg` lies on the line from its first to its
/// last within tolerance.
fn on_line(seg: &[(f32, [f32; 3])]) -> bool {
    let (u0, c0) = seg[0];
    let (u1, c1) = seg[seg.len() - 1];
    let span = u1 - u0;
    seg[1..seg.len() - 1].iter().all(|(u, c)| {
        let t = if span > 0.0 { (u - u0) / span } else { 0.0 };
        (0..3).all(|k| (c0[k] + (c1[k] - c0[k]) * t - c[k]).abs() <= RAMP_TOLERANCE)
    })
}

/// `enc` sampled over `region` at the read's resolution (lowered to fit
/// the pixel cap) as an image the region's clip will hold.
pub(super) fn sampled(
    enc: &hayro_interpret::encode::EncodedShadingPattern,
    region: Rect,
    opts: &ReadOptions,
    why: &'static str,
) -> Shaded {
    let mut scale = (opts.sample_ppi / 72.0).max(0.05);
    let area = region.width() * region.height();
    let cap = opts.max_sample_pixels.max(1) as f64;
    if area * (scale as f64).powi(2) > cap {
        scale = (cap / area).sqrt() as f32;
    }
    let tex = enc.render_texture(region, scale);
    let Some(png) = encode::png(tex.width, tex.height, &tex.data) else {
        return Shaded::Nothing;
    };
    let unit = tex.transform * Affine::scale_non_uniform(tex.width as f64, tex.height as f64);
    Shaded::Sampled(
        ImageItem {
            transform: unit.as_coeffs().map(|v| v as f32),
            width_px: tex.width,
            height_px: tex.height,
            data_b64: encode::b64(&png),
            mime: "image/png",
            opacity: 1.0,
            blend: None,
        },
        why,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_two_colour_ramp_keeps_its_two_stops() {
        let stops = ramp(|u| [u, 0.0, 1.0 - u, 1.0]);
        assert_eq!(stops.len(), 2, "{stops:?}");
        assert_eq!(stops[0].offset, 0.0);
        assert_eq!(stops[1].offset, 1.0);
        assert_eq!(stops[1].rgb, [1.0, 0.0, 0.0]);
    }

    #[test]
    fn a_three_colour_ramp_keeps_its_middle() {
        let stops = ramp(|u| {
            let v = if u < 0.5 { u * 2.0 } else { 2.0 - u * 2.0 };
            [v, v, v, 1.0]
        });
        assert_eq!(stops.len(), 3, "{stops:?}");
        assert!((stops[1].offset - 0.5).abs() < 1e-6);
        assert!((stops[1].rgb[0] - 1.0).abs() < 1e-6);
    }

    #[test]
    fn an_unpainted_end_takes_its_neighbour() {
        let stops = ramp(|u| {
            if u < 0.25 {
                [0.0; 4]
            } else {
                [1.0, 0.0, 0.0, 1.0]
            }
        });
        assert!(stops.iter().all(|s| s.rgb == [1.0, 0.0, 0.0]), "{stops:?}");
    }

    #[test]
    fn a_similarity_has_one_scale() {
        assert_eq!(similarity_scale(Affine::scale(2.0)), Some(2.0));
        assert!(similarity_scale(Affine::rotate(0.7) * Affine::scale(3.0))
            .is_some_and(|s| (s - 3.0).abs() < 1e-9));
        assert_eq!(similarity_scale(Affine::scale_non_uniform(1.0, 2.0)), None);
        assert_eq!(similarity_scale(Affine::skew(0.3, 0.0)), None);
    }
}

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

//! Engine ADR 1048 — mesh shadings: the gradient mesh and the freeform
//! gradient in the display list, and the one CPU rasteriser both
//! back ends draw them with.
//!
//! Neither Vello nor `vello_cpu` has a paint whose colour is a patch
//! surface or a scattered-point blend. So a [`DisplayCommand::MeshShade`]
//! is drawn as an IMAGE: [`mesh_raster`] rasterises the shading at the
//! display resolution (the scale of the command's transform times the
//! back end's page-to-pixel scale), once per `(shading, scale)` — a
//! process-wide cache keyed by the shading's content hash and a
//! quarter-octave scale bucket — and both back ends sample the same
//! pixels under the clip the renderer pushed around the command (the
//! frame's outline). GPU/CPU parity (ADR 146) follows: the two lanes
//! receive the same raster, as they receive a placed picture.
//!
//! The PDF writer reads the shading itself: patches become a type-6 or
//! type-7 shading, a freeform gradient the type-6 grid
//! [`FreeformShading::to_patches`] samples from the same evaluator.
//!
//! Colours are blended in sRGB-encoded values with the alpha apart
//! (unpremultiplied), the way paint v2's ramps and a PDF shading blend
//! (engine ADR 1007).
//!
//! [`DisplayCommand::MeshShade`]: crate::DisplayCommand::MeshShade

use std::collections::VecDeque;
use std::sync::{Arc, Mutex, OnceLock};

use crate::gradient_sample::srgb_encode;
use crate::{Color, Rect, Transform};

/// Index into [`DisplayList::meshes`](crate::DisplayList::meshes).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct MeshId(pub u32);

/// A shading in the display list's mesh pool, in the local coordinates
/// of the command that draws it. Build it with [`MeshShading::patches`]
/// or [`MeshShading::freeform`], which hash its content once.
#[derive(Debug, Clone, PartialEq)]
pub struct MeshShading {
    pub kind: MeshKind,
    /// FNV-1a 64 of the content: the raster cache's key.
    pub hash: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum MeshKind {
    /// Coons or tensor patches, painted in order.
    Patches(Vec<ShadePatch>),
    Freeform(FreeformShading),
}

/// One patch: its sixteen control points `points[i][j]` (`i` along `v`,
/// `j` along `u`; the corners are `[0][0]`, `[0][3]`, `[3][0]`, `[3][3]`)
/// and the colours at those corners in that order.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ShadePatch {
    pub points: [[(f32, f32); 4]; 4],
    pub colors: [Color; 4],
    /// The interior points are the patch's own (a PDF type-7 patch);
    /// `false`: they are the Coons interior of the edges (type 6).
    pub tensor: bool,
}

/// A freeform gradient: coloured points and lines over `bounds`.
#[derive(Debug, Clone, PartialEq)]
pub struct FreeformShading {
    /// The area the gradient covers (the frame's box).
    pub bounds: Rect,
    /// The points on no line.
    pub points: Vec<FreeformSource>,
    /// Each line's points in order; the colour and spread run along the
    /// Catmull-Rom curve through them.
    pub lines: Vec<Vec<FreeformSource>>,
}

/// A coloured source of a freeform gradient.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FreeformSource {
    pub at: (f32, f32),
    pub color: Color,
    /// How far (local units) the colour holds before it blends.
    pub spread: f32,
}

struct Fnv(u64);

impl Fnv {
    fn new() -> Self {
        Fnv(0xcbf2_9ce4_8422_2325)
    }
    fn f(&mut self, v: f32) {
        for b in v.to_bits().to_le_bytes() {
            self.0 ^= u64::from(b);
            self.0 = self.0.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    fn color(&mut self, c: Color) {
        self.f(c.r);
        self.f(c.g);
        self.f(c.b);
        self.f(c.a);
    }
    fn source(&mut self, s: &FreeformSource) {
        self.f(s.at.0);
        self.f(s.at.1);
        self.color(s.color);
        self.f(s.spread);
    }
}

impl MeshShading {
    pub fn patches(patches: Vec<ShadePatch>) -> Self {
        let mut h = Fnv::new();
        h.f(1.0);
        for p in &patches {
            for row in &p.points {
                for (x, y) in row {
                    h.f(*x);
                    h.f(*y);
                }
            }
            for c in p.colors {
                h.color(c);
            }
            h.f(if p.tensor { 1.0 } else { 0.0 });
        }
        MeshShading {
            hash: h.0,
            kind: MeshKind::Patches(patches),
        }
    }

    pub fn freeform(f: FreeformShading) -> Self {
        let mut h = Fnv::new();
        h.f(2.0);
        h.f(f.bounds.x);
        h.f(f.bounds.y);
        h.f(f.bounds.w);
        h.f(f.bounds.h);
        for s in &f.points {
            h.source(s);
        }
        for line in &f.lines {
            h.f(line.len() as f32);
            for s in line {
                h.source(s);
            }
        }
        MeshShading {
            hash: h.0,
            kind: MeshKind::Freeform(f),
        }
    }

    /// The local box the shading paints within; `None` when it paints
    /// nothing.
    pub fn bounds(&self) -> Option<Rect> {
        match &self.kind {
            MeshKind::Patches(patches) => {
                let mut b: Option<(f32, f32, f32, f32)> = None;
                for p in patches {
                    for row in &p.points {
                        for &(x, y) in row {
                            if !(x.is_finite() && y.is_finite()) {
                                continue;
                            }
                            b = Some(match b {
                                None => (x, y, x, y),
                                Some((x0, y0, x1, y1)) => {
                                    (x0.min(x), y0.min(y), x1.max(x), y1.max(y))
                                }
                            });
                        }
                    }
                }
                let (x0, y0, x1, y1) = b?;
                Some(Rect {
                    x: x0,
                    y: y0,
                    w: x1 - x0,
                    h: y1 - y0,
                })
            }
            MeshKind::Freeform(f) => (f.bounds.w > 0.0
                && f.bounds.h > 0.0
                && (!f.points.is_empty() || !f.lines.is_empty()))
            .then_some(f.bounds),
        }
    }

    /// Whether any colour is less than fully opaque.
    pub fn is_translucent(&self) -> bool {
        match &self.kind {
            MeshKind::Patches(p) => p.iter().any(|p| p.colors.iter().any(|c| c.a < 1.0)),
            MeshKind::Freeform(f) => f
                .points
                .iter()
                .chain(f.lines.iter().flatten())
                .any(|s| s.color.a < 1.0),
        }
    }
}

/// The cubic Bernstein weights at `t`.
fn bernstein(t: f32) -> [f32; 4] {
    let s = 1.0 - t;
    [s * s * s, 3.0 * t * s * s, 3.0 * t * t * s, t * t * t]
}

/// A colour as `[r, g, b, a]`, the channels sRGB-encoded.
pub fn encoded(c: Color) -> [f32; 4] {
    [
        srgb_encode(c.r),
        srgb_encode(c.g),
        srgb_encode(c.b),
        c.a.clamp(0.0, 1.0),
    ]
}

fn lerp4(a: [f32; 4], b: [f32; 4], t: f32) -> [f32; 4] {
    [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
        a[3] + (b[3] - a[3]) * t,
    ]
}

impl ShadePatch {
    /// The surface point at `(u, v)`.
    pub fn point(&self, u: f32, v: f32) -> (f32, f32) {
        let (bu, bv) = (bernstein(u), bernstein(v));
        let (mut x, mut y) = (0.0, 0.0);
        for (i, row) in self.points.iter().enumerate() {
            for (j, &(px, py)) in row.iter().enumerate() {
                let w = bv[i] * bu[j];
                x += px * w;
                y += py * w;
            }
        }
        (x, y)
    }

    /// The colour at `(u, v)`, sRGB-encoded with straight alpha: the
    /// corners blended bilinearly, as PDF interpolates a patch.
    pub fn color(&self, u: f32, v: f32) -> [f32; 4] {
        let [c00, c03, c30, c33] = self.colors.map(encoded);
        lerp4(lerp4(c00, c03, u), lerp4(c30, c33, u), v)
    }
}

/// Uniform Catmull-Rom samples along a line through `pts`: `per_span`
/// per span, each with its colour and spread blended along the span.
fn line_samples(pts: &[FreeformSource], per_span: usize) -> Vec<Sample> {
    let mut out = Vec::new();
    if pts.is_empty() {
        return out;
    }
    if pts.len() == 1 {
        out.push((pts[0].at, encoded(pts[0].color), pts[0].spread));
        return out;
    }
    let at = |i: isize| -> (f32, f32) {
        let i = i.clamp(0, pts.len() as isize - 1) as usize;
        pts[i].at
    };
    for i in 0..pts.len() - 1 {
        let (p0, p1, p2, p3) = (
            at(i as isize - 1),
            at(i as isize),
            at(i as isize + 1),
            at(i as isize + 2),
        );
        let (c1, c2) = (encoded(pts[i].color), encoded(pts[i + 1].color));
        let (r1, r2) = (pts[i].spread, pts[i + 1].spread);
        let last = i + 2 == pts.len();
        let n = per_span.max(1);
        let span: Vec<(f32, f32)> = (0..=n)
            .map(|k| {
                let t = k as f32 / n as f32;
                let (t2, t3) = (t * t, t * t * t);
                let f = |a: f32, b: f32, c: f32, d: f32| {
                    0.5 * (2.0 * b
                        + (-a + c) * t
                        + (2.0 * a - 5.0 * b + 4.0 * c - d) * t2
                        + (-a + 3.0 * b - 3.0 * c + d) * t3)
                };
                (f(p0.0, p1.0, p2.0, p3.0), f(p0.1, p1.1, p2.1, p3.1))
            })
            .collect();
        // Colour and spread run by arc length, not by the curve's
        // parameter (which an end span's doubled point bunches up).
        let mut run = vec![0.0f32; span.len()];
        for k in 1..span.len() {
            let (a, b) = (span[k - 1], span[k]);
            run[k] = run[k - 1] + (b.0 - a.0).hypot(b.1 - a.1);
        }
        let total = run[span.len() - 1].max(1e-6);
        for (k, &p) in span.iter().enumerate() {
            if k == n && !last {
                break;
            }
            let t = run[k] / total;
            out.push((p, lerp4(c1, c2, t), r1 + (r2 - r1) * t));
        }
    }
    out
}

/// A source as the field samples it: position, encoded colour, spread.
type Sample = ((f32, f32), [f32; 4], f32);

/// Points nearer than this (local units) to a source show its colour.
const PLATEAU_EPS: f32 = 1e-3;

/// The freeform field, prepared for sampling.
pub struct FreeformField {
    points: Vec<Sample>,
    lines: Vec<Vec<Sample>>,
}

impl FreeformShading {
    /// The field, ready to sample (the lines' curves sampled once).
    pub fn field(&self) -> FreeformField {
        FreeformField {
            points: self
                .points
                .iter()
                .map(|s| (s.at, encoded(s.color), s.spread.max(0.0)))
                .collect(),
            lines: self.lines.iter().map(|l| line_samples(l, 16)).collect(),
        }
    }

    /// A type-6 approximation of the field: an `n × n` grid of
    /// straight-edged patches over [`bounds`](Self::bounds), each corner
    /// the field's colour there (bilinear in between).
    pub fn to_patches(&self, n: usize) -> Vec<ShadePatch> {
        let n = n.max(1);
        let field = self.field();
        let b = self.bounds;
        let node = |i: usize, j: usize| -> (f32, f32) {
            (
                b.x + b.w * j as f32 / n as f32,
                b.y + b.h * i as f32 / n as f32,
            )
        };
        let mut colors = vec![Color::BLACK; (n + 1) * (n + 1)];
        for i in 0..=n {
            for j in 0..=n {
                let (x, y) = node(i, j);
                colors[i * (n + 1) + j] = decoded(field.sample(x, y));
            }
        }
        let mut out = Vec::with_capacity(n * n);
        for i in 0..n {
            for j in 0..n {
                let (a, d) = (node(i, j), node(i + 1, j + 1));
                let mut points = [[(0.0, 0.0); 4]; 4];
                for (r, row) in points.iter_mut().enumerate() {
                    for (c, p) in row.iter_mut().enumerate() {
                        *p = (
                            a.0 + (d.0 - a.0) * c as f32 / 3.0,
                            a.1 + (d.1 - a.1) * r as f32 / 3.0,
                        );
                    }
                }
                out.push(ShadePatch {
                    points,
                    colors: [
                        colors[i * (n + 1) + j],
                        colors[i * (n + 1) + j + 1],
                        colors[(i + 1) * (n + 1) + j],
                        colors[(i + 1) * (n + 1) + j + 1],
                    ],
                    tensor: false,
                });
            }
        }
        out
    }
}

/// An sRGB-encoded `[r, g, b, a]` back to a display-list (linear) colour.
pub fn decoded(c: [f32; 4]) -> Color {
    use crate::gradient_sample::srgb_decode;
    Color::rgba(
        srgb_decode(c[0].clamp(0.0, 1.0)),
        srgb_decode(c[1].clamp(0.0, 1.0)),
        srgb_decode(c[2].clamp(0.0, 1.0)),
        c[3].clamp(0.0, 1.0),
    )
}

impl FreeformField {
    /// The colour at `(x, y)`, sRGB-encoded with straight alpha.
    ///
    /// Each source (a point, or the nearest place on a line) holds its
    /// colour out to its spread; past it, sources blend by inverse
    /// squared distance from the spread's edge (Shepard, `p = 2`): flat
    /// at every source, smooth between them, the mean far from all.
    pub fn sample(&self, x: f32, y: f32) -> [f32; 4] {
        let mut plateau: Option<(f32, [f32; 4])> = None;
        let mut sum_w = 0.0f32;
        let mut acc = [0.0f32; 4];
        let mut take = |e: f32, c: [f32; 4]| {
            if e <= PLATEAU_EPS {
                if plateau.is_none_or(|(best, _)| e < best) {
                    plateau = Some((e, c));
                }
                return;
            }
            let w = 1.0 / (e * e);
            sum_w += w;
            for k in 0..4 {
                acc[k] += w * c[k];
            }
        };
        for &((px, py), c, r) in &self.points {
            let d = (x - px).hypot(y - py);
            take(d - r, c);
        }
        for line in &self.lines {
            let mut best: Option<(f32, [f32; 4], f32)> = None;
            if line.len() == 1 {
                let ((px, py), c, r) = line[0];
                best = Some(((x - px).hypot(y - py), c, r));
            }
            for w in line.windows(2) {
                let ((ax, ay), ca, ra) = w[0];
                let ((bx, by), cb, rb) = w[1];
                let (dx, dy) = (bx - ax, by - ay);
                let len2 = dx * dx + dy * dy;
                let t = if len2 > 0.0 {
                    (((x - ax) * dx + (y - ay) * dy) / len2).clamp(0.0, 1.0)
                } else {
                    0.0
                };
                let (qx, qy) = (ax + dx * t, ay + dy * t);
                let d = (x - qx).hypot(y - qy);
                if best.is_none_or(|(bd, _, _)| d < bd) {
                    best = Some((d, lerp4(ca, cb, t), ra + (rb - ra) * t));
                }
            }
            if let Some((d, c, r)) = best {
                take(d - r, c);
            }
        }
        if let Some((_, c)) = plateau {
            return c;
        }
        if sum_w <= 0.0 {
            return [0.0; 4];
        }
        acc.map(|v| v / sum_w)
    }
}

/// A shading rasterised for one scale: straight-alpha RGBA8, its pixel
/// grid mapped to the shading's local space by [`to_local`](Self::to_local).
#[derive(Debug)]
pub struct MeshRaster {
    pub width: u32,
    pub height: u32,
    /// `width × height × 4` bytes, row-major, sRGB-encoded, straight alpha.
    pub rgba: Arc<Vec<u8>>,
    /// Pixel space (`0..width`, `0..height`) → the shading's local space.
    pub to_local: Transform,
    /// `(content hash, scale bucket)` — what the cache keys it by.
    pub key: (u64, i32),
}

/// The longest raster side, and the most pixels, one shading gets.
pub const MAX_RASTER_SIDE: u32 = 4096;
const MAX_RASTER_PIXELS: u64 = 8 * 1024 * 1024;
/// The raster cache's budget.
const CACHE_BYTES: usize = 96 * 1024 * 1024;

#[derive(Default)]
struct RasterCache {
    entries: VecDeque<Arc<MeshRaster>>,
    bytes: usize,
}

fn cache() -> &'static Mutex<RasterCache> {
    static CACHE: OnceLock<Mutex<RasterCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(RasterCache::default()))
}

/// The quarter-octave bucket at or above `px_per_unit`.
pub fn scale_bucket(px_per_unit: f32) -> i32 {
    (px_per_unit.max(1e-4).log2() * 4.0).ceil() as i32
}

/// `mesh` rasterised at `px_per_unit` device pixels per local unit
/// (rounded up to its quarter-octave bucket, capped at
/// [`MAX_RASTER_SIDE`]), from the cache when it was drawn at that
/// bucket before. `None` when the shading paints nothing.
pub fn mesh_raster(mesh: &MeshShading, px_per_unit: f32) -> Option<Arc<MeshRaster>> {
    if !px_per_unit.is_finite() || px_per_unit <= 0.0 {
        return None;
    }
    let bucket = scale_bucket(px_per_unit);
    let key = (mesh.hash, bucket);
    if let Ok(mut c) = cache().lock() {
        if let Some(at) = c.entries.iter().position(|r| r.key == key) {
            let hit = c.entries.remove(at)?;
            c.entries.push_back(hit.clone());
            return Some(hit);
        }
    }
    let raster = Arc::new(rasterize(mesh, 2f32.powf(bucket as f32 / 4.0), key)?);
    if let Ok(mut c) = cache().lock() {
        let size = raster.rgba.len();
        while c.bytes + size > CACHE_BYTES {
            let Some(old) = c.entries.pop_front() else {
                break;
            };
            c.bytes -= old.rgba.len();
        }
        if size <= CACHE_BYTES {
            c.bytes += size;
            c.entries.push_back(raster.clone());
        }
    }
    Some(raster)
}

/// Rasterise `mesh` at `scale` px per local unit, uncached.
pub fn rasterize(mesh: &MeshShading, scale: f32, key: (u64, i32)) -> Option<MeshRaster> {
    let b = mesh.bounds()?;
    if !(b.w.is_finite() && b.h.is_finite()) || b.w < 0.0 || b.h < 0.0 {
        return None;
    }
    // One pixel of margin each side, which the edge bleed fills.
    let mut s = scale;
    let dims = |s: f32| -> (u64, u64) {
        (
            (b.w * s).ceil().max(1.0) as u64 + 2,
            (b.h * s).ceil().max(1.0) as u64 + 2,
        )
    };
    let (mut w, mut h) = dims(s);
    while w > u64::from(MAX_RASTER_SIDE)
        || h > u64::from(MAX_RASTER_SIDE)
        || w * h > MAX_RASTER_PIXELS
    {
        s *= 0.5;
        (w, h) = dims(s);
        if s < 1e-6 {
            return None;
        }
    }
    let (w, h) = (w as usize, h as usize);
    let (ox, oy) = (b.x - 1.0 / s, b.y - 1.0 / s);
    let mut px = vec![0u8; w * h * 4];
    match &mesh.kind {
        MeshKind::Patches(patches) => {
            let mut covered = vec![false; w * h];
            let to_px = |(x, y): (f32, f32)| ((x - ox) * s, (y - oy) * s);
            for p in patches {
                raster_patch(p, &to_px, w, h, &mut px, &mut covered);
            }
            bleed(w, h, &mut px, &covered);
        }
        MeshKind::Freeform(f) => {
            let field = f.field();
            // A smooth field: sampled every `step` px (bilinear between)
            // once the raster is large.
            let step = if w * h <= 512 * 512 {
                1
            } else if w * h <= 1024 * 1024 {
                2
            } else {
                4
            };
            let gw = w.div_ceil(step) + 1;
            let gh = h.div_ceil(step) + 1;
            let mut grid = vec![[0.0f32; 4]; gw * gh];
            for gy in 0..gh {
                for gx in 0..gw {
                    let (x, y) = (
                        ox + ((gx * step) as f32 + 0.5) / s,
                        oy + ((gy * step) as f32 + 0.5) / s,
                    );
                    grid[gy * gw + gx] = field.sample(x, y);
                }
            }
            for y in 0..h {
                let (gy, fy) = (y / step, (y % step) as f32 / step as f32);
                for x in 0..w {
                    let (gx, fx) = (x / step, (x % step) as f32 / step as f32);
                    let c = if step == 1 {
                        grid[gy * gw + gx]
                    } else {
                        let top = lerp4(grid[gy * gw + gx], grid[gy * gw + gx + 1], fx);
                        let bot = lerp4(grid[(gy + 1) * gw + gx], grid[(gy + 1) * gw + gx + 1], fx);
                        lerp4(top, bot, fy)
                    };
                    put(&mut px, (y * w + x) * 4, c);
                }
            }
        }
    }
    Some(MeshRaster {
        width: w as u32,
        height: h as u32,
        rgba: Arc::new(px),
        to_local: Transform([1.0 / s, 0.0, 0.0, 1.0 / s, ox, oy]),
        key,
    })
}

fn put(px: &mut [u8], at: usize, c: [f32; 4]) {
    for k in 0..4 {
        px[at + k] = (c[k].clamp(0.0, 1.0) * 255.0).round() as u8;
    }
}

/// Subdivide a patch into small quads (about two pixels across) and
/// draw each as two Gouraud triangles, later ones over earlier ones — so
/// where a patch folds, larger `v` (then larger `u`) shows, as PDF
/// paints it.
fn raster_patch(
    p: &ShadePatch,
    to_px: &dyn Fn((f32, f32)) -> (f32, f32),
    w: usize,
    h: usize,
    px: &mut [u8],
    covered: &mut [bool],
) {
    // The control net's longest row or column, in pixels.
    let mut longest = 0.0f32;
    for i in 0..4 {
        let (mut row, mut col) = (0.0, 0.0);
        for j in 0..3 {
            let (a, b) = (to_px(p.points[i][j]), to_px(p.points[i][j + 1]));
            row += (b.0 - a.0).hypot(b.1 - a.1);
            let (a, b) = (to_px(p.points[j][i]), to_px(p.points[j + 1][i]));
            col += (b.0 - a.0).hypot(b.1 - a.1);
        }
        longest = longest.max(row).max(col);
    }
    if !longest.is_finite() {
        return;
    }
    let n = ((longest / 2.0).ceil() as usize).clamp(1, 512);
    let mut grid: Vec<((f32, f32), [f32; 4])> = Vec::with_capacity((n + 1) * (n + 1));
    for i in 0..=n {
        let v = i as f32 / n as f32;
        for j in 0..=n {
            let u = j as f32 / n as f32;
            grid.push((to_px(p.point(u, v)), p.color(u, v)));
        }
    }
    let at = |i: usize, j: usize| grid[i * (n + 1) + j];
    for i in 0..n {
        for j in 0..n {
            let (a, b, c, d) = (at(i, j), at(i, j + 1), at(i + 1, j), at(i + 1, j + 1));
            raster_triangle([a, b, d], w, h, px, covered);
            raster_triangle([a, d, c], w, h, px, covered);
        }
    }
}

/// Fill the triangle's pixel centres (edges inclusive, so two
/// triangles sharing an edge leave no crack) with the colour
/// interpolated from its corners.
fn raster_triangle(
    t: [((f32, f32), [f32; 4]); 3],
    w: usize,
    h: usize,
    px: &mut [u8],
    covered: &mut [bool],
) {
    let p = t.map(|(p, _)| (f64::from(p.0), f64::from(p.1)));
    let area = (p[1].0 - p[0].0) * (p[2].1 - p[0].1) - (p[1].1 - p[0].1) * (p[2].0 - p[0].0);
    if area.abs() < 1e-12 || !area.is_finite() {
        return;
    }
    let min_x = p.iter().map(|q| q.0).fold(f64::INFINITY, f64::min);
    let max_x = p.iter().map(|q| q.0).fold(f64::NEG_INFINITY, f64::max);
    let min_y = p.iter().map(|q| q.1).fold(f64::INFINITY, f64::min);
    let max_y = p.iter().map(|q| q.1).fold(f64::NEG_INFINITY, f64::max);
    let x0 = (min_x - 0.5).ceil().max(0.0) as usize;
    let y0 = (min_y - 0.5).ceil().max(0.0) as usize;
    let x1 = ((max_x - 0.5).floor().min(w as f64 - 1.0)).max(-1.0);
    let y1 = ((max_y - 0.5).floor().min(h as f64 - 1.0)).max(-1.0);
    if x1 < 0.0 || y1 < 0.0 {
        return;
    }
    let (x1, y1) = (x1 as usize, y1 as usize);
    let edge = |a: (f64, f64), b: (f64, f64), x: f64, y: f64| {
        (b.0 - a.0) * (y - a.1) - (b.1 - a.1) * (x - a.0)
    };
    let inv = 1.0 / area;
    let tol = 1e-9 * area.abs().max(1.0);
    for y in y0..=y1 {
        let cy = y as f64 + 0.5;
        for x in x0..=x1 {
            let cx = x as f64 + 0.5;
            let w0 = edge(p[1], p[2], cx, cy) * inv;
            let w1 = edge(p[2], p[0], cx, cy) * inv;
            let w2 = edge(p[0], p[1], cx, cy) * inv;
            if w0 < -tol || w1 < -tol || w2 < -tol {
                continue;
            }
            let c: [f32; 4] = std::array::from_fn(|k| {
                (w0 * f64::from(t[0].1[k]) + w1 * f64::from(t[1].1[k]) + w2 * f64::from(t[2].1[k]))
                    as f32
            });
            let i = y * w + x;
            put(px, i * 4, c);
            covered[i] = true;
        }
    }
}

/// Give every uncovered pixel next to a covered one the mean of its
/// covered neighbours: the raster's own edge and any pinhole between two
/// patches then sample as the mesh, not as transparency, under the clip
/// that draws the frame's antialiased edge.
fn bleed(w: usize, h: usize, px: &mut [u8], covered: &[bool]) {
    let src = px.to_vec();
    for y in 0..h {
        for x in 0..w {
            if covered[y * w + x] {
                continue;
            }
            let mut sum = [0u32; 4];
            let mut n = 0u32;
            for (dx, dy) in [
                (-1i64, 0i64),
                (1, 0),
                (0, -1),
                (0, 1),
                (-1, -1),
                (1, -1),
                (-1, 1),
                (1, 1),
            ] {
                let (nx, ny) = (x as i64 + dx, y as i64 + dy);
                if nx < 0 || ny < 0 || nx >= w as i64 || ny >= h as i64 {
                    continue;
                }
                let j = ny as usize * w + nx as usize;
                if covered[j] {
                    for k in 0..4 {
                        sum[k] += u32::from(src[j * 4 + k]);
                    }
                    n += 1;
                }
            }
            for (k, total) in sum.iter().enumerate() {
                if let Some(v) = (total + n / 2).checked_div(n) {
                    px[(y * w + x) * 4 + k] = v as u8;
                }
            }
        }
    }
}

/// The patch with its interior replaced by the Coons interior of its
/// edges (what a type-6 patch means).
pub fn coons_points(p: &ShadePatch) -> [[(f32, f32); 4]; 4] {
    let net = p.points.map(|row| row.map(|(x, y)| [x, y]));
    let [p11, p12, p21, p22] = paged_model::mesh::coons_interior(&net);
    let mut out = p.points;
    out[1][1] = (p11[0], p11[1]);
    out[1][2] = (p12[0], p12[1]);
    out[2][1] = (p21[0], p21[1]);
    out[2][2] = (p22[0], p22[1]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect_patch(x0: f32, y0: f32, x1: f32, y1: f32, colors: [Color; 4]) -> ShadePatch {
        let mut points = [[(0.0, 0.0); 4]; 4];
        for (r, row) in points.iter_mut().enumerate() {
            for (c, p) in row.iter_mut().enumerate() {
                *p = (
                    x0 + (x1 - x0) * c as f32 / 3.0,
                    y0 + (y1 - y0) * r as f32 / 3.0,
                );
            }
        }
        ShadePatch {
            points,
            colors,
            tensor: false,
        }
    }

    fn rgba(r: &MeshRaster, x: usize, y: usize) -> [u8; 4] {
        let i = (y * r.width as usize + x) * 4;
        [r.rgba[i], r.rgba[i + 1], r.rgba[i + 2], r.rgba[i + 3]]
    }

    #[test]
    fn a_bilinear_patch_blends_its_corners_in_encoded_values() {
        let red = Color::rgba(1.0, 0.0, 0.0, 1.0);
        let blue = Color::rgba(0.0, 0.0, 1.0, 1.0);
        let m = MeshShading::patches(vec![rect_patch(
            0.0,
            0.0,
            100.0,
            10.0,
            [red, blue, red, blue],
        )]);
        let r = rasterize(&m, 1.0, (0, 0)).unwrap();
        assert_eq!((r.width, r.height), (102, 12));
        // Pixel 51 (local x = 50.5) is half way: 50 % in encoded values.
        let mid = rgba(&r, 51, 6);
        assert!((i32::from(mid[0]) - 127).abs() <= 2, "{mid:?}");
        assert!((i32::from(mid[2]) - 128).abs() <= 2, "{mid:?}");
        assert_eq!(mid[3], 255);
        // The margin pixels bleed from the edge.
        assert_eq!(rgba(&r, 0, 6)[3], 255);
    }

    #[test]
    fn opacity_blends_apart_from_colour() {
        let a = Color::rgba(1.0, 0.0, 0.0, 1.0);
        let b = Color::rgba(1.0, 0.0, 0.0, 0.0);
        let m = MeshShading::patches(vec![rect_patch(0.0, 0.0, 100.0, 10.0, [a, b, a, b])]);
        let r = rasterize(&m, 1.0, (0, 0)).unwrap();
        let mid = rgba(&r, 51, 6);
        assert_eq!(mid[0], 255, "colour holds while alpha falls: {mid:?}");
        assert!((i32::from(mid[3]) - 127).abs() <= 2, "{mid:?}");
    }

    #[test]
    fn a_curved_edge_bends_the_surface() {
        let c = Color::rgba(0.0, 1.0, 0.0, 1.0);
        let mut p = rect_patch(0.0, 0.0, 90.0, 90.0, [c; 4]);
        // Pull the top edge's handles down: the top edge sags.
        p.points[0][1].1 = 60.0;
        p.points[0][2].1 = 60.0;
        let interior = crate::mesh::coons_points(&p);
        p.points = interior;
        let m = MeshShading::patches(vec![p]);
        let r = rasterize(&m, 1.0, (0, 0)).unwrap();
        // The top middle (x = 45, y = 20) is above the sagging edge
        // (which dips to y = 45 at the middle): uncovered after bleed.
        assert_eq!(rgba(&r, 46, 21)[3], 0);
        assert_eq!(rgba(&r, 46, 80)[3], 255);
    }

    #[test]
    fn a_freeform_point_holds_its_colour_and_blends_to_the_mean() {
        let red = Color::rgba(1.0, 0.0, 0.0, 1.0);
        let blue = Color::rgba(0.0, 0.0, 1.0, 1.0);
        let f = FreeformShading {
            bounds: Rect {
                x: 0.0,
                y: 0.0,
                w: 100.0,
                h: 100.0,
            },
            points: vec![
                FreeformSource {
                    at: (10.0, 50.0),
                    color: red,
                    spread: 5.0,
                },
                FreeformSource {
                    at: (90.0, 50.0),
                    color: blue,
                    spread: 0.0,
                },
            ],
            lines: vec![],
        };
        let field = f.field();
        let near = field.sample(13.0, 50.0);
        assert!(
            (near[0] - 1.0).abs() < 1e-5 && near[2] == 0.0,
            "inside the spread: {near:?}"
        );
        let mid = field.sample(52.5, 50.0);
        // Equidistant from the red spread edge (15) and blue (90).
        assert!(
            (mid[0] - 0.5).abs() < 1e-3 && (mid[2] - 0.5).abs() < 1e-3,
            "{mid:?}"
        );
        // The type-6 lowering samples the same field at its nodes.
        let patches = f.to_patches(4);
        assert_eq!(patches.len(), 16);
        let c = encoded(patches[0].colors[3]);
        let s = field.sample(25.0, 25.0);
        assert!((c[0] - s[0]).abs() < 1e-3 && (c[2] - s[2]).abs() < 1e-3);
    }

    #[test]
    fn a_line_colours_along_its_curve() {
        let red = Color::rgba(1.0, 0.0, 0.0, 1.0);
        let blue = Color::rgba(0.0, 0.0, 1.0, 1.0);
        let f = FreeformShading {
            bounds: Rect {
                x: 0.0,
                y: 0.0,
                w: 100.0,
                h: 100.0,
            },
            points: vec![],
            lines: vec![vec![
                FreeformSource {
                    at: (0.0, 50.0),
                    color: red,
                    spread: 0.0,
                },
                FreeformSource {
                    at: (100.0, 50.0),
                    color: blue,
                    spread: 0.0,
                },
            ]],
        };
        let field = f.field();
        let on = field.sample(50.0, 50.0);
        assert!(
            (on[0] - 0.5).abs() < 0.02 && (on[2] - 0.5).abs() < 0.02,
            "{on:?}"
        );
        // Off the line, the nearest place on it colours the point.
        let off = field.sample(25.0, 90.0);
        assert!((off[0] - 0.75).abs() < 0.02, "{off:?}");
    }

    #[test]
    fn the_cache_hands_back_one_raster_per_bucket() {
        let c = Color::rgba(0.2, 0.4, 0.6, 1.0);
        let m = MeshShading::patches(vec![rect_patch(0.0, 0.0, 7.0, 3.0, [c; 4])]);
        let a = mesh_raster(&m, 3.0).unwrap();
        let b = mesh_raster(&m, 2.9).unwrap();
        assert!(Arc::ptr_eq(&a, &b), "same bucket, same raster");
        let d = mesh_raster(&m, 6.0).unwrap();
        assert!(!Arc::ptr_eq(&a, &d));
        assert!(d.width > a.width);
    }

    #[test]
    fn a_huge_scale_is_capped() {
        let c = Color::rgba(0.2, 0.4, 0.6, 1.0);
        let m = MeshShading::patches(vec![rect_patch(0.0, 0.0, 1000.0, 1000.0, [c; 4])]);
        let r = rasterize(&m, 100.0, (0, 0)).unwrap();
        assert!(r.width <= MAX_RASTER_SIDE && r.height <= MAX_RASTER_SIDE);
        assert!(u64::from(r.width) * u64::from(r.height) <= MAX_RASTER_PIXELS);
    }
}

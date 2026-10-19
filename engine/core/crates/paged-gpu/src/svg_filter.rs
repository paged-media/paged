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

//! SVG filter effects (`filter="url(#f)"`) on a placed SVG.
//!
//! `usvg` resolves a filter into its region and a list of primitives,
//! each with its subregion, colour space and inputs in user space. This
//! runs them over the filtered group's pixels as the Filter Effects
//! specification describes, at the device scale the SVG is drawn at.
//! Every image is premultiplied RGBA8 over the whole layer and records
//! the colour space it is in; a primitive converts its inputs into its
//! own `color-interpolation-filters` space (linearRGB by default) and the
//! result goes back to sRGB.
//!
//! All seventeen primitives apply. Blurs come from the effects
//! pipeline's kernels ([`crate::blur`]): the exact Gaussian below σ = 2 px,
//! a five-box approximation of it from there up.

use std::rc::Rc;
use std::sync::OnceLock;

use usvg::filter::{self as fe, ColorInterpolation as Space, Input, Kind};
use vello_cpu::kurbo::{Affine, Point, Rect};

use crate::blur;

/// A layer's pixels: premultiplied RGBA8, row-major.
#[derive(Clone)]
pub(crate) struct Buf {
    pub(crate) w: u32,
    pub(crate) h: u32,
    pub(crate) px: Vec<[u8; 4]>,
}

impl Buf {
    pub(crate) fn new(w: u32, h: u32) -> Self {
        Buf {
            w,
            h,
            px: vec![[0; 4]; w as usize * h as usize],
        }
    }

    fn get(&self, x: i32, y: i32) -> [u8; 4] {
        if x < 0 || y < 0 || x >= self.w as i32 || y >= self.h as i32 {
            [0; 4]
        } else {
            self.px[y as usize * self.w as usize + x as usize]
        }
    }

    fn bytes_mut(&mut self) -> &mut [u8] {
        self.px.as_flattened_mut()
    }

    pub(crate) fn clear(&mut self) {
        self.px.fill([0; 4]);
    }

    /// Clear everything outside `keep`.
    fn keep_only(&mut self, keep: Option<IRect>) {
        let w = self.w as usize;
        for (i, p) in self.px.iter_mut().enumerate() {
            let (x, y) = ((i % w) as i32, (i / w) as i32);
            if !keep.is_some_and(|r| r.contains(x, y)) {
                *p = [0; 4];
            }
        }
    }
}

/// A pixel rectangle, half-open.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct IRect {
    x0: i32,
    y0: i32,
    x1: i32,
    y1: i32,
}

impl IRect {
    fn contains(&self, x: i32, y: i32) -> bool {
        x >= self.x0 && x < self.x1 && y >= self.y0 && y < self.y1
    }

    fn intersect(&self, o: IRect) -> Option<IRect> {
        let r = IRect {
            x0: self.x0.max(o.x0),
            y0: self.y0.max(o.y0),
            x1: self.x1.min(o.x1),
            y1: self.y1.min(o.y1),
        };
        (r.x0 < r.x1 && r.y0 < r.y1).then_some(r)
    }

    fn w(&self) -> i32 {
        self.x1 - self.x0
    }

    fn h(&self) -> i32 {
        self.y1 - self.y0
    }
}

/// The pixels a rectangle in device space covers, rounded as `resvg`
/// rounds a filter region: its origin floored and its size rounded up.
fn int_rect(r: Rect) -> Option<IRect> {
    if !(r.x0.is_finite() && r.y0.is_finite() && r.x1.is_finite() && r.y1.is_finite()) {
        return None;
    }
    let (x0, y0) = (r.x0.floor(), r.y0.floor());
    let w = r.width().ceil().max(1.0);
    let h = r.height().ceil().max(1.0);
    let lim = (i32::MAX / 4) as f64;
    if x0.abs() > lim || y0.abs() > lim || w > lim || h > lim {
        return None;
    }
    Some(IRect {
        x0: x0 as i32,
        y0: y0 as i32,
        x1: (x0 + w) as i32,
        y1: (y0 + h) as i32,
    })
}

/// The device-space box around a user-space rectangle.
pub(crate) fn device_rect(r: usvg::NonZeroRect, ts: Affine) -> Rect {
    let corners = [
        Point::new(r.left() as f64, r.top() as f64),
        Point::new(r.right() as f64, r.top() as f64),
        Point::new(r.right() as f64, r.bottom() as f64),
        Point::new(r.left() as f64, r.bottom() as f64),
    ]
    .map(|p| ts * p);
    let mut out = Rect::from_points(corners[0], corners[1]);
    for p in &corners[2..] {
        out = out.union_pt(*p);
    }
    out
}

/// How far one user unit reaches along each device axis.
fn axis_scale(ts: Affine) -> (f32, f32) {
    let [a, b, c, d, _, _] = ts.as_coeffs();
    (a.hypot(c) as f32, b.hypot(d) as f32)
}

// ── Colour spaces ────────────────────────────────────────────────────

fn srgb_to_linear_table() -> &'static [u8; 256] {
    static T: OnceLock<[u8; 256]> = OnceLock::new();
    T.get_or_init(|| {
        std::array::from_fn(|i| {
            let v = i as f64 / 255.0;
            let l = if v <= 0.04045 {
                v / 12.92
            } else {
                ((v + 0.055) / 1.055).powf(2.4)
            };
            (l * 255.0).round() as u8
        })
    })
}

fn linear_to_srgb_table() -> &'static [u8; 256] {
    static T: OnceLock<[u8; 256]> = OnceLock::new();
    T.get_or_init(|| {
        std::array::from_fn(|i| {
            let v = i as f64 / 255.0;
            let s = if v <= 0.003_130_8 {
                v * 12.92
            } else {
                1.055 * v.powf(1.0 / 2.4) - 0.055
            };
            (s * 255.0).round() as u8
        })
    })
}

fn table(to: Space) -> &'static [u8; 256] {
    match to {
        Space::LinearRGB => srgb_to_linear_table(),
        Space::SRGB => linear_to_srgb_table(),
    }
}

/// `c` (0..=255) times `a` (0..=255), rounded.
fn mul8(c: u8, a: u8) -> u8 {
    ((c as u32 * a as u32 + 127) / 255) as u8
}

fn unpremultiply(p: [u8; 4]) -> [u8; 4] {
    let a = p[3] as u32;
    if a == 0 {
        return [0; 4];
    }
    let f = |c: u8| ((c as u32 * 255 + a / 2) / a).min(255) as u8;
    [f(p[0]), f(p[1]), f(p[2]), p[3]]
}

fn premultiply(p: [u8; 4]) -> [u8; 4] {
    [mul8(p[0], p[3]), mul8(p[1], p[3]), mul8(p[2], p[3]), p[3]]
}

/// An image with the colour space it holds.
#[derive(Clone)]
struct Img {
    buf: Rc<Buf>,
    space: Space,
    /// Where it has content (a primitive's clipped subregion); `feTile`
    /// repeats it and `feOffset` inherits it.
    region: IRect,
}

impl Img {
    fn into_space(self, to: Space) -> Img {
        if self.space == to {
            return self;
        }
        let t = table(to);
        let px = self
            .buf
            .px
            .iter()
            .map(|&p| {
                if p[3] == 0 {
                    return [0; 4];
                }
                let u = unpremultiply(p);
                premultiply([t[u[0] as usize], t[u[1] as usize], t[u[2] as usize], u[3]])
            })
            .collect();
        Img {
            buf: Rc::new(Buf {
                w: self.buf.w,
                h: self.buf.h,
                px,
            }),
            space: to,
            region: self.region,
        }
    }

    fn take(self) -> Buf {
        Rc::try_unwrap(self.buf).unwrap_or_else(|rc| (*rc).clone())
    }
}

/// A colour (sRGB, 0..=255) at `opacity`, premultiplied, in `space`.
fn flood_px(c: usvg::Color, opacity: f32, space: Space) -> [u8; 4] {
    let mut rgb = [c.red, c.green, c.blue];
    if space == Space::LinearRGB {
        let t = srgb_to_linear_table();
        rgb = rgb.map(|v| t[v as usize]);
    }
    let a = (opacity.clamp(0.0, 1.0) * 255.0).round() as u8;
    premultiply([rgb[0], rgb[1], rgb[2], a])
}

// ── The filter graph ─────────────────────────────────────────────────

/// Draw a group (an `feImage`'s content) into a fresh `w × h` layer
/// under a transform.
pub(crate) type DrawGroup<'a> = dyn FnMut(&usvg::Group, Affine, u32, u32) -> Buf + 'a;

/// Run `filter` over `layer`: the filtered group's pixels, premultiplied
/// sRGB, its user space mapped onto the layer by `ts`. A filter that
/// cannot apply (an empty or unbounded region, no primitives) leaves the
/// layer empty: the specification does not render an element whose
/// filter is in error.
pub(crate) fn apply(filter: &fe::Filter, ts: Affine, layer: &mut Buf, draw: &mut DrawGroup<'_>) {
    let full = IRect {
        x0: 0,
        y0: 0,
        x1: layer.w as i32,
        y1: layer.h as i32,
    };
    let region = int_rect(device_rect(filter.rect(), ts)).and_then(|r| r.intersect(full));
    let prims = filter.primitives();
    let (Some(region), false) = (region, prims.is_empty()) else {
        layer.clear();
        return;
    };
    let mut run = Run {
        prims,
        ts,
        scale: axis_scale(ts),
        region,
        source: Rc::new(std::mem::replace(layer, Buf::new(0, 0))),
        alpha: None,
        results: vec![None; prims.len()],
    };
    // Which result each reference names (the latest before it with that
    // name), so a result is dropped after its last reader.
    let mut last_use = vec![0usize; prims.len()];
    for (k, p) in prims.iter().enumerate() {
        for input in inputs(p.kind()) {
            if let Input::Reference(name) = input {
                if let Some(j) = run.resolve(k, name) {
                    last_use[j] = last_use[j].max(k);
                }
            }
        }
    }
    for k in 0..prims.len() {
        let img = run.primitive(k, draw);
        run.results[k] = Some(img);
        for (slot, last) in run.results[..k].iter_mut().zip(&last_use) {
            if *last <= k {
                *slot = None;
            }
        }
    }
    let out = run.results.pop().flatten().expect("the last result");
    let mut buf = out.into_space(Space::SRGB).take();
    buf.keep_only(Some(region));
    *layer = buf;
}

fn inputs(kind: &Kind) -> Vec<&Input> {
    match kind {
        Kind::Blend(f) => vec![f.input1(), f.input2()],
        Kind::Composite(f) => vec![f.input1(), f.input2()],
        Kind::DisplacementMap(f) => vec![f.input1(), f.input2()],
        Kind::Merge(f) => f.inputs().iter().collect(),
        Kind::ColorMatrix(f) => vec![f.input()],
        Kind::ComponentTransfer(f) => vec![f.input()],
        Kind::ConvolveMatrix(f) => vec![f.input()],
        Kind::DiffuseLighting(f) => vec![f.input()],
        Kind::SpecularLighting(f) => vec![f.input()],
        Kind::DropShadow(f) => vec![f.input()],
        Kind::GaussianBlur(f) => vec![f.input()],
        Kind::Morphology(f) => vec![f.input()],
        Kind::Offset(f) => vec![f.input()],
        Kind::Tile(f) => vec![f.input()],
        Kind::Flood(_) | Kind::Image(_) | Kind::Turbulence(_) => vec![],
    }
}

struct Run<'a> {
    prims: &'a [fe::Primitive],
    ts: Affine,
    scale: (f32, f32),
    region: IRect,
    source: Rc<Buf>,
    alpha: Option<Rc<Buf>>,
    results: Vec<Option<Img>>,
}

impl Run<'_> {
    fn resolve(&self, k: usize, name: &str) -> Option<usize> {
        (0..k).rev().find(|&j| self.prims[j].result() == name)
    }

    fn input(&mut self, k: usize, input: &Input) -> Img {
        let source = |buf: Rc<Buf>, region| Img {
            buf,
            space: Space::SRGB,
            region,
        };
        match input {
            Input::SourceGraphic => source(self.source.clone(), self.region),
            Input::SourceAlpha => {
                let src = &self.source;
                let alpha = self
                    .alpha
                    .get_or_insert_with(|| {
                        Rc::new(Buf {
                            w: src.w,
                            h: src.h,
                            px: src.px.iter().map(|p| [0, 0, 0, p[3]]).collect(),
                        })
                    })
                    .clone();
                source(alpha, self.region)
            }
            Input::Reference(name) => {
                match self.resolve(k, name).and_then(|j| self.results[j].clone()) {
                    Some(img) => img,
                    None => source(self.source.clone(), self.region),
                }
            }
        }
    }

    fn blank(&self) -> Buf {
        Buf::new(self.source.w, self.source.h)
    }

    fn primitive(&mut self, k: usize, draw: &mut DrawGroup<'_>) -> Img {
        let prims = self.prims;
        let p = &prims[k];
        let space = p.color_interpolation();
        let (sx, sy) = self.scale;
        let mut sub = int_rect(device_rect(p.rect(), self.ts));
        // An offset keeps the subregion of what it moves.
        if let Kind::Offset(f) = p.kind() {
            if let Input::Reference(name) = f.input() {
                if let Some(img) = self.resolve(k, name).and_then(|j| self.results[j].as_ref()) {
                    sub = Some(img.region);
                }
            }
        }
        let clip = sub.and_then(|s| s.intersect(self.region));
        let (buf, space) = match p.kind() {
            Kind::GaussianBlur(f) => {
                let input = self.input(k, f.input());
                let (dx, dy) = (f.std_dev_x().get() * sx, f.std_dev_y().get() * sy);
                if dx <= 1e-6 && dy <= 1e-6 {
                    let s = input.space;
                    (input.take(), s)
                } else {
                    let mut buf = input.into_space(space).take();
                    gaussian(&mut buf, dx, dy);
                    (buf, space)
                }
            }
            Kind::Offset(f) => {
                let input = self.input(k, f.input());
                let s = input.space;
                let (dx, dy) = (f.dx() * sx, f.dy() * sy);
                if dx.abs() <= 1e-6 && dy.abs() <= 1e-6 {
                    (input.take(), s)
                } else {
                    (shift(&input.buf, dx.round() as i32, dy.round() as i32), s)
                }
            }
            Kind::Flood(f) => {
                let mut buf = self.blank();
                buf.px
                    .fill(flood_px(f.color(), f.opacity().get(), Space::SRGB));
                (buf, Space::SRGB)
            }
            Kind::DropShadow(f) => {
                let input = self.input(k, f.input()).into_space(space);
                (drop_shadow(f, &input.buf, space, self.scale), space)
            }
            Kind::Composite(f) => {
                let a = self.input(k, f.input1()).into_space(space);
                let b = self.input(k, f.input2()).into_space(space);
                (composite(f.operator(), &a.buf, &b.buf), space)
            }
            Kind::Merge(f) => {
                let mut acc = self.blank();
                for input in f.inputs() {
                    let img = self.input(k, input).into_space(space);
                    for (d, s) in acc.px.iter_mut().zip(img.buf.px.iter()) {
                        *d = over(*s, *d);
                    }
                }
                (acc, space)
            }
            Kind::Blend(f) => {
                let a = self.input(k, f.input1()).into_space(space);
                let b = self.input(k, f.input2()).into_space(space);
                (blend(f.mode(), &a.buf, &b.buf), space)
            }
            Kind::ColorMatrix(f) => {
                let mut buf = self.input(k, f.input()).into_space(space).take();
                color_matrix(f.kind(), &mut buf);
                (buf, space)
            }
            Kind::ComponentTransfer(f) => {
                let mut buf = self.input(k, f.input()).into_space(space).take();
                component_transfer(f, &mut buf);
                (buf, space)
            }
            Kind::ConvolveMatrix(f) => {
                let input = self.input(k, f.input()).into_space(space);
                (convolve(f, &input.buf), space)
            }
            Kind::Morphology(f) => {
                let input = self.input(k, f.input()).into_space(space);
                let (rx, ry) = (f.radius_x().get() * sx, f.radius_y().get() * sy);
                if rx > 0.0 && ry > 0.0 {
                    (morphology(f.operator(), rx, ry, &input.buf), space)
                } else {
                    (input.take(), space)
                }
            }
            Kind::Tile(f) => {
                let input = self.input(k, f.input());
                let s = input.space;
                (tile(&input.buf, input.region), s)
            }
            Kind::Image(f) => {
                let at = sub.map_or((0, 0), |r| (r.x0, r.y0));
                let place = Affine::new([sx as f64, 0.0, 0.0, sy as f64, at.0 as f64, at.1 as f64]);
                (
                    draw(f.root(), place, self.source.w, self.source.h),
                    Space::SRGB,
                )
            }
            Kind::DisplacementMap(f) => {
                let input = self.input(k, f.input1());
                let s = input.space;
                let map = self.input(k, f.input2()).into_space(space);
                (displace(f, &input.buf, &map.buf, self.scale), s)
            }
            Kind::Turbulence(f) => {
                let mut buf = self.blank();
                if let Some(c) = clip {
                    turbulence(f, p.rect(), self.ts, c, &mut buf);
                }
                (buf, space)
            }
            Kind::DiffuseLighting(f) => {
                let input = self.input(k, f.input());
                let light = Light::new(f.light_source(), self.ts);
                let color = light_color(f.lighting_color(), space);
                (
                    lighting(
                        &input.buf,
                        &light,
                        f.surface_scale(),
                        color,
                        Shade::Diffuse(f.diffuse_constant()),
                    ),
                    space,
                )
            }
            Kind::SpecularLighting(f) => {
                let input = self.input(k, f.input());
                let light = Light::new(f.light_source(), self.ts);
                let color = light_color(f.lighting_color(), space);
                let shade = Shade::Specular(f.specular_constant(), f.specular_exponent());
                (
                    lighting(&input.buf, &light, f.surface_scale(), color, shade),
                    space,
                )
            }
        };
        let mut buf = buf;
        // An offset moves content within the filter region, whatever its
        // subregion says, and keeps that subregion for what reads it (an
        // `feTile`), as resvg does.
        let offset = matches!(p.kind(), Kind::Offset(_));
        buf.keep_only(if offset { Some(self.region) } else { clip });
        Img {
            buf: Rc::new(buf),
            space,
            region: clip.unwrap_or(self.region),
        }
    }
}

// ── Primitives ───────────────────────────────────────────────────────

/// Below this σ (device px) a blur takes the exact Gaussian; from it up,
/// five boxes. Box widths are whole pixels, so below it their variance
/// misses σ² by up to a sixth; above it the exact kernel's cost grows with
/// σ and the boxes' does not.
const BOX_SIGMA: f32 = 4.0;

/// `feGaussianBlur` at σ (device px) per axis, each axis on its own: the
/// exact Gaussian below [`BOX_SIGMA`], five box blurs from there up. A σ
/// under 0.05 px leaves its axis alone.
fn gaussian(buf: &mut Buf, sx: f32, sy: f32) {
    let (w, h) = (buf.w, buf.h);
    let exact = |s: f32| {
        (0.05..BOX_SIGMA)
            .contains(&s)
            .then(|| blur::gaussian_kernel(s))
    };
    let (kx, ky) = (exact(sx), exact(sy));
    if kx.is_some() || ky.is_some() {
        blur::gaussian_blur_premul_xy(buf.bytes_mut(), w, h, kx.as_deref(), ky.as_deref());
    }
    let boxed = |s: f32| if s >= BOX_SIGMA { s } else { 0.0 };
    if sx >= BOX_SIGMA || sy >= BOX_SIGMA {
        blur::box_blur_premul(buf.bytes_mut(), w, h, boxed(sx), boxed(sy));
    }
}

fn shift(src: &Buf, dx: i32, dy: i32) -> Buf {
    let mut out = Buf::new(src.w, src.h);
    let w = src.w as i32;
    for y in 0..src.h as i32 {
        for x in 0..w {
            out.px[(y * w + x) as usize] = src.get(x - dx, y - dy);
        }
    }
    out
}

/// Source-over of premultiplied `s` onto `d`.
fn over(s: [u8; 4], d: [u8; 4]) -> [u8; 4] {
    let inv = 255 - s[3];
    std::array::from_fn(|c| (s[c] as u32 + mul8(d[c], inv) as u32).min(255) as u8)
}

fn drop_shadow(f: &fe::DropShadow, input: &Buf, space: Space, (sx, sy): (f32, f32)) -> Buf {
    let mut shadow = Buf {
        w: input.w,
        h: input.h,
        px: input.px.iter().map(|p| [0, 0, 0, p[3]]).collect(),
    };
    let (bx, by) = (f.std_dev_x().get() * sx, f.std_dev_y().get() * sy);
    if bx > 1e-6 || by > 1e-6 {
        gaussian(&mut shadow, bx, by);
    }
    let color = flood_px(f.color(), f.opacity().get(), space);
    for p in &mut shadow.px {
        let a = p[3];
        *p = color.map(|c| mul8(c, a));
    }
    let mut out = shift(
        &shadow,
        (f.dx() * sx).round() as i32,
        (f.dy() * sy).round() as i32,
    );
    for (d, s) in out.px.iter_mut().zip(input.px.iter()) {
        *d = over(*s, *d);
    }
    out
}

fn composite(op: fe::CompositeOperator, a: &Buf, b: &Buf) -> Buf {
    use fe::CompositeOperator as Op;
    let mut out = Buf::new(a.w, a.h);
    if let Op::Arithmetic { k1, k2, k3, k4 } = op {
        for ((o, s), d) in out.px.iter_mut().zip(&a.px).zip(&b.px) {
            let f = |i1: u8, i2: u8, max: f32| {
                let (i1, i2) = (i1 as f32 / 255.0, i2 as f32 / 255.0);
                let v = k1 * i1 * i2 + k2 * i1 + k3 * i2 + k4;
                if v.is_nan() {
                    0.0
                } else {
                    v.clamp(0.0, max)
                }
            };
            let alpha = f(s[3], d[3], 1.0);
            if alpha <= 0.0 {
                continue;
            }
            let to8 = |v: f32| (v * 255.0).round() as u8;
            *o = [
                to8(f(s[0], d[0], alpha)),
                to8(f(s[1], d[1], alpha)),
                to8(f(s[2], d[2], alpha)),
                to8(alpha),
            ];
        }
        return out;
    }
    for ((o, s), d) in out.px.iter_mut().zip(&a.px).zip(&b.px) {
        // Porter-Duff on premultiplied colour: s·Fa + d·Fb.
        let (fa, fb) = match op {
            Op::Over => (255, 255 - s[3]),
            Op::In => (d[3], 0),
            Op::Out => (255 - d[3], 0),
            Op::Atop => (d[3], 255 - s[3]),
            Op::Xor => (255 - d[3], 255 - s[3]),
            Op::Arithmetic { .. } => unreachable!(),
        };
        *o =
            std::array::from_fn(|c| (mul8(s[c], fa) as u32 + mul8(d[c], fb) as u32).min(255) as u8);
    }
    out
}

/// `feBlend`: `a` (in) blended onto `b` (in2), the W3C compositing
/// formula `co = cs·(1 − αb) + cb·(1 − αs) + αs·αb·B(Cb, Cs)`.
fn blend(mode: usvg::BlendMode, a: &Buf, b: &Buf) -> Buf {
    let mut out = Buf::new(a.w, a.h);
    for ((o, s), d) in out.px.iter_mut().zip(&a.px).zip(&b.px) {
        if s[3] == 0 {
            *o = *d;
            continue;
        }
        if d[3] == 0 {
            *o = *s;
            continue;
        }
        let f = |p: [u8; 4]| p.map(|v| v as f32 / 255.0);
        let (s, d) = (f(*s), f(*d));
        let (as_, ab) = (s[3], d[3]);
        let cs = [s[0] / as_, s[1] / as_, s[2] / as_];
        let cb = [d[0] / ab, d[1] / ab, d[2] / ab];
        let mixed = blend_rgb(mode, cb, cs);
        let ao = as_ + ab - as_ * ab;
        let co: [f32; 3] =
            std::array::from_fn(|c| s[c] * (1.0 - ab) + d[c] * (1.0 - as_) + as_ * ab * mixed[c]);
        let to8 = |v: f32| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
        let a8 = to8(ao);
        *o = [
            to8(co[0]).min(a8),
            to8(co[1]).min(a8),
            to8(co[2]).min(a8),
            a8,
        ];
    }
    out
}

fn blend_rgb(mode: usvg::BlendMode, cb: [f32; 3], cs: [f32; 3]) -> [f32; 3] {
    use usvg::BlendMode as M;
    let sep = |f: fn(f32, f32) -> f32| std::array::from_fn(|c| f(cb[c], cs[c]));
    match mode {
        M::Normal => cs,
        M::Multiply => sep(|b, s| b * s),
        M::Screen => sep(screen),
        M::Overlay => sep(|b, s| hard_light(s, b)),
        M::Darken => sep(f32::min),
        M::Lighten => sep(f32::max),
        M::ColorDodge => sep(|b, s| {
            if b <= 0.0 {
                0.0
            } else if s >= 1.0 {
                1.0
            } else {
                (b / (1.0 - s)).min(1.0)
            }
        }),
        M::ColorBurn => sep(|b, s| {
            if b >= 1.0 {
                1.0
            } else if s <= 0.0 {
                0.0
            } else {
                1.0 - ((1.0 - b) / s).min(1.0)
            }
        }),
        M::HardLight => sep(hard_light),
        M::SoftLight => sep(|b, s| {
            if s <= 0.5 {
                b - (1.0 - 2.0 * s) * b * (1.0 - b)
            } else {
                let d = if b <= 0.25 {
                    ((16.0 * b - 12.0) * b + 4.0) * b
                } else {
                    b.sqrt()
                };
                b + (2.0 * s - 1.0) * (d - b)
            }
        }),
        M::Difference => sep(|b, s| (b - s).abs()),
        M::Exclusion => sep(|b, s| b + s - 2.0 * b * s),
        M::Hue => set_lum(set_sat(cs, sat(cb)), lum(cb)),
        M::Saturation => set_lum(set_sat(cb, sat(cs)), lum(cb)),
        M::Color => set_lum(cs, lum(cb)),
        M::Luminosity => set_lum(cb, lum(cs)),
    }
}

fn screen(b: f32, s: f32) -> f32 {
    b + s - b * s
}

fn hard_light(b: f32, s: f32) -> f32 {
    if s <= 0.5 {
        b * 2.0 * s
    } else {
        screen(b, 2.0 * s - 1.0)
    }
}

fn lum(c: [f32; 3]) -> f32 {
    0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]
}

fn clip_color(c: [f32; 3]) -> [f32; 3] {
    let l = lum(c);
    let n = c[0].min(c[1]).min(c[2]);
    let x = c[0].max(c[1]).max(c[2]);
    let mut c = c;
    if n < 0.0 {
        c = c.map(|v| l + (v - l) * l / (l - n));
    }
    if x > 1.0 {
        c = c.map(|v| l + (v - l) * (1.0 - l) / (x - l));
    }
    c
}

fn set_lum(c: [f32; 3], l: f32) -> [f32; 3] {
    let d = l - lum(c);
    clip_color(c.map(|v| v + d))
}

fn sat(c: [f32; 3]) -> f32 {
    c[0].max(c[1]).max(c[2]) - c[0].min(c[1]).min(c[2])
}

fn set_sat(c: [f32; 3], s: f32) -> [f32; 3] {
    let (mx, mn) = (c[0].max(c[1]).max(c[2]), c[0].min(c[1]).min(c[2]));
    if mx <= mn {
        return [0.0; 3];
    }
    c.map(|v| (v - mn) * s / (mx - mn))
}

fn color_matrix(kind: &fe::ColorMatrixKind, buf: &mut Buf) {
    use fe::ColorMatrixKind as K;
    let rgb3 = |m: [f32; 9]| {
        let mut full = [0.0f32; 20];
        for r in 0..3 {
            full[r * 5..r * 5 + 3].copy_from_slice(&m[r * 3..r * 3 + 3]);
        }
        full[18] = 1.0;
        full
    };
    let m: [f32; 20] = match kind {
        K::Matrix(v) if v.len() == 20 => std::array::from_fn(|i| v[i]),
        K::Matrix(_) => return,
        K::Saturate(s) => {
            let s = s.get().max(0.0);
            rgb3([
                0.213 + 0.787 * s,
                0.715 - 0.715 * s,
                0.072 - 0.072 * s,
                0.213 - 0.213 * s,
                0.715 + 0.285 * s,
                0.072 - 0.072 * s,
                0.213 - 0.213 * s,
                0.715 - 0.715 * s,
                0.072 + 0.928 * s,
            ])
        }
        K::HueRotate(deg) => {
            let (sin, cos) = deg.to_radians().sin_cos();
            rgb3([
                0.213 + 0.787 * cos - 0.213 * sin,
                0.715 - 0.715 * cos - 0.715 * sin,
                0.072 - 0.072 * cos + 0.928 * sin,
                0.213 - 0.213 * cos + 0.143 * sin,
                0.715 + 0.285 * cos + 0.140 * sin,
                0.072 - 0.072 * cos - 0.283 * sin,
                0.213 - 0.213 * cos - 0.787 * sin,
                0.715 - 0.715 * cos + 0.715 * sin,
                0.072 + 0.928 * cos + 0.072 * sin,
            ])
        }
        K::LuminanceToAlpha => {
            let mut m = [0.0f32; 20];
            m[15] = 0.2125;
            m[16] = 0.7154;
            m[17] = 0.0721;
            m
        }
    };
    let to8 = |v: f32| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
    for p in &mut buf.px {
        let u = unpremultiply(*p).map(|v| v as f32 / 255.0);
        let row = |r: usize| {
            m[r * 5] * u[0]
                + m[r * 5 + 1] * u[1]
                + m[r * 5 + 2] * u[2]
                + m[r * 5 + 3] * u[3]
                + m[r * 5 + 4]
        };
        *p = premultiply([to8(row(0)), to8(row(1)), to8(row(2)), to8(row(3))]);
    }
}

fn transfer_table(f: &fe::TransferFunction) -> Option<[u8; 256]> {
    use fe::TransferFunction as T;
    let eval: Box<dyn Fn(f32) -> f32> = match f {
        T::Identity => return None,
        T::Table(v) if v.is_empty() => return None,
        T::Discrete(v) if v.is_empty() => return None,
        T::Table(v) => {
            let v = v.clone();
            Box::new(move |c| {
                let n = (v.len() - 1) as f32;
                let k = ((c * n).floor() as usize).min(v.len() - 1);
                if k == v.len() - 1 {
                    v[k]
                } else {
                    v[k] + (c - k as f32 / n) * n * (v[k + 1] - v[k])
                }
            })
        }
        T::Discrete(v) => {
            let v = v.clone();
            Box::new(move |c| {
                let n = v.len();
                v[((c * n as f32).floor() as usize).min(n - 1)]
            })
        }
        T::Linear { slope, intercept } => {
            let (s, i) = (*slope, *intercept);
            Box::new(move |c| s * c + i)
        }
        T::Gamma {
            amplitude,
            exponent,
            offset,
        } => {
            let (a, e, o) = (*amplitude, *exponent, *offset);
            Box::new(move |c| a * c.powf(e) + o)
        }
    };
    Some(std::array::from_fn(|i| {
        let v = eval(i as f32 / 255.0);
        if v.is_nan() {
            0
        } else {
            (v.clamp(0.0, 1.0) * 255.0).round() as u8
        }
    }))
}

fn component_transfer(f: &fe::ComponentTransfer, buf: &mut Buf) {
    let tables = [f.func_r(), f.func_g(), f.func_b(), f.func_a()].map(transfer_table);
    if tables.iter().all(Option::is_none) {
        return;
    }
    for p in &mut buf.px {
        let mut u = unpremultiply(*p);
        for (c, t) in tables.iter().enumerate() {
            if let Some(t) = t {
                u[c] = t[u[c] as usize];
            }
        }
        *p = premultiply(u);
    }
}

fn convolve(f: &fe::ConvolveMatrix, src: &Buf) -> Buf {
    let m = f.matrix();
    let (cols, rows) = (m.columns() as i32, m.rows() as i32);
    let (tx, ty) = (m.target_x() as i32, m.target_y() as i32);
    let (w, h) = (src.w as i32, src.h as i32);
    let divisor = f.divisor().get();
    let bias = f.bias();
    let keep_alpha = f.preserve_alpha();
    let mut out = Buf::new(src.w, src.h);
    for y in 0..h {
        for x in 0..w {
            let mut acc = [0.0f32; 4];
            for oy in 0..rows {
                for ox in 0..cols {
                    let (mut px, mut py) = (x - tx + ox, y - ty + oy);
                    match f.edge_mode() {
                        fe::EdgeMode::None => {
                            if px < 0 || py < 0 || px >= w || py >= h {
                                continue;
                            }
                        }
                        fe::EdgeMode::Duplicate => {
                            px = px.clamp(0, w - 1);
                            py = py.clamp(0, h - 1);
                        }
                        fe::EdgeMode::Wrap => {
                            px = px.rem_euclid(w);
                            py = py.rem_euclid(h);
                        }
                    }
                    // The kernel is applied rotated by 180°.
                    let k = m.get((cols - ox - 1) as u32, (rows - oy - 1) as u32);
                    let mut p = src.px[(py * w + px) as usize];
                    if keep_alpha {
                        p = unpremultiply(p);
                    }
                    for c in 0..4 {
                        acc[c] += p[c] as f32 / 255.0 * k;
                    }
                }
            }
            let own = src.px[(y * w + x) as usize];
            let alpha = if keep_alpha {
                own[3] as f32 / 255.0
            } else {
                (acc[3] / divisor + bias).clamp(0.0, 1.0)
            };
            let to8 = |v: f32| (v * 255.0).round() as u8;
            let color = |v: f32| {
                let v = v / divisor + bias * alpha;
                if keep_alpha {
                    v.clamp(0.0, 1.0) * alpha
                } else {
                    v.clamp(0.0, alpha)
                }
            };
            out.px[(y * w + x) as usize] = [
                to8(color(acc[0])),
                to8(color(acc[1])),
                to8(color(acc[2])),
                to8(alpha),
            ];
        }
    }
    out
}

/// `feMorphology`: per channel the minimum (erode) or maximum (dilate)
/// of the pixels inside the image within `r` (rounded up) of each pixel,
/// a `(2r + 1)`-wide window as browsers and librsvg size it (the
/// specification's text says `2r`, and `resvg` followed it). A
/// rectangle's extreme is separable, so it runs as two passes.
fn morphology(op: fe::MorphologyOperator, rx: f32, ry: f32, src: &Buf) -> Buf {
    let erode = op == fe::MorphologyOperator::Erode;
    let pick = |a: u8, b: u8| if erode { a.min(b) } else { a.max(b) };
    let (w, h) = (src.w as i32, src.h as i32);
    let (lx, ly) = ((rx.ceil() as i32).min(w), (ry.ceil() as i32).min(h));
    let (cols, rows) = (2 * lx + 1, 2 * ly + 1);
    let pass = |src: &Buf, horizontal: bool| {
        let (n, reach) = if horizontal { (cols, lx) } else { (rows, ly) };
        let mut out = Buf::new(src.w, src.h);
        for y in 0..h {
            for x in 0..w {
                let mut acc = if erode { [255u8; 4] } else { [0u8; 4] };
                for o in 0..n {
                    let (px, py) = if horizontal {
                        (x - reach + o, y)
                    } else {
                        (x, y - reach + o)
                    };
                    if px < 0 || py < 0 || px >= w || py >= h {
                        continue;
                    }
                    let p = src.px[(py * w + px) as usize];
                    acc = std::array::from_fn(|c| pick(acc[c], p[c]));
                }
                out.px[(y * w + x) as usize] = acc;
            }
        }
        out
    };
    pass(&pass(src, true), false)
}

fn tile(src: &Buf, cell: IRect) -> Buf {
    let mut out = Buf::new(src.w, src.h);
    let (cw, ch) = (cell.w(), cell.h());
    if cw <= 0 || ch <= 0 {
        return out;
    }
    let w = src.w as i32;
    for y in 0..src.h as i32 {
        for x in 0..w {
            let sx = cell.x0 + (x - cell.x0).rem_euclid(cw);
            let sy = cell.y0 + (y - cell.y0).rem_euclid(ch);
            out.px[(y * w + x) as usize] = src.get(sx, sy);
        }
    }
    out
}

/// `feDisplacementMap`: each pixel of `src` taken from where the map's
/// (unpremultiplied) channels point, `scale · (C − ½)` away. The map is
/// in the primitive's colour space; the source stays in its own.
fn displace(f: &fe::DisplacementMap, src: &Buf, map: &Buf, (sx, sy): (f32, f32)) -> Buf {
    let pick = |p: [u8; 4], c: fe::ColorChannel| match c {
        fe::ColorChannel::R => p[0],
        fe::ColorChannel::G => p[1],
        fe::ColorChannel::B => p[2],
        fe::ColorChannel::A => p[3],
    };
    let (kx, ky) = (f.scale() * sx, f.scale() * sy);
    let mut out = Buf::new(src.w, src.h);
    let w = src.w as i32;
    for y in 0..src.h as i32 {
        for x in 0..w {
            let m = unpremultiply(map.px[(y * w + x) as usize]);
            let dx = kx * (pick(m, f.x_channel_selector()) as f32 / 255.0 - 0.5);
            let dy = ky * (pick(m, f.y_channel_selector()) as f32 / 255.0 - 0.5);
            out.px[(y * w + x) as usize] = src.get(
                (x as f32 + dx).round() as i32,
                (y as f32 + dy).round() as i32,
            );
        }
    }
    out
}

// ── feTurbulence: the specification's reference noise ────────────────

const BSIZE: usize = 0x100;
const BM: i32 = 0xff;
const PERLIN_N: i32 = 0x1000;

struct Noise {
    lattice: [usize; BSIZE + BSIZE + 2],
    gradient: [[[f64; 2]; BSIZE + BSIZE + 2]; 4],
}

#[derive(Clone, Copy)]
struct Stitch {
    width: i32,
    height: i32,
    wrap_x: i32,
    wrap_y: i32,
}

fn random(seed: i64) -> i64 {
    const M: i64 = 2_147_483_647;
    const A: i64 = 16_807;
    const Q: i64 = 127_773;
    const R: i64 = 2_836;
    let mut r = A * (seed % Q) - R * (seed / Q);
    if r <= 0 {
        r += M;
    }
    r
}

impl Noise {
    fn new(seed: i32) -> Noise {
        const M: i64 = 2_147_483_647;
        let mut seed = seed as i64;
        if seed <= 0 {
            seed = -(seed % (M - 1)) + 1;
        }
        if seed > M - 1 {
            seed = M - 1;
        }
        let mut n = Noise {
            lattice: [0; BSIZE + BSIZE + 2],
            gradient: [[[0.0; 2]; BSIZE + BSIZE + 2]; 4],
        };
        for k in 0..4 {
            for i in 0..BSIZE {
                n.lattice[i] = i;
                for j in 0..2 {
                    seed = random(seed);
                    n.gradient[k][i][j] =
                        ((seed % (BSIZE as i64 * 2)) - BSIZE as i64) as f64 / BSIZE as f64;
                }
                let g = n.gradient[k][i];
                let s = (g[0] * g[0] + g[1] * g[1]).sqrt();
                if s > 0.0 {
                    n.gradient[k][i] = [g[0] / s, g[1] / s];
                }
            }
        }
        for i in (1..BSIZE).rev() {
            seed = random(seed);
            let j = (seed % BSIZE as i64) as usize;
            n.lattice.swap(i, j);
        }
        for i in 0..BSIZE + 2 {
            n.lattice[BSIZE + i] = n.lattice[i];
            for k in 0..4 {
                n.gradient[k][BSIZE + i] = n.gradient[k][i];
            }
        }
        n
    }

    fn noise2(&self, channel: usize, vec: [f64; 2], stitch: Option<&Stitch>) -> f64 {
        let s_curve = |t: f64| t * t * (3.0 - 2.0 * t);
        let lerp = |t: f64, a: f64, b: f64| a + t * (b - a);
        let t = vec[0] + PERLIN_N as f64;
        let mut bx0 = (t as i32) & BM;
        let mut bx1 = (bx0 + 1) & BM;
        let rx0 = t - (t as i64) as f64;
        let rx1 = rx0 - 1.0;
        let t = vec[1] + PERLIN_N as f64;
        let mut by0 = (t as i32) & BM;
        let mut by1 = (by0 + 1) & BM;
        let ry0 = t - (t as i64) as f64;
        let ry1 = ry0 - 1.0;
        if let Some(s) = stitch {
            if bx0 >= s.wrap_x {
                bx0 -= s.width;
            }
            if bx1 >= s.wrap_x {
                bx1 -= s.width;
            }
            if by0 >= s.wrap_y {
                by0 -= s.height;
            }
            if by1 >= s.wrap_y {
                by1 -= s.height;
            }
        }
        let (bx0, bx1, by0, by1) = (
            (bx0 & BM) as usize,
            (bx1 & BM) as usize,
            (by0 & BM) as usize,
            (by1 & BM) as usize,
        );
        let i = self.lattice[bx0];
        let j = self.lattice[bx1];
        let b00 = self.lattice[i + by0];
        let b10 = self.lattice[j + by0];
        let b01 = self.lattice[i + by1];
        let b11 = self.lattice[j + by1];
        let sx = s_curve(rx0);
        let sy = s_curve(ry0);
        let g = &self.gradient[channel];
        let u = rx0 * g[b00][0] + ry0 * g[b00][1];
        let v = rx1 * g[b10][0] + ry0 * g[b10][1];
        let a = lerp(sx, u, v);
        let u = rx0 * g[b01][0] + ry1 * g[b01][1];
        let v = rx1 * g[b11][0] + ry1 * g[b11][1];
        let b = lerp(sx, u, v);
        lerp(sy, a, b)
    }
}

/// The turbulence function of the specification at a user-space point.
#[allow(clippy::too_many_arguments)]
fn turbulence_at(
    noise: &Noise,
    channel: usize,
    point: [f64; 2],
    mut freq: (f64, f64),
    octaves: u32,
    fractal: bool,
    tile: Option<[f64; 4]>,
) -> f64 {
    let mut stitch = None;
    if let Some([tx, ty, tw, th]) = tile {
        let adjust = |f: f64, size: f64| {
            if f == 0.0 {
                return f;
            }
            let lo = (size * f).floor() / size;
            let hi = (size * f).ceil() / size;
            if f / lo < hi / f {
                lo
            } else {
                hi
            }
        };
        freq = (adjust(freq.0, tw), adjust(freq.1, th));
        let width = (tw * freq.0 + 0.5) as i32;
        let height = (th * freq.1 + 0.5) as i32;
        stitch = Some(Stitch {
            width,
            height,
            wrap_x: (tx * freq.0 + PERLIN_N as f64 + width as f64) as i32,
            wrap_y: (ty * freq.1 + PERLIN_N as f64 + height as f64) as i32,
        });
    }
    let mut sum = 0.0;
    let mut vec = [point[0] * freq.0, point[1] * freq.1];
    let mut ratio = 1.0;
    for _ in 0..octaves {
        let n = noise.noise2(channel, vec, stitch.as_ref());
        sum += if fractal { n } else { n.abs() } / ratio;
        vec = [vec[0] * 2.0, vec[1] * 2.0];
        ratio *= 2.0;
        if let Some(s) = stitch.as_mut() {
            s.width *= 2;
            s.wrap_x = 2 * s.wrap_x - PERLIN_N;
            s.height *= 2;
            s.wrap_y = 2 * s.wrap_y - PERLIN_N;
        }
    }
    sum
}

fn turbulence(f: &fe::Turbulence, sub: usvg::NonZeroRect, ts: Affine, clip: IRect, buf: &mut Buf) {
    let det = ts.determinant();
    if det.abs() < 1e-12 {
        return;
    }
    let inv = ts.inverse();
    let noise = Noise::new(f.seed());
    let fractal = f.kind() == fe::TurbulenceKind::FractalNoise;
    let freq = (
        f.base_frequency_x().get() as f64,
        f.base_frequency_y().get() as f64,
    );
    let tile = f.stitch_tiles().then(|| {
        [
            sub.x() as f64,
            sub.y() as f64,
            sub.width() as f64,
            sub.height() as f64,
        ]
    });
    let w = buf.w as usize;
    for y in clip.y0..clip.y1 {
        for x in clip.x0..clip.x1 {
            let p = inv * Point::new(x as f64, y as f64);
            let mut c = [0u8; 4];
            for (ch, v) in c.iter_mut().enumerate() {
                let t = turbulence_at(&noise, ch, [p.x, p.y], freq, f.num_octaves(), fractal, tile);
                let t = if fractal { (t + 1.0) / 2.0 } else { t };
                *v = (t.clamp(0.0, 1.0) * 255.0).round() as u8;
            }
            buf.px[y as usize * w + x as usize] = premultiply(c);
        }
    }
}

// ── Lighting ─────────────────────────────────────────────────────────

/// A light source in device pixels.
enum Light {
    Distant([f32; 3]),
    Point([f32; 3]),
    Spot {
        at: [f32; 3],
        dir: [f32; 3],
        exponent: f32,
        cone: Option<f32>,
    },
}

fn sub3(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn dot3(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn norm3(v: [f32; 3]) -> [f32; 3] {
    let l = dot3(v, v).sqrt();
    if l > 0.0 {
        v.map(|c| c / l)
    } else {
        v
    }
}

impl Light {
    fn new(source: fe::LightSource, ts: Affine) -> Light {
        let (sx, sy) = axis_scale(ts);
        // A z in user units reaches as far as a unit along the diagonal.
        let sz = (sx * sx + sy * sy).sqrt() / std::f32::consts::SQRT_2;
        let place = |x: f32, y: f32, z: f32| {
            let p = ts * Point::new(x as f64, y as f64);
            [p.x as f32, p.y as f32, z * sz]
        };
        match source {
            fe::LightSource::DistantLight(l) => {
                let (az, el) = (l.azimuth.to_radians(), l.elevation.to_radians());
                Light::Distant([az.cos() * el.cos(), az.sin() * el.cos(), el.sin()])
            }
            fe::LightSource::PointLight(l) => Light::Point(place(l.x, l.y, l.z)),
            fe::LightSource::SpotLight(l) => {
                let at = place(l.x, l.y, l.z);
                let to = place(l.points_at_x, l.points_at_y, l.points_at_z);
                Light::Spot {
                    at,
                    dir: norm3(sub3(to, at)),
                    exponent: l.specular_exponent.get(),
                    cone: l.limiting_cone_angle,
                }
            }
        }
    }
}

fn light_color(c: usvg::Color, space: Space) -> [f32; 3] {
    let mut rgb = [c.red, c.green, c.blue];
    if space == Space::LinearRGB {
        let t = srgb_to_linear_table();
        rgb = rgb.map(|v| t[v as usize]);
    }
    rgb.map(|v| v as f32)
}

enum Shade {
    Diffuse(f32),
    Specular(f32, f32),
}

/// `feDiffuseLighting` / `feSpecularLighting`: the input's alpha as a
/// height map (times `surfaceScale`), its normal from the
/// specification's Sobel kernels (one-sided at the edges), lit by one
/// light.
fn lighting(src: &Buf, light: &Light, scale: f32, color: [f32; 3], shade: Shade) -> Buf {
    let (w, h) = (src.w as i32, src.h as i32);
    let mut out = Buf::new(src.w, src.h);
    if w < 2 || h < 2 {
        return out;
    }
    let alpha = |x: i32, y: i32| src.px[(y * w + x) as usize][3] as f32 / 255.0;
    for y in 0..h {
        for x in 0..w {
            // Sobel, with the specification's edge and corner weights:
            // rows (or columns) weighted 1-2-1 where they exist, a
            // one-sided difference at the border.
            let gradient = |horizontal: bool| {
                let (pos, len) = if horizontal { (x, w) } else { (y, h) };
                let (cross, cross_len) = if horizontal { (y, h) } else { (x, w) };
                let (lo, hi) = ((pos - 1).max(0), (pos + 1).min(len - 1));
                let span = (hi - lo) as f32;
                let mut sum = 0.0;
                let mut weights = 0.0;
                for d in -1..=1 {
                    let c = cross + d;
                    if c < 0 || c >= cross_len {
                        continue;
                    }
                    let wt = if d == 0 { 2.0 } else { 1.0 };
                    let (a, b) = if horizontal {
                        (alpha(hi, c), alpha(lo, c))
                    } else {
                        (alpha(c, hi), alpha(c, lo))
                    };
                    sum += wt * (a - b);
                    weights += wt;
                }
                if span == 0.0 {
                    0.0
                } else {
                    2.0 / (weights * span) * sum
                }
            };
            let n = norm3([-scale * gradient(true), -scale * gradient(false), 1.0]);
            let surface = [x as f32, y as f32, scale * alpha(x, y)];
            let (l, rgb) = match light {
                Light::Distant(l) => (*l, color),
                Light::Point(at) => (norm3(sub3(*at, surface)), color),
                Light::Spot {
                    at,
                    dir,
                    exponent,
                    cone,
                } => {
                    let l = norm3(sub3(*at, surface));
                    let minus_l_dot_s = -dot3(l, *dir);
                    let lit = minus_l_dot_s > 0.0
                        && cone.is_none_or(|c| minus_l_dot_s >= c.to_radians().cos());
                    let k = if lit {
                        minus_l_dot_s.powf(*exponent)
                    } else {
                        0.0
                    };
                    (l, color.map(|c| c * k))
                }
            };
            let to8 = |v: f32| v.clamp(0.0, 255.0).round() as u8;
            out.px[(y * w + x) as usize] = match shade {
                Shade::Diffuse(kd) => {
                    let k = kd * dot3(n, l);
                    let c = rgb.map(|v| to8(v * k));
                    [c[0], c[1], c[2], 255]
                }
                Shade::Specular(ks, exp) => {
                    let hv = norm3([l[0], l[1], l[2] + 1.0]);
                    let k = ks * dot3(n, hv).max(0.0).powf(exp);
                    let c = rgb.map(|v| to8(v * k));
                    let a = c[0].max(c[1]).max(c[2]);
                    [c[0], c[1], c[2], a]
                }
            };
        }
    }
    out
}

#[cfg(test)]
mod tests {
    /// Render `body` in a 40 × 40 SVG at `scale` px per unit.
    fn render_at(body: &str, scale: f32) -> (Vec<u8>, u32) {
        let svg = format!(
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">{body}</svg>"##
        );
        let tree = usvg::Tree::from_str(&svg, &usvg::Options::default()).expect("parse");
        let n = (40.0 * scale) as u32;
        (
            crate::svg::rasterize_svg(&tree, n, n, scale).expect("render"),
            n,
        )
    }

    fn render(body: &str) -> Vec<u8> {
        render_at(body, 1.0).0
    }

    fn at(px: &[u8], w: u32, x: u32, y: u32) -> [u8; 4] {
        let i = ((y * w + x) * 4) as usize;
        [px[i], px[i + 1], px[i + 2], px[i + 3]]
    }

    #[test]
    fn a_blur_spreads_the_shape_past_its_edge() {
        let sharp = render(r##"<rect x="10" y="10" width="20" height="20" fill="black"/>"##);
        let soft = render(
            r##"<filter id="f" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3"/></filter>
               <rect x="10" y="10" width="20" height="20" fill="black" filter="url(#f)"/>"##,
        );
        assert_eq!(at(&sharp, 40, 7, 20)[3], 0);
        assert!(at(&soft, 40, 7, 20)[3] > 20, "{:?}", at(&soft, 40, 7, 20));
        assert!(at(&soft, 40, 20, 20)[3] > 240);
        // The edge itself sits at half coverage.
        assert!((100..=155).contains(&at(&soft, 40, 10, 20)[3]));
    }

    #[test]
    fn a_large_blur_takes_the_box_path_and_stays_centred() {
        let px = render(
            r##"<filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" width="40" height="40"><feGaussianBlur stdDeviation="6"/></filter>
               <rect x="18" y="18" width="4" height="4" fill="black" filter="url(#f)"/>"##,
        );
        let left = at(&px, 40, 12, 20)[3];
        let right = at(&px, 40, 27, 20)[3];
        assert!(left > 0 && left.abs_diff(right) <= 1, "{left} {right}");
    }

    #[test]
    fn the_classic_drop_shadow_lands_behind_and_below_right() {
        let px = render(
            r##"<filter id="s" x="-20%" y="-20%" width="160%" height="160%">
                 <feGaussianBlur in="SourceAlpha" stdDeviation="1" result="b"/>
                 <feOffset in="b" dx="6" dy="6" result="o"/>
                 <feFlood flood-color="#0000ff"/>
                 <feComposite in2="o" operator="in" result="t"/>
                 <feMerge><feMergeNode in="t"/><feMergeNode in="SourceGraphic"/></feMerge>
               </filter>
               <rect x="5" y="5" width="20" height="20" fill="#ff0000" filter="url(#s)"/>"##,
        );
        assert_eq!(at(&px, 40, 15, 15), [255, 0, 0, 255], "the art on top");
        let shadow = at(&px, 40, 28, 28);
        assert!(
            shadow[2] == 255 && shadow[0] == 0 && shadow[3] > 200,
            "{shadow:?}"
        );
        assert_eq!(at(&px, 40, 2, 28)[3], 0, "nothing up-left");
    }

    #[test]
    fn fe_drop_shadow_is_the_same_chain() {
        let px = render(
            r##"<filter id="s" x="-20%" y="-20%" width="160%" height="160%">
                 <feDropShadow dx="6" dy="6" stdDeviation="1" flood-color="#0000ff"/>
               </filter>
               <rect x="5" y="5" width="20" height="20" fill="#ff0000" filter="url(#s)"/>"##,
        );
        assert_eq!(at(&px, 40, 15, 15), [255, 0, 0, 255]);
        let shadow = at(&px, 40, 28, 28);
        assert!(shadow[2] == 255 && shadow[3] > 200, "{shadow:?}");
    }

    #[test]
    fn a_flood_fills_only_its_subregion() {
        let px = render(
            r##"<filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" width="40" height="40" primitiveUnits="userSpaceOnUse">
                 <feFlood flood-color="#00ff00" x="10" y="10" width="10" height="10"/>
               </filter>
               <rect width="40" height="40" fill="black" filter="url(#f)"/>"##,
        );
        assert_eq!(at(&px, 40, 15, 15), [0, 255, 0, 255]);
        assert_eq!(at(&px, 40, 25, 25), [0, 0, 0, 0]);
    }

    #[test]
    fn the_filter_region_clips_the_result() {
        let px = render(
            r##"<filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" width="20" height="40"><feOffset dx="0"/></filter>
               <rect width="40" height="40" fill="black" filter="url(#f)"/>"##,
        );
        assert_eq!(at(&px, 40, 10, 20)[3], 255);
        assert_eq!(at(&px, 40, 30, 20)[3], 0);
    }

    #[test]
    fn composite_operators_follow_porter_duff() {
        // Source: left half. Destination (moved copy): right half.
        let op = |name: &str| {
            render(&format!(
                r##"<filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" width="40" height="40">
                     <feOffset dx="10" result="d"/>
                     <feComposite in="SourceGraphic" in2="d" operator="{name}"/>
                   </filter>
                   <rect x="5" y="5" width="20" height="30" fill="black" filter="url(#f)"/>"##
            ))
        };
        let (only_src, both, only_dst) = ((8, 20), (20, 20), (30, 20));
        let a = |px: &[u8], (x, y): (u32, u32)| at(px, 40, x, y)[3];
        let over = op("over");
        assert_eq!(
            [a(&over, only_src), a(&over, both), a(&over, only_dst)],
            [255, 255, 255]
        );
        let inn = op("in");
        assert_eq!(
            [a(&inn, only_src), a(&inn, both), a(&inn, only_dst)],
            [0, 255, 0]
        );
        let out = op("out");
        assert_eq!(
            [a(&out, only_src), a(&out, both), a(&out, only_dst)],
            [255, 0, 0]
        );
        let atop = op("atop");
        assert_eq!(
            [a(&atop, only_src), a(&atop, both), a(&atop, only_dst)],
            [0, 255, 255]
        );
        let xor = op("xor");
        assert_eq!(
            [a(&xor, only_src), a(&xor, both), a(&xor, only_dst)],
            [255, 0, 255]
        );
    }

    #[test]
    fn arithmetic_composite_weighs_the_inputs() {
        // k2 = 0.5 of the source alone: half its alpha.
        let px = render(
            r##"<filter id="f"><feComposite in="SourceGraphic" in2="SourceGraphic" operator="arithmetic" k2="0.5"/></filter>
               <rect width="40" height="40" fill="white" filter="url(#f)"/>"##,
        );
        let p = at(&px, 40, 20, 20);
        assert!((126..=129).contains(&p[3]) && p[0] == 255, "{p:?}");
    }

    #[test]
    fn saturate_zero_turns_colour_grey() {
        let px = render(
            r##"<filter id="f" color-interpolation-filters="sRGB"><feColorMatrix type="saturate" values="0"/></filter>
               <rect width="40" height="40" fill="#ff0000" filter="url(#f)"/>"##,
        );
        let p = at(&px, 40, 20, 20);
        assert!(
            p[0] == p[1] && p[1] == p[2] && (50..=58).contains(&p[0]),
            "{p:?}"
        );
    }

    #[test]
    fn linear_rgb_is_the_default_working_space() {
        // A 50 % blend of black and white: 50 % in linear light reads
        // 188 in sRGB; in sRGB it reads 128.
        let body = |space: &str| {
            format!(
                r##"<filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" width="40" height="40" {space}>
                     <feFlood flood-color="white" result="w"/>
                     <feComposite in="SourceGraphic" in2="w" operator="arithmetic" k2="0.5" k3="0.5"/>
                   </filter>
                   <rect width="40" height="40" fill="black" filter="url(#f)"/>"##
            )
        };
        let linear = at(&render(&body("")), 40, 20, 20);
        let srgb = at(
            &render(&body(r##"color-interpolation-filters="sRGB""##)),
            40,
            20,
            20,
        );
        assert!((186..=190).contains(&linear[0]), "{linear:?}");
        assert!((126..=130).contains(&srgb[0]), "{srgb:?}");
    }

    #[test]
    fn blend_multiplies_onto_its_backdrop() {
        let px = render(
            r##"<filter id="f" x="0" y="0" width="1" height="1" color-interpolation-filters="sRGB">
                 <feFlood flood-color="#808080" result="bg"/>
                 <feBlend in="SourceGraphic" in2="bg" mode="multiply"/>
               </filter>
               <rect width="40" height="40" fill="#ff8000" filter="url(#f)"/>"##,
        );
        let p = at(&px, 40, 20, 20);
        assert!(
            p[0].abs_diff(128) <= 1 && p[1].abs_diff(64) <= 1 && p[2] == 0,
            "{p:?}"
        );
    }

    #[test]
    fn component_transfer_inverts_with_a_linear_function() {
        let px = render(
            r##"<filter id="f" color-interpolation-filters="sRGB"><feComponentTransfer>
                 <feFuncR type="linear" slope="-1" intercept="1"/>
                 <feFuncG type="discrete" tableValues="0 1"/>
               </feComponentTransfer></filter>
               <rect width="40" height="40" fill="#4080c0" filter="url(#f)"/>"##,
        );
        assert_eq!(at(&px, 40, 20, 20), [0xbf, 255, 0xc0, 255]);
    }

    #[test]
    fn morphology_grows_and_shrinks_by_the_radius() {
        let body = |op: &str| {
            format!(
                r##"<filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" width="40" height="40"><feMorphology operator="{op}" radius="3"/></filter>
                   <rect x="10" y="10" width="20" height="20" fill="black" filter="url(#f)"/>"##
            )
        };
        let dilated = render(&body("dilate"));
        assert_eq!(at(&dilated, 40, 7, 20)[3], 255);
        assert_eq!(at(&dilated, 40, 6, 20)[3], 0);
        let eroded = render(&body("erode"));
        assert_eq!(at(&eroded, 40, 13, 20)[3], 255);
        assert_eq!(at(&eroded, 40, 12, 20)[3], 0);
    }

    #[test]
    fn turbulence_is_deterministic_and_seeded() {
        let body = |seed: u32| {
            format!(
                r##"<filter id="f" x="0" y="0" width="1" height="1"><feTurbulence baseFrequency="0.1" numOctaves="2" seed="{seed}"/></filter>
                   <rect width="40" height="40" filter="url(#f)"/>"##
            )
        };
        let a = render(&body(1));
        assert_eq!(a, render(&body(1)));
        assert_ne!(a, render(&body(2)));
        let alphas: Vec<u8> = a.chunks(4).map(|p| p[3]).collect();
        assert!(alphas.iter().any(|&v| v > 40) && alphas.iter().any(|&v| v < 10));
    }

    #[test]
    fn a_flat_surface_under_a_distant_light_takes_the_sine_of_its_elevation() {
        let px = render(
            r##"<filter id="f" x="0" y="0" width="1" height="1" color-interpolation-filters="sRGB">
                 <feDiffuseLighting in="SourceGraphic" surfaceScale="0"><feDistantLight azimuth="0" elevation="30"/></feDiffuseLighting>
               </filter>
               <rect width="40" height="40" fill="black" filter="url(#f)"/>"##,
        );
        let p = at(&px, 40, 20, 20);
        assert_eq!(p[3], 255);
        assert!(p[0].abs_diff(128) <= 1, "{p:?}");
    }

    #[test]
    fn an_offset_scales_with_the_drawing() {
        let body = r##"<filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" width="40" height="40"><feOffset dx="5"/></filter>
                      <rect x="10" y="10" width="10" height="10" fill="black" filter="url(#f)"/>"##;
        let (px, w) = render_at(body, 2.0);
        assert_eq!(at(&px, w, 2 * 15 + 1, 30)[3], 255);
        assert_eq!(at(&px, w, 2 * 25 - 1, 30)[3], 255);
        assert_eq!(at(&px, w, 2 * 25 + 1, 30)[3], 0);
        assert_eq!(at(&px, w, 2 * 14, 30)[3], 0);
    }

    #[test]
    fn a_filter_with_no_region_hides_the_element() {
        let px = render(
            r##"<filter id="f" filterUnits="userSpaceOnUse" x="100" y="100" width="10" height="10"><feOffset/></filter>
               <rect width="40" height="40" fill="black" filter="url(#f)"/>"##,
        );
        assert!(px.chunks(4).all(|p| p[3] == 0));
    }

    #[test]
    fn a_filtered_group_keeps_its_opacity_and_clip() {
        let px = render(
            r##"<clipPath id="c"><rect width="20" height="40"/></clipPath>
               <filter id="f"><feOffset dx="0"/></filter>
               <g opacity="0.5" clip-path="url(#c)"><rect width="40" height="40" fill="black" filter="url(#f)"/></g>"##,
        );
        assert!((126..=130).contains(&at(&px, 40, 10, 20)[3]));
        assert_eq!(at(&px, 40, 30, 20)[3], 0);
    }
}

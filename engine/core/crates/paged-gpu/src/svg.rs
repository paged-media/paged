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

//! A placed SVG, rasterized with `vello_cpu`.
//!
//! `usvg` parses the file into a tree of groups and paths; this draws the
//! tree the way `resvg` does, on the rasterizer the engine already
//! carries, instead of linking a second one (tiny-skia) for it alone.
//! Paths take their fill rule, solid, gradient and pattern paints, and
//! strokes with dashes; a group isolates with its opacity, blend mode,
//! clip path and mask; a nested SVG image is drawn in place, and text
//! from usvg's outlines when usvg is built with fonts (it is not: see
//! paged-renderer's Cargo.toml). A group with filters is drawn into a
//! layer over its filter region, filtered ([`crate::svg_filter`]) and
//! composited like any other isolated group. Raster images inside an SVG
//! are not decoded, as with the `resvg` build this replaces.

use vello_cpu::kurbo::{self, Affine, BezPath, Rect, Shape};
use vello_cpu::peniko::{
    BlendMode, Color, ColorStop, Compose, Extend, Fill, Gradient, ImageAlphaType, ImageQuality,
    ImageSampler, InterpolationAlphaSpace, Mix,
};
use vello_cpu::{
    Image, ImageSource, Level, Mask, PixelMetadata, Pixmap, RasterizerSettings, RenderContext,
    RenderMode, RenderSettings, Resources, TargetInit,
};

/// Rasterize `tree` into a `width × height` RGBA8 buffer (straight alpha,
/// as `DecodedImage` holds pixels), its user space scaled by `scale`.
/// `None` for an empty or oversized target.
pub fn rasterize_svg(tree: &usvg::Tree, width: u32, height: u32, scale: f32) -> Option<Vec<u8>> {
    let w = u16::try_from(width).ok().filter(|w| *w > 0)?;
    let h = u16::try_from(height).ok().filter(|h| *h > 0)?;
    let mut svg = Svg::new(w, h);
    let pix = svg.render(tree.root(), Affine::scale(scale as f64));
    Some(pix.take_rgba8(ImageAlphaType::Alpha))
}

struct Svg {
    w: u16,
    h: u16,
    res: Resources,
    /// How far a filtered group's layer may reach, in this surface's
    /// pixels: the canvas and a quarter of it on every side. Content
    /// further out can only reach the canvas through a filter that moves
    /// it that far (a long offset, a wide blur); the bound keeps a filter
    /// region that names the whole plane from allocating it.
    reach: (i32, i32, i32, i32),
}

impl Svg {
    fn new(w: u16, h: u16) -> Svg {
        let (mx, my) = (w as i32 / 4, h as i32 / 4);
        Svg {
            w,
            h,
            res: Resources::new(),
            reach: (-mx, -my, w as i32 + mx, h as i32 + my),
        }
    }
}

/// Coverage per pixel, `w × h`.
type Coverage = Vec<u8>;

impl Svg {
    fn context(&self) -> RenderContext {
        let mut ctx = RenderContext::new_with(
            self.w,
            self.h,
            RenderSettings {
                level: Level::try_detect().unwrap_or(Level::baseline()),
                num_threads: 0,
            },
        );
        ctx.set_fill_rule(Fill::NonZero);
        ctx
    }

    fn finish(&mut self, mut ctx: RenderContext) -> Pixmap {
        ctx.flush();
        let mut pix = Pixmap::new(self.w, self.h);
        ctx.render_with(
            pix.as_mut(),
            &mut self.res,
            RasterizerSettings {
                render_mode: RenderMode::OptimizeSpeed,
                target_init: TargetInit::Clear(vello_cpu::color::AlphaColor::TRANSPARENT),
                ..RasterizerSettings::default()
            },
        );
        pix
    }

    /// `group`'s children, drawn into a fresh transparent buffer.
    fn render(&mut self, group: &usvg::Group, ts: Affine) -> Pixmap {
        let mut ctx = self.context();
        self.draw_children(&mut ctx, group, ts);
        self.finish(ctx)
    }

    fn draw_children(&mut self, ctx: &mut RenderContext, group: &usvg::Group, ts: Affine) {
        for node in group.children() {
            match node {
                usvg::Node::Group(g) => self.draw_group(ctx, g, ts),
                usvg::Node::Path(p) => self.draw_path(ctx, p, ts),
                usvg::Node::Image(image) => {
                    if let (true, usvg::ImageKind::SVG(tree)) = (image.is_visible(), image.kind()) {
                        self.draw_children(ctx, tree.root(), ts);
                    }
                }
                usvg::Node::Text(text) => self.draw_group(ctx, text.flattened(), ts),
            }
        }
    }

    fn draw_group(&mut self, ctx: &mut RenderContext, group: &usvg::Group, ts: Affine) {
        let ts = ts * affine(group.transform());
        if !group.should_isolate() {
            self.draw_children(ctx, group, ts);
            return;
        }
        let mut cov: Option<Coverage> = None;
        if let Some(clip) = group.clip_path() {
            cov = Some(multiply(cov, self.clip_coverage(clip, ts)));
        }
        if let Some(mask) = group.mask() {
            cov = Some(multiply(cov, self.mask_coverage(mask, ts)));
        }
        let mask = cov.map(|c| Mask::from_parts(c, self.w, self.h));
        ctx.set_transform(Affine::IDENTITY);
        ctx.push_layer(
            None,
            Some(BlendMode::new(mix(group.blend_mode()), Compose::SrcOver)),
            Some(group.opacity().get()),
            mask,
            None,
        );
        if group.filters().is_empty() {
            self.draw_children(ctx, group, ts);
        } else {
            self.draw_filtered(ctx, group, ts);
        }
        ctx.pop_layer();
    }

    /// A filtered group: its children drawn into a layer over its filter
    /// region, every filter run over that layer in turn, and the result
    /// drawn back. A filter works in the group's own axes: under a
    /// rotation or a skew the layer is laid out along them, at the device
    /// resolution, and drawn back through the rest of the transform,
    /// resampled. Otherwise the layer is whole device pixels, sized as
    /// `resvg` sizes it, and goes back pixel for pixel.
    fn draw_filtered(&mut self, ctx: &mut RenderContext, group: &usvg::Group, ts: Affine) {
        let [a, b, c, d, e, f] = ts.as_coeffs();
        let axis_aligned = b.abs() < 1e-9 && c.abs() < 1e-9 && a > 0.0 && d > 0.0;
        // `local` maps user space onto the layer's pixel grid (before its
        // origin is chosen), `back` that grid onto this surface.
        let (local, back) = if axis_aligned {
            (ts, Affine::IDENTITY)
        } else {
            let (sx, sy) = (a.hypot(b), c.hypot(d));
            if sx < 1e-9 || sy < 1e-9 {
                return;
            }
            (
                Affine::scale_non_uniform(sx, sy),
                Affine::new([a / sx, b / sx, c / sy, d / sy, e, f]),
            )
        };
        let bbox = crate::svg_filter::device_rect(group.layer_bounding_box(), local);
        let (rx0, ry0, rx1, ry1) = self.reach;
        let reach = if axis_aligned {
            Rect::new(rx0 as f64, ry0 as f64, rx1 as f64, ry1 as f64)
        } else {
            let inv = back.inverse();
            let corners = [(rx0, ry0), (rx1, ry0), (rx1, ry1), (rx0, ry1)]
                .map(|(x, y)| inv * kurbo::Point::new(x as f64, y as f64));
            corners[1..]
                .iter()
                .fold(Rect::from_points(corners[0], corners[0]), |r, p| {
                    r.union_pt(*p)
                })
        };
        let (x0, y0) = (bbox.x0.floor(), bbox.y0.floor());
        let (x1, y1) = (
            x0 + bbox.width().ceil().max(1.0),
            y0 + bbox.height().ceil().max(1.0),
        );
        let (lx0, ly0) = (reach.x0.floor(), reach.y0.floor());
        let (lx1, ly1) = (reach.x1.ceil(), reach.y1.ceil());
        let (x0, y0, x1, y1) = (x0.max(lx0), y0.max(ly0), x1.min(lx1), y1.min(ly1));
        if !(x0 < x1 && y0 < y1) || x1 - x0 > u16::MAX as f64 || y1 - y0 > u16::MAX as f64 {
            return;
        }
        let (w, h) = ((x1 - x0) as u16, (y1 - y0) as u16);
        let to_layer = Affine::translate((-x0, -y0)) * local;
        let mut layer = Svg {
            w,
            h,
            res: Resources::new(),
            reach: (
                (lx0 - x0) as i32,
                (ly0 - y0) as i32,
                (lx1 - x0) as i32,
                (ly1 - y0) as i32,
            ),
        };
        let mut buf = to_buf(&layer.render(group, to_layer));
        for filter in group.filters() {
            crate::svg_filter::apply(filter, to_layer, &mut buf, &mut |g, place, w, h| {
                let mut s = Svg::new(w as u16, h as u16);
                to_buf(&s.render(g, place))
            });
        }
        let pix = from_buf(buf);
        ctx.set_transform(back * Affine::translate((x0, y0)));
        ctx.set_paint(Image {
            image: ImageSource::Pixmap(std::sync::Arc::new(pix)),
            sampler: ImageSampler::new()
                .with_extend(Extend::Pad)
                .with_quality(if axis_aligned {
                    ImageQuality::Low
                } else {
                    ImageQuality::Medium
                }),
        });
        ctx.fill_rect(&Rect::new(0.0, 0.0, w as f64, h as f64));
    }

    fn draw_path(&mut self, ctx: &mut RenderContext, path: &usvg::Path, ts: Affine) {
        if !path.is_visible() {
            return;
        }
        let crisp = !path.rendering_mode().use_shape_antialiasing();
        ctx.set_aliasing_threshold(crisp.then_some(128));
        if path.paint_order() == usvg::PaintOrder::FillAndStroke {
            self.fill_path(ctx, path, ts);
            self.stroke_path(ctx, path, ts);
        } else {
            self.stroke_path(ctx, path, ts);
            self.fill_path(ctx, path, ts);
        }
        ctx.set_aliasing_threshold(None);
    }

    fn fill_path(&mut self, ctx: &mut RenderContext, path: &usvg::Path, ts: Affine) {
        let Some(fill) = path.fill() else {
            return;
        };
        let bounds = path.data().bounds();
        if bounds.width() == 0.0 || bounds.height() == 0.0 {
            return;
        }
        let bez = bez(path.data());
        ctx.set_fill_rule(match fill.rule() {
            usvg::FillRule::NonZero => Fill::NonZero,
            usvg::FillRule::EvenOdd => Fill::EvenOdd,
        });
        self.paint(ctx, fill.paint(), fill.opacity(), ts, |ctx| {
            ctx.fill_path(&bez)
        });
        ctx.set_fill_rule(Fill::NonZero);
    }

    fn stroke_path(&mut self, ctx: &mut RenderContext, path: &usvg::Path, ts: Affine) {
        let Some(stroke) = path.stroke() else {
            return;
        };
        let mut ks = kurbo::Stroke::new(stroke.width().get() as f64)
            .with_join(match stroke.linejoin() {
                usvg::LineJoin::Miter | usvg::LineJoin::MiterClip => kurbo::Join::Miter,
                usvg::LineJoin::Round => kurbo::Join::Round,
                usvg::LineJoin::Bevel => kurbo::Join::Bevel,
            })
            .with_caps(match stroke.linecap() {
                usvg::LineCap::Butt => kurbo::Cap::Butt,
                usvg::LineCap::Round => kurbo::Cap::Round,
                usvg::LineCap::Square => kurbo::Cap::Square,
            })
            .with_miter_limit(stroke.miterlimit().get() as f64);
        if let Some(dashes) = stroke.dasharray() {
            ks = ks.with_dashes(stroke.dashoffset() as f64, dashes.iter().map(|d| *d as f64));
        }
        let bez = bez(path.data());
        ctx.set_stroke(ks);
        self.paint(ctx, stroke.paint(), stroke.opacity(), ts, |ctx| {
            ctx.stroke_path(&bez)
        });
    }

    /// Set `paint` (at `opacity`) and run `draw` with the path transform
    /// `ts`.
    fn paint(
        &mut self,
        ctx: &mut RenderContext,
        paint: &usvg::Paint,
        opacity: usvg::Opacity,
        ts: Affine,
        draw: impl FnOnce(&mut RenderContext),
    ) {
        ctx.set_transform(ts);
        ctx.reset_paint_transform();
        match paint {
            usvg::Paint::Color(c) => {
                ctx.set_paint(Color::from_rgba8(c.red, c.green, c.blue, opacity.to_u8()));
                draw(ctx);
            }
            usvg::Paint::LinearGradient(g) => {
                let mut gradient = Gradient::new_linear(
                    (g.x1() as f64, g.y1() as f64),
                    (g.x2() as f64, g.y2() as f64),
                );
                gradient.extend = extend(g.spread_method());
                gradient.interpolation_alpha_space = InterpolationAlphaSpace::Unpremultiplied;
                ctx.set_paint(gradient.with_stops(stops(g.stops(), opacity).as_slice()));
                ctx.set_paint_transform(affine(g.transform()));
                draw(ctx);
            }
            usvg::Paint::RadialGradient(g) => {
                let mut gradient = Gradient::new_two_point_radial(
                    (g.fx() as f64, g.fy() as f64),
                    g.fr().get(),
                    (g.cx() as f64, g.cy() as f64),
                    g.r().get(),
                );
                gradient.extend = extend(g.spread_method());
                gradient.interpolation_alpha_space = InterpolationAlphaSpace::Unpremultiplied;
                ctx.set_paint(gradient.with_stops(stops(g.stops(), opacity).as_slice()));
                ctx.set_paint_transform(affine(g.transform()));
                draw(ctx);
            }
            usvg::Paint::Pattern(pattern) => {
                let Some((tile, tile_ts)) = self.pattern_tile(pattern, ts) else {
                    return;
                };
                // A tile that lands on whole device pixels is copied, as
                // tiny-skia (and Skia) do: a bicubic filter at pixel
                // centres still softens it.
                let [a, b, c, d, e, f] = (ts * tile_ts).as_coeffs();
                let whole = |v: f64| (v - v.round()).abs() < 1e-3;
                let aligned = (a - 1.0).abs() < 1e-6
                    && (d - 1.0).abs() < 1e-6
                    && b.abs() < 1e-6
                    && c.abs() < 1e-6
                    && whole(e)
                    && whole(f);
                ctx.set_paint(Image {
                    image: ImageSource::Pixmap(std::sync::Arc::new(tile)),
                    sampler: ImageSampler::new()
                        .with_extend(Extend::Repeat)
                        .with_quality(if aligned {
                            ImageQuality::Low
                        } else {
                            ImageQuality::High
                        }),
                });
                ctx.set_paint_transform(tile_ts);
                let fade = opacity.get() < 1.0;
                if fade {
                    ctx.push_opacity_layer(opacity.get());
                }
                draw(ctx);
                if fade {
                    ctx.pop_layer();
                }
            }
        }
        ctx.reset_paint_transform();
    }

    /// A pattern's tile at the device scale it is drawn at, and the paint
    /// transform that places it.
    fn pattern_tile(&mut self, pattern: &usvg::Pattern, ts: Affine) -> Option<(Pixmap, Affine)> {
        let [a, b, c, d, _, _] = (ts * affine(pattern.transform())).as_coeffs();
        let (sx, sy) = (a.hypot(b), c.hypot(d));
        let rect = pattern.rect();
        let w = (rect.width() as f64 * sx).round();
        let h = (rect.height() as f64 * sy).round();
        if !(1.0..=u16::MAX as f64).contains(&w) || !(1.0..=u16::MAX as f64).contains(&h) {
            return None;
        }
        let mut tile = Svg::new(w as u16, h as u16);
        let pix = tile.render(pattern.root(), Affine::scale_non_uniform(sx, sy));
        let place = affine(pattern.transform())
            * Affine::translate((rect.x() as f64, rect.y() as f64))
            * Affine::scale_non_uniform(1.0 / sx, 1.0 / sy);
        Some((pix, place))
    }

    /// The coverage of a clip path: the union of its shapes, each filled
    /// with its clip rule, cut by the clip path's own clip path.
    fn clip_coverage(&mut self, clip: &usvg::ClipPath, ts: Affine) -> Coverage {
        let ts = ts * affine(clip.transform());
        let mut ctx = self.context();
        let mut nested = Vec::new();
        self.draw_clip_shapes(&mut ctx, clip.root(), ts, &mut nested);
        let mut cov = alpha(&self.finish(ctx));
        for other in nested {
            for (c, o) in cov.iter_mut().zip(other) {
                *c = (*c as u16 + o as u16 - mul(*c, o) as u16) as u8;
            }
        }
        if let Some(inner) = clip.clip_path() {
            cov = multiply(Some(cov), self.clip_coverage(inner, ts));
        }
        cov
    }

    /// Fill a clip path's shapes opaque into `ctx`. A child group with a
    /// clip path of its own is clipped on its own buffer and handed back
    /// in `nested`, to be united with the rest.
    fn draw_clip_shapes(
        &mut self,
        ctx: &mut RenderContext,
        group: &usvg::Group,
        ts: Affine,
        nested: &mut Vec<Coverage>,
    ) {
        for node in group.children() {
            match node {
                usvg::Node::Path(path) => {
                    let Some(fill) = path.fill().filter(|_| path.is_visible()) else {
                        continue;
                    };
                    ctx.set_transform(ts);
                    ctx.set_fill_rule(match fill.rule() {
                        usvg::FillRule::NonZero => Fill::NonZero,
                        usvg::FillRule::EvenOdd => Fill::EvenOdd,
                    });
                    ctx.set_paint(Color::BLACK);
                    ctx.fill_path(&bez(path.data()));
                    ctx.set_fill_rule(Fill::NonZero);
                }
                usvg::Node::Text(text) => self.draw_clip_shapes(ctx, text.flattened(), ts, nested),
                usvg::Node::Group(g) => {
                    let ts = ts * affine(g.transform());
                    match g.clip_path() {
                        Some(clip) => {
                            let mut own = self.context();
                            let mut deeper = Vec::new();
                            self.draw_clip_shapes(&mut own, g, ts, &mut deeper);
                            let mut cov = alpha(&self.finish(own));
                            for other in deeper {
                                for (c, o) in cov.iter_mut().zip(other) {
                                    *c = (*c as u16 + o as u16 - mul(*c, o) as u16) as u8;
                                }
                            }
                            nested.push(multiply(Some(cov), self.clip_coverage(clip, ts)));
                        }
                        None => self.draw_clip_shapes(ctx, g, ts, nested),
                    }
                }
                usvg::Node::Image(_) => {}
            }
        }
    }

    /// The coverage of a mask: its content drawn inside its region, read
    /// as luminance or alpha, times its own mask.
    fn mask_coverage(&mut self, mask: &usvg::Mask, ts: Affine) -> Coverage {
        let n = self.w as usize * self.h as usize;
        if mask.root().children().is_empty() {
            return vec![0; n];
        }
        let mut ctx = self.context();
        let r = mask.rect();
        ctx.set_transform(ts);
        ctx.push_clip_layer(
            &Rect::new(
                r.x() as f64,
                r.y() as f64,
                r.right() as f64,
                r.bottom() as f64,
            )
            .to_path(0.1),
        );
        self.draw_children(&mut ctx, mask.root(), ts);
        ctx.pop_layer();
        let pix = self.finish(ctx);
        let cov = match mask.kind() {
            usvg::MaskType::Alpha => alpha(&pix),
            // CSS Masking: the luminance of the premultiplied colour.
            usvg::MaskType::Luminance => pix
                .data()
                .iter()
                .map(|p| {
                    let luma = p.r as f32 * 0.2126 + p.g as f32 * 0.7152 + p.b as f32 * 0.0722;
                    (luma + 0.5).min(255.0) as u8
                })
                .collect(),
        };
        match mask.mask() {
            Some(inner) => multiply(Some(cov), self.mask_coverage(inner, ts)),
            None => cov,
        }
    }
}

fn affine(t: usvg::Transform) -> Affine {
    Affine::new([
        t.sx as f64,
        t.ky as f64,
        t.kx as f64,
        t.sy as f64,
        t.tx as f64,
        t.ty as f64,
    ])
}

fn bez(path: &usvg::tiny_skia_path::Path) -> BezPath {
    use usvg::tiny_skia_path::PathSegment as S;
    let pt = |p: usvg::tiny_skia_path::Point| kurbo::Point::new(p.x as f64, p.y as f64);
    let mut out = BezPath::new();
    for seg in path.segments() {
        match seg {
            S::MoveTo(p) => out.move_to(pt(p)),
            S::LineTo(p) => out.line_to(pt(p)),
            S::QuadTo(c, p) => out.quad_to(pt(c), pt(p)),
            S::CubicTo(c1, c2, p) => out.curve_to(pt(c1), pt(c2), pt(p)),
            S::Close => out.close_path(),
        }
    }
    out
}

fn stops(stops: &[usvg::Stop], opacity: usvg::Opacity) -> Vec<ColorStop> {
    stops
        .iter()
        .map(|s| {
            let c = s.color();
            let a = (s.opacity() * opacity).to_u8();
            ColorStop {
                offset: s.offset().get(),
                color: Color::from_rgba8(c.red, c.green, c.blue, a).into(),
            }
        })
        .collect()
}

fn extend(spread: usvg::SpreadMethod) -> Extend {
    match spread {
        usvg::SpreadMethod::Pad => Extend::Pad,
        usvg::SpreadMethod::Reflect => Extend::Reflect,
        usvg::SpreadMethod::Repeat => Extend::Repeat,
    }
}

fn mix(mode: usvg::BlendMode) -> Mix {
    match mode {
        usvg::BlendMode::Normal => Mix::Normal,
        usvg::BlendMode::Multiply => Mix::Multiply,
        usvg::BlendMode::Screen => Mix::Screen,
        usvg::BlendMode::Overlay => Mix::Overlay,
        usvg::BlendMode::Darken => Mix::Darken,
        usvg::BlendMode::Lighten => Mix::Lighten,
        usvg::BlendMode::ColorDodge => Mix::ColorDodge,
        usvg::BlendMode::ColorBurn => Mix::ColorBurn,
        usvg::BlendMode::HardLight => Mix::HardLight,
        usvg::BlendMode::SoftLight => Mix::SoftLight,
        usvg::BlendMode::Difference => Mix::Difference,
        usvg::BlendMode::Exclusion => Mix::Exclusion,
        usvg::BlendMode::Hue => Mix::Hue,
        usvg::BlendMode::Saturation => Mix::Saturation,
        usvg::BlendMode::Color => Mix::Color,
        usvg::BlendMode::Luminosity => Mix::Luminosity,
    }
}

fn to_buf(pix: &Pixmap) -> crate::svg_filter::Buf {
    crate::svg_filter::Buf {
        w: pix.width() as u32,
        h: pix.height() as u32,
        px: pix.data().iter().map(|p| [p.r, p.g, p.b, p.a]).collect(),
    }
}

fn from_buf(buf: crate::svg_filter::Buf) -> Pixmap {
    Pixmap::from_parts(
        buf.px.into_flattened(),
        buf.w as u16,
        buf.h as u16,
        PixelMetadata {
            may_have_transparency: true,
            alpha_type: ImageAlphaType::AlphaPremultiplied,
        },
    )
}

fn alpha(pix: &Pixmap) -> Coverage {
    pix.data().iter().map(|p| p.a).collect()
}

fn mul(a: u8, b: u8) -> u8 {
    ((a as u16 * b as u16 + 127) / 255) as u8
}

fn multiply(a: Option<Coverage>, b: Coverage) -> Coverage {
    match a {
        None => b,
        Some(mut a) => {
            for (x, y) in a.iter_mut().zip(b) {
                *x = mul(*x, y);
            }
            a
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Render `svg` (a 40 × 40 user space) at 1 px per unit.
    fn render(svg: &str) -> Vec<u8> {
        let tree = usvg::Tree::from_str(svg, &usvg::Options::default()).expect("parse");
        rasterize_svg(&tree, 40, 40, 1.0).expect("render")
    }

    fn at(px: &[u8], x: usize, y: usize) -> [u8; 4] {
        let i = (y * 40 + x) * 4;
        [px[i], px[i + 1], px[i + 2], px[i + 3]]
    }

    fn doc(body: &str) -> String {
        format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">{body}</svg>"#
        )
    }

    #[test]
    fn a_fill_paints_inside_and_leaves_the_rest_transparent() {
        let px = render(&doc(
            r##"<rect x="10" y="10" width="20" height="20" fill="#ff0000"/>"##,
        ));
        assert_eq!(at(&px, 20, 20), [255, 0, 0, 255]);
        assert_eq!(at(&px, 5, 5), [0, 0, 0, 0]);
    }

    #[test]
    fn pixels_come_back_with_straight_alpha() {
        let px = render(&doc(
            r##"<rect width="40" height="40" fill="#ff0000" fill-opacity="0.5"/>"##,
        ));
        let p = at(&px, 20, 20);
        assert_eq!(p[0], 255, "{p:?}");
        assert!((127..=129).contains(&p[3]), "{p:?}");
    }

    #[test]
    fn the_fill_rule_decides_the_hole() {
        // Two squares wound the same way: non-zero fills the inner one,
        // even-odd leaves it empty.
        let d = "M5 5H35V35H5Z M15 15H25V25H15Z";
        let nonzero = render(&doc(&format!(r#"<path d="{d}" fill="black"/>"#)));
        let evenodd = render(&doc(&format!(
            r#"<path d="{d}" fill="black" fill-rule="evenodd"/>"#
        )));
        assert_eq!(at(&nonzero, 20, 20)[3], 255);
        assert_eq!(at(&evenodd, 20, 20)[3], 0);
        assert_eq!(at(&evenodd, 10, 10)[3], 255);
    }

    #[test]
    fn a_linear_gradient_runs_across_the_shape() {
        let px = render(&doc(
            r##"<linearGradient id="g" x1="0" y1="0" x2="1" y2="0">
                 <stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/>
               </linearGradient>
               <rect width="40" height="40" fill="url(#g)"/>"##,
        ));
        let (left, right) = (at(&px, 1, 20), at(&px, 38, 20));
        assert!(left[0] > 230 && left[2] < 25, "{left:?}");
        assert!(right[2] > 230 && right[0] < 25, "{right:?}");
    }

    #[test]
    fn a_dashed_stroke_leaves_gaps() {
        let px = render(&doc(
            r#"<path d="M0 20H40" stroke="black" stroke-width="4" stroke-dasharray="5 5"/>"#,
        ));
        assert_eq!(at(&px, 2, 20)[3], 255, "in the first dash");
        assert_eq!(at(&px, 7, 20)[3], 0, "in the first gap");
        assert_eq!(at(&px, 12, 20)[3], 255, "in the second dash");
        assert_eq!(at(&px, 2, 10)[3], 0, "off the line");
    }

    #[test]
    fn a_group_is_drawn_at_its_opacity() {
        let px = render(&doc(
            r#"<g opacity="0.5"><rect width="40" height="40" fill="black"/>
               <rect width="20" height="40" fill="black"/></g>"#,
        ));
        // Isolated: the overlap is one layer at half opacity, not two.
        let (one, both) = (at(&px, 30, 20)[3], at(&px, 10, 20)[3]);
        assert!((126..=130).contains(&one), "{one}");
        assert_eq!(one, both);
    }

    #[test]
    fn a_clip_path_cuts_the_group() {
        let px = render(&doc(
            r#"<clipPath id="c"><circle cx="20" cy="20" r="10"/></clipPath>
               <rect width="40" height="40" fill="black" clip-path="url(#c)"/>"#,
        ));
        assert_eq!(at(&px, 20, 20)[3], 255);
        assert_eq!(at(&px, 2, 2)[3], 0);
        assert_eq!(at(&px, 36, 20)[3], 0);
    }

    #[test]
    fn a_luminance_mask_shows_where_it_is_white() {
        let px = render(&doc(
            r#"<mask id="m"><rect width="20" height="40" fill="white"/></mask>
               <rect width="40" height="40" fill="black" mask="url(#m)"/>"#,
        ));
        assert_eq!(at(&px, 5, 20)[3], 255);
        assert_eq!(at(&px, 35, 20)[3], 0);
    }

    #[test]
    fn a_pattern_repeats_its_tile() {
        let px = render(&doc(
            r#"<pattern id="p" width="10" height="10" patternUnits="userSpaceOnUse">
                 <rect width="5" height="10" fill="black"/>
               </pattern>
               <rect width="40" height="40" fill="url(#p)"/>"#,
        ));
        for x in [2, 12, 22, 32] {
            assert!(at(&px, x, 20)[3] > 200, "tile at {x}");
            assert!(at(&px, x + 5, 20)[3] < 55, "gap at {}", x + 5);
        }
    }

    #[test]
    fn the_scale_maps_user_space_to_pixels() {
        let tree = usvg::Tree::from_str(
            &doc(r#"<rect x="10" y="10" width="10" height="10" fill="black"/>"#),
            &usvg::Options::default(),
        )
        .expect("parse");
        let px = rasterize_svg(&tree, 80, 80, 2.0).expect("render");
        let a = |x: usize, y: usize| px[(y * 80 + x) * 4 + 3];
        assert_eq!(a(30, 30), 255);
        assert_eq!(a(15, 15), 0);
        assert_eq!(a(45, 45), 0);
    }
}

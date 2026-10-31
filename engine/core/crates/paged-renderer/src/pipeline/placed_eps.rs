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

//! A placed EPS drawn from its own PostScript (engine ADR 1033).
//!
//! `paged-ps` runs the program and hands back what it draws in
//! PostScript's default user space; [`prepare`] converts it once (paths,
//! the paints through the document's CMYK transform, images to RGBA) and
//! [`draw`] lays it into the page's display list at the placement's
//! transform, clipped to the bounding box, so the art stays vector on the
//! canvas and in the PDF export. A program the interpreter refuses (an
//! error nothing caught, a resource limit) leaves the EPS to the raster
//! path, whose preview (WP1.5) is the fallback.

use paged_color::math::srgb_to_linear as linear;
use paged_compose::{
    Color, DashPattern, DecodedImage, DisplayCommand, DisplayList, FillRule, GradientStop, LineCap,
    LineJoin, LinearGradient, Paint, PathData, PathSegment, RadialGradient, Stroke, Transform,
};
use paged_ps::{Element, GradientKind, Pixels};

use super::PipelineOptions;

/// True for bytes that open as PostScript (`%!PS`, or a DOS-binary EPS
/// around it).
pub(crate) fn is_eps(bytes: &[u8]) -> bool {
    paged_ps::is_postscript(bytes)
}

/// An interpreted EPS, ready to draw: `width` × `height` points, its
/// image space y-down from the bounding box's top-left corner.
pub(crate) struct EpsArt {
    pub width: f32,
    pub height: f32,
    /// Default user space → image space.
    flip: Transform,
    ops: Vec<Op>,
}

enum Op {
    Fill(PathData, Paint),
    Stroke(PathData, Transform, Stroke, Paint),
    Clip(PathData),
    PopClip,
    Image(DecodedImage, Transform),
    Ramp(Ramp),
}

struct Ramp {
    radial: bool,
    coords: [f32; 4],
    stops: Vec<GradientStop>,
    /// The area to cover, in shading space.
    quad: PathData,
    /// Shading space → default user space.
    transform: Transform,
}

/// The host's fonts for a font the EPS names but does not embed: the
/// document's resolver by the font's family and style, else the
/// fallback face.
struct Fonts<'a> {
    options: &'a PipelineOptions<'a>,
}

/// `Helvetica-BoldOblique` → (`Helvetica`, `Bold Oblique`).
fn family_and_style(name: &str) -> (String, Option<String>) {
    let (family, style) = match name.split_once('-') {
        Some((f, s)) => (f, Some(s)),
        None => (name, None),
    };
    let style = style.map(|s| {
        let mut out = String::new();
        for (k, c) in s.chars().enumerate() {
            if k > 0 && c.is_ascii_uppercase() {
                out.push(' ');
            }
            out.push(c);
        }
        if out == "Roman" {
            "Regular".to_string()
        } else {
            out
        }
    });
    (family.to_string(), style)
}

impl paged_ps::FontProvider for Fonts<'_> {
    fn face(&self, name: &str) -> Option<paged_ps::Face> {
        let (family, style) = family_and_style(name);
        if let Some(r) = self.options.assets {
            if let Some(f) = r.resolve_font_traced(&family, style.as_deref()) {
                let label = if f.substituted {
                    format!("a substitute for {family}")
                } else {
                    match &style {
                        Some(s) => format!("{family} {s}"),
                        None => family.clone(),
                    }
                };
                return Some(paged_ps::Face {
                    data: std::sync::Arc::from(f.bytes.as_ref()),
                    index: 0,
                    name: label,
                });
            }
        }
        self.options.font.map(|b| paged_ps::Face {
            data: std::sync::Arc::from(b),
            index: 0,
            name: "the fallback face".to_string(),
        })
    }
}

/// Interpret `bytes` and convert what it draws, or `None` when the
/// program does not run to its end (logged).
pub(crate) fn prepare(bytes: &[u8], options: &PipelineOptions<'_>) -> Option<EpsArt> {
    let fonts = Fonts { options };
    let art = match paged_ps::interpret(
        bytes,
        &paged_ps::Options {
            fonts: Some(&fonts),
            ..paged_ps::Options::default()
        },
    ) {
        Ok(art) => art,
        Err(error) => {
            tracing::warn!(%error, "placed EPS not interpreted; its preview stands in");
            return None;
        }
    };
    for (font, face) in &art.report.substituted_fonts {
        tracing::info!(
            font,
            face = face.as_deref().unwrap_or("none"),
            "EPS font substituted"
        );
    }
    for what in &art.report.unsupported {
        tracing::info!(what, "EPS feature skipped");
    }
    let [x0, y0, x1, y1] = art.bbox;
    let cmyk = options
        .cmyk_icc_profile
        .and_then(|p| match options.cmyk_transform_cache {
            Some(cache) => cache.get(p, options.cmyk_intent, options.cmyk_bpc),
            None => {
                super::color_paint::build_cmyk_transform(p, options.cmyk_intent, options.cmyk_bpc)
                    .map(super::color_paint::CmykTransformRef::Owned)
            }
        });
    let icc = cmyk.as_deref();
    let mut ops = Vec::with_capacity(art.elements.len());
    for e in &art.elements {
        ops.push(match e {
            Element::Fill { path, rule, paint } => Op::Fill(
                path_data(path).with_fill_rule(fill_rule(*rule)),
                to_paint(&paint.color, icc),
            ),
            Element::Stroke {
                path,
                transform,
                style,
                paint,
            } => {
                let mut s = Stroke::new(style.width as f32);
                s.cap = match style.cap {
                    paged_ps::LineCap::Butt => LineCap::Butt,
                    paged_ps::LineCap::Round => LineCap::Round,
                    paged_ps::LineCap::Square => LineCap::Square,
                };
                s.join = match style.join {
                    paged_ps::LineJoin::Miter => LineJoin::Miter,
                    paged_ps::LineJoin::Round => LineJoin::Round,
                    paged_ps::LineJoin::Bevel => LineJoin::Bevel,
                };
                s.miter_limit = style.miter_limit as f32;
                if !style.dash.is_empty() {
                    let d: Vec<f32> = style.dash.iter().map(|v| *v as f32).collect();
                    s.dash = DashPattern::from_slice(&d);
                }
                Op::Stroke(
                    path_data(path),
                    transform_of(transform),
                    s,
                    to_paint(&paint.color, icc),
                )
            }
            Element::PushClip { path, rule } => {
                Op::Clip(path_data(path).with_fill_rule(fill_rule(*rule)))
            }
            Element::PopClip => Op::PopClip,
            Element::Image(img) => match decoded(img, options) {
                Some(d) => Op::Image(d, transform_of(&img.transform)),
                None => continue,
            },
            Element::Gradient(g) => {
                if g.transform.determinant() == 0.0 {
                    continue;
                }
                let inv = g.transform.inverse();
                let a = g.area;
                let mut quad = paged_ps::BezPath::new();
                quad.move_to(inv * paged_ps::Point::new(a[0], a[1]));
                quad.line_to(inv * paged_ps::Point::new(a[2], a[1]));
                quad.line_to(inv * paged_ps::Point::new(a[2], a[3]));
                quad.line_to(inv * paged_ps::Point::new(a[0], a[3]));
                quad.close_path();
                let (radial, coords) = match g.kind {
                    GradientKind::Axial { x0, y0, x1, y1 } => {
                        (false, [x0 as f32, y0 as f32, x1 as f32, y1 as f32])
                    }
                    GradientKind::Radial { cx, cy, r1, .. } => {
                        (true, [cx as f32, cy as f32, r1 as f32, 0.0])
                    }
                };
                Op::Ramp(Ramp {
                    radial,
                    coords,
                    stops: g
                        .stops
                        .iter()
                        .map(|(t, c)| GradientStop {
                            offset: *t,
                            color: match to_paint(c, icc) {
                                Paint::Cmyk { rgb, .. } => rgb,
                                Paint::Solid(c) => c,
                                _ => Color::BLACK,
                            },
                        })
                        .collect(),
                    quad: path_data(&quad),
                    transform: transform_of(&g.transform),
                })
            }
        });
    }
    Some(EpsArt {
        width: (x1 - x0) as f32,
        height: (y1 - y0) as f32,
        flip: Transform([1.0, 0.0, 0.0, -1.0, -x0 as f32, y1 as f32]),
        ops,
    })
}

/// Lay `art` into `list`: `t` maps its image space (points, y down from
/// the bounding box's top-left) into page space.
pub(crate) fn draw(art: &EpsArt, t: Transform, list: &mut DisplayList) {
    let base = t.compose(&art.flip);
    // The art shows within its bounding box, as InDesign shows it.
    let bbox = list.paths.push_anon(rect(0.0, 0.0, art.width, art.height));
    list.push(DisplayCommand::PushClip {
        path_id: bbox,
        transform: t,
    });
    let mut open = 0usize;
    for op in &art.ops {
        match op {
            Op::Fill(path, paint) => {
                let id = list.paths.push_anon(path.clone());
                list.push(DisplayCommand::FillPath {
                    path_id: id,
                    paint: *paint,
                    transform: base,
                });
            }
            Op::Stroke(path, ctm, stroke, paint) => {
                let id = list.paths.push_anon(path.clone());
                list.push(DisplayCommand::StrokePath {
                    path_id: id,
                    paint: *paint,
                    stroke: *stroke,
                    transform: base.compose(ctm),
                });
            }
            Op::Clip(path) => {
                let id = list.paths.push_anon(path.clone());
                list.push(DisplayCommand::PushClip {
                    path_id: id,
                    transform: base,
                });
                open += 1;
            }
            Op::PopClip => {
                if open > 0 {
                    open -= 1;
                    list.push(DisplayCommand::PopClip(Transform::IDENTITY));
                }
            }
            Op::Image(img, unit) => {
                let image_id = list.push_image(img.clone());
                list.push(DisplayCommand::Image {
                    image_id,
                    transform: base.compose(unit),
                });
            }
            Op::Ramp(r) => {
                let [a, b, c, d] = r.coords;
                let paint = if r.radial {
                    Paint::RadialGradient(list.push_radial_gradient(RadialGradient {
                        center: (a, b),
                        radius: c,
                        stops: r.stops.clone(),
                    }))
                } else {
                    Paint::LinearGradient(list.push_linear_gradient(LinearGradient {
                        start: (a, b),
                        end: (c, d),
                        stops: r.stops.clone(),
                    }))
                };
                let id = list.paths.push_anon(r.quad.clone());
                list.push(DisplayCommand::FillPath {
                    path_id: id,
                    paint,
                    transform: base.compose(&r.transform),
                });
            }
        }
    }
    for _ in 0..open {
        list.push(DisplayCommand::PopClip(Transform::IDENTITY));
    }
    list.push(DisplayCommand::PopClip(Transform::IDENTITY));
}

fn rect(x0: f32, y0: f32, x1: f32, y1: f32) -> PathData {
    PathData::new(vec![
        PathSegment::MoveTo { x: x0, y: y0 },
        PathSegment::LineTo { x: x1, y: y0 },
        PathSegment::LineTo { x: x1, y: y1 },
        PathSegment::LineTo { x: x0, y: y1 },
        PathSegment::Close,
    ])
}

fn transform_of(m: &paged_ps::Affine) -> Transform {
    let v = m.as_coeffs();
    Transform([
        v[0] as f32,
        v[1] as f32,
        v[2] as f32,
        v[3] as f32,
        v[4] as f32,
        v[5] as f32,
    ])
}

fn fill_rule(r: paged_ps::FillRule) -> FillRule {
    match r {
        paged_ps::FillRule::NonZero => FillRule::NonZero,
        paged_ps::FillRule::EvenOdd => FillRule::EvenOdd,
    }
}

fn path_data(p: &paged_ps::BezPath) -> PathData {
    PathData::from_bez(p)
}

/// A device colour as a list paint: grey and RGB in linear light, CMYK
/// kept as CMYK with its display colour from the document's transform.
fn to_paint(c: &paged_ps::Color, icc: Option<&paged_color::IccTransform>) -> Paint {
    match *c {
        paged_ps::Color::Cmyk([cc, m, y, k]) => {
            let rgb = match icc {
                Some(x) => {
                    let paged_color::LinearRgb([r, g, b]) =
                        x.cmyk_percent_to_linear_rgb(paged_color::Cmyk {
                            c: cc * 100.0,
                            m: m * 100.0,
                            y: y * 100.0,
                            k: k * 100.0,
                        });
                    Color::rgba(r, g, b, 1.0)
                }
                None => {
                    let [r, g, b] = c.to_srgb();
                    Color::rgba(linear(r), linear(g), linear(b), 1.0)
                }
            };
            Paint::Cmyk {
                c: cc,
                m,
                y,
                k,
                rgb,
                spot: None,
            }
        }
        _ => {
            let [r, g, b] = c.to_srgb();
            Paint::Solid(Color::rgba(linear(r), linear(g), linear(b), 1.0))
        }
    }
}

/// An EPS image's samples as RGBA8 (CMYK through the document's profile).
fn decoded(img: &paged_ps::Image, options: &PipelineOptions<'_>) -> Option<DecodedImage> {
    let (w, h) = (img.width, img.height);
    let n = (w as usize).checked_mul(h as usize)?;
    let mut rgba = match &img.pixels {
        Pixels::Gray(v) if v.len() >= n => v[..n].iter().flat_map(|g| [*g, *g, *g, 255]).collect(),
        Pixels::Rgb(v) if v.len() >= n * 3 => v[..n * 3]
            .as_chunks::<3>()
            .0
            .iter()
            .flat_map(|p| [p[0], p[1], p[2], 255])
            .collect(),
        Pixels::Cmyk(v) if v.len() >= n * 4 => {
            // The converter takes CMYK as Adobe stores it, inverted.
            let inv: Vec<u8> = v[..n * 4].iter().map(|b| 255 - b).collect();
            // The document's Color Settings intent and BPC (ADR 1032).
            let rendering = super::images::image_rendering(options, None);
            super::image_convert::cmyk32_to_rgba(&inv, w, h, options.cmyk_icc_profile, rendering)?
        }
        _ => return None,
    };
    if let Some(a) = img.alpha.as_ref().filter(|a| a.len() >= n) {
        for (px, a) in rgba.as_chunks_mut::<4>().0.iter_mut().zip(a.iter()) {
            px[3] = *a;
        }
    }
    Some(DecodedImage {
        width: w,
        height: h,
        encoded: bytes::Bytes::new(),
        rgba: bytes::Bytes::from(rgba),
        icc: None,
        rendering: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn postscript_font_names_split_into_family_and_style() {
        assert_eq!(
            family_and_style("Helvetica-BoldOblique"),
            ("Helvetica".to_string(), Some("Bold Oblique".to_string()))
        );
        assert_eq!(
            family_and_style("Times-Roman"),
            ("Times".to_string(), Some("Regular".to_string()))
        );
        assert_eq!(family_and_style("Symbol"), ("Symbol".to_string(), None));
    }

    #[test]
    fn a_drawn_eps_rides_its_placement_and_clips_to_its_box() {
        let eps = b"%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 10 20 110 70\n1 0 0 setrgbcolor 10 20 50 25 rectfill\n0 0 0 1 setcmykcolor 2 setlinewidth newpath 10 20 moveto 110 70 lineto stroke\n";
        let options = PipelineOptions::default();
        let art = prepare(eps, &options).expect("interpreted");
        assert_eq!((art.width, art.height), (100.0, 50.0));
        let mut list = DisplayList::default();
        draw(&art, Transform::translate(5.0, 5.0), &mut list);
        let fills: Vec<_> = list
            .commands
            .iter()
            .filter_map(|c| match c {
                DisplayCommand::FillPath {
                    path_id,
                    transform,
                    paint,
                } => Some((*path_id, *transform, *paint)),
                _ => None,
            })
            .collect();
        assert_eq!(fills.len(), 1);
        // The rectangle's corner (10, 20) is the box's bottom-left: page
        // (5, 5 + 50).
        let (id, t, paint) = fills[0];
        let p = list.paths.get(id).unwrap();
        let PathSegment::MoveTo { x, y } = p.segments[0] else {
            panic!()
        };
        assert_eq!(t.apply(x, y), (5.0, 55.0));
        assert!(matches!(paint, Paint::Solid(c) if c.r == 1.0 && c.g == 0.0));
        let stroke = list.commands.iter().find_map(|c| match c {
            DisplayCommand::StrokePath { stroke, paint, .. } => Some((*stroke, *paint)),
            _ => None,
        });
        assert!(
            stroke.is_some_and(
                |(s, p)| s.width == 2.0 && matches!(p, Paint::Cmyk { k, .. } if k == 1.0)
            )
        );
        let pushes = list
            .commands
            .iter()
            .filter(|c| matches!(c, DisplayCommand::PushClip { .. }))
            .count();
        let pops = list
            .commands
            .iter()
            .filter(|c| matches!(c, DisplayCommand::PopClip(_)))
            .count();
        assert_eq!((pushes, pops), (1, 1));
    }

    #[test]
    fn a_program_that_fails_is_not_drawn() {
        let options = PipelineOptions::default();
        assert!(prepare(
            b"%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 10 10\nnosuchop\n",
            &options
        )
        .is_none());
        assert!(prepare(b"\x89PNG", &options).is_none());
    }
}

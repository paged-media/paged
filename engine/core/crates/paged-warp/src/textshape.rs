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

//! The guide curves of a text warp (engine ADR 1091): WordArt's
//! `a:prstTxWarp` presets as a map of the text box onto the bent shape.
//!
//! A preset is two guides, a top and a bottom curve, each a function of
//! `t ∈ [0, 1]` across the box in its unit square (y down). A point at
//! `(u, v)` of the text's box maps onto the straight segment between the
//! guides' points at `u`, `v` of the way down: the Coons patch whose sides
//! are the segments joining the guides' ends. Families share guide forms:
//! straight or bent polylines (taper), elliptic arcs inscribed in the box
//! (arch, circle, pour, button), one curve offset by the box (curve, can),
//! sines (wave) and half-sine bulges (inflate, deflate).
//!
//! The forms and defaults are this crate's reading of the ECMA-376 preset
//! names and their documented adjusts; they are geometry invariants (an
//! arch is symmetric, an inflate keeps the box's corners), not a measured
//! match of Word's or PowerPoint's drawing.

use std::f64::consts::PI;

/// One guide curve, in the box's unit square.
#[derive(Debug, Clone, PartialEq)]
enum Guide {
    /// A polyline through `(t, x, y)` knots, `t` ascending from 0 to 1.
    Poly(Vec<(f64, f64, f64)>),
    /// An elliptic arc: centre, radii, start angle and sweep (radians, y
    /// down, so positive sweeps clockwise on the page).
    Arc {
        c: (f64, f64),
        r: (f64, f64),
        start: f64,
        sweep: f64,
    },
    /// `x = t`, `y = base + amp · f(t)` for a shape function `f`.
    Curve { base: f64, amp: f64, shape: Shape },
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Shape {
    /// `sin(π t)`: 0 at the ends, 1 in the middle.
    Bulge,
    /// `cos(π t / 2)`: 1 at the start, 0 at the end.
    Fall,
    /// `sin(π t / 2)`: 0 at the start, 1 at the end.
    Rise,
    /// `sin(2π n t)` over `n` periods (a stored count).
    Sine(u8),
    /// `−sin(2π n t)`.
    NegSine(u8),
}

impl Shape {
    fn at(self, t: f64) -> f64 {
        match self {
            Shape::Bulge => (PI * t).sin(),
            Shape::Fall => (PI * t / 2.0).cos(),
            Shape::Rise => (PI * t / 2.0).sin(),
            Shape::Sine(n) => (2.0 * PI * f64::from(n) * t).sin(),
            Shape::NegSine(n) => -(2.0 * PI * f64::from(n) * t).sin(),
        }
    }
}

impl Guide {
    fn line(a: (f64, f64), b: (f64, f64)) -> Guide {
        Guide::Poly(vec![(0.0, a.0, a.1), (1.0, b.0, b.1)])
    }

    /// A polyline through three points, its knee at the middle.
    fn knee(a: (f64, f64), m: (f64, f64), b: (f64, f64)) -> Guide {
        Guide::Poly(vec![(0.0, a.0, a.1), (0.5, m.0, m.1), (1.0, b.0, b.1)])
    }

    fn flat(y: f64) -> Guide {
        Guide::line((0.0, y), (1.0, y))
    }

    fn at(&self, t: f64) -> (f64, f64) {
        match self {
            Guide::Poly(knots) => {
                let t = t.clamp(0.0, 1.0);
                for w in knots.windows(2) {
                    let ((t0, x0, y0), (t1, x1, y1)) = (w[0], w[1]);
                    if t <= t1 || t1 >= 1.0 {
                        let k = if t1 > t0 { (t - t0) / (t1 - t0) } else { 0.0 };
                        return (x0 + (x1 - x0) * k, y0 + (y1 - y0) * k);
                    }
                }
                knots.last().map_or((t, 0.0), |&(_, x, y)| (x, y))
            }
            Guide::Arc { c, r, start, sweep } => {
                let a = start + sweep * t;
                (c.0 + r.0 * a.cos(), c.1 + r.1 * a.sin())
            }
            Guide::Curve { base, amp, shape } => (t, base + amp * shape.at(t)),
        }
    }
}

/// A preset's two guides: the bent shape the text box maps onto.
#[derive(Debug, Clone, PartialEq)]
pub struct TextShape {
    top: Guide,
    bottom: Guide,
}

/// A box in the caller's units (page points), y down.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Box2 {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl TextShape {
    /// The point of `rect` the text box's point `(u, v)` (each 0 to 1)
    /// moves to.
    pub fn map(&self, rect: Box2, (u, v): (f64, f64)) -> (f64, f64) {
        let (tx, ty) = self.top.at(u);
        let (bx, by) = self.bottom.at(u);
        let x = tx + (bx - tx) * v;
        let y = ty + (by - ty) * v;
        (rect.x + x * rect.w, rect.y + y * rect.h)
    }

    /// Whether the shape is the box itself.
    pub fn is_identity(&self) -> bool {
        *self == plain()
    }
}

fn plain() -> TextShape {
    TextShape {
        top: Guide::flat(0.0),
        bottom: Guide::flat(1.0),
    }
}

/// An adjust in 1/100000 of the box, or `default`.
fn frac(adjust: &dyn Fn(&str) -> Option<i64>, name: &str, default: i64) -> f64 {
    adjust(name).unwrap_or(default) as f64 / 100_000.0
}

/// An adjust in 1/60000 of a degree, as radians, or `default` degrees.
fn angle(adjust: &dyn Fn(&str) -> Option<i64>, name: &str, default_deg: f64) -> f64 {
    adjust(name)
        .map_or(default_deg, |v| v as f64 / 60_000.0)
        .to_radians()
}

/// The ellipse inscribed in the box, scaled by `k` about its centre.
fn ring(k: f64, start: f64, sweep: f64) -> Guide {
    Guide::Arc {
        c: (0.5, 0.5),
        r: (0.5 * k, 0.5 * k),
        start,
        sweep,
    }
}

/// The shape `preset` (an `ST_TextShapeType` name) bends the text box to,
/// with its adjusts (`adjust("adj")`, `adjust("adj1")`, … as written; the
/// schema's defaults otherwise). `thickness` is the text's height as a
/// fraction of the box's: the band a single-guide preset (arch, circle,
/// button) gives the text. `None` for a name that is no preset.
pub fn text_shape(
    preset: &str,
    adjust: &dyn Fn(&str) -> Option<i64>,
    thickness: f64,
) -> Option<TextShape> {
    let band = thickness.clamp(0.05, 0.9);
    let s = |top: Guide, bottom: Guide| Some(TextShape { top, bottom });
    match preset {
        "textNoShape" | "textPlain" => Some(plain()),
        // Taper: corner-pinned straight guides.
        "textStop" => {
            let a = frac(adjust, "adj", 25_000).clamp(0.0, 0.5);
            s(
                Guide::Poly(vec![
                    (0.0, 0.0, a),
                    (a, a, 0.0),
                    (1.0 - a, 1.0 - a, 0.0),
                    (1.0, 1.0, a),
                ]),
                Guide::Poly(vec![
                    (0.0, 0.0, 1.0 - a),
                    (a, a, 1.0),
                    (1.0 - a, 1.0 - a, 1.0),
                    (1.0, 1.0, 1.0 - a),
                ]),
            )
        }
        "textTriangle" => {
            let a = frac(adjust, "adj", 50_000).clamp(0.0, 1.0);
            s(
                Guide::knee((0.0, 1.0 - a), (0.5, 0.0), (1.0, 1.0 - a)),
                Guide::flat(1.0),
            )
        }
        "textTriangleInverted" => {
            let a = frac(adjust, "adj", 50_000).clamp(0.0, 1.0);
            s(
                Guide::flat(0.0),
                Guide::knee((0.0, a), (0.5, 1.0), (1.0, a)),
            )
        }
        "textChevron" => {
            let a = frac(adjust, "adj", 25_000).clamp(0.0, 0.5);
            s(
                Guide::knee((0.0, a), (0.5, 0.0), (1.0, a)),
                Guide::knee((0.0, 1.0), (0.5, 1.0 - a), (1.0, 1.0)),
            )
        }
        "textChevronInverted" => {
            let a = frac(adjust, "adj", 75_000).clamp(0.5, 1.0);
            let a = 1.0 - a;
            s(
                Guide::knee((0.0, 0.0), (0.5, a), (1.0, 0.0)),
                Guide::knee((0.0, 1.0 - a), (0.5, 1.0), (1.0, 1.0 - a)),
            )
        }
        "textFadeRight" | "textFadeLeft" | "textFadeUp" | "textFadeDown" => {
            let a = frac(adjust, "adj", 33_333).clamp(0.0, 0.49);
            match preset {
                "textFadeRight" => s(
                    Guide::line((0.0, 0.0), (1.0, a)),
                    Guide::line((0.0, 1.0), (1.0, 1.0 - a)),
                ),
                "textFadeLeft" => s(
                    Guide::line((0.0, a), (1.0, 0.0)),
                    Guide::line((0.0, 1.0 - a), (1.0, 1.0)),
                ),
                "textFadeUp" => s(Guide::line((a, 0.0), (1.0 - a, 0.0)), Guide::flat(1.0)),
                _ => s(Guide::flat(0.0), Guide::line((a, 1.0), (1.0 - a, 1.0))),
            }
        }
        "textSlantUp" | "textSlantDown" => {
            let a = frac(adjust, "adj", 55_556).clamp(0.0, 1.0);
            let k = 1.0 - a;
            if preset == "textSlantUp" {
                s(
                    Guide::line((0.0, k), (1.0, 0.0)),
                    Guide::line((0.0, 1.0), (1.0, 1.0 - k)),
                )
            } else {
                s(
                    Guide::line((0.0, 0.0), (1.0, k)),
                    Guide::line((0.0, 1.0 - k), (1.0, 1.0)),
                )
            }
        }
        "textCascadeUp" | "textCascadeDown" => {
            let a = frac(adjust, "adj", 44_444).clamp(0.0, 1.0);
            let k = 1.0 - a;
            if preset == "textCascadeUp" {
                s(Guide::line((0.0, k), (1.0, 0.0)), Guide::flat(1.0))
            } else {
                s(Guide::line((0.0, 0.0), (1.0, k)), Guide::flat(1.0))
            }
        }
        // Arch, circle, button: the text follows an arc of the inscribed
        // ellipse, its band as thick as the text.
        "textArchUp" | "textArchUpPour" | "textButton" | "textButtonPour" => {
            let st = angle(adjust, "adj1", 180.0).clamp(PI / 2.0, 3.0 * PI / 2.0);
            let st = if adjust("adj1").is_none() {
                angle(adjust, "adj", 180.0).clamp(PI / 2.0, 3.0 * PI / 2.0)
            } else {
                st
            };
            let sweep = 3.0 * PI - 2.0 * st;
            let inner = inner_ring(preset, adjust, band);
            s(ring(1.0, st, sweep), ring(inner, st, sweep))
        }
        "textArchDown" | "textArchDownPour" => {
            let a = if adjust("adj1").is_some() {
                angle(adjust, "adj1", 0.0)
            } else {
                angle(adjust, "adj", 0.0)
            };
            let a = a.clamp(-PI / 2.0, PI / 2.0);
            // From the left end through the bottom to the right end:
            // counter-clockwise on the page.
            let start = PI - a;
            let sweep = -(PI - 2.0 * a);
            let inner = inner_ring(preset, adjust, band);
            s(ring(inner, start, sweep), ring(1.0, start, sweep))
        }
        "textCircle" | "textCirclePour" | "textRingInside" | "textRingOutside" => {
            let st = if adjust("adj1").is_some() {
                angle(adjust, "adj1", 180.0)
            } else {
                angle(adjust, "adj", 180.0)
            }
            .clamp(PI / 2.0, 3.0 * PI / 2.0);
            let sweep = (4.0 * PI - 2.0 * st).min(2.0 * PI);
            let inner = inner_ring(preset, adjust, band);
            if preset == "textRingInside" {
                s(ring(inner, st, sweep), ring(1.0, st, sweep))
            } else {
                s(ring(1.0, st, sweep), ring(inner, st, sweep))
            }
        }
        // Curve and can: one curve, the bottom guide the top one moved
        // down by the box less the curve's depth.
        "textCurveUp" | "textCurveDown" => {
            let a = frac(adjust, "adj", 45_977).clamp(0.0, 0.9);
            let shape = if preset == "textCurveUp" {
                Shape::Fall
            } else {
                Shape::Rise
            };
            s(
                Guide::Curve {
                    base: 0.0,
                    amp: a,
                    shape,
                },
                Guide::Curve {
                    base: 1.0 - a,
                    amp: a,
                    shape,
                },
            )
        }
        "textCanUp" | "textCanDown" => {
            let a = (1.0 - frac(adjust, "adj", 85_000)).clamp(0.0, 0.9);
            let (base, amp) = if preset == "textCanUp" {
                (a, -a)
            } else {
                (0.0, a)
            };
            s(
                Guide::Curve {
                    base,
                    amp,
                    shape: Shape::Bulge,
                },
                Guide::Curve {
                    base: base + 1.0 - a,
                    amp,
                    shape: Shape::Bulge,
                },
            )
        }
        // Waves: sinusoidal guides of amplitude `adj1`.
        "textWave1" | "textWave2" | "textWave4" | "textDoubleWave1" => {
            let (default, periods) = match preset {
                "textWave1" | "textWave2" => (12_500, 1),
                _ => (6_250, 2),
            };
            let a = frac(adjust, "adj1", default).clamp(0.0, 0.3);
            let shape = if preset == "textWave2" {
                Shape::NegSine(periods)
            } else {
                Shape::Sine(periods)
            };
            s(
                Guide::Curve {
                    base: a,
                    amp: a,
                    shape,
                },
                Guide::Curve {
                    base: 1.0 - a,
                    amp: a,
                    shape,
                },
            )
        }
        // Inflate and deflate: half-sine bulges of depth `adj`.
        "textInflate"
        | "textDeflate"
        | "textInflateTop"
        | "textInflateBottom"
        | "textDeflateTop"
        | "textDeflateBottom"
        | "textDeflateInflate"
        | "textDeflateInflateDeflate" => {
            let default = match preset {
                "textInflateTop" | "textInflateBottom" | "textDeflateTop" | "textDeflateBottom" => {
                    50_000
                }
                "textDeflateInflate" => 35_000,
                "textDeflateInflateDeflate" => 25_000,
                _ => 18_750,
            };
            let a = frac(adjust, "adj", default).clamp(0.0, 0.45);
            // A guide at `end` at the box's sides and `mid` in its middle.
            let bend = |end: f64, mid: f64| Guide::Curve {
                base: end,
                amp: mid - end,
                shape: Shape::Bulge,
            };
            match preset {
                // The top rises and the bottom falls in the middle.
                "textInflate" => s(bend(a, 0.0), bend(1.0 - a, 1.0)),
                "textInflateTop" => s(bend(a, 0.0), Guide::flat(1.0)),
                "textInflateBottom" => s(Guide::flat(0.0), bend(1.0 - a, 1.0)),
                "textDeflateTop" => s(bend(0.0, a), Guide::flat(1.0)),
                "textDeflateBottom" => s(Guide::flat(0.0), bend(1.0, 1.0 - a)),
                // Deflate, and the two- and three-line presets bend their
                // outer edges in.
                _ => s(bend(0.0, a), bend(1.0, 1.0 - a)),
            }
        }
        _ => None,
    }
}

/// The inner arc of an arch or circle: the pour presets' own (`adj2`), else
/// the band the text's height makes.
fn inner_ring(preset: &str, adjust: &dyn Fn(&str) -> Option<i64>, band: f64) -> f64 {
    if preset.ends_with("Pour") {
        frac(adjust, "adj2", 50_000).clamp(0.0, 0.99)
    } else {
        1.0 - band
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const R: Box2 = Box2 {
        x: 10.0,
        y: 20.0,
        w: 200.0,
        h: 100.0,
    };

    fn none(_: &str) -> Option<i64> {
        None
    }

    fn close(a: (f64, f64), b: (f64, f64)) -> bool {
        (a.0 - b.0).abs() < 1e-9 && (a.1 - b.1).abs() < 1e-9
    }

    #[test]
    fn plain_is_the_box() {
        let p = text_shape("textPlain", &none, 0.3).unwrap();
        assert!(p.is_identity());
        assert!(close(p.map(R, (0.25, 0.5)), (60.0, 70.0)));
        assert!(text_shape("textNotAPreset", &none, 0.3).is_none());
    }

    #[test]
    fn an_arch_of_180_degrees_is_symmetric_and_highest_in_the_middle() {
        let a = text_shape("textArchUp", &none, 0.3).unwrap();
        let (l, m, r) = (
            a.map(R, (0.0, 1.0)),
            a.map(R, (0.5, 1.0)),
            a.map(R, (1.0, 1.0)),
        );
        // First and last glyph stand on the same baseline height.
        assert!((l.1 - r.1).abs() < 1e-9, "{l:?} {r:?}");
        // The middle is highest (y down) and centred.
        assert!(m.1 < l.1);
        assert!((m.0 - (R.x + R.w / 2.0)).abs() < 1e-9);
        // The top of the middle glyph touches the box's top.
        assert!((a.map(R, (0.5, 0.0)).1 - R.y).abs() < 1e-9);
        // Arch down: the middle is lowest.
        let d = text_shape("textArchDown", &none, 0.3).unwrap();
        let (l, m, r) = (
            d.map(R, (0.0, 0.0)),
            d.map(R, (0.5, 0.0)),
            d.map(R, (1.0, 0.0)),
        );
        assert!((l.1 - r.1).abs() < 1e-9);
        assert!(m.1 > l.1);
        assert!(l.0 < r.0, "read left to right");
    }

    #[test]
    fn an_inflate_keeps_the_corners_and_bulges_the_middle() {
        let s = text_shape("textInflate", &none, 0.3).unwrap();
        for (u, v) in [(0.0, 0.0), (1.0, 0.0), (0.0, 1.0), (1.0, 1.0)] {
            let p = s.map(R, (u, v));
            let x = R.x + u * R.w;
            assert!((p.0 - x).abs() < 1e-9, "x of corner {u},{v}");
        }
        // The ends are pulled in by the adjust; the middle reaches the box.
        let top_mid = s.map(R, (0.5, 0.0)).1;
        let top_end = s.map(R, (0.0, 0.0)).1;
        assert!((top_mid - R.y).abs() < 1e-9);
        assert!(top_end > top_mid);
        let bottom_mid = s.map(R, (0.5, 1.0)).1;
        assert!((bottom_mid - (R.y + R.h)).abs() < 1e-9);
        // Deflate pinches instead.
        let d = text_shape("textDeflate", &none, 0.3).unwrap();
        assert!(d.map(R, (0.5, 0.0)).1 > d.map(R, (0.0, 0.0)).1);
    }

    #[test]
    fn adjusts_move_the_guides() {
        let gentle = text_shape("textWave1", &|n| (n == "adj1").then_some(5_000), 0.3).unwrap();
        let steep = text_shape("textWave1", &|n| (n == "adj1").then_some(20_000), 0.3).unwrap();
        let swing = |s: &TextShape| s.map(R, (0.75, 0.0)).1 - s.map(R, (0.25, 0.0)).1;
        assert!(swing(&steep).abs() > swing(&gentle).abs());
        // A circle goes all the way round.
        let c = text_shape("textCircle", &none, 0.2).unwrap();
        let (a, b) = (c.map(R, (0.0, 0.0)), c.map(R, (1.0, 0.0)));
        assert!(close(a, b), "{a:?} {b:?}");
    }

    #[test]
    fn every_preset_name_maps() {
        for name in [
            "textNoShape",
            "textPlain",
            "textStop",
            "textTriangle",
            "textTriangleInverted",
            "textChevron",
            "textChevronInverted",
            "textRingInside",
            "textRingOutside",
            "textArchUp",
            "textArchDown",
            "textCircle",
            "textButton",
            "textArchUpPour",
            "textArchDownPour",
            "textCirclePour",
            "textButtonPour",
            "textCurveUp",
            "textCurveDown",
            "textCanUp",
            "textCanDown",
            "textWave1",
            "textWave2",
            "textDoubleWave1",
            "textWave4",
            "textInflate",
            "textDeflate",
            "textInflateBottom",
            "textDeflateBottom",
            "textInflateTop",
            "textDeflateTop",
            "textDeflateInflate",
            "textDeflateInflateDeflate",
            "textFadeRight",
            "textFadeLeft",
            "textFadeUp",
            "textFadeDown",
            "textSlantUp",
            "textSlantDown",
            "textCascadeUp",
            "textCascadeDown",
        ] {
            let s = text_shape(name, &none, 0.3).unwrap_or_else(|| panic!("{name}"));
            let p = s.map(R, (0.3, 0.6));
            assert!(p.0.is_finite() && p.1.is_finite(), "{name}");
        }
    }
}

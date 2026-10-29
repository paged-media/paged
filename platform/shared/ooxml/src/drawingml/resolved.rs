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

//! The NEUTRAL resolved paint: what a DrawingML fill, line, effect list or
//! picture draws, with every colour resolved and every length in points,
//! every angle in degrees, every percentage a fraction.
//!
//! This is the IR the modules lower from (the shared mapper,
//! `platform/shared/dml-native`, turns it into the engine's model). It
//! knows nothing of the engine: a construct the engine cannot hold yet
//! (a pattern, a reflection) is still described here, and the lowering
//! says what it did with it.

use super::color::{resolve, Color, SchemeColors};
use super::effect;
use super::paint::{Blip, BlipEffect, Fill, Line, Shade};
use crate::units::{angle_to_deg, emu_to_pt, pct_to_fraction};

/// sRGB bytes.
pub type Rgb = [u8; 3];

/// A colour as bytes and an alpha (0–1).
pub fn color(c: &Color, schemes: &dyn SchemeColors) -> (Rgb, f64) {
    let rgba = resolve(c, schemes);
    (rgba.bytes(), rgba.a)
}

/// A resolved fill.
#[derive(Debug, Clone, Default, PartialEq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum Paint {
    #[default]
    None,
    Solid {
        rgb: Rgb,
        alpha: f64,
        /// The theme colour it names ([`SchemeColors::theme_key`]): by
        /// default the scheme slot, when the colour is one untransformed.
        theme: Option<String>,
    },
    Linear {
        stops: Vec<Stop>,
        /// DrawingML's angle in degrees: clockwise on a y-down page.
        angle: f64,
    },
    Radial {
        stops: Vec<Stop>,
        /// The centre, as fractions of the box: the centre of
        /// `a:fillToRect` (the box's centre when absent). The gradient
        /// reaches its last stop at the farthest corner.
        center: (f64, f64),
    },
    Pattern(PatternPaint),
    Image {
        part: String,
    },
}

/// One gradient stop: position (0–100 %), colour, alpha (0–1).
#[derive(Debug, Clone, Copy, PartialEq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct Stop {
    pub pos: f64,
    pub rgb: Rgb,
    pub alpha: f64,
}

/// A two-colour pattern (`a:pattFill`).
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct PatternPaint {
    pub preset: String,
    pub fg: Rgb,
    pub fg_alpha: f64,
    pub bg: Rgb,
    pub bg_alpha: f64,
}

impl PatternPaint {
    /// The share of the pattern's cell the foreground covers (0–1), from
    /// the preset's 8 × 8 cell as PowerPoint draws it.
    pub fn coverage(&self) -> f64 {
        pattern_coverage(&self.preset)
    }

    /// The pattern seen from a distance: its two colours mixed by
    /// [`PatternPaint::coverage`].
    pub fn mix(&self) -> (Rgb, f64) {
        let s = self.coverage();
        let m = |f: u8, b: u8| (f as f64 * s + b as f64 * (1.0 - s)).round() as u8;
        (
            [
                m(self.fg[0], self.bg[0]),
                m(self.fg[1], self.bg[1]),
                m(self.fg[2], self.bg[2]),
            ],
            self.fg_alpha * s + self.bg_alpha * (1.0 - s),
        )
    }
}

/// The foreground share of a preset pattern (`ST_PresetPatternVal`): the
/// percentage presets say theirs; the others are estimated from the 8 × 8
/// cells Office draws (thin lines and grids a quarter, dark and wide ones
/// half, the figured patterns about three eighths).
pub fn pattern_coverage(preset: &str) -> f64 {
    if let Some(n) = preset
        .strip_prefix("pct")
        .and_then(|n| n.parse::<f64>().ok())
    {
        return (n / 100.0).clamp(0.0, 1.0);
    }
    match preset {
        "ltHorz" | "ltVert" | "ltDnDiag" | "ltUpDiag" | "narHorz" | "narVert" => 0.25,
        "horz" | "vert" | "dnDiag" | "upDiag" | "dashHorz" | "dashVert" | "dashDnDiag"
        | "dashUpDiag" | "smGrid" | "dotGrid" => 0.25,
        "dkHorz" | "dkVert" | "dkDnDiag" | "dkUpDiag" | "wdDnDiag" | "wdUpDiag" => 0.5,
        "cross" | "lgGrid" => 0.234_375,
        "diagCross" | "smConfetti" | "lgConfetti" | "zigZag" | "wave" | "diagBrick"
        | "horzBrick" | "weave" | "plaid" | "divot" | "shingle" | "trellis" | "sphere"
        | "dotDmnd" => 0.375,
        "openDmnd" | "solidDmnd" => 0.25,
        "smCheck" | "lgCheck" => 0.5,
        _ => 0.5,
    }
}

impl Paint {
    /// The colour of a gradient at position `t` (0–1) along its axis, or of
    /// a solid paint (or a pattern seen from a distance) anywhere; stops
    /// interpolate in sRGB.
    pub fn color_at(&self, t: f64) -> Option<(Rgb, f64)> {
        match self {
            Paint::Solid { rgb, alpha, .. } => Some((*rgb, *alpha)),
            Paint::Pattern(p) => Some(p.mix()),
            Paint::Linear { stops, .. } | Paint::Radial { stops, .. } => {
                let t = t.clamp(0.0, 1.0) * 100.0;
                let first = stops.first()?;
                if t <= first.pos {
                    return Some((first.rgb, first.alpha));
                }
                for w in stops.windows(2) {
                    let (a, b) = (w[0], w[1]);
                    if t <= b.pos {
                        let k = if b.pos > a.pos {
                            (t - a.pos) / (b.pos - a.pos)
                        } else {
                            1.0
                        };
                        let mix =
                            |x: u8, y: u8| (x as f64 + (y as f64 - x as f64) * k).round() as u8;
                        return Some((
                            [
                                mix(a.rgb[0], b.rgb[0]),
                                mix(a.rgb[1], b.rgb[1]),
                                mix(a.rgb[2], b.rgb[2]),
                            ],
                            a.alpha + (b.alpha - a.alpha) * k,
                        ));
                    }
                }
                let last = stops.last()?;
                Some((last.rgb, last.alpha))
            }
            Paint::None | Paint::Image { .. } => None,
        }
    }

    /// The paint's alpha when it is the same everywhere (a solid colour, or
    /// a gradient whose stops share one), else `None`.
    pub fn uniform_alpha(&self) -> Option<f64> {
        match self {
            Paint::Solid { alpha, .. } => Some(*alpha),
            Paint::Pattern(p) => ((p.fg_alpha - p.bg_alpha).abs() < 1e-3).then_some(p.fg_alpha),
            Paint::Linear { stops, .. } | Paint::Radial { stops, .. } => {
                let first = stops.first()?.alpha;
                stops
                    .iter()
                    .all(|s| (s.alpha - first).abs() < 1e-3)
                    .then_some(first)
            }
            Paint::None | Paint::Image { .. } => Some(1.0),
        }
    }
}

/// How far a radial gradient centred at `center` (fractions of a `w` × `h`
/// box) runs before its last stop: to the farthest corner, as PowerPoint
/// draws `a:path path="circle"`.
pub fn radial_reach(center: (f64, f64), w: f64, h: f64) -> f64 {
    let dx = center.0.max(1.0 - center.0) * w;
    let dy = center.1.max(1.0 - center.1) * h;
    (dx * dx + dy * dy).sqrt()
}

/// Resolve a fill. `note` hears what the paint draws differently from
/// the file (a rectangular path gradient drawn round, a tiled gradient
/// drawn once).
pub fn paint(fill: &Fill, schemes: &dyn SchemeColors, note: &mut dyn FnMut(String)) -> Paint {
    match fill {
        Fill::None | Fill::Group => Paint::None,
        Fill::Solid(c) => {
            let (rgb, alpha) = color(c, schemes);
            Paint::Solid {
                rgb,
                alpha,
                theme: schemes.theme_key(c),
            }
        }
        Fill::Gradient(g) => {
            let mut stops: Vec<Stop> = g
                .stops
                .iter()
                .map(|s| {
                    let (rgb, alpha) = color(&s.color, schemes);
                    Stop {
                        pos: s.pos as f64 / 1000.0,
                        rgb,
                        alpha,
                    }
                })
                .collect();
            // `a:gsLst` need not be in position order.
            stops.sort_by(|a, b| a.pos.total_cmp(&b.pos));
            if stops.is_empty() {
                return Paint::None;
            }
            if g.tile_rect.is_some_and(|r| r != (0, 0, 0, 0)) {
                note("a gradient's tile rectangle is not carried: drawn across the shape".into());
            }
            match &g.shade {
                Some(Shade::Path { path, fill_to_rect }) => {
                    if path != "circle" {
                        note(format!("a {path} path gradient is drawn radial"));
                    }
                    let (l, t, r, b) = fill_to_rect.unwrap_or((0, 0, 0, 0));
                    let f = |v: i32| v as f64 / 100_000.0;
                    Paint::Radial {
                        stops,
                        center: ((f(l) + 1.0 - f(r)) / 2.0, (f(t) + 1.0 - f(b)) / 2.0),
                    }
                }
                Some(Shade::Linear { angle, .. }) => Paint::Linear {
                    stops,
                    angle: *angle as f64 / 60_000.0,
                },
                None => Paint::Linear { stops, angle: 0.0 },
            }
        }
        Fill::Blip(b) => match &b.part {
            Some(p) => Paint::Image { part: p.clone() },
            None => Paint::None,
        },
        Fill::Pattern(p) => {
            let fg =
                p.fg.as_ref()
                    .map(|c| color(c, schemes))
                    .unwrap_or(([0, 0, 0], 1.0));
            let bg =
                p.bg.as_ref()
                    .map(|c| color(c, schemes))
                    .unwrap_or(([255, 255, 255], 1.0));
            Paint::Pattern(PatternPaint {
                preset: p.preset.clone(),
                fg: fg.0,
                fg_alpha: fg.1,
                bg: bg.0,
                bg_alpha: bg.1,
            })
        }
    }
}

/// A resolved line.
#[derive(Debug, Clone, Default, PartialEq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct Stroke {
    /// pt.
    pub width: f64,
    pub paint: Paint,
    /// `a:prstDash` other than `solid`.
    pub dash: Option<String>,
    /// `cmpd` other than a single line (`dbl`, `thickThin`, …).
    #[cfg_attr(feature = "serde", serde(default))]
    pub compound: Option<String>,
    pub cap: Option<String>,
    pub join: Option<String>,
    /// `a:headEnd` / `a:tailEnd` type other than `none`.
    pub head: Option<String>,
    pub tail: Option<String>,
    /// `a:custDash` (dash, space) pairs as multiples of the width.
    #[cfg_attr(feature = "serde", serde(default))]
    pub custom_dash: Vec<(f64, f64)>,
    /// `a:miter lim` as a multiple of the width.
    #[cfg_attr(feature = "serde", serde(default))]
    pub miter_limit: Option<f64>,
}

/// Resolve a line; `None` when it draws nothing (no fill, `a:noFill`, or
/// a paint that resolves to none). A line with no `w` is
/// `default_width` EMU wide.
pub fn stroke(
    line: &Line,
    schemes: &dyn SchemeColors,
    default_width: i64,
    note: &mut dyn FnMut(String),
) -> Option<Stroke> {
    let p = paint(line.fill.as_ref()?, schemes, note);
    if matches!(p, Paint::None) {
        return None;
    }
    let end = |e: &Option<super::paint::LineEnd>| {
        e.as_ref().map(|e| e.kind.clone()).filter(|k| k != "none")
    };
    Some(Stroke {
        width: emu_to_pt(line.width.unwrap_or(default_width)),
        paint: p,
        dash: line.dash.clone().filter(|d| d != "solid"),
        compound: line.compound.clone().filter(|c| c != "sng"),
        cap: line.cap.clone(),
        join: line.join.clone(),
        head: end(&line.head),
        tail: end(&line.tail),
        custom_dash: line
            .custom_dash
            .iter()
            .map(|&(d, s)| (pct_to_fraction(d as i64), pct_to_fraction(s as i64)))
            .collect(),
        miter_limit: line.miter_limit.map(|m| pct_to_fraction(m as i64)),
    })
}

/// Resolved effects.
#[derive(Debug, Clone, Default, PartialEq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct Effects {
    pub outer_shadow: Option<Shadow>,
    #[cfg_attr(feature = "serde", serde(default))]
    pub inner_shadow: Option<Shadow>,
    #[cfg_attr(feature = "serde", serde(default))]
    pub preset_shadow: Option<PresetShadow>,
    #[cfg_attr(feature = "serde", serde(default))]
    pub glow: Option<Glow>,
    /// `a:softEdge` radius, pt.
    #[cfg_attr(feature = "serde", serde(default))]
    pub soft_edge: Option<f64>,
    #[cfg_attr(feature = "serde", serde(default))]
    pub reflection: Option<Reflection>,
    #[cfg_attr(feature = "serde", serde(default))]
    pub blur: Option<Blur>,
    #[cfg_attr(feature = "serde", serde(default))]
    pub fill_overlay: Option<FillOverlay>,
}

impl Effects {
    pub fn is_empty(&self) -> bool {
        *self == Effects::default()
    }
}

/// A shadow cast at (`dx`, `dy`) pt with a `blur` radius (pt).
#[derive(Debug, Clone, Default, PartialEq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct Shadow {
    pub dx: f64,
    pub dy: f64,
    pub blur: f64,
    pub rgb: Rgb,
    pub alpha: f64,
    /// An outer shadow's scale and skew (sx, sy as fractions; kx, ky in
    /// degrees), when not the identity.
    #[cfg_attr(feature = "serde", serde(default))]
    pub distortion: Option<(f64, f64, f64, f64)>,
}

/// A preset shadow (`shdw1` … `shdw20`) cast at (`dx`, `dy`) pt.
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct PresetShadow {
    pub preset: String,
    pub dx: f64,
    pub dy: f64,
    pub rgb: Rgb,
    pub alpha: f64,
}

/// A glow of `radius` pt.
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct Glow {
    pub radius: f64,
    pub rgb: Rgb,
    pub alpha: f64,
}

/// A reflection: lengths pt, angles degrees, alphas and positions 0–1.
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct Reflection {
    pub blur: f64,
    pub start_alpha: f64,
    pub start_pos: f64,
    pub end_alpha: f64,
    pub end_pos: f64,
    pub distance: f64,
    pub direction: f64,
    pub fade_direction: f64,
    pub sx: f64,
    pub sy: f64,
    pub kx: f64,
    pub ky: f64,
    pub align: String,
    pub rotate_with_shape: bool,
}

/// A blur of `radius` pt.
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct Blur {
    pub radius: f64,
    pub grow: bool,
}

/// A fill blended over the shape.
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct FillOverlay {
    pub blend: String,
    pub paint: Paint,
}

/// The offset a shadow `dist` EMU along `dir` (60 000ths of a degree,
/// clockwise on a y-down page) lands at, in pt.
pub fn polar(dist: i64, dir: i32) -> (f64, f64) {
    let d = emu_to_pt(dist);
    let a = angle_to_deg(dir as i64).to_radians();
    (d * a.cos(), d * a.sin())
}

fn shadow(s: &effect::Shadow, schemes: &dyn SchemeColors) -> Shadow {
    let (dx, dy) = polar(s.dist, s.dir);
    let (rgb, alpha) = color(&s.color, schemes);
    let (sx, sy) = s.scale.unwrap_or((100_000, 100_000));
    let (kx, ky) = s.skew.unwrap_or((0, 0));
    let distortion = ((sx, sy, kx, ky) != (100_000, 100_000, 0, 0)).then(|| {
        (
            pct_to_fraction(sx as i64),
            pct_to_fraction(sy as i64),
            angle_to_deg(kx as i64),
            angle_to_deg(ky as i64),
        )
    });
    Shadow {
        dx,
        dy,
        blur: emu_to_pt(s.blur),
        rgb,
        alpha,
        distortion,
    }
}

/// Resolve an effect list.
pub fn effects(
    fx: &effect::Effects,
    schemes: &dyn SchemeColors,
    note: &mut dyn FnMut(String),
) -> Effects {
    Effects {
        outer_shadow: fx.outer_shadow.as_ref().map(|s| shadow(s, schemes)),
        inner_shadow: fx.inner_shadow.as_ref().map(|s| shadow(s, schemes)),
        preset_shadow: fx.preset_shadow.as_ref().map(|p| {
            let (dx, dy) = polar(p.dist, p.dir);
            let (rgb, alpha) = color(&p.color, schemes);
            PresetShadow {
                preset: p.preset.clone(),
                dx,
                dy,
                rgb,
                alpha,
            }
        }),
        glow: fx.glow.as_ref().map(|g| {
            let (rgb, alpha) = color(&g.color, schemes);
            Glow {
                radius: emu_to_pt(g.radius),
                rgb,
                alpha,
            }
        }),
        soft_edge: fx.soft_edge.map(emu_to_pt),
        reflection: fx.reflection.as_ref().map(|r| Reflection {
            blur: emu_to_pt(r.blur),
            start_alpha: pct_to_fraction(r.start_alpha as i64),
            start_pos: pct_to_fraction(r.start_pos as i64),
            end_alpha: pct_to_fraction(r.end_alpha as i64),
            end_pos: pct_to_fraction(r.end_pos as i64),
            distance: emu_to_pt(r.dist),
            direction: angle_to_deg(r.dir as i64),
            fade_direction: angle_to_deg(r.fade_dir as i64),
            sx: pct_to_fraction(r.sx as i64),
            sy: pct_to_fraction(r.sy as i64),
            kx: angle_to_deg(r.kx as i64),
            ky: angle_to_deg(r.ky as i64),
            align: r.align.clone(),
            rotate_with_shape: r.rotate_with_shape,
        }),
        blur: fx.blur.as_ref().map(|b| Blur {
            radius: emu_to_pt(b.radius),
            grow: b.grow,
        }),
        fill_overlay: fx.fill_overlay.as_ref().map(|o| FillOverlay {
            blend: o.blend.clone(),
            paint: paint(&o.fill, schemes, note),
        }),
    }
}

/// A picture's look: its opacity (`a:alphaModFix`) and its other effects.
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct Picture {
    /// 0–1.
    pub opacity: f64,
    pub effects: Vec<ImageEffect>,
}

/// A resolved picture effect: fractions for percentages, degrees for
/// angles, pt for lengths, colours as bytes and alpha.
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum ImageEffect {
    Luminance {
        bright: f64,
        contrast: f64,
    },
    ColorChange {
        from: Rgb,
        to: Rgb,
        to_alpha: f64,
        use_alpha: bool,
    },
    Duotone {
        dark: Rgb,
        light: Rgb,
    },
    Grayscale,
    BiLevel {
        threshold: f64,
    },
    ColorReplace {
        rgb: Rgb,
        alpha: f64,
    },
    Hsl {
        hue: f64,
        sat: f64,
        lum: f64,
    },
    Tint {
        hue: f64,
        amount: f64,
    },
    Blur {
        radius: f64,
        grow: bool,
    },
    Alpha(String),
    /// Already in the image Office stored (see [`BlipEffect::Office2010`]).
    Office2010 {
        name: String,
        attrs: Vec<(String, String)>,
    },
    Other(String),
}

/// Resolve a picture's blip effects.
pub fn picture(blip: &Blip, schemes: &dyn SchemeColors) -> Picture {
    let f = |v: i32| pct_to_fraction(v as i64);
    let effects = blip
        .effects
        .iter()
        .map(|e| match e {
            BlipEffect::Luminance { bright, contrast } => ImageEffect::Luminance {
                bright: f(*bright),
                contrast: f(*contrast),
            },
            BlipEffect::ColorChange {
                from,
                to,
                use_alpha,
            } => {
                let (to, to_alpha) = color(to, schemes);
                ImageEffect::ColorChange {
                    from: color(from, schemes).0,
                    to,
                    to_alpha,
                    use_alpha: *use_alpha,
                }
            }
            BlipEffect::Duotone(a, b) => ImageEffect::Duotone {
                dark: color(a, schemes).0,
                light: color(b, schemes).0,
            },
            BlipEffect::Grayscale => ImageEffect::Grayscale,
            BlipEffect::BiLevel { threshold } => ImageEffect::BiLevel {
                threshold: f(*threshold),
            },
            BlipEffect::ColorReplace(c) => {
                let (rgb, alpha) = color(c, schemes);
                ImageEffect::ColorReplace { rgb, alpha }
            }
            BlipEffect::Hsl { hue, sat, lum } => ImageEffect::Hsl {
                hue: angle_to_deg(*hue as i64),
                sat: f(*sat),
                lum: f(*lum),
            },
            BlipEffect::Tint { hue, amount } => ImageEffect::Tint {
                hue: angle_to_deg(*hue as i64),
                amount: f(*amount),
            },
            BlipEffect::Blur { radius, grow } => ImageEffect::Blur {
                radius: emu_to_pt(*radius),
                grow: *grow,
            },
            BlipEffect::Alpha(n) => ImageEffect::Alpha(n.clone()),
            BlipEffect::Office2010 { name, attrs } => ImageEffect::Office2010 {
                name: name.clone(),
                attrs: attrs.clone(),
            },
            BlipEffect::Other(n) => ImageEffect::Other(n.clone()),
        })
        .collect();
    Picture {
        opacity: blip.alpha.map(|a| f(a).clamp(0.0, 1.0)).unwrap_or(1.0),
        effects,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::drawingml::color::Rgba;
    use crate::drawingml::{effect, paint as p};
    use crate::tree::parse;

    const NS: &str = r#"xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships""#;

    fn el(xml: &str) -> crate::tree::El {
        parse(format!(r#"<a:spPr {NS}>{xml}</a:spPr>"#).as_bytes()).unwrap()
    }

    fn slots() -> Vec<(String, Rgba)> {
        vec![("accent1".into(), Rgba::from_hex(0x4472c4))]
    }

    #[test]
    fn a_gradient_resolves_sorted_with_alpha_stops() {
        let f = p::fill_in(&el(r#"<a:gradFill><a:gsLst><a:gs pos="100000"><a:schemeClr val="accent1"><a:alpha val="0"/></a:schemeClr></a:gs><a:gs pos="0"><a:schemeClr val="accent1"/></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill>"#), &|_| None).unwrap();
        let mut notes = Vec::new();
        let paint = paint(&f, &slots(), &mut |n| notes.push(n));
        let Paint::Linear { stops, angle } = &paint else {
            panic!("{paint:?}")
        };
        assert_eq!(*angle, 90.0);
        assert_eq!(stops[0].pos, 0.0);
        assert_eq!(stops[0].rgb, [0x44, 0x72, 0xc4]);
        assert_eq!((stops[1].pos, stops[1].alpha), (100.0, 0.0));
        assert_eq!(paint.uniform_alpha(), None);
        assert_eq!(paint.color_at(0.5).unwrap().1, 0.5);
        assert!(notes.is_empty());
    }

    #[test]
    fn a_rect_path_gradient_is_radial_with_a_note() {
        let f = p::fill_in(&el(r#"<a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="FFFFFF"/></a:gs><a:gs pos="100000"><a:srgbClr val="000000"/></a:gs></a:gsLst><a:path path="rect"><a:fillToRect l="100000" t="0" r="0" b="100000"/></a:path><a:tileRect/></a:gradFill>"#), &|_| None).unwrap();
        let mut notes = Vec::new();
        let paint = paint(&f, &(), &mut |n| notes.push(n));
        assert_eq!(
            paint,
            Paint::Radial {
                stops: vec![
                    Stop {
                        pos: 0.0,
                        rgb: [255; 3],
                        alpha: 1.0
                    },
                    Stop {
                        pos: 100.0,
                        rgb: [0; 3],
                        alpha: 1.0
                    }
                ],
                center: (1.0, 0.0)
            }
        );
        assert_eq!(notes, ["a rect path gradient is drawn radial"]);
    }

    #[test]
    fn a_pattern_keeps_both_colours_and_mixes_by_its_coverage() {
        let f = p::fill_in(&el(r#"<a:pattFill prst="pct25"><a:fgClr><a:srgbClr val="000000"/></a:fgClr><a:bgClr><a:srgbClr val="FFFFFF"/></a:bgClr></a:pattFill>"#), &|_| None).unwrap();
        let Paint::Pattern(pp) = paint(&f, &(), &mut |_| {}) else {
            panic!()
        };
        assert_eq!(pp.coverage(), 0.25);
        assert_eq!(pp.mix(), ([191, 191, 191], 1.0));
        assert_eq!(pattern_coverage("dkDnDiag"), 0.5);
        assert_eq!(pattern_coverage("pct90"), 0.9);
    }

    #[test]
    fn a_line_resolves_in_points_with_its_dash_pattern() {
        let l = p::line(&parse(format!(r#"<a:ln {NS} w="38100" cmpd="sng"><a:solidFill><a:srgbClr val="FF0000"><a:alpha val="50000"/></a:srgbClr></a:solidFill><a:prstDash val="solid"/><a:custDash><a:ds d="400000" sp="300000"/></a:custDash><a:miter lim="800000"/><a:tailEnd type="none"/><a:headEnd type="stealth"/></a:ln>"#).as_bytes()).unwrap(), &|_| None);
        let s = stroke(&l, &(), 9525, &mut |_| {}).unwrap();
        assert_eq!(s.width, 3.0);
        assert_eq!(s.paint.uniform_alpha(), Some(0.5));
        assert_eq!((s.dash, s.compound, s.tail), (None, None, None));
        assert_eq!(s.head.as_deref(), Some("stealth"));
        assert_eq!(s.custom_dash, vec![(4.0, 3.0)]);
        assert_eq!(s.miter_limit, Some(8.0));
        let none = p::line(
            &parse(format!(r#"<a:ln {NS}><a:noFill/></a:ln>"#).as_bytes()).unwrap(),
            &|_| None,
        );
        assert_eq!(stroke(&none, &(), 9525, &mut |_| {}), None);
        let bare = p::line(
            &parse(
                format!(
                    r#"<a:ln {NS}><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln>"#
                )
                .as_bytes(),
            )
            .unwrap(),
            &|_| None,
        );
        assert_eq!(stroke(&bare, &(), 9525, &mut |_| {}).unwrap().width, 0.75);
    }

    #[test]
    fn effects_resolve_to_points_degrees_and_colours() {
        let e = effect::effects(
            &el(
                r#"<a:outerShdw blurRad="50800" dist="127000" dir="5400000" sx="50000" sy="50000"><a:schemeClr val="accent1"><a:alpha val="40000"/></a:schemeClr></a:outerShdw><a:glow rad="127000"><a:srgbClr val="FFC000"/></a:glow><a:softEdge rad="63500"/><a:reflection stA="50000" endPos="30000" dist="12700" sy="-100000"/><a:blur rad="25400"/>"#,
            ),
            &|_| None,
        );
        let fx = effects(&e, &slots(), &mut |_| {});
        let s = fx.outer_shadow.unwrap();
        assert!(s.dx.abs() < 1e-9 && (s.dy - 10.0).abs() < 1e-9);
        assert_eq!((s.blur, s.rgb, s.alpha), (4.0, [0x44, 0x72, 0xc4], 0.4));
        assert_eq!(s.distortion, Some((0.5, 0.5, 0.0, 0.0)));
        assert_eq!(fx.glow.unwrap().radius, 10.0);
        assert_eq!(fx.soft_edge, Some(5.0));
        let r = fx.reflection.unwrap();
        assert_eq!(
            (r.start_alpha, r.end_pos, r.distance, r.sy, r.fade_direction),
            (0.5, 0.3, 1.0, -1.0, 90.0)
        );
        assert_eq!(fx.blur.unwrap().radius, 2.0);
        assert!(effects(&effect::Effects::default(), &(), &mut |_| {}).is_empty());
    }

    #[test]
    fn a_picture_resolves_its_opacity_and_effects() {
        let b = p::blip(&parse(format!(r#"<a:blipFill {NS}><a:blip r:embed="r1"><a:alphaModFix amt="25000"/><a:duotone><a:srgbClr val="000000"/><a:schemeClr val="accent1"/></a:duotone><a:lum bright="10000"/></a:blip><a:stretch><a:fillRect/></a:stretch></a:blipFill>"#).as_bytes()).unwrap(), &|_| Some("media/a.png".into()));
        assert_eq!(b.fill_rect, None);
        let pic = picture(&b, &slots());
        assert_eq!(pic.opacity, 0.25);
        assert_eq!(
            pic.effects,
            vec![
                ImageEffect::Duotone {
                    dark: [0, 0, 0],
                    light: [0x44, 0x72, 0xc4]
                },
                ImageEffect::Luminance {
                    bright: 0.1,
                    contrast: 0.0
                }
            ]
        );
    }
}

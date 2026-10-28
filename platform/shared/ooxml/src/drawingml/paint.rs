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

//! DrawingML fills and lines as authored (ECMA-376 §20.1.8, §20.1.2.2.24):
//! `a:noFill`, `a:solidFill`, `a:gradFill`, `a:pattFill`, `a:blipFill`
//! (with the picture effects of its `a:blip`), `a:grpFill`, and `a:ln`.
//!
//! Values stay in the file's units (EMU, 60 000ths of a degree, 1 000ths of
//! a percent); [`super::resolved`] turns them into points, degrees and
//! fractions once the colours can be resolved.

use super::color::{color_in, Color};
use crate::tree::{El, Ns};

/// `l t r b` in 1 000ths of a percent (`a:srcRect`, `a:fillToRect`,
/// `a:tileRect`, `a:fillRect`).
pub type RelRect = (i32, i32, i32, i32);

/// A relationship resolver: an `r:embed` / `r:link` id to the part (or
/// URL) it names. A reader without relationships passes `&|_| None`.
pub type Rels<'a> = &'a dyn Fn(&str) -> Option<String>;

/// A fill.
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum Fill {
    None,
    Solid(Color),
    Gradient(Gradient),
    Blip(Blip),
    Pattern(Pattern),
    /// `a:grpFill` — use the group's fill.
    Group,
}

/// `a:gradFill`.
#[derive(Debug, Clone, Default, PartialEq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct Gradient {
    /// `a:gsLst`, in file order (which need not be position order).
    pub stops: Vec<GradientStop>,
    /// `a:lin` or `a:path`; `None` when the file gives neither (a linear
    /// gradient at 0°, as PowerPoint draws it).
    pub shade: Option<Shade>,
    /// `rotWithShape`, default true.
    pub rotate_with_shape: bool,
    /// `a:tileRect`: where the gradient's own box sits in the shape's.
    pub tile_rect: Option<RelRect>,
    /// `flip` (none / x / y / xy).
    pub flip: Option<String>,
}

/// One `a:gs`: a position in 1 000ths of a percent and a colour (whose
/// `alpha` transform makes the stop translucent).
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct GradientStop {
    pub pos: i32,
    pub color: Color,
}

/// How a gradient runs.
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum Shade {
    /// `a:lin ang` (60 000ths of a degree, clockwise) + `scaled`.
    Linear { angle: i32, scaled: bool },
    /// `a:path path` (`circle`, `rect`, `shape`) + `a:fillToRect`.
    Path {
        path: String,
        fill_to_rect: Option<RelRect>,
    },
}

/// `a:pattFill`.
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct Pattern {
    /// `prst` (pct5 … pct90, horz, dkDnDiag, smCheck, …), default `pct5`.
    pub preset: String,
    pub fg: Option<Color>,
    pub bg: Option<Color>,
}

/// `a:blipFill` (or `p:blipFill`, `pic:blipFill`, `xdr:blipFill`: the
/// same content in another namespace).
#[derive(Debug, Clone, Default, PartialEq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct Blip {
    /// The image part (the `r:embed` relationship, resolved).
    pub part: Option<String>,
    /// An `r:link` to an external image (resolved).
    pub link: Option<String>,
    /// `a:srcRect` l, t, r, b in 1 000ths of a percent.
    pub src_rect: Option<RelRect>,
    /// `a:stretch` (true) or `a:tile` (false).
    pub stretch: bool,
    /// `a:stretch/a:fillRect`, when it insets the image.
    pub fill_rect: Option<RelRect>,
    /// `a:tile`.
    pub tile: Option<Tile>,
    /// `a:alphaModFix amt`, 1 000ths of a percent.
    pub alpha: Option<i32>,
    /// The other effects on the `a:blip`, in file order (the Office 2010
    /// picture corrections and artistic effects among them).
    pub effects: Vec<BlipEffect>,
    /// `rotWithShape`.
    pub rotate_with_shape: Option<bool>,
    /// `dpi`.
    pub dpi: Option<u32>,
}

/// `a:tile`.
#[derive(Debug, Clone, Default, PartialEq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct Tile {
    /// Offsets in EMU.
    pub tx: i64,
    pub ty: i64,
    /// Scales in 1 000ths of a percent.
    pub sx: i32,
    pub sy: i32,
    /// `flip` (none / x / y / xy).
    pub flip: Option<String>,
    /// `algn` (tl, t, tr, l, ctr, r, bl, b, br).
    pub align: Option<String>,
}

/// One effect on an `a:blip` (ECMA-376 §20.1.8.13), or one Office 2010
/// image effect (`a14:imgEffect` in the blip's extension list).
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum BlipEffect {
    /// `a:lum bright contrast` (1 000ths of a percent, −100 000..100 000).
    Luminance { bright: i32, contrast: i32 },
    /// `a:clrChange`: `clrFrom` drawn as `clrTo` (`useA`: compare alpha).
    ColorChange {
        from: Color,
        to: Color,
        use_alpha: bool,
    },
    /// `a:duotone`: the image's luminance between two colours.
    Duotone(Color, Color),
    /// `a:grayscl`.
    Grayscale,
    /// `a:biLevel thresh` (1 000ths of a percent).
    BiLevel { threshold: i32 },
    /// `a:clrRepl`: every pixel's colour replaced, alpha kept.
    ColorReplace(Color),
    /// `a:hsl hue sat lum`.
    Hsl { hue: i32, sat: i32, lum: i32 },
    /// `a:tint hue amt`.
    Tint { hue: i32, amount: i32 },
    /// `a:blur rad grow`.
    Blur { radius: i64, grow: bool },
    /// `a:alphaBiLevel`, `a:alphaCeiling`, `a:alphaFloor`, `a:alphaInv`,
    /// `a:alphaMod`, `a:alphaRepl`, `a:alphaOutset`: alpha effects, by name.
    Alpha(String),
    /// An Office 2010 image effect (`a14:imgEffect`'s child:
    /// `artisticPencilSketch`, `saturation`, `brightnessContrast`,
    /// `colorTemperature`, `sharpenSoften`, …) with its attributes.
    /// Office stores the image these produce as the blip itself and the
    /// original in `a14:imgLayer`, so the picture as drawn already has it.
    Office2010 {
        name: String,
        attrs: Vec<(String, String)>,
    },
    /// Anything else, by local name.
    Other(String),
}

/// `a:ln`.
#[derive(Debug, Clone, Default, PartialEq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct Line {
    /// `w`, EMU.
    pub width: Option<i64>,
    pub fill: Option<Fill>,
    /// `a:prstDash val`.
    pub dash: Option<String>,
    /// `a:custDash` (dash, space) pairs in 1 000ths of a percent of the width.
    pub custom_dash: Vec<(i32, i32)>,
    /// `cap` (rnd / sq / flat).
    pub cap: Option<String>,
    /// round / bevel / miter.
    pub join: Option<String>,
    /// `a:miter lim` (1 000ths of a percent of the width).
    pub miter_limit: Option<i32>,
    /// `cmpd` (sng / dbl / thickThin / thinThick / tri).
    pub compound: Option<String>,
    /// `algn` (ctr / in).
    pub align: Option<String>,
    pub head: Option<LineEnd>,
    pub tail: Option<LineEnd>,
}

/// `a:headEnd` / `a:tailEnd`.
#[derive(Debug, Clone, Default, PartialEq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct LineEnd {
    /// `type` (none / triangle / stealth / diamond / oval / arrow).
    pub kind: String,
    /// `w` (sm / med / lg).
    pub w: Option<String>,
    /// `len` (sm / med / lg).
    pub len: Option<String>,
}

/// The fill choice among `el`'s children (`a:noFill`, `a:solidFill`, …).
pub fn fill_in(el: &El, rels: Rels) -> Option<Fill> {
    el.children.iter().find_map(|c| fill(c, rels))
}

/// One fill element; `None` for an element that is not one.
pub fn fill(el: &El, rels: Rels) -> Option<Fill> {
    if el.ns != Ns::A {
        return None;
    }
    Some(match el.local.as_str() {
        "noFill" => Fill::None,
        "solidFill" => Fill::Solid(color_in(el)?),
        "gradFill" => Fill::Gradient(gradient(el)),
        "blipFill" => Fill::Blip(blip(el, rels)),
        "pattFill" => Fill::Pattern(Pattern {
            preset: el.attr("prst").unwrap_or("pct5").to_string(),
            fg: el.child(Ns::A, "fgClr").and_then(color_in),
            bg: el.child(Ns::A, "bgClr").and_then(color_in),
        }),
        "grpFill" => Fill::Group,
        _ => return None,
    })
}

/// `a:gradFill`.
pub fn gradient(el: &El) -> Gradient {
    let stops = el
        .child(Ns::A, "gsLst")
        .map(|l| {
            l.children_named(Ns::A, "gs")
                .filter_map(|gs| {
                    Some(GradientStop {
                        pos: gs.attr_i32("pos").unwrap_or(0),
                        color: color_in(gs)?,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let shade = if let Some(l) = el.child(Ns::A, "lin") {
        Some(Shade::Linear {
            angle: l.attr_i32("ang").unwrap_or(0),
            scaled: l.attr_bool("scaled").unwrap_or(false),
        })
    } else {
        el.child(Ns::A, "path").map(|p| Shade::Path {
            path: p.attr("path").unwrap_or("circle").to_string(),
            fill_to_rect: p.child(Ns::A, "fillToRect").map(rect_attrs),
        })
    };
    Gradient {
        stops,
        shade,
        rotate_with_shape: el.attr_bool("rotWithShape").unwrap_or(true),
        tile_rect: el.child(Ns::A, "tileRect").map(rect_attrs),
        flip: el.attr("flip").map(str::to_string),
    }
}

/// `l t r b` attributes in 1 000ths of a percent.
pub fn rect_attrs(el: &El) -> RelRect {
    (
        el.attr_i32("l").unwrap_or(0),
        el.attr_i32("t").unwrap_or(0),
        el.attr_i32("r").unwrap_or(0),
        el.attr_i32("b").unwrap_or(0),
    )
}

/// A blip fill element, in whatever namespace it is written (the children
/// are DrawingML's).
pub fn blip(el: &El, rels: Rels) -> Blip {
    let b = el.child(Ns::A, "blip");
    let rel = |attr: &str| b.and_then(|b| b.attr_ns(Ns::R, attr)).and_then(rels);
    let stretch = el.child(Ns::A, "stretch");
    let tile = el.child(Ns::A, "tile").map(|t| Tile {
        tx: t.attr_i64("tx").unwrap_or(0),
        ty: t.attr_i64("ty").unwrap_or(0),
        sx: t.attr_i32("sx").unwrap_or(100_000),
        sy: t.attr_i32("sy").unwrap_or(100_000),
        flip: t.attr("flip").map(str::to_string),
        align: t.attr("algn").map(str::to_string),
    });
    let mut alpha = None;
    let mut effects = Vec::new();
    for e in b.map(|b| b.children.as_slice()).unwrap_or_default() {
        if e.ns != Ns::A {
            continue;
        }
        match blip_effect(e) {
            Some(BlipEffect::Alpha(name)) if name == "alphaModFix" => {
                alpha = Some(e.attr_i32("amt").unwrap_or(100_000));
            }
            Some(fx) => effects.push(fx),
            None => {}
        }
    }
    if let Some(ext) = b.and_then(|b| b.child(Ns::A, "extLst")) {
        office_2010_effects(ext, &mut effects);
    }
    Blip {
        part: rel("embed"),
        link: rel("link"),
        src_rect: el.child(Ns::A, "srcRect").map(rect_attrs),
        stretch: tile.is_none(),
        fill_rect: stretch
            .and_then(|s| s.child(Ns::A, "fillRect"))
            .map(rect_attrs)
            .filter(|r| *r != (0, 0, 0, 0)),
        tile,
        alpha,
        effects,
        rotate_with_shape: el.attr_bool("rotWithShape"),
        dpi: el.attr_u32("dpi"),
    }
}

/// One `a:blip` child as an effect; `None` for one that is not an effect
/// (`a:extLst`).
fn blip_effect(e: &El) -> Option<BlipEffect> {
    let pct = |name: &str| e.attr_i32(name).unwrap_or(0);
    Some(match e.local.as_str() {
        "lum" => BlipEffect::Luminance {
            bright: pct("bright"),
            contrast: pct("contrast"),
        },
        "clrChange" => BlipEffect::ColorChange {
            from: e.child(Ns::A, "clrFrom").and_then(color_in)?,
            to: e.child(Ns::A, "clrTo").and_then(color_in)?,
            use_alpha: e.attr_bool("useA").unwrap_or(true),
        },
        "duotone" => {
            let mut cs = e.children.iter().filter_map(super::color::color);
            BlipEffect::Duotone(cs.next()?, cs.next()?)
        }
        "grayscl" => BlipEffect::Grayscale,
        "biLevel" => BlipEffect::BiLevel {
            threshold: pct("thresh"),
        },
        "clrRepl" => BlipEffect::ColorReplace(color_in(e)?),
        "hsl" => BlipEffect::Hsl {
            hue: pct("hue"),
            sat: pct("sat"),
            lum: pct("lum"),
        },
        "tint" => BlipEffect::Tint {
            hue: pct("hue"),
            amount: pct("amt"),
        },
        "blur" => BlipEffect::Blur {
            radius: e.attr_i64("rad").unwrap_or(0),
            grow: e.attr_bool("grow").unwrap_or(true),
        },
        "alphaModFix" | "alphaBiLevel" | "alphaCeiling" | "alphaFloor" | "alphaInv"
        | "alphaMod" | "alphaRepl" | "alphaOutset" => BlipEffect::Alpha(e.local.clone()),
        "extLst" => return None,
        other => BlipEffect::Other(other.to_string()),
    })
}

/// The Office 2010 image effects under an extension list
/// (`a:ext/a14:imgProps/a14:imgLayer/a14:imgEffect/*`).
fn office_2010_effects(ext_lst: &El, out: &mut Vec<BlipEffect>) {
    fn walk(el: &El, out: &mut Vec<BlipEffect>) {
        for c in &el.children {
            if c.local == "imgEffect" {
                for fx in &c.children {
                    out.push(BlipEffect::Office2010 {
                        name: fx.local.clone(),
                        attrs: fx
                            .attrs
                            .iter()
                            .map(|a| (a.local.clone(), a.value.clone()))
                            .collect(),
                    });
                }
            } else {
                walk(c, out);
            }
        }
    }
    walk(ext_lst, out);
}

/// `a:ln`.
pub fn line(el: &El, rels: Rels) -> Line {
    let end = |name: &str| {
        el.child(Ns::A, name).map(|e| LineEnd {
            kind: e.attr("type").unwrap_or("none").to_string(),
            w: e.attr("w").map(str::to_string),
            len: e.attr("len").map(str::to_string),
        })
    };
    let join = ["round", "bevel", "miter"]
        .iter()
        .find(|j| el.child(Ns::A, j).is_some())
        .map(|j| j.to_string());
    Line {
        width: el.attr_i64("w"),
        fill: fill_in(el, rels),
        dash: el
            .child(Ns::A, "prstDash")
            .and_then(|d| d.attr("val"))
            .map(str::to_string),
        custom_dash: el
            .child(Ns::A, "custDash")
            .map(|c| {
                c.children_named(Ns::A, "ds")
                    .map(|ds| {
                        (
                            ds.attr_i32("d").unwrap_or(0),
                            ds.attr_i32("sp").unwrap_or(0),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default(),
        cap: el.attr("cap").map(str::to_string),
        miter_limit: el.child(Ns::A, "miter").and_then(|m| m.attr_i32("lim")),
        join,
        compound: el.attr("cmpd").map(str::to_string),
        align: el.attr("algn").map(str::to_string),
        head: end("headEnd"),
        tail: end("tailEnd"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::drawingml::color::ColorBase;
    use crate::tree::parse;

    const NS: &str = r#"xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main""#;

    fn sp_pr(inner: &str) -> El {
        parse(format!(r#"<a:spPr {NS}>{inner}</a:spPr>"#).as_bytes()).unwrap()
    }

    fn rels(id: &str) -> Option<String> {
        (id == "rId2").then(|| "ppt/media/image1.png".to_string())
    }

    #[test]
    fn solid_none_group_and_pattern_fills() {
        assert_eq!(fill_in(&sp_pr("<a:noFill/>"), &rels), Some(Fill::None));
        assert_eq!(fill_in(&sp_pr("<a:grpFill/>"), &rels), Some(Fill::Group));
        assert_eq!(
            fill_in(
                &sp_pr(r#"<a:solidFill><a:srgbClr val="FF0000"/></a:solidFill>"#),
                &rels
            ),
            Some(Fill::Solid(Color::srgb(0xff0000)))
        );
        let Some(Fill::Pattern(p)) = fill_in(
            &sp_pr(
                r#"<a:pattFill prst="dkDnDiag"><a:fgClr><a:schemeClr val="accent1"/></a:fgClr><a:bgClr><a:srgbClr val="FFFFFF"/></a:bgClr></a:pattFill>"#,
            ),
            &rels,
        ) else {
            panic!("pattern")
        };
        assert_eq!(p.preset, "dkDnDiag");
        assert_eq!(p.fg.unwrap().base, ColorBase::Scheme("accent1".into()));
        assert_eq!(p.bg, Some(Color::srgb(0xffffff)));
        // An element that is no fill is skipped.
        assert_eq!(fill_in(&sp_pr("<a:prstGeom/>"), &rels), None);
    }

    #[test]
    fn gradients_keep_stops_alpha_shade_and_tiling() {
        let Some(Fill::Gradient(g)) = fill_in(
            &sp_pr(
                r#"<a:gradFill flip="x" rotWithShape="0"><a:gsLst><a:gs pos="100000"><a:srgbClr val="0000FF"><a:alpha val="40000"/></a:srgbClr></a:gs><a:gs pos="0"><a:srgbClr val="FF0000"/></a:gs></a:gsLst><a:lin ang="2700000" scaled="1"/><a:tileRect r="-50000"/></a:gradFill>"#,
            ),
            &rels,
        ) else {
            panic!("gradient")
        };
        assert_eq!(g.stops.len(), 2);
        assert_eq!(g.stops[0].pos, 100_000);
        assert_eq!(g.stops[0].color.transforms, vec![("alpha".into(), 40_000)]);
        assert_eq!(
            g.shade,
            Some(Shade::Linear {
                angle: 2_700_000,
                scaled: true
            })
        );
        assert!(!g.rotate_with_shape);
        assert_eq!(g.tile_rect, Some((0, 0, -50_000, 0)));
        assert_eq!(g.flip.as_deref(), Some("x"));
        let Some(Fill::Gradient(p)) = fill_in(
            &sp_pr(
                r#"<a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="FFFFFF"/></a:gs></a:gsLst><a:path path="rect"><a:fillToRect l="50000" t="50000" r="50000" b="50000"/></a:path></a:gradFill>"#,
            ),
            &rels,
        ) else {
            panic!("path")
        };
        assert_eq!(
            p.shade,
            Some(Shade::Path {
                path: "rect".into(),
                fill_to_rect: Some((50_000, 50_000, 50_000, 50_000))
            })
        );
        assert!(p.rotate_with_shape);
    }

    #[test]
    fn blips_read_crop_tiling_and_every_picture_effect() {
        let el = parse(format!(r#"<p:blipFill xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" {NS} dpi="96" rotWithShape="1"><a:blip r:embed="rId2"><a:alphaModFix amt="60000"/><a:lum bright="20000" contrast="-10000"/><a:clrChange><a:clrFrom><a:srgbClr val="FFFFFF"/></a:clrFrom><a:clrTo><a:srgbClr val="FFFFFF"><a:alpha val="0"/></a:srgbClr></a:clrTo></a:clrChange><a:duotone><a:prstClr val="black"/><a:schemeClr val="accent2"/></a:duotone><a:grayscl/><a:biLevel thresh="50000"/><a:extLst><a:ext uri="{{BEBA8EAE-BF5A-486C-A8C5-ECC9F3942E4B}}"><a14:imgProps><a14:imgLayer r:embed="rId3"><a14:imgEffect><a14:artisticPencilSketch pressure="7"/></a14:imgEffect><a14:imgEffect><a14:saturation sat="200000"/></a14:imgEffect></a14:imgLayer></a14:imgProps></a:ext></a:extLst></a:blip><a:srcRect l="10000" b="5000"/><a:tile tx="12700" sx="50000" sy="50000" algn="ctr"/></p:blipFill>"#).as_bytes()).unwrap();
        let b = blip(&el, &rels);
        assert_eq!(b.part.as_deref(), Some("ppt/media/image1.png"));
        assert_eq!(b.alpha, Some(60_000));
        assert_eq!(b.src_rect, Some((10_000, 0, 0, 5_000)));
        assert!(!b.stretch);
        assert_eq!(b.tile.as_ref().unwrap().sx, 50_000);
        assert_eq!(b.tile.as_ref().unwrap().align.as_deref(), Some("ctr"));
        assert_eq!(b.dpi, Some(96));
        assert_eq!(b.rotate_with_shape, Some(true));
        let names: Vec<String> = b
            .effects
            .iter()
            .map(|e| match e {
                BlipEffect::Luminance { bright, contrast } => format!("lum {bright} {contrast}"),
                BlipEffect::ColorChange { use_alpha, .. } => format!("clrChange {use_alpha}"),
                BlipEffect::Duotone(..) => "duotone".into(),
                BlipEffect::Grayscale => "grayscl".into(),
                BlipEffect::BiLevel { threshold } => format!("biLevel {threshold}"),
                BlipEffect::Office2010 { name, attrs } => format!("{name} {}", attrs[0].1),
                other => format!("{other:?}"),
            })
            .collect();
        assert_eq!(
            names,
            [
                "lum 20000 -10000",
                "clrChange true",
                "duotone",
                "grayscl",
                "biLevel 50000",
                "artisticPencilSketch 7",
                "saturation 200000",
            ]
        );
    }

    #[test]
    fn lines_read_width_dash_join_compound_and_ends() {
        let el = parse(format!(r#"<a:ln {NS} w="25400" cap="rnd" cmpd="dbl" algn="in"><a:solidFill><a:srgbClr val="00FF00"/></a:solidFill><a:custDash><a:ds d="300000" sp="100000"/></a:custDash><a:miter lim="800000"/><a:headEnd type="triangle" w="lg" len="sm"/><a:tailEnd type="oval"/></a:ln>"#).as_bytes()).unwrap();
        let l = line(&el, &rels);
        assert_eq!(l.width, Some(25_400));
        assert_eq!(l.fill, Some(Fill::Solid(Color::srgb(0x00ff00))));
        assert_eq!(l.custom_dash, vec![(300_000, 100_000)]);
        assert_eq!(l.cap.as_deref(), Some("rnd"));
        assert_eq!(l.join.as_deref(), Some("miter"));
        assert_eq!(l.miter_limit, Some(800_000));
        assert_eq!(l.compound.as_deref(), Some("dbl"));
        assert_eq!(l.align.as_deref(), Some("in"));
        let head = l.head.unwrap();
        assert_eq!(
            (head.kind.as_str(), head.w.as_deref(), head.len.as_deref()),
            ("triangle", Some("lg"), Some("sm"))
        );
        assert_eq!(l.tail.unwrap().kind, "oval");
        let dashed = line(
            &parse(format!(r#"<a:ln {NS}><a:prstDash val="sysDot"/><a:round/></a:ln>"#).as_bytes())
                .unwrap(),
            &rels,
        );
        assert_eq!(dashed.dash.as_deref(), Some("sysDot"));
        assert_eq!(dashed.join.as_deref(), Some("round"));
        assert_eq!(dashed.width, None);
    }
}

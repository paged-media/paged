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

//! # slide-anim — a slide's animations played, listed and edited
//! (slide ADR 714)
//!
//! The timing tree (`pptx_core::anim`) is
//! - **played** ([`player::Player`]): compiled once ([`schedule`]) and
//!   evaluated per frame ([`eval`]) from the show's clicks into one state
//!   per layer (visibility, opacity, placement, a wipe or fade mask, colour
//!   overrides), deterministic and pure;
//! - **listed** ([`flat`]): the effects as PowerPoint's Animation Pane shows
//!   them (start, delay, duration, repeat, trigger, click);
//! - **edited** ([`author`]): add, remove, reorder, retime, change the
//!   effect or its direction, copy a shape's effects to another (Animation
//!   Painter), rebuilt in PowerPoint's own structure from the preset table
//!   ([`presets`], recorded from PowerPoint).

pub mod author;
pub mod eval;
pub mod flat;
pub mod fmla;
pub mod path;
pub mod player;
pub mod presets;
pub mod schedule;

use std::collections::BTreeMap;

use pptx_core::anim::{AnimColor, AnimValue, ColorBy, SpSub, SpTarget, TargetEl, TimeNode};

use crate::fmla::Expr;
use crate::path::MotionPath;

/// The id the player and the bundle know a shape target by: its page item,
/// else its shape key, else the deck's `spid`.
pub fn target_id(sp: &SpTarget) -> String {
    if let Some(i) = &sp.item {
        return i.clone();
    }
    if let Some(k) = &sp.key {
        return format!("key:{k}");
    }
    format!("spid:{}", sp.spid)
}

/// The layer keys a target animates: the shape (`id`), its background
/// (`id#bg`), each paragraph of a range (`id#p<i>`), a character range
/// (`id#c<st>-<end>`).
pub fn layer_keys(sp: &SpTarget) -> Vec<String> {
    let id = target_id(sp);
    match &sp.sub {
        None
        | Some(SpSub::SubSp { .. })
        | Some(SpSub::OleChartEl { .. })
        | Some(SpSub::Raw { .. }) => vec![id],
        Some(SpSub::Bg) => vec![format!("{id}#bg")],
        Some(SpSub::Paragraphs { st, end }) => (*st..=(*end).max(*st))
            .map(|i| format!("{id}#p{i}"))
            .collect(),
        Some(SpSub::Chars { st, end }) => vec![format!("{id}#c{st}-{end}")],
    }
}

/// What compiling a slide's timing needs: the slide's size (motion paths
/// are measured in points) and the theme's colours (`schemeClr`).
#[derive(Debug, Clone, Default)]
pub struct Ctx {
    pub w: f64,
    pub h: f64,
    pub theme: BTreeMap<String, String>,
}

/// An animated attribute (`p:attrName`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Attr {
    Visibility,
    Opacity,
    X,
    Y,
    W,
    H,
    Rot,
    SkewX,
    SkewY,
    Fill,
    Line,
    Text,
    Bold,
    Italic,
    Underline,
    FontSize,
    /// One the player does not show (`fill.type`, `fill.on`,
    /// `style.fontFamily`, …).
    Other,
}

impl Attr {
    pub fn of(name: &str) -> Attr {
        match name.trim() {
            "style.visibility" => Attr::Visibility,
            "style.opacity" => Attr::Opacity,
            "ppt_x" => Attr::X,
            "ppt_y" => Attr::Y,
            "ppt_w" => Attr::W,
            "ppt_h" => Attr::H,
            "r" | "ppt_r" | "style.rotation" => Attr::Rot,
            "xshear" => Attr::SkewX,
            "yshear" => Attr::SkewY,
            "fillcolor" | "fillColor" | "fill.color" => Attr::Fill,
            "stroke.color" | "strokecolor" => Attr::Line,
            "style.color" => Attr::Text,
            "style.fontWeight" => Attr::Bold,
            "style.fontStyle" => Attr::Italic,
            "style.textDecorationUnderline" => Attr::Underline,
            "style.fontSize" => Attr::FontSize,
            _ => Attr::Other,
        }
    }
}

/// A value an animation takes.
#[derive(Debug, Clone, PartialEq)]
pub enum Val {
    Num(Expr),
    Str(String),
    Clr([u8; 3]),
}

impl Val {
    fn of(v: &AnimValue, ctx: &Ctx) -> Option<Val> {
        Some(match v {
            AnimValue::Bool(b) => Val::Num(Expr::Num(if *b { 1.0 } else { 0.0 })),
            AnimValue::Int(i) => Val::Num(Expr::Num(*i as f64)),
            AnimValue::Flt(f) => Val::Num(Expr::Num(f.trim().parse().ok()?)),
            AnimValue::Str(s) => match Expr::parse(s) {
                Some(e) => Val::Num(e),
                None => Val::Str(s.clone()),
            },
            AnimValue::Clr(c) => Val::Clr(color(c, ctx)?),
        })
    }

    /// A value written as an attribute (`from`, `to`, `by` of `p:anim`).
    fn of_attr(s: &str) -> Val {
        match Expr::parse(s) {
            Some(e) => Val::Num(e),
            None => Val::Str(s.to_string()),
        }
    }
}

/// One `p:tav`.
#[derive(Debug, Clone, PartialEq)]
pub struct Point {
    /// 0..1 of the duration.
    pub tm: f64,
    pub fmla: Option<Expr>,
    pub val: Option<Val>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Op {
    Set {
        attr: Attr,
        to: Option<Val>,
    },
    Anim {
        attr: Attr,
        sum: bool,
        discrete: bool,
        points: Vec<Point>,
        from: Option<Val>,
        to: Option<Val>,
        by: Option<Val>,
    },
    Effect {
        filter: String,
        sub: Option<String>,
        /// `in` / `out` / `none`.
        transition: String,
        /// `prLst="opacity: 0.5"` of an `image` filter.
        opacity: Option<f64>,
    },
    Motion {
        path: Option<MotionPath>,
        from: Option<(f64, f64)>,
        to: Option<(f64, f64)>,
        by: Option<(f64, f64)>,
    },
    Scale {
        from: Option<(f64, f64)>,
        to: Option<(f64, f64)>,
        by: Option<(f64, f64)>,
    },
    Rot {
        from: Option<f64>,
        to: Option<f64>,
        by: Option<f64>,
    },
    Clr {
        attr: Attr,
        hsl: bool,
        ccw: bool,
        from: Option<[u8; 3]>,
        to: Option<[u8; 3]>,
        by: Option<ColorBy>,
    },
    Cmd {
        cmd: String,
    },
}

/// A behaviour as the player runs it.
#[derive(Debug, Clone, PartialEq)]
pub struct Behaviour {
    /// The shape's target id (`target_id`).
    pub target: String,
    /// The layers it acts on.
    pub keys: Vec<String>,
    pub op: Op,
    /// Formula `rand()` seed: the behaviour's node id.
    pub seed: u64,
}

/// Compile a behaviour node; `None` for one that does not name a shape.
pub fn behaviour(n: &TimeNode, ctx: &Ctx) -> Option<Behaviour> {
    let b = n.bhvr()?;
    let TargetEl::Sp(sp) = &b.target else {
        return None;
    };
    let attr = b
        .attr_names
        .as_ref()
        .and_then(|a| a.first())
        .map(|a| Attr::of(a))
        .unwrap_or(Attr::Other);
    let op = match n {
        TimeNode::Set { to, .. } => Op::Set {
            attr,
            to: to.as_ref().and_then(|v| Val::of(v, ctx)),
        },
        TimeNode::Anim {
            by,
            from,
            to,
            calcmode,
            points,
            ..
        } => Op::Anim {
            attr,
            sum: b.additive.as_deref() == Some("sum"),
            discrete: calcmode.as_deref() == Some("discrete"),
            points: points
                .iter()
                .flatten()
                .filter_map(|p| {
                    let tm = match p.tm.as_deref().map(str::trim) {
                        Some("indefinite") => return None,
                        Some(t) => t.parse::<f64>().ok()? / 100_000.0,
                        None => 0.0,
                    };
                    Some(Point {
                        tm,
                        fmla: p.fmla.as_deref().and_then(Expr::parse),
                        val: p.val.as_ref().and_then(|v| Val::of(v, ctx)),
                    })
                })
                .collect(),
            from: from.as_deref().map(Val::of_attr),
            to: to.as_deref().map(Val::of_attr),
            by: by.as_deref().map(Val::of_attr),
        },
        TimeNode::AnimEffect {
            transition,
            filter,
            pr_lst,
            ..
        } => {
            let f = filter.clone().unwrap_or_else(|| "fade".into());
            let (name, sub) = match f.find('(') {
                Some(i) => (
                    f[..i].trim().to_string(),
                    Some(f[i + 1..].trim_end_matches(')').trim().to_string()),
                ),
                None => (f.trim().to_string(), None),
            };
            let opacity = pr_lst.as_deref().and_then(|p| {
                p.split(';').find_map(|kv| {
                    let (k, v) = kv.split_once(':')?;
                    (k.trim() == "opacity").then(|| v.trim().parse().ok())?
                })
            });
            Op::Effect {
                filter: name,
                sub,
                transition: transition.clone().unwrap_or_else(|| "in".into()),
                opacity,
            }
        }
        TimeNode::AnimMotion {
            path, by, from, to, ..
        } => {
            let f = |p: &Option<(i64, i64)>| {
                p.map(|(x, y)| (x as f64 / 100_000.0, y as f64 / 100_000.0))
            };
            Op::Motion {
                path: path
                    .as_deref()
                    .map(|p| MotionPath::parse(p, ctx.w.max(1.0), ctx.h.max(1.0))),
                from: f(from),
                to: f(to),
                by: f(by),
            }
        }
        TimeNode::AnimScale { by, from, to, .. } => {
            let f = |p: &Option<(i64, i64)>| {
                p.map(|(x, y)| (x as f64 / 100_000.0, y as f64 / 100_000.0))
            };
            Op::Scale {
                from: f(from),
                to: f(to),
                by: f(by),
            }
        }
        TimeNode::AnimRot { by, from, to, .. } => {
            let f = |v: &Option<i64>| v.map(|v| v as f64 / 60_000.0);
            Op::Rot {
                from: f(from),
                to: f(to),
                by: f(by),
            }
        }
        TimeNode::AnimClr {
            clr_spc,
            dir,
            by,
            from,
            to,
            ..
        } => Op::Clr {
            attr,
            hsl: clr_spc.as_deref() == Some("hsl"),
            ccw: dir.as_deref() == Some("ccw"),
            from: from.as_ref().and_then(|c| color(c, ctx)),
            to: to.as_ref().and_then(|c| color(c, ctx)),
            by: by.clone(),
        },
        TimeNode::Cmd { cmd, .. } => Op::Cmd {
            cmd: cmd.clone().unwrap_or_default(),
        },
        _ => return None,
    };
    Some(Behaviour {
        target: target_id(sp),
        keys: layer_keys(sp),
        op,
        seed: b.ctn.id.unwrap_or(0) as u64,
    })
}

/// A DrawingML colour element as RGB: `srgbClr`, `schemeClr` (through the
/// theme), `prstClr` (the common names), `sysClr` (`lastClr`), with
/// `lumMod` / `lumOff` / `tint` / `shade` applied.
pub fn color(c: &AnimColor, ctx: &Ctx) -> Option<[u8; 3]> {
    let x = c.xml.as_str();
    let tag_end = x.find([' ', '/', '>'])?;
    let tag = x.get(1..tag_end)?;
    let local = tag.rsplit(':').next()?;
    let attr = |src: &str, k: &str| -> Option<String> {
        let pat = format!(" {k}=\"");
        let i = src.find(&pat)? + pat.len();
        let j = src[i..].find('"')? + i;
        Some(src[i..j].to_string())
    };
    let head_end = x.find('>')?;
    let head = &x[..head_end];
    let hex = match local {
        "srgbClr" => attr(head, "val")?,
        "sysClr" => attr(head, "lastClr").unwrap_or_else(|| "000000".into()),
        "schemeClr" => {
            let v = attr(head, "val")?;
            let alias = match v.as_str() {
                "tx1" => "dk1",
                "bg1" => "lt1",
                "tx2" => "dk2",
                "bg2" => "lt2",
                o => o,
            };
            ctx.theme
                .get(&v)
                .or_else(|| ctx.theme.get(alias))
                .cloned()
                .unwrap_or_else(|| default_theme(alias).to_string())
        }
        "prstClr" => preset_color(&attr(head, "val")?).to_string(),
        "scrgbClr" => {
            let p = |k| {
                attr(head, k)
                    .and_then(|v| v.parse::<f64>().ok())
                    .unwrap_or(0.0)
                    / 100_000.0
            };
            let to = |v: f64| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
            format!("{:02X}{:02X}{:02X}", to(p("r")), to(p("g")), to(p("b")))
        }
        _ => return None,
    };
    let mut rgb = hex_rgb(&hex)?;
    // Transforms in document order.
    let mut rest = &x[head_end..];
    while let Some(i) = rest.find('<') {
        let t = &rest[i + 1..];
        let e = t.find('>').unwrap_or(t.len());
        let el = &t[..e];
        let name = el
            .split([' ', '/'])
            .next()
            .unwrap_or("")
            .rsplit(':')
            .next()
            .unwrap_or("");
        let v = attr(&format!(" {el}"), "val")
            .and_then(|v| v.parse::<f64>().ok())
            .map(|v| v / 100_000.0);
        if let Some(v) = v {
            let (h, s, l) = rgb_hsl(rgb);
            rgb = match name {
                "lumMod" => hsl_rgb(h, s, (l * v).clamp(0.0, 1.0)),
                "lumOff" => hsl_rgb(h, s, (l + v).clamp(0.0, 1.0)),
                "tint" => rgb.map(|c| (c as f64 + (255.0 - c as f64) * (1.0 - v)).round() as u8),
                "shade" => rgb.map(|c| (c as f64 * v).round() as u8),
                _ => rgb,
            };
        }
        rest = &t[e.min(t.len())..];
    }
    Some(rgb)
}

/// Office's default theme (when the slide's is not given).
fn default_theme(slot: &str) -> &'static str {
    match slot {
        "dk1" => "000000",
        "lt1" => "FFFFFF",
        "dk2" => "0E2841",
        "lt2" => "E8E8E8",
        "accent1" => "156082",
        "accent2" => "E97132",
        "accent3" => "196B24",
        "accent4" => "0F9ED5",
        "accent5" => "A02B93",
        "accent6" => "4EA72E",
        "hlink" => "467886",
        "folHlink" => "96607D",
        _ => "000000",
    }
}

fn preset_color(name: &str) -> &'static str {
    match name {
        "black" => "000000",
        "white" => "FFFFFF",
        "red" => "FF0000",
        "green" => "008000",
        "blue" => "0000FF",
        "yellow" => "FFFF00",
        "orange" => "FFA500",
        "purple" => "800080",
        "gray" | "grey" => "808080",
        "cyan" => "00FFFF",
        "magenta" => "FF00FF",
        _ => "000000",
    }
}

pub fn hex_rgb(h: &str) -> Option<[u8; 3]> {
    let h = h.trim().trim_start_matches('#');
    if h.len() != 6 {
        return None;
    }
    let p = |i: usize| u8::from_str_radix(&h[i..i + 2], 16).ok();
    Some([p(0)?, p(2)?, p(4)?])
}

pub fn rgb_hex(c: [u8; 3]) -> String {
    format!("#{:02x}{:02x}{:02x}", c[0], c[1], c[2])
}

/// RGB to hue (degrees), saturation, lightness (0..1).
pub fn rgb_hsl(c: [u8; 3]) -> (f64, f64, f64) {
    let [r, g, b] = c.map(|v| v as f64 / 255.0);
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let l = (max + min) / 2.0;
    if (max - min).abs() < 1e-12 {
        return (0.0, 0.0, l);
    }
    let d = max - min;
    let s = if l > 0.5 {
        d / (2.0 - max - min)
    } else {
        d / (max + min)
    };
    let h = if max == r {
        (g - b) / d + if g < b { 6.0 } else { 0.0 }
    } else if max == g {
        (b - r) / d + 2.0
    } else {
        (r - g) / d + 4.0
    };
    (h * 60.0, s, l)
}

pub fn hsl_rgb(h: f64, s: f64, l: f64) -> [u8; 3] {
    let h = h.rem_euclid(360.0) / 360.0;
    if s <= 0.0 {
        let v = (l * 255.0).round() as u8;
        return [v, v, v];
    }
    let q = if l < 0.5 {
        l * (1.0 + s)
    } else {
        l + s - l * s
    };
    let p = 2.0 * l - q;
    let f = |mut t: f64| {
        if t < 0.0 {
            t += 1.0;
        }
        if t > 1.0 {
            t -= 1.0;
        }
        let v = if t < 1.0 / 6.0 {
            p + (q - p) * 6.0 * t
        } else if t < 0.5 {
            q
        } else if t < 2.0 / 3.0 {
            p + (q - p) * (2.0 / 3.0 - t) * 6.0
        } else {
            p
        };
        (v.clamp(0.0, 1.0) * 255.0).round() as u8
    };
    [f(h + 1.0 / 3.0), f(h), f(h - 1.0 / 3.0)]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_colours() {
        let ctx = Ctx {
            w: 960.0,
            h: 540.0,
            theme: [("accent2".to_string(), "ED7D31".to_string())].into(),
        };
        let c = |x: &str| color(&AnimColor { xml: x.into() }, &ctx);
        assert_eq!(c(r#"<a:srgbClr val="FF0000"/>"#), Some([255, 0, 0]));
        assert_eq!(
            c(r#"<a:schemeClr val="accent2"/>"#),
            Some([0xED, 0x7D, 0x31])
        );
        assert_eq!(c(r#"<a:schemeClr val="bg1"/>"#), Some([255, 255, 255]));
        assert_eq!(c(r#"<a:prstClr val="black"/>"#), Some([0, 0, 0]));
        assert_eq!(
            c(r#"<a:srgbClr val="808080"><a:lumMod val="50000"/></a:srgbClr>"#),
            Some([64, 64, 64])
        );
        assert_eq!(hsl_rgb(0.0, 1.0, 0.5), [255, 0, 0]);
        let (h, s, l) = rgb_hsl([0, 0, 255]);
        assert!((h - 240.0).abs() < 1e-9 && (s - 1.0).abs() < 1e-9 && (l - 0.5).abs() < 1e-9);
    }

    #[test]
    fn names_targets_and_layers() {
        let mut sp = SpTarget {
            spid: "4".into(),
            ..Default::default()
        };
        assert_eq!(target_id(&sp), "spid:4");
        sp.key = Some("ppt/slides/slide1.xml#4".into());
        assert_eq!(target_id(&sp), "key:ppt/slides/slide1.xml#4");
        sp.item = Some("u12".into());
        sp.sub = Some(SpSub::Paragraphs { st: 1, end: 2 });
        assert_eq!(layer_keys(&sp), ["u12#p1", "u12#p2"]);
        sp.sub = Some(SpSub::Bg);
        assert_eq!(layer_keys(&sp), ["u12#bg"]);
    }
}

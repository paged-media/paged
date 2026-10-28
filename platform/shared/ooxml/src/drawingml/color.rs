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

//! DrawingML colour: the six colour elements with their transform chains
//! (ECMA-376 §20.1.2.3), and their resolution to sRGB.
//!
//! A colour is read as authored ([`Color`]: a base and its transforms in
//! document order) and resolved later ([`resolve`]), because a scheme slot
//! (`accent1`, `phClr`) means something only once the reader knows the
//! theme, the colour map and the style reference that supplies `phClr`.
//! The caller says what a slot is through [`SchemeColors`].
//!
//! The arithmetic follows how PowerPoint draws: luminance, saturation and
//! hue transforms work in HSL; `tint` and `shade` work on linear-light RGB
//! ([`crate::colour`]); the alpha transforms move the alpha alone.

use crate::colour::{dml_shade, dml_tint, hsl_to_rgb, linear_to_srgb, rgb_to_hsl};
use crate::tree::{El, Ns};

/// A colour as authored: a base and its transform chain.
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct Color {
    pub base: ColorBase,
    /// In document order: (`lumMod`, 75000), (`alpha`, 50000), …
    pub transforms: Vec<(String, i32)>,
}

impl Color {
    /// An `a:srgbClr` with no transform.
    pub fn srgb(rgb: u32) -> Self {
        Color {
            base: ColorBase::Srgb(rgb),
            transforms: Vec::new(),
        }
    }

    /// The scheme slot when the colour is one with no transform (a theme
    /// colour as it stands), else `None`.
    pub fn plain_scheme(&self) -> Option<&str> {
        match &self.base {
            ColorBase::Scheme(s) if self.transforms.is_empty() => Some(s),
            _ => None,
        }
    }
}

/// The base of a colour.
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum ColorBase {
    /// `a:srgbClr val` as 0xRRGGBB.
    Srgb(u32),
    /// `a:schemeClr val` (bg1, tx1, accent1, phClr, …).
    Scheme(String),
    /// `a:sysClr val` + `lastClr`.
    System { name: String, last: Option<u32> },
    /// `a:prstClr val`.
    Preset(String),
    /// `a:hslClr`: hue in 60 000ths of a degree, sat/lum in 1 000ths of a percent.
    Hsl(i32, i32, i32),
    /// `a:scrgbClr`: linear r/g/b in 1 000ths of a percent.
    ScRgb(i32, i32, i32),
}

/// The colour elements, by local name.
pub const COLOR_TAGS: [&str; 6] = [
    "srgbClr",
    "schemeClr",
    "sysClr",
    "prstClr",
    "hslClr",
    "scrgbClr",
];

/// The first colour element among `el`'s children, if any.
pub fn color_in(el: &El) -> Option<Color> {
    el.children
        .iter()
        .find(|c| c.ns == Ns::A && COLOR_TAGS.contains(&c.local.as_str()))
        .and_then(color)
}

/// One colour element (`a:srgbClr`, `a:schemeClr`, …) with its transforms.
pub fn color(el: &El) -> Option<Color> {
    let hex = |v: &str| u32::from_str_radix(v.trim(), 16).ok();
    let base = match el.local.as_str() {
        "srgbClr" => ColorBase::Srgb(hex(el.attr("val")?)?),
        "schemeClr" => ColorBase::Scheme(el.attr("val")?.to_string()),
        "sysClr" => ColorBase::System {
            name: el.attr("val")?.to_string(),
            last: el.attr("lastClr").and_then(hex),
        },
        "prstClr" => ColorBase::Preset(el.attr("val")?.to_string()),
        "hslClr" => ColorBase::Hsl(
            el.attr_i32("hue").unwrap_or(0),
            el.attr_i32("sat").unwrap_or(0),
            el.attr_i32("lum").unwrap_or(0),
        ),
        "scrgbClr" => ColorBase::ScRgb(
            el.attr_i32("r").unwrap_or(0),
            el.attr_i32("g").unwrap_or(0),
            el.attr_i32("b").unwrap_or(0),
        ),
        _ => return None,
    };
    let transforms = el
        .children
        .iter()
        .filter(|c| c.ns == Ns::A)
        .map(|c| (c.local.clone(), c.attr_i32("val").unwrap_or(0)))
        .collect();
    Some(Color { base, transforms })
}

/// A resolved colour: sRGB 0–1 and alpha 0–1.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rgba {
    pub r: f64,
    pub g: f64,
    pub b: f64,
    pub a: f64,
}

impl Rgba {
    pub const BLACK: Rgba = Rgba {
        r: 0.0,
        g: 0.0,
        b: 0.0,
        a: 1.0,
    };
    pub const WHITE: Rgba = Rgba {
        r: 1.0,
        g: 1.0,
        b: 1.0,
        a: 1.0,
    };

    /// 0xRRGGBB, opaque.
    pub fn from_hex(v: u32) -> Self {
        Rgba {
            r: ((v >> 16) & 0xff) as f64 / 255.0,
            g: ((v >> 8) & 0xff) as f64 / 255.0,
            b: (v & 0xff) as f64 / 255.0,
            a: 1.0,
        }
    }

    /// sRGB bytes, opaque.
    pub fn from_bytes(rgb: [u8; 3]) -> Self {
        Rgba {
            r: rgb[0] as f64 / 255.0,
            g: rgb[1] as f64 / 255.0,
            b: rgb[2] as f64 / 255.0,
            a: 1.0,
        }
    }

    /// 0–255 channels, rounded.
    pub fn bytes(&self) -> [u8; 3] {
        let q = |x: f64| (x.clamp(0.0, 1.0) * 255.0).round() as u8;
        [q(self.r), q(self.g), q(self.b)]
    }

    /// 0xRRGGBB, rounded.
    pub fn hex(&self) -> u32 {
        let [r, g, b] = self.bytes();
        (r as u32) << 16 | (g as u32) << 8 | b as u32
    }
}

/// What the scheme slots of a colour are: the theme seen through the
/// colour map, and `phClr` (the colour a style reference supplies).
pub trait SchemeColors {
    /// The colour of slot `name` (`accent1`, `tx1`, `phClr`, …), with no
    /// transform applied; `None` when the slot is unknown.
    fn scheme(&self, name: &str) -> Option<Rgba>;
}

/// No theme: every slot is unknown (and resolves black).
impl SchemeColors for () {
    fn scheme(&self, _: &str) -> Option<Rgba> {
        None
    }
}

/// A slot table: `(name, colour)` pairs, looked up by name.
impl SchemeColors for Vec<(String, Rgba)> {
    fn scheme(&self, name: &str) -> Option<Rgba> {
        self.iter().find(|(k, _)| k == name).map(|(_, c)| *c)
    }
}

/// The CSS colour keywords, which `ST_PresetColorVal` names (with `dk`,
/// `lt` and `med` for `dark`, `light` and `medium`), lower case.
const PRESETS: [(&str, u32); 139] = [
    ("aliceblue", 0xf0f8ff),
    ("antiquewhite", 0xfaebd7),
    ("aqua", 0x00ffff),
    ("aquamarine", 0x7fffd4),
    ("azure", 0xf0ffff),
    ("beige", 0xf5f5dc),
    ("bisque", 0xffe4c4),
    ("black", 0x000000),
    ("blanchedalmond", 0xffebcd),
    ("blue", 0x0000ff),
    ("blueviolet", 0x8a2be2),
    ("brown", 0xa52a2a),
    ("burlywood", 0xdeb887),
    ("cadetblue", 0x5f9ea0),
    ("chartreuse", 0x7fff00),
    ("chocolate", 0xd2691e),
    ("coral", 0xff7f50),
    ("cornflowerblue", 0x6495ed),
    ("cornsilk", 0xfff8dc),
    ("crimson", 0xdc143c),
    ("cyan", 0x00ffff),
    ("darkblue", 0x00008b),
    ("darkcyan", 0x008b8b),
    ("darkgoldenrod", 0xb8860b),
    ("darkgray", 0xa9a9a9),
    ("darkgreen", 0x006400),
    ("darkgrey", 0xa9a9a9),
    ("darkkhaki", 0xbdb76b),
    ("darkmagenta", 0x8b008b),
    ("darkolivegreen", 0x556b2f),
    ("darkorange", 0xff8c00),
    ("darkorchid", 0x9932cc),
    ("darkred", 0x8b0000),
    ("darksalmon", 0xe9967a),
    ("darkseagreen", 0x8fbc8f),
    ("darkslateblue", 0x483d8b),
    ("darkslategray", 0x2f4f4f),
    ("darkslategrey", 0x2f4f4f),
    ("darkturquoise", 0x00ced1),
    ("darkviolet", 0x9400d3),
    ("deeppink", 0xff1493),
    ("deepskyblue", 0x00bfff),
    ("dimgray", 0x696969),
    ("dimgrey", 0x696969),
    ("dodgerblue", 0x1e90ff),
    ("firebrick", 0xb22222),
    ("floralwhite", 0xfffaf0),
    ("forestgreen", 0x228b22),
    ("fuchsia", 0xff00ff),
    ("gainsboro", 0xdcdcdc),
    ("ghostwhite", 0xf8f8ff),
    ("gold", 0xffd700),
    ("goldenrod", 0xdaa520),
    ("gray", 0x808080),
    ("green", 0x008000),
    ("greenyellow", 0xadff2f),
    ("grey", 0x808080),
    ("honeydew", 0xf0fff0),
    ("hotpink", 0xff69b4),
    ("indianred", 0xcd5c5c),
    ("indigo", 0x4b0082),
    ("ivory", 0xfffff0),
    ("khaki", 0xf0e68c),
    ("lavender", 0xe6e6fa),
    ("lavenderblush", 0xfff0f5),
    ("lawngreen", 0x7cfc00),
    ("lemonchiffon", 0xfffacd),
    ("lightblue", 0xadd8e6),
    ("lightcoral", 0xf08080),
    ("lightcyan", 0xe0ffff),
    ("lightgoldenrodyellow", 0xfafad2),
    ("lightgray", 0xd3d3d3),
    ("lightgreen", 0x90ee90),
    ("lightgrey", 0xd3d3d3),
    ("lightpink", 0xffb6c1),
    ("lightsalmon", 0xffa07a),
    ("lightseagreen", 0x20b2aa),
    ("lightskyblue", 0x87cefa),
    ("lightslategray", 0x778899),
    ("lightslategrey", 0x778899),
    ("lightsteelblue", 0xb0c4de),
    ("lightyellow", 0xffffe0),
    ("lime", 0x00ff00),
    ("limegreen", 0x32cd32),
    ("linen", 0xfaf0e6),
    ("magenta", 0xff00ff),
    ("maroon", 0x800000),
    ("mediumaquamarine", 0x66cdaa),
    ("mediumblue", 0x0000cd),
    ("mediumorchid", 0xba55d3),
    ("mediumpurple", 0x9370db),
    ("mediumseagreen", 0x3cb371),
    ("mediumslateblue", 0x7b68ee),
    ("mediumspringgreen", 0x00fa9a),
    ("mediumturquoise", 0x48d1cc),
    ("mediumvioletred", 0xc71585),
    ("midnightblue", 0x191970),
    ("mintcream", 0xf5fffa),
    ("mistyrose", 0xffe4e1),
    ("moccasin", 0xffe4b5),
    ("navajowhite", 0xffdead),
    ("navy", 0x000080),
    ("oldlace", 0xfdf5e6),
    ("olive", 0x808000),
    ("olivedrab", 0x6b8e23),
    ("orange", 0xffa500),
    ("orangered", 0xff4500),
    ("orchid", 0xda70d6),
    ("palegoldenrod", 0xeee8aa),
    ("palegreen", 0x98fb98),
    ("paleturquoise", 0xafeeee),
    ("palevioletred", 0xdb7093),
    ("papayawhip", 0xffefd5),
    ("peachpuff", 0xffdab9),
    ("peru", 0xcd853f),
    ("pink", 0xffc0cb),
    ("plum", 0xdda0dd),
    ("powderblue", 0xb0e0e6),
    ("purple", 0x800080),
    ("red", 0xff0000),
    ("rosybrown", 0xbc8f8f),
    ("royalblue", 0x4169e1),
    ("saddlebrown", 0x8b4513),
    ("salmon", 0xfa8072),
    ("sandybrown", 0xf4a460),
    ("seagreen", 0x2e8b57),
    ("seashell", 0xfff5ee),
    ("sienna", 0xa0522d),
    ("silver", 0xc0c0c0),
    ("skyblue", 0x87ceeb),
    ("slateblue", 0x6a5acd),
    ("slategray", 0x708090),
    ("slategrey", 0x708090),
    ("snow", 0xfffafa),
    ("springgreen", 0x00ff7f),
    ("steelblue", 0x4682b4),
    ("tan", 0xd2b48c),
    ("teal", 0x008080),
    ("thistle", 0xd8bfd8),
];

/// The tail of the keyword table (split so neither array is unwieldy).
const PRESETS_TAIL: [(&str, u32); 8] = [
    ("tomato", 0xff6347),
    ("turquoise", 0x40e0d0),
    ("violet", 0xee82ee),
    ("wheat", 0xf5deb3),
    ("white", 0xffffff),
    ("whitesmoke", 0xf5f5f5),
    ("yellow", 0xffff00),
    ("yellowgreen", 0x9acd32),
];

/// An `a:prstClr val` (`dkGoldenrod`, `ltGray`, `medAquamarine`, `red`, …)
/// as 0xRRGGBB.
pub fn preset(name: &str) -> Option<u32> {
    let lower = name.to_ascii_lowercase();
    let full = if let Some(rest) = lower.strip_prefix("med") {
        if rest.starts_with("ium") {
            lower.clone()
        } else {
            format!("medium{rest}")
        }
    } else if let Some(rest) = lower.strip_prefix("dk") {
        format!("dark{rest}")
    } else if let Some(rest) = lower.strip_prefix("lt") {
        format!("light{rest}")
    } else {
        lower
    };
    PRESETS
        .iter()
        .chain(PRESETS_TAIL.iter())
        .find(|(k, _)| *k == full)
        .map(|&(_, v)| v)
}

/// An `a:sysClr`: its `lastClr` when written, else the classic Windows
/// default of the commonest slots (`window` white, everything else black).
pub fn system(name: &str, last: Option<u32>) -> Rgba {
    last.map(Rgba::from_hex).unwrap_or(match name {
        "window" | "highlightText" | "btnHighlight" | "3dLight" | "menu" | "infoBk" => Rgba::WHITE,
        _ => Rgba::BLACK,
    })
}

/// Resolve a colour: its base (a scheme slot through `schemes`), then its
/// transforms in document order. An unknown slot or preset is black.
pub fn resolve(c: &Color, schemes: &dyn SchemeColors) -> Rgba {
    let mut rgba = match &c.base {
        ColorBase::Srgb(v) => Rgba::from_hex(*v),
        ColorBase::Scheme(name) => schemes.scheme(name).unwrap_or(Rgba::BLACK),
        ColorBase::System { last, name } => system(name, *last),
        ColorBase::Preset(name) => preset(name).map(Rgba::from_hex).unwrap_or(Rgba::BLACK),
        ColorBase::Hsl(h, s, l) => {
            let (r, g, b) = hsl_to_rgb(
                (*h as f64 / 21_600_000.0).rem_euclid(1.0),
                *s as f64 / 100_000.0,
                *l as f64 / 100_000.0,
            );
            Rgba { r, g, b, a: 1.0 }
        }
        ColorBase::ScRgb(r, g, b) => Rgba {
            r: linear_to_srgb(*r as f64 / 100_000.0),
            g: linear_to_srgb(*g as f64 / 100_000.0),
            b: linear_to_srgb(*b as f64 / 100_000.0),
            a: 1.0,
        },
    };
    for (name, val) in &c.transforms {
        rgba = transform(rgba, name, *val);
    }
    rgba.r = rgba.r.clamp(0.0, 1.0);
    rgba.g = rgba.g.clamp(0.0, 1.0);
    rgba.b = rgba.b.clamp(0.0, 1.0);
    rgba.a = rgba.a.clamp(0.0, 1.0);
    rgba
}

/// One colour transform (`lumMod`, `tint`, `alpha`, …; `val` in its file
/// units). An unknown one changes nothing.
pub fn transform(rgba: Rgba, name: &str, val: i32) -> Rgba {
    let v = val as f64 / 100_000.0;
    let each = |f: &dyn Fn(f64) -> f64| Rgba {
        r: f(rgba.r),
        g: f(rgba.g),
        b: f(rgba.b),
        a: rgba.a,
    };
    match name {
        "lumMod" | "lumOff" | "satMod" | "satOff" | "hueMod" | "hueOff" | "hue" | "sat" | "lum" => {
            let (mut h, mut s, mut l) = rgb_to_hsl(rgba.r, rgba.g, rgba.b);
            match name {
                "lumMod" => l *= v,
                "lumOff" => l += v,
                "lum" => l = v,
                "satMod" => s *= v,
                "satOff" => s += v,
                "sat" => s = v,
                "hueMod" => h *= v,
                "hueOff" => h += val as f64 / 21_600_000.0,
                "hue" => h = val as f64 / 21_600_000.0,
                _ => {}
            }
            let (r, g, b) = hsl_to_rgb(h.rem_euclid(1.0), s.clamp(0.0, 1.0), l.clamp(0.0, 1.0));
            Rgba { r, g, b, a: rgba.a }
        }
        "tint" => each(&|c| dml_tint(c, v)),
        "shade" => each(&|c| dml_shade(c, v)),
        "alpha" => Rgba { a: v, ..rgba },
        "alphaMod" => Rgba {
            a: rgba.a * v,
            ..rgba
        },
        "alphaOff" => Rgba {
            a: rgba.a + v,
            ..rgba
        },
        "comp" => {
            let (h, s, l) = rgb_to_hsl(rgba.r, rgba.g, rgba.b);
            let (r, g, b) = hsl_to_rgb((h + 0.5).rem_euclid(1.0), s, l);
            Rgba { r, g, b, a: rgba.a }
        }
        "inv" => each(&|c| 1.0 - c),
        "gray" => {
            let y = 0.2126 * rgba.r + 0.7152 * rgba.g + 0.0722 * rgba.b;
            each(&|_| y)
        }
        "gamma" => each(&linear_to_srgb),
        "invGamma" => each(&crate::colour::srgb_to_linear),
        "redMod" => Rgba {
            r: rgba.r * v,
            ..rgba
        },
        "greenMod" => Rgba {
            g: rgba.g * v,
            ..rgba
        },
        "blueMod" => Rgba {
            b: rgba.b * v,
            ..rgba
        },
        "redOff" => Rgba {
            r: rgba.r + v,
            ..rgba
        },
        "greenOff" => Rgba {
            g: rgba.g + v,
            ..rgba
        },
        "blueOff" => Rgba {
            b: rgba.b + v,
            ..rgba
        },
        "red" => Rgba { r: v, ..rgba },
        "green" => Rgba { g: v, ..rgba },
        "blue" => Rgba { b: v, ..rgba },
        _ => rgba,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tree::parse;

    const NS: &str = r#"xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main""#;

    fn read(xml: &str) -> Color {
        let root = parse(format!(r#"<a:solidFill {NS}>{xml}</a:solidFill>"#).as_bytes()).unwrap();
        color_in(&root).unwrap()
    }

    fn slots() -> Vec<(String, Rgba)> {
        vec![
            ("bg1".into(), Rgba::WHITE),
            ("accent1".into(), Rgba::from_hex(0x4472c4)),
        ]
    }

    #[test]
    fn every_colour_element_reads_with_its_transforms() {
        let c = read(
            r#"<a:schemeClr val="accent1"><a:lumMod val="60000"/><a:lumOff val="40000"/></a:schemeClr>"#,
        );
        assert_eq!(c.base, ColorBase::Scheme("accent1".into()));
        assert_eq!(
            c.transforms,
            vec![("lumMod".into(), 60_000), ("lumOff".into(), 40_000)]
        );
        assert_eq!(
            read(r#"<a:srgbClr val="FF8000"/>"#).base,
            ColorBase::Srgb(0xff8000)
        );
        assert_eq!(
            read(r#"<a:sysClr val="windowText" lastClr="000000"/>"#).base,
            ColorBase::System {
                name: "windowText".into(),
                last: Some(0)
            }
        );
        assert_eq!(
            read(r#"<a:prstClr val="dkGoldenrod"/>"#).base,
            ColorBase::Preset("dkGoldenrod".into())
        );
        assert_eq!(
            read(r#"<a:hslClr hue="14400000" sat="100000" lum="50000"/>"#).base,
            ColorBase::Hsl(14_400_000, 100_000, 50_000)
        );
        assert_eq!(
            read(r#"<a:scrgbClr r="100000" g="0" b="50000"/>"#).base,
            ColorBase::ScRgb(100_000, 0, 50_000)
        );
        assert_eq!(
            read(r#"<a:schemeClr val="tx1"/>"#).plain_scheme(),
            Some("tx1")
        );
    }

    #[test]
    fn transforms_resolve_as_powerpoint_draws() {
        let s = slots();
        // "Background 1, darker 15 %" = D9D9D9; accent1 lighter 40 % = 8FAADC.
        let d = resolve(
            &read(r#"<a:schemeClr val="bg1"><a:lumMod val="85000"/></a:schemeClr>"#),
            &s,
        );
        assert_eq!(d.bytes(), [0xd9, 0xd9, 0xd9]);
        let l = resolve(
            &read(
                r#"<a:schemeClr val="accent1"><a:lumMod val="60000"/><a:lumOff val="40000"/></a:schemeClr>"#,
            ),
            &s,
        );
        assert_eq!(l.bytes(), [0x8f, 0xaa, 0xdc]);
        // tint / shade in linear light; alpha alone.
        let t = resolve(
            &read(
                r#"<a:srgbClr val="808080"><a:shade val="50000"/><a:alpha val="25000"/></a:srgbClr>"#,
            ),
            &(),
        );
        assert_eq!(t.bytes(), [92, 92, 92]);
        assert!((t.a - 0.25).abs() < 1e-9);
        let w = resolve(
            &read(r#"<a:srgbClr val="000000"><a:tint val="0"/></a:srgbClr>"#),
            &(),
        );
        assert_eq!(w.bytes(), [255, 255, 255]);
        let inv = resolve(
            &read(r#"<a:srgbClr val="FF0000"><a:inv/></a:srgbClr>"#),
            &(),
        );
        assert_eq!(inv.bytes(), [0, 255, 255]);
        let comp = resolve(
            &read(r#"<a:srgbClr val="FF0000"><a:comp/></a:srgbClr>"#),
            &(),
        );
        assert_eq!(comp.bytes(), [0, 255, 255]);
        let hsl = resolve(
            &read(r#"<a:hslClr hue="7200000" sat="100000" lum="50000"/>"#),
            &(),
        );
        assert_eq!(hsl.bytes(), [0, 255, 0]);
        let sc = resolve(&read(r#"<a:scrgbClr r="100000" g="0" b="0"/>"#), &());
        assert_eq!(sc.bytes(), [255, 0, 0]);
        // An unknown slot is black.
        assert_eq!(
            resolve(&read(r#"<a:schemeClr val="accent6"/>"#), &s).bytes(),
            [0, 0, 0]
        );
    }

    #[test]
    fn presets_name_the_css_keywords_with_the_short_prefixes() {
        assert_eq!(preset("dkGoldenrod"), Some(0xb8860b));
        assert_eq!(preset("ltGray"), Some(0xd3d3d3));
        assert_eq!(preset("medAquamarine"), Some(0x66cdaa));
        assert_eq!(preset("mediumBlue"), Some(0x0000cd));
        assert_eq!(preset("darkGray"), Some(0xa9a9a9));
        assert_eq!(preset("yellowGreen"), Some(0x9acd32));
        assert_eq!(preset("noSuchColour"), None);
        assert_eq!(system("window", None), Rgba::WHITE);
        assert_eq!(system("windowText", None), Rgba::BLACK);
        assert_eq!(system("windowText", Some(0x123456)).hex(), 0x123456);
    }
}

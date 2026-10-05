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

//! Colour resolution: scheme slots through the colour map and theme, then
//! the transform chain (`lumMod`, `tint`, `alpha`, …) in document order.
//!
//! The arithmetic follows how PowerPoint draws: luminance and saturation
//! transforms work in HSL; `tint` and `shade` work on linear-light RGB
//! (scRGB), which is why a 50 % shade of a mid grey is darker than halving
//! its sRGB value. The PowerPoint oracle is the judge of each rule.

use pptx_core::{Color, ColorBase, ColorMap, Theme};

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
    pub fn from_hex(v: u32) -> Self {
        Rgba {
            r: ((v >> 16) & 0xff) as f64 / 255.0,
            g: ((v >> 8) & 0xff) as f64 / 255.0,
            b: (v & 0xff) as f64 / 255.0,
            a: 1.0,
        }
    }
    /// 0–255 channels, rounded.
    pub fn bytes(&self) -> [u8; 3] {
        let q = |x: f64| (x.clamp(0.0, 1.0) * 255.0).round() as u8;
        [q(self.r), q(self.g), q(self.b)]
    }
}

/// What a colour resolves against.
pub struct ColorCtx<'a> {
    pub theme: Option<&'a Theme>,
    pub map: &'a ColorMap,
    /// `phClr` — the colour a style reference supplies.
    pub placeholder: Option<Rgba>,
}

fn to_linear(c: f64) -> f64 {
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}
fn to_srgb(c: f64) -> f64 {
    if c <= 0.003_130_8 {
        c * 12.92
    } else {
        1.055 * c.powf(1.0 / 2.4) - 0.055
    }
}

fn rgb_to_hsl(r: f64, g: f64, b: f64) -> (f64, f64, f64) {
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
    (h / 6.0, s, l)
}

fn hsl_to_rgb(h: f64, s: f64, l: f64) -> (f64, f64, f64) {
    if s <= 0.0 {
        return (l, l, l);
    }
    let q = if l < 0.5 {
        l * (1.0 + s)
    } else {
        l + s - l * s
    };
    let p = 2.0 * l - q;
    let hue = |mut t: f64| {
        if t < 0.0 {
            t += 1.0;
        }
        if t > 1.0 {
            t -= 1.0;
        }
        if t < 1.0 / 6.0 {
            p + (q - p) * 6.0 * t
        } else if t < 0.5 {
            q
        } else if t < 2.0 / 3.0 {
            p + (q - p) * (2.0 / 3.0 - t) * 6.0
        } else {
            p
        }
    };
    (hue(h + 1.0 / 3.0), hue(h), hue(h - 1.0 / 3.0))
}

/// The preset colours DrawingML names (`a:prstClr`), the common subset.
fn preset(name: &str) -> Option<u32> {
    Some(match name {
        "black" => 0x000000,
        "white" => 0xffffff,
        "red" => 0xff0000,
        "green" => 0x008000,
        "blue" => 0x0000ff,
        "yellow" => 0xffff00,
        "gray" | "grey" => 0x808080,
        "darkGray" | "dkGray" => 0xa9a9a9,
        "lightGray" | "ltGray" => 0xd3d3d3,
        "orange" => 0xffa500,
        "purple" => 0x800080,
        "cyan" | "aqua" => 0x00ffff,
        "magenta" | "fuchsia" => 0xff00ff,
        "navy" => 0x000080,
        "silver" => 0xc0c0c0,
        "maroon" => 0x800000,
        "olive" => 0x808000,
        "teal" => 0x008080,
        "lime" => 0x00ff00,
        _ => return None,
    })
}

/// Follow a scheme slot through the colour map to the theme's colour.
fn scheme(name: &str, ctx: &ColorCtx) -> Option<Rgba> {
    if name == "phClr" {
        return ctx.placeholder;
    }
    let mapped = ctx
        .map
        .entries
        .iter()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.as_str())
        .unwrap_or(match name {
            // A map without these entries: PowerPoint's defaults.
            "bg1" => "lt1",
            "tx1" => "dk1",
            "bg2" => "lt2",
            "tx2" => "dk2",
            other => other,
        });
    let theme = ctx.theme?;
    let (_, c) = theme.colors.iter().find(|(k, _)| k == mapped)?;
    // A theme slot is itself a colour (srgb or sys) with no further mapping.
    Some(resolve(
        c,
        &ColorCtx {
            theme: None,
            map: ctx.map,
            placeholder: None,
        },
    ))
}

/// Resolve a colour. An unresolvable scheme reference is black (and the
/// caller may report it).
pub fn resolve(c: &Color, ctx: &ColorCtx) -> Rgba {
    let mut rgba = match &c.base {
        ColorBase::Srgb(v) => Rgba::from_hex(*v),
        ColorBase::Scheme(name) => scheme(name, ctx).unwrap_or(Rgba::BLACK),
        ColorBase::System { last, name } => {
            last.map(Rgba::from_hex).unwrap_or(if name == "window" {
                Rgba::from_hex(0xffffff)
            } else {
                Rgba::BLACK
            })
        }
        ColorBase::Preset(name) => preset(name).map(Rgba::from_hex).unwrap_or(Rgba::BLACK),
        ColorBase::Hsl(h, s, l) => {
            let (r, g, b) = hsl_to_rgb(
                *h as f64 / 21_600_000.0,
                *s as f64 / 100_000.0,
                *l as f64 / 100_000.0,
            );
            Rgba { r, g, b, a: 1.0 }
        }
        ColorBase::ScRgb(r, g, b) => Rgba {
            r: to_srgb(*r as f64 / 100_000.0),
            g: to_srgb(*g as f64 / 100_000.0),
            b: to_srgb(*b as f64 / 100_000.0),
            a: 1.0,
        },
    };
    for (name, val) in &c.transforms {
        let v = *val as f64 / 100_000.0;
        match name.as_str() {
            "lumMod" | "lumOff" | "satMod" | "satOff" | "hueMod" | "hueOff" | "hue" | "sat"
            | "lum" => {
                let (mut h, mut s, mut l) = rgb_to_hsl(rgba.r, rgba.g, rgba.b);
                match name.as_str() {
                    "lumMod" => l *= v,
                    "lumOff" => l += v,
                    "lum" => l = v,
                    "satMod" => s *= v,
                    "satOff" => s += v,
                    "sat" => s = v,
                    "hueMod" => h *= v,
                    "hueOff" => h += *val as f64 / 21_600_000.0,
                    "hue" => h = *val as f64 / 21_600_000.0,
                    _ => {}
                }
                let (r, g, b) = hsl_to_rgb(h.rem_euclid(1.0), s.clamp(0.0, 1.0), l.clamp(0.0, 1.0));
                rgba = Rgba { r, g, b, a: rgba.a };
            }
            "tint" => {
                let f = |c: f64| to_srgb(to_linear(c) * v + (1.0 - v));
                rgba = Rgba {
                    r: f(rgba.r),
                    g: f(rgba.g),
                    b: f(rgba.b),
                    a: rgba.a,
                };
            }
            "shade" => {
                let f = |c: f64| to_srgb(to_linear(c) * v);
                rgba = Rgba {
                    r: f(rgba.r),
                    g: f(rgba.g),
                    b: f(rgba.b),
                    a: rgba.a,
                };
            }
            "alpha" => rgba.a = v,
            "alphaMod" => rgba.a *= v,
            "alphaOff" => rgba.a += v,
            "comp" => {
                let (h, s, l) = rgb_to_hsl(rgba.r, rgba.g, rgba.b);
                let (r, g, b) = hsl_to_rgb((h + 0.5).rem_euclid(1.0), s, l);
                rgba = Rgba { r, g, b, a: rgba.a };
            }
            "inv" => {
                rgba = Rgba {
                    r: 1.0 - rgba.r,
                    g: 1.0 - rgba.g,
                    b: 1.0 - rgba.b,
                    a: rgba.a,
                }
            }
            "gray" => {
                let y = 0.2126 * rgba.r + 0.7152 * rgba.g + 0.0722 * rgba.b;
                rgba = Rgba {
                    r: y,
                    g: y,
                    b: y,
                    a: rgba.a,
                };
            }
            "redMod" => rgba.r *= v,
            "greenMod" => rgba.g *= v,
            "blueMod" => rgba.b *= v,
            "redOff" => rgba.r += v,
            "greenOff" => rgba.g += v,
            "blueOff" => rgba.b += v,
            "red" => rgba.r = v,
            "green" => rgba.g = v,
            "blue" => rgba.b = v,
            _ => {}
        }
    }
    rgba.r = rgba.r.clamp(0.0, 1.0);
    rgba.g = rgba.g.clamp(0.0, 1.0);
    rgba.b = rgba.b.clamp(0.0, 1.0);
    rgba.a = rgba.a.clamp(0.0, 1.0);
    rgba
}

#[cfg(test)]
mod tests {
    use super::*;

    fn theme() -> Theme {
        Theme {
            colors: vec![
                (
                    "dk1".into(),
                    Color {
                        base: ColorBase::System {
                            name: "windowText".into(),
                            last: Some(0x000000),
                        },
                        transforms: vec![],
                    },
                ),
                (
                    "lt1".into(),
                    Color {
                        base: ColorBase::System {
                            name: "window".into(),
                            last: Some(0xffffff),
                        },
                        transforms: vec![],
                    },
                ),
                (
                    "accent1".into(),
                    Color {
                        base: ColorBase::Srgb(0x4472c4),
                        transforms: vec![],
                    },
                ),
            ],
            ..Default::default()
        }
    }

    fn c(base: ColorBase, t: &[(&str, i32)]) -> Color {
        Color {
            base,
            transforms: t.iter().map(|(k, v)| (k.to_string(), *v)).collect(),
        }
    }

    #[test]
    fn scheme_slots_follow_the_map() {
        let th = theme();
        let map = ColorMap {
            entries: vec![("tx1".into(), "dk1".into()), ("bg1".into(), "lt1".into())],
        };
        let ctx = ColorCtx {
            theme: Some(&th),
            map: &map,
            placeholder: None,
        };
        assert_eq!(
            resolve(&c(ColorBase::Scheme("tx1".into()), &[]), &ctx).bytes(),
            [0, 0, 0]
        );
        assert_eq!(
            resolve(&c(ColorBase::Scheme("bg1".into()), &[]), &ctx).bytes(),
            [255, 255, 255]
        );
        assert_eq!(
            resolve(&c(ColorBase::Scheme("accent1".into()), &[]), &ctx).bytes(),
            [0x44, 0x72, 0xc4]
        );
    }

    #[test]
    fn lum_mod_and_off_work_in_hsl() {
        let th = theme();
        let map = ColorMap::default();
        let ctx = ColorCtx {
            theme: Some(&th),
            map: &map,
            placeholder: None,
        };
        // White at 85 % luminance: PowerPoint's "Background 1, darker 15 %" = D9D9D9.
        let d = resolve(
            &c(ColorBase::Scheme("bg1".into()), &[("lumMod", 85_000)]),
            &ctx,
        );
        assert_eq!(d.bytes(), [0xd9, 0xd9, 0xd9]);
        // accent1 lighter 40 %: lumMod 60 % + lumOff 40 % = 8FAADC.
        let l = resolve(
            &c(
                ColorBase::Scheme("accent1".into()),
                &[("lumMod", 60_000), ("lumOff", 40_000)],
            ),
            &ctx,
        );
        assert_eq!(l.bytes(), [0x8f, 0xaa, 0xdc]);
    }

    #[test]
    fn alpha_is_kept_and_ph_clr_uses_the_style_colour() {
        let map = ColorMap::default();
        let ctx = ColorCtx {
            theme: None,
            map: &map,
            placeholder: Some(Rgba::from_hex(0xff0000)),
        };
        let x = resolve(
            &c(ColorBase::Scheme("phClr".into()), &[("alpha", 50_000)]),
            &ctx,
        );
        assert_eq!(x.bytes(), [255, 0, 0]);
        assert!((x.a - 0.5).abs() < 1e-9);
    }
}

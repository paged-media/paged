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

//! Colour arithmetic, shared by the engine, paged.sheet, paged.slide and paged.doc
//! (engine ADR 1056 slice 3, PM-0017: one owner). `paged_ooxml::colour` and
//! `paged_ooxml::drawingml::{Rgba, transform}` re-export it.
//!
//! Two different operations are both called "tint", and they stay apart:
//!
//! - SpreadsheetML's `tint` attribute (a cell or font colour, −1.0..=1.0)
//!   moves the colour's **HSL luminance** toward black or white
//!   ([`excel_tint`]); Excel's "Lighter 80 %" swatches are these.
//! - DrawingML's `a:tint` / `a:shade` transforms (a theme colour in a
//!   presentation or a chart) work on **linear-light RGB** (scRGB), so a
//!   50 % shade of a mid grey is not half its sRGB value
//!   ([`dml_tint`], [`dml_shade`]).
//!
//! The luminance, saturation and hue transforms (`lumMod`, `satOff`, …) work
//! in HSL ([`rgb_to_hsl`], [`hsl_to_rgb`]). Channels are 0–1 floats; hue is a
//! fraction of a turn.

/// An sRGB channel (0–1) as linear light.
pub fn srgb_to_linear(c: f64) -> f64 {
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

/// A linear-light channel as sRGB (0–1).
pub fn linear_to_srgb(c: f64) -> f64 {
    if c <= 0.003_130_8 {
        c * 12.92
    } else {
        1.055 * c.powf(1.0 / 2.4) - 0.055
    }
}

/// sRGB (0–1 each) to HSL: hue as a fraction of a turn, saturation and
/// luminance 0–1. A grey (no channel apart from the others by 1e-12) has
/// hue and saturation 0.
pub fn rgb_to_hsl(r: f64, g: f64, b: f64) -> (f64, f64, f64) {
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

/// HSL (hue as a fraction of a turn, saturation and luminance 0–1) to sRGB.
/// A saturation of 0 or less is a grey of the luminance.
pub fn hsl_to_rgb(h: f64, s: f64, l: f64) -> (f64, f64, f64) {
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

/// SpreadsheetML's `tint` (−1.0..=1.0, clamped) applied to an sRGB colour:
/// the HSL luminance moves toward black (`tint < 0`: `L·(1+tint)`) or white
/// (`tint > 0`: `L·(1−tint) + tint`), hue and saturation kept.
pub fn excel_tint(r: f64, g: f64, b: f64, tint: f64) -> (f64, f64, f64) {
    let (hue, sat, lum) = rgb_to_hsl(r, g, b);
    let t = tint.clamp(-1.0, 1.0);
    let lum = if t < 0.0 {
        lum * (1.0 + t)
    } else {
        lum * (1.0 - t) + t
    };
    hsl_to_rgb(hue, sat, lum.clamp(0.0, 1.0))
}

/// DrawingML's `a:tint` (`v` 0–1, the share of the colour kept) on one sRGB
/// channel: toward white in linear light.
pub fn dml_tint(c: f64, v: f64) -> f64 {
    linear_to_srgb(srgb_to_linear(c) * v + (1.0 - v))
}

/// DrawingML's `a:shade` (`v` 0–1, the share of the colour kept) on one sRGB
/// channel: toward black in linear light.
pub fn dml_shade(c: f64, v: f64) -> f64 {
    linear_to_srgb(srgb_to_linear(c) * v)
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
        "invGamma" => each(&srgb_to_linear),
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

    fn hex(r: f64, g: f64, b: f64) -> String {
        let q = |v: f64| (v * 255.0).round().clamp(0.0, 255.0) as u8;
        format!("#{:02X}{:02X}{:02X}", q(r), q(g), q(b))
    }

    fn rgb(v: u32) -> (f64, f64, f64) {
        let c = |s: u32| ((v >> s) & 0xff) as f64 / 255.0;
        (c(16), c(8), c(0))
    }

    #[test]
    fn hsl_round_trips_every_byte_colour_on_a_grid() {
        for v in (0..=0xff_ffffu32).step_by(0x01_0305) {
            let (r, g, b) = rgb(v);
            let (h, s, l) = rgb_to_hsl(r, g, b);
            let (r2, g2, b2) = hsl_to_rgb(h, s, l);
            assert_eq!(hex(r, g, b), hex(r2, g2, b2), "{v:06X}");
        }
    }

    #[test]
    fn excel_tint_matches_excels_theme_swatches() {
        let (r, g, b) = rgb(0x4F81BD);
        // "Blue, Accent 1, Lighter 80%" / "Darker 50%".
        let (r1, g1, b1) = excel_tint(r, g, b, 0.7999816888943144);
        assert_eq!(hex(r1, g1, b1), "#DCE6F2");
        let (r2, g2, b2) = excel_tint(r, g, b, -0.499984740745262);
        assert_eq!(hex(r2, g2, b2), "#254061");
        let (r3, g3, b3) = excel_tint(0.0, 0.0, 0.0, 0.5);
        assert_eq!(hex(r3, g3, b3), "#808080");
    }

    #[test]
    fn dml_shade_works_in_linear_light_unlike_excel_tint() {
        // A 50 % shade of mid grey halves its linear light, which keeps more
        // than half of its sRGB value (92 of 128, not 64).
        let grey = 128.0 / 255.0;
        let shaded = dml_shade(grey, 0.5);
        assert!(shaded > 0.0 && shaded < grey);
        assert_eq!((shaded * 255.0).round(), 92.0);
        // Excel's tint of the same amount moves luminance, not linear light.
        let (t, _, _) = excel_tint(grey, grey, grey, -0.5);
        assert!((t - grey * 0.5).abs() < 1e-12);
        assert_eq!(dml_tint(1.0, 0.3), linear_to_srgb(1.0));
        assert!((srgb_to_linear(linear_to_srgb(0.25)) - 0.25).abs() < 1e-12);
    }
}

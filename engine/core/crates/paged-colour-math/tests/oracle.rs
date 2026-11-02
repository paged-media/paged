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

//! Engine ADR 1056 slice 3 (stage A): the colour arithmetic moved here from
//! `paged-ooxml` with no change. This file keeps the OLD implementation, copied
//! verbatim from `paged-ooxml` as it stood before the move (`colour.rs` and
//! `drawingml/color.rs`), as the oracle: every function and every transform
//! agrees bit for bit over a grid of colours and values.
#![allow(clippy::all, dead_code)]

use paged_colour_math as new;

mod old {
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
    pub struct OldRgba {
        pub r: f64,
        pub g: f64,
        pub b: f64,
        pub a: f64,
    }

    impl OldRgba {
        pub const BLACK: OldRgba = OldRgba {
            r: 0.0,
            g: 0.0,
            b: 0.0,
            a: 1.0,
        };
        pub const WHITE: OldRgba = OldRgba {
            r: 1.0,
            g: 1.0,
            b: 1.0,
            a: 1.0,
        };

        /// 0xRRGGBB, opaque.
        pub fn from_hex(v: u32) -> Self {
            OldRgba {
                r: ((v >> 16) & 0xff) as f64 / 255.0,
                g: ((v >> 8) & 0xff) as f64 / 255.0,
                b: (v & 0xff) as f64 / 255.0,
                a: 1.0,
            }
        }

        /// sRGB bytes, opaque.
        pub fn from_bytes(rgb: [u8; 3]) -> Self {
            OldRgba {
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
    pub fn old_transform(rgba: OldRgba, name: &str, val: i32) -> OldRgba {
        let v = val as f64 / 100_000.0;
        let each = |f: &dyn Fn(f64) -> f64| OldRgba {
            r: f(rgba.r),
            g: f(rgba.g),
            b: f(rgba.b),
            a: rgba.a,
        };
        match name {
            "lumMod" | "lumOff" | "satMod" | "satOff" | "hueMod" | "hueOff" | "hue" | "sat"
            | "lum" => {
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
                OldRgba { r, g, b, a: rgba.a }
            }
            "tint" => each(&|c| dml_tint(c, v)),
            "shade" => each(&|c| dml_shade(c, v)),
            "alpha" => OldRgba { a: v, ..rgba },
            "alphaMod" => OldRgba {
                a: rgba.a * v,
                ..rgba
            },
            "alphaOff" => OldRgba {
                a: rgba.a + v,
                ..rgba
            },
            "comp" => {
                let (h, s, l) = rgb_to_hsl(rgba.r, rgba.g, rgba.b);
                let (r, g, b) = hsl_to_rgb((h + 0.5).rem_euclid(1.0), s, l);
                OldRgba { r, g, b, a: rgba.a }
            }
            "inv" => each(&|c| 1.0 - c),
            "gray" => {
                let y = 0.2126 * rgba.r + 0.7152 * rgba.g + 0.0722 * rgba.b;
                each(&|_| y)
            }
            "gamma" => each(&linear_to_srgb),
            "invGamma" => each(&srgb_to_linear),
            "redMod" => OldRgba {
                r: rgba.r * v,
                ..rgba
            },
            "greenMod" => OldRgba {
                g: rgba.g * v,
                ..rgba
            },
            "blueMod" => OldRgba {
                b: rgba.b * v,
                ..rgba
            },
            "redOff" => OldRgba {
                r: rgba.r + v,
                ..rgba
            },
            "greenOff" => OldRgba {
                g: rgba.g + v,
                ..rgba
            },
            "blueOff" => OldRgba {
                b: rgba.b + v,
                ..rgba
            },
            "red" => OldRgba { r: v, ..rgba },
            "green" => OldRgba { g: v, ..rgba },
            "blue" => OldRgba { b: v, ..rgba },
            _ => rgba,
        }
    }
}

fn bits(c: (f64, f64, f64)) -> [u64; 3] {
    [c.0.to_bits(), c.1.to_bits(), c.2.to_bits()]
}

fn grid() -> Vec<(f64, f64, f64)> {
    let mut v = Vec::new();
    for r in (0..=255).step_by(17) {
        for g in (0..=255).step_by(51) {
            for b in (0..=255).step_by(34) {
                v.push((r as f64 / 255.0, g as f64 / 255.0, b as f64 / 255.0));
            }
        }
    }
    // Greys, near-greys and the awkward corners.
    for i in 0..=64 {
        let c = i as f64 / 64.0;
        v.push((c, c, c));
        v.push((c, c, (c + 1e-13).min(1.0)));
    }
    v
}

const NAMES: &[&str] = &[
    "lumMod", "lumOff", "satMod", "satOff", "hueMod", "hueOff", "hue", "sat", "lum", "tint",
    "shade", "alpha", "alphaMod", "alphaOff", "comp", "inv", "gray", "gamma", "invGamma", "redMod",
    "greenMod", "blueMod", "redOff", "greenOff", "blueOff", "red", "green", "blue", "nothing",
];

const VALUES: &[i32] = &[
    -100_000, -50_000, 0, 1, 20_000, 40_000, 50_000, 60_000, 75_000, 100_000, 150_000, 200_000,
    5_400_000, 10_800_000, 21_600_000,
];

#[test]
fn the_arithmetic_is_the_old_arithmetic_bit_for_bit() {
    for (r, g, b) in grid() {
        assert_eq!(
            bits(new::rgb_to_hsl(r, g, b)),
            bits(old::rgb_to_hsl(r, g, b))
        );
        let (h, s, l) = new::rgb_to_hsl(r, g, b);
        assert_eq!(
            bits(new::hsl_to_rgb(h, s, l)),
            bits(old::hsl_to_rgb(h, s, l))
        );
        for t in [-1.5, -1.0, -0.4999, -0.1, 0.0, 0.3, 0.7999, 1.0, 1.5] {
            assert_eq!(
                bits(new::excel_tint(r, g, b, t)),
                bits(old::excel_tint(r, g, b, t))
            );
        }
        for v in [0.0, 0.1, 0.25, 0.5, 0.75, 1.0] {
            assert_eq!(new::dml_tint(r, v).to_bits(), old::dml_tint(r, v).to_bits());
            assert_eq!(
                new::dml_shade(g, v).to_bits(),
                old::dml_shade(g, v).to_bits()
            );
        }
        assert_eq!(
            new::srgb_to_linear(b).to_bits(),
            old::srgb_to_linear(b).to_bits()
        );
        assert_eq!(
            new::linear_to_srgb(b).to_bits(),
            old::linear_to_srgb(b).to_bits()
        );
    }
}

#[test]
fn every_transform_is_the_old_transform_bit_for_bit() {
    let mut n = 0;
    for (r, g, b) in grid() {
        for a in [1.0, 0.5, 0.0] {
            let n_in = new::Rgba { r, g, b, a };
            let o_in = old::OldRgba { r, g, b, a };
            for name in NAMES {
                for val in VALUES {
                    let x = new::transform(n_in, name, *val);
                    let y = old::old_transform(o_in, name, *val);
                    assert_eq!(
                        [x.r.to_bits(), x.g.to_bits(), x.b.to_bits(), x.a.to_bits()],
                        [y.r.to_bits(), y.g.to_bits(), y.b.to_bits(), y.a.to_bits()],
                        "{name} {val} on {r} {g} {b} {a}"
                    );
                    n += 1;
                }
            }
        }
    }
    assert!(n > 100_000, "{n}");
}

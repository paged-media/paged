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

//! Colour resolution: a [`ColorRef`] against the workbook theme to the
//! `#RRGGBB` the geometry paints (with the document swatch it names), and
//! Excel's automatic series colours for a chart style.
//!
//! AUTOMATIC COLOURS (Excel 2013+, `c:style` 2 — the default): series `i`
//! takes accent `i mod 6`; the second six take the accents at 60% luminance,
//! the third six at 80% luminance + 20% offset, then 80%, then 60% + 40%,
//! then 50%, and the cycle repeats. The other style columns (`c:style` 1–48,
//! `(style − 1) mod 8`): column 0 greys, column 1 the accents, columns 2–7
//! shades of one accent from dark to light across the series.

use crate::geometry::PlotData;
use crate::model::{dml_to_sheet_index, ColorRef, ConcreteColor};

/// The Office theme (2013+): dk1, lt1, dk2, lt2, accent1–6, hlink, folHlink.
pub const OFFICE_THEME: [u32; 12] = [
    0x000000, 0xFFFFFF, 0x44546A, 0xE7E6E6, 0x4472C4, 0xED7D31, 0xA5A5A5, 0xFFC000, 0x5B9BD5,
    0x70AD47, 0x0563C1, 0x954F72,
];

/// A resolved paint: the colour and the document swatch it names.
#[derive(Clone, Debug, PartialEq)]
pub struct Paint {
    pub hex: String,
    pub swatch: Option<String>,
}

impl Paint {
    pub fn hex(hex: &str) -> Paint {
        Paint {
            hex: hex.to_string(),
            swatch: None,
        }
    }
    pub fn rgb(rgb: u32) -> Paint {
        Paint::hex(&hex_of(rgb))
    }
    pub fn rgb_value(&self) -> u32 {
        u32::from_str_radix(self.hex.trim_start_matches('#'), 16).unwrap_or(0x888888)
    }
    /// The same colour lightened (+) or darkened (−) by an Excel tint; the
    /// swatch reference is dropped (it names the untinted colour).
    pub fn tinted(&self, tint: f64) -> Paint {
        Paint::rgb(apply_tint(self.rgb_value(), tint))
    }
}

/// The resolved theme.
#[derive(Clone, Debug)]
pub struct Theme {
    pub colors: [u32; 12],
}

impl Theme {
    pub fn from_data(data: &PlotData) -> Theme {
        Theme {
            colors: data.theme.unwrap_or(OFFICE_THEME),
        }
    }

    /// Resolve a colour role; `auto` paints `fallback`.
    pub fn paint(&self, c: &ColorRef, fallback: &str) -> Paint {
        let hex = match c.concrete {
            ConcreteColor::Rgb { r, g, b } => {
                hex_of((u32::from(r) << 16) | (u32::from(g) << 8) | u32::from(b))
            }
            // The shared type counts theme slots the spreadsheet way.
            ConcreteColor::Theme { index, tint } => hex_of(apply_tint(
                self.colors
                    .get(usize::from(dml_to_sheet_index(index.min(255) as u8)))
                    .copied()
                    .unwrap_or(0),
                tint,
            )),
            ConcreteColor::Indexed { index } => hex_of(indexed(index.min(255) as u8)),
            ConcreteColor::Auto => fallback.to_string(),
        };
        Paint {
            hex,
            swatch: c.doc.as_ref().map(|s| s.id.clone()),
        }
    }

    /// Resolve an optional role, with an automatic value when absent.
    pub fn paint_or(&self, c: Option<&ColorRef>, auto: impl FnOnce() -> Paint) -> Paint {
        match c {
            Some(c) if !matches!(c.concrete, ConcreteColor::Auto) => self.paint(c, "#808080"),
            Some(c) if c.doc.is_some() => {
                let mut p = auto();
                p.swatch = c.doc.as_ref().map(|s| s.id.clone());
                p
            }
            _ => auto(),
        }
    }

    /// Excel's automatic colour of series (or point) `i` of `n` under chart
    /// style `style`.
    pub fn auto_color(&self, i: usize, n: usize, style: Option<u32>) -> Paint {
        Paint::rgb(self.auto_value(i, n, style))
    }

    fn auto_value(&self, i: usize, n: usize, style: Option<u32>) -> u32 {
        let col = style.map_or(1, |s| (s.max(1) - 1) % 8);
        match col {
            0 => {
                // Greys: dark to light across the series.
                let t = if n <= 1 {
                    -0.5
                } else {
                    -0.85 + 0.7 * i as f64 / (n - 1) as f64
                };
                apply_tint(self.colors[1], t.min(-0.05))
            }
            1 => {
                const TIERS: [f64; 6] = [0.0, -0.4, 0.2, -0.2, 0.4, -0.5];
                let accent = self.colors[4 + i % 6];
                apply_tint(accent, TIERS[(i / 6) % TIERS.len()])
            }
            k => {
                let accent = self.colors[4 + (k as usize - 2)];
                let t = if n <= 1 {
                    0.0
                } else {
                    -0.5 + i as f64 / (n - 1) as f64
                };
                apply_tint(accent, t.clamp(-0.6, 0.6))
            }
        }
    }
}

pub fn hex_of(rgb: u32) -> String {
    format!("#{:06X}", rgb & 0xFF_FFFF)
}

/// Apply an Excel tint (−1..1) in HSL luminance: negative darkens
/// (`L·(1+t)`), positive lightens (`L·(1−t) + t`).
pub fn apply_tint(rgb: u32, tint: f64) -> u32 {
    if tint == 0.0 {
        return rgb & 0xFF_FFFF;
    }
    let (h, s, l) = rgb_to_hsl(rgb);
    let l = if tint < 0.0 {
        l * (1.0 + tint)
    } else {
        l * (1.0 - tint) + tint
    };
    hsl_to_rgb(h, s, l.clamp(0.0, 1.0))
}

/// DrawingML `lumMod` / `lumOff` (fractions) as an Excel tint.
pub fn tint_of(lum_mod: Option<f64>, lum_off: Option<f64>) -> f64 {
    match (lum_mod, lum_off) {
        (_, Some(off)) if off > 0.0 => off,
        (Some(m), _) => m - 1.0,
        _ => 0.0,
    }
}

fn rgb_to_hsl(rgb: u32) -> (f64, f64, f64) {
    let r = ((rgb >> 16) & 0xFF) as f64 / 255.0;
    let g = ((rgb >> 8) & 0xFF) as f64 / 255.0;
    let b = (rgb & 0xFF) as f64 / 255.0;
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let l = (max + min) / 2.0;
    if max == min {
        return (0.0, 0.0, l);
    }
    let d = max - min;
    let s = if l > 0.5 {
        d / (2.0 - max - min)
    } else {
        d / (max + min)
    };
    let h = if max == r {
        ((g - b) / d).rem_euclid(6.0)
    } else if max == g {
        (b - r) / d + 2.0
    } else {
        (r - g) / d + 4.0
    } / 6.0;
    (h, s, l)
}

fn hsl_to_rgb(h: f64, s: f64, l: f64) -> u32 {
    let q = if l < 0.5 {
        l * (1.0 + s)
    } else {
        l + s - l * s
    };
    let p = 2.0 * l - q;
    let ch = |t: f64| {
        let t = t.rem_euclid(1.0);
        let v = if t < 1.0 / 6.0 {
            p + (q - p) * 6.0 * t
        } else if t < 0.5 {
            q
        } else if t < 2.0 / 3.0 {
            p + (q - p) * (2.0 / 3.0 - t) * 6.0
        } else {
            p
        };
        (v * 255.0).round().clamp(0.0, 255.0) as u32
    };
    let (r, g, b) = if s == 0.0 {
        let v = (l * 255.0).round() as u32;
        (v, v, v)
    } else {
        (ch(h + 1.0 / 3.0), ch(h), ch(h - 1.0 / 3.0))
    };
    (r << 16) | (g << 8) | b
}

/// The legacy indexed palette (Excel's default 64 colours; 64 = system
/// foreground, 65 = system background).
pub fn indexed(i: u8) -> u32 {
    const P: [u32; 64] = [
        0x000000, 0xFFFFFF, 0xFF0000, 0x00FF00, 0x0000FF, 0xFFFF00, 0xFF00FF, 0x00FFFF, 0x000000,
        0xFFFFFF, 0xFF0000, 0x00FF00, 0x0000FF, 0xFFFF00, 0xFF00FF, 0x00FFFF, 0x800000, 0x008000,
        0x000080, 0x808000, 0x800080, 0x008080, 0xC0C0C0, 0x808080, 0x9999FF, 0x993366, 0xFFFFCC,
        0xCCFFFF, 0x660066, 0xFF8080, 0x0066CC, 0xCCCCFF, 0x000080, 0xFF00FF, 0xFFFF00, 0x00FFFF,
        0x800080, 0x800000, 0x008080, 0x0000FF, 0x00CCFF, 0xCCFFFF, 0xCCFFCC, 0xFFFF99, 0x99CCFF,
        0xFF99CC, 0xCC99FF, 0xFFCC99, 0x3366FF, 0x33CCCC, 0x99CC00, 0xFFCC00, 0xFF9900, 0xFF6600,
        0x666699, 0x969696, 0x003366, 0x339966, 0x003300, 0x333300, 0x993300, 0x993366, 0x333399,
        0x333333,
    ];
    match i {
        64 => 0x000000,
        65 => 0xFFFFFF,
        _ => P.get(i as usize).copied().unwrap_or(0x000000),
    }
}

#[cfg(test)]
#[allow(non_snake_case)] // `__feat__<id>` test-name links (cockpit rule)
mod tests {
    use super::*;

    #[test]
    fn tint_darkens_and_lightens__feat__sheet_chart_style_roles() {
        assert_eq!(apply_tint(0x4472C4, 0.0), 0x4472C4);
        let dark = apply_tint(0x4472C4, -0.4);
        let light = apply_tint(0x4472C4, 0.4);
        let lum = |c: u32| rgb_to_hsl(c).2;
        assert!(lum(dark) < lum(0x4472C4) && lum(light) > lum(0x4472C4));
        assert_eq!(apply_tint(0x808080, -1.0), 0x000000);
        assert_eq!(apply_tint(0x808080, 1.0), 0xFFFFFF);
    }

    #[test]
    fn default_style_cycles_the_accents_then_tiers__feat__sheet_chart_style_roles() {
        let t = Theme {
            colors: OFFICE_THEME,
        };
        assert_eq!(t.auto_color(0, 3, None).hex, "#4472C4");
        assert_eq!(t.auto_color(1, 3, None).hex, "#ED7D31");
        assert_eq!(t.auto_color(5, 8, Some(2)).hex, "#70AD47");
        // Series 7 is accent 1 at 60% luminance.
        assert_ne!(t.auto_color(6, 8, None).hex, "#4472C4");
    }

    #[test]
    fn theme_refs_resolve_with_their_swatch__feat__sheet_chart_style_roles() {
        let t = Theme {
            colors: OFFICE_THEME,
        };
        let p = t.paint(
            &crate::model::color_scheme(5, 0.0)
                .with_doc(crate::model::doc_swatch("Color/Brand", 0xED7D31)),
            "#000000",
        );
        assert_eq!(p.hex, "#ED7D31");
        assert_eq!(p.swatch.as_deref(), Some("Color/Brand"));
        assert_eq!(tint_of(Some(0.6), Some(0.4)), 0.4);
        assert!((tint_of(Some(0.75), None) + 0.25).abs() < 1e-12);
    }
}

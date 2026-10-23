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

//! The colour resolver (sheet ADR 518): ONE function turns a
//! [`ColorRef`] into what a surface paints — an sRGB colour and, when the
//! colour references a document swatch, that swatch's id. The page lowering,
//! the live grid, conditional formatting, number-format colours and chart
//! roles all resolve through [`resolve`], so a colour cannot differ between
//! surfaces.
//!
//! Resolution order: a document reference wins (its `fallback_rgb` is what a
//! surface that cannot read the swatch shows, its id what the page names);
//! else the concrete colour — RGB as stored, a theme slot from the
//! workbook's theme (the Office default theme for slots the workbook does
//! not carry), an indexed entry from the workbook's palette (the default
//! 64-entry table otherwise) — with the tint applied; `auto` resolves to
//! nothing (the reader's default).

use sheet_core::{ColorRef, ConcreteColor};

use crate::sections::DEFAULT_PALETTE;

/// The workbook's colour context: its theme colours (spreadsheet index
/// order: lt1, dk1, lt2, dk2, accent1–6, hlink, folHlink) and its indexed
/// palette override (`<colors><indexedColors>`; empty = the default table).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ColorPalette {
    pub theme: Vec<Option<(u8, u8, u8)>>,
    pub indexed: Vec<Option<(u8, u8, u8)>>,
}

/// The Office theme's colours (index order), for slots a workbook lacks.
pub const OFFICE_THEME: [(u8, u8, u8); 12] = [
    (0xFF, 0xFF, 0xFF),
    (0x00, 0x00, 0x00),
    (0xE7, 0xE6, 0xE6),
    (0x44, 0x54, 0x6A),
    (0x44, 0x72, 0xC4),
    (0xED, 0x7D, 0x31),
    (0xA5, 0xA5, 0xA5),
    (0xFF, 0xC0, 0x00),
    (0x5B, 0x9B, 0xD5),
    (0x70, 0xAD, 0x47),
    (0x05, 0x63, 0xC1),
    (0x95, 0x4F, 0x72),
];

/// What a colour paints: its sRGB and the document swatch it names.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct ResolvedColor {
    pub rgb: (u8, u8, u8),
    pub swatch: Option<String>,
}

impl ResolvedColor {
    /// `#RRGGBB`.
    pub fn hex(&self) -> String {
        hex(self.rgb)
    }
}

/// `(r, g, b)` → `#RRGGBB`.
pub fn hex(rgb: (u8, u8, u8)) -> String {
    format!("#{:02X}{:02X}{:02X}", rgb.0, rgb.1, rgb.2)
}

impl ColorPalette {
    /// A theme slot's colour (the Office theme beyond the workbook's).
    pub fn theme_rgb(&self, index: u32) -> Option<(u8, u8, u8)> {
        match self.theme.get(index as usize) {
            Some(Some(c)) => Some(*c),
            _ => OFFICE_THEME.get(index as usize).copied(),
        }
    }

    /// An indexed palette entry (`None` for the system colours 64/65).
    pub fn indexed_rgb(&self, index: u32) -> Option<(u8, u8, u8)> {
        match self.indexed.get(index as usize) {
            Some(c) => *c,
            None => DEFAULT_PALETTE.get(index as usize).copied(),
        }
    }
}

/// Resolve a colour (see the module docs). `None` = automatic.
pub fn resolve(color: &ColorRef, palette: &ColorPalette) -> Option<ResolvedColor> {
    if let Some(doc) = &color.doc {
        return Some(ResolvedColor {
            rgb: doc.fallback_rgb,
            swatch: Some(doc.id.clone()),
        });
    }
    let rgb = match &color.concrete {
        ConcreteColor::Rgb { r, g, b } => (*r, *g, *b),
        ConcreteColor::Theme { index, tint } => tint_rgb(palette.theme_rgb(*index)?, *tint),
        ConcreteColor::Indexed { index } => palette.indexed_rgb(*index)?,
        ConcreteColor::Auto => return None,
    };
    Some(ResolvedColor { rgb, swatch: None })
}

/// [`resolve`] as `#RRGGBB` (`None` = automatic).
pub fn resolve_hex(color: &ColorRef, palette: &ColorPalette) -> Option<String> {
    resolve(color, palette).map(|c| c.hex())
}

/// SpreadsheetML's `tint` on an sRGB colour: the HSL luminance moves toward
/// black (`tint < 0`: `L·(1+tint)`) or white (`L·(1−tint) + tint`), hue and
/// saturation kept (ECMA-376 §18.8.19; the arithmetic of
/// `paged_ooxml::colour::excel_tint`, which the xlsx layer's own theme tests
/// pin).
pub fn tint_rgb(rgb: (u8, u8, u8), tint: f64) -> (u8, u8, u8) {
    if tint == 0.0 || !tint.is_finite() {
        return rgb;
    }
    let f = |v: u8| v as f64 / 255.0;
    let (h, s, l) = rgb_to_hsl(f(rgb.0), f(rgb.1), f(rgb.2));
    let t = tint.clamp(-1.0, 1.0);
    let l = if t < 0.0 {
        l * (1.0 + t)
    } else {
        l * (1.0 - t) + t
    };
    let (r, g, b) = hsl_to_rgb(h, s, l.clamp(0.0, 1.0));
    let q = |v: f64| (v * 255.0).round().clamp(0.0, 255.0) as u8;
    (q(r), q(g), q(b))
}

/// Blend `fg` over `bg` by `share` of `fg` (a pattern a surface cannot draw
/// shows as this mix).
pub fn blend(fg: (u8, u8, u8), bg: (u8, u8, u8), share: f64) -> (u8, u8, u8) {
    let s = share.clamp(0.0, 1.0);
    let m = |a: u8, b: u8| (a as f64 * s + b as f64 * (1.0 - s)).round() as u8;
    (m(fg.0, bg.0), m(fg.1, bg.1), m(fg.2, bg.2))
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

#[cfg(test)]
#[allow(non_snake_case)]
mod tests {
    use super::*;
    use sheet_core::{DocColorModel, DocSwatchRef};

    #[test]
    fn one_resolver_for_every_colour__feat__sheet_format_cell_style() {
        let pal = ColorPalette {
            theme: vec![None, None, None, None, Some((0x4F, 0x81, 0xBD))],
            indexed: vec![],
        };
        assert_eq!(
            resolve_hex(&ColorRef::rgb(1, 2, 3), &pal).as_deref(),
            Some("#010203")
        );
        // The workbook's theme slot, tinted (the xlsx theme tests' values).
        assert_eq!(
            resolve_hex(&ColorRef::theme(4, 0.7999816888943144), &pal).as_deref(),
            Some("#DCE6F2")
        );
        assert_eq!(
            resolve_hex(&ColorRef::theme(4, -0.499984740745262), &pal).as_deref(),
            Some("#254061")
        );
        // A slot the workbook lacks falls back to the Office theme.
        assert_eq!(
            resolve_hex(&ColorRef::theme(5, 0.0), &pal).as_deref(),
            Some("#ED7D31")
        );
        assert_eq!(
            resolve_hex(&ColorRef::indexed(10), &pal).as_deref(),
            Some("#FF0000")
        );
        assert_eq!(resolve(&ColorRef::indexed(64), &pal), None);
        assert_eq!(resolve(&ColorRef::auto(), &pal), None);
        // A document reference wins: its fallback is shown, its id named.
        let doc = ColorRef::rgb(0, 0, 0).with_doc(DocSwatchRef {
            id: "Color/Brand".into(),
            model: DocColorModel::Spot,
            fallback_rgb: (0xE3, 0x00, 0x0F),
        });
        let r = resolve(&doc, &pal).unwrap();
        assert_eq!(r.hex(), "#E3000F");
        assert_eq!(r.swatch.as_deref(), Some("Color/Brand"));
        assert_eq!(blend((0, 0, 0), (255, 255, 255), 0.125), (223, 223, 223));
    }
}

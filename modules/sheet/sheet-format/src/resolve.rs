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
    /// The workbook's theme as the engine holds it (engine ADR 1056): a
    /// theme colour is followed (see [`ResolvedColor::theme`]) only where
    /// this theme resolves it to the colour the cell shows. `None` = the
    /// package has no readable theme part.
    pub engine_theme: Option<std::sync::Arc<dml_native::theme::EngineTheme>>,
}

/// The Office theme's colours (index order), for slots a workbook lacks: the
/// shared default palette (`paged_ooxml::drawingml::theme::OFFICE`, in
/// DrawingML order) with each light/dark pair swapped, as SpreadsheetML
/// numbers them.
pub const OFFICE_THEME: [(u8, u8, u8); 12] = {
    const fn rgb(v: u32) -> (u8, u8, u8) {
        ((v >> 16) as u8, (v >> 8) as u8, v as u8)
    }
    let o = paged_ooxml::drawingml::theme::OFFICE;
    [
        rgb(o[1]),
        rgb(o[0]),
        rgb(o[3]),
        rgb(o[2]),
        rgb(o[4]),
        rgb(o[5]),
        rgb(o[6]),
        rgb(o[7]),
        rgb(o[8]),
        rgb(o[9]),
        rgb(o[10]),
        rgb(o[11]),
    ]
};

/// The DrawingML slot a SpreadsheetML `theme="N"` index names.
pub const INDEX_SLOTS: [&str; 12] = [
    "lt1", "dk1", "lt2", "dk2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6",
    "hlink", "folHlink",
];

/// A theme slot and the DrawingML transforms after it: what a theme-coloured
/// cell follows (engine ADR 1056). See [`ResolvedColor::theme`].
pub type ThemeFollow = (String, Vec<(String, i32)>);

/// What a colour paints: its sRGB and the document swatch it names.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct ResolvedColor {
    pub rgb: (u8, u8, u8),
    pub swatch: Option<String>,
    /// The theme slot and transforms the colour follows, when it is a theme
    /// colour the workbook's engine theme resolves to exactly `rgb`.
    pub theme: Option<ThemeFollow>,
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
            theme: None,
        });
    }
    let mut theme = None;
    let rgb = match &color.concrete {
        ConcreteColor::Rgb { r, g, b } => (*r, *g, *b),
        ConcreteColor::Theme { index, tint } => {
            let rgb = tint_rgb(palette.theme_rgb(*index)?, *tint);
            theme = follow_theme(palette, *index, *tint, rgb);
            rgb
        }
        ConcreteColor::Indexed { index } => palette.indexed_rgb(*index)?,
        ConcreteColor::Auto => return None,
    };
    Some(ResolvedColor {
        rgb,
        swatch: None,
        theme,
    })
}

/// The slot and transforms a theme colour with `tint` follows: Excel's tint
/// is a luminance step in HSL (`tint < 0`: `L·(1+tint)`, `tint > 0`:
/// `L·(1−tint) + tint`), so it is `lumMod` / `lumOff`. Only where the
/// workbook's engine theme resolves that to `rgb`, the colour shown.
fn follow_theme(
    palette: &ColorPalette,
    index: u32,
    tint: f64,
    rgb: (u8, u8, u8),
) -> Option<ThemeFollow> {
    let theme = palette.engine_theme.as_deref()?;
    let slot = INDEX_SLOTS.get(index as usize)?;
    if !tint.is_finite() {
        return None;
    }
    let transforms = if tint < 0.0 {
        dml_native::theme::lum_transforms(1.0 + tint, 0.0)
    } else {
        dml_native::theme::lum_transforms(1.0 - tint, tint)
    };
    let r = dml_native::theme::ThemeRef {
        slot: slot.to_string(),
        transforms,
    };
    let value = [rgb.0 as f32, rgb.1 as f32, rgb.2 as f32];
    let r = dml_native::theme::follow(theme, r, &value)?;
    Some((r.slot, r.transforms))
}

/// [`resolve`] as `#RRGGBB` (`None` = automatic).
pub fn resolve_hex(color: &ColorRef, palette: &ColorPalette) -> Option<String> {
    resolve(color, palette).map(|c| c.hex())
}

/// SpreadsheetML's `tint` on an sRGB colour: the HSL luminance moves toward
/// black (`tint < 0`: `L·(1+tint)`) or white (`L·(1−tint) + tint`), hue and
/// saturation kept (ECMA-376 §18.8.19; the arithmetic of
/// `paged_ooxml::colour::excel_tint`, which this calls).
pub fn tint_rgb(rgb: (u8, u8, u8), tint: f64) -> (u8, u8, u8) {
    if tint == 0.0 || !tint.is_finite() {
        return rgb;
    }
    let f = |v: u8| v as f64 / 255.0;
    let (r, g, b) = paged_ooxml::colour::excel_tint(f(rgb.0), f(rgb.1), f(rgb.2), tint);
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
            engine_theme: None,
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

    const THEME_PART: &str = r#"<?xml version="1.0"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="T"><a:themeElements><a:clrScheme name="C">
<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
<a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>
<a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2>
<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4>
<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6>
<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink>
</a:clrScheme></a:themeElements></a:theme>"#;

    #[test]
    fn a_theme_colour_follows_its_slot_and_an_rgb_colour_does_not__feat__sheet_format_cell_style() {
        let engine = dml_native::theme::engine_theme(THEME_PART.as_bytes()).unwrap();
        let pal = ColorPalette {
            theme: OFFICE_THEME.iter().map(|c| Some(*c)).collect(),
            indexed: vec![],
            engine_theme: Some(std::sync::Arc::new(engine)),
        };
        let r = resolve(&ColorRef::theme(4, 0.0), &pal).unwrap();
        assert_eq!(r.theme, Some(("accent1".to_string(), vec![])));
        // Excel's "Accent 1, Lighter 40%" and "Darker 25%" (index 4).
        let light = resolve(&ColorRef::theme(4, 0.3999786376953125), &pal).unwrap();
        assert_eq!(light.theme.as_ref().map(|t| t.0.as_str()), Some("accent1"));
        assert_eq!(light.theme.as_ref().unwrap().1.len(), 2);
        let dark = resolve(&ColorRef::theme(4, -0.249977111117893), &pal).unwrap();
        assert_eq!(dark.theme.as_ref().unwrap().1.len(), 1);
        // The pair swap: index 0 is lt1, index 1 is dk1.
        assert_eq!(
            resolve(&ColorRef::theme(1, 0.0), &pal).unwrap().theme,
            Some(("dk1".to_string(), vec![]))
        );
        // A plain RGB colour, even one equal to a slot, is literal.
        assert_eq!(
            resolve(&ColorRef::rgb(0x44, 0x72, 0xC4), &pal)
                .unwrap()
                .theme,
            None
        );
        // Without an engine theme nothing follows.
        let bare = ColorPalette {
            engine_theme: None,
            ..pal
        };
        assert_eq!(
            resolve(&ColorRef::theme(4, 0.0), &bare).unwrap().theme,
            None
        );
    }
}

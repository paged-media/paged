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

//! `styles.xml` — the workbook style sheet (ECMA-376 §18.8).
//!
//! Two products come out of this part:
//!
//! 1. The interned [`StyleTable`] (`numFmt` resolution + the opaque
//!    `font`/`fill`/`border` `u32` slots, frozen `CellStyle` shape). A
//!    cell's `s="N"` indexes `cellXfs`; entry N carries the `numFmtId` we
//!    resolve (custom > built-in) and the raw sub-table ids.
//! 2. The **visual** model ([`VisualStyles`], M1 style-map track, spec
//!    §8.3): the `<fonts>`/`<fills>`/`<borders>` sub-tables are now
//!    *interpreted* — bold/italic, point size, font name, fill/text colours
//!    (resolved to `#RRGGBB`), and per-edge border presence — keyed by the
//!    cell's resolved [`StyleId`] so the lowering can turn a cell into a
//!    [`sheet_lower`-shaped] `LoweredStyle` on BOTH surfaces (the page lower
//!    and the grid scene resolve the SAME entry — the cross-surface-parity
//!    row). The frozen `CellStyle` keeps `font`/`fill`/`border` as `u32`
//!    indices; we DO NOT change it — `VisualStyles` is a separate side table
//!    returned alongside (`XlsxDocument::visual_styles`).
//!
//! Round-trip fidelity is unchanged: re-emitting the original `styles.xml`
//! verbatim when undirtied keeps every byte; the visual model is read-only
//! derived state for lowering, never written back.
//!
//! ## Colour resolution (spec §8.3, documented rulings)
//!
//! - `rgb="AARRGGBB"` — the leading alpha byte is dropped → `#RRGGBB`.
//! - `indexed="N"` — the workbook's own palette (`<colors><indexedColors>`)
//!   when it has one, else the legacy 56-entry table (ECMA-376 §18.8.27,
//!   [`indexed_color`]). Indices 64/65 (system foreground/background) have no
//!   fixed RGB → resolved to `None` (fall through to the document default).
//! - `theme="N"` — the workbook's theme part (`/theme` relationship, parsed
//!   by [`crate::parts::theme::ThemePalette`]) when the loader passes one
//!   ([`parse_with_colors`]); without a theme part, the SIX common slots of
//!   the Office default ([`theme_color`], best effort) and `None` beyond.
//! - `tint` — applied to whatever the reference resolved to
//!   ([`crate::parts::theme::apply_tint`]).
//! - `auto="1"` / nothing → `None` (the document default colour wins).
//!
//! The same [`ColorContext`] resolves `get_style`'s report, so the page
//! lowering and the format panel agree on every colour (round 2).

use crate::error::XlsxError;
use crate::opc::attr;
use crate::parts::style_model::StyleSheet;
use crate::parts::theme::{apply_tint, ThemePalette};
use sheet_core::style::{CellStyle, StyleTable};
use sheet_core::visual::{
    CellVisual, DifferentialFormat, FontSpec, HAlign, NamedCellStyle, RichRunVisual,
};
use sheet_core::StyleId;
use sheet_format::ColorPalette;
use std::collections::BTreeMap;

/// The standard built-in number formats (ECMA-376 §18.8.30, Table). Ids not
/// listed (5–8, 23–36, 41–44, 50–58) are locale/currency-dependent and have
/// no canonical code in the spec table; we leave them to fall back to
/// "General" in T0 (real workbooks that use them carry an explicit custom
/// numFmt or rely on the consumer's locale — out of T0 format scope).
pub fn builtin_num_fmt(id: u32) -> Option<&'static str> {
    Some(match id {
        0 => "General",
        1 => "0",
        2 => "0.00",
        3 => "#,##0",
        4 => "#,##0.00",
        9 => "0%",
        10 => "0.00%",
        11 => "0.00E+00",
        12 => "# ?/?",
        13 => "# ??/??",
        // ECMA-376 lists 14 as `mm-dd-yy`, but the id is the SYSTEM short
        // date: Excel (16, en-US) shows and reports it as `m/d/yy`
        // (recorded, oracle entry lane — ruling sheet.edit.typed-entry).
        14 => "m/d/yy",
        15 => "d-mmm-yy",
        16 => "d-mmm",
        17 => "mmm-yy",
        18 => "h:mm AM/PM",
        19 => "h:mm:ss AM/PM",
        20 => "h:mm",
        21 => "h:mm:ss",
        22 => "m/d/yy h:mm",
        37 => "#,##0 ;(#,##0)",
        38 => "#,##0 ;[Red](#,##0)",
        39 => "#,##0.00;(#,##0.00)",
        40 => "#,##0.00;[Red](#,##0.00)",
        45 => "mm:ss",
        46 => "[h]:mm:ss",
        // ECMA-376's `mmss.0` is an erratum: Excel reports and renders 47 as
        // `mm:ss.0` (recorded, oracle entry lane).
        47 => "mm:ss.0",
        48 => "##0.0E+0",
        49 => "@",
        _ => return None,
    })
}

/// The legacy indexed colour palette (ECMA-376 §18.8.27). Returns the
/// `#RRGGBB` string for a palette index, or `None` for indices with no fixed
/// RGB (64 = system foreground, 65 = system background, anything past the
/// table). This is the standard default palette Excel ships; a workbook MAY
/// override it via `<indexedColors>`, which T0 does not parse (documented).
pub fn indexed_color(idx: u32) -> Option<&'static str> {
    // ECMA-376 Table — indices 0..=63. 0..=7 duplicate 8..=15 by spec.
    const PALETTE: &[&str] = &[
        "#000000", "#FFFFFF", "#FF0000", "#00FF00", "#0000FF", "#FFFF00", "#FF00FF", "#00FFFF",
        "#000000", "#FFFFFF", "#FF0000", "#00FF00", "#0000FF", "#FFFF00", "#FF00FF", "#00FFFF",
        "#800000", "#008000", "#000080", "#808000", "#800080", "#008080", "#C0C0C0", "#808080",
        "#9999FF", "#993366", "#FFFFCC", "#CCFFFF", "#660066", "#FF8080", "#0066CC", "#CCCCFF",
        "#000080", "#FF00FF", "#FFFF00", "#00FFFF", "#800080", "#800000", "#008080", "#0000FF",
        "#00CCFF", "#CCFFFF", "#CCFFCC", "#FFFF99", "#99CCFF", "#FF99CC", "#CC99FF", "#FFCC99",
        "#3366FF", "#33CCCC", "#99CC00", "#FFCC00", "#FF9900", "#FF6600", "#666699", "#969696",
        "#003366", "#339966", "#003300", "#333300", "#993300", "#993366", "#333399", "#333333",
    ];
    PALETTE.get(idx as usize).copied()
}

/// Best-effort theme-colour fallback for a package WITHOUT a readable theme
/// part (the real palette is read by [`ColorContext`] from the workbook's
/// `/theme` relationship). Maps the six slots of the Office default theme;
/// slots beyond these resolve to `None` so the document default colour wins
/// rather than guessing.
pub fn theme_color(idx: u32) -> Option<&'static str> {
    Some(match idx {
        0 => "#FFFFFF", // dk1 / lt1 ordering varies; 0/1 are the text/bg pair
        1 => "#000000",
        2 => "#E7E6E6", // lt2 (light background 2)
        3 => "#44546A", // dk2 (dark text 2)
        4 => "#4472C4", // accent1 (the Office default blue)
        5 => "#ED7D31", // accent2 (orange)
        _ => return None,
    })
}

/// One cell's resolved visual style — the lowering's flat
/// [`sheet_lower::VisualAttrs`] (one type, so a loaded style and a lowered
/// one cannot drift). Colours are `#RRGGBB` (beside their document swatch
/// ids), sizes points; `None`/`false` = no explicit attribute.
pub type VisualStyle = sheet_lower::VisualAttrs;

/// The visual style side table: a cell's resolved [`StyleId`] → its
/// [`VisualStyle`], plus the unresolved model behind it ([`CellVisual`],
/// W2.2), the Excel named cell styles and the palette colours resolve
/// against.
#[derive(Clone, Debug, Default)]
pub struct VisualStyles {
    by_style: BTreeMap<u32, VisualStyle>,
    models: BTreeMap<u32, CellVisual>,
    named: Vec<NamedCellStyle>,
    palette: ColorPalette,
    default_font: FontSpec,
    /// Rich-text cells: `(sheet, row, col)` → the runs of its shared string.
    rich: BTreeMap<(sheet_core::SheetId, u32, u32), Vec<RichRunVisual>>,
}

impl VisualStyles {
    /// The visual style for a resolved `StyleId`, or `None` (the default).
    pub fn get(&self, id: StyleId) -> Option<&VisualStyle> {
        self.by_style.get(&id.0).filter(|v| !v.is_default())
    }

    /// The unresolved visual model of a style (`None` for an id the style
    /// sheet does not carry).
    pub fn model(&self, id: StyleId) -> Option<&CellVisual> {
        self.models.get(&id.0)
    }

    /// The Excel named cell styles (`cellStyles`), in document order.
    pub fn named_styles(&self) -> &[NamedCellStyle] {
        &self.named
    }

    /// The palette (theme + indexed colours) every colour resolves against.
    pub fn palette(&self) -> &ColorPalette {
        &self.palette
    }

    /// The workbook's base font (`<fonts>` entry 0).
    pub fn default_font(&self) -> &FontSpec {
        &self.default_font
    }

    /// The table with the workbook's rich-text cells.
    pub fn with_rich(
        mut self,
        rich: BTreeMap<(sheet_core::SheetId, u32, u32), Vec<RichRunVisual>>,
    ) -> Self {
        self.rich = rich;
        self
    }

    /// Carry the rich-text cells over from an earlier table (a style edit
    /// re-parses the styles part; the runs belong to the strings).
    pub fn take_rich_from(&mut self, other: &mut VisualStyles) {
        self.rich = std::mem::take(&mut other.rich);
    }

    /// Drop a cell's runs (its text was edited).
    pub fn forget_rich(&mut self, sheet: sheet_core::SheetId, row: u32, col: u32) {
        self.rich.remove(&(sheet, row, col));
    }

    /// True if NO cell carries visual styling (e.g. an unstyled workbook).
    pub fn is_empty(&self) -> bool {
        self.by_style.values().all(VisualStyle::is_default)
    }
}

/// Make [`VisualStyles`] a [`sheet_lower::VisualStyleSource`] so the page
/// lowering and the grid scene resolve the parsed styles through ONE trait —
/// a cell's `StyleId` yields an IDENTICAL `LoweredStyle` on both surfaces.
impl sheet_lower::VisualStyleSource for VisualStyles {
    fn visual(&self, id: StyleId) -> Option<sheet_lower::VisualAttrs> {
        self.get(id).cloned()
    }

    fn rich_runs(
        &self,
        sheet: sheet_core::SheetId,
        row: u32,
        col: u32,
        text: &str,
        base: &sheet_lower::VisualAttrs,
    ) -> Option<Vec<(String, sheet_lower::VisualAttrs)>> {
        let runs = self.rich.get(&(sheet, row, col))?;
        // The runs belong to the text the cell was loaded with: an edited
        // cell shows plain text.
        if runs.iter().map(|r| r.text.as_str()).collect::<String>() != text {
            return None;
        }
        Some(
            runs.iter()
                .map(|r| {
                    let attrs = match &r.font {
                        Some(f) => {
                            sheet_lower::run_attrs(base, f, &self.palette, &self.default_font)
                        }
                        None => base.clone(),
                    };
                    (r.text.clone(), attrs)
                })
                .collect(),
        )
    }

    fn format_color_rgb(&self, color: sheet_format::FormatColor) -> String {
        match self.palette.indexed.get(color.palette_index() as usize) {
            Some(Some(rgb)) => sheet_format::resolve::hex(*rgb),
            _ => {
                let (r, g, b) = color.default_rgb();
                format!("#{r:02X}{g:02X}{b:02X}")
            }
        }
    }
}

/// The parsed style sheet, ready to fold into the model's `StyleTable`.
pub struct ParsedStyles {
    /// `StyleId` per `cellXfs` index N (so `s="N"` -> styles[N]).
    pub xf_to_style: Vec<StyleId>,
    /// The visual side table (resolved + model), keyed by `StyleId`.
    pub visual: VisualStyles,
    /// The differential formats (`<dxfs>`) resolved, indexed by `dxfId`.
    pub dxfs: Vec<VisualStyle>,
    /// The differential formats as the model holds them (W2.2): what a
    /// conditional format changes, number format included.
    pub dxf_models: Vec<DifferentialFormat>,
    /// A workbook display locale DERIVED from the styles' custom number-format
    /// codes (ruling `sheet.format.locale.locale-from-workbook`): the first
    /// custom code whose `[$…-LCID]` token names a non-en locale.
    pub workbook_locale: Option<sheet_core::Locale>,
}

/// Parse `styles.xml`, interning each `cellXfs` entry into `styles` AND
/// building the [`VisualStyles`] side table.
pub fn parse(xml: &[u8], styles: &mut StyleTable) -> Result<ParsedStyles, XlsxError> {
    parse_with_colors(xml, styles, &ColorContext::new(xml, None))
}

/// [`parse`] with the workbook's colour context (its theme part's scheme and
/// the styles' `<indexedColors>`).
pub fn parse_with_colors(
    xml: &[u8],
    styles: &mut StyleTable,
    colors: &ColorContext,
) -> Result<ParsedStyles, XlsxError> {
    let sheet = StyleSheet::parse(xml)?;

    let mut workbook_locale: Option<sheet_core::Locale> = None;
    for code in sheet.num_fmts.values() {
        if let Ok(compiled) = sheet_format::compile(code) {
            if let Some(loc) = compiled.locale {
                if loc != sheet_core::Locale::EnUs {
                    workbook_locale = Some(loc);
                    break;
                }
            }
        }
    }

    let palette = sheet.palette(colors.theme_rgbs());
    let default_font = sheet.fonts.first().cloned().unwrap_or_default();
    let mut xf_to_style = Vec::with_capacity(sheet.cell_xfs.len());
    let mut visual = VisualStyles {
        named: sheet.named_styles(),
        palette: palette.clone(),
        default_font: default_font.clone(),
        ..VisualStyles::default()
    };
    for (i, xf) in sheet.cell_xfs.iter().enumerate() {
        let code = sheet.num_fmt_code(xf.num_fmt_id);
        let num_fmt = styles.intern_num_fmt(&code);
        let style = CellStyle {
            num_fmt,
            font: xf.font_id,
            fill: xf.fill_id,
            border: xf.border_id,
            align: model_align(xf.alignment.horizontal),
        };
        // POSITIONAL ids (Wave 6): `StyleId == cellXfs index`; xf 0 takes
        // the seeded id 0.
        let id = if i == 0 {
            styles.replace_style(StyleId(0), style);
            StyleId(0)
        } else {
            styles.push_style(style)
        };
        xf_to_style.push(id);
        let model = sheet.cell_visual(i, &palette);
        let resolved = sheet_lower::resolve_visual(&model, &palette, &default_font);
        visual.by_style.insert(id.0, resolved);
        visual.models.insert(id.0, model);
    }

    let dxfs = sheet
        .dxfs
        .iter()
        .map(|d| sheet_lower::resolve_delta(d, &palette))
        .collect();

    Ok(ParsedStyles {
        xf_to_style,
        visual,
        dxfs,
        dxf_models: sheet.dxfs,
        workbook_locale,
    })
}

/// The frozen model's horizontal alignment (`centerContinuous` reads as
/// centred; `justify`/`distributed` as left; `fill`/`general` as general —
/// the full value rides the visual model's `h_align`).
fn model_align(h: HAlign) -> sheet_core::Align {
    match h {
        HAlign::Left | HAlign::Justify | HAlign::Distributed => sheet_core::Align::Left,
        HAlign::Center | HAlign::CenterContinuous => sheet_core::Align::Center,
        HAlign::Right => sheet_core::Align::Right,
        HAlign::General | HAlign::Fill => sheet_core::Align::General,
    }
}

/// What a colour reference resolves against: the workbook theme's scheme
/// and the workbook's own indexed palette (`<colors><indexedColors>`, which
/// overrides the legacy default table when present). One context serves the
/// page lowering ([`parse_with_colors`]) and the style report
/// (`XlsxDocument::describe_style`).
#[derive(Clone, Debug, Default)]
pub struct ColorContext {
    theme: Option<ThemePalette>,
    /// The workbook's palette, in index order (`None` = an unreadable entry).
    indexed: Vec<Option<String>>,
}

/// The attributes of one `<color>`-shaped element.
#[derive(Default)]
pub(crate) struct ColorAttrs {
    pub auto: Option<String>,
    pub rgb: Option<String>,
    pub indexed: Option<String>,
    pub theme: Option<String>,
    pub tint: Option<String>,
}

impl ColorContext {
    /// The theme's twelve colours in spreadsheet index order (`None` where
    /// the theme part has none — the resolver falls back to the Office
    /// theme).
    pub fn theme_rgbs(&self) -> Vec<Option<(u8, u8, u8)>> {
        (0..12)
            .map(|t| {
                self.theme
                    .as_ref()
                    .and_then(|p| p.color(t))
                    .and_then(crate::parts::style_model::rgb_bytes)
            })
            .collect()
    }

    /// The context of a styles part (`styles_xml`'s `<indexedColors>`) under
    /// a theme (`None` = the package has no readable theme part).
    pub fn new(styles_xml: &[u8], theme: Option<ThemePalette>) -> ColorContext {
        ColorContext {
            theme,
            indexed: scan_indexed_colors(styles_xml),
        }
    }

    /// Resolve a colour reference to `#RRGGBB`: `rgb` (alpha dropped), else
    /// `indexed`, else `theme`, then its `tint`. `auto` / nothing / an
    /// unknown slot → `None` (the document default).
    pub(crate) fn resolve(&self, a: &ColorAttrs) -> Option<String> {
        if a.auto.as_deref().is_some_and(|v| v == "1" || v == "true") {
            return None;
        }
        let base = if let Some(rgb) = &a.rgb {
            normalize_rgb(rgb)?
        } else if let Some(i) = a.indexed.as_deref().and_then(|v| v.parse::<usize>().ok()) {
            match self.indexed.get(i) {
                Some(c) => c.clone()?,
                None => indexed_color(i as u32)?.to_string(),
            }
        } else {
            let t = a.theme.as_deref().and_then(|v| v.parse::<u32>().ok())?;
            match self.theme.as_ref().and_then(|p| p.color(t)) {
                Some(c) => c.to_string(),
                None => theme_color(t)?.to_string(),
            }
        };
        match a.tint.as_deref().and_then(|v| v.parse::<f64>().ok()) {
            Some(tint) => Some(apply_tint(&base, tint)),
            None => Some(base),
        }
    }
}

/// The `<colors><indexedColors><rgbColor rgb/>` palette of a styles part
/// (empty when it has none, or the part is unreadable).
fn scan_indexed_colors(xml: &[u8]) -> Vec<Option<String>> {
    use quick_xml::events::Event;
    let mut reader = quick_xml::Reader::from_reader(xml);
    let mut buf = Vec::new();
    let mut out = Vec::new();
    let mut inside = false;
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) if e.local_name().as_ref() == b"indexedColors" => inside = true,
            Ok(Event::End(e)) if e.local_name().as_ref() == b"indexedColors" => break,
            Ok(Event::Start(e) | Event::Empty(e))
                if inside && e.local_name().as_ref() == b"rgbColor" =>
            {
                out.push(
                    attr(&e, b"rgb")
                        .ok()
                        .flatten()
                        .and_then(|v| normalize_rgb(&v)),
                );
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    out
}

/// Normalize an xlsx `rgb` attribute (`AARRGGBB` or `RRGGBB`) to `#RRGGBB`.
/// Drops the leading alpha byte; returns `None` if not a valid hex colour.
fn normalize_rgb(rgb: &str) -> Option<String> {
    let hex = rgb.trim();
    let body = match hex.len() {
        8 => &hex[2..], // strip the AA alpha byte
        6 => hex,
        _ => return None,
    };
    if body.chars().all(|c| c.is_ascii_hexdigit()) {
        Some(format!("#{}", body.to_ascii_uppercase()))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_table_spot_checks() {
        assert_eq!(builtin_num_fmt(0), Some("General"));
        assert_eq!(builtin_num_fmt(2), Some("0.00"));
        assert_eq!(builtin_num_fmt(9), Some("0%"));
        assert_eq!(builtin_num_fmt(14), Some("m/d/yy"));
        assert_eq!(builtin_num_fmt(47), Some("mm:ss.0"));
        assert_eq!(builtin_num_fmt(49), Some("@"));
        // locale/currency ids have no canonical code in T0
        assert_eq!(builtin_num_fmt(5), None);
        assert_eq!(builtin_num_fmt(164), None);
    }

    #[test]
    #[allow(non_snake_case)]
    fn format_colors_read_the_workbook_palette__feat__sheet_format_engine() {
        use sheet_lower::VisualStyleSource;
        // Slot 10 ([Red] = [Color3]) and slot 19 ([Color12]) overridden.
        let mut pal = String::new();
        for i in 0..64 {
            let rgb = match i {
                10 => "FF112233",
                19 => "FFAABBCC",
                _ => "FF000000",
            };
            pal.push_str(&format!(r#"<rgbColor rgb="{rgb}"/>"#));
        }
        let xml = format!(
            r#"<styleSheet><colors><indexedColors>{pal}</indexedColors></colors>
<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellXfs></styleSheet>"#
        );
        let mut table = StyleTable::new();
        let ctx = ColorContext::new(xml.as_bytes(), None);
        let parsed = parse_with_colors(xml.as_bytes(), &mut table, &ctx).unwrap();
        let v = &parsed.visual;
        assert_eq!(
            v.format_color_rgb(sheet_format::FormatColor::Red),
            "#112233"
        );
        assert_eq!(
            v.format_color_rgb(sheet_format::FormatColor::Indexed(12)),
            "#AABBCC"
        );
        // Without an override the default palette answers.
        let plain = VisualStyles::default();
        assert_eq!(
            plain.format_color_rgb(sheet_format::FormatColor::Blue),
            "#0000FF"
        );
    }

    #[test]
    fn indexed_and_theme_palettes() {
        assert_eq!(indexed_color(2), Some("#FF0000")); // red
        assert_eq!(indexed_color(5), Some("#FFFF00")); // yellow
        assert_eq!(indexed_color(64), None); // system foreground — no fixed RGB
        assert_eq!(theme_color(1), Some("#000000"));
        assert_eq!(theme_color(99), None); // beyond the mapped slots
    }

    #[test]
    fn normalize_rgb_drops_alpha() {
        assert_eq!(normalize_rgb("FFFFFF00").as_deref(), Some("#FFFF00"));
        assert_eq!(normalize_rgb("00FF00").as_deref(), Some("#00FF00"));
        assert_eq!(normalize_rgb("ffff0000").as_deref(), Some("#FF0000"));
        assert_eq!(normalize_rgb("nothex!!").as_deref(), None);
        assert_eq!(normalize_rgb("FFF").as_deref(), None);
    }

    #[test]
    fn sheet_format_locale_from_workbook_numfmt_token() {
        // A custom numFmt carrying a [$-407] de-DE locale token sets the
        // derived workbook locale (ruling sheet.format.locale.locale-from-workbook).
        let xml = br#"<?xml version="1.0"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="1">
    <numFmt numFmtId="164" formatCode="[$-407]#,##0.00"/>
  </numFmts>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="1"><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>
</styleSheet>"#;
        let mut st = StyleTable::new();
        let p = parse(xml, &mut st).unwrap();
        assert_eq!(p.workbook_locale, Some(sheet_core::Locale::DeDe));
    }

    #[test]
    fn sheet_format_locale_from_workbook_no_hint_defaults_en() {
        // No [$…-LCID] token anywhere → no hint (caller keeps Locale::EnUs).
        // A bare [$-409] (en-US) is NOT recorded as a hint either.
        let xml = br#"<?xml version="1.0"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="2">
    <numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/>
    <numFmt numFmtId="165" formatCode="[$-409]0.00"/>
  </numFmts>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="1"><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>
</styleSheet>"#;
        let mut st = StyleTable::new();
        let p = parse(xml, &mut st).unwrap();
        assert_eq!(p.workbook_locale, None);
    }

    #[test]
    fn parse_custom_and_builtin_cellxfs() {
        let xml = br#"<?xml version="1.0"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="1">
    <numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/>
  </numFmts>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="3">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="2" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="164" fontId="0" fillId="2" borderId="1" xfId="0" applyNumberFormat="1"/>
  </cellXfs>
</styleSheet>"#;
        let mut st = StyleTable::new();
        let p = parse(xml, &mut st).unwrap();
        assert_eq!(p.xf_to_style.len(), 3);
        // xf 0 -> General
        assert_eq!(st.num_fmt_of(p.xf_to_style[0]), "General");
        // xf 1 -> built-in 2
        assert_eq!(st.num_fmt_of(p.xf_to_style[1]), "0.00");
        // xf 2 -> custom 164, with raw font/fill/border slots captured
        assert_eq!(st.num_fmt_of(p.xf_to_style[2]), "\"$\"#,##0.00");
        let s2 = st.style(p.xf_to_style[2]);
        assert_eq!(s2.fill, 2);
        assert_eq!(s2.border, 1);
    }

    /// The full visual parse: fonts (bold/size/name), fills (solid fgColor),
    /// borders (per-edge thin), threaded through `cellXfs` into a
    /// `VisualStyles` keyed by the resolved `StyleId`. Mirrors the corpus
    /// fixture 03-styles.xlsx exactly.
    #[test]
    fn parse_visual_fonts_fills_borders() {
        let xml = br#"<?xml version="1.0"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="2">
    <numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/>
    <numFmt numFmtId="165" formatCode="0.000%"/>
  </numFmts>
  <fonts count="3">
    <font><sz val="11"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><name val="Calibri"/></font>
    <font><sz val="18"/><name val="Cambria"/></font>
  </fonts>
  <fills count="3">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border><left style="thin"/><right style="thin"/><top style="thin"/><bottom style="thin"/><diagonal/></border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="6">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="2" fontId="1" fillId="0" borderId="1" xfId="0"/>
    <xf numFmtId="164" fontId="0" fillId="2" borderId="0" xfId="0"/>
    <xf numFmtId="9" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0"/>
  </cellXfs>
</styleSheet>"#;
        let mut st = StyleTable::new();
        let p = parse(xml, &mut st).unwrap();

        // xf 0 — plain (default font, no emphasis/fill/border) → no entry.
        // The default font (index 0)'s size/name are the document default,
        // NOT a per-cell override (the §8.3 minimal-override ruling).
        assert!(p.visual.get(p.xf_to_style[0]).is_none());

        // xf 1 — bold + thin border all sides, no fill. The font shares the
        // DEFAULT size/name (Calibri 11), so only `bold` is recorded — the
        // size/name fold to the document default (minimal override).
        let v1 = p
            .visual
            .get(p.xf_to_style[1])
            .expect("xf1 has visual style");
        assert!(v1.bold);
        assert!(!v1.italic);
        assert_eq!(v1.font_size_pt, None, "default size is not an override");
        assert_eq!(v1.font_name, None, "default name is not an override");
        assert!(v1.border_top && v1.border_right && v1.border_bottom && v1.border_left);
        assert_eq!(v1.fill_rgb, None);

        // xf 2 — yellow solid fill (FFFFFF00 -> #FFFF00), no border, no bold.
        let v2 = p
            .visual
            .get(p.xf_to_style[2])
            .expect("xf2 has visual style");
        assert_eq!(v2.fill_rgb.as_deref(), Some("#FFFF00"));
        assert!(!v2.bold);
        assert!(!v2.border_top);

        // xf 5 — font 2 is a genuinely DISTINCT face (Cambria 18) → its
        // size + name ARE overrides (they differ from the default font).
        let v5 = p
            .visual
            .get(p.xf_to_style[5])
            .expect("xf5 has visual style");
        assert_eq!(v5.font_size_pt, Some(18.0));
        assert_eq!(v5.font_name.as_deref(), Some("Cambria"));
        assert!(!v5.bold);

        // xf 3/4 — only a number format differs; visually default → no entry.
        assert!(p.visual.get(p.xf_to_style[3]).is_none());
        assert!(p.visual.get(p.xf_to_style[4]).is_none());
    }

    #[test]
    fn apply_font_zero_suppresses_emphasis() {
        let xml = br#"<?xml version="1.0"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="1"><font><b/><sz val="14"/><name val="Arial"/></font></fonts>
  <fills count="1"><fill><patternFill patternType="none"/></fill></fills>
  <borders count="1"><border/></borders>
  <cellXfs count="1">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" applyFont="0"/>
  </cellXfs>
</styleSheet>"#;
        let mut st = StyleTable::new();
        let p = parse(xml, &mut st).unwrap();
        // applyFont="0" suppresses the font facet → visually default.
        assert!(p.visual.get(p.xf_to_style[0]).is_none());
    }

    #[test]
    fn parse_dxfs_for_conditional_formatting() {
        // `<dxfs>` is the differential-format table a cfRule dxfId references.
        // dxf 0: bold + red text + yellow fill (bgColor, the dxf convention).
        // dxf 1: italic only. Each PRESENT facet is an override (no apply* /
        // default-font folding — a dxf carries only what the rule changes).
        let xml = br#"<?xml version="1.0"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
  <fills count="1"><fill><patternFill patternType="none"/></fill></fills>
  <borders count="1"><border/></borders>
  <cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellXfs>
  <dxfs count="2">
    <dxf>
      <font><b/><color rgb="FFFF0000"/></font>
      <fill><patternFill><bgColor rgb="FFFFFF00"/></patternFill></fill>
    </dxf>
    <dxf>
      <font><i/></font>
    </dxf>
  </dxfs>
</styleSheet>"#;
        let mut st = StyleTable::new();
        let p = parse(xml, &mut st).unwrap();
        assert_eq!(p.dxfs.len(), 2);

        // dxf 0 — bold + red text + yellow fill, nothing else.
        let d0 = &p.dxfs[0];
        assert!(d0.bold);
        assert!(!d0.italic);
        assert_eq!(d0.text_rgb.as_deref(), Some("#FF0000"));
        assert_eq!(d0.fill_rgb.as_deref(), Some("#FFFF00"));
        assert_eq!(d0.font_size_pt, None);
        assert!(!d0.border_top);

        // dxf 1 — italic only.
        let d1 = &p.dxfs[1];
        assert!(d1.italic);
        assert!(!d1.bold);
        assert_eq!(d1.fill_rgb, None);
        assert_eq!(d1.text_rgb, None);
    }

    #[test]
    fn dxf_solid_fill_fgcolor_also_accepted() {
        // Some writers use <fgColor> in a dxf fill; accept it too.
        let xml = br#"<?xml version="1.0"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellXfs>
  <dxfs count="1">
    <dxf><fill><patternFill patternType="solid"><fgColor rgb="FF00FF00"/></patternFill></fill></dxf>
  </dxfs>
</styleSheet>"#;
        let mut st = StyleTable::new();
        let p = parse(xml, &mut st).unwrap();
        assert_eq!(p.dxfs.len(), 1);
        assert_eq!(p.dxfs[0].fill_rgb.as_deref(), Some("#00FF00"));
    }

    #[test]
    fn no_dxfs_yields_empty_table() {
        let xml = br#"<?xml version="1.0"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellXfs>
</styleSheet>"#;
        let mut st = StyleTable::new();
        let p = parse(xml, &mut st).unwrap();
        assert!(p.dxfs.is_empty());
    }

    #[test]
    fn indexed_and_theme_colors_in_fill_and_font() {
        let xml = br#"<?xml version="1.0"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="1"><font><color indexed="2"/><sz val="11"/><name val="Calibri"/></font></fonts>
  <fills count="2">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="solid"><fgColor theme="4"/></patternFill></fill>
  </fills>
  <borders count="1"><border/></borders>
  <cellXfs count="1">
    <xf numFmtId="0" fontId="0" fillId="1" borderId="0"/>
  </cellXfs>
</styleSheet>"#;
        let mut st = StyleTable::new();
        let p = parse(xml, &mut st).unwrap();
        let v = p.visual.get(p.xf_to_style[0]).expect("colours present");
        assert_eq!(v.text_rgb.as_deref(), Some("#FF0000")); // indexed 2 = red
        assert_eq!(v.fill_rgb.as_deref(), Some("#4472C4")); // theme 4 = accent1
    }
}

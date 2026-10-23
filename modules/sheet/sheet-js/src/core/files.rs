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

//! Files and dialect (sheet ADR 521): the package kind (`.xlsx`, `.xlsm`,
//! templates) and saving as another kind, the OpenDocument import, the CSV
//! export, and the display dialect of formulas (R1C1, localized names).

use serde::Serialize;
use sheet_core::CellValue;
use sheet_format::{FormatCache, FormatCtx};
use sheet_parser::dialect::{self, Dialect, FormulaLang, RefStyle};
use sheet_xlsx::kind::WorkbookKind;
use sheet_xlsx::XlsxDocument;

use super::{cell_display, SessionError, SheetSession};

/// The CSV export options.
#[derive(Debug, Clone)]
pub struct CsvExportOptions {
    /// The field delimiter: `","`, `";"` or `"\t"`.
    pub delimiter: String,
    /// `true` writes what the cells show (their number formats applied, as
    /// Excel's "CSV" save does); `false` the underlying values (numbers in
    /// shortest round-trip form, dates as serials, `TRUE`/`FALSE`).
    pub formatted: bool,
    /// Lead with a UTF-8 byte-order mark (Excel reads a BOM-less CSV in the
    /// system code page).
    pub bom: bool,
    /// The range to export (`"B2:D9"`, a defined name); empty for the used
    /// range of the sheet, from A1.
    pub range: String,
}

impl Default for CsvExportOptions {
    fn default() -> Self {
        CsvExportOptions {
            delimiter: ",".into(),
            formatted: true,
            bom: false,
            range: String::new(),
        }
    }
}

/// The formula display settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormulaDisplay {
    /// R1C1 references (the workbook's `<calcPr refMode>`).
    pub r1c1: bool,
    /// The function-name language (`"en"`, `"de"`).
    pub lang: String,
}

/// One CSV field, quoted when RFC 4180 needs it.
fn csv_field(s: &str, delim: char, out: &mut String) {
    if s.contains([delim, '"', '\r', '\n']) {
        out.push('"');
        out.push_str(&s.replace('"', "\"\""));
        out.push('"');
    } else {
        out.push_str(s);
    }
}

/// A raw (unformatted) value as CSV text.
fn raw_text(v: &CellValue) -> String {
    match v {
        CellValue::Empty => String::new(),
        CellValue::Number(n) => {
            if n.fract() == 0.0 && n.abs() < 1e15 {
                format!("{}", *n as i64)
            } else {
                n.to_string()
            }
        }
        CellValue::Text(t) => t.to_string(),
        CellValue::Bool(b) => (if *b { "TRUE" } else { "FALSE" }).to_string(),
        CellValue::Error(e) => e.as_str().to_string(),
    }
}

impl SheetSession {
    /// The package kind of the open workbook: `"xlsx"` or `"xlsm"` (a
    /// template opened as a workbook reports the workbook kind).
    pub fn workbook_kind(&self) -> String {
        self.doc.kind().extension().to_string()
    }

    /// Whether the workbook carries a VBA project (kept, never run).
    pub fn has_macros(&self) -> bool {
        self.doc.has_vba_project()
    }

    /// Save as the package kind `ext` names (`"xlsx"`, `"xlsm"`, `"xltx"`,
    /// `"xltm"`). Saving a macro-enabled workbook as `.xlsx` (or `.xltx`)
    /// leaves its VBA project out — Excel refuses an `.xlsx` that has one —
    /// and the open workbook keeps it; the same kind is [`Self::save_xlsx`].
    pub fn save_as(&mut self, ext: &str) -> Result<Vec<u8>, SessionError> {
        let kind = WorkbookKind::from_extension(ext)
            .ok_or_else(|| SessionError(format!("unknown workbook kind {ext:?}")))?;
        let bytes = self.save_xlsx()?;
        if kind == self.doc.kind() {
            return Ok(bytes);
        }
        let mut copy = XlsxDocument::open(&bytes).map_err(|e| SessionError(e.to_string()))?;
        copy.set_kind(kind)
            .map_err(|e| SessionError(e.to_string()))?;
        copy.save().map_err(|e| SessionError(e.to_string()))
    }

    /// Import an OpenDocument spreadsheet (`.ods`, `.ots`) as a fresh
    /// workbook: converted to a SpreadsheetML package, then opened like one.
    #[cfg(feature = "ods")]
    pub fn load_ods(bytes: &[u8], now_serial: f64) -> Result<SheetSession, SessionError> {
        let xlsx = sheet_xlsx::ods::ods_to_xlsx(bytes).map_err(|e| SessionError(e.to_string()))?;
        let mut s = SheetSession::load_xlsx_at(&xlsx, now_serial)?;
        // Nothing of the import is saved yet.
        s.structure_changed = true;
        Ok(s)
    }

    /// Export `sheet` (or a range of it) as CSV text — RFC 4180 quoting,
    /// CRLF row ends, every row as wide as the range. Formulas export their
    /// values. A leading BOM when asked (the caller encodes UTF-8).
    pub fn export_csv(&self, sheet: u16, opts: &CsvExportOptions) -> Result<String, SessionError> {
        let delim = match opts.delimiter.as_str() {
            "," | "" => ',',
            ";" => ';',
            "\t" | "tab" | "\\t" => '\t',
            other => {
                return Err(SessionError(format!(
                    "unsupported CSV delimiter {other:?} (use \",\", \";\" or a tab)"
                )))
            }
        };
        let model = self.engine().model();
        let (sheet, top, left, bottom, right) = if opts.range.trim().is_empty() {
            self.validate_sheet(sheet)?;
            let Some(ws) = model.sheet(sheet) else {
                return Ok(String::new());
            };
            let mut extent: Option<(u32, u32)> = None;
            for (&(r, c), cell) in ws.iter_cells() {
                if matches!(cell.value, CellValue::Empty) {
                    continue;
                }
                let (mr, mc) = extent.unwrap_or((0, 0));
                extent = Some((mr.max(r), mc.max(c)));
            }
            match extent {
                None => {
                    return Ok(if opts.bom {
                        "\u{feff}".into()
                    } else {
                        String::new()
                    })
                }
                Some((r, c)) => (sheet, 0, 0, r, c),
            }
        } else {
            let (s, cr) = self.resolve_range(sheet, &opts.range)?;
            (
                s,
                cr.r0.min(cr.r1),
                cr.c0.min(cr.c1),
                cr.r0.max(cr.r1),
                cr.c0.max(cr.c1),
            )
        };
        let mut cache = FormatCache::default();
        let ctx = FormatCtx::new(model.calc.date_system, model.calc.locale);
        let ws = model.sheet(sheet);
        let mut out = String::new();
        if opts.bom {
            out.push('\u{feff}');
        }
        for r in top..=bottom {
            for c in left..=right {
                if c > left {
                    out.push(delim);
                }
                let text = if opts.formatted {
                    cell_display(model, sheet, r, c, &mut cache, &ctx)
                } else {
                    ws.and_then(|ws| ws.cell(r, c))
                        .map(|cell| raw_text(&cell.value))
                        .unwrap_or_default()
                };
                csv_field(&text, delim, &mut out);
            }
            out.push_str("\r\n");
        }
        Ok(out)
    }

    /// The display dialect formulas are shown and typed in.
    fn dialect(&self) -> Dialect {
        Dialect {
            refs: if self.doc.ref_mode_r1c1() {
                RefStyle::R1C1
            } else {
                RefStyle::A1
            },
            lang: self.formula_lang,
        }
    }

    /// The formula display settings.
    pub fn formula_display(&self) -> FormulaDisplay {
        FormulaDisplay {
            r1c1: self.doc.ref_mode_r1c1(),
            lang: self.formula_lang.tag().to_string(),
        }
    }

    /// Set how formulas are shown and typed: R1C1 references (kept in the
    /// workbook, as Excel keeps it) and the function-name language (a host
    /// language tag, `"de-DE"`; languages without a table show English).
    /// Stored formulas stay A1 and English.
    pub fn set_formula_display(&mut self, r1c1: bool, lang_tag: &str) -> Result<(), SessionError> {
        if self.doc.ref_mode_r1c1() != r1c1 {
            self.doc
                .set_ref_mode_r1c1(r1c1)
                .map_err(|e| SessionError(e.to_string()))?;
            self.structure_changed = true;
        }
        self.formula_lang = FormulaLang::from_tag(lang_tag);
        Ok(())
    }

    /// Canonical cell input (`=SUM(A1,1.5)`, as [`Self::get_cell_input`]
    /// gives it) → the display dialect, for the cell at `(row, col)`.
    /// Anything that is not a formula is returned unchanged.
    pub fn formula_to_display(&self, row: u32, col: u32, input: &str) -> String {
        match input.strip_prefix('=') {
            Some(f) => format!("={}", dialect::to_display(f, self.dialect(), row, col)),
            None => input.to_string(),
        }
    }

    /// Display-dialect input (`=SUMME(Z(-1)S;1,5)`) → the canonical input
    /// [`Self::set_cell`] reads, for the cell at `(row, col)`.
    pub fn formula_from_display(&self, row: u32, col: u32, input: &str) -> String {
        match input.strip_prefix('=') {
            Some(f) => format!("={}", dialect::from_display(f, self.dialect(), row, col)),
            None => input.to_string(),
        }
    }

    /// The cell's input as the formula bar shows it: [`Self::get_cell_input`]
    /// in the display dialect.
    pub fn get_cell_edit_text(&self, sheet: u16, row: u32, col: u32) -> String {
        self.formula_to_display(row, col, &self.get_cell_input(sheet, row, col))
    }

    /// Commit display-dialect input: [`Self::formula_from_display`], then
    /// [`Self::set_cell`].
    pub fn set_cell_display(
        &mut self,
        sheet: u16,
        row: u32,
        col: u32,
        input: &str,
    ) -> Result<super::SetCellResult, SessionError> {
        let canonical = self.formula_from_display(row, col, input);
        self.set_cell(sheet, row, col, &canonical)
    }
}

#[cfg(test)]
#[allow(non_snake_case)]
mod tests {
    use super::*;

    #[test]
    fn csv_quoting_follows_rfc4180__feat__sheet_export_csv() {
        let mut s = String::new();
        csv_field("a,b", ',', &mut s);
        s.push(',');
        csv_field("say \"hi\"", ',', &mut s);
        s.push(',');
        csv_field("x\ny", ',', &mut s);
        s.push(',');
        csv_field("a,b", ';', &mut s);
        assert_eq!(s, "\"a,b\",\"say \"\"hi\"\"\",\"x\ny\",a,b");
        assert_eq!(raw_text(&CellValue::Number(1.5)), "1.5");
        assert_eq!(raw_text(&CellValue::Number(46299.0)), "46299");
    }
}

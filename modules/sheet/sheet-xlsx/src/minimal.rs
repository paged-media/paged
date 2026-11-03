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

//! The smallest workbook the engine writes from nothing: one sheet, a
//! styles part, no shared strings. The CSV import (`sheet-js`), the chart
//! data a slide synthesizes for a chart without an embedded workbook
//! (`slide-sheet`) and the ODS import (`ods`) all build their package here,
//! with the same cell addressing and the same inline-string cell, so the
//! three writers are one (W5, capability register).

use paged_ooxml::xml::escape_attr as esc;

/// Column letters for a 0-based index (`0` -> `A`, `26` -> `AA`).
pub fn col_name(mut c: u32) -> String {
    let mut s = Vec::new();
    loop {
        s.push(b'A' + (c % 26) as u8);
        if c < 26 {
            break;
        }
        c = c / 26 - 1;
    }
    s.reverse();
    String::from_utf8(s).expect("ascii")
}

/// The A1 reference of a 0-based `(row, col)`.
pub fn a1(row: u32, col: u32) -> String {
    format!("{}{}", col_name(col), row + 1)
}

/// An inline-string cell (`t="inlineStr"`), optionally with a style index;
/// `text` is escaped here.
pub fn inline_str_cell(a1: &str, xf: Option<u32>, text: &str) -> String {
    let s = match xf {
        Some(xf) => format!(r#" s="{xf}""#),
        None => String::new(),
    };
    format!(
        r#"<c r="{a1}"{s} t="inlineStr"><is><t xml:space="preserve">{}</t></is></c>"#,
        esc(text)
    )
}

/// A package of one sheet. `worksheet_inner` is what sits inside
/// `<worksheet>` (an optional `<dimension>` and the `<sheetData>`),
/// `styles_xml` the whole styles part, `app_xml` an optional
/// `docProps/app.xml` written last.
pub fn package(
    sheet_name: &str,
    styles_xml: &str,
    worksheet_inner: &str,
    app_xml: Option<&str>,
) -> Vec<u8> {
    let mut ct = paged_ooxml::content_types::ContentTypes::new();
    ct.add_default(
        "rels",
        "application/vnd.openxmlformats-package.relationships+xml",
    );
    ct.add_default("xml", "application/xml");
    ct.add_override(
        "/xl/workbook.xml",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
    );
    ct.add_override(
        "/xl/worksheets/sheet1.xml",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml",
    );
    ct.add_override(
        "/xl/styles.xml",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml",
    );
    let mut files: Vec<(&str, String)> = vec![
        ("[Content_Types].xml", ct.render_with_decl_newline()),
        ("_rels/.rels", r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#.to_string()),
        ("xl/workbook.xml", format!(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="{}" sheetId="1" r:id="rId1"/></sheets></workbook>"#, esc(sheet_name))),
        ("xl/_rels/workbook.xml.rels", r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>"#.to_string()),
        ("xl/styles.xml", styles_xml.to_string()),
        ("xl/worksheets/sheet1.xml", format!(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">{worksheet_inner}</worksheet>"#)),
    ];
    if let Some(app) = app_xml {
        files.push(("docProps/app.xml", app.to_string()));
    }
    crate::write::write_package(files.iter().map(|(n, b)| (*n, b.as_bytes())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn columns_are_named_as_excel_names_them() {
        assert_eq!(col_name(0), "A");
        assert_eq!(col_name(25), "Z");
        assert_eq!(col_name(26), "AA");
        assert_eq!(col_name(27), "AB");
        assert_eq!(col_name(701), "ZZ");
        assert_eq!(a1(2, 1), "B3");
    }
}

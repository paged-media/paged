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

//! A workbook made from a chart's cached values, for a chart that has no
//! embedded workbook (or one that cannot be read). It is laid out as
//! PowerPoint lays out the sheet of a chart it inserts: one sheet,
//! `Sheet1`; the categories (or X values) down column A from row 2; one
//! series per column from B, its name in row 1 and its values below. The
//! chart part is then bound to those cells: every series' name, categories
//! and values get a `c:f` naming them, with the caches as they were.

use dml_chart::write::{self as dw, DataOut};
use paged_ooxml::tree::{El, Ns};

const SHEET: &str = "Sheet1";

/// One series' cached values, in file order.
struct Cached {
    name: String,
    categories: Vec<String>,
    numeric_categories: bool,
    values: Vec<Option<f64>>,
    scatter: bool,
}

fn col_name(mut c: u32) -> String {
    let mut s = Vec::new();
    loop {
        s.push(b'A' + (c % 26) as u8);
        if c < 26 {
            break;
        }
        c = c / 26 - 1;
    }
    s.reverse();
    String::from_utf8(s).unwrap_or_default()
}

fn cached(root: &El) -> Vec<Cached> {
    let chart = dml_chart::chart(root, &());
    let mut out = Vec::new();
    let area = root.path(&[(Ns::C, "chart"), (Ns::C, "plotArea")]);
    let elements: Vec<&El> = area
        .map(|a| {
            a.children
                .iter()
                .flat_map(|p| p.children_named(Ns::C, "ser"))
                .collect()
        })
        .unwrap_or_default();
    let series = chart.plots.iter().flat_map(|p| p.series.iter());
    for (s, el) in series.zip(elements) {
        let cat = el.child(Ns::C, "cat").or_else(|| el.child(Ns::C, "xVal"));
        let numeric = cat.is_some_and(|c| {
            c.child(Ns::C, "numRef").is_some() || c.child(Ns::C, "numLit").is_some()
        });
        out.push(Cached {
            name: s.name.clone(),
            categories: s.categories.clone(),
            numeric_categories: numeric && s.categories.iter().all(|c| c.parse::<f64>().is_ok()),
            values: s.values.clone(),
            scatter: el.child(Ns::C, "yVal").is_some(),
        });
    }
    out
}

fn rows(series: &[Cached]) -> usize {
    series
        .iter()
        .map(|s| s.values.len().max(s.categories.len()))
        .max()
        .unwrap_or(0)
}

fn esc(s: &str) -> String {
    dw::esc(s)
}

/// The workbook for a chart part's cached values.
pub fn synthesize_xlsx(chart_xml: &[u8]) -> Result<Vec<u8>, String> {
    let root = paged_ooxml::tree::parse(chart_xml)?;
    let series = cached(&root);
    if series.is_empty() {
        return Err("the chart has no series".into());
    }
    let n = rows(&series);
    let cats = &series[0];
    let mut sheet = String::from("<sheetData>");
    // Row 1: the series names.
    sheet.push_str(r#"<row r="1">"#);
    for (i, s) in series.iter().enumerate() {
        let r = format!("{}1", col_name(1 + i as u32));
        sheet.push_str(&format!(
            r#"<c r="{r}" t="inlineStr"><is><t xml:space="preserve">{}</t></is></c>"#,
            esc(&s.name)
        ));
    }
    sheet.push_str("</row>");
    for p in 0..n {
        let row = p + 2;
        sheet.push_str(&format!(r#"<row r="{row}">"#));
        if let Some(c) = cats.categories.get(p) {
            match c.parse::<f64>() {
                Ok(v) if cats.numeric_categories => {
                    sheet.push_str(&format!(r#"<c r="A{row}"><v>{v}</v></c>"#));
                }
                _ => sheet.push_str(&format!(
                    r#"<c r="A{row}" t="inlineStr"><is><t xml:space="preserve">{}</t></is></c>"#,
                    esc(c)
                )),
            }
        }
        for (i, s) in series.iter().enumerate() {
            if let Some(Some(v)) = s.values.get(p) {
                if v.is_finite() {
                    sheet.push_str(&format!(
                        r#"<c r="{}{row}"><v>{v}</v></c>"#,
                        col_name(1 + i as u32)
                    ));
                }
            }
        }
        sheet.push_str("</row>");
    }
    sheet.push_str("</sheetData>");
    let last = format!("{}{}", col_name(series.len() as u32), n + 1);
    let parts: Vec<(&str, String)> = vec![
        (
            "[Content_Types].xml",
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>"#
                .into(),
        ),
        (
            "_rels/.rels",
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#
                .into(),
        ),
        (
            "xl/workbook.xml",
            format!(
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="{SHEET}" sheetId="1" r:id="rId1"/></sheets></workbook>"#
            ),
        ),
        (
            "xl/_rels/workbook.xml.rels",
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>"#
                .into(),
        ),
        (
            "xl/styles.xml",
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>"#
                .into(),
        ),
        (
            "xl/worksheets/sheet1.xml",
            format!(
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:{last}"/>{sheet}</worksheet>"#
            ),
        ),
    ];
    Ok(sheet_xlsx::write::write_package(
        parts.iter().map(|(n, b)| (*n, b.as_bytes())),
    ))
}

/// The chart part bound to the made workbook's cells.
pub fn bind(chart_xml: &[u8]) -> Result<Vec<u8>, String> {
    let mut root = paged_ooxml::tree::parse(chart_xml)?;
    let series = cached(&root);
    let n = rows(&series);
    let cat_f = format!("{SHEET}!$A$2:$A${}", n + 1);
    let mut i = 0usize;
    let Some(area) = root
        .children
        .iter_mut()
        .find(|c| c.is(Ns::C, "chart"))
        .and_then(|c| c.children.iter_mut().find(|c| c.is(Ns::C, "plotArea")))
    else {
        return Ok(chart_xml.to_vec());
    };
    for plot in &mut area.children {
        for ser in plot.children.iter_mut().filter(|c| c.is(Ns::C, "ser")) {
            let Some(s) = series.get(i) else {
                break;
            };
            let col = col_name(1 + i as u32);
            i += 1;
            let tx = dw::fragment(&format!(
                r#"<c:tx><c:strRef><c:f>{SHEET}!${col}$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>{}</c:v></c:pt></c:strCache></c:strRef></c:tx>"#,
                esc(&s.name)
            ))?;
            dw::put_child(ser, Ns::C, "tx", Some(tx), dw::ORDER_SER);
            let (cat_tag, val_tag) = if s.scatter {
                ("xVal", "yVal")
            } else {
                ("cat", "val")
            };
            let cats = &series[0];
            if !cats.categories.is_empty() {
                let numbers = cats.numeric_categories.then(|| {
                    cats.categories
                        .iter()
                        .map(|c| c.parse::<f64>().ok())
                        .collect()
                });
                let d = DataOut {
                    formula: Some(cat_f.clone()),
                    strings: numbers.is_none().then(|| cats.categories.clone()),
                    numbers,
                    format: None,
                };
                let el = dw::fragment(&dw::data_xml(cat_tag, &d))?;
                dw::put_child(ser, Ns::C, cat_tag, Some(el), dw::ORDER_SER);
            }
            let format = ser
                .child(Ns::C, val_tag)
                .and_then(|v| {
                    v.children
                        .iter()
                        .find_map(|r| r.child(Ns::C, "numCache").or(r.child(Ns::C, "formatCode")))
                })
                .and_then(|c| {
                    if c.local == "formatCode" {
                        Some(c.deep_text())
                    } else {
                        c.child(Ns::C, "formatCode").map(|f| f.deep_text())
                    }
                });
            let mut values = s.values.clone();
            values.resize(n, None);
            let d = DataOut {
                formula: Some(format!("{SHEET}!${col}$2:${col}${}", n + 1)),
                numbers: Some(values),
                strings: None,
                format,
            };
            let el = dw::fragment(&dw::data_xml(val_tag, &d))?;
            dw::put_child(ser, Ns::C, val_tag, Some(el), dw::ORDER_SER);
        }
    }
    dw::ensure_prefixes(&mut root);
    Ok(dw::serialise(chart_xml, &root))
}

/// The made workbook and the chart part bound to it.
pub fn synthesize(chart_xml: &[u8]) -> Result<(Vec<u8>, Vec<u8>), String> {
    Ok((synthesize_xlsx(chart_xml)?, bind(chart_xml)?))
}

#[cfg(test)]
mod tests {
    use super::col_name;

    #[test]
    fn columns_are_named_as_excel_names_them() {
        assert_eq!(col_name(0), "A");
        assert_eq!(col_name(25), "Z");
        assert_eq!(col_name(26), "AA");
        assert_eq!(col_name(701), "ZZ");
        assert_eq!(col_name(702), "AAA");
    }
}

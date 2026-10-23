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

#![allow(non_snake_case)] // `__feat__<id>` test-name links (cockpit rule)

//! Files and dialect (sheet ADR 521), end to end through `SheetSession`:
//! macro-enabled workbooks and templates, the OpenDocument import, the CSV
//! export and the formula display dialect — each read back from the package
//! the writer produces.

use std::collections::BTreeMap;
use std::io::{Read, Write};

use sheet_js::core::files::CsvExportOptions;
use sheet_js::core::SheetSession;

const CT_XLSX: &str = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml";
const CT_XLSM: &str = "application/vnd.ms-excel.sheet.macroEnabled.main+xml";
const CT_XLTX: &str =
    "application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml";
const VBA: &[u8] = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1 not a real VBA project \x00\x01\x02";

fn parts(bytes: &[u8]) -> BTreeMap<String, Vec<u8>> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let mut out = BTreeMap::new();
    for i in 0..zip.len() {
        let mut f = zip.by_index(i).unwrap();
        let mut b = Vec::new();
        f.read_to_end(&mut b).unwrap();
        out.insert(f.name().unwrap().into_owned(), b);
    }
    out
}

fn text(bytes: &[u8], name: &str) -> String {
    String::from_utf8(parts(bytes).remove(name).unwrap_or_default()).unwrap()
}

fn zip_of(files: &[(&str, &[u8])]) -> Vec<u8> {
    let mut buf = Vec::new();
    {
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        for (name, body) in files {
            let opts = zip::write::SimpleFileOptions::default().compression_method(
                if *name == "mimetype" {
                    zip::CompressionMethod::Stored
                } else {
                    zip::CompressionMethod::Deflated
                },
            );
            zip.start_file(*name, opts).unwrap();
            zip.write_all(body).unwrap();
        }
        zip.finish().unwrap();
    }
    buf
}

/// A one-sheet package whose workbook part has content type `ct`; with
/// `vba`, a VBA project part related from the workbook.
fn package(ct: &str, vba: bool) -> Vec<u8> {
    let mut types = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="{ct}"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>"#
    );
    let mut rels = String::from(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>"#,
    );
    if vba {
        types.push_str(
            r#"<Override PartName="/xl/vbaProject.bin" ContentType="application/vnd.ms-office.vbaProject"/>"#,
        );
        rels.push_str(r#"<Relationship Id="rId9" Type="http://schemas.microsoft.com/office/2006/relationships/vbaProject" Target="vbaProject.bin"/>"#);
    }
    types.push_str("</Types>");
    rels.push_str("</Relationships>");
    let mut files: Vec<(&str, Vec<u8>)> = vec![
        ("[Content_Types].xml", types.into_bytes()),
        ("_rels/.rels", br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#.to_vec()),
        ("xl/workbook.xml", br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>"#.to_vec()),
        ("xl/_rels/workbook.xml.rels", rels.into_bytes()),
        ("xl/worksheets/sheet1.xml", br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><v>2</v></c><c r="B1"><f>A1*21</f><v>42</v></c></row></sheetData></worksheet>"#.to_vec()),
    ];
    if vba {
        files.push(("xl/vbaProject.bin", VBA.to_vec()));
    }
    let refs: Vec<(&str, &[u8])> = files.iter().map(|(n, b)| (*n, b.as_slice())).collect();
    zip_of(&refs)
}

#[test]
fn xlsm_keeps_its_macros_byte_for_byte__feat__sheet_xlsx_roundtrip() {
    let mut s = SheetSession::load_xlsx(&package(CT_XLSM, true)).unwrap();
    assert_eq!(s.workbook_kind(), "xlsm");
    assert!(s.has_macros());
    s.set_cell(0, 1, 0, "=B1+1").unwrap();
    let saved = s.save_xlsx().unwrap();
    let p = parts(&saved);
    assert_eq!(p["xl/vbaProject.bin"], VBA, "the VBA project is opaque");
    let types = text(&saved, "[Content_Types].xml");
    assert!(types.contains(CT_XLSM));
    assert!(text(&saved, "xl/_rels/workbook.xml.rels").contains("vbaProject"));
    // Reopened: still macro-enabled, the edit kept.
    let s2 = SheetSession::load_xlsx(&saved).unwrap();
    assert_eq!(s2.workbook_kind(), "xlsm");
    assert_eq!(s2.get_cell_display(0, 1, 0), "43");
}

#[test]
fn xlsm_saved_as_xlsx_leaves_the_vba_project_out__feat__sheet_xlsx_roundtrip() {
    let mut s = SheetSession::load_xlsx(&package(CT_XLSM, true)).unwrap();
    let xlsx = s.save_as("xlsx").unwrap();
    let p = parts(&xlsx);
    assert!(!p.contains_key("xl/vbaProject.bin"));
    let types = text(&xlsx, "[Content_Types].xml");
    assert!(types.contains(CT_XLSX) && !types.contains("vbaProject"));
    assert!(!text(&xlsx, "xl/_rels/workbook.xml.rels").contains("vbaProject"));
    let back = SheetSession::load_xlsx(&xlsx).unwrap();
    assert_eq!(back.workbook_kind(), "xlsx");
    assert_eq!(back.get_cell_display(0, 0, 1), "42");
    // The open workbook still has its macros.
    assert!(s.has_macros());
    assert!(parts(&s.save_as("xlsm").unwrap()).contains_key("xl/vbaProject.bin"));
}

#[test]
fn a_template_opens_as_a_new_workbook__feat__sheet_xlsx_roundtrip() {
    let mut s = SheetSession::load_xlsx(&package(CT_XLTX, false)).unwrap();
    assert_eq!(s.workbook_kind(), "xlsx");
    let saved = s.save_xlsx().unwrap();
    let types = text(&saved, "[Content_Types].xml");
    assert!(types.contains(CT_XLSX) && !types.contains("template"));
    // A macro-enabled template becomes a macro-enabled workbook.
    let xltm = package(
        "application/vnd.ms-excel.template.macroEnabled.main+xml",
        true,
    );
    let mut m = SheetSession::load_xlsx(&xltm).unwrap();
    assert_eq!(m.workbook_kind(), "xlsm");
    let saved = m.save_xlsx().unwrap();
    assert!(text(&saved, "[Content_Types].xml").contains(CT_XLSM));
    assert_eq!(parts(&saved)["xl/vbaProject.bin"], VBA);
}

#[test]
fn csv_export_quotes_formats_and_picks_delimiters__feat__sheet_export_csv() {
    let mut s = SheetSession::new();
    s.set_cell(0, 0, 0, "Name").unwrap();
    s.set_cell(0, 0, 1, "Amount").unwrap();
    s.set_cell(0, 1, 0, "Smith, J.").unwrap();
    s.set_cell(0, 1, 1, "1234.5").unwrap();
    s.set_cell(0, 2, 0, "say \"hi\"").unwrap();
    s.set_cell(0, 2, 1, "=B2*2").unwrap();
    s.set_cell(0, 3, 1, "12%").unwrap();
    let csv = s.export_csv(0, &CsvExportOptions::default()).unwrap();
    assert_eq!(
        csv,
        "Name,Amount\r\n\"Smith, J.\",1234.5\r\n\"say \"\"hi\"\"\",2469\r\n,12%\r\n"
    );
    let raw = s
        .export_csv(
            0,
            &CsvExportOptions {
                delimiter: ";".into(),
                formatted: false,
                bom: true,
                range: "B2:B4".into(),
            },
        )
        .unwrap();
    assert_eq!(raw, "\u{feff}1234.5\r\n2469\r\n0.12\r\n");
    let tab = s
        .export_csv(
            0,
            &CsvExportOptions {
                delimiter: "\t".into(),
                range: "A2:B2".into(),
                ..CsvExportOptions::default()
            },
        )
        .unwrap();
    assert_eq!(tab, "Smith, J.\t1234.5\r\n");
    assert!(s
        .export_csv(
            0,
            &CsvExportOptions {
                delimiter: "|".into(),
                ..CsvExportOptions::default()
            }
        )
        .is_err());
}

#[test]
fn csv_export_round_trips_through_the_csv_import__feat__sheet_export_csv() {
    let mut s = SheetSession::new();
    for (r, row) in [["a", "b,c"], ["1.5", "x\ny"], ["TRUE", "=1/0"]]
        .iter()
        .enumerate()
    {
        for (c, v) in row.iter().enumerate() {
            s.set_cell(0, r as u32, c as u32, v).unwrap();
        }
    }
    let csv = s.export_csv(0, &CsvExportOptions::default()).unwrap();
    let back = SheetSession::load_csv(&csv, None, "en-US", "Sheet1", 0.0).unwrap();
    for r in 0..3 {
        for c in 0..2 {
            assert_eq!(
                back.get_cell_display(0, r, c),
                s.get_cell_display(0, r, c),
                "cell {r},{c}"
            );
        }
    }
}

#[test]
fn r1c1_display_round_trips_and_persists_in_the_workbook__feat__sheet_parser_dialect() {
    let mut s = SheetSession::load_xlsx(&package(CT_XLSX, false)).unwrap();
    assert!(!s.formula_display().r1c1);
    s.set_formula_display(true, "en-US").unwrap();
    // B1 holds `=A1*21`: the cell to its left.
    assert_eq!(s.get_cell_edit_text(0, 0, 1), "=RC[-1]*21");
    s.set_cell_display(0, 2, 2, "=SUM(R1C1:R[-2]C[-1])")
        .unwrap();
    assert_eq!(s.get_cell_input(0, 2, 2), "=SUM($A$1:B1)");
    assert_eq!(s.get_cell_display(0, 2, 2), "44");
    let saved = s.save_xlsx().unwrap();
    assert!(text(&saved, "xl/workbook.xml").contains(r#"refMode="R1C1""#));
    // Stored formulas stay A1.
    assert!(text(&saved, "xl/worksheets/sheet1.xml").contains("<f>SUM($A$1:B1)</f>"));
    let mut back = SheetSession::load_xlsx(&saved).unwrap();
    assert!(back.formula_display().r1c1);
    back.set_formula_display(false, "en").unwrap();
    let a1 = back.save_xlsx().unwrap();
    assert!(!text(&a1, "xl/workbook.xml").contains("refMode"));
}

#[test]
fn german_display_names_and_separators__feat__sheet_parser_dialect() {
    let mut s = SheetSession::new();
    s.set_formula_display(false, "de-DE").unwrap();
    s.set_cell(0, 0, 0, "2").unwrap();
    s.set_cell_display(0, 0, 1, "=WENN(A1>1,5;SUMME(A1;0,5);\"nein\")")
        .unwrap();
    assert_eq!(
        s.get_cell_input(0, 0, 1),
        "=IF(A1>1.5,SUM(A1,0.5),\"nein\")"
    );
    assert_eq!(s.get_cell_display(0, 0, 1), "2.5");
    assert_eq!(
        s.get_cell_edit_text(0, 0, 1),
        "=WENN(A1>1,5;SUMME(A1;0,5);\"nein\")"
    );
    // German R1C1 is Z1S1.
    s.set_formula_display(true, "de").unwrap();
    assert_eq!(
        s.get_cell_edit_text(0, 0, 1),
        "=WENN(ZS(-1)>1,5;SUMME(ZS(-1);0,5);\"nein\")"
    );
    // A value is not a formula: unchanged.
    assert_eq!(s.formula_from_display(0, 0, "1,5"), "1,5");
}

/// A small OpenDocument spreadsheet: two tables, values of every type,
/// formulas, styles, a merge and a repeated run.
fn ods() -> Vec<u8> {
    let content = r##"<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:number="urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:of="urn:oasis:names:tc:opendocument:xmlns:of:1.2" office:version="1.3">
<office:automatic-styles>
<number:number-style style:name="N2"><number:number number:decimal-places="2" number:min-integer-digits="1" number:grouping="true"/></number:number-style>
<number:date-style style:name="D1"><number:year number:style="long"/><number:text>-</number:text><number:month number:style="long"/><number:text>-</number:text><number:day number:style="long"/></number:date-style>
<number:percentage-style style:name="P0"><number:number number:decimal-places="0" number:min-integer-digits="1"/><number:text>%</number:text></number:percentage-style>
<style:style style:name="ce1" style:family="table-cell" style:parent-style-name="Default"><style:text-properties fo:font-weight="bold" fo:font-style="italic"/><style:table-cell-properties fo:background-color="#ffff00"/></style:style>
<style:style style:name="ce2" style:family="table-cell" style:data-style-name="N2"/>
<style:style style:name="ce3" style:family="table-cell" style:data-style-name="D1"/>
<style:style style:name="ce4" style:family="table-cell" style:data-style-name="P0"/>
<style:style style:name="ta2" style:family="table"><style:table-properties table:display="false"/></style:style>
</office:automatic-styles>
<office:body><office:spreadsheet>
<table:named-expressions><table:named-range table:name="Amounts" table:cell-range-address="$Data.$B$2:.$B$3"/></table:named-expressions>
<table:table table:name="Data">
<table:table-column table:number-columns-repeated="3"/>
<table:table-row>
<table:table-cell table:style-name="ce1" office:value-type="string" table:number-columns-spanned="2"><text:p>Report</text:p></table:table-cell>
<table:covered-table-cell/>
<table:table-cell office:value-type="boolean" office:boolean-value="true"><text:p>TRUE</text:p></table:table-cell>
</table:table-row>
<table:table-row>
<table:table-cell office:value-type="string"><text:p>a<text:s text:c="2"/>b</text:p><text:p>second</text:p><office:annotation><text:p>a note</text:p></office:annotation></table:table-cell>
<table:table-cell table:style-name="ce2" office:value-type="float" office:value="1234.5"><text:p>1,234.50</text:p></table:table-cell>
<table:table-cell table:style-name="ce3" office:value-type="date" office:date-value="2026-10-04"><text:p>2026-10-04</text:p></table:table-cell>
</table:table-row>
<table:table-row>
<table:table-cell office:value-type="time" office:time-value="PT12H30M00S"><text:p>12:30</text:p></table:table-cell>
<table:table-cell table:style-name="ce4" office:value-type="percentage" office:value="0.25"><text:p>25%</text:p></table:table-cell>
<table:table-cell table:formula="of:=SUM([.B2:.B3])*2" office:value-type="float" office:value="2469.5"><text:p>2469.5</text:p></table:table-cell>
</table:table-row>
<table:table-row table:number-rows-repeated="2">
<table:table-cell office:value-type="float" office:value="7" table:number-columns-repeated="2"><text:p>7</text:p></table:table-cell>
<table:table-cell/>
</table:table-row>
<table:table-row table:number-rows-repeated="1048570"><table:table-cell table:number-columns-repeated="1024"/></table:table-row>
</table:table>
<table:table table:name="Calc">
<table:table-row>
<table:table-cell table:formula="of:=[Data.B2]+SUM(Amounts)" office:value-type="float" office:value="2469"><text:p>2469</text:p></table:table-cell>
<table:table-cell table:formula="of:=ORG.OPENOFFICE.STYLE(&quot;x&quot;)" office:value-type="float" office:value="0"><text:p>0</text:p></table:table-cell>
<table:table-cell table:formula="of:=IF([.A1]&gt;1;&quot;big&quot;;&quot;small&quot;)" office:value-type="string" office:string-value="big"><text:p>big</text:p></table:table-cell>
</table:table-row>
</table:table>
<table:table table:name="Hidden" table:style-name="ta2"><table:table-row><table:table-cell office:value-type="float" office:value="1"><text:p>1</text:p></table:table-cell></table:table-row></table:table>
</office:spreadsheet></office:body></office:document-content>"##;
    zip_of(&[
        ("mimetype", b"application/vnd.oasis.opendocument.spreadsheet"),
        ("content.xml", content.as_bytes()),
        (
            "META-INF/manifest.xml",
            br#"<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>"#,
        ),
    ])
}

#[test]
fn ods_values_formulas_styles_and_merges__feat__sheet_import_ods() {
    let mut s = SheetSession::load_ods(&ods(), 0.0).unwrap();
    let sheets = s.list_sheets();
    let names: Vec<&str> = sheets.iter().map(|i| i.name.as_str()).collect();
    assert_eq!(names, ["Data", "Calc", "Hidden"]);
    // Values, through their number formats.
    assert_eq!(s.get_cell_display(0, 0, 0), "Report");
    assert_eq!(s.get_cell_display(0, 0, 2), "TRUE");
    assert_eq!(s.get_cell_display(0, 1, 0), "a  b\nsecond");
    assert_eq!(s.get_cell_display(0, 1, 1), "1,234.50");
    assert_eq!(s.get_cell_display(0, 1, 2), "2026-10-04");
    assert_eq!(s.get_cell_input(0, 1, 2), "46299");
    assert_eq!(s.get_cell_input(0, 2, 0), "0.5208333333333334");
    assert_eq!(s.get_cell_display(0, 2, 1), "25%");
    // A formula, translated and recalculated.
    assert_eq!(s.get_cell_input(0, 2, 2), "=SUM(B2:B3)*2");
    assert_eq!(s.get_cell_display(0, 2, 2), "2469.5");
    // Repeated rows and columns expand where they hold something.
    for r in 3..5 {
        assert_eq!(s.get_cell_display(0, r, 0), "7");
        assert_eq!(s.get_cell_display(0, r, 1), "7");
    }
    assert_eq!(s.get_cell_display(0, 5, 0), "");
    // Cross-sheet references and named ranges.
    assert_eq!(s.get_cell_input(1, 0, 0), "=Data!B2+SUM(Amounts)");
    assert_eq!(s.get_cell_display(1, 0, 0), "2469.25");
    // A function only the other application knows keeps its cached value.
    assert_eq!(s.get_cell_display(1, 0, 1), "0");
    assert_eq!(s.get_cell_display(1, 0, 2), "big");
    // The saved package carries the merge, the hidden sheet and the styles.
    let saved = s.save_xlsx().unwrap();
    let data = text(&saved, "xl/worksheets/sheet1.xml");
    assert!(data.contains(r#"<mergeCell ref="A1:B1"/>"#), "{data}");
    let wb = text(&saved, "xl/workbook.xml");
    assert!(
        wb.contains(r#"name="Hidden" sheetId="3" state="hidden""#),
        "{wb}"
    );
    let styles = text(&saved, "xl/styles.xml");
    assert!(styles.contains("<b/><i/>") && styles.contains(r#"rgb="FFFFFF00""#));
    assert!(styles.contains(r##"formatCode="#,##0.00""##));
}

#[test]
fn a_package_that_is_not_ods_is_refused__feat__sheet_import_ods() {
    let other = zip_of(&[
        ("mimetype", b"application/vnd.oasis.opendocument.text"),
        ("content.xml", b"<office:document-content/>"),
    ]);
    assert!(SheetSession::load_ods(&other, 0.0).is_err());
    assert!(SheetSession::load_ods(b"not a zip", 0.0).is_err());
}

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
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

#![allow(non_snake_case)]

//! The Excel OPEN-CHECK lane: Excel opens what Paged saves after an edit
//! without a repair prompt, and keeps what it holds.
//!
//! Three steps, the middle one a maintainer's (macOS + Excel; respect the
//! Excel lock of the oracle README):
//!
//! ```text
//! PAGED_ORACLE_BUILD=<dir> cargo nextest run -p sheet-conformance \
//!     --run-ignored only excel_opencheck::write_the_paged_files
//! PAGED_ORACLE_BUILD=<dir> PAGED_ORACLE_SCRIPT=opencheck.applescript \
//!     sheet-conformance/oracle/excel/drive.sh
//! PAGED_ORACLE_BUILD=<dir> cargo nextest run -p sheet-conformance \
//!     --run-ignored only excel_opencheck::record_what_excel_made_of_them
//! ```
//!
//! The recording (`oracle/excel/recorded/opencheck.tsv`) is committed; CI
//! replays it here: every Paged-written case opened, unrepaired, with the
//! conditional formats, validations, tables, notes and cell values it was
//! saved with. A deliberately broken control file proves the lane sees a
//! repair. (Excel scripted with alerts off answers a file it would repair
//! with error -50 instead of a prompt; three generated fixtures — 05, 11,
//! 13 — are refused by Excel as generated, so the cases made from them are
//! recorded but not gated.)

use std::path::PathBuf;

use sheet_js::core::{SheetSession, StructuralEdit};

fn corpus(name: &str) -> Vec<u8> {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../corpus/xlsx-corpus")
        .join(name);
    std::fs::read(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()))
}

fn build_dir() -> PathBuf {
    std::env::var_os("PAGED_ORACLE_BUILD")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("oracle/excel/build/opencheck")
        })
}

fn recorded() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("oracle/excel/recorded/opencheck.tsv")
}

/// One edit scenario: the fixture and what is done to it before the save.
type Step = fn(&mut SheetSession);

fn scenarios() -> Vec<(&'static str, &'static str, Step)> {
    let mut v: Vec<(&'static str, &'static str, Step)> = vec![
        ("saveloss-edit", "15-saveloss.xlsx", |s| {
            s.set_cell(0, 3, 0, "edited").unwrap();
            s.set_cell(0, 0, 2, "6").unwrap();
        }),
        ("saveloss-structure", "15-saveloss.xlsx", |s| {
            s.structural_edit(0, StructuralEdit::InsertRows, 1, 2)
                .unwrap();
            s.structural_edit(0, StructuralEdit::InsertCols, 0, 1)
                .unwrap();
        }),
        ("structure-edit", "16-structure.xlsx", |s| {
            s.set_cell(0, 1, 1, "13").unwrap();
        }),
        ("structure-insert-rows", "16-structure.xlsx", |s| {
            s.structural_edit(0, StructuralEdit::InsertRows, 1, 2)
                .unwrap();
        }),
        ("structure-table-column", "16-structure.xlsx", |s| {
            s.structural_edit(0, StructuralEdit::InsertCols, 8, 1)
                .unwrap();
        }),
        ("structure-delete-column", "16-structure.xlsx", |s| {
            s.structural_edit(0, StructuralEdit::DeleteCols, 1, 1)
                .unwrap();
        }),
        ("structure-delete-table", "16-structure.xlsx", |s| {
            s.structural_edit(0, StructuralEdit::DeleteCols, 7, 3)
                .unwrap();
        }),
        ("structure-delete-rows", "16-structure.xlsx", |s| {
            s.structural_edit(0, StructuralEdit::DeleteRows, 2, 2)
                .unwrap();
        }),
    ];
    // W2.6–W2.8 and ADR 517: what Paged authors, Excel must open unrepaired.
    v.push(("w2-table-create", "01-minimal.xlsx", |s| {
        fill_sales(s);
        s.set_cell(0, 9, 3, "Total").unwrap();
        s.create_table(0, "A10:D14", true, Some("TableStyleMedium9"), Some("Sales"))
            .unwrap();
        s.set_calculated_column("Sales", "Total", Some("=[@Units]*[@Price]"))
            .unwrap();
        s.set_table_totals("Sales", true).unwrap();
        s.set_totals_function("Sales", "Units", "average", None)
            .unwrap();
        s.set_table_style(
            "Sales",
            sheet_js::core::tables::TableStyleArg {
                banded_columns: Some(true),
                first_column: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
    }));
    v.push(("w2-table-edit", "07-tables.xlsx", |s| {
        let t = s.list_table_details()[0].clone();
        s.rename_table(&t.name, "Renamed").unwrap();
        s.set_table_totals("Renamed", !t.totals_row).unwrap();
    }));
    v.push(("w2-validation", "01-minimal.xlsx", |s| {
        use sheet_js::core::validation::ValidationRuleArg;
        s.set_validation(
            0,
            "D2:D9",
            ValidationRuleArg {
                kind: "list".into(),
                list_items: Some(vec!["Yes".into(), "No".into()]),
                prompt_title: Some("Pick".into()),
                prompt: Some("Yes or no".into()),
                ..Default::default()
            },
        )
        .unwrap();
        s.set_validation(
            0,
            "E2:E9",
            ValidationRuleArg {
                kind: "whole".into(),
                operator: Some("between".into()),
                formula1: Some("1".into()),
                formula2: Some("=$A$1+10".into()),
                error_style: Some("warning".into()),
                error_title: Some("Range".into()),
                error: Some("1 to A1+10".into()),
                ..Default::default()
            },
        )
        .unwrap();
        s.set_validation(
            0,
            "F2",
            ValidationRuleArg {
                kind: "custom".into(),
                formula1: Some("=ISNUMBER(F2)".into()),
                ..Default::default()
            },
        )
        .unwrap();
    }));
    v.push(("w2-validation-edit", "12-datavalidation.xlsx", |s| {
        use sheet_js::core::validation::ValidationRuleArg;
        s.update_validation(
            0,
            0,
            ValidationRuleArg {
                error_style: Some("information".into()),
                prompt: Some("edited".into()),
                ..Default::default()
            },
        )
        .unwrap();
        s.clear_validation(0, "Z1:Z5").unwrap();
    }));
    v.push(("w2-protection", "01-minimal.xlsx", |s| {
        s.set_style(
            0,
            "B2:B4",
            sheet_js::core::StylePatchArg {
                locked: Some(false),
                formula_hidden: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
        s.protect_sheet(
            0,
            sheet_js::core::protect::ProtectOptions {
                password: Some("pw".into()),
                format_rows: Some(true),
                sort: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
        s.protect_workbook("book", true, false).unwrap();
    }));
    v.push(("w2-sort-filter", "01-minimal.xlsx", |s| {
        use sheet_js::core::filter::{ConditionArg, CriterionArg};
        use sheet_js::core::sort::{SortKeyArg, SortSpec};
        fill_sales(s);
        s.set_style(
            0,
            "A12",
            sheet_js::core::StylePatchArg {
                fill: Some("#FFC000".into()),
                ..Default::default()
            },
        )
        .unwrap();
        s.set_autofilter(0, "A10:C14").unwrap();
        s.sort_range_by(
            0,
            "A10:C14",
            SortSpec {
                keys: vec![
                    SortKeyArg {
                        index: 0,
                        sort_by: Some("cellColor".into()),
                        color: Some("#FFC000".into()),
                        ..Default::default()
                    },
                    SortKeyArg {
                        index: 1,
                        descending: true,
                        ..Default::default()
                    },
                ],
                has_header: true,
                ..Default::default()
            },
        )
        .unwrap();
        s.set_filter_column(
            0,
            "A10:C14",
            1,
            Some(CriterionArg::Custom {
                and: true,
                conditions: vec![
                    ConditionArg {
                        op: "greaterThan".into(),
                        val: "1".into(),
                    },
                    ConditionArg {
                        op: "lessThan".into(),
                        val: "100".into(),
                    },
                ],
            }),
        )
        .unwrap();
        s.set_filter_column(
            0,
            "A10:C14",
            2,
            Some(CriterionArg::Top {
                n: 3.0,
                percent: false,
                top: true,
            }),
        )
        .unwrap();
        s.set_filter_column(
            0,
            "A10:C14",
            0,
            Some(CriterionArg::Dynamic {
                dynamic: "aboveAverage".into(),
            }),
        )
        .unwrap();
        s.set_filter_column(0, "A10:C14", 0, None).unwrap();
    }));
    v.push(("w2-outline", "01-minimal.xlsx", |s| {
        use sheet_js::core::outline::Axis;
        fill_sales(s);
        s.group(0, Axis::Rows, 11, 13).unwrap();
        s.set_group_collapsed(0, Axis::Rows, 12, true).unwrap();
        s.group(0, Axis::Cols, 1, 2).unwrap();
        s.set_hidden(0, Axis::Cols, 6, 6, true).unwrap();
        s.add_sheet("Hidden").unwrap();
        s.set_cell(1, 0, 0, "x").unwrap();
        s.set_sheet_state(1, "hidden").unwrap();
    }));
    for f in [
        "01-minimal.xlsx",
        "02-formulas.xlsx",
        "03-styles.xlsx",
        "05-unknown-subtrees.xlsx",
        "06-multisheet-1904.xlsx",
        "07-tables.xlsx",
        "08-condfmt.xlsx",
        "11-freeze.xlsx",
        "12-datavalidation.xlsx",
        "13-comments.xlsx",
        "14-textstyles.xlsx",
    ] {
        v.push((f.trim_end_matches(".xlsx"), f, |s| {
            let row = s.model().sheets[0].used_range().map_or(0, |u| u.row1 + 2);
            s.set_cell(0, row, 0, "edited").unwrap();
            s.structural_edit(0, StructuralEdit::InsertRows, 0, 1)
                .unwrap();
        }));
    }
    v
}

/// A small table of sales at A10:C14 (header first).
fn fill_sales(s: &mut SheetSession) {
    let rows = [
        ["Region", "Units", "Price"],
        ["West", "5", "2"],
        ["East", "9", "3"],
        ["North", "7", "4"],
        ["South", "2", "8"],
    ];
    for (r, row) in rows.iter().enumerate() {
        for (c, v) in row.iter().enumerate() {
            s.set_cell(0, 9 + r as u32, c as u32, v).unwrap();
        }
    }
}

/// A package Excel must repair: rows out of order.
fn broken_control() -> Vec<u8> {
    let mut s = SheetSession::load_xlsx(&corpus("01-minimal.xlsx")).unwrap();
    s.set_cell(0, 5, 0, "x").unwrap();
    let out = s.save_xlsx().unwrap();
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(&out)).unwrap();
    let mut parts = Vec::new();
    for i in 0..z.len() {
        let mut f = z.by_index(i).unwrap();
        let name = f.name().unwrap().to_string();
        let mut data = Vec::new();
        std::io::Read::read_to_end(&mut f, &mut data).unwrap();
        if name == "xl/worksheets/sheet1.xml" {
            let x = String::from_utf8(data).unwrap();
            let x = x.replace(
                "<sheetData>",
                r#"<sheetData><row r="9"><c r="A9"><v>1</v></c></row>"#,
            );
            data = x.into_bytes();
        }
        parts.push((name, data));
    }
    sheet_xlsx::write::write_package(parts.iter().map(|(n, d)| (n.as_str(), d.as_slice())))
}

#[test]
#[ignore = "maintainer: writes the open-check lane's Paged files"]
fn write_the_paged_files() {
    let dir = build_dir();
    std::fs::create_dir_all(&dir).unwrap();
    for (name, fixture, step) in scenarios() {
        let mut s = SheetSession::load_xlsx(&corpus(fixture)).unwrap();
        step(&mut s);
        std::fs::write(dir.join(format!("{name}.xlsx")), s.save_xlsx().unwrap()).unwrap();
        // The fixture as generated, for a baseline.
        std::fs::write(dir.join(format!("orig-{fixture}")), corpus(fixture)).unwrap();
    }
    std::fs::write(dir.join("control-broken.xlsx"), broken_control()).unwrap();
}

/// What a package holds, read through Paged's own reader.
fn inventory(bytes: &[u8]) -> String {
    let doc = sheet_xlsx::XlsxDocument::open(bytes).expect("Paged reads it");
    let s = SheetSession::load_xlsx(bytes).expect("Paged loads it");
    let sheets = s.list_sheets();
    let mut cf = 0;
    let mut dv = 0;
    let mut notes = 0;
    let mut tables = 0;
    for i in 0..sheets.len() as u16 {
        cf += doc
            .conditional_formats
            .get(&i)
            .map_or(0, |c| c.blocks.len());
        dv += doc.data_validations_of(i).map_or(0, |d| d.rules.len());
        notes += doc.comments_of(i).map_or(0, |c| c.comments.len());
        tables += s.model().sheets[i as usize].tables.len();
    }
    // Every non-empty cell value of every sheet, as displayed.
    let mut cells = 0usize;
    let mut digest = 0u64;
    for (si, ws) in s.model().sheets.iter().enumerate() {
        for (&(r, c), _) in ws.iter_cells() {
            let d = s.get_cell_display(si as u16, r, c);
            if d.is_empty() {
                continue;
            }
            cells += 1;
            for b in format!("{si}:{r}:{c}={d}").bytes() {
                digest = digest.wrapping_mul(1_000_003).wrapping_add(u64::from(b));
            }
        }
    }
    // ADR 517: protection, filters, outline and hidden tracks and sheets.
    let mut prot = 0;
    let mut af = 0;
    let mut hidden = 0;
    for i in 0..sheets.len() as u16 {
        prot += usize::from(doc.sheet_protection(i).is_some_and(|p| p.on));
        af += usize::from(doc.ws_child(i, "autoFilter").is_some());
        let o = s.outline(i).unwrap();
        hidden += o.hidden_rows.len() + o.hidden_cols.len() + o.rows.len() + o.cols.len();
    }
    let wbp = usize::from(doc.workbook_protection().is_some_and(|w| w.lock_structure));
    let states: String = sheets.iter().map(|x| &x.state[..1]).collect();
    format!(
        "cf={cf} dv={dv} tables={tables} notes={notes} cells={cells} digest={digest:016x} prot={prot} wbp={wbp} af={af} outline={hidden} states={states}"
    )
}

#[test]
#[ignore = "maintainer: records the open-check lane after drive.sh"]
fn record_what_excel_made_of_them() {
    let dir = build_dir();
    let mut rows = vec!["case\topened\trepaired\tbaseline\tpaged\texcel".to_string()];
    // Whether Excel opened the fixture a case was made from, as generated.
    let baseline = |case: &str| -> &'static str {
        let fixture = scenarios()
            .iter()
            .find(|(n, _, _)| *n == case)
            .map(|(_, f, _)| f.trim_end_matches(".xlsx").to_string())
            .unwrap_or_else(|| case.to_string());
        let meta =
            std::fs::read_to_string(dir.join(format!("orig-{fixture}.meta"))).unwrap_or_default();
        if meta.contains(" OK name=") {
            "opens"
        } else {
            "refused"
        }
    };
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".xlsx") && !n.ends_with(".excel.xlsx"))
        .collect();
    names.sort();
    for n in names {
        let case = n.trim_end_matches(".xlsx");
        let paged = std::fs::read(dir.join(&n)).unwrap();
        let meta = std::fs::read_to_string(dir.join(format!("{case}.meta"))).unwrap_or_default();
        let excel = std::fs::read(dir.join(format!("{case}.excel.xlsx"))).ok();
        let opened = meta.contains(" OK name=");
        let repaired = !opened || meta.contains("Repaired") || meta.contains("repaired");
        let paged_inv = if case == "control-broken" {
            "-".to_string()
        } else {
            inventory(&paged)
        };
        let excel_inv = match &excel {
            Some(b) if case != "control-broken" => inventory(b),
            Some(_) => "-".to_string(),
            None => "-".to_string(),
        };
        let base = if case.starts_with("orig-") || case == "control-broken" {
            "-"
        } else {
            baseline(case)
        };
        rows.push(format!(
            "{case}\t{}\t{}\t{base}\t{paged_inv}\t{excel_inv}",
            if opened { "yes" } else { "no" },
            if repaired { "yes" } else { "no" }
        ));
    }
    std::fs::write(recorded(), rows.join("\n") + "\n").unwrap();
}

/// CI: the recording says Excel opened every Paged-written file without a
/// repair and kept what Paged wrote; the broken control was caught.
#[test]
fn excel_opens_what_paged_saves_without_repair__feat__sheet_calc_rewrite_structural_door() {
    let text = std::fs::read_to_string(recorded()).expect("recorded/opencheck.tsv");
    let mut paged_cases = 0;
    let mut control = false;
    for line in text.lines().skip(1) {
        let f: Vec<&str> = line.split('\t').collect();
        let (case, opened, repaired, base, paged, excel) = (f[0], f[1], f[2], f[3], f[4], f[5]);
        if case == "control-broken" {
            assert_eq!(repaired, "yes", "the lane must see Excel's repair");
            control = true;
            continue;
        }
        if case.starts_with("orig-") || base == "refused" {
            // A fixture as generated is a baseline, not a gate; and a case
            // made from a fixture Excel already refuses proves nothing.
            continue;
        }
        paged_cases += 1;
        assert_eq!((opened, repaired), ("yes", "no"), "{case}: {line}");
        // Excel's re-save keeps the content: the same conditional formats,
        // validations, tables and notes, and every cell showing the same.
        assert_eq!(paged, excel, "{case}");
    }
    assert!(control, "the broken control was not recorded");
    assert!(paged_cases >= 23, "{paged_cases} cases");
}

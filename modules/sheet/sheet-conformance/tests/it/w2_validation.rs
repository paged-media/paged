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

//! Data validation interpreted (sheet ADR 517): entries checked against
//! every Excel rule kind, alerts by style, list items, circle invalid data,
//! authoring with the cells leaving older rules, and the round trip.

#![allow(non_snake_case)]

use sheet_js::core::validation::ValidationRuleArg;
use sheet_js::core::SheetSession;
use std::io::Read;
use std::path::PathBuf;

fn read_part(bytes: &[u8], name: &str) -> String {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).expect("valid zip");
    let mut f = zip.by_name(name).unwrap_or_else(|_| panic!("part {name}"));
    let mut data = String::new();
    f.read_to_string(&mut data).unwrap();
    data
}

fn rule(kind: &str, op: Option<&str>, f1: &str, f2: Option<&str>) -> ValidationRuleArg {
    ValidationRuleArg {
        kind: kind.into(),
        operator: op.map(Into::into),
        formula1: Some(f1.into()),
        formula2: f2.map(Into::into),
        ..Default::default()
    }
}

#[test]
fn whole_number_between_stops_bad_entries__feat__sheet_validation_enforce() {
    let mut s = SheetSession::new();
    s.set_validation(0, "A1:A5", rule("whole", None, "1", Some("10")))
        .unwrap();
    assert!(s.enter_cell(0, 0, 0, "5", false).unwrap().applied);
    let r = s.enter_cell(0, 1, 0, "11", false).unwrap();
    assert!(!r.applied);
    let a = r.alert.unwrap();
    assert_eq!(a.style, "stop");
    assert!(a.message.contains("data validation restrictions"));
    // A stop cannot be confirmed through.
    assert!(!s.enter_cell(0, 1, 0, "11", true).unwrap().applied);
    assert!(!s.enter_cell(0, 1, 0, "2.5", false).unwrap().applied);
    assert!(!s.enter_cell(0, 1, 0, "abc", false).unwrap().applied);
    // A blank passes (allowBlank is on by default); outside the range anything goes.
    assert!(s.enter_cell(0, 2, 0, "", false).unwrap().applied);
    assert!(s.enter_cell(0, 9, 0, "99", false).unwrap().applied);
    assert_eq!(s.get_cell_display(0, 1, 0), "");
}

#[test]
fn warning_and_information_ask_first__feat__sheet_validation_enforce() {
    let mut s = SheetSession::new();
    let mut r = rule("decimal", Some("lessThan"), "100", None);
    r.error_style = Some("warning".into());
    r.error_title = Some("Too big".into());
    r.error = Some("Under 100, please".into());
    s.set_validation(0, "B1", r).unwrap();
    let first = s.enter_cell(0, 0, 1, "150", false).unwrap();
    assert!(!first.applied);
    let a = first.alert.unwrap();
    assert_eq!((a.style, a.title.as_str()), ("warning", "Too big"));
    assert!(s.enter_cell(0, 0, 1, "150", true).unwrap().applied);
    assert_eq!(s.get_cell_display(0, 0, 1), "150");
    // check_entry is a pure question.
    assert!(!s.check_entry(0, 0, 1, "200").unwrap().valid);
    assert!(s.check_entry(0, 0, 1, "99.5").unwrap().valid);
}

#[test]
fn list_rules_inline_and_from_a_range__feat__sheet_validation_list() {
    let mut s = SheetSession::new();
    s.set_validation(
        0,
        "C1:C9",
        ValidationRuleArg {
            kind: "list".into(),
            list_items: Some(vec!["Yes".into(), "No".into()]),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(s.enter_cell(0, 0, 2, "yes", false).unwrap().applied);
    assert!(!s.enter_cell(0, 1, 2, "Maybe", false).unwrap().applied);
    let v = s.validation_at(0, 4, 2).unwrap().unwrap();
    assert_eq!(v.list_items.unwrap(), vec!["Yes", "No"]);
    assert_eq!(v.rule.formula1.as_deref(), Some("=\"Yes,No\""));

    // A dynamic range: OFFSET over the filled part of column E.
    for (i, t) in ["red", "green", "blue"].iter().enumerate() {
        s.set_cell(0, i as u32, 4, t).unwrap();
    }
    s.set_cell(0, 3, 4, "7").unwrap();
    s.set_validation(
        0,
        "D1:D3",
        rule("list", None, "=OFFSET($E$1,0,0,COUNTA($E:$E),1)", None),
    )
    .unwrap();
    let items = s
        .validation_at(0, 0, 3)
        .unwrap()
        .unwrap()
        .list_items
        .unwrap();
    assert_eq!(items, vec!["red", "green", "blue", "7"]);
    assert!(s.enter_cell(0, 0, 3, "Green", false).unwrap().applied);
    assert!(s.enter_cell(0, 1, 3, "7", false).unwrap().applied);
    assert!(!s.enter_cell(0, 2, 3, "pink", false).unwrap().applied);
    s.set_cell(0, 4, 4, "pink").unwrap();
    assert!(s.enter_cell(0, 2, 3, "pink", false).unwrap().applied);
}

#[test]
fn custom_text_length_and_date_rules__feat__sheet_validation_enforce() {
    let mut s = SheetSession::new();
    // Relative to the range's top-left: A2 reads ISEVEN(A2).
    s.set_validation(0, "A1:A3", rule("custom", None, "=ISEVEN(A1)", None))
        .unwrap();
    assert!(s.enter_cell(0, 1, 0, "4", false).unwrap().applied);
    assert!(!s.enter_cell(0, 2, 0, "3", false).unwrap().applied);
    // The refused entry left the old value in place.
    assert_eq!(s.get_cell_display(0, 2, 0), "");
    assert_eq!(s.get_cell_display(0, 1, 0), "4");

    s.set_validation(
        0,
        "B1",
        rule("textLength", Some("lessThanOrEqual"), "3", None),
    )
    .unwrap();
    assert!(s.enter_cell(0, 0, 1, "abc", false).unwrap().applied);
    assert!(!s.enter_cell(0, 0, 1, "abcd", false).unwrap().applied);

    s.set_validation(
        0,
        "C1",
        rule("date", Some("greaterThan"), "=DATE(2026,1,1)", None),
    )
    .unwrap();
    assert!(s.enter_cell(0, 0, 2, "2026-03-01", false).unwrap().applied);
    assert!(!s.enter_cell(0, 0, 2, "2025-12-31", false).unwrap().applied);
}

#[test]
fn circle_invalid_data__feat__sheet_validation_invalid() {
    let mut s = SheetSession::new();
    for r in 0..5 {
        s.set_cell(0, r, 0, &format!("{}", r * 5)).unwrap();
    }
    s.set_validation(0, "A1:A5", rule("whole", Some("lessThan"), "12", None))
        .unwrap();
    let bad: Vec<u32> = s.invalid_cells(0).unwrap().iter().map(|c| c.row).collect();
    assert_eq!(bad, vec![3, 4]);
}

#[test]
fn authoring_moves_cells_between_rules_and_round_trips__feat__sheet_validation_author() {
    let mut s = SheetSession::new();
    s.set_cell(0, 0, 0, "x").unwrap();
    s.set_validation(0, "A1:A10", rule("whole", None, "1", Some("5")))
        .unwrap();
    let mut r = rule("list", None, "\"a,b\"", None);
    r.prompt_title = Some("Pick".into());
    r.prompt = Some("a or b".into());
    let rules = s.set_validation(0, "A4:A5", r).unwrap();
    assert_eq!(rules.len(), 2);
    assert_eq!(rules[0].sqref, "A1:A3 A6:A10");
    assert_eq!(rules[1].sqref, "A4:A5");
    let rules = s
        .update_validation(
            0,
            0,
            ValidationRuleArg {
                operator: Some("notBetween".into()),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(rules[0].operator, "notBetween");
    assert_eq!(rules[0].formula2.as_deref(), Some("=5"));

    let bytes = s.save_xlsx().unwrap();
    let ws = read_part(&bytes, "xl/worksheets/sheet1.xml");
    assert!(ws.contains("<dataValidations count=\"2\">"), "{ws}");
    assert!(ws.contains(r#"promptTitle="Pick""#));
    let mut back = SheetSession::load_xlsx(&bytes).unwrap();
    assert_eq!(back.list_validation_rules(0).unwrap(), rules);
    assert!(!back.enter_cell(0, 0, 0, "3", false).unwrap().applied);
    assert!(back.enter_cell(0, 0, 0, "7", false).unwrap().applied);
    back.clear_validation(0, "A1:A10").unwrap();
    let ws = read_part(&back.save_xlsx().unwrap(), "xl/worksheets/sheet1.xml");
    assert!(!ws.contains("dataValidation"));
}

#[test]
fn a_workbooks_own_rules_are_enforced__feat__sheet_validation_enforce() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("corpus/xlsx-corpus/12-datavalidation.xlsx");
    let bytes = std::fs::read(path).unwrap();
    let mut s = SheetSession::load_xlsx(&bytes).unwrap();
    let rules = s.list_validation_rules(0).unwrap();
    assert!(!rules.is_empty());
    let list = rules.iter().find(|r| r.kind == "list").unwrap();
    let first = list.sqref.split([' ', ':']).next().unwrap().to_string();
    let (row, col, _, _) = sheet_core::parse_a1(&first).unwrap();
    let v = s.validation_at(0, row, col).unwrap().unwrap();
    let items = v.list_items.unwrap();
    assert!(!items.is_empty());
    assert!(s.enter_cell(0, row, col, &items[0], false).unwrap().applied);
    assert!(
        !s.enter_cell(0, row, col, "certainly-not-an-item", false)
            .unwrap()
            .applied
    );
    // A zero-edit save of the workbook keeps the element byte for byte.
    let mut z = SheetSession::load_xlsx(&bytes).unwrap();
    let a = read_part(&bytes, "xl/worksheets/sheet1.xml");
    let b = read_part(&z.save_xlsx().unwrap(), "xl/worksheets/sheet1.xml");
    assert_eq!(a, b);
}

#[test]
fn protected_sheet_refuses_rule_edits__feat__sheet_validation_author() {
    let mut s = SheetSession::new();
    s.protect_sheet(0, Default::default()).unwrap();
    assert!(s
        .set_validation(0, "A1", rule("whole", None, "1", Some("2")))
        .is_err());
}

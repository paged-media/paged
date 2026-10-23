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

//! W2.7 (sheet ADR 517): multi-key sort written as `sortState`, the
//! AutoFilter criteria engine written as `filterColumn`, the dropdown data,
//! named filter views — and property tests against brute force.

#![allow(non_snake_case)]

use proptest::prelude::*;
use sheet_js::core::filter::{ConditionArg, CriterionArg, DateGroupArg};
use sheet_js::core::sort::{SortKeyArg, SortSpec};
use sheet_js::core::{SheetSession, StylePatchArg};
use std::io::Read;

fn read_part(bytes: &[u8], name: &str) -> String {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).expect("valid zip");
    let mut f = zip.by_name(name).unwrap_or_else(|_| panic!("part {name}"));
    let mut data = String::new();
    f.read_to_string(&mut data).unwrap();
    data
}

fn table(rows: &[[&str; 3]]) -> SheetSession {
    let mut s = SheetSession::new();
    for (r, row) in rows.iter().enumerate() {
        for (c, v) in row.iter().enumerate() {
            if !v.is_empty() {
                s.set_cell(0, r as u32, c as u32, v).unwrap();
            }
        }
    }
    s
}

fn col(s: &SheetSession, c: u32, rows: std::ops::RangeInclusive<u32>) -> Vec<String> {
    rows.map(|r| s.get_cell_display(0, r, c)).collect()
}

fn key(index: u32, descending: bool) -> SortKeyArg {
    SortKeyArg {
        index,
        descending,
        ..Default::default()
    }
}

#[test]
fn two_level_sort_with_header_and_sort_state__feat__sheet_sort_multikey() {
    let mut s = table(&[
        ["Region", "Units", "Rep"],
        ["West", "5", "a"],
        ["East", "9", "b"],
        ["West", "7", "c"],
        ["East", "2", "d"],
        ["", "1", "e"],
    ]);
    s.set_cell(0, 1, 3, "=B2*10").unwrap();
    s.sort_range_by(
        0,
        "A1:D6",
        SortSpec {
            keys: vec![key(0, false), key(1, true)],
            has_header: true,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(col(&s, 0, 1..=5), ["East", "East", "West", "West", ""]);
    assert_eq!(col(&s, 1, 1..=5), ["9", "2", "7", "5", "1"]);
    // The formula moved with its row and was re-addressed.
    assert_eq!(s.get_cell_input(0, 4, 3), "=B5*10");
    assert_eq!(s.get_cell_display(0, 4, 3), "50");
    let ws = read_part(&s.save_xlsx().unwrap(), "xl/worksheets/sheet1.xml");
    assert!(
        ws.contains(r#"<sortState ref="A2:D6"><sortCondition ref="A2:A6"/><sortCondition descending="1" ref="B2:B6"/></sortState>"#),
        "{ws}"
    );
}

#[test]
fn custom_list_case_sensitive_and_left_to_right__feat__sheet_sort_multikey() {
    let mut s = table(&[["High", "low", "Mid"], ["1", "2", "3"], ["", "", ""]]);
    s.sort_range_by(
        0,
        "A1:C2",
        SortSpec {
            keys: vec![SortKeyArg {
                index: 0,
                custom_list: Some(vec!["Low".into(), "Mid".into(), "High".into()]),
                ..Default::default()
            }],
            left_to_right: true,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(
        (0..3)
            .map(|c| s.get_cell_display(0, 0, c))
            .collect::<Vec<_>>(),
        ["low", "Mid", "High"]
    );
    assert_eq!(
        (0..3)
            .map(|c| s.get_cell_display(0, 1, c))
            .collect::<Vec<_>>(),
        ["2", "3", "1"]
    );
    let ws = read_part(&s.save_xlsx().unwrap(), "xl/worksheets/sheet1.xml");
    assert!(ws.contains(r#"columnSort="1""#) && ws.contains(r#"customList="Low,Mid,High""#));

    let mut c = table(&[["B", "", ""], ["b", "", ""], ["a", "", ""], ["A", "", ""]]);
    c.sort_range_by(
        0,
        "A1:A4",
        SortSpec {
            keys: vec![key(0, false)],
            case_sensitive: true,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(col(&c, 0, 0..=3), ["a", "A", "b", "B"]);
}

#[test]
fn sort_by_cell_colour_moves_formats__feat__sheet_sort_multikey() {
    let mut s = table(&[["x", "", ""], ["y", "", ""], ["z", "", ""]]);
    s.set_style(
        0,
        "A2",
        StylePatchArg {
            fill: Some("#FF0000".into()),
            ..Default::default()
        },
    )
    .unwrap();
    let r = s
        .sort_range_by(
            0,
            "A1:A3",
            SortSpec {
                keys: vec![SortKeyArg {
                    index: 0,
                    sort_by: Some("cellColor".into()),
                    color: Some("#FF0000".into()),
                    ..Default::default()
                }],
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(col(&s, 0, 0..=2), ["y", "x", "z"]);
    assert!(r.styles.is_some(), "the fill moved with its row");
    assert_eq!(
        s.get_style(0, 0, 0).unwrap().fill.as_deref(),
        Some("#FF0000")
    );
    let ws = read_part(&s.save_xlsx().unwrap(), "xl/worksheets/sheet1.xml");
    assert!(ws.contains(r#"sortBy="cellColor""#) && ws.contains("dxfId="));
}

fn sales() -> SheetSession {
    table(&[
        ["Region", "Units", "When"],
        ["West", "5", "2026-03-04"],
        ["East", "12", "2026-03-20"],
        ["west", "7", "2025-11-02"],
        ["North", "2", "2026-01-15"],
        ["", "30", "2026-03-05"],
    ])
}

#[test]
fn value_list_filter_hides_rows_and_writes_autofilter__feat__sheet_filter_criteria() {
    let mut s = sales();
    s.set_cell(0, 7, 1, "=SUBTOTAL(109,B2:B6)").unwrap();
    let r = s
        .set_filter_column(
            0,
            "A1:C6",
            0,
            Some(CriterionArg::Values {
                values: vec!["West".into()],
                blanks: true,
                dates: vec![],
            }),
        )
        .unwrap();
    assert_eq!(r.hidden_rows, vec![2, 4]);
    assert_eq!(s.get_cell_display(0, 7, 1), "42");
    let bytes = s.save_xlsx().unwrap();
    let ws = read_part(&bytes, "xl/worksheets/sheet1.xml");
    assert!(ws.contains(r#"<autoFilter ref="A1:C6"><filterColumn colId="0"><filters blank="1"><filter val="West"/></filters></filterColumn></autoFilter>"#), "{ws}");
    let row3 = &ws[ws.find(r#"<row r="3""#).unwrap()..];
    assert!(row3[..row3.find('>').unwrap()].contains(r#"hidden="1""#));
    // Reloaded: the filter is known, clearing it shows exactly its rows.
    let mut back = SheetSession::load_xlsx(&bytes).unwrap();
    back.set_hidden(0, sheet_js::core::outline::Axis::Rows, 6, 6, true)
        .unwrap();
    assert_eq!(
        back.filter_state(0).unwrap().unwrap().hidden_rows,
        vec![2, 4]
    );
    back.clear_filter_criteria(0).unwrap();
    assert_eq!(back.outline(0).unwrap().hidden_rows, vec![6]);
    assert!(back.filter_state(0).unwrap().is_some(), "the buttons stay");
    back.remove_autofilter(0).unwrap();
    let ws = read_part(&back.save_xlsx().unwrap(), "xl/worksheets/sheet1.xml");
    assert!(!ws.contains("autoFilter"));
}

#[test]
fn custom_top_dynamic_and_date_groups__feat__sheet_filter_criteria() {
    let mut s = sales();
    let c = |op: &str, val: &str| ConditionArg {
        op: op.into(),
        val: val.into(),
    };
    let hid = |s: &mut SheetSession, col: u32, crit: CriterionArg| {
        s.set_filter_column(0, "A1:C6", col, Some(crit))
            .unwrap()
            .hidden_rows
    };
    assert_eq!(
        hid(
            &mut s,
            1,
            CriterionArg::Custom {
                and: true,
                conditions: vec![c("greaterThan", "4"), c("lessThanOrEqual", "12")]
            }
        ),
        vec![4, 5]
    );
    s.clear_filter_criteria(0).unwrap();
    assert_eq!(
        hid(
            &mut s,
            0,
            CriterionArg::Custom {
                and: false,
                conditions: vec![c("equal", "w*"), c("equal", "?orth")]
            }
        ),
        vec![2, 5]
    );
    s.clear_filter_criteria(0).unwrap();
    assert_eq!(
        hid(
            &mut s,
            1,
            CriterionArg::Top {
                n: 2.0,
                percent: false,
                top: true
            }
        ),
        vec![1, 3, 4]
    );
    s.clear_filter_criteria(0).unwrap();
    assert_eq!(
        hid(
            &mut s,
            1,
            CriterionArg::Dynamic {
                dynamic: "aboveAverage".into()
            }
        ),
        // The average is 11.2: 12 and 30 stay.
        vec![1, 3, 4]
    );
    s.clear_filter_criteria(0).unwrap();
    assert_eq!(
        hid(
            &mut s,
            2,
            CriterionArg::Dynamic {
                dynamic: "M3".into()
            }
        ),
        vec![3, 4]
    );
    s.clear_filter_criteria(0).unwrap();
    assert_eq!(
        hid(
            &mut s,
            2,
            CriterionArg::Values {
                values: vec![],
                blanks: false,
                dates: vec![DateGroupArg {
                    year: 2026,
                    month: Some(3),
                    ..Default::default()
                }]
            }
        ),
        vec![3, 4]
    );
    let ws = read_part(&s.save_xlsx().unwrap(), "xl/worksheets/sheet1.xml");
    assert!(
        ws.contains(r#"<dateGroupItem year="2026" month="3" dateTimeGrouping="month"/>"#),
        "{ws}"
    );
}

#[test]
fn dynamic_dates_follow_the_clock__feat__sheet_filter_criteria() {
    let mut s = sales();
    // 2026-03-05 12:00 UTC.
    s.set_clock(1_772_712_000_000.0, 0.0);
    let r = s
        .set_filter_column(
            0,
            "A1:C6",
            2,
            Some(CriterionArg::Dynamic {
                dynamic: "thisMonth".into(),
            }),
        )
        .unwrap();
    assert_eq!(r.hidden_rows, vec![3, 4]);
    let r = s
        .set_filter_column(
            0,
            "A1:C6",
            2,
            Some(CriterionArg::Dynamic {
                dynamic: "today".into(),
            }),
        )
        .unwrap();
    assert_eq!(r.hidden_rows, vec![1, 2, 3, 4]);
    let ws = read_part(&s.save_xlsx().unwrap(), "xl/worksheets/sheet1.xml");
    assert!(
        ws.contains(r#"<dynamicFilter type="today" val="46086" maxVal="46087"/>"#),
        "{ws}"
    );
}

#[test]
fn colour_filter_and_dropdown_data__feat__sheet_filter_dropdown() {
    let mut s = sales();
    s.set_style(
        0,
        "A3",
        StylePatchArg {
            fill: Some("#00FF00".into()),
            ..Default::default()
        },
    )
    .unwrap();
    s.set_autofilter(0, "A1:C6").unwrap();
    let v = s.filter_column_values(0, 0).unwrap();
    assert_eq!(v.kind, "text");
    let texts: Vec<_> = v.items.iter().map(|i| (i.text.as_str(), i.count)).collect();
    assert_eq!(texts, [("East", 1), ("North", 1), ("West", 1), ("west", 1)]);
    assert_eq!(v.blanks, 1);
    assert_eq!(v.fill_colors, vec!["#00FF00"]);
    let d = s.filter_column_values(0, 2).unwrap();
    assert_eq!(d.kind, "date");
    assert_eq!(d.dates.len(), 5);
    let r = s
        .set_filter_column(
            0,
            "A1:C6",
            0,
            Some(CriterionArg::Color {
                color: "#00FF00".into(),
                cell_color: true,
            }),
        )
        .unwrap();
    assert_eq!(r.hidden_rows, vec![1, 3, 4, 5]);
    // The dropdown of another column lists only the kept rows.
    let u = s.filter_column_values(0, 1).unwrap();
    assert_eq!(u.items.len(), 1);
    assert_eq!(u.items[0].text, "12");
    let st = s.filter_state(0).unwrap().unwrap();
    assert!(matches!(
        st.columns[0].criterion,
        Some(CriterionArg::Color { .. })
    ));
}

#[test]
fn named_filter_views__feat__sheet_filter_views() {
    let mut s = sales();
    s.set_filter("0".parse().unwrap(), "A1:C6", 0, "equals", "East")
        .unwrap();
    s.save_filter_view(0, "east").unwrap();
    s.remove_autofilter(0).unwrap();
    let views = s.list_filter_views();
    assert_eq!(views.len(), 1);
    let mut other = sales();
    other.set_filter_views(views);
    let r = other.apply_filter_view(0, "east").unwrap();
    assert_eq!(r.hidden_rows, vec![1, 3, 4, 5]);
}

#[test]
fn protected_sheet_refuses_filter_and_sort__feat__sheet_filter_criteria() {
    let mut s = sales();
    s.protect_sheet(0, Default::default()).unwrap();
    assert!(s.set_autofilter(0, "A1:C6").is_err());
    assert!(s
        .sort_range_by(
            0,
            "A1:C6",
            SortSpec {
                keys: vec![key(0, false)],
                ..Default::default()
            }
        )
        .is_err());
}

// ── property tests ─────────────────────────────────────────────────────────

fn cell_value() -> impl Strategy<Value = String> {
    prop_oneof![
        (0i32..6).prop_map(|n| n.to_string()),
        prop::sample::select(vec!["a", "B", "b", "c", "TRUE", ""]).prop_map(String::from),
    ]
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 64, ..ProptestConfig::default() })]

    /// A two-key sort is the stable sort brute force gives: each row's tag
    /// (column C) lands where a stable sort of the (key1, key2) tuples puts
    /// it.
    #[test]
    fn multi_key_sort_is_stable__feat__sheet_sort_multikey(
        rows in prop::collection::vec((cell_value(), cell_value()), 2..12),
        d1 in any::<bool>(),
        d2 in any::<bool>(),
    ) {
        let mut s = SheetSession::new();
        for (i, (a, b)) in rows.iter().enumerate() {
            if !a.is_empty() { s.set_cell(0, i as u32, 0, a).unwrap(); }
            if !b.is_empty() { s.set_cell(0, i as u32, 1, b).unwrap(); }
            s.set_cell(0, i as u32, 2, &format!("t{i}")).unwrap();
        }
        let n = rows.len() as u32;
        let before: Vec<(String, String, String)> = (0..n)
            .map(|r| (s.get_cell_display(0, r, 0), s.get_cell_display(0, r, 1), s.get_cell_display(0, r, 2)))
            .collect();
        s.sort_range_by(0, &format!("A1:C{n}"), SortSpec {
            keys: vec![key(0, d1), key(1, d2)], ..Default::default()
        }).unwrap();
        let after: Vec<(String, String, String)> = (0..n)
            .map(|r| (s.get_cell_display(0, r, 0), s.get_cell_display(0, r, 1), s.get_cell_display(0, r, 2)))
            .collect();
        // Same multiset of rows.
        let mut a = before.clone(); a.sort();
        let mut b = after.clone(); b.sort();
        prop_assert_eq!(a, b);
        // Rows with identical keys keep their relative order (stability).
        for i in 0..after.len() {
            for j in i + 1..after.len() {
                if after[i].0 == after[j].0 && after[i].1 == after[j].1 {
                    let ti: usize = after[i].2[1..].parse().unwrap();
                    let tj: usize = after[j].2[1..].parse().unwrap();
                    prop_assert!(ti < tj, "unstable: {:?}", after);
                }
            }
        }
        // Blanks of the first key are last.
        let first_blank = after.iter().position(|r| r.0.is_empty());
        if let Some(fb) = first_blank {
            prop_assert!(after[fb..].iter().all(|r| r.0.is_empty()));
        }
    }

    /// The custom-condition engine against a brute-force reading of the
    /// same rule over numbers.
    #[test]
    fn custom_filter_matches_brute_force__feat__sheet_filter_criteria(
        vals in prop::collection::vec(-5i32..15, 1..15),
        lo in -5i32..15,
        hi in -5i32..15,
        and in any::<bool>(),
    ) {
        let mut s = SheetSession::new();
        s.set_cell(0, 0, 0, "N").unwrap();
        for (i, v) in vals.iter().enumerate() {
            s.set_cell(0, i as u32 + 1, 0, &v.to_string()).unwrap();
        }
        let n = vals.len() as u32 + 1;
        let r = s.set_filter_column(0, &format!("A1:A{n}"), 0, Some(CriterionArg::Custom {
            and,
            conditions: vec![
                ConditionArg { op: "greaterThanOrEqual".into(), val: lo.to_string() },
                ConditionArg { op: "lessThan".into(), val: hi.to_string() },
            ],
        })).unwrap();
        let want: Vec<u32> = vals.iter().enumerate().filter(|(_, v)| {
            let (a, b) = (**v >= lo, **v < hi);
            !(if and { a && b } else { a || b })
        }).map(|(i, _)| i as u32 + 1).collect();
        prop_assert_eq!(r.hidden_rows, want);
    }
}

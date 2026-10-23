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

//! W2.5 (sheet ADR 523): conditional-format authoring through the session —
//! add, edit, delete, reorder, stop-if-true — written back by splicing only
//! the changed blocks (and their x14 counterpart), differential formats
//! appended, read back the same after a save and a reload.

use std::io::Read;

use sheet_core::condfmt::*;
use sheet_core::visual::{CellFill, ColorRef, DifferentialFormat, FontDelta, PatternKind};
use sheet_js::core::cf::CfRuleSpec;
use sheet_js::core::{LowerOptions, SheetSession};

fn sheet_xml(bytes: &[u8]) -> String {
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let mut f = z.by_name("xl/worksheets/sheet1.xml").unwrap();
    let mut s = String::new();
    f.read_to_string(&mut s).unwrap();
    s
}

fn red_fill() -> DifferentialFormat {
    DifferentialFormat {
        font: Some(FontDelta {
            bold: Some(true),
            color: Some(ColorRef::rgb(0x9C, 0, 6)),
            ..Default::default()
        }),
        fill: Some(CellFill::Pattern {
            pattern: PatternKind::Solid,
            fg: Some(ColorRef::rgb(0xFF, 0xC7, 0xCE)),
            bg: None,
        }),
        ..Default::default()
    }
}

#[test]
fn rules_are_authored_and_round_trip__feat__sheet_xlsx_condfmt() {
    let mut s = SheetSession::new();
    for r in 0..10u32 {
        s.set_cell(0, r, 0, &format!("{}", r as i32 - 3)).unwrap();
        s.set_cell(0, r, 1, &format!("{}", r * 10)).unwrap();
    }
    // A cell-value rule with a formula operand.
    s.add_cf_rule(
        0,
        CfRuleSpec {
            ranges: vec!["B1:B10".into()],
            kind: CfKind::CellIs {
                op: CfOp::GreaterThan,
                formulas: vec!["$B$5".into()],
            },
            stop_if_true: false,
            dxf: Some(red_fill()),
        },
    )
    .unwrap();
    // A data bar over negatives (x14), then an icon set only x14 has.
    let mut bar = DataBarRule::new(
        Cfvo::new(CfvoKind::AutoMin, None),
        Cfvo::new(CfvoKind::AutoMax, None),
        ColorRef::rgb(0x63, 0x8E, 0xC6),
    );
    bar.gradient = false;
    bar.axis_position = AxisPosition::Middle;
    s.add_cf_rule(
        0,
        CfRuleSpec {
            ranges: vec!["A1:A10".into()],
            kind: CfKind::DataBar(bar),
            stop_if_true: false,
            dxf: None,
        },
    )
    .unwrap();
    s.add_cf_rule(
        0,
        CfRuleSpec {
            ranges: vec!["B1:B10".into()],
            kind: CfKind::IconSet(IconSetRule {
                set: "3Stars".into(),
                cfvos: vec![
                    Cfvo::new(CfvoKind::Percent, Some("0")),
                    Cfvo::new(CfvoKind::Percent, Some("33")),
                    Cfvo::new(CfvoKind::Percent, Some("67")),
                ],
                reverse: false,
                show_value: true,
                custom: vec![],
            }),
            stop_if_true: false,
            dxf: None,
        },
    )
    .unwrap();
    let rules = s.cf_rules(0).unwrap();
    assert_eq!(rules.len(), 3);
    // New rules go on top: the icon set first, the cell-value rule last.
    assert!(matches!(rules[0].rule.kind, CfKind::IconSet(_)));
    assert!(matches!(rules[2].rule.kind, CfKind::CellIs { .. }));
    assert_eq!(
        rules.iter().map(|r| r.rule.priority).collect::<Vec<_>>(),
        vec![1, 2, 3]
    );

    // They evaluate: B10 (90 > 40) is painted, A1 (-3) has a negative bar,
    // B10 has a full star.
    let page = s
        .get_range_page(0, "A1:B10", LowerOptions::default())
        .unwrap();
    let b10 = &page.rows[9].cells[1];
    assert_eq!(
        page.styles[b10.style_key as usize].fill_rgb.as_deref(),
        Some("#FFC7CE")
    );
    assert!(page.databars.iter().any(|d| d.row == 0 && d.negative));
    assert!(page
        .icons
        .iter()
        .any(|i| i.row == 9 && i.set == "3Stars" && i.index == 2));

    // Reorder (cell-value rule to the top) and stop there.
    s.reorder_cf_rules(0, vec![2, 0, 1]).unwrap();
    s.set_cf_stop_if_true(0, 0, true).unwrap();
    let rules = s.cf_rules(0).unwrap();
    assert!(matches!(rules[0].rule.kind, CfKind::CellIs { .. }));
    assert!(rules[0].rule.stop_if_true);

    // Save: 2006 blocks, the x14 extension (data bar + icon set), the dxf.
    let bytes = s.save_xlsx().unwrap();
    let xml = sheet_xml(&bytes);
    assert!(xml.contains(r#"<conditionalFormatting sqref="B1:B10"><cfRule type="cellIs" dxfId="0" priority="1" stopIfTrue="1" operator="greaterThan"><formula>$B$5</formula></cfRule></conditionalFormatting>"#), "{xml}");
    assert!(xml.contains("x14:conditionalFormattings"), "{xml}");
    assert!(xml.contains(r#"<x14:iconSet iconSet="3Stars">"#), "{xml}");
    assert!(xml.contains(r#"axisPosition="middle""#), "{xml}");

    // Reload: the same rules.
    let back = SheetSession::load_xlsx(&bytes).unwrap();
    let again = back.cf_rules(0).unwrap();
    assert_eq!(again.len(), 3);
    for (a, b) in again.iter().zip(&rules) {
        assert_eq!(a.ranges, b.ranges);
        assert_eq!(a.rule.kind, b.rule.kind);
        assert_eq!(a.rule.priority, b.rule.priority);
        assert_eq!(a.rule.dxf, b.rule.dxf);
    }

    // Edit and delete.
    let mut s = back;
    s.update_cf_rule(
        0,
        0,
        CfRuleSpec {
            ranges: vec!["B1:B10".into()],
            kind: CfKind::Top10 {
                rank: 2,
                percent: false,
                bottom: false,
            },
            stop_if_true: false,
            dxf: Some(red_fill()),
        },
    )
    .unwrap();
    s.delete_cf_rule(0, 1).unwrap();
    let rules = s.cf_rules(0).unwrap();
    assert_eq!(rules.len(), 2);
    assert!(matches!(rules[0].rule.kind, CfKind::Top10 { rank: 2, .. }));
    assert!(matches!(rules[1].rule.kind, CfKind::DataBar(_)));
    assert!(s.reorder_cf_rules(0, vec![0, 0]).is_err());
}

#[test]
fn an_edit_splices_only_the_changed_block__feat__sheet_xlsx_condfmt() {
    let fixture = std::fs::read(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../corpus/xlsx-corpus/08-condfmt.xlsx"),
    )
    .unwrap();
    let before = sheet_xml(&fixture);
    let mut s = SheetSession::load_xlsx(&fixture).unwrap();
    let n = s.cf_rules(0).unwrap().len();
    s.add_cf_rule(
        0,
        CfRuleSpec {
            ranges: vec!["H1:H4".into()],
            kind: CfKind::Duplicates { unique: false },
            stop_if_true: false,
            dxf: Some(red_fill()),
        },
    )
    .unwrap();
    assert_eq!(s.cf_rules(0).unwrap().len(), n + 1);
    let after = sheet_xml(&s.save_xlsx().unwrap());
    assert!(
        after.contains(r#"<conditionalFormatting sqref="H1:H4"><cfRule type="duplicateValues""#),
        "{after}"
    );
    // The new rule took priority 1, so every old rule was renumbered: the
    // old blocks are rewritten — but their rules keep their content.
    let back = SheetSession::load_xlsx(&s.save_xlsx().unwrap()).unwrap();
    assert_eq!(back.cf_rules(0).unwrap().len(), n + 1);
    // Deleting the new rule renumbers back: the old blocks' bytes return.
    s.delete_cf_rule(0, 0).unwrap();
    let restored = sheet_xml(&s.save_xlsx().unwrap());
    for block in before.split("<conditionalFormatting").skip(1) {
        let block = block.split("</conditionalFormatting>").next().unwrap();
        assert!(restored.contains(block), "{block}");
    }
}

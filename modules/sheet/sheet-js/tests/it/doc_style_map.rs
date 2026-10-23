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

//! Sheet ADR 524 end to end through `SheetSession`: Excel named styles
//! mapped to document styles reach the page and the grid alike, in the
//! fixed precedence, and the mapping survives an xlsx save and reload.

use sheet_js::core::{GridSceneOptions, LowerOptions, SheetSession, StylePatchArg};
use sheet_lower::{DocStyleMap, DocStyleTarget, LoweredStyle};

fn para(id: &str) -> DocStyleTarget {
    DocStyleTarget {
        para: Some(id.into()),
        ..Default::default()
    }
}

fn page_style(s: &SheetSession, a1: &str) -> LoweredStyle {
    let page = s
        .get_range_page(0, &format!("{a1}:{a1}"), LowerOptions::default())
        .unwrap();
    page.styles[page.rows[0].cells[0].style_key as usize].clone()
}

fn named(s: &mut SheetSession, a1: &str, name: &str) {
    s.set_style(
        0,
        a1,
        StylePatchArg {
            named_style: Some(name.into()),
            ..StylePatchArg::default()
        },
    )
    .unwrap();
}

fn workbook() -> SheetSession {
    let mut s = SheetSession::new();
    s.set_cell(0, 0, 0, "Sales").unwrap();
    s.set_cell(0, 1, 0, "plain").unwrap();
    s.set_cell(0, 2, 0, "red heading").unwrap();
    s.set_cell(0, 3, 0, "fine").unwrap();
    named(&mut s, "A1", "Heading 1");
    named(&mut s, "A3", "Heading 1");
    named(&mut s, "A4", "Good");
    // Direct formatting over the named style.
    s.set_style(
        0,
        "A3",
        StylePatchArg {
            font_color: Some("#FF0000".into()),
            ..StylePatchArg::default()
        },
    )
    .unwrap();
    s
}

#[test]
fn named_styles_map_to_document_styles_on_both_surfaces__feat__sheet_format_doc_style_map() {
    let mut s = workbook();
    let before = page_style(&s, "A1");
    assert!(before.bold);
    assert_eq!(before.doc_para_style, None);

    s.set_doc_style_mapping("Heading 1", para("ParagraphStyle/Heading 1"))
        .unwrap();
    s.set_doc_style_mapping("Normal", para("ParagraphStyle/Body"))
        .unwrap();
    // Off: the table is kept, nothing changes.
    assert_eq!(page_style(&s, "A1"), before);
    s.set_doc_styles_enabled(true).unwrap();

    let h = page_style(&s, "A1");
    assert_eq!(
        h.doc_para_style.as_deref(),
        Some("ParagraphStyle/Heading 1")
    );
    assert!(!h.bold, "the named style's font gives way");
    assert_eq!(h.font_size_pt, None);
    assert_eq!(h.text_rgb, None);
    assert_eq!(h.named_style.as_deref(), Some("Heading 1"));

    let plain = page_style(&s, "A2");
    assert_eq!(plain.doc_para_style.as_deref(), Some("ParagraphStyle/Body"));
    assert_eq!(plain.font_name, None, "no default-font override");
    assert_eq!(plain.font_size_pt, None);

    // Direct formatting wins over the mapping.
    let red = page_style(&s, "A3");
    assert_eq!(red.text_rgb.as_deref(), Some("#FF0000"));
    assert_eq!(
        red.doc_para_style.as_deref(),
        Some("ParagraphStyle/Heading 1")
    );

    // A named style without an entry: Normal's paragraph, its look concrete.
    let good = page_style(&s, "A4");
    assert_eq!(good.doc_para_style.as_deref(), Some("ParagraphStyle/Body"));
    assert!(good.fill_rgb.is_some());

    // The grid resolves the same style for the same cell.
    let scene = s
        .get_grid_scene(0, 0, 0, 200.0, 200.0, GridSceneOptions::default())
        .unwrap();
    let g = scene
        .cells
        .iter()
        .find(|c| (c.row, c.col) == (0, 0))
        .unwrap();
    assert_eq!(
        scene.styles[g.style_key as usize].doc_para_style,
        h.doc_para_style
    );

    // A document reference of the cell's own beats the mapping.
    s.set_style(
        0,
        "A1",
        StylePatchArg {
            doc_para_style: Some("ParagraphStyle/Own".into()),
            ..StylePatchArg::default()
        },
    )
    .unwrap();
    assert_eq!(
        page_style(&s, "A1").doc_para_style.as_deref(),
        Some("ParagraphStyle/Own")
    );

    // Switching off restores the workbook's own look.
    s.set_doc_styles_enabled(false).unwrap();
    assert_eq!(page_style(&s, "A2").doc_para_style, None);
    assert!(page_style(&s, "A3").bold);
}

#[test]
fn the_mapping_survives_save_and_reload() {
    let mut s = workbook();
    let mut map = DocStyleMap {
        enabled: true,
        ..Default::default()
    };
    map.set("Heading 1", para("ParagraphStyle/Heading 1"));
    map.set(
        "Good",
        DocStyleTarget {
            para: Some("ParagraphStyle/Body".into()),
            char: Some("CharacterStyle/Good".into()),
            cell: Some("CellStyle/Good".into()),
        },
    );
    s.set_doc_style_map(map.clone()).unwrap();
    let bytes = s.save_xlsx().unwrap();
    let back = SheetSession::load_xlsx(&bytes).unwrap();
    assert_eq!(back.doc_style_map(), map);
    let good = page_style(&back, "A4");
    assert_eq!(good.doc_cell_style.as_deref(), Some("CellStyle/Good"));
    assert_eq!(good.fill_rgb, None, "the mapped cell style draws the box");
    assert_eq!(page_style(&back, "A1"), page_style(&s, "A1"));
}

#[test]
fn usage_lists_named_styles_with_counts() {
    let s = workbook();
    let u = s.named_style_usage();
    assert_eq!(u[0].name, "Normal");
    assert_eq!(u[0].cells, 1);
    let h1 = u.iter().find(|n| n.name == "Heading 1").unwrap();
    assert_eq!(h1.cells, 2);
    assert!(h1.bold);
    assert_eq!(h1.font_size, Some(15.0));
    assert_eq!(u.iter().find(|n| n.name == "Good").unwrap().cells, 1);
}

#[test]
fn table_regions_rank_between_named_and_normal_mappings() {
    let mut s = SheetSession::new();
    for r in 0..3 {
        s.set_cell(0, r, 0, &format!("v{r}")).unwrap();
        s.set_cell(0, r, 1, &format!("w{r}")).unwrap();
    }
    s.create_table(0, "A1:B3", true, Some("TableStyleMedium2"), None)
        .unwrap();
    named(&mut s, "B1", "Heading 1");
    let mut map = DocStyleMap {
        enabled: true,
        ..Default::default()
    };
    map.set("Normal", para("ParagraphStyle/Body"));
    map.set("Heading 1", para("ParagraphStyle/Heading 1"));
    s.set_doc_style_map(map).unwrap();
    // The header cell under Normal's mapping: the table's header text wins.
    let a1 = page_style(&s, "A1");
    assert_eq!(a1.doc_para_style.as_deref(), Some("ParagraphStyle/Body"));
    assert!(
        a1.bold || a1.text_rgb.is_some(),
        "table header look: {a1:?}"
    );
    // The named style's mapping ranks above the table: its text is the
    // document's.
    let b1 = page_style(&s, "B1");
    assert_eq!(
        b1.doc_para_style.as_deref(),
        Some("ParagraphStyle/Heading 1")
    );
    assert!(!b1.bold);
    assert_eq!(b1.text_rgb, None);
}

#[test]
fn missing_document_styles_fall_back_and_remap() {
    let mut s = workbook();
    let mut map = DocStyleMap {
        enabled: true,
        ..Default::default()
    };
    map.set("Heading 1", para("ParagraphStyle/Gone"));
    s.set_doc_style_map(map).unwrap();
    assert!(!page_style(&s, "A1").bold);
    // The document lacks the style: the heading shows its workbook look.
    assert!(s
        .set_document_styles_available(Some(vec!["ParagraphStyle/Body".into()]))
        .unwrap());
    let h = page_style(&s, "A1");
    assert!(h.bold);
    assert_eq!(h.doc_para_style, None);
    let refs = s.doc_references();
    assert_eq!(refs.para_styles.get("ParagraphStyle/Gone"), Some(&0));
    // Remap to a style the document has: the mapping follows.
    assert_eq!(
        s.remap_doc_reference("ParagraphStyle/Gone", "ParagraphStyle/Body", None)
            .unwrap(),
        1
    );
    let h = page_style(&s, "A1");
    assert_eq!(h.doc_para_style.as_deref(), Some("ParagraphStyle/Body"));
    assert!(!h.bold);
}

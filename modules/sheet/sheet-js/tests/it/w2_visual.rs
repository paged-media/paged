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

//! W2.2 (sheet ADR 518) end to end through `SheetSession`: a style authored
//! with the visual model's facets lowers the same on the page and in the
//! grid (JSON snapshot of the style), and its document references survive a
//! save and a reload.

use sheet_js::core::{
    DocSwatchArg, EdgeArg, GridSceneOptions, LowerOptions, SheetSession, StylePatchArg,
};

#[test]
fn the_visual_model_reaches_both_surfaces_and_round_trips__feat__sheet_format_cell_style() {
    let mut s = SheetSession::new();
    s.set_cell(0, 0, 0, "Total").unwrap();
    let brand = DocSwatchArg {
        id: "Color/Brand".into(),
        model: "spot".into(),
        fallback_rgb: "#E3000F".into(),
    };
    s.set_style(
        0,
        "A1",
        StylePatchArg {
            pattern: Some("lightTrellis".into()),
            fill: Some("#000000".into()),
            fill_bg: Some("#FFFFFF".into()),
            rotation: Some(45),
            indent: Some(2),
            strike: Some(true),
            vert_align: Some("superscript".into()),
            border_diagonal: Some(EdgeArg {
                style: "thin".into(),
                color: Some("#0000FF".into()),
                swatch: None,
            }),
            diagonal_up: Some(true),
            font_swatch: Some(brand.clone()),
            doc_char_style: Some("CharacterStyle/Strong".into()),
            ..StylePatchArg::default()
        },
    )
    .unwrap();

    let page = s
        .get_range_page(0, "A1:A1", LowerOptions::default())
        .unwrap();
    let key = page.rows[0].cells[0].style_key as usize;
    let st = &page.styles[key];
    let json = serde_json::to_value(st).unwrap();
    assert_eq!(json["fillPattern"]["pattern"], "lightTrellis");
    assert_eq!(
        json["fillRgb"], "#8F8F8F",
        "light trellis: 43.75 % black over white"
    );
    assert_eq!(json["rotation"], 45);
    assert_eq!(json["indentPt"], 13.5);
    assert_eq!(json["strike"], true);
    assert_eq!(json["vertAlign"], "superscript");
    assert_eq!(json["textRgb"], "#E3000F");
    assert_eq!(json["textSwatch"], "Color/Brand");
    assert_eq!(json["docCharStyle"], "CharacterStyle/Strong");
    assert_eq!(json["borderLines"]["diagonalUp"]["rgb"], "#0000FF");

    // The grid shows the same style for the same cell.
    let scene = s
        .get_grid_scene(0, 0, 0, 200.0, 100.0, GridSceneOptions::default())
        .unwrap();
    let g = scene
        .cells
        .iter()
        .find(|c| (c.row, c.col) == (0, 0))
        .unwrap();
    assert_eq!(scene.styles[g.style_key as usize], *st);

    // get_style answers the facets back.
    let got = s.get_style(0, 0, 0).unwrap();
    assert_eq!(got.pattern.as_deref(), Some("lightTrellis"));
    assert_eq!(got.font_swatch, Some(brand.clone()));
    assert_eq!(got.doc_char_style.as_deref(), Some("CharacterStyle/Strong"));

    // Save, reload: the concrete colour is written, the reference restored.
    let bytes = s.save_xlsx().unwrap();
    let back = SheetSession::load_xlsx(&bytes).unwrap();
    let v = back.get_cell_visual(0, 0, 0).unwrap();
    let doc = v.font.font.color.as_ref().unwrap().doc.as_ref().unwrap();
    assert_eq!(doc.id, "Color/Brand");
    assert_eq!(
        v.font.doc_char_style.as_deref(),
        Some("CharacterStyle/Strong")
    );
    assert_eq!(v.alignment.rotation, 45);
}

#[test]
fn named_styles_are_listed_and_applied__feat__sheet_format_cell_style() {
    let mut s = SheetSession::new();
    s.set_cell(0, 0, 0, "Sales").unwrap();
    let names = s.named_styles();
    let h1 = names.iter().find(|n| n.name == "Heading 1").unwrap();
    assert!(!h1.present);
    s.set_style(
        0,
        "A1",
        StylePatchArg {
            named_style: Some("Heading 1".into()),
            ..StylePatchArg::default()
        },
    )
    .unwrap();
    assert!(s
        .named_styles()
        .iter()
        .any(|n| n.name == "Heading 1" && n.present));
    let page = s
        .get_range_page(0, "A1:A1", LowerOptions::default())
        .unwrap();
    let st = &page.styles[page.rows[0].cells[0].style_key as usize];
    assert!(st.bold);
    assert_eq!(st.font_size_pt, Some(15.0));
    assert_eq!(st.named_style.as_deref(), Some("Heading 1"));
    assert_eq!(st.border_lines.bottom.as_ref().unwrap().style, "thick");
}

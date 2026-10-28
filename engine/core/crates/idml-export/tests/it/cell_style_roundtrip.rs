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

//! Cell-style save-back, end to end through the real [`write_idml`].
//!
//! The writer spelled a cell's `AppliedCellStyle` but never the
//! `<CellStyle>` it names, so a cell style created in a document — a
//! `CreateStyle` on the cell collection, a data rule's cell style —
//! re-opened as a reference to nothing. These tests create one, apply it
//! to a cell of a minted table, export, re-import, and check the
//! definition and the pointer; and that a source part's own cell styles
//! keep their bytes until one is edited.

use crate::pkg;

use idml_export::write_idml;
use idml_import::{
    CellStyleDef, CharacterRun, Paragraph, Story, Table, TableCell, TableColumn, TableRow,
};

const STYLES_WITH_CELLS: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Styles xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="20.0">
<RootCharacterStyleGroup Self="u9d"><CharacterStyle Self="CharacterStyle/$ID/[No character style]" Name="$ID/[No character style]"/></RootCharacterStyleGroup>
<RootParagraphStyleGroup Self="u9e"><ParagraphStyle Self="ParagraphStyle/$ID/[No paragraph style]" Name="$ID/[No paragraph style]"/></RootParagraphStyleGroup>
<RootCellStyleGroup Self="u8a"><CellStyle Self="CellStyle/$ID/[None]" Name="$ID/[None]"/><CellStyle Self="CellStyle/Head" Name="Head" FillColor="Color/Black" FillTint="20" BottomEdgeStrokeWeight="1.5" VerticalJustification="CenterAlign"/></RootCellStyleGroup>
</idPkg:Styles>"#;

/// A two-by-one table whose first cell applies `style`.
fn table(style: &str) -> Table {
    let cell = |c: u32, applied: &str| TableCell {
        name: Some(format!("{c}:0")),
        row_span: 1,
        column_span: 1,
        applied_cell_style: Some(applied.into()),
        paragraphs: vec![Paragraph {
            runs: vec![CharacterRun {
                text: format!("c{c}"),
                ..Default::default()
            }],
            ..Default::default()
        }],
        ..Default::default()
    };
    Table {
        self_id: Some("u7".into()),
        body_row_count: 1,
        column_count: 2,
        rows: vec![TableRow {
            name: Some("0".into()),
            single_row_height: Some(20.0),
            ..Default::default()
        }],
        columns: (0..2)
            .map(|c| TableColumn {
                name: Some(c.to_string()),
                single_column_width: Some(60.0),
                ..Default::default()
            })
            .collect(),
        cells: vec![cell(0, style), cell(1, "CellStyle/$ID/[None]")],
        ..Default::default()
    }
}

/// A minted story holding [`table`], framed so it reaches the package.
fn add_table_story(doc: &mut paged_scene::Document, style: &str) {
    doc.stories.push(paged_scene::ParsedStory {
        src: String::new(),
        self_id: "Story/u1".into(),
        story: Story {
            paragraphs: vec![Paragraph {
                table: Some(table(style)),
                ..Default::default()
            }],
            ..Default::default()
        },
    });
    pkg::place_story(doc, "tf_u1", "Story/u1");
}

/// The style a `CreateStyle` on the cell collection mints, with the
/// fields a cell-style setter (or a data rule) gives it.
fn created_style() -> CellStyleDef {
    CellStyleDef {
        self_id: "CellStyle/u20".into(),
        name: Some("Price".into()),
        based_on: Some("CellStyle/$ID/[None]".into()),
        fill_color: Some("Color/Black".into()),
        fill_tint: Some(35.0),
        vertical_justification: Some("BottomAlign".into()),
        rotation_angle: Some(90.0),
        top_edge_stroke_color: Some("Color/Black".into()),
        top_edge_stroke_weight: Some(2.0),
        top_edge_stroke_type: Some("StrokeStyle/$ID/ThickThick".into()),
        top_edge_stroke_tint: Some(50.0),
        right_edge_stroke_weight: Some(0.5),
        first_baseline_offset: Some("LeadingOffset".into()),
        minimum_first_baseline_offset: Some(3.0),
        ..Default::default()
    }
}

fn the_cell_applies(doc: &paged_scene::Document, style: &str) {
    let story = doc
        .stories
        .iter()
        .find(|s| s.self_id == "Story_u1")
        .expect("minted story back");
    let t = story.story.paragraphs[0]
        .table
        .as_ref()
        .expect("table back");
    assert_eq!(t.cells[0].applied_cell_style.as_deref(), Some(style));
}

#[test]
fn a_created_cell_style_survives_export_and_reimport() {
    // The fixture's part has no `<RootCellStyleGroup>` at all: the writer
    // gives the style one.
    let source = pkg::simple("", pkg::STORY_BODY, pkg::STYLES);
    let mut doc = pkg::open(&source);
    let def = created_style();
    doc.styles
        .cell_styles
        .insert(def.self_id.clone(), def.clone());
    add_table_story(&mut doc, &def.self_id);

    let out = write_idml(&doc, &source).expect("write");
    let xml = pkg::entry(&out, "Resources/Styles.xml").expect("styles");
    assert!(
        xml.contains("<RootCellStyleGroup><CellStyle Self=\"CellStyle/u20\" Name=\"Price\""),
        "{xml}"
    );
    assert!(
        xml.contains(r#"<Properties><BasedOn type="object">CellStyle/$ID/[None]</BasedOn></Properties></CellStyle></RootCellStyleGroup>"#),
        "{xml}"
    );

    let re = pkg::open(&out);
    let back = re
        .styles
        .cell_styles
        .get("CellStyle/u20")
        .expect("the created cell style is DEFINED in the exported package");
    assert_eq!(back.name.as_deref(), Some("Price"));
    assert_eq!(back.based_on.as_deref(), Some("CellStyle/$ID/[None]"));
    assert_eq!(back.fill_color.as_deref(), Some("Color/Black"));
    assert_eq!(back.fill_tint, Some(35.0));
    assert_eq!(back.vertical_justification.as_deref(), Some("BottomAlign"));
    assert_eq!(back.rotation_angle, Some(90.0));
    assert_eq!(back.top_edge_stroke_color.as_deref(), Some("Color/Black"));
    assert_eq!(back.top_edge_stroke_weight, Some(2.0));
    assert_eq!(
        back.top_edge_stroke_type.as_deref(),
        Some("StrokeStyle/$ID/ThickThick")
    );
    assert_eq!(back.top_edge_stroke_tint, Some(50.0));
    assert_eq!(back.right_edge_stroke_weight, Some(0.5));
    assert_eq!(back.first_baseline_offset.as_deref(), Some("LeadingOffset"));
    assert_eq!(back.minimum_first_baseline_offset, Some(3.0));
    // The reserved `[None]` is InDesign's own: never synthesised.
    assert!(!xml.contains(r#"Self="CellStyle/$ID/[None]""#), "{xml}");
    the_cell_applies(&re, "CellStyle/u20");
    // A second save of the reopened package is byte-identical.
    pkg::assert_same_package(&out, &write_idml(&re, &out).expect("re-write"));
}

#[test]
fn a_created_cell_style_joins_the_parts_own_group() {
    let source = pkg::simple("", pkg::STORY_BODY, STYLES_WITH_CELLS);
    let mut doc = pkg::open(&source);
    let def = created_style();
    doc.styles
        .cell_styles
        .insert(def.self_id.clone(), def.clone());
    add_table_story(&mut doc, &def.self_id);

    let out = write_idml(&doc, &source).expect("write");
    let xml = pkg::entry(&out, "Resources/Styles.xml").expect("styles");
    assert_eq!(xml.matches("<RootCellStyleGroup").count(), 1, "{xml}");
    assert!(pkg::pos(&xml, r#"Self="CellStyle/Head""#) < pkg::pos(&xml, r#"Self="CellStyle/u20""#));
    assert_eq!(xml.matches(r#"Self="CellStyle/Head""#).count(), 1, "{xml}");

    let re = pkg::open(&out);
    assert_eq!(re.styles.cell_styles.len(), 3, "None + Head + u20");
    assert_eq!(re.styles.cell_styles["CellStyle/u20"].fill_tint, Some(35.0));
    the_cell_applies(&re, "CellStyle/u20");
}

#[test]
fn a_sources_cell_styles_keep_their_bytes_until_edited() {
    let source = pkg::simple("", pkg::STORY_BODY, STYLES_WITH_CELLS);
    let doc = pkg::open(&source);
    let out = write_idml(&doc, &source).expect("write");
    assert_eq!(out, source, "an unmutated package must be byte-identical");

    // `SetStyleProperty` on the source's own style: written in place.
    let mut doc = pkg::open(&source);
    let head = doc
        .styles
        .cell_styles
        .get_mut("CellStyle/Head")
        .expect("Head");
    head.fill_tint = Some(60.0);
    head.vertical_justification = None;
    head.left_edge_stroke_weight = Some(4.0);
    let out = write_idml(&doc, &source).expect("write");
    let xml = pkg::entry(&out, "Resources/Styles.xml").expect("styles");
    assert!(
        xml.contains(r#"<CellStyle Self="CellStyle/Head" Name="Head" FillColor="Color/Black" FillTint="60" BottomEdgeStrokeWeight="1.5" LeftEdgeStrokeWeight="4"/>"#),
        "{xml}"
    );
    let re = pkg::open(&out);
    let head = &re.styles.cell_styles["CellStyle/Head"];
    assert_eq!(head.fill_tint, Some(60.0));
    assert_eq!(head.vertical_justification, None);
    assert_eq!(head.left_edge_stroke_weight, Some(4.0));
    assert_eq!(head.bottom_edge_stroke_weight, Some(1.5));
}

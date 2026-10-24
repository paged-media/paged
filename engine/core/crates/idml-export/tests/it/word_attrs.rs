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

//! Engine ADR 1018 — Word's character and paragraph additions in IDML:
//! the underline kind and colour, double strikethrough, the highlight as
//! InDesign's highlight underline, and a range's own shading and border,
//! written where the model changed them and read back.

use crate::pkg;

use idml_export::write_idml;

const BODY: &str = r#"<ParagraphStyleRange><CharacterStyleRange><Content>Hello world</Content></CharacterStyleRange></ParagraphStyleRange><ParagraphStyleRange><CharacterStyleRange UnderlineType="StrokeStyle/$ID/ThickThin" Underline="true"><Content>Kept</Content></CharacterStyleRange></ParagraphStyleRange>"#;

fn story_xml(out: &[u8]) -> String {
    pkg::entry(out, "Stories/Story_st1.xml").expect("story part")
}

#[test]
fn an_unmutated_document_stays_byte_identical__feat__doc_word_character_model() {
    let source = pkg::simple("", BODY, pkg::STYLES);
    let doc = pkg::open(&source);
    // A stroke style with no Word counterpart is read as no kind and kept.
    let p1 = &doc.stories[0].story.paragraphs[1];
    assert_eq!(p1.runs[0].decorations.underline_kind, None);
    let out = write_idml(&doc, &source).expect("write");
    pkg::assert_same_package(&source, &out);
}

#[test]
fn character_additions_are_written_and_read_back__feat__doc_word_character_model() {
    let source = pkg::simple("", BODY, pkg::STYLES);
    let mut doc = pkg::open(&source);
    {
        let run = &mut doc.stories[0].story.paragraphs[0].runs[0];
        run.underline = Some(true);
        run.decorations.underline_kind = Some(paged_model::UnderlineKind::Double);
        run.decorations.underline_color = Some("Color/Red".into());
        run.decorations.double_strikethrough = Some(true);
    }
    let out = write_idml(&doc, &source).expect("write");
    let xml = story_xml(&out);
    assert!(
        xml.contains(r#"UnderlineType="StrokeStyle/$ID/ThinThin""#),
        "{xml}"
    );
    assert!(xml.contains(r#"UnderlineColor="Color/Red""#), "{xml}");
    assert!(
        xml.contains(r#"StrikeThroughType="StrokeStyle/$ID/ThinThin""#),
        "{xml}"
    );
    // The untouched second paragraph keeps its own spelling.
    assert!(
        xml.contains(r#"UnderlineType="StrokeStyle/$ID/ThickThin""#),
        "{xml}"
    );
    let back = pkg::open(&out);
    let d = &back.stories[0].story.paragraphs[0].runs[0].decorations;
    assert_eq!(d.underline_kind, Some(paged_model::UnderlineKind::Double));
    assert_eq!(d.underline_color.as_deref(), Some("Color/Red"));
    assert_eq!(d.double_strikethrough, Some(true));
}

#[test]
fn a_highlight_is_written_as_the_highlight_underline__feat__doc_word_character_model() {
    let source = pkg::simple("", pkg::STORY_BODY, pkg::STYLES);
    let mut doc = pkg::open(&source);
    {
        let run = &mut doc.stories[0].story.paragraphs[0].runs[0];
        run.point_size = Some(10.0);
        run.decorations.highlight_color = Some("Color/Yellow".into());
    }
    let out = write_idml(&doc, &source).expect("write");
    let xml = story_xml(&out);
    for attr in [
        r#"Underline="true""#,
        r#"UnderlineColor="Color/Yellow""#,
        r#"UnderlineWeight="10""#,
        r#"UnderlineOffset="-3""#,
    ] {
        assert!(xml.contains(attr), "{attr} in {xml}");
    }
}

#[test]
fn a_paragraphs_own_shading_and_border_are_written__feat__doc_word_paragraph_model() {
    let source = pkg::simple("", pkg::STORY_BODY, pkg::STYLES);
    let mut doc = pkg::open(&source);
    {
        let p = &mut doc.stories[0].story.paragraphs[0];
        p.shading.on = Some(true);
        p.shading.color = Some("Color/Yellow".into());
        p.shading.tint = Some(40.0);
        p.border.on = Some(true);
        p.border.weight = Some(2.0);
    }
    let out = write_idml(&doc, &source).expect("write");
    let xml = story_xml(&out);
    for attr in [
        r#"ParagraphShadingOn="true""#,
        r#"ParagraphShadingColor="Color/Yellow""#,
        r#"ParagraphShadingTint="40""#,
        r#"ParagraphBorderOn="true""#,
        r#"ParagraphBorderWeight="2""#,
    ] {
        assert!(xml.contains(attr), "{attr} in {xml}");
    }
    let back = pkg::open(&out);
    let p = &back.stories[0].story.paragraphs[0];
    assert_eq!(p.shading.tint, Some(40.0));
    assert_eq!(p.border.weight, Some(2.0));
}

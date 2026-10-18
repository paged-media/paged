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

//! A carried-through story whose runs end with the paragraph mark
//! (`<Br/>` — what InDesign writes, and what the minted-story emitter
//! writes) must keep every mark on an unmutated save, and keep it when a
//! run's TEXT is edited. Found by re-saving a minted story: the second
//! save dropped the marks, and InDesign would then have read the
//! paragraphs merged.

use crate::pkg;

use idml_export::write_idml;

const BODY: &str = r#"<ParagraphStyleRange><CharacterStyleRange><Content>First</Content><Br/></CharacterStyleRange></ParagraphStyleRange><ParagraphStyleRange><CharacterStyleRange><Content>Second </Content><Br/></CharacterStyleRange><CharacterStyleRange FontStyle="Bold"><Content>bold</Content><Br/></CharacterStyleRange></ParagraphStyleRange><ParagraphStyleRange><CharacterStyleRange><Content>Third</Content></CharacterStyleRange></ParagraphStyleRange>"#;

#[test]
fn an_unmutated_story_with_marks_is_byte_identical() {
    let source = pkg::simple("", BODY, pkg::STYLES);
    let doc = pkg::open(&source);
    let p = &doc.stories[0].story.paragraphs;
    assert_eq!(p.len(), 3);
    assert_eq!(p[1].runs[0].text, "Second ");
    assert_eq!(
        p[1].runs[1].text, "\nbold",
        "the interior mark lands at the head of the next run"
    );
    pkg::assert_same_package(&source, &write_idml(&doc, &source).expect("write"));
}

#[test]
fn an_edited_run_keeps_its_mark() {
    let source = pkg::simple("", BODY, pkg::STYLES);
    let mut doc = pkg::open(&source);
    doc.stories[0].story.paragraphs[0].runs[0].text = "Erste".into();
    doc.stories[0].story.paragraphs[1].runs[1].text = "\nfett".into();
    let out = write_idml(&doc, &source).expect("write");
    let xml = pkg::entry(&out, "Stories/Story_st1.xml").expect("story");
    assert!(
        xml.contains("<Content>Erste</Content><Br/></CharacterStyleRange>"),
        "{xml}"
    );
    assert!(
        xml.contains("<Content>fett</Content><Br/></CharacterStyleRange>"),
        "{xml}"
    );
    assert_eq!(xml.matches("<Br/>").count(), 3, "{xml}");
    let re = pkg::open(&out);
    let p = &re.stories[0].story.paragraphs;
    assert_eq!(p.len(), 3);
    assert_eq!(p[0].runs[0].text, "Erste");
    assert_eq!(p[1].runs[1].text, "\nfett");
    assert_eq!(p[2].runs[0].text, "Third");
}

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

//! A story tagged with XML takes edits (D-02).
//!
//! InDesign 20.0.1 writes a tagged text range as an `<XMLElement Self
//! MarkupTag>` around its `<Content>` inside the character range (core
//! `xml-structure-probe`; the fixture is its export of a story tagged
//! Article, its paragraphs Title and Body). The writer took the inline
//! element for foreign markup and replayed the range verbatim, so an edit
//! anywhere in a tagged paragraph was lost on save. Now each element's
//! start and end ride the run as pieces at their character offsets, as a
//! tracked insertion's do: the edit is written inside its element, and
//! InDesign reads the saved package with the same structure and the
//! edited Title.

use idml_export::rewrite::rewrite_story;
use idml_import::parse_story;

const SRC: &str = include_str!("fixtures/tagged-story.xml");

fn squash(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[test]
fn an_unmutated_save_is_identical() {
    let st = parse_story(SRC.as_bytes()).expect("parse");
    let out = rewrite_story(SRC.as_bytes(), &st).expect("rewrite");
    assert_eq!(String::from_utf8(out).unwrap(), SRC);
}

#[test]
fn an_edit_in_a_tagged_paragraph_is_written_inside_its_element() {
    let mut st = parse_story(SRC.as_bytes()).expect("parse");
    assert_eq!(
        st.paragraphs[0].runs[0].text,
        "A Tagged Title\nThe tagged body text."
    );
    st.paragraphs[0].runs[0].text = "A NEW Tagged Title\nThe tagged body text.".into();
    let out = String::from_utf8(rewrite_story(SRC.as_bytes(), &st).expect("rewrite")).unwrap();
    let flat = squash(&out);
    assert!(
        flat.contains(
            r#"MarkupTag="XMLTag/Title"><Content>A NEW Tagged Title</Content><Br/></XMLElement>"#
        ),
        "{out}"
    );
    assert!(
        flat.contains(
            r#"MarkupTag="XMLTag/Body"><Content>The tagged body text.</Content></XMLElement>"#
        ),
        "{out}"
    );
    assert!(
        flat.contains(r#"<XMLElement Self="di2i3" MarkupTag="XMLTag/Article" XMLContent="ue3">"#)
    );
    let back = parse_story(out.as_bytes()).expect("reparse");
    assert_eq!(
        back.paragraphs[0].runs[0].text,
        "A NEW Tagged Title\nThe tagged body text."
    );
}

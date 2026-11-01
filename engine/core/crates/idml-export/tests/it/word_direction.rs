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

//! Engine ADR 1051 — a paragraph's direction and a run's direction in
//! IDML: read, written where the model changed them, and kept byte for
//! byte where it did not.
#![allow(non_snake_case)]

use crate::pkg;

use idml_export::write_idml;

const BODY: &str = r#"<ParagraphStyleRange ParagraphDirection="RightToLeftDirection"><CharacterStyleRange CharacterDirection="RightToLeftDirection"><Content>Hello</Content></CharacterStyleRange></ParagraphStyleRange><ParagraphStyleRange><CharacterStyleRange><Content>World</Content></CharacterStyleRange></ParagraphStyleRange>"#;

#[test]
fn directions_round_trip__feat__doc_bidi_paragraph() {
    let source = pkg::simple("", BODY, pkg::STYLES);
    let mut doc = pkg::open(&source);
    let p0 = &doc.stories[0].story.paragraphs[0];
    assert_eq!(
        p0.direction,
        Some(paged_model::ParagraphDirection::RightToLeft)
    );
    assert_eq!(
        p0.runs[0].script.direction,
        Some(paged_model::CharacterDirection::RightToLeft)
    );
    let out = write_idml(&doc, &source).expect("write");
    pkg::assert_same_package(&source, &out);
    // Changed: the first paragraph back to left to right, the second
    // right to left with a right-to-left run.
    {
        let paras = &mut doc.stories[0].story.paragraphs;
        paras[0].direction = Some(paged_model::ParagraphDirection::LeftToRight);
        paras[1].direction = Some(paged_model::ParagraphDirection::RightToLeft);
        paras[1].runs[0].script.direction = Some(paged_model::CharacterDirection::RightToLeft);
    }
    let out = write_idml(&doc, &source).expect("write");
    let back = pkg::open(&out);
    let paras = &back.stories[0].story.paragraphs;
    assert_eq!(
        paras[0].direction,
        Some(paged_model::ParagraphDirection::LeftToRight)
    );
    assert_eq!(
        paras[1].direction,
        Some(paged_model::ParagraphDirection::RightToLeft)
    );
    assert_eq!(
        paras[1].runs[0].script.direction,
        Some(paged_model::CharacterDirection::RightToLeft)
    );
}

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

//! Engine ADR 1002 — an `<XMLElement>` tagging a text range knows where it
//! stands in its story, in the story characters `InsertText`, `DeleteRange`
//! and `StoryRange` count.

use idml_import::parse_story;

/// InDesign 20.0.1's own spelling of a story tagged Article whose two
/// paragraphs are tagged Title and Body (core `xml-structure-probe`).
const TAGGED: &str = include_str!("../../../idml-export/tests/fixtures/tagged-story.xml");

fn flat(story: &paged_model::Story) -> String {
    story.flat_text()
}

fn ranged(story: &paged_model::Story) -> Vec<(String, String)> {
    let text: Vec<char> = flat(story).chars().collect();
    story
        .xml_elements
        .iter()
        .flat_map(|top| top.walk())
        .filter_map(|el| {
            let r = el.range?;
            Some((
                el.tag_name().to_string(),
                text[r.start as usize..r.end as usize].iter().collect(),
            ))
        })
        .collect()
}

#[test]
fn indesigns_tagged_paragraphs_stand_where_their_text_is() {
    let story = parse_story(TAGGED.as_bytes()).unwrap();
    assert_eq!(flat(&story), "A Tagged Title\nThe tagged body text.");
    let top = &story.xml_elements[0];
    assert_eq!(top.content.as_deref(), Some("ue3"));
    assert_eq!(
        top.range, None,
        "the story's own element stands for all of it"
    );
    assert_eq!(
        ranged(&story),
        vec![
            ("Title".to_string(), "A Tagged Title".to_string()),
            ("Body".to_string(), "The tagged body text.".to_string()),
        ]
    );
}

#[test]
fn ranges_count_across_paragraphs_and_inside_a_run() {
    let xml = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<idPkg:Story xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="20.0">
<Story Self="s1">
<XMLElement Self="e1" MarkupTag="XMLTag/Story" XMLContent="s1">
<ParagraphStyleRange><CharacterStyleRange><Content>First paragraph</Content><Br/></CharacterStyleRange></ParagraphStyleRange>
<ParagraphStyleRange><CharacterStyleRange><Content>Dear </Content><XMLElement Self="e1i2" MarkupTag="XMLTag/Name"><Content>Ada</Content></XMLElement><Content>, hello.</Content></CharacterStyleRange><CharacterStyleRange FontStyle="Bold"><XMLElement Self="e1i3" MarkupTag="XMLTag/Price"><XMLAttribute Self="e1i3a" Name="label" Value="Price"/><Content>9.99</Content></XMLElement></CharacterStyleRange></ParagraphStyleRange>
</XMLElement>
</Story>
</idPkg:Story>"#;
    let story = parse_story(xml.as_bytes()).unwrap();
    assert_eq!(
        ranged(&story),
        vec![
            ("Name".to_string(), "Ada".to_string()),
            ("Price".to_string(), "9.99".to_string()),
        ]
    );
    let price = story.xml_elements[0].find("e1i3").unwrap();
    assert_eq!(price.attribute("label"), Some("Price"));
}

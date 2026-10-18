/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * This file is part of paged (https://paged.media) and is additionally
 * available under the Paged Media Enterprise License (PMEL). Full
 * copyright and license information is available in LICENSE.md which is
 * distributed with this source code.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    MPL-2.0 OR Paged Media Enterprise License (PMEL)
 */

//! D-02 — a document's XML structure, as InDesign 20.0.1 writes it (core
//! `xml-structure-probe`): the tags in `XML/Tags.xml`, the element tree in
//! `XML/BackingStory.xml`, and in each story the element that tags it with
//! the elements tagging its ranges. Read as trees of `<XMLElement Self
//! MarkupTag XMLContent>` with their `<XMLAttribute Name Value>`s; whatever
//! else a part holds is passed over.

use paged_model::{XmlElement, XmlTag};
use quick_xml::events::{BytesStart, Event};

use crate::util::attr;
use crate::ParseError;

/// The `<XMLTag>`s of `XML/Tags.xml`, with their `TagColor`.
pub fn parse_tags(xml: &[u8]) -> Result<Vec<XmlTag>, ParseError> {
    let mut reader = quick_xml::Reader::from_reader(xml);
    let mut buf = Vec::new();
    let mut out: Vec<XmlTag> = Vec::new();
    let mut in_color = false;
    loop {
        match reader.read_event_into(&mut buf)? {
            Event::Start(e) | Event::Empty(e) if e.name().as_ref() == b"XMLTag" => {
                out.push(XmlTag {
                    self_id: attr(&e, b"Self").unwrap_or_default(),
                    name: attr(&e, b"Name").unwrap_or_default(),
                    color: None,
                });
            }
            Event::Start(e) if e.name().as_ref() == b"TagColor" => in_color = true,
            Event::End(e) if e.name().as_ref() == b"TagColor" => in_color = false,
            Event::Text(t) if in_color => {
                if let (Some(tag), Ok(text)) = (out.last_mut(), t.decode()) {
                    let text = text.trim();
                    if !text.is_empty() {
                        tag.color = Some(text.to_string());
                    }
                }
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }
    Ok(out)
}

/// The outermost `<XMLElement>`s of a part, each with its subtree: the back
/// story's root, or the element that tags a story.
pub fn parse_elements(xml: &[u8]) -> Result<Vec<XmlElement>, ParseError> {
    let mut reader = quick_xml::Reader::from_reader(xml);
    let mut buf = Vec::new();
    let mut roots: Vec<XmlElement> = Vec::new();
    let mut stack: Vec<XmlElement> = Vec::new();
    let attach =
        |el: XmlElement, stack: &mut Vec<XmlElement>, roots: &mut Vec<XmlElement>| match stack
            .last_mut()
        {
            Some(parent) => parent.children.push(el),
            None => roots.push(el),
        };
    loop {
        match reader.read_event_into(&mut buf)? {
            Event::Start(e) if e.name().as_ref() == b"XMLElement" => stack.push(element(&e)),
            Event::Empty(e) if e.name().as_ref() == b"XMLElement" => {
                attach(element(&e), &mut stack, &mut roots)
            }
            Event::End(e) if e.name().as_ref() == b"XMLElement" => {
                if let Some(el) = stack.pop() {
                    attach(el, &mut stack, &mut roots);
                }
            }
            Event::Start(e) | Event::Empty(e) if e.name().as_ref() == b"XMLAttribute" => {
                if let Some(el) = stack.last_mut() {
                    el.attributes.push((
                        attr(&e, b"Name").unwrap_or_default(),
                        attr(&e, b"Value").unwrap_or_default(),
                    ));
                }
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }
    Ok(roots)
}

fn element(e: &BytesStart) -> XmlElement {
    XmlElement {
        self_id: attr(e, b"Self").unwrap_or_default(),
        tag: attr(e, b"MarkupTag").unwrap_or_default(),
        content: attr(e, b"XMLContent"),
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// InDesign 20.0.1's own parts (core `xml-structure-probe`).
    const TAGS: &[u8] = br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<idPkg:Tags xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="20.0">
	<XMLTag Self="XMLTag/Article" Name="Article">
		<Properties>
			<TagColor type="enumeration">Red</TagColor>
		</Properties>
	</XMLTag>
	<XMLTag Self="XMLTag/Root" Name="Root">
		<Properties>
			<TagColor type="enumeration">LightBlue</TagColor>
		</Properties>
	</XMLTag>
</idPkg:Tags>"#;

    const BACKING: &[u8] = br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<idPkg:BackingStory xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="20.0">
	<XmlStory Self="ub1" UserText="true">
		<ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/$ID/NormalParagraphStyle">
			<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]">
				<XMLElement Self="di2" MarkupTag="XMLTag/Root">
					<XMLElement Self="di2i3" MarkupTag="XMLTag/Article" XMLContent="ue3" />
					<XMLElement Self="di2i5" MarkupTag="XMLTag/Figure" XMLContent="ufb">
						<XMLAttribute Self="di2i5XMLAttributenalt" Name="alt" Value="A grey box" />
					</XMLElement>
				</XMLElement>
				<Content>&#xFEFF;</Content>
			</CharacterStyleRange>
		</ParagraphStyleRange>
	</XmlStory>
</idPkg:BackingStory>"#;

    #[test]
    fn tags_are_read_with_their_colours() {
        let tags = parse_tags(TAGS).unwrap();
        assert_eq!(tags.len(), 2);
        assert_eq!(tags[0].self_id, "XMLTag/Article");
        assert_eq!(tags[0].name, "Article");
        assert_eq!(tags[0].color.as_deref(), Some("Red"));
    }

    #[test]
    fn the_back_story_is_the_root_and_its_tree() {
        let roots = parse_elements(BACKING).unwrap();
        assert_eq!(roots.len(), 1);
        let root = &roots[0];
        assert_eq!(root.tag, "XMLTag/Root");
        assert_eq!(root.children.len(), 2);
        assert_eq!(root.children[0].content.as_deref(), Some("ue3"));
        let fig = &root.children[1];
        assert_eq!(fig.tag, "XMLTag/Figure");
        assert_eq!(
            fig.attributes,
            vec![("alt".to_string(), "A grey box".to_string())]
        );
    }
}

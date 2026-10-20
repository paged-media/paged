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

//! ADR 206 — a caret or a range reads the EFFECTIVE text attributes: the
//! run's own over its character style over its paragraph style's based-on
//! chain, the cascade the composer sets the text with.
//!
//! It did not: the read reported the run's local override only, so text
//! whose size came from its paragraph style read `null` and the control
//! bar showed the 12 pt default (a 30 pt heading, 8.5 pt body type). A
//! range whose runs set the same size two ways read mixed, and one over two
//! paragraphs styled 30 and 8.5 read uniform.

use std::io::{Cursor, Write};

use paged_canvas::channel::Mutation;
use paged_canvas::{CanvasModel, CanvasOptions, ReadError};
use paged_mutate::Value;
use paged_wire::Address;

const PKG: &str = r#"xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging""#;

/// `Base` sets the type; `Head` is based on it and sets none of it; `Body`
/// sets its own size; the `Tiny` character style sets a smaller one.
const STYLES: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<idPkg:Styles xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="20.0">
  <RootCharacterStyleGroup Self="rc">
    <CharacterStyle Self="CharacterStyle/$ID/[No character style]" Name="$ID/[No character style]"/>
    <CharacterStyle Self="CharacterStyle/Tiny" Name="Tiny" PointSize="6" Tracking="-10"/>
  </RootCharacterStyleGroup>
  <RootParagraphStyleGroup Self="rp">
    <ParagraphStyle Self="ParagraphStyle/$ID/[No paragraph style]" Name="$ID/[No paragraph style]"/>
    <ParagraphStyle Self="ParagraphStyle/Base" Name="Base" PointSize="30" Leading="36" Tracking="25" FillColor="Color/Red" Justification="CenterAlign" SpaceBefore="6">
      <Properties><AppliedFont type="string">Inter</AppliedFont></Properties>
    </ParagraphStyle>
    <ParagraphStyle Self="ParagraphStyle/Head" Name="Head">
      <Properties><BasedOn type="object">ParagraphStyle/Base</BasedOn></Properties>
    </ParagraphStyle>
    <ParagraphStyle Self="ParagraphStyle/Body" Name="Body" PointSize="8.5"/>
  </RootParagraphStyleGroup>
</idPkg:Styles>"#;

/// Story `st1`: "Heading" (0..7, style `Head`), then the `Body` paragraph
/// "Body small big" (7..21): "Body " plain, "small" in `Tiny`, " big" with
/// a local 14 pt.
fn package(story_body: &str) -> Vec<u8> {
    let designmap = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<Document DOMVersion="20.0" Self="d" {PKG}>
<idPkg:Styles src="Resources/Styles.xml"/>
<Layer Self="ub6" Name="Layer 1" Visible="true" Locked="false" Printable="true"/>
<idPkg:Spread src="Spreads/Spread_s1.xml"/>
<idPkg:Story src="Stories/Story_st1.xml"/>
</Document>"#
    );
    let spread = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Spread {PKG} DOMVersion="20.0">
<Spread Self="s1" PageCount="1" BindingLocation="0" ItemTransform="1 0 0 1 0 0">
<Page Self="p1" Name="1" GeometricBounds="0 0 720 540" ItemTransform="1 0 0 1 0 0"/>
<TextFrame Self="tf1" ParentStory="st1" GeometricBounds="48 48 400 480" ItemTransform="1 0 0 1 0 0"/>
</Spread></idPkg:Spread>"#
    );
    let story = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Story {PKG} DOMVersion="20.0">
<Story Self="st1">{story_body}</Story></idPkg:Story>"#
    );
    let mut buf = Vec::new();
    {
        let mut zip = zip::ZipWriter::new(Cursor::new(&mut buf));
        let stored = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        let deflated = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        zip.start_file("mimetype", stored).unwrap();
        zip.write_all(b"application/vnd.adobe.indesign-idml-package")
            .unwrap();
        for (name, body) in [
            ("designmap.xml", designmap.as_str()),
            ("Resources/Styles.xml", STYLES),
            ("Spreads/Spread_s1.xml", spread.as_str()),
            ("Stories/Story_st1.xml", story.as_str()),
        ] {
            zip.start_file(name, deflated).unwrap();
            zip.write_all(body.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
    }
    buf
}

const STYLED: &str = r#"<ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/Head"><CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]"><Content>Heading</Content><Br/></CharacterStyleRange></ParagraphStyleRange><ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/Body"><CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]"><Content>Body </Content></CharacterStyleRange><CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Tiny"><Content>small</Content></CharacterStyleRange><CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]" PointSize="14"><Content> big</Content></CharacterStyleRange></ParagraphStyleRange>"#;

fn load(story: &str) -> CanvasModel {
    CanvasModel::load("caret-effective", &package(story), CanvasOptions::default()).expect("load")
}

/// Where the second paragraph starts in the story's character space.
fn body_start(m: &CanvasModel) -> u32 {
    let story = &m.scene().stories[0].story;
    story.paragraphs[0]
        .runs
        .iter()
        .map(|r| r.text.chars().count() as u32)
        .sum()
}

fn get(m: &CanvasModel, start: u32, end: u32, path: &str) -> Result<Value, ReadError> {
    m.read_property(&format!("storyRange:st1@{start}..{end}"), path)
}

fn size(m: &CanvasModel, start: u32, end: u32) -> Result<Value, ReadError> {
    get(m, start, end, "characterFontSize")
}

fn pt(n: f32) -> Result<Value, ReadError> {
    Ok(Value::Length(Some(n)))
}

#[test]
fn a_caret_reads_the_size_its_paragraph_styles_based_on_chain_sets() {
    let m = load(STYLED);
    assert_eq!(size(&m, 3, 3), pt(30.0), "caret inside the heading");
    assert_eq!(size(&m, 0, 0), pt(30.0), "caret at the story start");
    assert_eq!(size(&m, 0, 7), pt(30.0), "the heading as a range");
    // Everything else `Base` sets reaches the heading the same way.
    assert_eq!(get(&m, 3, 3, "characterLeading"), pt(36.0));
    assert_eq!(get(&m, 3, 3, "characterTracking"), pt(25.0));
    assert_eq!(
        get(&m, 3, 3, "characterFillColor"),
        Ok(Value::ColorRef(Some("Color/Red".into())))
    );
    assert_eq!(
        get(&m, 3, 3, "characterFontFamily"),
        Ok(Value::Text("Inter".into()))
    );
    assert_eq!(
        get(&m, 3, 3, "paragraphJustification"),
        Ok(Value::Text("CenterAlign".into()))
    );
    assert_eq!(get(&m, 3, 3, "paragraphSpaceBefore"), pt(6.0));
    // The applied style itself is still the one the paragraph names.
    assert_eq!(
        get(&m, 3, 3, "appliedParagraphStyle"),
        Ok(Value::Text("ParagraphStyle/Head".into()))
    );
}

#[test]
fn character_style_and_local_overrides_win_over_the_paragraph_style() {
    let m = load(STYLED);
    let b = body_start(&m);
    assert_eq!(size(&m, b + 2, b + 2), pt(8.5), "caret in plain body text");
    assert_eq!(size(&m, b, b + 5), pt(8.5), "\"Body \"");
    assert_eq!(size(&m, b + 5, b + 10), pt(6.0), "\"small\" in Tiny");
    assert_eq!(get(&m, b + 5, b + 10, "characterTracking"), pt(-10.0));
    assert_eq!(size(&m, b + 10, b + 14), pt(14.0), "\" big\" set locally");
}

#[test]
fn a_range_is_mixed_only_when_the_effective_values_differ() {
    let mut m = load(STYLED);
    let b = body_start(&m);
    // Two paragraphs that both inherit, at 30 and 8.5: mixed (it read as
    // one inherited `null` before).
    assert_eq!(size(&m, 2, b + 3), Err(ReadError::Mixed));
    // One paragraph whose runs differ.
    assert_eq!(size(&m, b, b + 14), Err(ReadError::Mixed));
    // A local 30 next to an inherited 30 is one size (it read mixed).
    m.apply_mutation(&Mutation::Set {
        address: Address::parse("storyRange:st1@0..3").unwrap(),
        path: "characterFontSize".into(),
        value: Value::Length(Some(30.0)),
    })
    .expect("set a local size");
    assert_eq!(size(&m, 0, 7), pt(30.0));
}

#[test]
fn unstyled_text_reads_the_size_it_is_set_at() {
    let m = load(
        r#"<ParagraphStyleRange><CharacterStyleRange><Content>Plain</Content></CharacterStyleRange></ParagraphStyleRange>"#,
    );
    assert_eq!(size(&m, 2, 2), pt(12.0));
    assert_eq!(size(&m, 0, 5), pt(12.0));
    // Nothing names a leading: auto, which reads as no length.
    assert_eq!(get(&m, 2, 2, "characterLeading"), Ok(Value::Length(None)));
}

/// The snapshot (`RequestElementProperties`) still reports what the range
/// itself sets: a consumer that copies a range's formatting (the data
/// merge) must copy the overrides, not bake the style's values in.
#[test]
fn the_snapshot_reports_what_the_range_itself_sets() {
    use paged_canvas::element_selection::ElementId;
    use paged_mutate::PropertyPath;
    let m = load(STYLED);
    let b = body_start(&m);
    let snapshot = |start: u32, end: u32, path: PropertyPath| {
        let id = ElementId::StoryRange {
            story_id: "st1".into(),
            start,
            end,
        };
        m.element_properties(&id)
            .expect("a range")
            .entries
            .into_iter()
            .find(|e| e.path == path)
            .and_then(|e| e.value)
    };
    assert_eq!(
        snapshot(0, 7, PropertyPath::CharacterFontSize),
        Some(Value::Length(None)),
        "the heading inherits its size"
    );
    assert_eq!(
        snapshot(0, 7, PropertyPath::ParagraphJustification),
        Some(Value::Text(String::new()))
    );
    assert_eq!(
        snapshot(b + 10, b + 14, PropertyPath::CharacterFontSize),
        Some(Value::Length(Some(14.0))),
        "a local size is the range's own"
    );
}

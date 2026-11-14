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

//! Document X-Ray (engine ADR 1309): an item explains itself from the
//! model — the style cascade per property with the winning level and the
//! levels it shadows, the lock and visibility reasons, the link, the data
//! binding, the thread and its overset, the object style, and what editing
//! a style changes. Each answer here is one the document states; nothing
//! is inferred.

use std::io::{Cursor, Write};

use paged_canvas::channel::Mutation;
use paged_canvas::explain::{
    ExplainAspect, Explanation, HiddenReason, LockReason, PropertyFact, ValueSource,
};
use paged_canvas::{CanvasModel, CanvasOptions, ElementId};
use serde_json::json;

const PKG: &str = r#"xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging""#;

/// `Base` sets the type and black; `Body` is based on it and makes it red;
/// `Head` is based on `Body` and sets a larger size; `Emph` makes text
/// blue. `BoxChild` is based on `Box`, which fills red.
const STYLES: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<idPkg:Styles xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="20.0">
  <RootCharacterStyleGroup Self="rc">
    <CharacterStyle Self="CharacterStyle/$ID/[No character style]" Name="$ID/[No character style]"/>
    <CharacterStyle Self="CharacterStyle/Emph" Name="Emph" FillColor="Color/Blue"/>
  </RootCharacterStyleGroup>
  <RootParagraphStyleGroup Self="rp">
    <ParagraphStyle Self="ParagraphStyle/$ID/[No paragraph style]" Name="$ID/[No paragraph style]"/>
    <ParagraphStyle Self="ParagraphStyle/Base" Name="Base" PointSize="10" Leading="12" FillColor="Color/Black" SpaceAfter="6"/>
    <ParagraphStyle Self="ParagraphStyle/Body" Name="Body" FillColor="Color/Red">
      <Properties><BasedOn type="object">ParagraphStyle/Base</BasedOn></Properties>
    </ParagraphStyle>
    <ParagraphStyle Self="ParagraphStyle/Head" Name="Head" PointSize="18">
      <Properties><BasedOn type="object">ParagraphStyle/Body</BasedOn></Properties>
    </ParagraphStyle>
  </RootParagraphStyleGroup>
  <RootObjectStyleGroup Self="ro">
    <ObjectStyle Self="ObjectStyle/$ID/[None]" Name="$ID/[None]"/>
    <ObjectStyle Self="ObjectStyle/Box" Name="Box" FillColor="Color/Red"/>
    <ObjectStyle Self="ObjectStyle/BoxChild" Name="BoxChild">
      <Properties><BasedOn type="object">ObjectStyle/Box</BasedOn></Properties>
    </ObjectStyle>
  </RootObjectStyleGroup>
</idPkg:Styles>"#;

/// Story `st1`: "Plain " + "emph" (`Emph`) + " big" (a local 14 pt), all
/// `Body`; then "Heading" in `Head`.
const STORY1: &str = r#"<ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/Body"><CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]"><Content>Plain </Content></CharacterStyleRange><CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Emph"><Content>emph</Content></CharacterStyleRange><CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]" PointSize="14"><Content> big</Content><Br/></CharacterStyleRange></ParagraphStyleRange><ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/Head"><CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]"><Content>Heading</Content></CharacterStyleRange></ParagraphStyleRange>"#;

/// Story `st2`: far more text than its two small frames hold.
fn story2() -> String {
    let text =
        "Threaded text runs from the first frame into the second and on past it. ".repeat(12);
    format!(
        r#"<ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/Base"><CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]"><Content>{text}</Content></CharacterStyleRange></ParagraphStyleRange>"#
    )
}

fn rect(id: &str, top: f32, extra: &str, inner: &str) -> String {
    format!(
        r#"<Rectangle Self="{id}" GeometricBounds="{top} 300 {} 380" ItemTransform="1 0 0 1 0 0" {extra}>{inner}</Rectangle>"#,
        top + 40.0
    )
}

fn package() -> Vec<u8> {
    let designmap = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<Document DOMVersion="20.0" Self="d" {PKG}>
<idPkg:Styles src="Resources/Styles.xml"/>
<Layer Self="lBody" Name="Body" Visible="true" Locked="false" Printable="true"/>
<Layer Self="lLock" Name="Locked art" Visible="true" Locked="true" Printable="true"/>
<Layer Self="lNotes" Name="Notes" Visible="false" Locked="false" Printable="false"/>
<idPkg:Spread src="Spreads/Spread_s1.xml"/>
<idPkg:Story src="Stories/Story_st1.xml"/>
<idPkg:Story src="Stories/Story_st2.xml"/>
</Document>"#
    );
    let image = |link: &str| {
        format!(
            r#"<Image Self="{link}i" ItemTransform="1 0 0 1 0 0"><Link Self="{link}" LinkResourceURI="file:///nowhere/photo.jpg"/></Image>"#
        )
    };
    let items = [
        r#"<TextFrame Self="tf1" ParentStory="st1" ItemLayer="lBody" GeometricBounds="48 48 300 260" ItemTransform="1 0 0 1 0 0"/>"#.to_string(),
        rect("r1", 48.0, r#"ItemLayer="lBody" Locked="true" AppliedObjectStyle="ObjectStyle/BoxChild""#, ""),
        rect("r2", 100.0, r#"ItemLayer="lLock" FillColor="Color/Blue""#, ""),
        rect("r3", 150.0, r#"ItemLayer="lNotes""#, ""),
        rect("img1", 200.0, r#"ItemLayer="lBody""#, &image("ln1")),
        rect("img2", 250.0, r#"ItemLayer="lBody""#, &image("ln2")),
        rect("d1", 300.0, r#"ItemLayer="lBody""#, ""),
        r#"<TextFrame Self="tf2" ParentStory="st2" NextTextFrame="tf3" ItemLayer="lBody" GeometricBounds="400 48 460 200" ItemTransform="1 0 0 1 0 0"/>"#.to_string(),
        r#"<TextFrame Self="tf3" ParentStory="st2" PreviousTextFrame="tf2" ItemLayer="lBody" GeometricBounds="400 260 460 412" ItemTransform="1 0 0 1 0 0"/>"#.to_string(),
    ]
    .join("\n");
    let spread = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Spread {PKG} DOMVersion="20.0">
<Spread Self="s1" PageCount="1" BindingLocation="0" ItemTransform="1 0 0 1 0 0">
<Page Self="p1" Name="1" GeometricBounds="0 0 792 612" ItemTransform="1 0 0 1 0 0"/>
{items}
</Spread></idPkg:Spread>"#
    );
    let story = |id: &str, body: &str| {
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Story {PKG} DOMVersion="20.0">
<Story Self="{id}">{body}</Story></idPkg:Story>"#
        )
    };
    let st1 = story("st1", STORY1);
    let st2 = story("st2", &story2());
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
            ("Stories/Story_st1.xml", st1.as_str()),
            ("Stories/Story_st2.xml", st2.as_str()),
        ] {
            zip.start_file(name, deflated).unwrap();
            zip.write_all(body.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
    }
    buf
}

fn model() -> CanvasModel {
    CanvasModel::load(
        "xray",
        &package(),
        CanvasOptions {
            fonts: vec![include_bytes!("../../../../corpus/fonts/Inter.ttf").to_vec()],
            ..Default::default()
        },
    )
    .expect("load")
}

fn caret(story: &str, at: u32) -> ElementId {
    ElementId::StoryRange {
        story_id: story.into(),
        start: at,
        end: at,
        cell: None,
        paragraph: None,
    }
}

fn fact<'a>(x: &'a Explanation, name: &str) -> &'a PropertyFact {
    x.text
        .as_ref()
        .expect("text facts")
        .properties
        .iter()
        .find(|p| p.property == name)
        .unwrap_or_else(|| panic!("no {name}"))
}

fn style_source(source: &ValueSource) -> (String, u32) {
    match source {
        ValueSource::Style { style, depth } => (style.name.clone(), *depth),
        other => panic!("not a style: {other:?}"),
    }
}

#[test]
fn a_colour_names_the_style_that_sets_it_and_what_it_shadows() {
    let m = model();
    // Inside "Plain ": Body sets red, over Base's black.
    let x = m.explain(&caret("st1", 3), ExplainAspect::All);
    assert!(x.found, "{x:?}");
    let text = x.text.as_ref().unwrap();
    let chain: Vec<&str> = text
        .paragraph_style
        .chain
        .iter()
        .map(|s| s.name.as_str())
        .collect();
    assert_eq!(chain, ["Body", "Base"]);
    assert!(text.character_style.is_none());
    let fill = fact(&x, "fillColor");
    assert_eq!(fill.value, json!("Color/Red"));
    assert_eq!(style_source(&fill.source), ("Body".into(), 0));
    assert_eq!(fill.shadowed.len(), 1);
    assert_eq!(fill.shadowed[0].value, json!("Color/Black"));
    assert_eq!(style_source(&fill.shadowed[0].source), ("Base".into(), 1));
    // The size comes from further down the chain.
    let size = fact(&x, "pointSize");
    assert_eq!(size.value, json!(10.0));
    assert_eq!(style_source(&size.source), ("Base".into(), 1));
    // Spacing too: "which style determines this spacing?"
    let after = fact(&x, "spaceAfter");
    assert_eq!(after.value, json!(6.0));
    assert_eq!(style_source(&after.source), ("Base".into(), 1));
    // Nothing sets the tracking: the engine's default, said so.
    let tracking = fact(&x, "tracking");
    assert_eq!(tracking.source, ValueSource::Default);
    assert_eq!(tracking.value, json!(0.0));
    assert_eq!(text.overrides, 0);
}

#[test]
fn a_local_override_and_a_character_style_win_and_say_so() {
    let m = model();
    // "emph" (6..10) is in the Emph character style: blue over red over black.
    let x = m.explain(&caret("st1", 8), ExplainAspect::All);
    let text = x.text.as_ref().unwrap();
    let cs: Vec<&str> = text
        .character_style
        .as_ref()
        .expect("character style")
        .chain
        .iter()
        .map(|s| s.name.as_str())
        .collect();
    assert_eq!(cs, ["Emph"]);
    let fill = fact(&x, "fillColor");
    assert_eq!(fill.value, json!("Color/Blue"));
    assert_eq!(style_source(&fill.source), ("Emph".into(), 0));
    assert_eq!(fill.shadowed.len(), 2, "Body's red and Base's black");
    // " big" (10..14) is set to 14 pt locally, over Base's 10.
    let x = m.explain(&caret("st1", 12), ExplainAspect::All);
    let size = fact(&x, "pointSize");
    assert_eq!(size.value, json!(14.0));
    assert_eq!(size.source, ValueSource::Character);
    assert_eq!(style_source(&size.shadowed[0].source), ("Base".into(), 1));
    assert_eq!(x.text.as_ref().unwrap().overrides, 1);
    // A range across both runs is mixed; its facts are its first character's.
    let x = m.explain(
        &ElementId::StoryRange {
            story_id: "st1".into(),
            start: 6,
            end: 14,
            cell: None,
            paragraph: None,
        },
        ExplainAspect::All,
    );
    assert!(x.text.as_ref().unwrap().mixed);
    assert_eq!(fact(&x, "fillColor").value, json!("Color/Blue"));
}

#[test]
fn a_based_on_style_two_levels_down_still_answers() {
    let m = model();
    // "Heading" starts at 14: Head sets the size, Body (depth 1) the colour.
    let x = m.explain(&caret("st1", 16), ExplainAspect::All);
    let text = x.text.as_ref().unwrap();
    assert_eq!(text.paragraph, 1);
    let chain: Vec<&str> = text
        .paragraph_style
        .chain
        .iter()
        .map(|s| s.name.as_str())
        .collect();
    assert_eq!(chain, ["Head", "Body", "Base"]);
    assert_eq!(
        style_source(&fact(&x, "pointSize").source),
        ("Head".into(), 0)
    );
    assert_eq!(
        style_source(&fact(&x, "fillColor").source),
        ("Body".into(), 1)
    );
    // The text frame of the story names the frame's page and layer.
    assert_eq!(x.page.as_ref().map(|p| p.index), Some(0));
    assert_eq!(x.layer.as_ref().map(|l| l.name.as_str()), Some("Body"));
}

#[test]
fn editing_a_style_names_the_pages_and_the_styles_based_on_it() {
    let m = model();
    let x = m.explain(&caret("st1", 3), ExplainAspect::All);
    let body = x
        .dependents
        .iter()
        .find(|d| d.style.name == "Body")
        .expect("Body's dependents");
    // Body's own paragraph and Head's, which is based on it.
    assert_eq!(body.uses, 2);
    assert_eq!(body.stories, 1);
    assert_eq!(
        body.based_on_it
            .iter()
            .map(|s| s.name.as_str())
            .collect::<Vec<_>>(),
        ["Head"]
    );
    assert_eq!(body.pages, [0]);
    assert_eq!(body.items, ["tf1"]);
    assert_eq!(body.unplaced, 0);
    // Base reaches both stories' paragraphs.
    let base = m.style_dependents(&x.text.as_ref().unwrap().paragraph_style.chain[1]);
    assert_eq!(base.stories, 2);
    assert_eq!(base.uses, 3);
}

#[test]
fn a_lock_says_whose_it_is() {
    let mut m = model();
    let own = m.explain(&ElementId::Rectangle("r1".into()), ExplainAspect::All);
    assert!(own.lock.locked);
    assert_eq!(own.lock.reasons, [LockReason::Item]);
    let layer = m.explain(&ElementId::Rectangle("r2".into()), ExplainAspect::All);
    assert!(layer.lock.locked);
    assert_eq!(
        layer.lock.reasons,
        [LockReason::Layer {
            id: "lLock".into(),
            name: "Locked art".into()
        }]
    );
    let free = m.explain(&ElementId::Rectangle("img1".into()), ExplainAspect::All);
    assert!(!free.lock.locked, "{:?}", free.lock);
    // A viewer may move nothing: the role is a reason of its own.
    m.set_session_policy(paged_template::SessionPolicy {
        role: paged_template::Role::Viewer,
        overrides: Vec::new(),
    });
    let viewed = m.explain(&ElementId::Rectangle("img1".into()), ExplainAspect::All);
    let role = viewed
        .lock
        .reasons
        .iter()
        .find_map(|r| match r {
            LockReason::Role { role, denied } => Some((role.clone(), denied.clone())),
            _ => None,
        })
        .expect("a role reason");
    assert_eq!(role.0, "viewer");
    assert!(role.1.iter().any(|p| p == "item.move"), "{role:?}");
    assert!(role.1.iter().any(|p| p == "image.replace"), "{role:?}");
    assert!(!viewed.link.as_ref().unwrap().replace_permitted);
}

#[test]
fn a_hidden_layer_hides_and_does_not_print() {
    let m = model();
    let x = m.explain(&ElementId::Rectangle("r3".into()), ExplainAspect::All);
    assert!(!x.visibility.visible);
    assert!(!x.visibility.prints);
    assert!(x.visibility.reasons.contains(&HiddenReason::Layer {
        id: "lNotes".into(),
        name: "Notes".into()
    }));
    assert!(x
        .visibility
        .reasons
        .contains(&HiddenReason::LayerNonprinting {
            id: "lNotes".into(),
            name: "Notes".into()
        }));
}

#[test]
fn a_fill_from_an_object_style_names_the_style_down_the_chain() {
    let m = model();
    let x = m.explain(&ElementId::Rectangle("r1".into()), ExplainAspect::All);
    let chain: Vec<&str> = x
        .object_style
        .as_ref()
        .expect("object style")
        .chain
        .iter()
        .map(|s| s.name.as_str())
        .collect();
    assert_eq!(chain, ["BoxChild", "Box"]);
    let fill = x
        .appearance
        .iter()
        .find(|p| p.property == "fillColor")
        .unwrap();
    assert_eq!(fill.value, json!("Color/Red"));
    assert_eq!(style_source(&fill.source), ("Box".into(), 1));
    // The item's own fill wins over nothing below it.
    let own = m.explain(&ElementId::Rectangle("r2".into()), ExplainAspect::All);
    let fill = own
        .appearance
        .iter()
        .find(|p| p.property == "fillColor")
        .unwrap();
    assert_eq!(fill.source, ValueSource::Item);
    assert_eq!(fill.value, json!("Color/Blue"));
    // The object style's dependents: the one item using BoxChild.
    let boxes = x
        .dependents
        .iter()
        .find(|d| d.style.name == "BoxChild")
        .unwrap();
    assert_eq!(boxes.uses, 1);
    assert_eq!(boxes.items, ["r1"]);
}

#[test]
fn a_picture_says_where_it_comes_from_and_what_shares_it() {
    let m = model();
    let x = m.explain(&ElementId::Rectangle("img1".into()), ExplainAspect::All);
    let link = x.link.as_ref().expect("a link");
    assert_eq!(link.uri, "file:///nowhere/photo.jpg");
    assert_eq!(link.status, "missing");
    assert!(!link.embedded);
    assert_eq!(link.same_link, ["img2"], "relinking changes img2 too");
    assert!(link.replace_permitted);
}

#[test]
fn a_thread_names_its_neighbours_and_how_much_is_overset() {
    let m = model();
    let first = m.explain(&ElementId::TextFrame("tf2".into()), ExplainAspect::All);
    let flow = first.flow.as_ref().expect("flow");
    assert_eq!(flow.frames, ["tf2", "tf3"]);
    assert_eq!(flow.index, Some(0));
    assert_eq!(flow.previous, None);
    assert_eq!(flow.next.as_deref(), Some("tf3"));
    let last = m.explain(&ElementId::TextFrame("tf3".into()), ExplainAspect::All);
    let flow = last.flow.as_ref().unwrap();
    assert_eq!(flow.previous.as_deref(), Some("tf2"));
    assert!(flow.overset, "{flow:?}");
    assert!(flow.overset_characters > 0);
    let from = flow.overset_from.expect("where the overset starts");
    assert_eq!(flow.characters - from, flow.overset_characters);
    // The story's own frame (tf1) is not overset.
    let tf1 = m.explain(&ElementId::TextFrame("tf1".into()), ExplainAspect::All);
    assert!(!tf1.flow.as_ref().unwrap().overset);
    assert_eq!(tf1.flow.as_ref().unwrap().overset_characters, 0);
}

#[test]
fn a_data_binding_names_its_field_and_source_and_not_a_record() {
    let mut m = model();
    let label = r#"{"v":1,"data":{"oid":"pd-1","bind":[{"id":"b1","kind":"variable","target":"$host","query":"q1","expr":"product.name"}],"queries":[{"id":"q1","source":"s1"}],"sources":[{"id":"s1","name":"Products"}]}}"#;
    m.apply_mutation(&Mutation::SetPluginMetadata {
        element_id: ElementId::Rectangle("d1".into()),
        key: "x-paged:media.paged.data".into(),
        value: Some(label.into()),
        caller: None,
    })
    .expect("label");
    let x = m.explain(&ElementId::Rectangle("d1".into()), ExplainAspect::All);
    let b = x
        .bindings
        .iter()
        .find(|b| b.origin == "data")
        .expect("a data binding");
    assert_eq!(b.kind, "variable");
    assert_eq!(b.field.as_deref(), Some("product.name"));
    assert_eq!(b.query.as_deref(), Some("q1"));
    assert_eq!(b.source.as_deref(), Some("Products"));
    assert!(x.unknown.iter().any(|u| u.fact == "binding.record"));
    // The answer holds for the document as it stands.
    assert_eq!(x.revision, m.document_revision());
}

#[test]
fn an_overview_is_cheap_and_an_unknown_id_is_not_found() {
    let m = model();
    let x = m.explain(&ElementId::Rectangle("r1".into()), ExplainAspect::Overview);
    assert!(x.found);
    assert!(x.object_style.is_some());
    assert!(x.appearance.is_empty() && x.dependents.is_empty());
    let none = m.explain(&ElementId::Rectangle("nope".into()), ExplainAspect::All);
    assert!(!none.found);
}

#[test]
fn explaining_changes_nothing() {
    let m = model();
    let before = (
        m.current_state_hash(),
        m.applied_log_len(),
        m.document_revision(),
    );
    for id in [
        caret("st1", 3),
        ElementId::Rectangle("r1".into()),
        ElementId::TextFrame("tf3".into()),
    ] {
        let _ = m.explain(&id, ExplainAspect::All);
    }
    assert_eq!(
        before,
        (
            m.current_state_hash(),
            m.applied_log_len(),
            m.document_revision()
        )
    );
}

#[test]
fn a_caret_in_the_editors_units_explains_the_character_it_names() {
    let m = model();
    // "Heading" starts at character 14; the caret counts one separator
    // before it, so content offset 17 stands after character 15.
    let sel = paged_canvas::selection::ContentSelection::caret("st1", 17);
    let x = m.explain_selection(&sel, ExplainAspect::All);
    let text = x.text.expect("text facts");
    assert_eq!(text.paragraph, 1);
    assert_eq!(text.offset, 15);
    assert_eq!(text.paragraph_style.chain[0].name, "Head");
}

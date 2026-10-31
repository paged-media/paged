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

//! Engine ADR 1045 — an anchored frame's look through the wire, as a
//! module lowering places one: `insertAnchoredFrame`, `bindCreated`, then
//! `setElementProperty` on the handle, ONE batch and ONE undo step. The
//! look draws on the canvas (the anchored frame's story is rebuilt), the
//! undo restores the exact state, and the look survives `.paged` and an
//! IDML round trip, with a stack-only effect reported as an IDML loss.

use std::io::Write;

use paged_canvas::{channel::Mutation, CanvasModel, CanvasOptions, PageId};
use paged_compose::{DisplayCommand, LayerEffect};
use paged_mutate::operation::{EffectEntrySpec, EffectKind};
use paged_mutate::{PropertyPath, Value};
use paged_wire::ElementId;

const PNG: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

fn idml() -> Vec<u8> {
    let mut buf = Vec::new();
    {
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        let mut put = |name: &str, body: &[u8]| {
            zip.start_file(name, opts).unwrap();
            zip.write_all(body).unwrap();
        };
        put("mimetype", b"application/vnd.adobe.indesign-idml-package");
        put(
            "designmap.xml",
            br#"<?xml version="1.0" encoding="UTF-8"?>
<Document DOMVersion="13.1" Self="d1">
<idPkg:Graphic src="Resources/Graphic.xml" xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"/>
<idPkg:Spread src="Spreads/Spread_s1.xml" xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"/>
<idPkg:Story src="Stories/Story_st1.xml" xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"/>
</Document>"#,
        );
        put(
            "Resources/Graphic.xml",
            br#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Graphic xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <Color Self="Color/Black" Model="Process" Space="CMYK" ColorValue="0 0 0 100" Name="Black"/>
  <Color Self="Color/Red" Model="Process" Space="RGB" ColorValue="255 0 0" Name="Red"/>
</idPkg:Graphic>"#,
        );
        put(
            "Spreads/Spread_s1.xml",
            br#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Spread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="13.1">
<Spread Self="s1" PageCount="1">
<Page Self="p1" Name="1" GeometricBounds="0 0 792 612" ItemTransform="1 0 0 1 0 0"/>
<TextFrame Self="tf1" ParentStory="st1" GeometricBounds="72 72 600 540" ItemTransform="1 0 0 1 0 0"/>
</Spread></idPkg:Spread>"#,
        );
        put(
            "Stories/Story_st1.xml",
            br#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Story xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="13.1">
<Story Self="st1"><ParagraphStyleRange><CharacterStyleRange>
<Content>Hello world</Content>
</CharacterStyleRange></ParagraphStyleRange></Story></idPkg:Story>"#,
        );
        zip.finish().unwrap();
    }
    buf
}

fn options() -> CanvasOptions {
    CanvasOptions {
        fonts: vec![include_bytes!("../../../../corpus/fonts/Inter.ttf").to_vec()],
        ..CanvasOptions::default()
    }
}

fn load() -> CanvasModel {
    CanvasModel::load("anchored-effects", &idml(), options()).expect("load")
}

fn set(path: PropertyPath, value: Value) -> Mutation {
    Mutation::SetElementProperty {
        element_id: ElementId::Rectangle("$h:pic".into()),
        path,
        value,
    }
}

/// The batch a module lowering sends for a picture with a look: insert,
/// bind, then the look on the handle.
fn place_with_look(m: &mut CanvasModel, look: Vec<Mutation>) {
    let mut ops = vec![
        Mutation::InsertAnchoredFrame {
            paragraph: None,
            story_id: "st1".into(),
            offset: 0,
            width: 60.0,
            height: 60.0,
            image_uri: Some(PNG.into()),
        },
        Mutation::BindCreated {
            handle: "pic".into(),
        },
    ];
    ops.extend(look);
    m.apply_mutation(&Mutation::Batch { ops }).expect("batch");
}

fn frame(m: &CanvasModel) -> paged_model::AnchoredFrame {
    m.scene().stories[0].story.paragraphs[0].anchored_frames[0].clone()
}

fn commands(m: &CanvasModel) -> Vec<DisplayCommand> {
    let page = PageId(m.pages()[0].self_id.clone());
    m.display_list_for_page(&page)
        .expect("display list")
        .commands
        .clone()
}

fn look() -> Vec<Mutation> {
    vec![
        set(PropertyPath::FrameOpacity, Value::Length(Some(70.0))),
        set(PropertyPath::FrameDropShadow, Value::Bool(true)),
        set(
            PropertyPath::FrameDropShadowXOffset,
            Value::Length(Some(5.0)),
        ),
        set(
            PropertyPath::FrameDropShadowColor,
            Value::ColorRef(Some("Color/Black".into())),
        ),
        set(PropertyPath::FrameFeatherEnabled, Value::Bool(true)),
        set(PropertyPath::FrameFeatherWidth, Value::Length(Some(4.0))),
    ]
}

#[test]
#[allow(non_snake_case)]
fn a_lowering_batch_gives_an_anchored_picture_its_look__feat__anchored_inline_objects_anchored_effects(
) {
    let mut m = load();
    let h0 = m.current_state_hash();
    place_with_look(&mut m, look());
    let f = frame(&m);
    assert_eq!(f.opacity, Some(70.0));
    assert_eq!(f.drop_shadow.as_ref().map(|d| d.x_offset), Some(5.0));
    assert_eq!(
        f.effects
            .as_ref()
            .and_then(|e| e.feather.as_ref())
            .and_then(|f| f.width),
        Some(4.0)
    );
    // It draws on the canvas: the shadow under the picture, the picture
    // inside the feathered run.
    let cmds = commands(&m);
    let at = |f: &dyn Fn(&DisplayCommand) -> bool| cmds.iter().position(f);
    let shadow = at(&|c| matches!(c, DisplayCommand::DropShadow { .. })).expect("shadow");
    let marker = at(&|c| matches!(c, DisplayCommand::BeginFeatheredObject { .. })).expect("marker");
    let picture = at(&|c| matches!(c, DisplayCommand::Image { .. })).expect("picture");
    let feather = at(&|c| matches!(c, DisplayCommand::Feather { .. })).expect("feather");
    assert!(shadow < picture && marker < picture && picture < feather);
    // One undo step for the whole placement, to the exact state.
    m.undo().expect("undo");
    assert_eq!(m.current_state_hash(), h0);
    assert!(m.scene().stories[0].story.paragraphs[0]
        .anchored_frames
        .is_empty());
    m.redo().expect("redo");
    assert_eq!(frame(&m).opacity, Some(70.0));
}

#[test]
#[allow(non_snake_case)]
fn a_later_edit_redraws_the_anchored_frame__feat__anchored_inline_objects_anchored_effects() {
    let mut m = load();
    place_with_look(&mut m, Vec::new());
    assert!(!commands(&m)
        .iter()
        .any(|c| matches!(c, DisplayCommand::PushLayer { .. })));
    let id = frame(&m).self_id.expect("minted");
    let h = m.current_state_hash();
    m.apply_mutation(&Mutation::SetElementProperty {
        element_id: ElementId::Rectangle(id),
        path: PropertyPath::FrameEffectStack,
        value: Value::EffectStack {
            entries: vec![EffectEntrySpec {
                radius_pt: Some(2.0),
                ..EffectEntrySpec::new(EffectKind::GaussianBlur)
            }],
            prev: None,
        },
    })
    .expect("blur");
    assert!(
        commands(&m).iter().any(|c| matches!(
            c,
            DisplayCommand::PushLayer {
                effect: LayerEffect::GaussianBlur { .. },
                ..
            }
        )),
        "the story holding the frame is drawn again"
    );
    m.undo().expect("undo");
    assert_eq!(m.current_state_hash(), h);
}

#[test]
#[allow(non_snake_case)]
fn the_look_survives_paged_and_idml__feat__anchored_inline_objects_anchored_effects() {
    let mut m = load();
    let clean = m.idml_export_losses();
    let mut l = look();
    l.push(set(
        PropertyPath::FrameEffectStack,
        Value::EffectStack {
            entries: vec![
                EffectEntrySpec::new(EffectKind::DropShadow),
                EffectEntrySpec::new(EffectKind::Feather),
                EffectEntrySpec {
                    size_pt: Some(3.0),
                    color: Some("Color/Red".into()),
                    ..EffectEntrySpec::new(EffectKind::OutlineStroke)
                },
            ],
            prev: None,
        },
    ));
    place_with_look(&mut m, l);
    let placed = frame(&m);
    assert_eq!(placed.effect_stack.len(), 3);

    // `.paged`.
    m.refresh_model_part().expect("refresh model part");
    let bytes = m
        .export_paged(paged_canvas::channel::PROTOCOL_VERSION.0)
        .expect("export .paged");
    let reloaded = CanvasModel::load("reloaded", &bytes, options()).expect("reload");
    let again = frame(&reloaded);
    assert_eq!(again.opacity, Some(70.0));
    assert_eq!(again.effect_stack.len(), 3);

    // IDML: InDesign's own settings, the stack in the label, the outline
    // stroke reported.
    let losses: Vec<String> = m
        .idml_export_losses()
        .into_iter()
        .filter(|l| !clean.contains(l))
        .collect();
    assert!(
        losses
            .iter()
            .any(|l| l.contains("`outlineStroke`") && l.contains("anchored frame")),
        "{losses:?}"
    );
    let idml = m.export_idml().expect("export idml");
    let twin = idml_import::import_idml_doc(&idml).expect("twin");
    let read = &twin.stories[0].story.paragraphs[0].anchored_frames[0];
    assert_eq!(read.opacity, Some(70.0));
    assert_eq!(read.drop_shadow.as_ref().map(|d| d.x_offset), Some(5.0));
    assert!(read.effects.as_ref().is_some_and(|e| e.feather.is_some()));
    assert_eq!(
        read.effect_stack
            .iter()
            .map(|e| e.effect.kind_name())
            .collect::<Vec<_>>(),
        ["dropShadow", "feather", "outlineStroke"],
        "the label restores the stack"
    );
}

/// The doc pour's lane: a MIXED batch (text first, then the picture, its
/// handle and its look) binds the frame and lands its look in one step.
#[test]
#[allow(non_snake_case)]
fn a_mixed_pour_batch_binds_the_picture_and_its_look__feat__anchored_inline_objects_anchored_effects(
) {
    let mut m = load();
    let h0 = m.current_state_hash();
    let mut ops = vec![
        Mutation::InsertText {
            story_id: "st1".into(),
            offset: 11,
            text: " and more".into(),
            cell: None,
        },
        Mutation::InsertAnchoredFrame {
            paragraph: None,
            story_id: "st1".into(),
            offset: 0,
            width: 60.0,
            height: 60.0,
            image_uri: Some(PNG.into()),
        },
        Mutation::BindCreated {
            handle: "pic".into(),
        },
    ];
    ops.extend(look());
    m.apply_mutation(&Mutation::Batch { ops })
        .expect("mixed batch");
    assert_eq!(frame(&m).opacity, Some(70.0));
    assert!(commands(&m)
        .iter()
        .any(|c| matches!(c, DisplayCommand::DropShadow { .. })));
    m.undo().expect("undo");
    assert_eq!(m.current_state_hash(), h0, "one step");
}

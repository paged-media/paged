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

//! v58 — the two new doors through the WIRE (the surface a plugin
//! sends), end to end:
//!
//!   * C-28 `applyOpacityMask` / `releaseOpacityMask` — the side map,
//!     the undo/redo round-trip, the `.paged` container round-trip
//!     (the LOSSLESS save path), and the LOUD `.idml` loss report.
//!   * C-29 `attachTextToPath` / `detachTextFromPath` — creating the
//!     `<TextPath>` the renderer already consumes, with every knob it
//!     honours, and the story surviving the detach.

use std::io::Write;
use std::path::PathBuf;

use paged_canvas::{channel::Mutation, CanvasModel, CanvasOptions, ElementId};

fn read_font(name: &str) -> Vec<u8> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../corpus/fonts")
        .join(name);
    std::fs::read(p).unwrap_or_else(|e| panic!("read font fixture {name}: {e}"))
}

/// One spread: two overlapping rectangles (mask candidates), a polygon
/// (a text-on-path host), and a story with no frame flowing it.
fn build_idml() -> Vec<u8> {
    use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};
    let buf = std::io::Cursor::new(Vec::new());
    let mut zip = ZipWriter::new(buf);
    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    zip.start_file("mimetype", stored).unwrap();
    zip.write_all(b"application/vnd.adobe.indesign-idml-package")
        .unwrap();
    zip.start_file("designmap.xml", deflated).unwrap();
    zip.write_all(
        br#"<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <idPkg:Spread src="Spreads/Spread_sp1.xml"/>
  <idPkg:Story src="Stories/Story_st1.xml"/>
</Document>"#,
    )
    .unwrap();
    zip.start_file("Resources/Graphic.xml", deflated).unwrap();
    zip.write_all(
        br#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Graphic xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <Graphic/>
</idPkg:Graphic>"#,
    )
    .unwrap();
    zip.start_file("Stories/Story_st1.xml", deflated).unwrap();
    zip.write_all(
        br#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Story xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <Story Self="st1">
    <ParagraphStyleRange>
      <CharacterStyleRange><Content>Curve</Content></CharacterStyleRange>
    </ParagraphStyleRange>
  </Story>
</idPkg:Story>"#,
    )
    .unwrap();
    zip.start_file("Spreads/Spread_sp1.xml", deflated).unwrap();
    zip.write_all(
        br#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Spread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <Spread Self="sp1">
    <Page Self="p1" GeometricBounds="0 0 700 700"/>
    <Rectangle Self="target" GeometricBounds="100 100 300 300" StrokeWeight="0"/>
    <Rectangle Self="artwork" GeometricBounds="200 200 400 400" StrokeWeight="0"/>
    <Polygon Self="curve" GeometricBounds="400 100 500 600" StrokeWeight="1">
      <Properties>
        <PathGeometry>
          <GeometryPathType PathOpen="true">
            <PathPointArray>
              <PathPointType Anchor="100 450" LeftDirection="100 450" RightDirection="100 450"/>
              <PathPointType Anchor="600 450" LeftDirection="600 450" RightDirection="600 450"/>
            </PathPointArray>
          </GeometryPathType>
        </PathGeometry>
      </Properties>
    </Polygon>
  </Spread>
</idPkg:Spread>"#,
    )
    .unwrap();
    zip.finish().unwrap().into_inner()
}

fn load() -> CanvasModel {
    CanvasModel::load(
        "doc-v58",
        &build_idml(),
        CanvasOptions {
            fonts: vec![read_font("Inter.ttf")],
            ..Default::default()
        },
    )
    .expect("load")
}

fn mask_entry(model: &CanvasModel, target: &str) -> Option<paged_model::OpacityMask> {
    model.scene().spreads[0]
        .spread
        .opacity_masks
        .get(target)
        .cloned()
}

fn top_level_len(model: &CanvasModel) -> usize {
    model.scene().spreads[0].spread.frames_in_order.len()
}

/// The mask lands through the wire, the artwork leaves the z-table, and
/// undo/redo round-trips the whole relation in ONE step each.
#[test]
fn apply_and_release_opacity_mask_round_trip_through_the_wire() {
    let mut model = load();
    let before = top_level_len(&model);

    model
        .apply_mutation(&Mutation::ApplyOpacityMask {
            target_id: ElementId::Rectangle("target".into()),
            mask_id: ElementId::Rectangle("artwork".into()),
            mask_type: Some("alpha".into()),
            invert: Some(true),
            clip: None,
        })
        .expect("applyOpacityMask");
    let entry = mask_entry(&model, "target").expect("side-map entry");
    assert_eq!(entry.mask_item, "artwork");
    assert_eq!(entry.mask_type, paged_model::OpacityMaskType::Alpha);
    assert!(entry.invert);
    assert_eq!(
        top_level_len(&model),
        before - 1,
        "the artwork left the z-table"
    );

    model.undo().expect("undo");
    assert!(mask_entry(&model, "target").is_none());
    assert_eq!(top_level_len(&model), before);

    model.redo().expect("redo");
    let entry = mask_entry(&model, "target").expect("redo restores the relation");
    assert_eq!(entry.mask_type, paged_model::OpacityMaskType::Alpha);
    assert!(entry.invert, "mode + invert survive undo/redo");

    // The explicit release gesture, and its undo.
    model
        .apply_mutation(&Mutation::ReleaseOpacityMask {
            target_id: ElementId::Rectangle("target".into()),
        })
        .expect("releaseOpacityMask");
    assert!(mask_entry(&model, "target").is_none());
    assert_eq!(top_level_len(&model), before);
    model.undo().expect("undo release");
    assert_eq!(
        mask_entry(&model, "target").map(|m| m.mask_type),
        Some(paged_model::OpacityMaskType::Alpha)
    );
}

/// `maskType` defaults to Illustrator's Luminosity when the wire omits
/// it or sends anything that isn't "alpha".
#[test]
fn mask_type_defaults_to_luminosity() {
    let mut model = load();
    model
        .apply_mutation(&Mutation::ApplyOpacityMask {
            target_id: ElementId::Rectangle("target".into()),
            mask_id: ElementId::Rectangle("artwork".into()),
            mask_type: None,
            invert: None,
            clip: None,
        })
        .expect("applyOpacityMask");
    let entry = mask_entry(&model, "target").unwrap();
    assert_eq!(entry.mask_type, paged_model::OpacityMaskType::Luminosity);
    assert!(!entry.invert);
}

/// **The IDML round-trip decision, pinned.** `.paged` keeps the mask
/// (it rides the native model part); `.idml` cannot, and says so.
#[test]
fn a_mask_survives_paged_and_is_reported_lost_on_idml() {
    let mut model = load();
    // The fixture's story flows in no frame: InDesign discards such a
    // story on open (measured), so the export drops it and the ledger
    // names it — the one loss a clean copy of THIS document has.
    let clean = model.idml_export_losses();
    assert_eq!(clean.len(), 1, "{clean:?}");
    assert!(
        clean[0].contains("st1") && clean[0].contains("referenced by no frame"),
        "{}",
        clean[0]
    );

    model
        .apply_mutation(&Mutation::ApplyOpacityMask {
            target_id: ElementId::Rectangle("target".into()),
            mask_id: ElementId::Rectangle("artwork".into()),
            mask_type: Some("alpha".into()),
            invert: Some(true),
            clip: None,
        })
        .expect("applyOpacityMask");

    // --- LOSSY: .idml names the loss instead of swallowing it.
    let losses: Vec<String> = model
        .idml_export_losses()
        .into_iter()
        .filter(|l| !clean.contains(l))
        .collect();
    assert_eq!(losses.len(), 1, "one masked item ⇒ one NEW loss line");
    assert!(losses[0].contains("target"), "{}", losses[0]);
    assert!(losses[0].contains("artwork"), "{}", losses[0]);
    assert!(
        losses[0].contains(".paged"),
        "the message must point at the lossless path: {}",
        losses[0]
    );
    model.export_idml().expect("the IDML still writes");

    // --- LOSSLESS: .paged round-trips the relation verbatim.
    model.refresh_model_part().expect("refresh model part");
    let bytes = model
        .export_paged(paged_canvas::channel::PROTOCOL_VERSION.0)
        .expect("export .paged");
    let reloaded = CanvasModel::load("doc-v58-reloaded", &bytes, CanvasOptions::default())
        .expect("reload .paged");
    let native = reloaded
        .read_model_part()
        .expect("document.pgm present after reload");
    let entry = native.spreads[0]
        .spread
        .opacity_masks
        .get("target")
        .expect("the mask survived the .paged round-trip");
    assert_eq!(entry.mask_item, "artwork");
    assert_eq!(entry.mask_type, paged_model::OpacityMaskType::Alpha);
    assert!(entry.invert);
}

fn text_paths(model: &CanvasModel, host: &str) -> Vec<paged_model::TextPath> {
    model.scene().spreads[0]
        .spread
        .polygons
        .iter()
        .find(|p| p.self_id.as_deref() == Some(host))
        .map(|p| p.text_paths.clone())
        .unwrap_or_default()
}

/// C-29 through the wire: the link is created with every knob the
/// renderer honours, the renderer then draws glyphs along the path,
/// and detach removes the link while the STORY survives.
#[test]
fn attach_and_detach_text_to_path_round_trip_through_the_wire() {
    let mut model = load();
    assert!(text_paths(&model, "curve").is_empty());
    let stories_before = model.scene().stories.len();

    model
        .apply_mutation(&Mutation::AttachTextToPath {
            element_id: ElementId::Polygon("curve".into()),
            story_id: "st1".into(),
            path_type_alignment: Some("CenterPathType".into()),
            flip_path_effect: Some("Flipped".into()),
            start_bracket: Some(50.0),
            end_bracket: Some(400.0),
        })
        .expect("attachTextToPath");

    let tps = text_paths(&model, "curve");
    assert_eq!(tps.len(), 1);
    assert_eq!(tps[0].parent_story, "st1");
    assert_eq!(
        tps[0].path_type_alignment.as_deref(),
        Some("CenterPathType")
    );
    assert_eq!(tps[0].flip_path_effect.as_deref(), Some("Flipped"));
    assert_eq!(tps[0].start_bracket, Some(50.0));
    assert_eq!(tps[0].end_bracket, Some(400.0));
    assert!(
        tps[0].path_effect.is_none(),
        "PathEffect is not offered — only Rainbow renders"
    );

    model
        .apply_mutation(&Mutation::DetachTextFromPath {
            element_id: ElementId::Polygon("curve".into()),
        })
        .expect("detachTextFromPath");
    assert!(text_paths(&model, "curve").is_empty());
    assert_eq!(
        model.scene().stories.len(),
        stories_before,
        "the story survives the detach — attach only ever linked it"
    );

    model.undo().expect("undo detach");
    let tps = text_paths(&model, "curve");
    assert_eq!(tps.len(), 1);
    assert_eq!(
        tps[0].path_type_alignment.as_deref(),
        Some("CenterPathType"),
        "the knobs come back with the link"
    );
}

/// The renderer draws the attached story: the same document renders
/// glyph fills along the path only AFTER the attach. This is what
/// makes C-29 a door and not just bookkeeping.
#[test]
fn the_attached_story_actually_renders_along_the_path() {
    use paged_compose::DisplayCommand;

    fn fill_count(model: &CanvasModel) -> usize {
        model
            .built()
            .pages
            .iter()
            .flat_map(|p| p.list.commands.iter())
            .filter(|c| matches!(c, DisplayCommand::FillPath { .. }))
            .count()
    }

    let mut model = load();
    let before = fill_count(&model);
    model
        .apply_mutation(&Mutation::AttachTextToPath {
            element_id: ElementId::Polygon("curve".into()),
            story_id: "st1".into(),
            path_type_alignment: None,
            flip_path_effect: None,
            start_bracket: None,
            end_bracket: None,
        })
        .expect("attachTextToPath");
    let after = fill_count(&model);
    assert!(
        after > before,
        "attaching a story to a path must add glyph fills ({before} → {after})"
    );

    model
        .apply_mutation(&Mutation::DetachTextFromPath {
            element_id: ElementId::Polygon("curve".into()),
        })
        .expect("detachTextFromPath");
    assert_eq!(
        fill_count(&model),
        before,
        "detaching removes exactly the glyphs the attach added"
    );
}

// ---- Editor ADR 309 — the mask's options through `Mutation::Set` -----

fn set_option(
    model: &mut CanvasModel,
    path: &str,
    value: paged_mutate::Value,
) -> Result<(), String> {
    model
        .apply_mutation(&Mutation::Set {
            address: paged_wire::Address::parse("rectangle:target").unwrap(),
            path: path.to_string(),
            value,
        })
        .map(|_| ())
        .map_err(|e| format!("{e:?}"))
}

fn read(model: &CanvasModel, path: &str) -> paged_mutate::Value {
    model
        .read_property("rectangle:target", path)
        .unwrap_or_else(|e| panic!("read {path}: {e:?}"))
}

/// The Transparency panel's mode, Invert Mask and Clip: each a write of
/// its own, one undo step, the artwork staying out of the z-order, and
/// the undo restoring the exact state.
#[test]
#[allow(non_snake_case)]
fn mask_options_set_read_and_undo__feat__effects_transparency_opacity_mask() {
    use paged_mutate::Value;
    let mut model = load();
    // Without a mask the options read as a new mask would take them, and
    // a write is refused.
    assert!(matches!(read(&model, "opacityMaskClip"), Value::Bool(true)));
    assert!(set_option(&mut model, "opacityMaskInvert", Value::Bool(true)).is_err());

    model
        .apply_mutation(&Mutation::ApplyOpacityMask {
            target_id: ElementId::Rectangle("target".into()),
            mask_id: ElementId::Rectangle("artwork".into()),
            mask_type: None,
            invert: None,
            clip: None,
        })
        .expect("applyOpacityMask");
    let z = top_level_len(&model);
    let h0 = model.current_state_hash();
    assert!(matches!(read(&model, "opacityMaskType"), Value::Text(t) if t == "luminosity"));
    assert!(matches!(
        read(&model, "opacityMaskInvert"),
        Value::Bool(false)
    ));
    assert!(matches!(read(&model, "opacityMaskClip"), Value::Bool(true)));

    set_option(&mut model, "opacityMaskClip", Value::Bool(false)).expect("clip off");
    let entry = mask_entry(&model, "target").expect("still masked");
    assert!(!entry.clip);
    assert_eq!(entry.mask_item, "artwork");
    assert_eq!(
        top_level_len(&model),
        z,
        "the artwork stays out of the z-order"
    );
    assert!(matches!(
        read(&model, "opacityMaskClip"),
        Value::Bool(false)
    ));
    let h1 = model.current_state_hash();

    set_option(&mut model, "opacityMaskInvert", Value::Bool(true)).expect("invert");
    set_option(&mut model, "opacityMaskType", Value::Text("alpha".into())).expect("alpha");
    let entry = mask_entry(&model, "target").unwrap();
    assert!(entry.invert && !entry.clip);
    assert_eq!(entry.mask_type, paged_model::OpacityMaskType::Alpha);
    assert!(set_option(
        &mut model,
        "opacityMaskType",
        Value::Text("lightness".into())
    )
    .is_err());

    // One undo per write.
    model.undo().expect("undo type");
    model.undo().expect("undo invert");
    assert_eq!(model.current_state_hash(), h1);
    model.undo().expect("undo clip");
    assert_eq!(model.current_state_hash(), h0);
    assert!(mask_entry(&model, "target").unwrap().clip);
    assert_eq!(top_level_len(&model), z);

    // A release followed by its undo keeps the switch.
    set_option(&mut model, "opacityMaskClip", Value::Bool(false)).unwrap();
    model
        .apply_mutation(&Mutation::ReleaseOpacityMask {
            target_id: ElementId::Rectangle("target".into()),
        })
        .unwrap();
    model.undo().unwrap();
    assert!(
        !mask_entry(&model, "target").unwrap().clip,
        "undo of a release keeps Clip"
    );
}

/// The panel's thumbnail: a snapshot naming only the mask item draws the
/// artwork alone, although it is no page item of its own while it masks.
#[test]
fn a_snapshot_of_the_mask_item_alone_draws_the_artwork() {
    use paged_canvas::{
        render_snapshot_request, SnapshotBackground, SnapshotFormat, SnapshotRequest,
    };
    let sample = paged_gen::samples::build("layers-z").expect("sample");
    let bytes = paged_gen::write_idml(&sample).expect("write");
    let mut model = CanvasModel::load(
        "mask-thumb",
        &bytes,
        CanvasOptions {
            fonts: vec![read_font("Inter.ttf")],
            ..Default::default()
        },
    )
    .expect("load");
    let rects: Vec<String> = model.scene().spreads[0]
        .spread
        .rectangles
        .iter()
        .filter_map(|r| r.self_id.clone())
        .collect();
    model
        .apply_mutation(&Mutation::ApplyOpacityMask {
            target_id: ElementId::Rectangle(rects[0].clone()),
            mask_id: ElementId::Rectangle(rects[1].clone()),
            mask_type: None,
            invert: None,
            clip: None,
        })
        .expect("mask");
    let page = paged_wire::PageId(model.pages()[0].self_id.clone());
    let drawn = |only: &[ElementId]| {
        let snap = render_snapshot_request(
            &model,
            &SnapshotRequest {
                only,
                format: SnapshotFormat::Rgba,
                background: SnapshotBackground::Transparent,
                ..SnapshotRequest::page(&page, 200)
            },
        )
        .expect("snapshot");
        snap.rgba.chunks(4).filter(|p| p[3] > 0).count()
    };
    let mask_only = [ElementId::Rectangle(rects[1].clone())];
    assert!(drawn(&mask_only) > 0, "the mask artwork draws alone");
    // The document itself is untouched: the artwork is still the mask.
    assert!(mask_entry(&model, &rects[0]).is_some());
}

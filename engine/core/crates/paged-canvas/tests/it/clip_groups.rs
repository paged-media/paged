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

//! Engine ADR 1010 — clip groups and groups pasted into a frame, through
//! the canvas model and the wire: make, read, release and undo; the scene
//! tree lists pasted-in children; the IDML export writes a clip group as
//! the paste-into that paints the same, and the reader opens a pasted-in
//! group as one.

use std::io::Write;

use paged_canvas::{
    channel::{Mutation, SceneTreeNode},
    snapshot::render_snapshot_at_dpi,
    CanvasModel, CanvasOptions, PageId,
};
use paged_mutate::{PropertyPath, Value};
use paged_wire::{ElementId, VirtualTarget};

fn rect(id: &str, bounds: &str, fill: &str) -> String {
    format!(
        r#"<Rectangle Self="{id}" GeometricBounds="{bounds}" FillColor="{fill}" StrokeWeight="0"/>"#
    )
}

/// Three rectangles on a 300 pt page: two black ones, `a` protruding
/// left of `clip` and `b` protruding below it, and on top `clip`, a red
/// square at x, y ∈ [100, 200].
fn build_idml() -> Vec<u8> {
    use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};
    let spread = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Spread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <Spread Self="sp1">
    <Page Self="p1" GeometricBounds="0 0 300 300"/>
    {}
    {}
    {}
  </Spread>
</idPkg:Spread>"#,
        rect("a", "120 50 160 150", "Color/Black"),
        rect("b", "150 140 260 180", "Color/Black"),
        rect("clip", "100 100 200 200", "Color/Red"),
    );
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
  <idPkg:Graphic src="Resources/Graphic.xml"/>
  <idPkg:Spread src="Spreads/Spread_sp1.xml"/>
</Document>"#,
    )
    .unwrap();
    zip.start_file("Resources/Graphic.xml", deflated).unwrap();
    zip.write_all(
        br#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Graphic xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <Color Self="Color/Black" Model="Process" Space="CMYK" ColorValue="0 0 0 100" Name="Black"/>
  <Color Self="Color/Red" Model="Process" Space="RGB" ColorValue="255 0 0" Name="Red"/>
</idPkg:Graphic>"#,
    )
    .unwrap();
    zip.start_file("Spreads/Spread_sp1.xml", deflated).unwrap();
    zip.write_all(spread.as_bytes()).unwrap();
    zip.finish().unwrap().into_inner()
}

fn load_bytes(bytes: &[u8]) -> CanvasModel {
    CanvasModel::load("clip-groups", bytes, CanvasOptions::default()).expect("load")
}

fn load() -> CanvasModel {
    load_bytes(&build_idml())
}

fn r(id: &str) -> ElementId {
    ElementId::Rectangle(id.into())
}

fn make_clip(m: &mut CanvasModel) -> String {
    let reply = m
        .apply_mutation(&Mutation::CreateGroup {
            member_ids: vec![r("a"), r("b"), r("clip")],
            clip: true,
        })
        .expect("make clipping mask");
    let tree = m.scene_tree();
    let group = find_kind(&tree, "Group").expect("a group row");
    let _ = reply;
    group.id.as_ref().expect("group id").raw_id().to_string()
}

fn find_kind<'a>(nodes: &'a [SceneTreeNode], kind: &str) -> Option<&'a SceneTreeNode> {
    for n in nodes {
        if n.kind == kind {
            return Some(n);
        }
        if let Some(f) = find_kind(&n.children, kind) {
            return Some(f);
        }
    }
    None
}

/// The tree under the page, as `id[children…]` strings.
fn outline(m: &CanvasModel) -> Vec<String> {
    fn label(n: &SceneTreeNode) -> String {
        let id =
            n.id.as_ref()
                .map(|i| i.raw_id().to_string())
                .unwrap_or_default();
        let id = if n.clip == Some(true) {
            format!("{id}(clip)")
        } else {
            id
        };
        if n.children.is_empty() {
            id
        } else {
            let kids: Vec<String> = n.children.iter().map(label).collect();
            format!("{id}[{}]", kids.join(", "))
        }
    }
    m.scene_tree()[0].children[0]
        .children
        .iter()
        .map(label)
        .collect()
}

fn pixels(m: &CanvasModel) -> Vec<u8> {
    let page = PageId(m.pages()[0].self_id.clone());
    render_snapshot_at_dpi(m, &page, 72.0)
        .expect("snapshot")
        .rgba
}

fn px(rgba: &[u8], x: usize, y: usize) -> [u8; 4] {
    let i = (y * 300 + x) * 4;
    [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]]
}

fn is_dark(p: [u8; 4]) -> bool {
    p[0] < 80 && p[1] < 80 && p[2] < 80
}

fn is_white(p: [u8; 4]) -> bool {
    p[0] > 230 && p[1] > 230 && p[2] > 230
}

/// The probes of a working clip: `a` and `b` inside the square, clipped
/// outside it, and the square's red not drawn.
fn assert_clipped(rgba: &[u8]) {
    assert!(
        is_dark(px(rgba, 120, 140)),
        "a inside: {:?}",
        px(rgba, 120, 140)
    );
    assert!(
        is_white(px(rgba, 70, 140)),
        "a clipped left: {:?}",
        px(rgba, 70, 140)
    );
    assert!(
        is_dark(px(rgba, 160, 190)),
        "b inside: {:?}",
        px(rgba, 160, 190)
    );
    assert!(
        is_white(px(rgba, 160, 240)),
        "b clipped below: {:?}",
        px(rgba, 160, 240)
    );
    assert!(
        is_white(px(rgba, 180, 110)),
        "the clip path is unpainted: {:?}",
        px(rgba, 180, 110)
    );
}

#[test]
#[allow(non_snake_case)]
fn make_clipping_mask_reads_draws_and_undoes_exactly__feat__frames_paths_clip_groups() {
    let mut m = load();
    let before = m.scene().canonical_hash();
    let unclipped = pixels(&m);
    assert!(is_dark(px(&unclipped, 70, 140)), "premise: a protrudes");
    let g = make_clip(&mut m);
    assert_eq!(outline(&m), vec![format!("{g}(clip)[a, b, clip]")]);
    // The read: the group says it clips, and its extent is the path's.
    let props = m
        .element_properties(&ElementId::Group(g.clone()))
        .expect("group properties");
    let clip_row = props
        .entries
        .iter()
        .find(|e| e.path == PropertyPath::GroupClip)
        .expect("groupClip row");
    assert_eq!(clip_row.value, Some(Value::Bool(true)));
    let bounds = props
        .entries
        .iter()
        .find(|e| e.path == PropertyPath::FrameBounds)
        .and_then(|e| e.value.clone());
    assert_eq!(bounds, Some(Value::Bounds([100.0, 100.0, 200.0, 200.0])));
    assert_clipped(&pixels(&m));

    // One undo step: the three items are back as they were, exactly.
    m.undo().expect("undo");
    assert_eq!(m.scene().canonical_hash(), before);
    assert_eq!(outline(&m), vec!["a", "b", "clip"]);
    assert_eq!(pixels(&m), unclipped);
    m.redo().expect("redo");
    assert_clipped(&pixels(&m));
}

#[test]
#[allow(non_snake_case)]
fn release_ungroups_and_undo_brings_the_clip_back__feat__frames_paths_clip_groups() {
    let mut m = load();
    let g = make_clip(&mut m);
    let clipped = m.scene().canonical_hash();
    m.apply_mutation(&Mutation::DissolveGroup {
        group_id: g.clone(),
    })
    .expect("release");
    assert_eq!(outline(&m), vec!["a", "b", "clip"]);
    m.undo().expect("undo release");
    assert_eq!(m.scene().canonical_hash(), clipped);
    assert_clipped(&pixels(&m));

    // The flag alone: off keeps the group and paints everything.
    let target = VirtualTarget::Element {
        element_id: ElementId::Group(g.clone()),
    };
    m.apply_mutation(&Mutation::Set {
        address: target.clone().into(),
        path: "groupClip".into(),
        value: Value::Bool(false),
    })
    .expect("groupClip false");
    assert_eq!(outline(&m), vec![format!("{g}[a, b, clip]")]);
    let plain = pixels(&m);
    assert!(is_dark(px(&plain, 70, 140)), "unclipped again");
    m.undo().expect("undo flag");
    assert_eq!(m.scene().canonical_hash(), clipped);
}

#[test]
#[allow(non_snake_case)]
fn a_clipping_mask_needs_a_closed_outline_on_top__feat__frames_paths_clip_groups() {
    let mut m = load();
    let before = m.scene().canonical_hash();
    // Group the two black ones first: a group on top cannot clip.
    m.apply_mutation(&Mutation::CreateGroup {
        member_ids: vec![r("clip"), r("a")],
        clip: false,
    })
    .expect("group");
    let inner = find_kind(&m.scene_tree(), "Group")
        .and_then(|n| n.id.clone())
        .expect("inner group");
    m.apply_mutation(&Mutation::ReorderElement {
        element_id: inner.clone(),
        to: serde_json::from_str("\"front\"").unwrap(),
    })
    .expect("to front");
    let err = m
        .apply_mutation(&Mutation::CreateGroup {
            member_ids: vec![r("b"), inner],
            clip: true,
        })
        .expect_err("a group on top cannot clip");
    assert!(format!("{err:?}").contains("top-most"), "{err:?}");
    m.undo().expect("undo reorder");
    m.undo().expect("undo group");
    assert_eq!(m.scene().canonical_hash(), before);
}

#[test]
#[allow(non_snake_case)]
fn a_group_pastes_into_a_frame_and_the_tree_lists_it__feat__frames_paths_clip_groups() {
    let mut m = load();
    let before = m.scene().canonical_hash();
    m.apply_mutation(&Mutation::CreateGroup {
        member_ids: vec![r("a"), r("b")],
        clip: false,
    })
    .expect("group a and b");
    let g = find_kind(&m.scene_tree(), "Group")
        .and_then(|n| n.id.clone())
        .expect("group")
        .raw_id()
        .to_string();
    let grouped = m.scene().canonical_hash();
    // A member stands for its group.
    m.apply_mutation(&Mutation::PasteInto {
        container_id: r("clip"),
        child_id: r("a"),
    })
    .expect("paste the group in");
    assert_eq!(outline(&m), vec![format!("clip[{g}[a, b]]")]);
    let rgba = pixels(&m);
    assert!(is_white(px(&rgba, 70, 140)), "clipped to the frame");
    assert!(is_dark(px(&rgba, 120, 140)), "inside the frame");
    // The container paints its own fill under the content.
    let red = px(&rgba, 180, 110);
    assert!(red[0] > 200 && red[1] < 80, "the frame's fill: {red:?}");
    m.apply_mutation(&Mutation::ReleaseFrom {
        child_id: ElementId::Group(g.clone()),
    })
    .expect("release");
    assert_ne!(m.scene().canonical_hash(), grouped, "released on top");
    m.undo().expect("undo release");
    m.undo().expect("undo paste");
    assert_eq!(m.scene().canonical_hash(), grouped);
    m.undo().expect("undo group");
    assert_eq!(m.scene().canonical_hash(), before);

    // Deleting the frame takes the group along; undo re-nests it.
    m.apply_mutation(&Mutation::CreateGroup {
        member_ids: vec![r("a"), r("b")],
        clip: false,
    })
    .expect("group");
    m.apply_mutation(&Mutation::PasteInto {
        container_id: r("clip"),
        child_id: r("b"),
    })
    .expect("paste");
    let nested = m.scene().canonical_hash();
    m.apply_mutation(&Mutation::DeleteFrame {
        frame_id: "clip".into(),
    })
    .expect("delete the frame");
    assert!(outline(&m).is_empty(), "{:?}", outline(&m));
    m.undo().expect("undo delete");
    assert_eq!(m.scene().canonical_hash(), nested);
}

#[test]
#[allow(non_snake_case)]
fn the_idml_export_writes_a_clip_group_as_paste_into__feat__frames_paths_clip_groups() {
    let mut m = load();
    make_clip(&mut m);
    let clipped = pixels(&m);
    let bytes = m.export_idml().expect("export");
    let spread_xml = {
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(&bytes)).unwrap();
        let mut f = zip.by_name("Spreads/Spread_sp1.xml").unwrap();
        let mut s = String::new();
        std::io::Read::read_to_string(&mut f, &mut s).unwrap();
        s
    };
    // The clipping path is the container, unpainted, the group inside.
    let at = |needle: &str| {
        spread_xml
            .find(needle)
            .unwrap_or_else(|| panic!("{needle}:\n{spread_xml}"))
    };
    assert!(at(r#"Self="clip""#) < at("<Group "), "{spread_xml}");
    assert!(at("<Group ") < at("</Rectangle>"), "{spread_xml}");
    let twin = load_bytes(&bytes);
    let group = find_kind(&twin.scene_tree(), "Group")
        .and_then(|n| n.id.clone())
        .expect("group")
        .raw_id()
        .to_string();
    assert_eq!(outline(&twin), vec![format!("clip[{group}[a, b]]")]);
    assert_eq!(
        pixels(&twin),
        clipped,
        "the paste-into paints what the clip group did"
    );
    // …and the twin exports again to the same picture.
    let again = load_bytes(&twin.export_idml().expect("export twin"));
    assert_eq!(pixels(&again), clipped);
}

#[test]
#[allow(non_snake_case)]
fn a_clip_group_survives_paged__feat__frames_paths_clip_groups() {
    let mut m = load();
    let g = make_clip(&mut m);
    m.refresh_model_part().expect("refresh model part");
    let bytes = m
        .export_paged(paged_canvas::channel::PROTOCOL_VERSION.0)
        .expect("export .paged");
    let reloaded = load_bytes(&bytes);
    assert_eq!(outline(&reloaded), vec![format!("{g}(clip)[a, b, clip]")]);
    assert_clipped(&pixels(&reloaded));
}

#[test]
#[allow(non_snake_case)]
fn clip_groups_and_pasted_groups_refuse_what_would_break_them__feat__frames_paths_clip_groups() {
    let mut m = load();
    make_clip(&mut m);
    m.apply_mutation(&Mutation::CreateGroup {
        member_ids: vec![],
        clip: false,
    })
    .expect_err("an empty group is refused");
    let err = m
        .apply_mutation(&Mutation::DissolveGroup {
            group_id: "nope".into(),
        })
        .expect_err("no such group");
    let _ = err;
    m.undo().expect("undo the clip");
    m.apply_mutation(&Mutation::PasteInto {
        container_id: r("clip"),
        child_id: r("a"),
    })
    .expect("paste a into the square");
    // …and a frame hosting pasted-in content cannot become one.
    let err = m
        .apply_mutation(&Mutation::CreateGroup {
            member_ids: vec![r("b"), r("clip")],
            clip: true,
        })
        .expect_err("a host on top cannot clip");
    assert!(format!("{err:?}").contains("pasted-in"), "{err:?}");
    m.undo().expect("undo paste");
    let g = make_clip(&mut m);
    // Content cannot be pasted into a clipping path (here, `b` stands for
    // the clip group, which holds the container).
    let err = m
        .apply_mutation(&Mutation::PasteInto {
            container_id: r("clip"),
            child_id: r("b"),
        })
        .expect_err("b's group is the clip group, which holds the container");
    assert!(format!("{err:?}").contains("nest the container"), "{err:?}");
    // A pasted-in group is released before it is ungrouped.
    m.apply_mutation(&Mutation::DissolveGroup { group_id: g })
        .expect("release");
    m.apply_mutation(&Mutation::CreateGroup {
        member_ids: vec![r("a"), r("b")],
        clip: false,
    })
    .expect("group");
    let inner = find_kind(&m.scene_tree(), "Group")
        .and_then(|n| n.id.clone())
        .expect("group")
        .raw_id()
        .to_string();
    m.apply_mutation(&Mutation::PasteInto {
        container_id: r("clip"),
        child_id: r("a"),
    })
    .expect("paste");
    let err = m
        .apply_mutation(&Mutation::DissolveGroup { group_id: inner })
        .expect_err("ungroup inside a container");
    assert!(format!("{err:?}").contains("release it"), "{err:?}");
}

#[test]
#[allow(non_snake_case)]
fn duplicating_a_clip_group_or_a_host_of_a_group_copies_it_whole__feat__frames_paths_clip_groups() {
    let mut m = load();
    let g = make_clip(&mut m);
    m.apply_mutation(&Mutation::DuplicateElements {
        element_ids: vec![ElementId::Group(g)],
        offset: (0.0, 0.0),
    })
    .expect("duplicate the clip group");
    let rows = outline(&m);
    assert_eq!(rows.len(), 2, "{rows:?}");
    assert!(rows.iter().all(|r| r.contains("(clip)")), "{rows:?}");
}

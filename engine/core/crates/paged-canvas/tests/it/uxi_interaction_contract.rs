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

//! The engine's half of the editor's interaction contract (protocol 79):
//!
//! * a gesture holds the document — a write, an undo or a script that
//!   arrives during it is refused whole (engine ADR 1300; `UXI-T60`);
//! * a marquee takes by mode and scope, across pages and from the
//!   pasteboard (engine ADR 1011, amendment 1);
//! * a snap target is held until the release tolerance, the tolerance
//!   follows the zoom, ties rank by kind and every line names its target
//!   (engine ADR 125, amendment 2; `UXI-T12`);
//! * an Alt-drag previews the duplicate it commits, and modifier changes
//!   recompute from the snapshot (engine ADR 193, amendment 1; `UXI-T06`,
//!   `UXI-T11`).

use std::io::Write;

use paged_canvas::channel::{Mutation, WorkerError};
use paged_canvas::gesture::{GestureHandle, ResizeHandle};
use paged_canvas::hit::{MarqueeMode, MarqueeScope};
use paged_canvas::snap::SnapTargetKind;
use paged_canvas::{CanvasModel, CanvasOptions, ElementId, GestureModifiers, GestureType, PageId};
use paged_mutate::operation::GuideOrientationSpec;

// ── fixtures ────────────────────────────────────────────────────────────

fn package(spreads: &[(&str, String)]) -> Vec<u8> {
    let mut buf = Vec::new();
    {
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        zip.start_file("mimetype", opts).unwrap();
        zip.write_all(b"application/vnd.adobe.indesign-idml-package")
            .unwrap();
        zip.start_file("META-INF/container.xml", opts).unwrap();
        zip.write_all(
            br#"<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="designmap.xml" media-type="text/xml"/></rootfiles></container>"#,
        )
        .unwrap();
        let mut designmap = String::from(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<Document DOMVersion="13.1" Self="d1">
<Layer Self="layer-body" Name="Body" Visible="true" Locked="false"/>
"#,
        );
        for (name, _) in spreads {
            designmap.push_str(&format!(
                r#"<idPkg:Spread src="Spreads/Spread_{name}.xml" xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"/>
"#
            ));
        }
        designmap.push_str("</Document>");
        zip.start_file("designmap.xml", opts).unwrap();
        zip.write_all(designmap.as_bytes()).unwrap();
        for (name, body) in spreads {
            zip.start_file(format!("Spreads/Spread_{name}.xml"), opts)
                .unwrap();
            zip.write_all(
                format!(
                    r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Spread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="13.1">
{body}
</idPkg:Spread>"#
                )
                .as_bytes(),
            )
            .unwrap();
        }
        zip.finish().unwrap();
    }
    buf
}

/// One page (612 × 792 at the spread origin): `m` (x 100–200, y 100–200)
/// moves; `t` (x 500–550, y 500–600) is a target; the group `g` holds `ga`
/// and `gb`. `page_extra` goes inside the `<Page>` (margins).
fn one_page(page_extra: &str) -> CanvasModel {
    let spread = format!(
        r#"<Spread Self="s1" PageCount="1">
<Page Self="p1" Name="1" GeometricBounds="0 0 792 612" ItemTransform="1 0 0 1 0 0">{page_extra}</Page>
<Rectangle Self="m" GeometricBounds="100 100 200 200" ItemTransform="1 0 0 1 0 0" FillColor="Color/Black"/>
<Rectangle Self="t" GeometricBounds="500 500 600 550" ItemTransform="1 0 0 1 0 0" FillColor="Color/Black"/>
<Group Self="g">
  <Rectangle Self="ga" GeometricBounds="300 100 350 150" ItemTransform="1 0 0 1 0 0" FillColor="Color/Black"/>
  <Rectangle Self="gb" GeometricBounds="300 200 350 250" ItemTransform="1 0 0 1 0 0" FillColor="Color/Black"/>
</Group>
</Spread>"#
    );
    CanvasModel::load("uxi", &package(&[("s1", spread)]), CanvasOptions::default()).expect("load")
}

/// A facing spread `s1` (verso `p1`, recto `p2`) and a single-page spread
/// `s2` (`p3`). On the canvas the pages stack: `p1` at y 0, `p2` at 816,
/// `p3` at 1632 (engine ADR 1011).
///
/// - `r1` on `p1` (page-local x 60–160, y 100–200);
/// - the group `g1` on `p2`: `a1` (x 100–200, y 100–150), `a2` (x 250–290,
///   y 150–190);
/// - `pb` on the pasteboard left of `p1` (as `p1` draws it: x −188…−148,
///   y 296–336);
/// - `r3` on `p3` (x 50–150, y 50–150).
fn facing() -> CanvasModel {
    let s1 = r#"<Spread Self="s1" PageCount="2" BindingLocation="1">
<Page Self="p1" Name="2" GeometricBounds="0 0 792 612" ItemTransform="1 0 0 1 -612 -396"/>
<Page Self="p2" Name="3" GeometricBounds="0 0 792 612" ItemTransform="1 0 0 1 0 -396"/>
<Rectangle Self="r1" GeometricBounds="0 0 100 100" ItemTransform="1 0 0 1 -552 -296" FillColor="Color/Black"/>
<Group Self="g1">
  <Rectangle Self="a1" GeometricBounds="0 0 50 100" ItemTransform="1 0 0 1 100 -296" FillColor="Color/Black"/>
  <Rectangle Self="a2" GeometricBounds="0 0 40 40" ItemTransform="1 0 0 1 250 -246" FillColor="Color/Black"/>
</Group>
<Rectangle Self="pb" GeometricBounds="0 0 40 40" ItemTransform="1 0 0 1 -800 -100" FillColor="Color/Black"/>
</Spread>"#
        .to_string();
    let s2 = r#"<Spread Self="s2" PageCount="1" BindingLocation="0">
<Page Self="p3" Name="4" GeometricBounds="0 0 792 612" ItemTransform="1 0 0 1 0 -396"/>
<Rectangle Self="r3" GeometricBounds="0 0 100 100" ItemTransform="1 0 0 1 50 -346" FillColor="Color/Black"/>
</Spread>"#
        .to_string();
    CanvasModel::load(
        "facing",
        &package(&[("s1", s1), ("s2", s2)]),
        CanvasOptions::default(),
    )
    .expect("load")
}

fn rect(id: &str) -> ElementId {
    ElementId::Rectangle(id.into())
}

fn page(id: &str) -> PageId {
    PageId(id.into())
}

fn none() -> GestureModifiers {
    GestureModifiers::default()
}

fn alt() -> GestureModifiers {
    GestureModifiers {
        alt: true,
        ..GestureModifiers::default()
    }
}

fn shift() -> GestureModifiers {
    GestureModifiers {
        shift: true,
        ..GestureModifiers::default()
    }
}

/// Every rectangle on the first spread: (id, [top, left, bottom, right]).
fn rects(m: &CanvasModel) -> Vec<(String, [f32; 4])> {
    m.scene().spreads[0]
        .spread
        .rectangles
        .iter()
        .map(|r| {
            let b = r.bounds;
            let [tx, ty] = r.item_transform.map_or([0.0, 0.0], |t| [t[4], t[5]]);
            (
                r.self_id.clone().unwrap_or_default(),
                [b.top + ty, b.left + tx, b.bottom + ty, b.right + tx],
            )
        })
        .collect()
}

fn bounds_of(m: &CanvasModel, id: &str) -> [f32; 4] {
    rects(m)
        .into_iter()
        .find(|(i, _)| i == id)
        .unwrap_or_else(|| panic!("{id} on the spread"))
        .1
}

fn undo_len(m: &CanvasModel) -> usize {
    m.undo_log(usize::MAX).undo_len
}

fn ids(hits: &[ElementId]) -> Vec<String> {
    let mut out: Vec<String> = hits
        .iter()
        .map(|h| format!("{}:{}", h.kind_label().to_lowercase(), h.raw_id()))
        .collect();
    out.sort();
    out
}

fn assert_held(result: Result<impl std::fmt::Debug, WorkerError>, h: GestureHandle) {
    match result {
        Err(WorkerError::GestureInProgress { handle }) => assert_eq!(handle, h),
        other => panic!("expected GestureInProgress({h:?}), got {other:?}"),
    }
}

// ── EN1: a gesture holds the document (UXI-T60) ─────────────────────────

#[test]
fn uxi_t60_a_write_during_a_gesture_is_refused_whole() {
    let mut m = one_page("");
    let h = m
        .begin_gesture(vec![rect("m")], GestureType::Translate, None)
        .expect("begin");
    m.update_gesture(h, (10.0, 0.0), none()).expect("update");
    let t_before = bounds_of(&m, "t");
    let steps = undo_len(&m);
    let write = Mutation::MoveFrame {
        frame_id: "t".into(),
        transform: [1.0, 0.0, 0.0, 1.0, 40.0, 20.0],
    };
    assert_held(m.apply_mutation(&write), h);
    assert_held(m.apply_mutation_labeled(&write, Some("named")), h);
    // Nothing of it landed: the other item and the history are untouched,
    // and the gesture's preview still stands.
    assert_eq!(bounds_of(&m, "t"), t_before);
    assert_eq!(undo_len(&m), steps);
    assert_eq!(bounds_of(&m, "m")[1], 110.0);
    // The gesture's own commit passes, and the write may follow it.
    m.commit_gesture(h).expect("commit");
    assert_eq!(undo_len(&m), steps + 1);
    m.apply_mutation(&write)
        .expect("the write after the gesture");
    assert_eq!(bounds_of(&m, "t")[1], 540.0);
}

#[test]
fn uxi_t60_undo_redo_and_history_jumps_wait_for_the_gesture() {
    let mut m = one_page("");
    let first = m
        .apply_mutation(&Mutation::MoveFrame {
            frame_id: "t".into(),
            transform: [1.0, 0.0, 0.0, 1.0, 10.0, 0.0],
        })
        .expect("a step to undo")
        .applied_seq;
    let h = m
        .begin_gesture(vec![rect("m")], GestureType::Translate, None)
        .expect("begin");
    m.update_gesture(h, (0.0, 30.0), none()).expect("update");
    let t_before = bounds_of(&m, "t");
    assert!(m.undo().is_none(), "undo waits for the gesture");
    assert!(m.redo().is_none(), "redo waits for the gesture");
    assert_held(m.undo_to(first), h);
    assert_held(m.redo_to(first), h);
    assert_held(m.restore_to(0, None), h);
    assert_eq!(bounds_of(&m, "t"), t_before, "the history did not move");
    m.cancel_gesture(h).expect("cancel");
    assert!(m.refuse_during_gesture().is_ok());
    assert!(m.undo().is_some(), "undo once the gesture let go");
    assert_eq!(bounds_of(&m, "t")[1], 500.0);
}

// ── EN2: the marquee's mode, scope, pages and pasteboard ────────────────

#[test]
fn marquee_from_the_pasteboard_takes_a_pasteboard_item() {
    let m = facing();
    // Left of p1, over the pasteboard item p1 draws at x −188…−148.
    let hits = m.marquee_hits_with(
        &page("p1"),
        [280.0, -220.0, 350.0, -100.0],
        MarqueeMode::Intersect,
        None,
    );
    assert_eq!(ids(&hits), ["rectangle:pb"]);
    // The old request shape (no mode, no scope) takes it too.
    assert_eq!(
        ids(&m.marquee_hits(&page("p1"), [280.0, -220.0, 350.0, -100.0])),
        ["rectangle:pb"]
    );
}

#[test]
fn marquee_contain_takes_only_what_lies_inside() {
    let m = facing();
    let partial = [90.0, 50.0, 210.0, 120.0];
    assert_eq!(
        ids(&m.marquee_hits_with(&page("p1"), partial, MarqueeMode::Intersect, None)),
        ["rectangle:r1"]
    );
    assert!(m
        .marquee_hits_with(&page("p1"), partial, MarqueeMode::Contain, None)
        .is_empty());
    let whole = [90.0, 50.0, 210.0, 170.0];
    assert_eq!(
        ids(&m.marquee_hits_with(&page("p1"), whole, MarqueeMode::Contain, None)),
        ["rectangle:r1"]
    );
}

#[test]
fn marquee_crosses_pages_and_spreads_on_the_canvas() {
    let m = facing();
    // From p1 down over p2 (canvas y 816…) and p3 (canvas y 1632…).
    let rect = [90.0, 40.0, 1800.0, 300.0];
    let doc = MarqueeScope::Document;
    assert_eq!(
        ids(&m.marquee_hits_with(&page("p1"), rect, MarqueeMode::Intersect, Some(&doc))),
        ["group:g1", "rectangle:r1", "rectangle:r3"]
    );
    assert_eq!(
        ids(&m.marquee_hits_with(&page("p1"), rect, MarqueeMode::Contain, Some(&doc))),
        ["group:g1", "rectangle:r1", "rectangle:r3"]
    );
    // Measured from p2 the same canvas rectangle takes the same items.
    let from_p2 = [rect[0] - 816.0, rect[1], rect[2] - 816.0, rect[3]];
    assert_eq!(
        ids(&m.marquee_hits_with(&page("p2"), from_p2, MarqueeMode::Intersect, Some(&doc))),
        ["group:g1", "rectangle:r1", "rectangle:r3"]
    );
}

#[test]
fn marquee_in_the_document_scope_takes_a_group_whole() {
    let m = facing();
    // Over a1 only: p2-local x 90–210, y 90–160, i.e. canvas y + 816.
    let over_a1 = [906.0, 90.0, 976.0, 210.0];
    let doc = MarqueeScope::Document;
    assert_eq!(
        ids(&m.marquee_hits_with(&page("p1"), over_a1, MarqueeMode::Intersect, Some(&doc))),
        ["group:g1"]
    );
    assert!(
        m.marquee_hits_with(&page("p1"), over_a1, MarqueeMode::Contain, Some(&doc))
            .is_empty(),
        "a group is contained only when all of it is"
    );
    // Without a scope the leaves come back, as they always did.
    assert_eq!(ids(&m.marquee_hits(&page("p1"), over_a1)), ["rectangle:a1"]);
}

#[test]
fn marquee_scoped_to_a_group_takes_only_its_members() {
    let m = facing();
    let everything = [-400.0, -400.0, 2600.0, 700.0];
    let inside = MarqueeScope::Group { id: "g1".into() };
    assert_eq!(
        ids(&m.marquee_hits_with(
            &page("p1"),
            everything,
            MarqueeMode::Intersect,
            Some(&inside)
        )),
        ["rectangle:a1", "rectangle:a2"]
    );
    let over_a1 = [906.0, 90.0, 976.0, 210.0];
    assert_eq!(
        ids(&m.marquee_hits_with(&page("p1"), over_a1, MarqueeMode::Contain, Some(&inside))),
        ["rectangle:a1"]
    );
}

// ── EN3: snap hysteresis, zoom, ranking, target kinds (UXI-T12) ─────────

/// Move `m` by `dx` (x only) in the gesture `h` at camera scale `scale`;
/// answer m's left edge in the preview and the x lines' kinds.
fn drag_x(
    m: &mut CanvasModel,
    h: GestureHandle,
    dx: f32,
    scale: Option<f32>,
) -> (f32, Vec<(f32, Option<SnapTargetKind>)>) {
    let r = m
        .update_gesture_with_scale(h, (dx, 0.0), none(), scale)
        .expect("update");
    let lines = r
        .snap_lines
        .iter()
        .filter(|l| l.axis == paged_canvas::snap::SnapAxis::X)
        .map(|l| (l.position, l.target_kind))
        .collect();
    (bounds_of(m, "m")[1], lines)
}

#[test]
fn uxi_t12_a_held_snap_is_released_only_past_six_pixels() {
    let mut m = one_page("");
    let h = m
        .begin_gesture_with_scale(vec![rect("m")], GestureType::Translate, None, Some(1.0))
        .expect("begin");
    // m's right edge (200 + dx) approaches t's left edge at 500.
    let (left, lines) = drag_x(&mut m, h, 295.0, None);
    assert_eq!(left, 395.0, "5 px away: not acquired");
    assert!(lines.is_empty());
    let (left, lines) = drag_x(&mut m, h, 297.0, None);
    assert_eq!(left, 400.0, "3 px away: acquired");
    assert_eq!(lines, [(500.0, Some(SnapTargetKind::ObjectEdge))]);
    let (left, _) = drag_x(&mut m, h, 305.0, None);
    assert_eq!(left, 400.0, "5 px past it: held");
    let (left, _) = drag_x(&mut m, h, 306.0, None);
    assert_eq!(left, 400.0, "6 px past it: still held");
    let (left, lines) = drag_x(&mut m, h, 307.0, None);
    assert_eq!(left, 407.0, "7 px past it: released");
    assert!(lines.is_empty());
    let (left, _) = drag_x(&mut m, h, 305.0, None);
    assert_eq!(left, 405.0, "back to 5 px: not re-acquired");
    // The commit lands exactly where the last preview did.
    let (left, _) = drag_x(&mut m, h, 303.0, None);
    assert_eq!(left, 400.0, "3 px: acquired again");
    m.commit_gesture(h).expect("commit");
    assert_eq!(bounds_of(&m, "m"), [100.0, 400.0, 200.0, 500.0]);
}

#[test]
fn uxi_t12_the_tolerance_follows_the_current_zoom() {
    let mut m = one_page("");
    let h = m
        .begin_gesture_with_scale(vec![rect("m")], GestureType::Translate, None, Some(1.0))
        .expect("begin");
    // 3 pt away is 6 px at 200 %: out of reach.
    let (left, _) = drag_x(&mut m, h, 297.0, Some(2.0));
    assert_eq!(left, 397.0);
    // Back at 100 % (the update says so) the same 3 pt is 3 px: acquired.
    let (left, _) = drag_x(&mut m, h, 297.0, Some(1.0));
    assert_eq!(left, 400.0);
    m.cancel_gesture(h).expect("cancel");
    // Begun at 200 %, zoomed out to 100 % mid-drag: the update's scale wins.
    let h = m
        .begin_gesture_with_scale(vec![rect("m")], GestureType::Translate, None, Some(2.0))
        .expect("begin");
    let (left, _) = drag_x(&mut m, h, 297.0, Some(1.0));
    assert_eq!(left, 400.0);
    m.cancel_gesture(h).expect("cancel");
}

#[test]
fn uxi_t12_targets_at_the_same_distance_rank_by_kind() {
    let run = || {
        let mut m = one_page("");
        m.apply_mutation(&Mutation::InsertGuide {
            spread_id: "s1".into(),
            orientation: GuideOrientationSpec::Vertical,
            position: 502.0,
            page_index: 0,
        })
        .expect("guide");
        let h = m
            .begin_gesture_with_scale(vec![rect("m")], GestureType::Translate, None, Some(1.0))
            .expect("begin");
        // The right edge at 501: the object edge (500) and the guide (502)
        // are both 1 pt away; the guide ranks first.
        let out = drag_x(&mut m, h, 301.0, None);
        m.cancel_gesture(h).expect("cancel");
        out
    };
    let (left, lines) = run();
    assert_eq!(left, 402.0, "snapped onto the guide");
    assert_eq!(lines.first(), Some(&(502.0, Some(SnapTargetKind::Guide))));
    for _ in 0..3 {
        assert_eq!(run(), (left, lines.clone()), "the same answer every time");
    }
}

#[test]
fn uxi_t12_lines_name_margin_and_column_targets() {
    let margins = r#"<MarginPreference ColumnCount="2" ColumnGutter="12" Top="36" Bottom="36" Left="36" Right="36"/>"#;
    let mut m = one_page(margins);
    let h = m
        .begin_gesture_with_scale(vec![rect("m")], GestureType::Translate, None, Some(1.0))
        .expect("begin");
    // The left edge (100) to 38: the left margin at 36.
    let (left, lines) = drag_x(&mut m, h, -62.0, None);
    assert_eq!(left, 36.0);
    assert_eq!(lines.first(), Some(&(36.0, Some(SnapTargetKind::Margin))));
    // The right edge (200) to 298: the first column ends at 300
    // ((612 − 72 − 12) / 2 + 36).
    let (left, lines) = drag_x(&mut m, h, 98.0, None);
    assert_eq!(left, 200.0);
    assert_eq!(lines.first(), Some(&(300.0, Some(SnapTargetKind::Column))));
    m.cancel_gesture(h).expect("cancel");
}

#[test]
fn uxi_t12_a_resize_holds_its_target_too() {
    let mut m = one_page("");
    let h = m
        .begin_gesture_with_scale(
            vec![rect("m")],
            GestureType::Resize {
                handle: ResizeHandle::East,
            },
            None,
            Some(1.0),
        )
        .expect("begin");
    let right = |m: &mut CanvasModel, dx: f32| {
        m.update_gesture(h, (dx, 0.0), none()).expect("update");
        bounds_of(m, "m")[3]
    };
    // The east edge (200 + dx) to t's left edge at 500.
    assert_eq!(right(&mut m, 295.0), 495.0);
    assert_eq!(right(&mut m, 297.0), 500.0);
    assert_eq!(right(&mut m, 305.0), 500.0);
    assert_eq!(right(&mut m, 307.0), 507.0);
    m.cancel_gesture(h).expect("cancel");
}

// ── EN4: live modifiers, the duplicate preview (UXI-T06, UXI-T11) ───────

#[test]
fn uxi_t06_an_alt_drag_previews_the_copy_and_commits_exactly_it() {
    let mut m = one_page("");
    let before = rects(&m);
    let steps = undo_len(&m);
    let h = m
        .begin_gesture_with(
            vec![rect("m")],
            GestureType::Translate,
            None,
            Some(1.0),
            alt(),
        )
        .expect("begin");
    m.update_gesture(h, (37.0, 41.0), alt()).expect("update");
    // The preview: the original at rest, one copy at the dragged place.
    let preview = rects(&m);
    assert_eq!(preview.len(), before.len() + 1);
    assert_eq!(bounds_of(&m, "m"), [100.0, 100.0, 200.0, 200.0]);
    let copy: Vec<_> = preview
        .iter()
        .filter(|(id, _)| !before.iter().any(|(b, _)| b == id))
        .cloned()
        .collect();
    assert_eq!(copy.len(), 1, "{preview:?}");
    assert_eq!(copy[0].1, [141.0, 137.0, 241.0, 237.0]);
    // The commit is that preview, as one undo step.
    m.commit_gesture(h).expect("commit");
    assert_eq!(rects(&m), preview, "the commit equals the last preview");
    assert_eq!(undo_len(&m), steps + 1);
    m.undo().expect("undo");
    assert_eq!(rects(&m), before, "one undo removes the copy");
}

#[test]
fn uxi_t06_releasing_alt_mid_drag_moves_and_leaves_no_copy() {
    let mut m = one_page("");
    let before = rects(&m);
    let h = m
        .begin_gesture(vec![rect("m")], GestureType::Translate, None)
        .expect("begin");
    m.update_gesture(h, (20.0, 0.0), alt()).expect("alt");
    assert_eq!(rects(&m).len(), before.len() + 1);
    m.update_gesture(h, (30.0, 0.0), none())
        .expect("alt released");
    let preview = rects(&m);
    assert_eq!(preview.len(), before.len(), "the copy left with Alt");
    assert_eq!(bounds_of(&m, "m"), [100.0, 130.0, 200.0, 230.0]);
    m.commit_gesture(h).expect("commit");
    assert_eq!(rects(&m), preview);
}

#[test]
fn uxi_t06_pressing_alt_mid_drag_duplicates() {
    let mut m = one_page("");
    let before = rects(&m);
    let h = m
        .begin_gesture(vec![rect("m")], GestureType::Translate, None)
        .expect("begin");
    m.update_gesture(h, (20.0, 0.0), none()).expect("move");
    assert_eq!(bounds_of(&m, "m"), [100.0, 120.0, 200.0, 220.0]);
    m.update_gesture(h, (25.0, 0.0), alt())
        .expect("alt pressed");
    m.update_gesture(h, (30.0, 0.0), alt()).expect("alt held");
    let preview = rects(&m);
    assert_eq!(preview.len(), before.len() + 1);
    assert_eq!(bounds_of(&m, "m"), [100.0, 100.0, 200.0, 200.0]);
    m.commit_gesture(h).expect("commit");
    assert_eq!(rects(&m), preview);
}

#[test]
fn uxi_t06_a_cancelled_duplicate_drag_leaves_no_copy() {
    let mut m = one_page("");
    let before = rects(&m);
    let steps = undo_len(&m);
    let h = m
        .begin_gesture(vec![rect("m")], GestureType::Translate, None)
        .expect("begin");
    m.update_gesture(h, (40.0, 40.0), alt()).expect("alt");
    m.cancel_gesture(h).expect("cancel");
    assert_eq!(rects(&m), before);
    assert_eq!(undo_len(&m), steps);
}

#[test]
fn uxi_t06_an_alt_drag_of_a_group_previews_and_commits_one_copy() {
    let mut m = one_page("");
    let groups = |m: &CanvasModel| m.scene().spreads[0].spread.groups.len();
    let (rects_before, groups_before) = (rects(&m).len(), groups(&m));
    let h = m
        .begin_gesture(
            vec![ElementId::Group("g".into())],
            GestureType::Translate,
            None,
        )
        .expect("begin");
    m.update_gesture(h, (0.0, 200.0), alt()).expect("alt");
    let preview = rects(&m);
    assert_eq!(preview.len(), rects_before + 2);
    assert_eq!(groups(&m), groups_before + 1);
    m.commit_gesture(h).expect("commit");
    assert_eq!(rects(&m), preview);
    assert_eq!(groups(&m), groups_before + 1);
}

#[test]
fn uxi_t11_modifier_changes_recompute_from_the_snapshot() {
    let mut m = one_page("");
    let h = m
        .begin_gesture(
            vec![rect("m")],
            GestureType::Resize {
                handle: ResizeHandle::SouthEast,
            },
            None,
        )
        .expect("begin");
    m.update_gesture(h, (60.0, 10.0), shift()).expect("shift");
    let constrained = bounds_of(&m, "m");
    m.update_gesture(h, (60.0, 10.0), none())
        .expect("shift released");
    let free = bounds_of(&m, "m");
    assert_ne!(constrained, free);
    m.update_gesture(h, (60.0, 10.0), shift())
        .expect("shift again");
    assert_eq!(
        bounds_of(&m, "m"),
        constrained,
        "no drift: the same delta and modifiers give the same box"
    );
    m.commit_gesture(h).expect("commit");
    assert_eq!(bounds_of(&m, "m"), constrained);
}

/// A turned polygon in a group beside a rectangle: what the fuzzer drags.
fn turned() -> CanvasModel {
    let spread = r#"<Spread Self="s1" PageCount="1">
<Page Self="p1" Name="1" GeometricBounds="0 0 792 612" ItemTransform="1 0 0 1 0 0"/>
<Rectangle Self="m" GeometricBounds="100 100 200 200" ItemTransform="1 0 0 1 0 0" FillColor="Color/Black"/>
<Group Self="g" ItemTransform="1 0 0 1 0 0">
  <Polygon Self="poly" GeometricBounds="0 0 100 100" ItemTransform="0.866 0.5 -0.5 0.866 300 300" FillColor="Color/Black">
    <Properties><PathGeometry><GeometryPathType pathOpen="false"><PathPointArray>
      <PathPointType Anchor="0 0" LeftDirection="0 0" RightDirection="0 0"/>
      <PathPointType Anchor="100 0" LeftDirection="100 0" RightDirection="100 0"/>
      <PathPointType Anchor="50 100" LeftDirection="50 100" RightDirection="50 100"/>
    </PathPointArray></GeometryPathType></PathGeometry></Properties>
  </Polygon>
  <Rectangle Self="gr" GeometricBounds="400 100 450 150" ItemTransform="1 0 0 1 0 0" FillColor="Color/Black"/>
</Group>
</Spread>"#
        .to_string();
    CanvasModel::load(
        "turned",
        &package(&[("s1", spread)]),
        CanvasOptions::default(),
    )
    .expect("load")
}

/// `UXI-GST-008` — the commit is a function of the snapshot and the last
/// update: an Alt pressed and released along the way leaves no trace, so
/// the document equals the one a single update would have made, and one
/// undo gives the opened document back.
#[test]
fn uxi_t06_a_flapping_alt_commits_what_one_update_would() {
    let run = |updates: &[((f32, f32), GestureModifiers)]| {
        let mut m = turned();
        let opened = m.export_idml().expect("export");
        let h = m
            .begin_gesture(
                vec![ElementId::Group("g".into()), rect("m")],
                GestureType::Translate,
                None,
            )
            .expect("begin");
        for (d, mods) in updates {
            m.update_gesture(h, *d, *mods).expect("update");
        }
        m.commit_gesture(h).expect("commit");
        let committed = m.export_idml().expect("export");
        m.undo().expect("undo");
        assert_eq!(m.export_idml().expect("export"), opened, "one undo");
        committed
    };
    let direct = run(&[((41.0, 37.0), alt())]);
    let flapped = run(&[
        ((10.0, 10.0), alt()),
        ((20.0, 20.0), none()),
        ((30.0, -30.0), alt()),
        ((35.0, 30.0), none()),
        ((41.0, 37.0), alt()),
    ]);
    assert!(
        direct == flapped,
        "the flapped commit differs from the direct one"
    );
}

// ── protocol 80 ─────────────────────────────────────────────────────────

/// Every rectangle on every spread: (spread index, id, [top, left,
/// bottom, right] in spread space).
fn all_rects(m: &CanvasModel) -> Vec<(usize, String, [f32; 4])> {
    let mut out = Vec::new();
    for (si, parsed) in m.scene().spreads.iter().enumerate() {
        for r in &parsed.spread.rectangles {
            let b = r.bounds;
            let [tx, ty] = r.item_transform.map_or([0.0, 0.0], |t| [t[4], t[5]]);
            out.push((
                si,
                r.self_id.clone().unwrap_or_default(),
                [b.top + ty, b.left + tx, b.bottom + ty, b.right + tx],
            ));
        }
    }
    out
}

/// One page holding `items` (spread XML) besides the page.
fn page_with(items: &str) -> CanvasModel {
    let spread = format!(
        r#"<Spread Self="s1" PageCount="1">
<Page Self="p1" Name="1" GeometricBounds="0 0 792 612" ItemTransform="1 0 0 1 0 0"/>
{items}
</Spread>"#
    );
    CanvasModel::load(
        "press",
        &package(&[("s1", spread)]),
        CanvasOptions::default(),
    )
    .expect("load")
}

fn press(page: &str, point: (f32, f32)) -> paged_canvas::press::GesturePress {
    paged_canvas::press::GesturePress {
        page_id: PageId(page.into()),
        point,
        modifiers: none(),
        select: paged_canvas::press::PressSelect::Replace,
        target: paged_canvas::press::PressTarget::Outermost,
        scope: None,
        gesture: None,
        filter: None,
        camera_scale: Some(1.0),
    }
}

fn group(id: &str) -> ElementId {
    ElementId::Group(id.into())
}

// ── EN5: the edit scope (engine ADR 1301; UXI-T44) ──────────────────────

#[test]
fn uxi_t44_a_group_scope_holds_its_members_and_nothing_else() {
    let m = one_page("");
    let scope = m.scope_subtree(&group("g"));
    assert!(scope.found);
    assert_eq!(ids(&scope.members), vec!["rectangle:ga", "rectangle:gb"]);
    assert_eq!(
        m.scope_contains(
            &group("g"),
            &[group("g"), rect("ga"), rect("gb"), rect("m"), rect("t")]
        ),
        vec![true, true, true, false, false],
        "the root, its members — and not the items beside it"
    );
}

#[test]
fn uxi_t44_a_container_scope_holds_what_is_pasted_into_it() {
    let mut m = one_page("");
    m.apply_mutation(&Mutation::PasteInto {
        container_id: rect("t"),
        child_id: rect("m"),
    })
    .expect("paste m into t");
    assert_eq!(
        m.scope_contains(&rect("t"), &[rect("m"), rect("ga")]),
        vec![true, false]
    );
    // A nested group: its members are in the scope of what holds it.
    m.apply_mutation(&Mutation::PasteInto {
        container_id: rect("t"),
        child_id: group("g"),
    })
    .expect("paste g into t");
    assert_eq!(
        m.scope_contains(&rect("t"), &[group("g"), rect("ga"), rect("gb")]),
        vec![true, true, true]
    );
}

#[test]
fn uxi_t44_a_text_frame_scope_holds_its_story_and_what_is_anchored_in_it() {
    let spread = r#"<Spread Self="s1" PageCount="1">
<Page Self="p1" Name="1" GeometricBounds="0 0 792 612" ItemTransform="1 0 0 1 0 0"/>
<TextFrame Self="tf1" ParentStory="st1" GeometricBounds="72 72 600 540" ItemTransform="1 0 0 1 0 0"/>
<TextFrame Self="tf2" ParentStory="st2" GeometricBounds="620 72 700 540" ItemTransform="1 0 0 1 0 0"/>
</Spread>"#;
    let mut buf = Vec::new();
    {
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        let mut put = |name: &str, body: &str| {
            zip.start_file(name, opts).unwrap();
            zip.write_all(body.as_bytes()).unwrap();
        };
        put("mimetype", "application/vnd.adobe.indesign-idml-package");
        put(
            "designmap.xml",
            r#"<?xml version="1.0" encoding="UTF-8"?>
<Document DOMVersion="13.1" Self="d1">
<idPkg:Spread src="Spreads/Spread_s1.xml" xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"/>
<idPkg:Story src="Stories/Story_st1.xml" xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"/>
<idPkg:Story src="Stories/Story_st2.xml" xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"/>
</Document>"#,
        );
        put(
            "Spreads/Spread_s1.xml",
            &format!(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Spread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="13.1">
{spread}</idPkg:Spread>"#
            ),
        );
        for st in ["st1", "st2"] {
            put(
                &format!("Stories/Story_{st}.xml"),
                &format!(
                    r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Story xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="13.1">
<Story Self="{st}"><ParagraphStyleRange><CharacterStyleRange>
<Content>Hello world</Content>
</CharacterStyleRange></ParagraphStyleRange></Story></idPkg:Story>"#
                ),
            );
        }
        zip.finish().unwrap();
    }
    let mut m = CanvasModel::load("anchored", &buf, CanvasOptions::default()).expect("load");
    let anchored = m
        .apply_mutation(&Mutation::InsertAnchoredFrame {
            paragraph: None,
            story_id: "st1".into(),
            offset: 0,
            width: 40.0,
            height: 40.0,
            image_uri: None,
            kind: None,
            layout: None,
            cell: None,
        })
        .expect("anchor a frame in st1")
        .created_id
        .expect("the anchored frame's id");
    let in_story = ElementId::StoryRange {
        story_id: "st1".into(),
        start: 0,
        end: 5,
        cell: None,
        paragraph: None,
    };
    let elsewhere = ElementId::StoryRange {
        story_id: "st2".into(),
        start: 0,
        end: 5,
        cell: None,
        paragraph: None,
    };
    let tf1 = ElementId::TextFrame("tf1".into());
    assert_eq!(
        m.scope_contains(&tf1, &[anchored.clone(), in_story, elsewhere]),
        vec![true, true, false],
        "the anchored frame and the frame's own text, not another story's"
    );
    assert_eq!(m.scope_subtree(&tf1).stories, vec!["st1".to_string()]);
    // The anchored frame is a root of its own too.
    assert!(m.scope_subtree(&anchored).found);
}

#[test]
fn uxi_t44_an_unknown_root_has_an_empty_scope() {
    let m = one_page("");
    let scope = m.scope_subtree(&group("nope"));
    assert!(!scope.found);
    assert_eq!(
        m.scope_contains(&group("nope"), &[group("nope"), rect("m")]),
        vec![false, false]
    );
}

#[test]
fn uxi_t44_the_revision_moves_with_the_document_and_the_scope_with_it() {
    let mut m = one_page("");
    let before = m.document_revision();
    assert_eq!(m.document_revision(), before, "a read does not move it");
    m.apply_mutation(&Mutation::PasteInto {
        container_id: rect("t"),
        child_id: rect("m"),
    })
    .expect("paste");
    assert!(m.document_revision() > before);
    assert!(m.scope_contains(&rect("t"), &[rect("m")])[0]);
    m.undo().expect("undo");
    assert!(
        !m.scope_contains(&rect("t"), &[rect("m")])[0],
        "undone, m left t"
    );
}

/// `UXI-CTX-010` — a press inside an entered context on an item outside
/// its scope neither selects nor moves it.
#[test]
fn uxi_t44_a_press_outside_the_scope_changes_nothing() {
    let mut m = one_page("");
    let steps = undo_len(&m);
    let mut p = press("p1", (150.0, 150.0)); // on m
    p.scope = Some(group("g"));
    p.target = paged_canvas::press::PressTarget::InGroup { id: "g".into() };
    let out = m.begin_gesture_at(&p);
    assert!(out.out_of_scope);
    assert!(out.handle.is_none() && out.target.is_none());
    assert!(m.element_selection.ids.is_empty(), "nothing selected");
    assert_eq!(m.active_gesture_handle(), None);
    // Inside the scope the press takes the member, not the group.
    let mut p = press("p1", (125.0, 325.0)); // on ga
    p.scope = Some(group("g"));
    p.target = paged_canvas::press::PressTarget::InGroup { id: "g".into() };
    let out = m.begin_gesture_at(&p);
    assert_eq!(out.target, Some(rect("ga")));
    let h = out.handle.expect("begun");
    m.cancel_gesture(h).expect("cancel");
    assert_eq!(undo_len(&m), steps);
}

// ── EN7: the press (engine ADR 1303; UXI-T58) ───────────────────────────

/// The hit, the selection and the gesture in one call; the drag's deltas
/// are measured from the press point, so it starts where the pointer went
/// down (`UXI-OWN-007`).
#[test]
fn uxi_t58_a_press_hits_selects_and_begins_in_one_call() {
    let mut m = one_page("");
    let steps = undo_len(&m);
    let out = m.begin_gesture_at(&press("p1", (150.0, 150.0)));
    assert_eq!(out.hit.element, Some(rect("m")));
    assert_eq!(out.target, Some(rect("m")));
    assert_eq!(out.selection, vec![rect("m")]);
    assert!(out.selection_changed && !out.marquee && out.refused.is_none());
    assert_eq!(m.element_selection.ids, vec![rect("m")]);
    let h = out.handle.expect("begun");
    // A move that came before the answer is a delta from the press point.
    m.update_gesture(h, (30.0, -20.0), none()).expect("update");
    m.commit_gesture(h).expect("commit");
    assert_eq!(bounds_of(&m, "m"), [80.0, 130.0, 180.0, 230.0], "no jump");
    assert_eq!(undo_len(&m), steps + 1, "one step");
    m.undo().expect("undo");
    assert_eq!(bounds_of(&m, "m"), [100.0, 100.0, 200.0, 200.0]);
}

#[test]
fn uxi_t58_a_press_on_nothing_is_a_marquee_and_changes_nothing() {
    let mut m = one_page("");
    m.element_selection.set(vec![rect("t")]);
    let out = m.begin_gesture_at(&press("p1", (400.0, 50.0)));
    assert!(out.marquee);
    assert!(out.handle.is_none() && out.target.is_none() && !out.selection_changed);
    assert_eq!(
        out.selection,
        vec![rect("t")],
        "the marquee's release decides"
    );
    assert_eq!(m.active_gesture_handle(), None);
}

#[test]
fn uxi_t58_a_press_on_a_group_member_takes_by_its_target_rule() {
    let mut m = one_page("");
    let on_ga = (125.0, 325.0);
    let out = m.begin_gesture_at(&press("p1", on_ga));
    assert_eq!(out.hit.element, Some(rect("ga")));
    assert_eq!(out.target, Some(group("g")), "the outermost group");
    m.cancel_gesture(out.handle.expect("begun"))
        .expect("cancel");
    let mut p = press("p1", on_ga);
    p.target = paged_canvas::press::PressTarget::Leaf;
    let out = m.begin_gesture_at(&p);
    assert_eq!(out.target, Some(rect("ga")), "direct selection: the leaf");
    m.cancel_gesture(out.handle.expect("begun"))
        .expect("cancel");
    // Inside another group's context a press leaves it: the outermost.
    let mut p = press("p1", on_ga);
    p.target = paged_canvas::press::PressTarget::InGroup { id: "other".into() };
    let out = m.begin_gesture_at(&p);
    assert_eq!(out.target, Some(group("g")));
    m.cancel_gesture(out.handle.expect("begun"))
        .expect("cancel");
}

/// `UXI-SEL-004` — a press on an item of the selection drags the whole
/// selection; on an item outside it, the item alone (`replace`) or the
/// selection with it (`toggle`).
#[test]
fn uxi_t58_select_policies_decide_what_the_drag_moves() {
    let mut m = one_page("");
    m.element_selection.set(vec![rect("m"), rect("t")]);
    let out = m.begin_gesture_at(&press("p1", (150.0, 150.0)));
    assert_eq!(out.selection, vec![rect("m"), rect("t")], "kept");
    assert!(!out.selection_changed);
    let h = out.handle.expect("begun");
    m.update_gesture(h, (10.0, 0.0), none()).expect("update");
    m.commit_gesture(h).expect("commit");
    assert_eq!(bounds_of(&m, "m")[1], 110.0);
    assert_eq!(bounds_of(&m, "t")[1], 510.0, "both moved");

    m.element_selection.set(vec![rect("t")]);
    let mut p = press("p1", (160.0, 150.0));
    p.select = paged_canvas::press::PressSelect::Toggle;
    let out = m.begin_gesture_at(&p);
    assert_eq!(out.selection, vec![rect("t"), rect("m")], "added");
    m.cancel_gesture(out.handle.expect("begun"))
        .expect("cancel");

    m.element_selection.set(vec![rect("t")]);
    let out = m.begin_gesture_at(&press("p1", (160.0, 150.0)));
    assert_eq!(out.selection, vec![rect("m")], "replaced");
    m.cancel_gesture(out.handle.expect("begun"))
        .expect("cancel");

    // `keep`: the selection moves whatever the press hit.
    m.element_selection.set(vec![rect("t")]);
    let mut p = press("p1", (400.0, 50.0)); // nothing there
    p.select = paged_canvas::press::PressSelect::Keep;
    let out = m.begin_gesture_at(&p);
    assert!(!out.marquee);
    assert_eq!(out.selection, vec![rect("t")]);
    let h = out.handle.expect("begun");
    m.update_gesture(h, (0.0, 5.0), none()).expect("update");
    m.commit_gesture(h).expect("commit");
    assert_eq!(bounds_of(&m, "t")[0], 505.0);
}

/// D-08 — a locked item is selected by the press and not moved; the
/// refusal says why.
#[test]
fn uxi_t58_a_locked_item_is_selected_and_its_drag_refused() {
    let mut m = page_with(
        r#"<Rectangle Self="lk" GeometricBounds="100 100 200 200" ItemTransform="1 0 0 1 0 0" FillColor="Color/Black" Locked="true"/>"#,
    );
    let out = m.begin_gesture_at(&press("p1", (150.0, 150.0)));
    assert_eq!(out.selection, vec![rect("lk")]);
    assert!(out.handle.is_none());
    assert!(
        matches!(out.refused, Some(paged_canvas::GestureError::Locked(_))),
        "{:?}",
        out.refused
    );
    assert_eq!(m.active_gesture_handle(), None);
}

#[test]
fn uxi_t58_a_press_during_a_gesture_changes_nothing() {
    let mut m = one_page("");
    let h = m
        .begin_gesture(vec![rect("t")], GestureType::Translate, None)
        .expect("begin");
    m.element_selection.set(vec![rect("t")]);
    let out = m.begin_gesture_at(&press("p1", (150.0, 150.0)));
    assert!(matches!(
        out.refused,
        Some(paged_canvas::GestureError::AlreadyActive(active)) if active == h
    ));
    assert_eq!(out.selection, vec![rect("t")], "the selection stands");
    assert!(out.handle.is_none() && out.target.is_none());
    m.cancel_gesture(h).expect("cancel");
}

// ── fuzz findings at PAGED_GESTURE_FUZZ_N=200 (engine ADR 1302) ─────────

/// Seeds 48, 141 and 155 — an Alt-drag of a selection on two spreads
/// failed at its commit (a snippet holds one spread). It copies each
/// spread's items onto that spread, all by the same offset, as one step.
#[test]
fn uxi_t06_an_alt_drag_across_two_spreads_copies_each_on_its_own_spread() {
    let mut m = facing();
    let before = all_rects(&m);
    let steps = undo_len(&m);
    let h = m
        .begin_gesture_with(
            vec![rect("r1"), rect("r3")],
            GestureType::Translate,
            None,
            Some(1.0),
            alt(),
        )
        .expect("begin: the copy can be made");
    let up = m.update_gesture(h, (12.0, 7.0), alt()).expect("update");
    assert!(up.duplicate_refused.is_none());
    let preview = all_rects(&m);
    m.commit_gesture(h).expect("commit");
    let after = all_rects(&m);
    assert_eq!(after, preview, "the commit equals the preview");
    assert_eq!(undo_len(&m), steps + 1, "one step");
    let new: Vec<_> = after
        .iter()
        .filter(|(_, id, _)| !before.iter().any(|(_, b, _)| b == id))
        .cloned()
        .collect();
    assert_eq!(new.len(), 2, "{new:?}");
    let orig = |id: &str| before.iter().find(|(_, i, _)| i == id).cloned().unwrap();
    for (spread, source) in [(0, "r1"), (1, "r3")] {
        let (si, _, b) = orig(source);
        assert_eq!(si, spread);
        let copy = new
            .iter()
            .find(|(s, _, _)| *s == spread)
            .expect("a copy on its spread");
        assert_eq!(
            copy.2,
            [b[0] + 7.0, b[1] + 12.0, b[2] + 7.0, b[3] + 12.0],
            "{source}"
        );
    }
    m.undo().expect("undo");
    assert_eq!(all_rects(&m), before, "one undo takes both copies");
    m.redo().expect("redo");
    assert_eq!(all_rects(&m), after);
}

/// D-16 — a selection that cannot be copied whole (here a frame and what
/// is pasted into it, which a copy of the frame already carries) is refused
/// at a press with Alt held, before anything moves; Alt pressed during the
/// drag keeps it a move, said why, and the commit moves as the preview.
#[test]
fn uxi_t06_a_selection_that_cannot_copy_is_refused_whole_and_said_why() {
    let mut m = page_with(
        r#"<Rectangle Self="box" GeometricBounds="100 100 300 300" ItemTransform="1 0 0 1 0 0" FillColor="Color/Black"/>
<Oval Self="dot" GeometricBounds="150 150 200 200" ItemTransform="1 0 0 1 0 0" FillColor="Color/Black"/>"#,
    );
    m.apply_mutation(&Mutation::PasteInto {
        container_id: rect("box"),
        child_id: ElementId::Oval("dot".into()),
    })
    .expect("paste the oval in");
    let opened = m.export_idml().expect("export");
    let steps = undo_len(&m);
    let both = vec![rect("box"), ElementId::Oval("dot".into())];
    let err = m
        .begin_gesture_with(both.clone(), GestureType::Translate, None, Some(1.0), alt())
        .expect_err("refused at the press");
    match err {
        paged_canvas::GestureError::DuplicateRefused(r) => {
            assert!(!r.reason.is_empty(), "{r:?}");
        }
        other => panic!("expected DuplicateRefused, got {other:?}"),
    }
    assert_eq!(m.export_idml().expect("export"), opened, "nothing moved");
    assert_eq!(m.active_gesture_handle(), None);
    // Alt pressed during the drag: a move, with the reason.
    let h = m
        .begin_gesture(both, GestureType::Translate, None)
        .expect("begin without Alt");
    let up = m.update_gesture(h, (20.0, 0.0), alt()).expect("update");
    assert!(up.duplicate_refused.is_some(), "the update says why");
    let preview = rects(&m);
    m.commit_gesture(h).expect("the commit moves");
    assert_eq!(rects(&m), preview, "as the preview showed");
    assert_eq!(bounds_of(&m, "box")[1], 120.0);
    assert_eq!(undo_len(&m), steps + 1);
}

/// Seed 31 — a pasted copy of a resized path drifted on save → load: the
/// resize wrote the path's box and not its anchors, and a copy written
/// afresh took its box from the stale path. The resize carries the path.
#[test]
fn a_resized_path_carries_its_anchors_and_its_copy_round_trips() {
    let mut m = page_with(
        r#"<Polygon Self="path" ItemTransform="1 0 0 1 0 0" StrokeWeight="1" StrokeColor="Color/Black" FillColor="Swatch/None">
<Properties><PathGeometry><GeometryPathType PathOpen="true"><PathPointArray>
<PathPointType Anchor="72 620" LeftDirection="72 620" RightDirection="72 620"/>
<PathPointType Anchor="144 680" LeftDirection="144 680" RightDirection="144 680"/>
<PathPointType Anchor="216 620" LeftDirection="216 620" RightDirection="216 620"/>
</PathPointArray></GeometryPathType></PathGeometry></Properties></Polygon>"#,
    );
    let poly = ElementId::Polygon("path".into());
    let h = m
        .begin_gesture(
            vec![poly.clone()],
            GestureType::Resize {
                handle: ResizeHandle::NorthEast,
            },
            None,
        )
        .expect("begin");
    m.update_gesture(h, (36.0, -60.0), none()).expect("update");
    m.commit_gesture(h).expect("commit");
    let p = &m.scene().spreads[0].spread.polygons[0];
    let xs: Vec<f32> = p.anchors.iter().map(|a| a.anchor.0).collect();
    let ys: Vec<f32> = p.anchors.iter().map(|a| a.anchor.1).collect();
    let extent = [
        ys.iter().cloned().fold(f32::INFINITY, f32::min),
        xs.iter().cloned().fold(f32::INFINITY, f32::min),
        ys.iter().cloned().fold(f32::NEG_INFINITY, f32::max),
        xs.iter().cloned().fold(f32::NEG_INFINITY, f32::max),
    ];
    let b = p.bounds;
    assert_eq!(
        extent,
        [b.top, b.left, b.bottom, b.right],
        "the path fills its box"
    );
    assert_eq!(extent, [560.0, 72.0, 680.0, 252.0]);
    // The copy, written afresh, reads back where it was.
    let h = m
        .begin_gesture_with(vec![poly], GestureType::Translate, None, Some(1.0), alt())
        .expect("begin");
    m.update_gesture(h, (0.0, 0.0), alt()).expect("update");
    m.commit_gesture(h).expect("commit");
    let boxes = |m: &CanvasModel| {
        let mut v: Vec<[f32; 4]> = m.scene().spreads[0]
            .spread
            .polygons
            .iter()
            .map(|p| [p.bounds.top, p.bounds.left, p.bounds.bottom, p.bounds.right])
            .collect();
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        v
    };
    let saved = m.export_idml().expect("export");
    let back = CanvasModel::load("back", &saved, CanvasOptions::default()).expect("reload");
    assert_eq!(boxes(&back), boxes(&m), "the copy round-trips");
    assert_eq!(boxes(&m).len(), 2);
}

// ── EN6: the import's losses on the load (engine ADR 1305) ─────────────

#[test]
fn an_opened_document_reports_what_it_could_not_show() {
    let m = page_with(
        r#"<Rectangle Self="pic" GeometricBounds="100 100 300 300" ItemTransform="1 0 0 1 0 0">
<Image Self="img" ItemTransform="1 0 0 1 0 0"><Link Self="lnk" LinkResourceURI="file:///nowhere/missing.png"/></Image>
</Rectangle>"#,
    );
    let losses = m.handle().losses;
    let missing = losses
        .iter()
        .find(|l| l.code == "idml.import.linkMissing")
        .unwrap_or_else(|| panic!("a missing link is reported: {losses:?}"));
    assert_eq!(missing.items, vec!["pic".to_string()]);
    assert_eq!(missing.pages, vec![0]);
    // A document that shows all it names reports nothing.
    assert!(one_page("").handle().losses.is_empty());
}

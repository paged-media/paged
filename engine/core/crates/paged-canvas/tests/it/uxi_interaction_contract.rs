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

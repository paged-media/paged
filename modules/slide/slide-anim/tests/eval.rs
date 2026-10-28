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

//! The player against PowerPoint's own behaviours: the presets as the
//! oracle fixture recorded them (the preset table), the fixture's timing
//! slide, evaluated at known moments.

use std::collections::BTreeMap;

use pptx_core::anim::Timing;
use serde_json::json;
use slide_anim::author::{apply, Edit};
use slide_anim::eval::{Bounds, Event, Frame, LayerState};
use slide_anim::player::{Player, PlayerInput, Size};

const W: f64 = 960.0;
const H: f64 = 540.0;

fn edit(t: Option<&Timing>, e: serde_json::Value) -> Option<Timing> {
    let e: Edit = serde_json::from_value(e).unwrap();
    apply(t, &e).unwrap()
}

fn add(t: Option<&Timing>, spid: &str, class: &str, id: i32, extra: serde_json::Value) -> Timing {
    let mut e = json!({
        "kind": "add",
        "target": { "spid": spid },
        "presetClass": class,
        "presetId": id,
    });
    if let (Some(m), Some(x)) = (e.as_object_mut(), extra.as_object()) {
        for (k, v) in x {
            m.insert(k.clone(), v.clone());
        }
    }
    edit(t, e).unwrap()
}

fn player(t: &Timing) -> Player {
    let mut boxes = BTreeMap::new();
    for id in ["2", "3", "4", "5", "6", "7"] {
        boxes.insert(
            format!("spid:{id}"),
            Bounds {
                x: 100.0,
                y: 100.0,
                w: 200.0,
                h: 100.0,
            },
        );
    }
    Player::new(PlayerInput {
        timing: Some(t.clone()),
        slide: Size { w: W, h: H },
        boxes,
        theme: BTreeMap::new(),
        colors: BTreeMap::new(),
    })
}

fn next(at: f64) -> Event {
    Event {
        kind: "next".into(),
        at,
        target: None,
    }
}

fn layer<'a>(f: &'a Frame, k: &str) -> &'a LayerState {
    f.layers
        .get(k)
        .unwrap_or_else(|| panic!("no layer {k}: {:?}", f.layers.keys()))
}

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-3
}

#[test]
fn fly_in_from_the_left_starts_off_the_slide_and_lands() {
    let t = add(None, "2", "entr", 2, json!({ "presetSubtype": 8 }));
    let p = player(&t);
    assert_eq!(p.clicks(), 1);
    // Before the click: hidden.
    let f = p.evaluate(&[], 100.0);
    assert!(!layer(&f, "spid:2").visible);
    assert!(!f.running);
    // At the click: its right edge at the slide's left (ppt_x = 0 - w/2).
    let f = p.evaluate(&[next(0.0)], 0.0);
    let l = layer(&f, "spid:2");
    assert!(l.visible);
    assert!(close(l.dx, -(100.0 + 200.0)), "{}", l.dx);
    assert!(f.running);
    // Half way, then at rest.
    let f = p.evaluate(&[next(0.0)], 250.0);
    assert!(close(layer(&f, "spid:2").dx, -150.0));
    let f = p.evaluate(&[next(0.0)], 500.0);
    let l = layer(&f, "spid:2");
    assert!(close(l.dx, 0.0) && close(l.dy, 0.0));
    assert!(!f.running);
}

#[test]
fn fade_and_wipe_are_masks() {
    let t = add(None, "2", "entr", 10, json!({}));
    let f = player(&t).evaluate(&[next(0.0)], 250.0);
    let m = layer(&f, "spid:2").mask.clone().unwrap();
    assert_eq!((m.filter.as_str(), m.out), ("fade", false));
    assert!(close(m.progress, 0.5));
    let f = player(&t).evaluate(&[next(0.0)], 600.0);
    assert!(layer(&f, "spid:2").mask.is_none());
    let t = add(None, "2", "entr", 22, json!({}));
    let f = player(&t).evaluate(&[next(0.0)], 100.0);
    let m = layer(&f, "spid:2").mask.clone().unwrap();
    assert_eq!(
        (m.filter.as_str(), m.sub.as_deref()),
        ("wipe", Some("down"))
    );
    let t = add(None, "2", "entr", 22, json!({ "presetSubtype": 8 }));
    let f = player(&t).evaluate(&[next(0.0)], 100.0);
    // PowerPoint names the wipe by the edge it starts from ("From Left":
    // `wipe(left)`).
    assert_eq!(
        layer(&f, "spid:2").mask.clone().unwrap().sub.as_deref(),
        Some("left")
    );
}

#[test]
fn spin_turns_half_way_and_grow_shrink_scales() {
    let t = add(None, "2", "emph", 8, json!({}));
    let p = player(&t);
    // An emphasis does not hide the shape first.
    assert!(layer(&p.evaluate(&[], 0.0), "spid:2").visible);
    let f = p.evaluate(&[next(0.0)], 1000.0);
    assert!(
        close(layer(&f, "spid:2").rot, 180.0),
        "{}",
        layer(&f, "spid:2").rot
    );
    let f = p.evaluate(&[next(0.0)], 5000.0);
    assert!(close(layer(&f, "spid:2").rot, 360.0));
    let t = add(None, "2", "emph", 6, json!({}));
    let f = player(&t).evaluate(&[next(0.0)], 5000.0);
    let l = layer(&f, "spid:2");
    assert!(close(l.sx, 1.5) && close(l.sy, 1.5), "{} {}", l.sx, l.sy);
}

#[test]
fn auto_reverse_returns() {
    let t = add(None, "2", "emph", 8, json!({}));
    let t = edit(
        Some(&t),
        json!({ "kind": "timing", "index": 0, "rewind": true }),
    )
    .unwrap();
    let p = player(&t);
    let f = p.evaluate(&[next(0.0)], 2000.0);
    assert!(close(layer(&f, "spid:2").rot, 360.0));
    let f = p.evaluate(&[next(0.0)], 3000.0);
    assert!(close(layer(&f, "spid:2").rot, 180.0));
    let f = p.evaluate(&[next(0.0)], 9000.0);
    assert!(close(layer(&f, "spid:2").rot, 0.0));
}

#[test]
fn a_motion_path_ends_at_its_end() {
    for id in [42, 63, 1, 46] {
        let t = add(None, "2", "path", id, json!({}));
        let path = {
            let mut p = None;
            t.walk(&mut |n| {
                if let pptx_core::anim::TimeNode::AnimMotion { path, .. } = n {
                    p = path.clone();
                }
            });
            p.unwrap()
        };
        let end = slide_anim::path::MotionPath::parse(&path, W, H).end();
        let f = player(&t).evaluate(&[next(0.0)], 60_000.0);
        let l = layer(&f, "spid:2");
        assert!(
            close(l.dx, end.0 * W) && close(l.dy, end.1 * H),
            "path {id}: {l:?} vs {end:?}"
        );
    }
}

#[test]
fn exits_end_hidden_and_start_visible() {
    for id in [10, 2, 22, 6, 1] {
        let t = add(None, "2", "exit", id, json!({}));
        let p = player(&t);
        assert!(layer(&p.evaluate(&[], 0.0), "spid:2").visible, "exit {id}");
        assert!(
            !layer(&p.evaluate(&[next(0.0)], 10_000.0), "spid:2").visible,
            "exit {id}"
        );
    }
}

#[test]
fn every_preset_plays_from_hidden_or_shown_to_its_end() {
    // Every recorded preset: the player reads it and reaches a still frame.
    let mut bad = Vec::new();
    for p in &slide_anim::presets::table().presets {
        let t = add(None, "2", &p.c, p.i, json!({ "presetSubtype": p.s }));
        let pl = player(&t);
        let start = pl.evaluate(&[], 0.0);
        let end = pl.evaluate(&[next(0.0)], 600_000.0);
        let l = layer(&end, "spid:2");
        assert!(!end.running, "{} {} {}", p.c, p.i, p.s);
        match p.c.as_str() {
            "entr" => {
                assert!(!layer(&start, "spid:2").visible, "entr {} {}", p.i, p.s);
                assert!(l.visible, "entr {} {}", p.i, p.s);
                // Credits scrolls up through the slide and off it.
                if p.i != 28
                    && !(l.mask.is_none()
                        && close(l.dx, 0.0)
                        && close(l.dy, 0.0)
                        && close(l.sx, 1.0)
                        && close(l.rot.rem_euclid(360.0), 0.0))
                {
                    bad.push(format!("entr {} {}: {l:?}", p.i, p.s));
                }
            }
            "exit" => assert!(!l.visible, "exit {} {}", p.i, p.s),
            _ => assert!(l.visible, "{} {} {}", p.c, p.i, p.s),
        }
    }
    assert!(bad.is_empty(), "{}", bad.join("\n"));
}

#[test]
fn paragraphs_build_one_click_each() {
    let t = add(
        None,
        "2",
        "entr",
        10,
        json!({ "paragraphs": 2, "hasText": true }),
    );
    let p = player(&t);
    assert_eq!(p.clicks(), 3);
    let at = |clicks: usize| {
        let ev: Vec<Event> = (0..clicks).map(|i| next(i as f64 * -10_000.0)).collect();
        let f = p.evaluate(&ev, 0.0);
        (
            layer(&f, "spid:2#bg").visible,
            layer(&f, "spid:2#p0").visible,
            layer(&f, "spid:2#p1").visible,
        )
    };
    assert_eq!(at(0), (false, false, false));
    assert_eq!(at(1), (true, false, false));
    assert_eq!(at(2), (true, true, false));
    assert_eq!(at(3), (true, true, true));
}

#[test]
fn with_and_after_previous() {
    let t = add(None, "2", "entr", 10, json!({}));
    let t = add(Some(&t), "3", "entr", 10, json!({ "start": "after" }));
    let t = add(
        Some(&t),
        "4",
        "entr",
        10,
        json!({ "start": "with", "delayMs": 200 }),
    );
    let p = player(&t);
    assert_eq!(p.clicks(), 1);
    let f = p.evaluate(&[next(0.0)], 250.0);
    assert!(layer(&f, "spid:2").visible && !layer(&f, "spid:3").visible);
    assert_eq!(f.next_change, Some(500.0));
    let f = p.evaluate(&[next(0.0)], 600.0);
    assert!(layer(&f, "spid:3").visible);
    // With the after-previous one, after 200 ms.
    assert!(!layer(&f, "spid:4").visible);
    let f = p.evaluate(&[next(0.0)], 750.0);
    assert!(layer(&f, "spid:4").visible);
    // Starting by itself: no click.
    let t = add(None, "2", "entr", 10, json!({ "start": "with" }));
    let p = player(&t);
    assert_eq!(p.clicks(), 0);
    assert!(layer(&p.evaluate(&[], 100.0), "spid:2").visible);
}

#[test]
fn a_click_during_an_effect_takes_it_to_its_end() {
    let t = add(None, "2", "entr", 2, json!({}));
    let t = add(Some(&t), "3", "entr", 2, json!({}));
    let p = player(&t);
    let f = p.evaluate(&[next(0.0), next(100.0)], 100.0);
    let a = layer(&f, "spid:2");
    assert!(a.visible && close(a.dy, 0.0), "{a:?}");
    let b = layer(&f, "spid:3");
    assert!(b.visible && b.dy > 100.0, "{b:?}");
}

#[test]
fn a_trigger_plays_on_a_click_on_its_shape() {
    let t = add(None, "2", "entr", 10, json!({}));
    let t = add(Some(&t), "4", "emph", 8, json!({}));
    let t = edit(
        Some(&t),
        json!({ "kind": "timing", "index": 1, "trigger": { "spid": "3" } }),
    )
    .unwrap();
    let p = player(&t);
    assert_eq!(p.clicks(), 1);
    let click = Event {
        kind: "click".into(),
        at: 0.0,
        target: Some("spid:3".into()),
    };
    assert!(close(layer(&p.evaluate(&[], 1000.0), "spid:4").rot, 0.0));
    let f = p.evaluate(&[click], 1000.0);
    assert!(close(layer(&f, "spid:4").rot, 180.0));
    // The slide's click does not play it.
    let f = p.evaluate(&[next(0.0)], 1000.0);
    assert!(close(layer(&f, "spid:4").rot, 0.0));
    assert!(layer(&f, "spid:2").visible);
}

#[test]
fn the_fixture_timing_slide_at_known_moments() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../slide-conformance/fixtures/animations.pptx");
    let deck = pptx_import::import_pptx(&std::fs::read(path).unwrap()).unwrap();
    let s = deck
        .slides
        .iter()
        .find(|s| {
            s.shapes.iter().any(
                |x| matches!(x, pptx_core::Shape::Sp(sp) if sp.nv.name == "timing with previous"),
            )
        })
        .unwrap();
    let p = player(s.timing.as_ref().unwrap());
    // The fade with previous starts with the slide, the 2 s fade after it.
    assert_eq!(p.clicks(), 4);
    let f = p.evaluate(&[], 250.0);
    assert!(close(
        layer(&f, "spid:2").mask.clone().unwrap().progress,
        0.5
    ));
    assert!(!layer(&f, "spid:3").visible);
    let f = p.evaluate(&[], 1500.0);
    assert!(close(
        layer(&f, "spid:3").mask.clone().unwrap().progress,
        0.5
    ));
    // Click 2: the spin, 2 s, three times, reversing.
    let ev = [next(-10_000.0), next(0.0)];
    let rot = |t: f64| layer(&p.evaluate(&ev, t), "spid:5").rot;
    assert!(close(rot(1000.0), 180.0));
    assert!(close(rot(3000.0), 180.0));
    assert!(close(rot(4000.0), 0.0));
    assert!(close(rot(5000.0), 180.0));
    assert!(close(rot(20_000.0), 0.0));
    // Click 3: the smooth fly — half way at half time, slower at the start.
    let ev = [next(-20_000.0), next(-10_000.0), next(0.0)];
    let dy = |t: f64| layer(&p.evaluate(&ev, t), "spid:6").dy;
    let full = dy(0.0);
    assert!(full > 0.0);
    assert!(close(dy(250.0), full / 2.0), "{} {}", dy(250.0), full);
    assert!(dy(125.0) > full * 0.75);
    // Click 4: the fade that rewinds when done is gone again.
    let ev = [next(-30_000.0), next(-20_000.0), next(-10_000.0), next(0.0)];
    assert!(layer(&p.evaluate(&ev, 250.0), "spid:7").visible);
    assert!(!layer(&p.evaluate(&ev, 1000.0), "spid:7").visible);
}

#[test]
fn the_same_input_gives_the_same_frame() {
    let t = add(None, "2", "entr", 15, json!({}));
    let p = player(&t);
    let a = p
        .evaluate_json(r#"[{"kind":"next","at":0}]"#, 333.0)
        .unwrap();
    let b = player(&t)
        .evaluate_json(r#"[{"kind":"next","at":0}]"#, 333.0)
        .unwrap();
    assert_eq!(a, b);
    let v: serde_json::Value = serde_json::from_str(&a).unwrap();
    assert!(v["layers"]["spid:2"]["visible"].as_bool().unwrap());
    assert!(v.get("nextChange").is_some());
}

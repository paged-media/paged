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

//! Live presets: handles, refit, connection sites, connectors.

use dml_geom::live::{
    drag_handle, flatten, handles, mul, part_of, refit_preset, route, sites_on_page, Anchor, Part,
    Refit, IDENTITY,
};
use dml_geom::{preset, preset_evaluated, preset_geometry, preset_names, Site};

fn anchors_of(
    name: &str,
    adj: &[(String, String)],
    w: f64,
    h: f64,
    part: Part,
) -> (Vec<Anchor>, Vec<usize>) {
    let o = preset(name, adj, w, h).unwrap();
    let (a, s, _) = flatten(&part_of(&o.subpaths, part));
    (a, s)
}

fn scaled(a: &[Anchor], sx: f64, sy: f64, ox: f64, oy: f64) -> Vec<Anchor> {
    a.iter()
        .map(|p| p.map(|(x, y)| (x * sx + ox, y * sy + oy)))
        .collect()
}

fn close(a: f64, b: f64, eps: f64) -> bool {
    (a - b).abs() <= eps
}

#[test]
fn every_handle_and_site_of_every_preset_is_read() {
    let mut handles = 0;
    let mut with_sites = 0;
    for n in preset_names() {
        let g = preset_geometry(n).unwrap();
        handles += g.handles.len();
        if !g.connections.is_empty() {
            with_sites += 1;
        }
        let e = preset_evaluated(n, &[], 200.0, 100.0).unwrap();
        assert_eq!(e.handles.len(), g.handles.len(), "{n}");
        for h in &e.handles {
            assert!(h.pos.0.is_finite() && h.pos.1.is_finite(), "{n}");
            assert!(!h.refs.is_empty(), "{n}: a handle that moves nothing");
        }
        for s in &e.sites {
            assert!((0.0..360.0).contains(&s.angle), "{n}: {}", s.angle);
        }
    }
    // ECMA-376 Annex D: 243 adjust handles; 174 presets with connection
    // sites (lines, arcs and the like have none).
    assert_eq!(handles, 243);
    assert_eq!(with_sites, 174);
}

#[test]
fn a_resized_round_rect_keeps_its_corner_radius() {
    let (a, s) = anchors_of("roundRect", &[], 200.0, 100.0, Part::Fill);
    // The host scaled the path to 300 × 80 and moved it by (10, 5).
    let now = scaled(&a, 1.5, 0.8, 10.0, 5.0);
    let Some(Refit::Regenerated(r)) =
        refit_preset("roundRect", &[], 200.0, 100.0, &now, &s, &IDENTITY)
    else {
        panic!("not regenerated")
    };
    assert!(
        close(r.w, 300.0, 1e-6) && close(r.h, 80.0, 1e-6),
        "{} {}",
        r.w,
        r.h
    );
    assert_eq!(r.part, Part::Fill);
    let want = [1.0, 0.0, 0.0, 1.0, 10.0, 5.0];
    assert!(
        r.transform
            .iter()
            .zip(want)
            .all(|(a, b)| close(*a, b, 1e-9)),
        "{:?}",
        r.transform
    );
    // Corner radius: 16 667 / 100 000 of the short side (80).
    let first_corner = r.subpaths[0]
        .points
        .iter()
        .map(|p| p.anchor.0)
        .filter(|&x| x > 1e-6)
        .fold(f64::MAX, f64::min);
    assert!(close(first_corner, 80.0 * 0.16667, 0.01), "{first_corner}");
    // Scaling would have stretched it to 25 × 13.3.
    assert!(!close(first_corner, 16.667 * 1.5, 0.5));
    // The answer refits as itself.
    let (a2, s2, _) = flatten(&r.subpaths);
    assert_eq!(
        refit_preset("roundRect", &[], r.w, r.h, &a2, &s2, &r.transform),
        Some(Refit::Same)
    );
}

#[test]
fn a_scaled_transform_moves_into_the_box() {
    // A group resize scales the item's transform instead of its anchors.
    let (a, s) = anchors_of("rightArrow", &[], 120.0, 60.0, Part::Fill);
    let rot = {
        let (c, sn) = (0.0f64.cos(), 0.0f64.sin());
        [c, sn, -sn, c, 50.0, 40.0]
    };
    let t = mul(&rot, &[2.0, 0.0, 0.0, 0.5, 0.0, 0.0]);
    let Some(Refit::Regenerated(r)) = refit_preset("rightArrow", &[], 120.0, 60.0, &a, &s, &t)
    else {
        panic!()
    };
    assert!(close(r.w, 240.0, 1e-6) && close(r.h, 30.0, 1e-6));
    assert!(r.transform[..4]
        .iter()
        .zip(&rot[..4])
        .all(|(x, y)| close(*x, *y, 1e-9)));
    assert_eq!(r.scale, (2.0, 0.5));
}

#[test]
fn a_flip_by_resize_stays_a_flip() {
    let (a, s) = anchors_of("rtTriangle", &[], 100.0, 100.0, Part::Fill);
    // Dragged past its left edge: x mirrored.
    let now = scaled(&a, -1.0, 1.0, 100.0, 0.0);
    let Some(Refit::Regenerated(r)) =
        refit_preset("rtTriangle", &[], 100.0, 100.0, &now, &s, &IDENTITY)
    else {
        panic!()
    };
    assert!(close(r.w, 100.0, 1e-9));
    let want = [-1.0, 0.0, 0.0, 1.0, 100.0, 0.0];
    assert!(
        r.transform
            .iter()
            .zip(want)
            .all(|(a, b)| close(*a, b, 1e-9)),
        "{:?}",
        r.transform
    );
}

#[test]
fn unchanged_is_same_and_hand_edited_is_reshaped() {
    let (a, s) = anchors_of("star5", &[], 100.0, 100.0, Part::Fill);
    assert_eq!(
        refit_preset("star5", &[], 100.0, 100.0, &a, &s, &IDENTITY),
        Some(Refit::Same)
    );
    let mut moved = a.clone();
    moved[3][0].0 += 7.0;
    assert_eq!(
        refit_preset("star5", &[], 100.0, 100.0, &moved, &s, &IDENTITY),
        Some(Refit::Reshaped)
    );
    // A moved item is the same preset (its transform moves, not its anchors).
    let t = [1.0, 0.0, 0.0, 1.0, 30.0, 40.0];
    assert_eq!(
        refit_preset("star5", &[], 100.0, 100.0, &a, &s, &t),
        Some(Refit::Same)
    );
}

#[test]
fn a_detail_element_refits_as_the_detail() {
    // `can`: a filled body and a stroke-only rim.
    let (a, s) = anchors_of("can", &[], 80.0, 120.0, Part::Detail);
    assert!(!a.is_empty());
    let now = scaled(&a, 2.0, 1.0, 0.0, 0.0);
    let Some(Refit::Regenerated(r)) = refit_preset("can", &[], 80.0, 120.0, &now, &s, &IDENTITY)
    else {
        panic!()
    };
    assert_eq!(r.part, Part::Detail);
    assert!(close(r.w, 160.0, 1e-6));
}

#[test]
fn every_handle_round_trips_through_its_adjust_values() {
    // Dragging a handle to where it already is reproduces its position:
    // adjust → handle → adjust → path → refit, for every handle.
    let (w, h) = (200.0, 120.0);
    let mut checked = 0;
    for n in preset_names() {
        let hs = handles(n, &[], w, h).unwrap();
        for (i, hd) in hs.iter().enumerate() {
            let adj = drag_handle(n, &[], w, h, i, hd.pos).unwrap();
            let back = handles(n, &adj, w, h).unwrap();
            let p = back[i].pos;
            assert!(
                close(p.0, hd.pos.0, 0.75) && close(p.1, hd.pos.1, 0.75),
                "{n} handle {i}: {:?} → {:?} ({adj:?})",
                hd.pos,
                p
            );
            // The outline the new values draw refits as itself.
            let (a, s) = anchors_of(n, &adj, w, h, Part::All);
            assert_eq!(
                refit_preset(n, &adj, w, h, &a, &s, &IDENTITY),
                Some(Refit::Same),
                "{n}"
            );
            checked += 1;
        }
    }
    assert_eq!(checked, 243);
}

#[test]
fn dragging_a_round_rect_handle_sets_its_radius() {
    // roundRect's handle sits at (x1, t), x1 = ss · adj / 100 000.
    let adj = drag_handle("roundRect", &[], 200.0, 100.0, 0, (30.0, 0.0)).unwrap();
    assert_eq!(adj, vec![("adj".to_string(), "val 30000".to_string())]);
    // Past its range (50 000), it stops there.
    let adj = drag_handle("roundRect", &[], 200.0, 100.0, 0, (90.0, 0.0)).unwrap();
    assert_eq!(adj, vec![("adj".to_string(), "val 50000".to_string())]);
}

#[test]
fn dragging_a_callout_leader_on_an_unbounded_range() {
    // wedgeRectCallout: the tip at (xPos, yPos), adj1/adj2 unbounded.
    let adj = drag_handle("wedgeRectCallout", &[], 200.0, 100.0, 0, (-50.0, 180.0)).unwrap();
    let back = handles("wedgeRectCallout", &adj, 200.0, 100.0).unwrap();
    assert!(
        close(back[0].pos.0, -50.0, 0.5) && close(back[0].pos.1, 180.0, 0.5),
        "{:?}",
        back[0].pos
    );
}

#[test]
fn rect_sites_are_its_side_midpoints() {
    let s = preset_evaluated("rect", &[], 200.0, 100.0).unwrap().sites;
    let got: Vec<((f64, f64), f64)> = s.iter().map(|s| (s.pos, s.angle)).collect();
    assert_eq!(
        got,
        vec![
            ((100.0, 0.0), 270.0),
            ((0.0, 50.0), 180.0),
            ((100.0, 100.0), 90.0),
            ((200.0, 50.0), 0.0)
        ]
    );
}

#[test]
fn sites_follow_the_shape_on_the_page() {
    // A quarter turn clockwise about the origin, then moved by (300, 10).
    let t = [0.0, 1.0, -1.0, 0.0, 300.0, 10.0];
    let s = sites_on_page("rect", &[], 200.0, 100.0, &t);
    // The right side's midpoint (200, 50) → (250, 210), facing down.
    assert!(close(s[3].pos.0, 250.0, 1e-9) && close(s[3].pos.1, 210.0, 1e-9));
    assert!(close(s[3].angle, 90.0, 1e-9));
    // An unknown name takes a rectangle's sites.
    assert_eq!(
        sites_on_page("noSuchShape", &[], 200.0, 100.0, &IDENTITY).len(),
        4
    );
}

#[test]
fn connectors_run_from_site_to_site() {
    let a = Site {
        pos: (100.0, 50.0),
        angle: 0.0,
    };
    let b = Site {
        pos: (20.0, 200.0),
        angle: 180.0,
    };
    for name in [
        "straightConnector1",
        "bentConnector3",
        "curvedConnector3",
        "bentConnector2",
    ] {
        let r = route(name, &[], a, b).unwrap();
        let first = r.subpaths[0].points.first().unwrap().anchor;
        let last = r.subpaths.last().unwrap().points.last().unwrap().anchor;
        let p0 = dml_geom::live::apply(&r.transform, first);
        let p1 = dml_geom::live::apply(&r.transform, last);
        assert!(
            close(p0.0, 100.0, 1e-6) && close(p0.1, 50.0, 1e-6),
            "{name} {p0:?}"
        );
        assert!(
            close(p1.0, 20.0, 1e-6) && close(p1.1, 200.0, 1e-6),
            "{name} {p1:?}"
        );
    }
    // An elbow leaving a site that faces down starts vertically.
    let down = Site {
        pos: (0.0, 0.0),
        angle: 90.0,
    };
    let r = route(
        "bentConnector3",
        &[],
        down,
        Site {
            pos: (100.0, 80.0),
            angle: 270.0,
        },
    )
    .unwrap();
    let pts = &r.subpaths[0].points;
    let p0 = dml_geom::live::apply(&r.transform, pts[0].anchor);
    let p1 = dml_geom::live::apply(&r.transform, pts[1].anchor);
    assert!(close(p0.0, p1.0, 1e-9) && p1.1 > p0.1, "{p0:?} {p1:?}");
}

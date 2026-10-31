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

//! The preset table against the PowerPoint fixture (slide ADR 705).

use std::collections::BTreeMap;

use pptx_core::anim::{TimeNode, Timing};
use pptx_core::{Presentation, Shape};

use super::*;
use crate::author::{apply, Edit, TargetRef};
use crate::flat::{self, Start};

pub(crate) fn fixture() -> Presentation {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../slide-conformance/fixtures/animations.pptx");
    let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    pptx_import::import_pptx(&bytes).unwrap()
}

fn names(shapes: &[Shape]) -> BTreeMap<String, String> {
    shapes
        .iter()
        .filter_map(|s| match s {
            Shape::Sp(sp) => Some((sp.nv.id.to_string(), sp.nv.name.clone())),
            _ => None,
        })
        .collect()
}

/// The effect as a template: ids, start and group left out, the shape as
/// `S`.
fn normalize(n: &TimeNode) -> String {
    let mut n = n.clone();
    n.walk_mut(&mut |x| {
        if let Some(c) = x.ctn_mut() {
            c.id = None;
        }
    });
    if let Some(c) = n.ctn_mut() {
        c.node_type = None;
        // PowerPoint leaves the group out of some effects (no text
        // build): kept as recorded, set when the effect is added.
        if c.grp_id.is_some() {
            c.grp_id = Some(0);
        }
    }
    let mut t = Timing {
        nodes: vec![n],
        ..Default::default()
    };
    t.for_each_sp_target(&mut |spid, item, key| {
        *spid = SPID.into();
        *item = None;
        *key = None;
    });
    let x = t.to_xml();
    x["<p:timing><p:tnLst>".len()..x.len() - "</p:tnLst></p:timing>".len()].to_string()
}

/// The table the fixture gives.
fn from_fixture() -> Table {
    let deck = fixture();
    let mut presets: Vec<Template> = Vec::new();
    for s in &deck.slides {
        let Some(t) = &s.timing else { continue };
        let names = names(&s.shapes);
        let f = flat::flatten(t).unwrap_or_else(|| panic!("{}: not canonical", s.part));
        for e in &f.effects {
            let Some(target) = e.target() else { continue };
            let name = names.get(&target.spid).cloned().unwrap_or_default();
            if name.split('|').count() != 3 {
                continue;
            }
            let c = e.ctn();
            let (Some(class), Some(id), Some(sub)) =
                (c.preset_class.clone(), c.preset_id, c.preset_subtype)
            else {
                continue;
            };
            if presets
                .iter()
                .any(|p| p.c == class && p.i == id && p.s == sub)
            {
                continue;
            }
            let b = t.builds.iter().flatten().find_map(|b| match b {
                pptx_core::anim::Build::P { spid, anim_bg, .. } if *spid == target.spid => {
                    Some(*anim_bg == Some(true))
                }
                _ => None,
            });
            presets.push(Template {
                c: class,
                i: id,
                s: sub,
                x: encode(&normalize(&e.node)),
                d: false,
                b,
            });
        }
    }
    // Directions the dictionary cannot set: the recorded one with the
    // filter's argument changed.
    let derive: &[(i32, i32, &str, i32, &str)] = &[
        (21, 1, "wheel(1)", 2, "wheel(2)"),
        (21, 1, "wheel(1)", 3, "wheel(3)"),
        (21, 1, "wheel(1)", 4, "wheel(4)"),
        (21, 1, "wheel(1)", 8, "wheel(8)"),
        (3, 10, "blinds(horizontal)", 5, "blinds(vertical)"),
        (5, 10, "checkerboard(across)", 5, "checkerboard(down)"),
        (14, 10, "randombar(horizontal)", 5, "randombar(vertical)"),
    ];
    for class in ["entr", "exit"] {
        for (id, from, f0, to, f1) in derive {
            let Some(base) = presets
                .iter()
                .find(|p| p.c == class && p.i == *id && p.s == *from)
                .cloned()
            else {
                continue;
            };
            if presets
                .iter()
                .any(|p| p.c == class && p.i == *id && p.s == *to)
                || !decode(&base.x).contains(f0)
            {
                continue;
            }
            presets.push(Template {
                x: encode(&decode(&base.x).replace(f0, f1).replace(
                    &format!("presetSubtype=\"{from}\""),
                    &format!("presetSubtype=\"{to}\""),
                )),
                s: *to,
                d: true,
                ..base
            });
        }
    }
    presets.sort_by_key(|p| (class_rank(&p.c), p.i, p.d));
    // The default (first recorded) subtype must stay first among a
    // preset's recorded ones: keep recording order for it.
    Table { presets }
}

fn class_rank(c: &str) -> u8 {
    match c {
        "entr" => 0,
        "emph" => 1,
        "exit" => 2,
        "path" => 3,
        _ => 4,
    }
}

fn to_json(t: &Table) -> String {
    // One preset per line: small, and a diff names the preset.
    let mut s = String::from("{\"presets\":[\n");
    for (i, p) in t.presets.iter().enumerate() {
        s.push_str(&serde_json::to_string(p).unwrap());
        if i + 1 < t.presets.len() {
            s.push(',');
        }
        s.push('\n');
    }
    s.push_str("]}\n");
    s
}

#[test]
fn templates_round_trip_through_their_storage() {
    for p in &from_fixture().presets {
        assert_eq!(encode(&decode(&p.x)), p.x);
    }
}

#[test]
fn the_table_is_what_powerpoint_wrote() {
    let t = from_fixture();
    let json = to_json(&t);
    if std::env::var_os("PAGED_SLIDE_WRITE_PRESETS").is_some() {
        let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("data/presets.json");
        std::fs::write(&p, &json).unwrap();
        return;
    }
    // As data: the committed file is formatted by the repository's JSON
    // formatter, which lays it out its own way.
    let committed: serde_json::Value = serde_json::from_str(DATA).expect("presets.json");
    let generated: serde_json::Value = serde_json::from_str(&json).expect("generated");
    assert!(
        committed == generated,
        "data/presets.json is stale: regenerate with PAGED_SLIDE_WRITE_PRESETS=1 (then bun fmt)"
    );
    let recorded = t.presets.iter().filter(|p| !p.d).count();
    let count = |c: &str| {
        let mut ids: Vec<i32> = t.presets.iter().filter(|p| p.c == c).map(|p| p.i).collect();
        ids.dedup();
        ids.len()
    };
    assert_eq!(
        (count("entr"), count("emph"), count("exit"), count("path")),
        (52, 30, 52, 64)
    );
    assert_eq!(recorded, 451);
}

#[test]
fn every_preset_has_a_name_and_a_default() {
    let g = gallery();
    assert_eq!(g.len(), 198);
    for p in &g {
        assert_ne!(p.name, "Custom", "{} {}", p.class, p.preset_id);
        assert!(template(&p.class, p.preset_id, None).is_some());
        for s in &p.subtypes {
            assert!(template(&p.class, p.preset_id, Some(s.subtype)).is_some());
        }
    }
    let fly = g
        .iter()
        .find(|p| p.class == "entr" && p.preset_id == 2)
        .unwrap();
    assert_eq!(fly.name, "Fly In");
    assert_eq!(fly.default_subtype, 4);
    assert!(fly
        .subtypes
        .iter()
        .any(|s| s.subtype == 8 && s.label == "From Left"));
    let circle = g
        .iter()
        .find(|p| p.class == "exit" && p.preset_id == 6)
        .unwrap();
    assert_eq!(
        circle
            .subtypes
            .iter()
            .map(|s| s.subtype)
            .collect::<Vec<_>>(),
        [16, 32]
    );
    let wheel = g
        .iter()
        .find(|p| p.class == "entr" && p.preset_id == 21)
        .unwrap();
    assert_eq!(wheel.subtypes.len(), 5);
}

/// Each effect slide of the fixture authored again effect by effect, as
/// the pane would (the preset, its start, a text shape's build entry):
/// PowerPoint's timing, byte for byte.
#[test]
fn authoring_the_fixture_again_writes_what_powerpoint_wrote() {
    let deck = fixture();
    let mut slides = 0;
    let mut effects = 0;
    for s in &deck.slides {
        let Some(t) = &s.timing else { continue };
        let names = names(&s.shapes);
        let f = flat::flatten(t).unwrap();
        if !f.effects.iter().all(|e| {
            e.target()
                .and_then(|x| names.get(&x.spid))
                .is_some_and(|n| n.split('|').count() == 3)
        }) {
            continue;
        }
        let mut cur: Option<Timing> = None;
        for e in &f.effects {
            let sp = e.target().unwrap();
            let c = e.ctn();
            // Only effects whose template is this very effect (the
            // dictionary wrote some subtypes twice, differently).
            let tpl = template(
                c.preset_class.as_deref().unwrap(),
                c.preset_id.unwrap(),
                c.preset_subtype,
            )
            .unwrap();
            assert_eq!(
                decode(&tpl.x),
                normalize(&e.node),
                "{} {}",
                s.part,
                names[&sp.spid]
            );
            let has_text =
                t.builds.iter().flatten().any(
                    |b| matches!(b, pptx_core::anim::Build::P { spid, .. } if *spid == sp.spid),
                );
            cur = apply(
                cur.as_ref(),
                &Edit::Add {
                    target: TargetRef {
                        spid: Some(sp.spid.clone()),
                        ..Default::default()
                    },
                    preset_class: c.preset_class.clone().unwrap(),
                    preset_id: c.preset_id.unwrap(),
                    preset_subtype: c.preset_subtype,
                    start: Some(e.start),
                    duration_ms: None,
                    delay_ms: None,
                    paragraphs: None,
                    levels: None,
                    build_level: None,
                    trigger: None,
                    at: None,
                    has_text: Some(has_text),
                },
            )
            .unwrap();
            effects += 1;
        }
        assert_eq!(cur.as_ref().unwrap().to_xml(), t.to_xml(), "{}", s.part);
        slides += 1;
    }
    // Every effect slide (the text and timing slides are authored below).
    assert_eq!(slides, 12);
    assert!(effects >= 451, "{effects}");
}

/// The text and timing slides authored again with the pane's options.
#[test]
fn text_builds_and_timing_options_author_as_powerpoint_wrote_them() {
    let deck = fixture();
    let find = |name: &str| {
        deck.slides
            .iter()
            .find(|s| names(&s.shapes).values().any(|n| n == name))
            .unwrap()
    };
    // By first level, by second level, all at once.
    let s = find("text first level");
    let mut cur: Option<Timing> = None;
    for (spid, level) in [("2", 1), ("3", 2), ("4", 0)] {
        cur = apply(
            cur.as_ref(),
            &Edit::Add {
                target: TargetRef {
                    spid: Some(spid.into()),
                    ..Default::default()
                },
                preset_class: "entr".into(),
                preset_id: 2,
                preset_subtype: None,
                start: Some(Start::Click),
                duration_ms: None,
                delay_ms: None,
                paragraphs: Some(3),
                levels: Some(vec![1, 2, 1]),
                build_level: Some(level),
                trigger: None,
                at: None,
                has_text: Some(true),
            },
        )
        .unwrap();
    }
    assert_eq!(cur.unwrap().to_xml(), s.timing.as_ref().unwrap().to_xml());

    // With previous, after previous (2 s), zoom, spin ×3 auto-reversed,
    // smooth fly, rewind when done.
    let s = find("timing with previous");
    let add = |cur: Option<&Timing>, spid: &str, id: i32, sub: Option<i32>, start: Start| {
        apply(
            cur,
            &Edit::Add {
                target: TargetRef {
                    spid: Some(spid.into()),
                    ..Default::default()
                },
                preset_class: if id == 8 { "emph" } else { "entr" }.into(),
                preset_id: id,
                preset_subtype: sub,
                start: Some(start),
                duration_ms: None,
                delay_ms: None,
                paragraphs: None,
                levels: None,
                build_level: None,
                trigger: None,
                at: None,
                has_text: Some(true),
            },
        )
        .unwrap()
    };
    let timing = |index: usize| Edit::Timing {
        index,
        start: None,
        duration_ms: None,
        delay_ms: None,
        repeat: None,
        rewind: None,
        rewind_when_done: None,
        smooth_start: None,
        smooth_end: None,
        trigger: None,
    };
    let mut t = add(None, "2", 10, None, Start::With);
    t = add(t.as_ref(), "3", 10, None, Start::After);
    let Edit::Timing { .. } = timing(0) else {
        unreachable!()
    };
    t = apply(t.as_ref(), &{
        let mut e = timing(1);
        if let Edit::Timing { duration_ms, .. } = &mut e {
            *duration_ms = Some(2000.0);
        }
        e
    })
    .unwrap();
    t = add(t.as_ref(), "4", 23, Some(16), Start::Click);
    t = add(t.as_ref(), "5", 8, None, Start::Click);
    t = apply(t.as_ref(), &{
        let mut e = timing(3);
        if let Edit::Timing {
            duration_ms,
            repeat,
            rewind,
            ..
        } = &mut e
        {
            *duration_ms = Some(2000.0);
            *repeat = Some(Some(serde_json::json!(3)));
            *rewind = Some(true);
        }
        e
    })
    .unwrap();
    t = add(t.as_ref(), "6", 2, None, Start::Click);
    t = apply(t.as_ref(), &{
        let mut e = timing(4);
        if let Edit::Timing {
            smooth_start,
            smooth_end,
            ..
        } = &mut e
        {
            *smooth_start = Some(true);
            *smooth_end = Some(true);
        }
        e
    })
    .unwrap();
    t = add(t.as_ref(), "7", 10, None, Start::Click);
    t = apply(t.as_ref(), &{
        let mut e = timing(5);
        if let Edit::Timing {
            rewind_when_done, ..
        } = &mut e
        {
            *rewind_when_done = Some(true);
        }
        e
    })
    .unwrap();
    assert_eq!(t.unwrap().to_xml(), s.timing.as_ref().unwrap().to_xml());
}

#[test]
fn every_fixture_timing_lists_with_names_and_starts() {
    let deck = fixture();
    let mut total = 0;
    for s in &deck.slides {
        let (list, clicks) = flat::list(s.timing.as_ref());
        if list.is_empty() {
            continue;
        }
        assert!(
            list.iter().all(|e| e.editable && e.name != "Custom"),
            "{}",
            s.part
        );
        assert!(clicks > 0);
        total += list.len();
    }
    assert!(total > 451);
}

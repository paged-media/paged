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

//! Editing a slide's animations (the Animations pane, the typed commands):
//! each edit reads the timing as a list ([`flat`]), changes the list and
//! writes the timing back in PowerPoint's structure. New effects come from
//! the preset table ([`presets`]), as PowerPoint writes them.

use pptx_core::anim::*;
use serde::{Deserialize, Deserializer};

use crate::flat::{self, effect_times, Flat, FlatEffect, Start};
use crate::presets;

/// A shape as an edit names it.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct TargetRef {
    #[serde(default)]
    pub spid: Option<String>,
    #[serde(default)]
    pub item: Option<String>,
    #[serde(default)]
    pub key: Option<String>,
}

impl TargetRef {
    pub fn sp(&self) -> SpTarget {
        SpTarget {
            spid: self.spid.clone().unwrap_or_else(|| "0".into()),
            sub: None,
            item: self.item.clone(),
            key: self.key.clone(),
        }
    }
}

/// `Some(None)` for an explicit `null`, `None` when absent.
fn nullable<'de, D, T>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Ok(Some(Option::deserialize(d)?))
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Edit {
    #[serde(rename_all = "camelCase")]
    Add {
        target: TargetRef,
        preset_class: String,
        preset_id: i32,
        #[serde(default)]
        preset_subtype: Option<i32>,
        #[serde(default)]
        start: Option<Start>,
        #[serde(default)]
        duration_ms: Option<f64>,
        #[serde(default)]
        delay_ms: Option<f64>,
        /// Build by paragraph over this many paragraphs (the shape's
        /// background first, then each paragraph).
        #[serde(default)]
        paragraphs: Option<u32>,
        /// Each paragraph's list level (1 = first level, which takes its
        /// own click; deeper levels go with their parent).
        #[serde(default)]
        levels: Option<Vec<u32>>,
        /// Build by paragraph down to this list level (1, the default:
        /// each first-level paragraph takes a click; 0: all at once).
        #[serde(default)]
        build_level: Option<u32>,
        #[serde(default)]
        trigger: Option<TargetRef>,
        #[serde(default)]
        at: Option<usize>,
        /// The shape has text: it gets a build entry (`p:bldP`), as
        /// PowerPoint writes one for an animated text shape.
        #[serde(default)]
        has_text: Option<bool>,
    },
    Remove {
        index: usize,
    },
    Move {
        from: usize,
        to: usize,
    },
    #[serde(rename_all = "camelCase")]
    Timing {
        index: usize,
        #[serde(default)]
        start: Option<Start>,
        #[serde(default)]
        duration_ms: Option<f64>,
        #[serde(default)]
        delay_ms: Option<f64>,
        #[serde(default, deserialize_with = "nullable")]
        repeat: Option<Option<serde_json::Value>>,
        #[serde(default)]
        rewind: Option<bool>,
        /// "Rewind when done playing" (`fill="remove"`).
        #[serde(default)]
        rewind_when_done: Option<bool>,
        /// Smooth start / end (half the duration accelerating /
        /// decelerating).
        #[serde(default)]
        smooth_start: Option<bool>,
        #[serde(default)]
        smooth_end: Option<bool>,
        #[serde(default, deserialize_with = "nullable")]
        trigger: Option<Option<TargetRef>>,
    },
    #[serde(rename_all = "camelCase")]
    Option {
        index: usize,
        preset_subtype: i32,
    },
    #[serde(rename_all = "camelCase")]
    Change {
        index: usize,
        preset_class: String,
        preset_id: i32,
        #[serde(default)]
        preset_subtype: Option<i32>,
    },
    Paint {
        from: TargetRef,
        to: TargetRef,
    },
}

/// Do two targets name the same shape?
pub fn same_shape(a: &SpTarget, b: &SpTarget) -> bool {
    if let (Some(x), Some(y)) = (&a.item, &b.item) {
        return x == y;
    }
    if let (Some(x), Some(y)) = (&a.key, &b.key) {
        return x == y;
    }
    a.spid == b.spid && a.spid != "0"
}

/// Point every shape target in `node` that `pick` accepts at `to` (keeping
/// the part of the shape it names).
pub fn retarget(node: &mut TimeNode, pick: &dyn Fn(&SpTarget) -> bool, to: &SpTarget) {
    let swap = |sp: &mut SpTarget| {
        if pick(sp) {
            let sub = sp.sub.clone().or_else(|| to.sub.clone());
            *sp = SpTarget { sub, ..to.clone() };
        }
    };
    node.walk_mut(&mut |n| {
        let ctn = if let Some(b) = n.bhvr_mut() {
            if let TargetEl::Sp(sp) = &mut b.target {
                swap(sp);
            }
            &mut b.ctn
        } else if let Some(c) = n.container_ctn_mut() {
            c
        } else {
            return;
        };
        for list in [&mut ctn.st_conds, &mut ctn.end_conds]
            .into_iter()
            .flatten()
        {
            for c in list {
                if let Some(CondTarget::El {
                    el: TargetEl::Sp(sp),
                }) = &mut c.target
                {
                    swap(sp);
                }
            }
        }
    });
}

/// Scale every duration and delay under the effect (not the effect's own
/// delay) by `f`.
fn scale(node: &mut TimeNode, f: f64) {
    if !(f.is_finite() && f > 0.0) || (f - 1.0).abs() < 1e-12 {
        return;
    }
    let sc = |s: &mut Option<String>| {
        if let Some(v) = s.as_deref().and_then(|v| v.trim().parse::<f64>().ok()) {
            *s = Some(fmt(v * f));
        }
    };
    let Some(c) = node.container_ctn_mut() else {
        return;
    };
    for ch in c.children.iter_mut() {
        ch.walk_mut(&mut |n| {
            let ctn = match n.bhvr_mut() {
                Some(b) => &mut b.ctn,
                None => match n.container_ctn_mut() {
                    Some(c) => c,
                    None => return,
                },
            };
            // An instant (`dur="1"`, a set) stays instant.
            if ctn
                .dur
                .as_deref()
                .and_then(|d| d.trim().parse::<f64>().ok())
                .is_some_and(|d| d > 1.0)
            {
                sc(&mut ctn.dur);
            }
            for list in [&mut ctn.st_conds, &mut ctn.end_conds]
                .into_iter()
                .flatten()
            {
                for x in list {
                    if x.evt.is_none() {
                        sc(&mut x.delay);
                    }
                }
            }
        });
    }
}

fn fmt(v: f64) -> String {
    let r = v.round();
    if (v - r).abs() < 1e-6 {
        format!("{}", r as i64)
    } else {
        format!("{:.3}", v)
            .trim_end_matches('0')
            .trim_end_matches('.')
            .to_string()
    }
}

fn set_delay(node: &mut TimeNode, ms: f64) {
    if let Some(c) = node.ctn_mut() {
        c.st_conds = Some(vec![Condition {
            delay: Some(fmt(ms.max(0.0))),
            ..Default::default()
        }]);
    }
}

fn set_duration(node: &mut TimeNode, ms: f64) {
    let e = FlatEffect {
        node: node.clone(),
        start: Start::Click,
        trigger: None,
    };
    let (simple, _) = effect_times(&e);
    if simple > 0.0 {
        scale(node, ms / simple);
    }
}

/// A new effect node from the preset table.
fn effect_from_preset(
    class: &str,
    id: i32,
    subtype: Option<i32>,
    target: &SpTarget,
) -> Result<TimeNode, String> {
    let t = presets::template(class, id, subtype)
        .ok_or_else(|| format!("no preset {class} {id} {subtype:?}"))?;
    let mut n = presets::instantiate(t, target).ok_or("the preset does not read")?;
    retarget(
        &mut n,
        &|sp| sp.spid == target.spid && sp.item == target.item,
        target,
    );
    Ok(n)
}

fn grp_id_for(f: &Flat, target: &SpTarget) -> u32 {
    f.effects
        .iter()
        .filter(|e| e.target().is_some_and(|t| same_shape(&t, target)))
        .filter_map(|e| e.ctn().grp_id)
        .max()
        .map(|g| g + 1)
        .unwrap_or(0)
}

/// Apply `edit` to `timing`: the timing afterwards (`None` when nothing is
/// left).
pub fn apply(timing: Option<&Timing>, edit: &Edit) -> Result<Option<Timing>, String> {
    let mut f = match timing {
        None => Flat::default(),
        Some(t) => flat::flatten(t).ok_or("this slide's animations are not in PowerPoint's structure; they can be played but not edited")?,
    };
    let n = f.effects.len();
    let check = |i: usize| {
        if i < n {
            Ok(())
        } else {
            Err(format!("no effect {i} (the slide has {n})"))
        }
    };
    match edit {
        Edit::Add {
            target,
            preset_class,
            preset_id,
            preset_subtype,
            start,
            duration_ms,
            delay_ms,
            paragraphs,
            levels,
            build_level,
            trigger,
            at,
            has_text,
        } => {
            let build_level = build_level.unwrap_or(1);
            let sp = target.sp();
            let grp = grp_id_for(&f, &sp);
            let start = start.unwrap_or(Start::Click);
            let trigger = trigger.as_ref().map(TargetRef::sp);
            let make = |sub: Option<SpSub>, st: Start| -> Result<FlatEffect, String> {
                let tgt = SpTarget { sub, ..sp.clone() };
                let mut node = effect_from_preset(preset_class, *preset_id, *preset_subtype, &tgt)?;
                if let Some(c) = node.ctn_mut() {
                    if c.grp_id.is_some() {
                        c.grp_id = Some(grp);
                    }
                }
                if let Some(d) = duration_ms {
                    set_duration(&mut node, *d);
                }
                if let Some(d) = delay_ms {
                    set_delay(&mut node, *d);
                }
                Ok(FlatEffect {
                    node,
                    start: st,
                    trigger: trigger.clone(),
                })
            };
            let mut new = Vec::new();
            match paragraphs {
                Some(p) if *p > 0 => {
                    new.push(make(Some(SpSub::Bg), start)?);
                    for i in 0..*p {
                        let lvl = levels
                            .as_ref()
                            .and_then(|l| l.get(i as usize))
                            .copied()
                            .unwrap_or(1);
                        let st = if build_level == 0 || lvl > build_level {
                            Start::With
                        } else {
                            Start::Click
                        };
                        new.push(make(Some(SpSub::Paragraphs { st: i, end: i }), st)?);
                    }
                }
                _ => new.push(make(None, start)?),
            }
            let pos = at.unwrap_or(n).min(n);
            f.effects.splice(pos..pos, new);
            // A text shape gets the build entry PowerPoint writes for the
            // preset (none for some: a spin turns the shape, text and all).
            let tpl_build =
                presets::template(preset_class, *preset_id, *preset_subtype).and_then(|t| t.b);
            let by_paragraph = matches!(paragraphs, Some(p) if *p > 0);
            let want_build = by_paragraph || (*has_text == Some(true) && tpl_build.is_some());
            if want_build {
                let builds = f.builds.get_or_insert_with(Vec::new);
                let exists = builds.iter().any(|b| match b {
                    Build::P {
                        spid,
                        item,
                        key,
                        grp_id,
                        ..
                    } => {
                        *grp_id == Some(grp)
                            && same_shape(
                                &SpTarget {
                                    spid: spid.clone(),
                                    item: item.clone(),
                                    key: key.clone(),
                                    sub: None,
                                },
                                &sp,
                            )
                    }
                    _ => false,
                });
                if !exists {
                    let by_p = matches!(paragraphs, Some(p) if *p > 0);
                    builds.push(Build::P {
                        spid: sp.spid.clone(),
                        grp_id: Some(grp),
                        ui_expand: None,
                        build: by_p
                            .then(|| if build_level == 0 { "allAtOnce" } else { "p" }.to_string()),
                        bld_lvl: (by_p && build_level >= 2).then_some(build_level),
                        anim_bg: (by_paragraph || tpl_build == Some(true)).then_some(true),
                        auto_update_anim_bg: None,
                        rev: None,
                        adv_auto: None,
                        extra: Vec::new(),
                        children: Vec::new(),
                        item: sp.item.clone(),
                        key: sp.key.clone(),
                    });
                }
            }
        }
        Edit::Remove { index } => {
            check(*index)?;
            f.effects.remove(*index);
        }
        Edit::Move { from, to } => {
            check(*from)?;
            let e = f.effects.remove(*from);
            let to = (*to).min(f.effects.len());
            f.effects.insert(to, e);
        }
        Edit::Timing {
            index,
            start,
            duration_ms,
            delay_ms,
            repeat,
            rewind,
            rewind_when_done,
            smooth_start,
            smooth_end,
            trigger,
        } => {
            check(*index)?;
            let e = &mut f.effects[*index];
            if let Some(s) = start {
                e.start = *s;
            }
            if let Some(d) = duration_ms {
                set_duration(&mut e.node, *d);
            }
            if let Some(d) = delay_ms {
                set_delay(&mut e.node, *d);
            }
            if let Some(r) = repeat {
                let c = e.ctn_mut();
                c.repeat_count = match r {
                    None | Some(serde_json::Value::Null) => None,
                    Some(serde_json::Value::String(s)) if s == "indefinite" => {
                        Some("indefinite".into())
                    }
                    Some(v) => v
                        .as_f64()
                        .filter(|x| *x > 0.0 && (*x - 1.0).abs() > 1e-9)
                        .map(|x| fmt(x * 1000.0)),
                };
            }
            if let Some(r) = rewind {
                e.ctn_mut().auto_rev = r.then_some(true);
            }
            if let Some(r) = rewind_when_done {
                e.ctn_mut().fill = Some(if *r { "remove" } else { "hold" }.into());
            }
            if let Some(v) = smooth_start {
                e.ctn_mut().accel = v.then_some(50_000);
            }
            if let Some(v) = smooth_end {
                e.ctn_mut().decel = v.then_some(50_000);
            }
            if let Some(t) = trigger {
                e.trigger = t.as_ref().map(TargetRef::sp);
            }
        }
        Edit::Option {
            index,
            preset_subtype,
        } => {
            check(*index)?;
            let c = f.effects[*index].ctn().clone();
            let (Some(class), Some(id)) = (c.preset_class.clone(), c.preset_id) else {
                return Err("the effect is not a preset".into());
            };
            replace_preset(&mut f.effects[*index], &class, id, Some(*preset_subtype))?;
        }
        Edit::Change {
            index,
            preset_class,
            preset_id,
            preset_subtype,
        } => {
            check(*index)?;
            replace_preset(
                &mut f.effects[*index],
                preset_class,
                *preset_id,
                *preset_subtype,
            )?;
        }
        Edit::Paint { from, to } => {
            let (src, dst) = (from.sp(), to.sp());
            let copies: Vec<FlatEffect> = f
                .effects
                .iter()
                .filter(|e| e.target().is_some_and(|t| same_shape(&t, &src)))
                .cloned()
                .map(|mut e| {
                    let s = src.clone();
                    retarget(&mut e.node, &|sp| same_shape(sp, &s), &dst);
                    e
                })
                .collect();
            if copies.is_empty() {
                return Err("the shape has no animation to copy".into());
            }
            f.effects
                .retain(|e| !e.target().is_some_and(|t| same_shape(&t, &dst)));
            f.effects.extend(copies);
            // The build entries go with the effects.
            if let Some(builds) = &mut f.builds {
                let src_builds: Vec<Build> = builds
                    .iter()
                    .filter(|b| matches!(b, Build::P { spid, item, key, .. } if same_shape(&SpTarget { spid: spid.clone(), item: item.clone(), key: key.clone(), sub: None }, &src)))
                    .cloned()
                    .collect();
                builds.retain(|b| !matches!(b, Build::P { spid, item, key, .. } if same_shape(&SpTarget { spid: spid.clone(), item: item.clone(), key: key.clone(), sub: None }, &dst)));
                for mut b in src_builds {
                    if let Build::P {
                        spid, item, key, ..
                    } = &mut b
                    {
                        *spid = dst.spid.clone();
                        *item = dst.item.clone();
                        *key = dst.key.clone();
                    }
                    builds.push(b);
                }
            }
        }
    }
    prune_builds(&mut f);
    // A first effect that starts with or after "the previous" one starts
    // the slide's animations by itself; one that is now first stays as set.
    Ok(flat::rebuild(&f))
}

/// Drop build entries of shapes no effect animates any more.
fn prune_builds(f: &mut Flat) {
    let targets: Vec<SpTarget> = f.effects.iter().filter_map(FlatEffect::target).collect();
    if let Some(builds) = &mut f.builds {
        builds.retain(|b| match b {
            Build::P {
                spid, item, key, ..
            } => {
                let t = SpTarget {
                    spid: spid.clone(),
                    item: item.clone(),
                    key: key.clone(),
                    sub: None,
                };
                targets.iter().any(|x| same_shape(x, &t))
            }
            Build::Raw { spid: Some(s), .. } => targets.iter().any(|x| x.spid == *s),
            Build::Raw { .. } => true,
        });
        if builds.is_empty() && f.effects.is_empty() {
            f.builds = None;
        }
    }
}

/// Swap an effect's behaviours for another preset's, keeping its target,
/// start, delay, duration, repeat, rewind and trigger.
fn replace_preset(
    e: &mut FlatEffect,
    class: &str,
    id: i32,
    subtype: Option<i32>,
) -> Result<(), String> {
    let target = e.target().ok_or("the effect animates no shape")?;
    let old = e.ctn().clone();
    let (old_simple, _) = effect_times(e);
    let mut node = effect_from_preset(class, id, subtype, &target)?;
    if let Some(c) = node.ctn_mut() {
        if c.grp_id.is_some() || old.grp_id.is_some() {
            c.grp_id = old.grp_id;
        }
        c.st_conds = old.st_conds.clone();
        c.repeat_count = old.repeat_count.clone();
        c.auto_rev = old.auto_rev;
    }
    // A preset of the same kind keeps the duration it was given.
    if old.preset_class.as_deref() == Some(class) && old.preset_id == Some(id) && old_simple > 0.0 {
        set_duration(&mut node, old_simple);
    }
    e.node = node;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sp(spid: &str) -> TargetRef {
        TargetRef {
            spid: Some(spid.into()),
            ..Default::default()
        }
    }

    fn add(t: Option<&Timing>, spid: &str, class: &str, id: i32, start: Start) -> Timing {
        apply(
            t,
            &Edit::Add {
                target: sp(spid),
                preset_class: class.into(),
                preset_id: id,
                preset_subtype: None,
                start: Some(start),
                duration_ms: None,
                delay_ms: None,
                paragraphs: None,
                levels: None,
                build_level: None,
                trigger: None,
                at: None,
                has_text: None,
            },
        )
        .unwrap()
        .unwrap()
    }

    #[test]
    fn add_remove_move_retime_paint() {
        let a = add(None, "2", "entr", 10, Start::Click);
        let b = add(Some(&a), "3", "entr", 2, Start::After);
        // Add then remove: the timing before.
        let back = apply(Some(&b), &Edit::Remove { index: 1 })
            .unwrap()
            .unwrap();
        assert_eq!(back, a);
        assert_eq!(apply(Some(&a), &Edit::Remove { index: 0 }).unwrap(), None);
        // Move twice: back where it was.
        let c = add(Some(&b), "4", "emph", 8, Start::Click);
        let m = apply(Some(&c), &Edit::Move { from: 2, to: 0 })
            .unwrap()
            .unwrap();
        let (l, _) = flat::list(Some(&m));
        assert_eq!(l[0].preset_class.as_deref(), Some("emph"));
        let m2 = apply(Some(&m), &Edit::Move { from: 0, to: 2 })
            .unwrap()
            .unwrap();
        assert_eq!(m2, c);
        // Retime: 2 s, 300 ms delay, with previous, repeat 2 and rewind.
        let r = apply(
            Some(&c),
            &Edit::Timing {
                index: 1,
                start: Some(Start::With),
                duration_ms: Some(2000.0),
                delay_ms: Some(300.0),
                repeat: Some(Some(serde_json::json!(2))),
                rewind: Some(true),
                rewind_when_done: None,
                smooth_start: None,
                smooth_end: None,
                trigger: None,
            },
        )
        .unwrap()
        .unwrap();
        let (l, clicks) = flat::list(Some(&r));
        assert_eq!(clicks, 2);
        assert_eq!(l[1].start, Start::With);
        assert!(
            (l[1].duration_ms - 2000.0).abs() < 1e-6,
            "{}",
            l[1].duration_ms
        );
        assert_eq!(l[1].delay_ms, 300.0);
        assert_eq!(l[1].repeat, Some(serde_json::json!(2.0)));
        assert!(l[1].rewind);
        // Paint the fly-in of shape 3 onto shape 4 (its spin goes).
        let p = apply(
            Some(&c),
            &Edit::Paint {
                from: sp("3"),
                to: sp("4"),
            },
        )
        .unwrap()
        .unwrap();
        let (l, _) = flat::list(Some(&p));
        let on4: Vec<_> = l
            .iter()
            .filter(|e| e.target.as_ref().unwrap().spid == "4")
            .collect();
        assert_eq!(on4.len(), 1);
        assert_eq!(on4[0].preset_id, Some(2));
        // A trigger: an interactive sequence on shape 2.
        let t = apply(
            Some(&c),
            &Edit::Timing {
                index: 2,
                start: None,
                duration_ms: None,
                delay_ms: None,
                repeat: None,
                rewind: None,
                rewind_when_done: None,
                smooth_start: None,
                smooth_end: None,
                trigger: Some(Some(sp("2"))),
            },
        )
        .unwrap()
        .unwrap();
        let (l, clicks) = flat::list(Some(&t));
        assert_eq!(clicks, 1);
        assert_eq!(l[2].trigger.as_ref().unwrap().spid, "2");
        assert!(t.to_xml().contains("interactiveSeq"));
        // Change the direction of the fly-in, then the effect.
        let o = apply(
            Some(&c),
            &Edit::Option {
                index: 1,
                preset_subtype: 8,
            },
        )
        .unwrap()
        .unwrap();
        let (l, _) = flat::list(Some(&o));
        assert_eq!(l[1].preset_subtype, Some(8));
        let ch = apply(
            Some(&c),
            &Edit::Change {
                index: 1,
                preset_class: "entr".into(),
                preset_id: 22,
                preset_subtype: None,
            },
        )
        .unwrap()
        .unwrap();
        let (l, _) = flat::list(Some(&ch));
        assert_eq!(l[1].name, "Wipe");
        assert_eq!(l[1].start, Start::After);
    }

    #[test]
    fn builds_by_paragraph_as_powerpoint_does() {
        let t = apply(
            None,
            &Edit::Add {
                target: sp("2"),
                preset_class: "entr".into(),
                preset_id: 2,
                preset_subtype: None,
                start: Some(Start::Click),
                duration_ms: None,
                delay_ms: None,
                paragraphs: Some(3),
                levels: Some(vec![1, 2, 1]),
                build_level: None,
                trigger: None,
                at: None,
                has_text: Some(true),
            },
        )
        .unwrap()
        .unwrap();
        let (l, clicks) = flat::list(Some(&t));
        assert_eq!(l.len(), 4);
        assert!(l[0].bg);
        assert_eq!(
            l.iter().map(|e| e.paragraph).collect::<Vec<_>>(),
            [None, Some(0), Some(1), Some(2)]
        );
        assert_eq!(
            l.iter().map(|e| e.start).collect::<Vec<_>>(),
            [Start::Click, Start::Click, Start::With, Start::Click]
        );
        assert_eq!(clicks, 3);
        assert!(t
            .to_xml()
            .contains(r#"<p:bldP spid="2" grpId="0" build="p" animBg="1"/>"#));
    }
}

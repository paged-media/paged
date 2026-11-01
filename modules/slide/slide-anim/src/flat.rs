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

//! A slide's effects as a list (PowerPoint's Animation Pane), and the timing
//! tree rebuilt from such a list in PowerPoint's own structure:
//!
//! ```text
//! par tmRoot
//!   seq mainSeq (onPrev / onNext)
//!     par  click group   (delay indefinite; the first, when it starts by
//!                          itself: also onBegin of the main sequence)
//!       par  sub-group   (delay: where the previous sub-group ends)
//!         par  effect    (presetID/Class/Subtype, nodeType click/with/
//!                          afterEffect, its own delay)
//!           behaviours
//!   seq interactiveSeq   (one per trigger shape: onClick on it)
//!     par  group …
//! ```
//!
//! A timing in that structure is *canonical*: [`flatten`] reads it into a
//! [`Flat`] list and [`rebuild`] writes it back as it was (the fixture
//! decks hold that), so an edit to one effect leaves the others as they
//! were.

use pptx_core::anim::*;
use serde::Serialize;

use crate::{presets, schedule, target_id, Ctx};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Start {
    Click,
    With,
    After,
}

impl Start {
    pub fn node_type(self) -> &'static str {
        match self {
            Start::Click => "clickEffect",
            Start::With => "withEffect",
            Start::After => "afterEffect",
        }
    }
}

/// One effect.
#[derive(Debug, Clone, PartialEq)]
pub struct FlatEffect {
    /// The effect's `p:par`, behaviours and all.
    pub node: TimeNode,
    pub start: Start,
    /// The trigger shape (an interactive sequence), `None` for the main
    /// sequence.
    pub trigger: Option<SpTarget>,
}

impl FlatEffect {
    pub fn ctn(&self) -> &CommonTimeNode {
        self.node.ctn().expect("an effect is a par")
    }
    pub fn ctn_mut(&mut self) -> &mut CommonTimeNode {
        self.node.ctn_mut().expect("an effect is a par")
    }
    /// The shape it animates (its first behaviour's target).
    pub fn target(&self) -> Option<SpTarget> {
        let mut out = None;
        self.node.walk(&mut |n| {
            if out.is_none() {
                if let Some(TargetEl::Sp(sp)) = n.bhvr().map(|b| &b.target) {
                    out = Some(sp.clone());
                }
            }
        });
        out
    }
}

/// A canonical timing as a list.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Flat {
    pub effects: Vec<FlatEffect>,
    pub builds: Option<Vec<Build>>,
    pub extra: Vec<String>,
}

fn sld_cond(evt: &str) -> Condition {
    Condition {
        evt: Some(evt.into()),
        delay: Some("0".into()),
        target: Some(CondTarget::El { el: TargetEl::Sld }),
        extra: Vec::new(),
    }
}

fn delay_cond(d: &str) -> Condition {
    Condition {
        delay: Some(d.into()),
        ..Default::default()
    }
}

fn sp_cond(evt: &str, sp: &SpTarget) -> Condition {
    Condition {
        evt: Some(evt.into()),
        delay: Some("0".into()),
        target: Some(CondTarget::El {
            el: TargetEl::Sp(SpTarget {
                sub: None,
                ..sp.clone()
            }),
        }),
        extra: Vec::new(),
    }
}

/// Is this an effect's `par` (a preset or an effect node type)?
fn is_effect(n: &TimeNode) -> bool {
    let TimeNode::Par { ctn } = n else {
        return false;
    };
    ctn.preset_class.is_some()
        || matches!(
            ctn.node_type.as_deref(),
            Some("clickEffect" | "withEffect" | "afterEffect")
        )
}

fn start_of(ctn: &CommonTimeNode, first_in_group: bool, first_in_sub: bool) -> Start {
    match ctn.node_type.as_deref() {
        Some("clickEffect") => Start::Click,
        Some("withEffect") => Start::With,
        Some("afterEffect") => Start::After,
        _ if first_in_group => Start::Click,
        _ if first_in_sub => Start::After,
        _ => Start::With,
    }
}

/// Read a timing in PowerPoint's structure into a list; `None` when it is
/// not in that structure (it is then shown but not edited).
pub fn flatten(t: &Timing) -> Option<Flat> {
    let [TimeNode::Par { ctn: root }] = t.nodes.as_slice() else {
        return None;
    };
    if root.node_type.as_deref() != Some("tmRoot") || !root.sub.is_empty() {
        return None;
    }
    let mut effects = Vec::new();
    for (si, seq) in root.children.iter().enumerate() {
        let TimeNode::Seq { ctn, .. } = seq else {
            return None;
        };
        let trigger = match ctn.node_type.as_deref() {
            Some("mainSeq") if si == 0 => None,
            Some("interactiveSeq") => {
                let c = ctn.st_conds.as_ref()?.first()?;
                match &c.target {
                    Some(CondTarget::El {
                        el: TargetEl::Sp(sp),
                    }) => Some(sp.clone()),
                    _ => return None,
                }
            }
            _ => return None,
        };
        for group in &ctn.children {
            let TimeNode::Par { ctn: g } = group else {
                return None;
            };
            for (k, sub) in g.children.iter().enumerate() {
                let TimeNode::Par { ctn: s } = sub else {
                    return None;
                };
                for (j, e) in s.children.iter().enumerate() {
                    if !is_effect(e) {
                        return None;
                    }
                    let start = start_of(e.ctn()?, k == 0 && j == 0, j == 0);
                    effects.push(FlatEffect {
                        node: e.clone(),
                        start,
                        trigger: trigger.clone(),
                    });
                }
            }
        }
    }
    let flat = Flat {
        effects,
        builds: t.builds.clone(),
        extra: t.extra.clone(),
    };
    // Canonical only if writing it back gives the timing (its node ids
    // numbered as PowerPoint numbers them).
    let mut numbered = t.clone();
    renumber(&mut numbered);
    (rebuild(&flat).as_ref() == Some(&numbered)).then_some(flat)
}

/// An effect's own durations: (simple, active), ms.
pub fn effect_times(e: &FlatEffect) -> (f64, f64) {
    let n = schedule::compile_node(&e.node, &Ctx::default());
    (finite(n.simple), finite(n.active))
}

fn finite(v: f64) -> f64 {
    if v.is_finite() {
        v
    } else {
        0.0
    }
}

fn fmt_ms(v: f64) -> String {
    let r = v.round();
    if (v - r).abs() < 1e-6 {
        format!("{}", r as i64)
    } else {
        format!("{v}")
    }
}

/// Write a list back as a timing; `None` when the list is empty and there
/// is nothing else to keep.
pub fn rebuild(f: &Flat) -> Option<Timing> {
    if f.effects.is_empty() && f.extra.is_empty() {
        return None;
    }
    let mut seqs: Vec<TimeNode> = Vec::new();
    // The main sequence, then one per trigger in the order they appear.
    let main: Vec<&FlatEffect> = f.effects.iter().filter(|e| e.trigger.is_none()).collect();
    let mut triggers: Vec<(String, SpTarget, Vec<&FlatEffect>)> = Vec::new();
    for e in f.effects.iter() {
        if let Some(t) = &e.trigger {
            let id = target_id(t);
            match triggers.iter_mut().find(|(k, _, _)| *k == id) {
                Some((_, _, list)) => list.push(e),
                None => triggers.push((id, t.clone(), vec![e])),
            }
        }
    }
    seqs.push(TimeNode::Seq {
        ctn: CommonTimeNode {
            dur: Some("indefinite".into()),
            node_type: Some("mainSeq".into()),
            children: groups(&main, true),
            has_children: true,
            ..Default::default()
        },
        concurrent: Some(true),
        prev_ac: None,
        next_ac: Some("seek".into()),
        prev_conds: Some(vec![sld_cond("onPrev")]),
        next_conds: Some(vec![sld_cond("onNext")]),
    });
    for (_, t, list) in &triggers {
        seqs.push(TimeNode::Seq {
            ctn: CommonTimeNode {
                restart: Some("whenNotActive".into()),
                fill: Some("hold".into()),
                evt_filter: Some("cancelBubble".into()),
                node_type: Some("interactiveSeq".into()),
                st_conds: Some(vec![sp_cond("onClick", t)]),
                end_sync: Some(Condition {
                    evt: Some("end".into()),
                    delay: Some("0".into()),
                    target: Some(CondTarget::Rtn { val: "all".into() }),
                    extra: Vec::new(),
                }),
                children: groups(list, false),
                has_children: true,
                ..Default::default()
            },
            concurrent: Some(true),
            prev_ac: None,
            next_ac: Some("seek".into()),
            prev_conds: None,
            next_conds: Some(vec![sp_cond("onClick", t)]),
        });
    }
    let mut t = Timing {
        nodes: vec![TimeNode::Par {
            ctn: CommonTimeNode {
                dur: Some("indefinite".into()),
                restart: Some("never".into()),
                node_type: Some("tmRoot".into()),
                children: seqs,
                has_children: true,
                ..Default::default()
            },
        }],
        builds: f.builds.clone(),
        extra: f.extra.clone(),
    };
    renumber(&mut t);
    Some(t)
}

/// Click groups and their sub-groups. The main sequence's first group, when
/// it starts by itself, also starts on the main sequence's start (its id
/// is filled in by [`renumber`]: `u32::MAX` stands for it).
fn groups(list: &[&FlatEffect], main: bool) -> Vec<TimeNode> {
    let mut out: Vec<TimeNode> = Vec::new();
    // (sub-groups: (delay, effects)) of the group being built.
    let mut cur: Vec<(f64, Vec<TimeNode>, f64)> = Vec::new();
    let mut first_auto = false;
    let flush =
        |out: &mut Vec<TimeNode>, cur: &mut Vec<(f64, Vec<TimeNode>, f64)>, first_auto: bool| {
            if cur.is_empty() {
                return;
            }
            let index = out.len();
            let mut conds = vec![delay_cond(if !main && index == 0 {
                "0"
            } else {
                "indefinite"
            })];
            if main && index == 0 && first_auto {
                conds.push(Condition {
                    evt: Some("onBegin".into()),
                    delay: Some("0".into()),
                    target: Some(CondTarget::Tn {
                        val: Some(u32::MAX),
                        tn_type: None,
                    }),
                    extra: Vec::new(),
                });
            }
            let subs = cur
                .drain(..)
                .map(|(d, effects, _)| TimeNode::Par {
                    ctn: CommonTimeNode {
                        fill: Some("hold".into()),
                        st_conds: Some(vec![delay_cond(&fmt_ms(d))]),
                        children: effects,
                        has_children: true,
                        ..Default::default()
                    },
                })
                .collect();
            out.push(TimeNode::Par {
                ctn: CommonTimeNode {
                    fill: Some("hold".into()),
                    st_conds: Some(conds),
                    children: subs,
                    has_children: true,
                    ..Default::default()
                },
            });
        };
    for (i, e) in list.iter().enumerate() {
        let mut node = e.node.clone();
        if let Some(c) = node.ctn_mut() {
            c.node_type = Some(e.start.node_type().into());
        }
        let delay = e.ctn().delay_ms().unwrap_or(0.0);
        let (_, active) = effect_times(e);
        let end = delay + active;
        let new_group = i == 0 || e.start == Start::Click;
        if new_group {
            flush(&mut out, &mut cur, first_auto);
            if i == 0 {
                first_auto = e.start != Start::Click;
            }
            cur.push((0.0, vec![node], end));
            continue;
        }
        match e.start {
            Start::After => {
                let (d, _, sub_end) =
                    cur.last()
                        .map(|(d, _, s)| (*d, (), *s))
                        .unwrap_or((0.0, (), 0.0));
                cur.push((d + sub_end, vec![node], end));
            }
            _ => {
                if let Some(last) = cur.last_mut() {
                    last.1.push(node);
                    last.2 = last.2.max(end);
                }
            }
        }
    }
    flush(&mut out, &mut cur, first_auto);
    out
}

/// Number every `cTn` depth first from 1, as PowerPoint does, and point
/// the references (`p:tn`) at the new ids.
pub fn renumber(t: &mut Timing) {
    let mut map: Vec<(u32, u32)> = Vec::new();
    let mut next = 0u32;
    let mut main_id = 0u32;
    fn number(n: &mut TimeNode, next: &mut u32, map: &mut Vec<(u32, u32)>, main_id: &mut u32) {
        let is_main =
            matches!(n, TimeNode::Seq { ctn, .. } if ctn.node_type.as_deref() == Some("mainSeq"));
        let Some(c) = n.ctn_mut() else { return };
        *next += 1;
        if let Some(old) = c.id {
            map.push((old, *next));
        }
        c.id = Some(*next);
        if is_main {
            *main_id = *next;
        }
        for ch in c.children.iter_mut().chain(c.sub.iter_mut()) {
            number(ch, next, map, main_id);
        }
    }
    for n in &mut t.nodes {
        number(n, &mut next, &mut map, &mut main_id);
    }
    fn fix(c: &mut Condition, map: &[(u32, u32)], main_id: u32) {
        if let Some(CondTarget::Tn { val: Some(v), .. }) = &mut c.target {
            if *v == u32::MAX {
                *v = main_id;
            } else if let Some((_, n)) = map.iter().find(|(o, _)| o == v) {
                *v = *n;
            }
        }
    }
    t.walk_mut(&mut |n| {
        let c = match n.container_ctn_mut() {
            Some(c) => c,
            None => match n.bhvr_mut() {
                Some(b) => &mut b.ctn,
                None => return,
            },
        };
        for list in [&mut c.st_conds, &mut c.end_conds].into_iter().flatten() {
            for x in list {
                fix(x, &map, main_id);
            }
        }
        if let Some(x) = &mut c.end_sync {
            fix(x, &map, main_id);
        }
    });
}

/// A target as the pane shows it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetInfo {
    pub spid: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
}

impl From<&SpTarget> for TargetInfo {
    fn from(s: &SpTarget) -> Self {
        TargetInfo {
            spid: s.spid.clone(),
            item: s.item.clone(),
            key: s.key.clone(),
        }
    }
}

/// One effect as the pane lists it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectInfo {
    pub index: usize,
    pub target: Option<TargetInfo>,
    pub paragraph: Option<u32>,
    pub bg: bool,
    pub preset_class: Option<String>,
    pub preset_id: Option<i32>,
    pub preset_subtype: Option<i32>,
    pub name: String,
    pub start: Start,
    pub delay_ms: f64,
    pub duration_ms: f64,
    pub repeat: Option<serde_json::Value>,
    pub rewind: bool,
    /// "Rewind when done playing" (`fill="remove"`).
    pub rewind_when_done: bool,
    pub smooth_start: bool,
    pub smooth_end: bool,
    pub trigger: Option<TargetInfo>,
    pub click_group: usize,
    pub begin_ms: f64,
    pub end_ms: f64,
    pub editable: bool,
    /// Its motion path (`p:animMotion path`, slide fractions from where
    /// the shape stands), when it moves the shape.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Path lock: `pathEditMode="fixed"`.
    pub path_locked: bool,
}

/// The pane's list: `(effects, clicks)`.
pub fn list(t: Option<&Timing>) -> (Vec<EffectInfo>, usize) {
    let Some(t) = t else {
        return (Vec::new(), 0);
    };
    let (effects, editable) = match flatten(t) {
        Some(f) => (f.effects, true),
        None => (loose(t), false),
    };
    let mut out = Vec::new();
    let mut clicks = 0usize;
    let mut group = 0usize;
    // Where the current sub-group starts and ends within its click group.
    let mut sub_begin = 0.0;
    let mut sub_end = 0.0;
    let mut last_trigger: Option<String> = None;
    for (i, e) in effects.iter().enumerate() {
        let c = e.ctn();
        let trig = e.trigger.as_ref().map(target_id);
        let first_of_seq = i == 0 || trig != last_trigger;
        if trig != last_trigger {
            sub_begin = 0.0;
            sub_end = 0.0;
        }
        last_trigger = trig.clone();
        match e.start {
            Start::Click => {
                if e.trigger.is_none() {
                    clicks += 1;
                    group = clicks;
                }
                sub_begin = 0.0;
                sub_end = 0.0;
            }
            Start::After if !first_of_seq => {
                sub_begin = sub_end;
            }
            _ => {}
        }
        let delay = c.delay_ms().unwrap_or(0.0);
        let (simple, active) = effect_times(e);
        let begin = sub_begin + delay;
        let end = begin + active;
        sub_end = sub_end.max(end);
        let target = e.target();
        let mut motion: Option<(String, bool)> = None;
        e.node.walk(&mut |n| {
            if let TimeNode::AnimMotion {
                path: Some(p),
                path_edit_mode,
                ..
            } = n
            {
                if motion.is_none() {
                    motion = Some((p.clone(), path_edit_mode.as_deref() == Some("fixed")));
                }
            }
        });
        let repeat = match c.repeat_count.as_deref().map(str::trim) {
            Some("indefinite") => Some(serde_json::Value::from("indefinite")),
            Some(r) => r
                .parse::<f64>()
                .ok()
                .map(|r| serde_json::Value::from(r / 1000.0)),
            None => None,
        };
        out.push(EffectInfo {
            index: i,
            target: target.as_ref().map(TargetInfo::from),
            paragraph: match target.as_ref().and_then(|t| t.sub.clone()) {
                Some(SpSub::Paragraphs { st, .. }) => Some(st),
                _ => None,
            },
            bg: matches!(target.as_ref().and_then(|t| t.sub.clone()), Some(SpSub::Bg)),
            preset_class: c.preset_class.clone(),
            preset_id: c.preset_id,
            preset_subtype: c.preset_subtype,
            name: match (&c.preset_class, c.preset_id) {
                (Some(cl), Some(id)) => presets::name(cl, id).unwrap_or("Custom").to_string(),
                _ => "Custom".to_string(),
            },
            start: e.start,
            delay_ms: delay,
            duration_ms: simple,
            repeat,
            rewind: c.auto_rev == Some(true),
            rewind_when_done: c.fill.as_deref() == Some("remove"),
            smooth_start: c.accel.unwrap_or(0) > 0,
            smooth_end: c.decel.unwrap_or(0) > 0,
            trigger: e.trigger.as_ref().map(TargetInfo::from),
            click_group: if e.trigger.is_some() { 0 } else { group },
            begin_ms: begin,
            end_ms: end,
            editable,
            path: motion.as_ref().map(|m| m.0.clone()),
            path_locked: motion.as_ref().is_some_and(|m| m.1),
        });
    }
    (out, clicks)
}

/// The effects of a timing not in PowerPoint's structure, in document
/// order (for the list only).
fn loose(t: &Timing) -> Vec<FlatEffect> {
    let mut out = Vec::new();
    let mut seen_first = false;
    t.walk(&mut |n| {
        if is_effect(n) {
            let start = start_of(n.ctn().expect("par"), !seen_first, false);
            seen_first = true;
            out.push(FlatEffect {
                node: n.clone(),
                start,
                trigger: None,
            });
        }
    });
    out
}

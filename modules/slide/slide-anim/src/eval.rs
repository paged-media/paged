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

//! One frame of a slide's animations: the compiled tree ([`schedule`]) walked
//! at a moment, from the clicks so far, into one [`LayerState`] per layer.
//!
//! - **Starts.** A node starts after its parent by its delay; in a sequence
//!   after the previous child ends; a main-sequence group with an
//!   `indefinite` start waits for the next click on the slide, a trigger's
//!   sequence for a click on its shape. With `nextAc="seek"` a click while
//!   the previous group still plays takes that group to its end at once.
//! - **Time.** Inside a node: its iterations (`repeatCount`), reversal
//!   (`autoRev`) and the acceleration warp (`accel` / `decel`); its
//!   children see the warped time.
//! - **Fill.** After its end a node keeps its last values unless its fill
//!   (or its parent's, which it inherits) is `remove`.
//! - **Sandwich.** Behaviours apply in document order; `additive="sum"`
//!   adds, anything else sets. A shape whose first visibility `set` is
//!   `visible` is hidden until it plays.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::fmla::Env;
use crate::schedule::{self, Begin, Fill, Kind, Node, INF};
use crate::{hsl_rgb, rgb_hex, rgb_hsl, Attr, Behaviour, Op, Val};

/// A layer's state at a moment. Placement is about the layer's centre:
/// scale, then rotation, then the move.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerState {
    pub visible: bool,
    pub opacity: f64,
    /// Move of the centre, pt.
    pub dx: f64,
    pub dy: f64,
    pub sx: f64,
    pub sy: f64,
    /// Degrees, clockwise.
    pub rot: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skew_x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skew_y: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mask: Option<Mask>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fill: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_style: Option<TextStyle>,
}

/// A filter taking the layer in or out (`p:animEffect`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mask {
    /// `fade`, `wipe`, `barn`, `blinds`, `box`, `checkerboard`, `circle`,
    /// `diamond`, `dissolve`, `plus`, `randombar`, `slide`, `strips`,
    /// `wedge`, `wheel`, …
    pub filter: String,
    /// `down`, `inVertical`, `4`, …
    pub sub: Option<String>,
    /// 0..1 of the way in (or out).
    pub progress: f64,
    pub out: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextStyle {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bold: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub italic: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub underline: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<f64>,
}

/// A layer's box: page space, pt, unrotated.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// A click: `next` on the slide (the main sequence), `click` on a shape (a
/// trigger). `at`: ms since the slide started.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Event {
    pub kind: String,
    pub at: f64,
    #[serde(default)]
    pub target: Option<String>,
}

/// A command a behaviour gives (play a medium, …).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Command {
    pub target: String,
    pub cmd: String,
    pub at: f64,
}

/// One frame.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Frame {
    pub layers: BTreeMap<String, LayerState>,
    /// Something animates at this moment (or will without another click).
    pub running: bool,
    /// The next moment something is due to start, ms, when one is known.
    pub next_change: Option<f64>,
    pub commands: Vec<Command>,
}

/// A slide's animations ready to evaluate.
#[derive(Debug, Clone)]
pub struct Compiled {
    pub roots: Vec<Node>,
    pub w: f64,
    pub h: f64,
    /// Every layer key the timing animates, with whether it starts
    /// visible.
    pub initial: BTreeMap<String, bool>,
}

impl Compiled {
    pub fn new(roots: Vec<Node>, w: f64, h: f64) -> Compiled {
        let mut initial = BTreeMap::new();
        fn walk(n: &Node, out: &mut BTreeMap<String, bool>) {
            if let Kind::Behaviour(b) = &n.kind {
                for k in &b.keys {
                    let first = match &b.op {
                        Op::Set {
                            attr: Attr::Visibility,
                            to: Some(Val::Str(s)),
                        } => Some(s != "visible"),
                        _ => None,
                    };
                    match (out.get(k), first) {
                        (None, Some(v)) => {
                            out.insert(k.clone(), v);
                        }
                        (None, None) => {
                            // Seen, no visibility yet: a later set decides.
                        }
                        _ => {}
                    }
                }
            }
            for c in &n.children {
                walk(c, out);
            }
        }
        for r in &roots {
            walk(r, &mut initial);
        }
        // Keys never given a visibility start visible.
        fn keys(n: &Node, out: &mut BTreeMap<String, bool>) {
            if let Kind::Behaviour(b) = &n.kind {
                for k in &b.keys {
                    out.entry(k.clone()).or_insert(true);
                }
            }
            for c in &n.children {
                keys(c, out);
            }
        }
        for r in &roots {
            keys(r, &mut initial);
        }
        Compiled {
            roots,
            w,
            h,
            initial,
        }
    }

    /// How many clicks the main sequence takes.
    pub fn clicks(&self) -> usize {
        fn find(n: &Node) -> Option<usize> {
            if let Kind::Seq { main: true, .. } = n.kind {
                return Some(
                    n.children
                        .iter()
                        .filter(|c| c.begin == Begin::Advance)
                        .count(),
                );
            }
            n.children.iter().find_map(find)
        }
        self.roots.iter().find_map(find).unwrap_or(0)
    }

    /// The frame at `now` after `events`.
    pub fn evaluate(
        &self,
        events: &[Event],
        now: f64,
        boxes: &BTreeMap<String, Bounds>,
        colors: &BTreeMap<String, [u8; 3]>,
    ) -> Frame {
        let mut events: Vec<Event> = events.iter().filter(|e| e.at <= now).cloned().collect();
        events.sort_by(|a, b| a.at.total_cmp(&b.at));
        let mut run = Run {
            c: self,
            events: &events,
            now,
            boxes,
            colors,
            acc: BTreeMap::new(),
            running: false,
            next_change: None,
            commands: Vec::new(),
        };
        let begins = schedule::static_begins(&self.roots);
        for (r, b) in self.roots.iter().zip(begins) {
            if let Some(b) = b {
                run.visit(r, now, b, 0.0, false);
            }
        }
        let mut layers = BTreeMap::new();
        for (k, vis) in &self.initial {
            let a = run.acc.remove(k).unwrap_or_else(|| Acc::new(*vis));
            layers.insert(k.clone(), run.finish(k, a));
        }
        Frame {
            layers,
            running: run.running,
            next_change: run.next_change,
            commands: run.commands,
        }
    }
}

#[derive(Debug, Clone)]
struct Acc {
    visible: bool,
    opacity: f64,
    abs: [Option<f64>; 4],
    add: [f64; 4],
    scale: (f64, f64),
    rot_abs: Option<f64>,
    rot_add: f64,
    skew: (Option<f64>, Option<f64>),
    mask: Option<Mask>,
    fill: Option<[u8; 3]>,
    line: Option<[u8; 3]>,
    text: Option<[u8; 3]>,
    style: Option<TextStyle>,
}

impl Acc {
    fn new(visible: bool) -> Acc {
        Acc {
            visible,
            opacity: 1.0,
            abs: [None; 4],
            add: [0.0; 4],
            scale: (1.0, 1.0),
            rot_abs: None,
            rot_add: 0.0,
            skew: (None, None),
            mask: None,
            fill: None,
            line: None,
            text: None,
            style: None,
        }
    }
}

struct Run<'a> {
    c: &'a Compiled,
    events: &'a [Event],
    now: f64,
    boxes: &'a BTreeMap<String, Bounds>,
    colors: &'a BTreeMap<String, [u8; 3]>,
    acc: BTreeMap<String, Acc>,
    running: bool,
    next_change: Option<f64>,
    commands: Vec<Command>,
}

impl Run<'_> {
    fn future(&mut self, at: f64) {
        if at.is_finite() && at > self.now {
            self.next_change = Some(self.next_change.map_or(at, |n: f64| n.min(at)));
        }
    }

    /// Clicks on `target` (a trigger), ms.
    fn clicks_on(&self, target: &str) -> Vec<f64> {
        self.events
            .iter()
            .filter(|e| e.kind == "click" && e.target.as_deref() == Some(target))
            .map(|e| e.at)
            .collect()
    }

    /// Visit `n`, which starts at `begin` in its parent's time; the parent
    /// is at `t_parent`; the parent's time 0 is `abs0` ms of the slide
    /// (meaningful while nothing above warps time).
    fn visit(&mut self, n: &Node, t_parent: f64, begin: f64, abs0: f64, warped: bool) {
        let t = t_parent - begin;
        if t < 0.0 {
            if !warped {
                self.future(abs0 + begin);
            }
            return;
        }
        let ended = t >= n.active;
        if ended && n.fill == Fill::Remove {
            return;
        }
        let tl = if ended { n.active } else { t };
        if !ended && n.active.is_finite() {
            self.running = true;
        }
        let s = if tl.is_finite() {
            n.simple_time(tl)
        } else {
            tl
        };
        let abs_begin = abs0 + begin;
        let child_warped = warped
            || n.accel > 0.0
            || n.decel > 0.0
            || n.auto_rev
            || (n.active.is_finite() && (n.active - n.simple).abs() > 1e-9);
        match &n.kind {
            Kind::Par => {
                let mut begins = schedule::static_begins(&n.children);
                for (i, c) in n.children.iter().enumerate() {
                    if let Begin::Click(target, d) = &c.begin {
                        let first = self.clicks_on(target).first().copied();
                        begins[i] = first.map(|at| at - abs_begin + d);
                    }
                }
                for (c, b) in n.children.iter().zip(begins) {
                    if let Some(b) = b {
                        self.visit(c, s, b, abs_begin, child_warped);
                    }
                }
            }
            Kind::Seq {
                main,
                trigger,
                seek,
            } => {
                let mut adv: Vec<f64> = if *main {
                    self.events
                        .iter()
                        .filter(|e| e.kind == "next")
                        .map(|e| e.at - abs_begin)
                        .collect()
                } else if let Some(tg) = trigger {
                    let first_waits = n
                        .children
                        .first()
                        .map(|c| c.begin == Begin::Advance)
                        .unwrap_or(false);
                    self.clicks_on(tg)
                        .into_iter()
                        .map(|at| at - abs_begin)
                        .filter(|&a| if first_waits { a >= -1e-9 } else { a > 1e-9 })
                        .collect()
                } else {
                    Vec::new()
                };
                adv.reverse();
                let mut begins: Vec<Option<f64>> = Vec::with_capacity(n.children.len());
                let mut prev_end: Option<f64> = Some(0.0);
                for (i, c) in n.children.iter().enumerate() {
                    let b = match &c.begin {
                        Begin::Advance => adv.pop(),
                        Begin::Delay(d) => {
                            if i == 0 {
                                Some(*d)
                            } else {
                                prev_end.map(|e| e + d)
                            }
                        }
                        Begin::OnBegin(id, d) => {
                            if Some(*id) == n.id {
                                Some(*d)
                            } else {
                                n.children
                                    .iter()
                                    .position(|x| x.id == Some(*id))
                                    .and_then(|j| begins.get(j).copied().flatten())
                                    .map(|b| b + d)
                            }
                        }
                        Begin::OnEnd(id, d) => n
                            .children
                            .iter()
                            .position(|x| x.id == Some(*id))
                            .and_then(|j| {
                                begins
                                    .get(j)
                                    .copied()
                                    .flatten()
                                    .map(|b| b + n.children[j].active)
                            })
                            .map(|e| e + d),
                        Begin::Click(target, d) => {
                            self.clicks_on(target).first().map(|at| at - abs_begin + d)
                        }
                        Begin::Never => None,
                    };
                    prev_end = b.map(|b| b + c.active);
                    begins.push(b);
                }
                for (i, c) in n.children.iter().enumerate() {
                    let Some(b) = begins[i] else { continue };
                    // A later group started by a click: this one is sought
                    // to its end.
                    let sought = *seek
                        && begins[i + 1..]
                            .iter()
                            .zip(&n.children[i + 1..])
                            .any(|(nb, nc)| {
                                nc.begin == Begin::Advance
                                    && nb.is_some_and(|nb| nb <= s && nb >= b)
                            });
                    let tp = if sought { INF } else { s };
                    self.visit(c, tp, b, abs_begin, child_warped);
                }
            }
            Kind::Behaviour(b) => {
                let p = if n.simple.is_finite() && n.simple > 0.0 {
                    (s / n.simple).clamp(0.0, 1.0)
                } else {
                    1.0
                };
                self.apply(b, p, abs_begin);
            }
            Kind::Inert => {}
        }
    }

    fn base_box(&self, key: &str, target: &str) -> Bounds {
        self.boxes
            .get(key)
            .or_else(|| self.boxes.get(target))
            .copied()
            .unwrap_or(Bounds {
                x: self.c.w * 0.45,
                y: self.c.h * 0.45,
                w: self.c.w * 0.1,
                h: self.c.h * 0.1,
            })
    }

    fn env(&self, key: &str, target: &str, value: f64, seed: u64) -> Env {
        let b = self.base_box(key, target);
        let (w, h) = (self.c.w.max(1e-9), self.c.h.max(1e-9));
        Env {
            x: (b.x + b.w / 2.0) / w,
            y: (b.y + b.h / 2.0) / h,
            w: b.w / w,
            h: b.h / h,
            value,
            seed,
        }
    }

    fn apply(&mut self, b: &Behaviour, p: f64, began: f64) {
        if let Op::Cmd { cmd } = &b.op {
            self.commands.push(Command {
                target: b.target.clone(),
                cmd: cmd.clone(),
                at: began,
            });
            return;
        }
        for key in &b.keys {
            let env = self.env(key, &b.target, 0.0, b.seed);
            let initial = self.c.initial.get(key).copied().unwrap_or(true);
            let base_colors = self
                .colors
                .get(key)
                .or_else(|| self.colors.get(&b.target))
                .copied();
            let acc = self
                .acc
                .entry(key.clone())
                .or_insert_with(|| Acc::new(initial));
            apply_op(acc, &b.op, p, &env, base_colors);
        }
    }

    fn finish(&self, key: &str, a: Acc) -> LayerState {
        let target = key.split('#').next().unwrap_or(key);
        let e = self.env(key, target, 0.0, 0);
        let (w, h) = (self.c.w, self.c.h);
        let base = [e.x, e.y, e.w, e.h];
        let pos = |i: usize| a.abs[i].unwrap_or(base[i]) + a.add[i];
        let size = |i: usize| {
            if base[i].abs() < 1e-12 {
                1.0
            } else {
                pos(i) / base[i]
            }
        };
        LayerState {
            visible: a.visible,
            opacity: a.opacity.clamp(0.0, 1.0),
            dx: round((pos(0) - base[0]) * w),
            dy: round((pos(1) - base[1]) * h),
            sx: round(size(2) * a.scale.0),
            sy: round(size(3) * a.scale.1),
            rot: round(a.rot_abs.unwrap_or(0.0) + a.rot_add),
            skew_x: a.skew.0.map(round),
            skew_y: a.skew.1.map(round),
            mask: a.mask.map(|mut m| {
                m.progress = round(m.progress);
                m
            }),
            fill: a.fill.map(rgb_hex),
            line: a.line.map(rgb_hex),
            text: a.text.map(rgb_hex),
            text_style: a.style,
        }
    }
}

/// Rounded to 1e-6 so the frames are stable across platforms.
fn round(v: f64) -> f64 {
    let r = (v * 1e6).round() / 1e6;
    if r == 0.0 {
        0.0
    } else {
        r
    }
}

fn num(v: &Val, env: &Env) -> Option<f64> {
    match v {
        Val::Num(e) => Some(e.eval(env)),
        Val::Str(s) => s.trim().parse().ok(),
        Val::Clr(_) => None,
    }
}

/// An animation's value at `p`: the key points (each segment interpolated,
/// the formula of its first point applied to the interpolated `$`), or
/// from / to / by.
enum Out {
    Num(f64),
    Str(String),
    Clr([u8; 3]),
}

fn lerp_clr(a: [u8; 3], b: [u8; 3], f: f64) -> [u8; 3] {
    [0, 1, 2].map(|i| {
        (a[i] as f64 + (b[i] as f64 - a[i] as f64) * f)
            .round()
            .clamp(0.0, 255.0) as u8
    })
}

#[allow(clippy::too_many_arguments)]
fn anim_value(
    points: &[crate::Point],
    from: &Option<Val>,
    to: &Option<Val>,
    by: &Option<Val>,
    discrete: bool,
    p: f64,
    env: &Env,
    base: f64,
) -> Option<Out> {
    let eval_pt = |pt: &crate::Point, value: Option<f64>| -> Option<Out> {
        match (&pt.val, value) {
            (_, Some(v)) => Some(Out::Num(match &pt.fmla {
                Some(f) => f.eval(&Env { value: v, ..*env }),
                None => v,
            })),
            (Some(Val::Str(s)), None) => Some(Out::Str(s.clone())),
            (Some(Val::Clr(c)), None) => Some(Out::Clr(*c)),
            (Some(v @ Val::Num(_)), None) => {
                let v = num(v, env)?;
                Some(Out::Num(match &pt.fmla {
                    Some(f) => f.eval(&Env { value: v, ..*env }),
                    None => v,
                }))
            }
            (None, None) => pt.fmla.as_ref().map(|f| Out::Num(f.eval(env))),
        }
    };
    if !points.is_empty() {
        if discrete || points.len() == 1 {
            let pt = points
                .iter()
                .rev()
                .find(|x| x.tm <= p + 1e-12)
                .unwrap_or(&points[0]);
            return eval_pt(pt, None);
        }
        if p <= points[0].tm {
            return eval_pt(&points[0], None);
        }
        for w in points.windows(2) {
            let (a, b) = (&w[0], &w[1]);
            if p <= b.tm + 1e-12 {
                let f = if b.tm > a.tm {
                    ((p - a.tm) / (b.tm - a.tm)).clamp(0.0, 1.0)
                } else {
                    1.0
                };
                return match (&a.val, &b.val) {
                    (Some(Val::Clr(x)), Some(Val::Clr(y))) => Some(Out::Clr(lerp_clr(*x, *y, f))),
                    (Some(Val::Str(_)), _) | (_, Some(Val::Str(_))) => {
                        eval_pt(if f < 1.0 { a } else { b }, None)
                    }
                    (Some(x), Some(y)) => {
                        let (x, y) = (num(x, env)?, num(y, env)?);
                        eval_pt(a, Some(x + (y - x) * f))
                    }
                    _ => eval_pt(a, None),
                };
            }
        }
        return eval_pt(points.last()?, None);
    }
    let f = from.as_ref().and_then(|v| num(v, env)).unwrap_or(base);
    let t = match (to, by) {
        (Some(t), _) => match t {
            Val::Str(s) if s.trim().parse::<f64>().is_err() => return Some(Out::Str(s.clone())),
            Val::Clr(c) => return Some(Out::Clr(*c)),
            _ => num(t, env)?,
        },
        (None, Some(b)) => f + num(b, env)?,
        (None, None) => return None,
    };
    if discrete {
        return Some(Out::Num(if p < 1.0 { f } else { t }));
    }
    Some(Out::Num(f + (t - f) * p))
}

fn apply_op(a: &mut Acc, op: &Op, p: f64, env: &Env, base_colors: Option<[u8; 3]>) {
    let base_of = |a: &Acc, attr: Attr| -> f64 {
        let base = [env.x, env.y, env.w, env.h];
        match attr {
            Attr::X => a.abs[0].unwrap_or(base[0]) + a.add[0],
            Attr::Y => a.abs[1].unwrap_or(base[1]) + a.add[1],
            Attr::W => a.abs[2].unwrap_or(base[2]) + a.add[2],
            Attr::H => a.abs[3].unwrap_or(base[3]) + a.add[3],
            Attr::Rot => a.rot_abs.unwrap_or(0.0) + a.rot_add,
            Attr::Opacity => a.opacity,
            _ => 0.0,
        }
    };
    match op {
        Op::Set { attr, to } => {
            let Some(v) = to else { return };
            set_value(a, *attr, value_out(v, env), false);
        }
        Op::Anim {
            attr,
            sum,
            discrete,
            points,
            from,
            to,
            by,
        } => {
            let base = if *sum { 0.0 } else { base_of(a, *attr) };
            if let Some(v) = anim_value(points, from, to, by, *discrete, p, env, base) {
                set_value(a, *attr, v, *sum);
            }
        }
        Op::Effect {
            filter,
            sub,
            transition,
            opacity,
        } => match transition.as_str() {
            "in" => {
                a.mask = (p < 1.0).then(|| Mask {
                    filter: filter.clone(),
                    sub: sub.clone(),
                    progress: p,
                    out: false,
                });
            }
            "out" => {
                a.mask = Some(Mask {
                    filter: filter.clone(),
                    sub: sub.clone(),
                    progress: p,
                    out: true,
                });
            }
            _ => {
                if let Some(o) = opacity {
                    a.opacity *= o;
                }
            }
        },
        Op::Motion { path, from, to, by } => {
            let (x, y) = match (path, from, to, by) {
                (Some(path), ..) => path.at(p),
                (None, f, Some(t), _) => {
                    let f = f.unwrap_or((0.0, 0.0));
                    (f.0 + (t.0 - f.0) * p, f.1 + (t.1 - f.1) * p)
                }
                (None, f, None, Some(b)) => {
                    let f = f.unwrap_or((0.0, 0.0));
                    (f.0 + b.0 * p, f.1 + b.1 * p)
                }
                _ => (0.0, 0.0),
            };
            a.add[0] += x;
            a.add[1] += y;
        }
        // `to` sets the scale (from `from`, else where it is); `by`
        // multiplies it.
        Op::Scale { from, to, by } => match (to, by) {
            (Some(t), _) => {
                let f = from.unwrap_or(a.scale);
                a.scale = (f.0 + (t.0 - f.0) * p, f.1 + (t.1 - f.1) * p);
            }
            (None, Some(b)) => {
                let f = from.unwrap_or((1.0, 1.0));
                a.scale.0 *= f.0 + (f.0 * b.0 - f.0) * p;
                a.scale.1 *= f.1 + (f.1 * b.1 - f.1) * p;
            }
            _ => {}
        },
        Op::Rot { from, to, by } => match (from, to, by) {
            (_, Some(t), _) => {
                let f = from.unwrap_or(a.rot_abs.unwrap_or(0.0) + a.rot_add);
                a.rot_abs = Some(f + (t - f) * p);
                a.rot_add = 0.0;
            }
            (_, None, Some(b)) => a.rot_add += b * p,
            _ => {}
        },
        Op::Clr {
            attr,
            hsl,
            ccw,
            from,
            to,
            by,
        } => {
            let current = match attr {
                Attr::Fill => a.fill,
                Attr::Line => a.line,
                Attr::Text => a.text,
                _ => None,
            };
            let f = from.or(current).or(base_colors);
            let c = match (f, to, by) {
                (Some(f), Some(t), _) => Some(if *hsl {
                    let (h0, s0, l0) = rgb_hsl(f);
                    let (h1, s1, l1) = rgb_hsl(*t);
                    let mut dh = h1 - h0;
                    if *ccw && dh > 0.0 {
                        dh -= 360.0;
                    } else if !*ccw && dh < 0.0 {
                        dh += 360.0;
                    }
                    hsl_rgb(h0 + dh * p, s0 + (s1 - s0) * p, l0 + (l1 - l0) * p)
                } else {
                    lerp_clr(f, *t, p)
                }),
                (None, Some(t), _) => Some(if p >= 1.0 { *t } else { lerp_clr(*t, *t, p) }),
                (Some(f), None, Some(pptx_core::anim::ColorBy::Hsl { h, s, l })) => {
                    let (h0, s0, l0) = rgb_hsl(f);
                    let dir = if *ccw { -1.0 } else { 1.0 };
                    Some(hsl_rgb(
                        h0 + dir * (*h as f64 / 60_000.0) * p,
                        (s0 + *s as f64 / 100_000.0 * p).clamp(0.0, 1.0),
                        (l0 + *l as f64 / 100_000.0 * p).clamp(0.0, 1.0),
                    ))
                }
                (Some(f), None, Some(pptx_core::anim::ColorBy::Rgb { r, g, b })) => {
                    let d = [*r, *g, *b].map(|v| v as f64 / 100_000.0 * 255.0 * p);
                    Some([0, 1, 2].map(|i| (f[i] as f64 + d[i]).round().clamp(0.0, 255.0) as u8))
                }
                _ => None,
            };
            if let Some(c) = c {
                match attr {
                    Attr::Fill => a.fill = Some(c),
                    Attr::Line => a.line = Some(c),
                    Attr::Text => a.text = Some(c),
                    _ => {}
                }
            }
        }
        Op::Cmd { .. } => {}
    }
}

fn value_out(v: &Val, env: &Env) -> Out {
    match v {
        Val::Num(e) => Out::Num(e.eval(env)),
        Val::Str(s) => Out::Str(s.clone()),
        Val::Clr(c) => Out::Clr(*c),
    }
}

fn set_value(a: &mut Acc, attr: Attr, v: Out, sum: bool) {
    let idx = match attr {
        Attr::X => Some(0),
        Attr::Y => Some(1),
        Attr::W => Some(2),
        Attr::H => Some(3),
        _ => None,
    };
    match (attr, v) {
        (Attr::Visibility, Out::Str(s)) => a.visible = s.trim() != "hidden",
        (_, Out::Num(n)) if idx.is_some() => {
            let i = idx.unwrap_or(0);
            if sum {
                a.add[i] += n;
            } else {
                a.abs[i] = Some(n);
                a.add[i] = 0.0;
            }
        }
        (Attr::Rot, Out::Num(n)) => {
            if sum {
                a.rot_add += n;
            } else {
                a.rot_abs = Some(n);
                a.rot_add = 0.0;
            }
        }
        (Attr::Opacity, Out::Num(n)) => a.opacity = if sum { a.opacity + n } else { n },
        (Attr::SkewX, Out::Num(n)) => a.skew.0 = Some(n),
        (Attr::SkewY, Out::Num(n)) => a.skew.1 = Some(n),
        (Attr::Fill, Out::Clr(c)) => a.fill = Some(c),
        (Attr::Line, Out::Clr(c)) => a.line = Some(c),
        (Attr::Text, Out::Clr(c)) => a.text = Some(c),
        (Attr::Bold, Out::Str(s)) => {
            a.style.get_or_insert_with(TextStyle::default).bold = Some(s.trim() == "bold")
        }
        (Attr::Italic, Out::Str(s)) => {
            a.style.get_or_insert_with(TextStyle::default).italic = Some(s.trim() == "italic")
        }
        (Attr::Underline, Out::Str(s)) => {
            a.style.get_or_insert_with(TextStyle::default).underline = Some(s.trim() == "true")
        }
        (Attr::Underline, Out::Num(n)) => {
            a.style.get_or_insert_with(TextStyle::default).underline = Some(n != 0.0)
        }
        (Attr::FontSize, Out::Num(n)) => {
            a.style.get_or_insert_with(TextStyle::default).size = Some(n)
        }
        _ => {}
    }
}

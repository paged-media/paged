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

//! The time-node tree compiled for playback (ECMA-376 Part 1 §19.5, the
//! SMIL timing model PowerPoint follows): each node's start (a delay in its
//! parent's time, a click, a click on a shape, the start or end of another
//! node), its simple and active durations (repeats, auto-reverse), its time
//! warp (acceleration, deceleration) and its fill. Compiled once per slide;
//! [`crate::eval`] walks it per frame.

use pptx_core::anim::{CommonTimeNode, CondTarget, Condition, TargetEl, TimeNode, Timing};

use crate::{target_id, Behaviour, Ctx};

pub const INF: f64 = f64::INFINITY;

/// How a node starts.
#[derive(Debug, Clone, PartialEq)]
pub enum Begin {
    /// This long after its parent's start (in a sequence: after the
    /// previous child's end).
    Delay(f64),
    /// When its sequence advances (a click on the slide for the main
    /// sequence, on the trigger shape for an interactive one).
    Advance,
    /// When the shape is clicked (a trigger), plus a delay.
    Click(String, f64),
    /// When node `id` starts / ends, plus a delay.
    OnBegin(u32, f64),
    OnEnd(u32, f64),
    /// Never (an event this player does not raise).
    Never,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fill {
    Hold,
    Remove,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Kind {
    Par,
    /// A sequence: `main` (advanced by clicks on the slide), else advanced
    /// by clicks on its trigger (`trigger`) or by its children's ends.
    Seq {
        main: bool,
        trigger: Option<String>,
        seek: bool,
    },
    Behaviour(Box<Behaviour>),
    /// A node the player does not play (raw XML).
    Inert,
}

/// One compiled node.
#[derive(Debug, Clone, PartialEq)]
pub struct Node {
    pub kind: Kind,
    pub id: Option<u32>,
    pub begin: Begin,
    /// The simple duration (`dur`, else implied by the children); `INF`
    /// for indefinite.
    pub simple: f64,
    /// The active duration: the simple one repeated (and reversed).
    pub active: f64,
    pub auto_rev: bool,
    /// `accel` / `decel` as fractions of the simple duration.
    pub accel: f64,
    pub decel: f64,
    pub fill: Fill,
    pub children: Vec<Node>,
    /// Document order of the node (behaviours apply in it).
    pub order: usize,
}

impl Node {
    /// The node's simple time for local time `t` (0 ≤ t ≤ active):
    /// iterations, auto-reverse and the acceleration warp applied.
    pub fn simple_time(&self, t: f64) -> f64 {
        let d = self.simple;
        if !(d.is_finite()) || d <= 0.0 {
            return t;
        }
        let iter = if self.auto_rev { 2.0 * d } else { d };
        let mut ti = if t >= self.active && self.active.is_finite() {
            // At the end: the end of the last (possibly partial) iteration.
            let r = self.active % iter;
            if r.abs() < 1e-9 {
                iter
            } else {
                r
            }
        } else {
            t % iter
        };
        if ti < 0.0 {
            ti = 0.0;
        }
        let u = if self.auto_rev && ti > d {
            2.0 * d - ti
        } else {
            ti
        };
        d * ease(u / d, self.accel, self.decel)
    }
}

/// SMIL's acceleration / deceleration warp of progress `x`.
pub fn ease(x: f64, a: f64, dcl: f64) -> f64 {
    let x = x.clamp(0.0, 1.0);
    if a <= 0.0 && dcl <= 0.0 || a + dcl > 1.0 {
        return x;
    }
    let r = 1.0 / (1.0 - a / 2.0 - dcl / 2.0);
    if x < a {
        r * x * x / (2.0 * a)
    } else if x <= 1.0 - dcl {
        r * (x - a / 2.0)
    } else {
        let y = 1.0 - x;
        1.0 - r * y * y / (2.0 * dcl)
    }
}

fn parse_ms(s: &str) -> Option<f64> {
    s.trim().parse::<f64>().ok()
}

fn begin_of(ctn: &CommonTimeNode) -> Begin {
    let Some(conds) = &ctn.st_conds else {
        return Begin::Delay(0.0);
    };
    let mut best: Option<Begin> = None;
    for c in conds {
        let b = cond_begin(c);
        // Prefer a begin that happens without a click (onBegin of the main
        // sequence on the first group), then a click.
        best = match (&best, &b) {
            (None, _) => Some(b),
            (Some(Begin::Advance), Begin::OnBegin(..) | Begin::Delay(_) | Begin::Click(..)) => {
                Some(b)
            }
            (Some(Begin::Never), _) => Some(b),
            _ => best,
        };
    }
    best.unwrap_or(Begin::Delay(0.0))
}

fn cond_begin(c: &Condition) -> Begin {
    let delay = c.delay.as_deref();
    let d = delay.and_then(parse_ms).unwrap_or(0.0);
    let indefinite = delay.map(str::trim) == Some("indefinite");
    match (c.evt.as_deref(), &c.target) {
        (None, None) if indefinite => Begin::Advance,
        (None, None) => Begin::Delay(d),
        (Some("onBegin" | "begin"), Some(CondTarget::Tn { val: Some(id), .. })) => {
            Begin::OnBegin(*id, d)
        }
        (Some("onEnd" | "end"), Some(CondTarget::Tn { val: Some(id), .. })) => Begin::OnEnd(*id, d),
        (
            Some("onClick"),
            Some(CondTarget::El {
                el: TargetEl::Sp(sp),
            }),
        ) => Begin::Click(target_id(sp), d),
        (Some("onNext"), _) => Begin::Advance,
        _ => Begin::Never,
    }
}

/// Compile a timing.
pub fn compile(t: &Timing, ctx: &Ctx) -> Vec<Node> {
    let mut order = 0;
    t.nodes
        .iter()
        .map(|n| node(n, Fill::Hold, &mut order, ctx))
        .collect()
}

/// Compile one node (an effect, for its durations).
pub fn compile_node(n: &TimeNode, ctx: &Ctx) -> Node {
    let mut order = 0;
    node(n, Fill::Hold, &mut order, ctx)
}

fn fill_of(ctn: &CommonTimeNode, inherited: Fill) -> Fill {
    match ctn.fill.as_deref() {
        Some("remove") => Fill::Remove,
        Some(_) => Fill::Hold,
        None => inherited,
    }
}

fn node(n: &TimeNode, inherited: Fill, order: &mut usize, ctx: &Ctx) -> Node {
    *order += 1;
    let my_order = *order;
    let Some(ctn) = n.ctn() else {
        return Node {
            kind: Kind::Inert,
            id: None,
            begin: Begin::Never,
            simple: 0.0,
            active: 0.0,
            auto_rev: false,
            accel: 0.0,
            decel: 0.0,
            fill: Fill::Remove,
            children: Vec::new(),
            order: my_order,
        };
    };
    let fill = fill_of(ctn, inherited);
    let kind = match n {
        TimeNode::Par { .. } | TimeNode::Excl { .. } => Kind::Par,
        TimeNode::Seq {
            next_ac,
            next_conds,
            ..
        } => {
            let main = ctn.node_type.as_deref() == Some("mainSeq")
                || next_conds
                    .iter()
                    .flatten()
                    .any(|c| c.evt.as_deref() == Some("onNext"));
            let trigger = next_conds
                .iter()
                .flatten()
                .chain(ctn.st_conds.iter().flatten())
                .find_map(|c| match (&c.evt, &c.target) {
                    (
                        Some(e),
                        Some(CondTarget::El {
                            el: TargetEl::Sp(sp),
                        }),
                    ) if e == "onClick" => Some(target_id(sp)),
                    _ => None,
                });
            Kind::Seq {
                main: main && trigger.is_none(),
                trigger,
                seek: next_ac.as_deref() == Some("seek") || main,
            }
        }
        TimeNode::Raw { .. } => Kind::Inert,
        other => match crate::behaviour(other, ctx) {
            Some(b) => Kind::Behaviour(Box::new(b)),
            None => Kind::Inert,
        },
    };
    let children: Vec<Node> = match n.container_ctn() {
        Some(c) => c
            .children
            .iter()
            .map(|x| node(x, fill, order, ctx))
            .collect(),
        None => Vec::new(),
    };
    let explicit = ctn.dur.as_deref().map(str::trim);
    let simple = match explicit {
        Some("indefinite") => INF,
        Some(d) => parse_ms(d).unwrap_or(0.0),
        None => match &kind {
            Kind::Par => implied_par(&children),
            Kind::Seq { main, trigger, .. } if !*main && trigger.is_none() => {
                implied_seq(&children)
            }
            Kind::Seq { .. } => INF,
            _ => 0.0,
        },
    };
    let count = match ctn.repeat_count.as_deref().map(str::trim) {
        Some("indefinite") => INF,
        Some(c) => parse_ms(c).map(|c| c / 1000.0).unwrap_or(1.0),
        None => 1.0,
    };
    let auto_rev = ctn.auto_rev == Some(true);
    let mut active = if simple.is_finite() {
        simple * count * if auto_rev { 2.0 } else { 1.0 }
    } else {
        INF
    };
    match ctn.repeat_dur.as_deref().map(str::trim) {
        Some("indefinite") => active = INF,
        Some(d) => {
            if let Some(d) = parse_ms(d) {
                active = if ctn.repeat_count.is_some() {
                    active.min(d)
                } else {
                    d
                };
            }
        }
        None => {}
    }
    if !active.is_finite() && simple.is_finite() && simple <= 0.0 {
        active = 0.0;
    }
    Node {
        kind,
        id: ctn.id,
        begin: begin_of(ctn),
        simple,
        active,
        auto_rev,
        accel: ctn.accel.unwrap_or(0) as f64 / 100_000.0,
        decel: ctn.decel.unwrap_or(0) as f64 / 100_000.0,
        fill,
        children,
        order: my_order,
    }
}

/// When each child of a parallel container starts and ends on its own
/// (delays and references to siblings), in the container's time; `None`
/// for a child waiting on an event.
pub fn static_begins(children: &[Node]) -> Vec<Option<f64>> {
    let mut out: Vec<Option<f64>> = vec![None; children.len()];
    // Two passes, for references to later siblings.
    for _ in 0..2 {
        for (i, c) in children.iter().enumerate() {
            let find = |id: u32| children.iter().position(|x| x.id == Some(id));
            out[i] = match &c.begin {
                Begin::Delay(d) => Some(*d),
                Begin::OnBegin(id, d) => match find(*id) {
                    Some(j) => out[j].map(|b| b + d),
                    // A reference to an ancestor: its start is ours.
                    None => Some(*d),
                },
                Begin::OnEnd(id, d) => {
                    find(*id).and_then(|j| out[j].map(|b| b + children[j].active + d))
                }
                _ => None,
            };
        }
    }
    out
}

fn implied_par(children: &[Node]) -> f64 {
    let begins = static_begins(children);
    let mut end: f64 = 0.0;
    for (c, b) in children.iter().zip(begins) {
        if let Some(b) = b {
            end = end.max(b + c.active);
        }
    }
    end
}

fn implied_seq(children: &[Node]) -> f64 {
    let mut end = 0.0;
    for c in children {
        match c.begin {
            Begin::Delay(d) => end += d + c.active,
            _ => return INF,
        }
    }
    end
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn eases_like_smil() {
        assert_eq!(ease(0.5, 0.0, 0.0), 0.5);
        // Symmetric half/half: the middle is the middle, the ends are slow.
        assert!((ease(0.5, 0.5, 0.5) - 0.5).abs() < 1e-12);
        assert!(ease(0.1, 0.5, 0.5) < 0.1);
        assert!(ease(0.9, 0.5, 0.5) > 0.9);
        assert!((ease(1.0, 0.5, 0.5) - 1.0).abs() < 1e-12);
        assert!((ease(1.0, 1.0, 0.0) - 1.0).abs() < 1e-12);
    }
}

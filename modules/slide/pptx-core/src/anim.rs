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

//! A slide's animation timing (`p:timing`, ECMA-376 Part 1 §19.5) as a tree
//! (slide ADR 714).
//!
//! The time-node tree is kept as the file writes it: `par` / `seq` / `excl`
//! containers with their common time node (`p:cTn`: id, preset, duration,
//! repeat, acceleration, fill, start and end conditions, iteration), and the
//! behaviours under them (`set`, `anim`, `animEffect`, `animMotion`,
//! `animScale`, `animRot`, `animClr`, `cmd`). An element this model does not
//! know (media nodes, extension lists, `mc:AlternateContent`) is a
//! [`TimeNode::Raw`] node holding its XML, written back as read; an attribute
//! it does not know stays in the element's `extra` list.
//!
//! [`Timing::to_xml`] writes the tree back as PresentationML. A timing read
//! and written again reads back equal (the tests hold every fixture and
//! corpus deck to that); export keeps the deck's bytes for a timing the
//! document did not change and writes this for one it did.
//!
//! Shape targets carry, beside the deck's `spid`, the document's own names
//! for the shape once a deck is imported: the page item's `Self` id and its
//! shape key (`ppt/slides/slide2.xml#4`). They are not written to the file.

use serde::{Deserialize, Serialize};

fn is_false(b: &bool) -> bool {
    !*b
}

/// `p:timing`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Timing {
    /// `p:tnLst`: the root time nodes (PowerPoint writes one `par`, the
    /// `tmRoot`).
    #[serde(default)]
    pub nodes: Vec<TimeNode>,
    /// `p:bldLst`; `None` when the element is absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub builds: Option<Vec<Build>>,
    /// Other children (`p:extLst`), verbatim.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub extra: Vec<String>,
}

/// One time node of a time-node list (`p:childTnLst`, `p:subTnLst`,
/// `p:tnLst`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "node", rename_all = "camelCase")]
pub enum TimeNode {
    /// `p:par`: children run in parallel.
    Par { ctn: CommonTimeNode },
    /// `p:seq`: children run one after the other (the main sequence and
    /// the interactive sequences).
    #[serde(rename_all = "camelCase")]
    Seq {
        ctn: CommonTimeNode,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        concurrent: Option<bool>,
        /// `prevAc`: `none` / `skipTimed`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        prev_ac: Option<String>,
        /// `nextAc`: `none` / `seek`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        next_ac: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        prev_conds: Option<Vec<Condition>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        next_conds: Option<Vec<Condition>>,
    },
    /// `p:excl`: one child at a time.
    Excl { ctn: CommonTimeNode },
    /// `p:set`: a value from the behaviour's start.
    Set {
        bhvr: Behavior,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        to: Option<AnimValue>,
    },
    /// `p:anim`: an attribute animated through key points or from / to /
    /// by.
    #[serde(rename_all = "camelCase")]
    Anim {
        bhvr: Behavior,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        by: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        from: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        to: Option<String>,
        /// `calcmode`: `discrete` / `lin` / `fmla`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        calcmode: Option<String>,
        /// `valueType`: `str` / `num` / `clr`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        value_type: Option<String>,
        /// `p:tavLst`; `None` when absent.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        points: Option<Vec<TimePoint>>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        extra: Vec<(String, String)>,
    },
    /// `p:animEffect`: a filter (fade, wipe(down), …) taking the target in
    /// or out.
    #[serde(rename_all = "camelCase")]
    AnimEffect {
        bhvr: Behavior,
        /// `transition`: `in` / `out` / `none`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        transition: Option<String>,
        /// `filter`: `fade`, `wipe(down)`, `wheel(4)`, …
        #[serde(default, skip_serializing_if = "Option::is_none")]
        filter: Option<String>,
        /// `prLst`: `opacity: 0.5`, …
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pr_lst: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        progress: Option<AnimValue>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        extra: Vec<(String, String)>,
    },
    /// `p:animMotion`: the target moves along a path.
    #[serde(rename_all = "camelCase")]
    AnimMotion {
        bhvr: Behavior,
        /// `origin`: `parent` / `layout`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        origin: Option<String>,
        /// `path`: `M 0 0 L 0.25 0.33 E`, in slide fractions.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        path: Option<String>,
        /// `pathEditMode`: `relative` / `fixed`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        path_edit_mode: Option<String>,
        /// `rAng`, 60 000ths of a degree.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        r_ang: Option<String>,
        /// `ptsTypes`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pts_types: Option<String>,
        /// `p:by` / `p:from` / `p:to` / `p:rCtr` (x, y), 1 000ths of a
        /// percent.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        by: Option<(i64, i64)>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        from: Option<(i64, i64)>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        to: Option<(i64, i64)>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        r_ctr: Option<(i64, i64)>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        extra: Vec<(String, String)>,
    },
    /// `p:animScale`: the target scales (x, y in 1 000ths of a percent).
    #[serde(rename_all = "camelCase")]
    AnimScale {
        bhvr: Behavior,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        zoom_contents: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        by: Option<(i64, i64)>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        from: Option<(i64, i64)>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        to: Option<(i64, i64)>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        extra: Vec<(String, String)>,
    },
    /// `p:animRot`: the target turns (60 000ths of a degree).
    AnimRot {
        bhvr: Behavior,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        by: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        from: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        to: Option<i64>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        extra: Vec<(String, String)>,
    },
    /// `p:animClr`: a colour changes.
    #[serde(rename_all = "camelCase")]
    AnimClr {
        bhvr: Behavior,
        /// `clrSpc`: `rgb` / `hsl`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        clr_spc: Option<String>,
        /// `dir`: `cw` / `ccw` (round the hue circle).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        dir: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        by: Option<ColorBy>,
        /// `p:from` / `p:to`: a DrawingML colour.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        from: Option<AnimColor>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        to: Option<AnimColor>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        extra: Vec<(String, String)>,
    },
    /// `p:cmd`: a command to the target (play a medium, a verb, an event).
    #[serde(rename_all = "camelCase")]
    Cmd {
        bhvr: Behavior,
        /// `type`: `evt` / `call` / `verb`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cmd_type: Option<String>,
        /// `cmd`: `playFrom(0.0)`, `togglePause`, `stop`, …
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cmd: Option<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        extra: Vec<(String, String)>,
    },
    /// An element this model does not read (`p:audio`, `p:video`,
    /// `mc:AlternateContent`, …), verbatim.
    Raw { xml: String },
}

impl TimeNode {
    /// The node's common time node (a container's own, a behaviour's
    /// `p:cBhvr/p:cTn`); `None` for a raw node.
    pub fn ctn(&self) -> Option<&CommonTimeNode> {
        match self {
            TimeNode::Par { ctn } | TimeNode::Excl { ctn } | TimeNode::Seq { ctn, .. } => Some(ctn),
            TimeNode::Raw { .. } => None,
            other => other.bhvr().map(|b| &b.ctn),
        }
    }

    pub fn ctn_mut(&mut self) -> Option<&mut CommonTimeNode> {
        match self {
            TimeNode::Par { ctn } | TimeNode::Excl { ctn } | TimeNode::Seq { ctn, .. } => Some(ctn),
            TimeNode::Raw { .. } => None,
            other => other.bhvr_mut().map(|b| &mut b.ctn),
        }
    }

    /// A behaviour's `p:cBhvr`.
    pub fn bhvr(&self) -> Option<&Behavior> {
        match self {
            TimeNode::Set { bhvr, .. }
            | TimeNode::Anim { bhvr, .. }
            | TimeNode::AnimEffect { bhvr, .. }
            | TimeNode::AnimMotion { bhvr, .. }
            | TimeNode::AnimScale { bhvr, .. }
            | TimeNode::AnimRot { bhvr, .. }
            | TimeNode::AnimClr { bhvr, .. }
            | TimeNode::Cmd { bhvr, .. } => Some(bhvr),
            _ => None,
        }
    }

    pub fn bhvr_mut(&mut self) -> Option<&mut Behavior> {
        match self {
            TimeNode::Set { bhvr, .. }
            | TimeNode::Anim { bhvr, .. }
            | TimeNode::AnimEffect { bhvr, .. }
            | TimeNode::AnimMotion { bhvr, .. }
            | TimeNode::AnimScale { bhvr, .. }
            | TimeNode::AnimRot { bhvr, .. }
            | TimeNode::AnimClr { bhvr, .. }
            | TimeNode::Cmd { bhvr, .. } => Some(bhvr),
            _ => None,
        }
    }

    /// Every node of the subtree, this one first (depth first, children
    /// before sub-nodes).
    pub fn walk<'a>(&'a self, f: &mut dyn FnMut(&'a TimeNode)) {
        f(self);
        if let Some(c) = self.container_ctn() {
            for n in c.children.iter().chain(c.sub.iter()) {
                n.walk(f);
            }
        }
    }

    /// Every node of the subtree, mutably.
    pub fn walk_mut(&mut self, f: &mut dyn FnMut(&mut TimeNode)) {
        f(self);
        if let Some(c) = self.container_ctn_mut() {
            for n in c.children.iter_mut().chain(c.sub.iter_mut()) {
                n.walk_mut(f);
            }
        }
    }

    /// The common time node of a container (`par`, `seq`, `excl`).
    pub fn container_ctn(&self) -> Option<&CommonTimeNode> {
        match self {
            TimeNode::Par { ctn } | TimeNode::Excl { ctn } | TimeNode::Seq { ctn, .. } => Some(ctn),
            _ => None,
        }
    }

    pub fn container_ctn_mut(&mut self) -> Option<&mut CommonTimeNode> {
        match self {
            TimeNode::Par { ctn } | TimeNode::Excl { ctn } | TimeNode::Seq { ctn, .. } => Some(ctn),
            _ => None,
        }
    }
}

/// `p:cTn`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommonTimeNode {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset_id: Option<i32>,
    /// `presetClass`: `entr` / `exit` / `emph` / `path` / `verb` /
    /// `mediacall`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset_class: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset_subtype: Option<i32>,
    /// `dur`: ms, or `indefinite`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dur: Option<String>,
    /// `repeatCount`: 1 000ths of a repeat, or `indefinite`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repeat_count: Option<String>,
    /// `repeatDur`: ms, or `indefinite`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repeat_dur: Option<String>,
    /// `spd`, 1 000ths of a percent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spd: Option<i64>,
    /// `accel` / `decel`, 1 000ths of a percent of the duration.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accel: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decel: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_rev: Option<bool>,
    /// `restart`: `always` / `whenNotActive` / `never`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restart: Option<String>,
    /// `fill`: `remove` / `freeze` / `hold` / `transition`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fill: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sync_behavior: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tm_filter: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evt_filter: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub master_rel: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bld_lvl: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grp_id: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after_effect: Option<bool>,
    /// `nodeType`: `tmRoot`, `mainSeq`, `interactiveSeq`, `clickEffect`,
    /// `withEffect`, `afterEffect`, `clickPar`, `withGroup`, `afterGroup`,
    /// …
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_ph: Option<bool>,
    /// Attributes this model does not name (`p14:…`), as written.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub extra: Vec<(String, String)>,
    /// `p:stCondLst` / `p:endCondLst`; `None` when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub st_conds: Option<Vec<Condition>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_conds: Option<Vec<Condition>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_sync: Option<Condition>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub iterate: Option<Iterate>,
    /// `p:childTnLst` (`has_children`: the element is there even when
    /// empty).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<TimeNode>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub has_children: bool,
    /// `p:subTnLst`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sub: Vec<TimeNode>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub has_sub: bool,
}

impl CommonTimeNode {
    /// `dur` in ms; `None` for `indefinite` or when absent.
    pub fn dur_ms(&self) -> Option<f64> {
        self.dur.as_deref().and_then(|d| d.trim().parse().ok())
    }

    /// The delay of the first start condition that is a plain delay (no
    /// event), ms; `None` for `indefinite` or none.
    pub fn delay_ms(&self) -> Option<f64> {
        self.st_conds
            .as_ref()?
            .iter()
            .find(|c| c.evt.is_none() && c.target.is_none())
            .and_then(|c| c.delay.as_deref())
            .and_then(|d| d.trim().parse().ok())
    }
}

/// `p:cond` (in `p:stCondLst`, `p:endCondLst`, `p:prevCondLst`,
/// `p:nextCondLst`) or `p:endSync`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Condition {
    /// `evt`: `onBegin`, `onEnd`, `begin`, `end`, `onClick`, `onDblClick`,
    /// `onMouseOver`, `onMouseOut`, `onNext`, `onPrev`, `onStopAudio`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evt: Option<String>,
    /// `delay`: ms, or `indefinite`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delay: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<CondTarget>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub extra: Vec<(String, String)>,
}

/// What a condition watches.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CondTarget {
    /// `p:tn`: another time node (`val` its id).
    Tn {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        val: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none", rename = "type")]
        tn_type: Option<String>,
    },
    /// `p:rtn`: `first` / `last` / `all`.
    Rtn { val: String },
    /// `p:tgtEl`.
    El { el: TargetEl },
}

/// `p:tgtEl`: what a behaviour acts on.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TargetEl {
    /// `p:sldTgt`: the slide.
    #[default]
    Sld,
    /// `p:spTgt`.
    Sp(SpTarget),
    /// `p:inkTgt`.
    Ink {
        spid: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        item: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        key: Option<String>,
    },
    /// `p:sndTgt` or anything else, verbatim.
    Raw { xml: String },
}

/// `p:spTgt`: a shape, or part of one.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpTarget {
    /// The deck's `spid` (the shape's `cNvPr id`).
    pub spid: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sub: Option<SpSub>,
    /// The page item the shape became (its `Self` id), once imported.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item: Option<String>,
    /// The shape key of that item (`<slide part>#<id>`), once imported.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
}

/// Part of a shape a target names.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SpSub {
    /// `p:bg`: the shape without its text.
    Bg,
    /// `p:txEl/p:pRg`: paragraphs `st..=end` (0-based).
    Paragraphs { st: u32, end: u32 },
    /// `p:txEl/p:charRg`: characters `st..end`.
    Chars { st: u32, end: u32 },
    /// `p:subSp`.
    SubSp { spid: String },
    /// `p:oleChartEl`.
    OleChartEl {
        #[serde(rename = "type")]
        el_type: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        lvl: Option<u32>,
    },
    /// `p:graphicEl` or anything else, verbatim.
    Raw { xml: String },
}

/// `p:cBhvr`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Behavior {
    /// `additive`: `base` / `sum` / `repl` / `mult` / `none`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub additive: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accumulate: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub xfrm_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rctx: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "override")]
    pub override_: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub extra: Vec<(String, String)>,
    pub ctn: CommonTimeNode,
    pub target: TargetEl,
    /// `p:attrNameLst`; `None` when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attr_names: Option<Vec<String>>,
}

/// `p:tav`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimePoint {
    /// `tm`: 1 000ths of a percent of the duration, or `indefinite`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tm: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fmla: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub val: Option<AnimValue>,
}

/// `p:val`, `p:to`, `p:progress`: one of `boolVal`, `intVal`, `fltVal`,
/// `strVal`, `clrVal`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "val", rename_all = "camelCase")]
pub enum AnimValue {
    Bool(bool),
    Int(i64),
    /// As written (`fltVal val="0.5"`).
    Flt(String),
    Str(String),
    Clr(AnimColor),
}

/// A DrawingML colour in an animation (`p:clrVal`, `p:from`, `p:to`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimColor {
    /// The colour element, verbatim (`<a:schemeClr val="accent1"/>`).
    pub xml: String,
}

/// `p:by` of `p:animClr`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "space", rename_all = "camelCase")]
pub enum ColorBy {
    /// `p:rgb`: 1 000ths of a percent.
    Rgb { r: i64, g: i64, b: i64 },
    /// `p:hsl`: hue in 60 000ths of a degree, saturation and lightness in
    /// 1 000ths of a percent.
    Hsl { h: i64, s: i64, l: i64 },
}

/// `p:iterate`: by letter, word or element, with the time between.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Iterate {
    /// `type`: `el` / `wd` / `lt`.
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "type")]
    pub iter_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backwards: Option<bool>,
    /// `p:tmAbs val` (ms).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tm_abs: Option<String>,
    /// `p:tmPct val` (1 000ths of a percent of the duration).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tm_pct: Option<String>,
}

/// One entry of `p:bldLst`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Build {
    /// `p:bldP`: how a shape's text builds.
    #[serde(rename_all = "camelCase")]
    P {
        spid: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        grp_id: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ui_expand: Option<bool>,
        /// `build`: `whole` / `p` / `cust` / `allAtOnce`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        build: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        bld_lvl: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        anim_bg: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        auto_update_anim_bg: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        rev: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        adv_auto: Option<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        extra: Vec<(String, String)>,
        /// Children (`p:tmplLst`), verbatim.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        children: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        item: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        key: Option<String>,
    },
    /// `p:bldDgm`, `p:bldOleChart`, `p:bldGraphic`, verbatim, with the
    /// shape it names.
    Raw {
        xml: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        spid: Option<String>,
    },
}

/// What [`Timing::for_each_sp_target`] calls for each shape target: its
/// `spid`, `item` and `key`.
pub type TargetNames<'a> = dyn FnMut(&mut String, &mut Option<String>, &mut Option<String>) + 'a;

impl Timing {
    /// Every node of every tree, depth first.
    pub fn walk<'a>(&'a self, f: &mut dyn FnMut(&'a TimeNode)) {
        for n in &self.nodes {
            n.walk(f);
        }
    }

    pub fn walk_mut(&mut self, f: &mut dyn FnMut(&mut TimeNode)) {
        for n in &mut self.nodes {
            n.walk_mut(f);
        }
    }

    /// Every shape target, mutably (behaviours, conditions, builds).
    pub fn for_each_sp_target(&mut self, f: &mut TargetNames) {
        fn cond(c: &mut Condition, f: &mut TargetNames) {
            if let Some(CondTarget::El { el }) = &mut c.target {
                target(el, f);
            }
        }
        fn target(t: &mut TargetEl, f: &mut TargetNames) {
            match t {
                TargetEl::Sp(sp) => f(&mut sp.spid, &mut sp.item, &mut sp.key),
                TargetEl::Ink { spid, item, key } => f(spid, item, key),
                _ => {}
            }
        }
        fn ctn(c: &mut CommonTimeNode, f: &mut TargetNames) {
            for list in [&mut c.st_conds, &mut c.end_conds].into_iter().flatten() {
                for x in list {
                    cond(x, f);
                }
            }
            if let Some(x) = &mut c.end_sync {
                cond(x, f);
            }
        }
        // Children are walked by walk_mut; only each node's own parts here.
        self.walk_mut(&mut |n| {
            if let TimeNode::Seq {
                prev_conds,
                next_conds,
                ..
            } = n
            {
                for list in [prev_conds, next_conds].into_iter().flatten() {
                    for x in list {
                        cond(x, f);
                    }
                }
            }
            if let Some(b) = n.bhvr_mut() {
                target(&mut b.target, f);
                ctn(&mut b.ctn, f);
            } else if let Some(c) = n.container_ctn_mut() {
                ctn(c, f);
            }
        });
        for b in self.builds.iter_mut().flatten() {
            if let Build::P {
                spid, item, key, ..
            } = b
            {
                f(spid, item, key);
            }
        }
    }

    /// The timing with the document's names for its shapes taken off (what
    /// the file says): for comparing a document's timing with the deck's.
    pub fn without_document_names(&self) -> Timing {
        let mut t = self.clone();
        t.for_each_sp_target(&mut |_, item, key| {
            *item = None;
            *key = None;
        });
        t
    }

    /// `p:timing` as PresentationML (prefixes `p:` and `a:`, as a slide
    /// part declares them).
    pub fn to_xml(&self) -> String {
        let mut w = String::new();
        w.push_str("<p:timing>");
        if !self.nodes.is_empty() {
            w.push_str("<p:tnLst>");
            for n in &self.nodes {
                write_node(&mut w, n);
            }
            w.push_str("</p:tnLst>");
        }
        if let Some(b) = &self.builds {
            if b.is_empty() {
                w.push_str("<p:bldLst/>");
            } else {
                w.push_str("<p:bldLst>");
                for x in b {
                    write_build(&mut w, x);
                }
                w.push_str("</p:bldLst>");
            }
        }
        for x in &self.extra {
            w.push_str(x);
        }
        w.push_str("</p:timing>");
        w
    }
}

// ------------------------------------------------------------------ writer

/// XML attribute escaping.
pub fn esc(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => o.push_str("&amp;"),
            '<' => o.push_str("&lt;"),
            '>' => o.push_str("&gt;"),
            '"' => o.push_str("&quot;"),
            _ => o.push(c),
        }
    }
    o
}

struct Tag<'a> {
    w: &'a mut String,
    name: &'static str,
}

impl<'a> Tag<'a> {
    fn open(w: &'a mut String, name: &'static str) -> Self {
        w.push('<');
        w.push_str(name);
        Tag { w, name }
    }
    fn attr(&mut self, k: &str, v: impl std::fmt::Display) -> &mut Self {
        self.w.push(' ');
        self.w.push_str(k);
        self.w.push_str("=\"");
        self.w.push_str(&esc(&v.to_string()));
        self.w.push('"');
        self
    }
    fn opt<T: std::fmt::Display>(&mut self, k: &str, v: &Option<T>) -> &mut Self {
        if let Some(v) = v {
            self.attr(k, v);
        }
        self
    }
    fn opt_bool(&mut self, k: &str, v: &Option<bool>) -> &mut Self {
        if let Some(v) = v {
            self.attr(k, if *v { "1" } else { "0" });
        }
        self
    }
    fn extra(&mut self, x: &[(String, String)]) -> &mut Self {
        for (k, v) in x {
            self.attr(k, v);
        }
        self
    }
    /// Close the start tag; `body` writes the content (none: an empty
    /// element).
    fn body(&mut self, body: impl FnOnce(&mut String)) {
        let mut inner = String::new();
        body(&mut inner);
        if inner.is_empty() {
            self.w.push_str("/>");
        } else {
            self.w.push('>');
            self.w.push_str(&inner);
            self.w.push_str("</");
            self.w.push_str(self.name);
            self.w.push('>');
        }
    }
    fn empty(&mut self) {
        self.w.push_str("/>");
    }
}

fn write_node(w: &mut String, n: &TimeNode) {
    match n {
        TimeNode::Par { ctn } => Tag::open(w, "p:par").body(|w| write_ctn(w, ctn)),
        TimeNode::Excl { ctn } => Tag::open(w, "p:excl").body(|w| write_ctn(w, ctn)),
        TimeNode::Seq {
            ctn,
            concurrent,
            prev_ac,
            next_ac,
            prev_conds,
            next_conds,
        } => Tag::open(w, "p:seq")
            .opt_bool("concurrent", concurrent)
            .opt("prevAc", prev_ac)
            .opt("nextAc", next_ac)
            .body(|w| {
                write_ctn(w, ctn);
                write_conds(w, "p:prevCondLst", prev_conds);
                write_conds(w, "p:nextCondLst", next_conds);
            }),
        TimeNode::Set { bhvr, to } => Tag::open(w, "p:set").body(|w| {
            write_bhvr(w, bhvr);
            if let Some(v) = to {
                Tag::open(w, "p:to").body(|w| write_value(w, v));
            }
        }),
        TimeNode::Anim {
            bhvr,
            by,
            from,
            to,
            calcmode,
            value_type,
            points,
            extra,
        } => Tag::open(w, "p:anim")
            .opt("by", by)
            .opt("from", from)
            .opt("to", to)
            .opt("calcmode", calcmode)
            .opt("valueType", value_type)
            .extra(extra)
            .body(|w| {
                write_bhvr(w, bhvr);
                if let Some(points) = points {
                    if points.is_empty() {
                        w.push_str("<p:tavLst/>");
                    } else {
                        Tag::open(w, "p:tavLst").body(|w| {
                            for p in points {
                                Tag::open(w, "p:tav")
                                    .opt("tm", &p.tm)
                                    .opt("fmla", &p.fmla)
                                    .body(|w| {
                                        if let Some(v) = &p.val {
                                            Tag::open(w, "p:val").body(|w| write_value(w, v));
                                        }
                                    });
                            }
                        });
                    }
                }
            }),
        TimeNode::AnimEffect {
            bhvr,
            transition,
            filter,
            pr_lst,
            progress,
            extra,
        } => Tag::open(w, "p:animEffect")
            .opt("transition", transition)
            .opt("filter", filter)
            .opt("prLst", pr_lst)
            .extra(extra)
            .body(|w| {
                write_bhvr(w, bhvr);
                if let Some(v) = progress {
                    Tag::open(w, "p:progress").body(|w| write_value(w, v));
                }
            }),
        TimeNode::AnimMotion {
            bhvr,
            origin,
            path,
            path_edit_mode,
            r_ang,
            pts_types,
            by,
            from,
            to,
            r_ctr,
            extra,
        } => Tag::open(w, "p:animMotion")
            .opt("origin", origin)
            .opt("path", path)
            .opt("pathEditMode", path_edit_mode)
            .opt("rAng", r_ang)
            .opt("ptsTypes", pts_types)
            .extra(extra)
            .body(|w| {
                write_bhvr(w, bhvr);
                write_pair(w, "p:by", "x", "y", by);
                write_pair(w, "p:from", "x", "y", from);
                write_pair(w, "p:to", "x", "y", to);
                write_pair(w, "p:rCtr", "x", "y", r_ctr);
            }),
        TimeNode::AnimScale {
            bhvr,
            zoom_contents,
            by,
            from,
            to,
            extra,
        } => Tag::open(w, "p:animScale")
            .opt_bool("zoomContents", zoom_contents)
            .extra(extra)
            .body(|w| {
                write_bhvr(w, bhvr);
                write_pair(w, "p:by", "x", "y", by);
                write_pair(w, "p:from", "x", "y", from);
                write_pair(w, "p:to", "x", "y", to);
            }),
        TimeNode::AnimRot {
            bhvr,
            by,
            from,
            to,
            extra,
        } => Tag::open(w, "p:animRot")
            .opt("by", by)
            .opt("from", from)
            .opt("to", to)
            .extra(extra)
            .body(|w| write_bhvr(w, bhvr)),
        TimeNode::AnimClr {
            bhvr,
            clr_spc,
            dir,
            by,
            from,
            to,
            extra,
        } => Tag::open(w, "p:animClr")
            .opt("clrSpc", clr_spc)
            .opt("dir", dir)
            .extra(extra)
            .body(|w| {
                write_bhvr(w, bhvr);
                match by {
                    Some(ColorBy::Rgb { r, g, b }) => {
                        w.push_str("<p:by>");
                        Tag::open(w, "p:rgb")
                            .attr("r", r)
                            .attr("g", g)
                            .attr("b", b)
                            .empty();
                        w.push_str("</p:by>");
                    }
                    Some(ColorBy::Hsl { h, s, l }) => {
                        w.push_str("<p:by>");
                        Tag::open(w, "p:hsl")
                            .attr("h", h)
                            .attr("s", s)
                            .attr("l", l)
                            .empty();
                        w.push_str("</p:by>");
                    }
                    None => {}
                }
                if let Some(c) = from {
                    w.push_str("<p:from>");
                    w.push_str(&c.xml);
                    w.push_str("</p:from>");
                }
                if let Some(c) = to {
                    w.push_str("<p:to>");
                    w.push_str(&c.xml);
                    w.push_str("</p:to>");
                }
            }),
        TimeNode::Cmd {
            bhvr,
            cmd_type,
            cmd,
            extra,
        } => Tag::open(w, "p:cmd")
            .opt("type", cmd_type)
            .opt("cmd", cmd)
            .extra(extra)
            .body(|w| write_bhvr(w, bhvr)),
        TimeNode::Raw { xml } => w.push_str(xml),
    }
}

fn write_pair(w: &mut String, name: &'static str, x: &str, y: &str, v: &Option<(i64, i64)>) {
    if let Some((a, b)) = v {
        Tag::open(w, name).attr(x, a).attr(y, b).empty();
    }
}

fn write_value(w: &mut String, v: &AnimValue) {
    match v {
        AnimValue::Bool(b) => {
            Tag::open(w, "p:boolVal")
                .attr("val", if *b { "1" } else { "0" })
                .empty();
        }
        AnimValue::Int(i) => {
            Tag::open(w, "p:intVal").attr("val", i).empty();
        }
        AnimValue::Flt(f) => {
            Tag::open(w, "p:fltVal").attr("val", f).empty();
        }
        AnimValue::Str(s) => {
            Tag::open(w, "p:strVal").attr("val", s).empty();
        }
        AnimValue::Clr(c) => {
            w.push_str("<p:clrVal>");
            w.push_str(&c.xml);
            w.push_str("</p:clrVal>");
        }
    }
}

fn write_ctn(w: &mut String, c: &CommonTimeNode) {
    Tag::open(w, "p:cTn")
        .opt("id", &c.id)
        .opt("presetID", &c.preset_id)
        .opt("presetClass", &c.preset_class)
        .opt("presetSubtype", &c.preset_subtype)
        .opt("dur", &c.dur)
        .opt("repeatCount", &c.repeat_count)
        .opt("repeatDur", &c.repeat_dur)
        .opt("spd", &c.spd)
        .opt("accel", &c.accel)
        .opt("decel", &c.decel)
        .opt_bool("autoRev", &c.auto_rev)
        .opt("restart", &c.restart)
        .opt("fill", &c.fill)
        .opt("syncBehavior", &c.sync_behavior)
        .opt("tmFilter", &c.tm_filter)
        .opt("evtFilter", &c.evt_filter)
        .opt_bool("display", &c.display)
        .opt("masterRel", &c.master_rel)
        .opt("bldLvl", &c.bld_lvl)
        .opt("grpId", &c.grp_id)
        .opt_bool("afterEffect", &c.after_effect)
        .opt("nodeType", &c.node_type)
        .opt_bool("nodePh", &c.node_ph)
        .extra(&c.extra)
        .body(|w| {
            write_conds(w, "p:stCondLst", &c.st_conds);
            write_conds(w, "p:endCondLst", &c.end_conds);
            if let Some(s) = &c.end_sync {
                write_cond(w, "p:endSync", s);
            }
            if let Some(it) = &c.iterate {
                Tag::open(w, "p:iterate")
                    .opt("type", &it.iter_type)
                    .opt_bool("backwards", &it.backwards)
                    .body(|w| {
                        if let Some(v) = &it.tm_abs {
                            Tag::open(w, "p:tmAbs").attr("val", v).empty();
                        }
                        if let Some(v) = &it.tm_pct {
                            Tag::open(w, "p:tmPct").attr("val", v).empty();
                        }
                    });
            }
            if !c.children.is_empty() || c.has_children {
                w.push_str("<p:childTnLst");
                if c.children.is_empty() {
                    w.push_str("/>");
                } else {
                    w.push('>');
                    for n in &c.children {
                        write_node(w, n);
                    }
                    w.push_str("</p:childTnLst>");
                }
            }
            if !c.sub.is_empty() || c.has_sub {
                w.push_str("<p:subTnLst");
                if c.sub.is_empty() {
                    w.push_str("/>");
                } else {
                    w.push('>');
                    for n in &c.sub {
                        write_node(w, n);
                    }
                    w.push_str("</p:subTnLst>");
                }
            }
        });
}

fn write_conds(w: &mut String, name: &'static str, conds: &Option<Vec<Condition>>) {
    let Some(conds) = conds else { return };
    if conds.is_empty() {
        w.push('<');
        w.push_str(name);
        w.push_str("/>");
        return;
    }
    Tag::open(w, name).body(|w| {
        for c in conds {
            write_cond(w, "p:cond", c);
        }
    });
}

fn write_cond(w: &mut String, name: &'static str, c: &Condition) {
    Tag::open(w, name)
        .opt("evt", &c.evt)
        .opt("delay", &c.delay)
        .extra(&c.extra)
        .body(|w| match &c.target {
            Some(CondTarget::Tn { val, tn_type }) => {
                Tag::open(w, "p:tn")
                    .opt("val", val)
                    .opt("type", tn_type)
                    .empty();
            }
            Some(CondTarget::Rtn { val }) => {
                Tag::open(w, "p:rtn").attr("val", val).empty();
            }
            Some(CondTarget::El { el }) => write_target(w, el),
            None => {}
        });
}

fn write_target(w: &mut String, t: &TargetEl) {
    w.push_str("<p:tgtEl>");
    match t {
        TargetEl::Sld => w.push_str("<p:sldTgt/>"),
        TargetEl::Ink { spid, .. } => {
            Tag::open(w, "p:inkTgt").attr("spid", spid).empty();
        }
        TargetEl::Raw { xml } => w.push_str(xml),
        TargetEl::Sp(sp) => {
            Tag::open(w, "p:spTgt")
                .attr("spid", &sp.spid)
                .body(|w| match &sp.sub {
                    None => {}
                    Some(SpSub::Bg) => w.push_str("<p:bg/>"),
                    Some(SpSub::Paragraphs { st, end }) => {
                        w.push_str("<p:txEl>");
                        Tag::open(w, "p:pRg")
                            .attr("st", st)
                            .attr("end", end)
                            .empty();
                        w.push_str("</p:txEl>");
                    }
                    Some(SpSub::Chars { st, end }) => {
                        w.push_str("<p:txEl>");
                        Tag::open(w, "p:charRg")
                            .attr("st", st)
                            .attr("end", end)
                            .empty();
                        w.push_str("</p:txEl>");
                    }
                    Some(SpSub::SubSp { spid }) => {
                        Tag::open(w, "p:subSp").attr("spid", spid).empty();
                    }
                    Some(SpSub::OleChartEl { el_type, lvl }) => {
                        Tag::open(w, "p:oleChartEl")
                            .attr("type", el_type)
                            .opt("lvl", lvl)
                            .empty();
                    }
                    Some(SpSub::Raw { xml }) => w.push_str(xml),
                });
        }
    }
    w.push_str("</p:tgtEl>");
}

fn write_bhvr(w: &mut String, b: &Behavior) {
    Tag::open(w, "p:cBhvr")
        .opt("additive", &b.additive)
        .opt("accumulate", &b.accumulate)
        .opt("xfrmType", &b.xfrm_type)
        .opt("from", &b.from)
        .opt("to", &b.to)
        .opt("by", &b.by)
        .opt("rctx", &b.rctx)
        .opt("override", &b.override_)
        .extra(&b.extra)
        .body(|w| {
            write_ctn(w, &b.ctn);
            write_target(w, &b.target);
            if let Some(names) = &b.attr_names {
                if names.is_empty() {
                    w.push_str("<p:attrNameLst/>");
                } else {
                    w.push_str("<p:attrNameLst>");
                    for n in names {
                        if n.is_empty() {
                            w.push_str("<p:attrName/>");
                        } else {
                            w.push_str("<p:attrName>");
                            w.push_str(&esc(n));
                            w.push_str("</p:attrName>");
                        }
                    }
                    w.push_str("</p:attrNameLst>");
                }
            }
        });
}

fn write_build(w: &mut String, b: &Build) {
    match b {
        Build::P {
            spid,
            grp_id,
            ui_expand,
            build,
            bld_lvl,
            anim_bg,
            auto_update_anim_bg,
            rev,
            adv_auto,
            extra,
            children,
            ..
        } => {
            Tag::open(w, "p:bldP")
                .attr("spid", spid)
                .opt("grpId", grp_id)
                .opt_bool("uiExpand", ui_expand)
                .opt("build", build)
                .opt("bldLvl", bld_lvl)
                .opt_bool("animBg", anim_bg)
                .opt_bool("autoUpdateAnimBg", auto_update_anim_bg)
                .opt_bool("rev", rev)
                .opt("advAuto", adv_auto)
                .extra(extra)
                .body(|w| {
                    for c in children {
                        w.push_str(c);
                    }
                });
        }
        Build::Raw { xml, .. } => w.push_str(xml),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_a_click_effect_as_powerpoint_lays_it_out() {
        let sp = |id: &str| {
            TargetEl::Sp(SpTarget {
                spid: id.into(),
                ..Default::default()
            })
        };
        let t = Timing {
            nodes: vec![TimeNode::Par {
                ctn: CommonTimeNode {
                    id: Some(1),
                    dur: Some("indefinite".into()),
                    node_type: Some("tmRoot".into()),
                    children: vec![TimeNode::Set {
                        bhvr: Behavior {
                            ctn: CommonTimeNode {
                                id: Some(2),
                                dur: Some("1".into()),
                                fill: Some("hold".into()),
                                st_conds: Some(vec![Condition {
                                    delay: Some("0".into()),
                                    ..Default::default()
                                }]),
                                ..Default::default()
                            },
                            target: sp("4"),
                            attr_names: Some(vec!["style.visibility".into()]),
                            ..Default::default()
                        },
                        to: Some(AnimValue::Str("visible".into())),
                    }],
                    ..Default::default()
                },
            }],
            builds: Some(vec![Build::P {
                spid: "4".into(),
                grp_id: Some(0),
                ui_expand: None,
                build: None,
                bld_lvl: None,
                anim_bg: Some(true),
                auto_update_anim_bg: None,
                rev: None,
                adv_auto: None,
                extra: vec![],
                children: vec![],
                item: Some("u1".into()),
                key: None,
            }]),
            extra: vec![],
        };
        assert_eq!(
            t.to_xml(),
            concat!(
                r#"<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" nodeType="tmRoot"><p:childTnLst>"#,
                r#"<p:set><p:cBhvr><p:cTn id="2" dur="1" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn>"#,
                r#"<p:tgtEl><p:spTgt spid="4"/></p:tgtEl><p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr>"#,
                r#"<p:to><p:strVal val="visible"/></p:to></p:set></p:childTnLst></p:cTn></p:par></p:tnLst>"#,
                r#"<p:bldLst><p:bldP spid="4" grpId="0" animBg="1"/></p:bldLst></p:timing>"#
            )
        );
        // The document's names are not the file's.
        assert_eq!(t.without_document_names().builds.unwrap()[0], {
            let mut b = t.builds.as_ref().unwrap()[0].clone();
            if let Build::P { item, .. } = &mut b {
                *item = None;
            }
            b
        });
        // JSON round trip.
        let json = serde_json::to_string(&t).unwrap();
        assert_eq!(serde_json::from_str::<Timing>(&json).unwrap(), t);
    }
}

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

//! A slide's animation timing written back (slide ADR 714).
//!
//! The document's timing names its shapes by the page elements they became
//! (`item`) and their shape keys (`key`); the file names them by the `cNvPr
//! id` each was written under. [`resolve`] turns the one into the other:
//! an effect whose shape is gone is dropped (the whole effect, so no half
//! effect plays), with the build entries and interactive sequences that
//! named it. A timing that resolves to the deck's own keeps its bytes; any
//! other is written as [`Timing::to_xml`] in place of the slide's
//! `p:timing`.

use std::collections::{BTreeMap, BTreeSet};

use pptx_core::anim::{Build, CondTarget, Condition, TargetEl, TimeNode, Timing};

use crate::native::NShape;
use crate::xml;

/// How a slide's shapes are named in the written part.
#[derive(Debug, Default)]
pub struct Names {
    /// The `cNvPr id` shapes were written under, by element `Self` id, group
    /// id and (for shapes made in the editor) shape key.
    pub written: BTreeMap<String, u32>,
    /// The shape key of each element and group of the page, by `Self` id.
    pub elem_key: BTreeMap<String, String>,
    /// Every `cNvPr id` in the written slide part.
    pub present: BTreeSet<u32>,
}

impl Names {
    /// The names of a page's shapes, written into `slide_xml` with the ids
    /// `written` reports.
    pub fn new(cur: &[NShape], written: BTreeMap<String, u32>, slide_xml: &str) -> Names {
        fn walk(s: &[NShape], out: &mut BTreeMap<String, String>) {
            for c in s {
                if let Some(k) = &c.key {
                    for e in &c.elems {
                        out.insert(e.id.clone(), k.clone());
                    }
                    if let Some((g, _)) = &c.group {
                        out.insert(g.clone(), k.clone());
                    }
                }
                walk(&c.children, out);
            }
        }
        let mut elem_key = BTreeMap::new();
        walk(cur, &mut elem_key);
        Names {
            written,
            elem_key,
            present: ids_in(slide_xml),
        }
    }

    /// The id a shape key names in this part: the id it was written under,
    /// else the id the key ends in, when the part has it.
    fn key_id(&self, key: &str) -> Option<u32> {
        if let Some(id) = self.written.get(key) {
            return Some(*id);
        }
        let (_, path) = key.rsplit_once('#')?;
        let last = path.rsplit('/').next()?;
        let id: u32 = last.parse().ok()?;
        self.present.contains(&id).then_some(id)
    }

    /// The written id of a target.
    pub fn id_of(&self, spid: &str, item: Option<&str>, key: Option<&str>) -> Option<u32> {
        if let Some(i) = item {
            if let Some(id) = self.written.get(i) {
                return Some(*id);
            }
            if let Some(id) = self.elem_key.get(i).and_then(|k| self.key_id(k)) {
                return Some(id);
            }
        }
        if let Some(k) = key {
            if let Some(id) = self.key_id(k) {
                return Some(id);
            }
        }
        if item.is_some() || key.is_some() {
            // Named by the document, and no longer on the page.
            return None;
        }
        let id: u32 = spid.trim().parse().ok()?;
        self.present.contains(&id).then_some(id)
    }
}

/// `timing` as the file names its shapes, with what named a shape that is
/// gone dropped: the timing (`None` when nothing is left to play) and one
/// line per dropped effect.
pub fn resolve(timing: &Timing, names: &Names) -> (Option<Timing>, Vec<String>) {
    let mut t = timing.clone();
    let mut gone: BTreeSet<String> = BTreeSet::new();
    t.for_each_sp_target(&mut |spid, item, key| {
        match names.id_of(spid, item.as_deref(), key.as_deref()) {
            Some(id) => *spid = id.to_string(),
            None => {
                // A name no id can take: a shape that is gone.
                *spid = format!("\u{0}{spid}");
                gone.insert(spid.clone());
            }
        }
        *item = None;
        *key = None;
    });
    let mut dropped = Vec::new();
    if !gone.is_empty() {
        for n in &mut t.nodes {
            prune(n, &gone, &mut dropped);
        }
        t.nodes.retain(|n| !names_gone(n, &gone));
        if let Some(b) = &mut t.builds {
            b.retain(|x| match x {
                Build::P { spid, .. } => !gone.contains(spid),
                Build::Raw { spid, .. } => spid.as_ref().is_none_or(|s| !gone.contains(s)),
            });
        }
    }
    // Nothing left that acts on anything: no timing.
    let mut behaviours = 0;
    t.walk(&mut |n| {
        if n.bhvr().is_some() || matches!(n, TimeNode::Raw { .. }) {
            behaviours += 1;
        }
    });
    if behaviours == 0 {
        return (None, dropped);
    }
    (Some(t), dropped)
}

/// Whether node `n` itself (not its children) names a shape that is gone:
/// a behaviour's target, a start or end condition (a trigger), a raw node
/// that mentions its id.
fn names_gone(n: &TimeNode, gone: &BTreeSet<String>) -> bool {
    let cond_gone = |c: &Condition| match &c.target {
        Some(CondTarget::El { el }) => target_gone(el, gone),
        _ => false,
    };
    let ctn_gone = |c: &pptx_core::anim::CommonTimeNode| {
        c.st_conds.iter().flatten().any(cond_gone)
            || c.end_conds.iter().flatten().any(cond_gone)
            || c.end_sync.as_ref().is_some_and(cond_gone)
    };
    match n {
        TimeNode::Raw { xml } => gone
            .iter()
            .any(|g| xml.contains(&format!("spid=\"{}\"", g.trim_start_matches('\u{0}')))),
        TimeNode::Seq {
            ctn,
            prev_conds,
            next_conds,
            ..
        } => {
            ctn_gone(ctn)
                || prev_conds.iter().flatten().any(cond_gone)
                || next_conds.iter().flatten().any(cond_gone)
        }
        other => match other.bhvr() {
            Some(b) => target_gone(&b.target, gone) || ctn_gone(&b.ctn),
            None => other.container_ctn().is_some_and(ctn_gone),
        },
    }
}

fn target_gone(t: &TargetEl, gone: &BTreeSet<String>) -> bool {
    match t {
        TargetEl::Sp(sp) => gone.contains(&sp.spid),
        TargetEl::Ink { spid, .. } => gone.contains(spid),
        _ => false,
    }
}

/// Whether the subtree of `n` names a shape that is gone anywhere.
fn subtree_gone(n: &TimeNode, gone: &BTreeSet<String>) -> bool {
    let mut any = false;
    n.walk(&mut |x| any |= names_gone(x, gone));
    any
}

/// An effect node: what PowerPoint lists as one animation.
fn is_effect(n: &TimeNode) -> bool {
    n.container_ctn().is_some_and(|c| {
        c.preset_class.is_some()
            || matches!(
                c.node_type.as_deref(),
                Some("clickEffect" | "withEffect" | "afterEffect")
            )
    })
}

/// Drop from `n`'s lists every effect (or, outside effects, every node)
/// that names a shape that is gone, then every container left empty.
fn prune(n: &mut TimeNode, gone: &BTreeSet<String>, dropped: &mut Vec<String>) {
    let Some(c) = n.container_ctn_mut() else {
        return;
    };
    for list in [&mut c.children, &mut c.sub] {
        let mut keep = Vec::with_capacity(list.len());
        for mut x in std::mem::take(list) {
            if names_gone(&x, gone) || (is_effect(&x) && subtree_gone(&x, gone)) {
                dropped.push(describe(&x));
                continue;
            }
            prune(&mut x, gone, dropped);
            keep.push(x);
        }
        // A container that held something and holds nothing now goes.
        keep.retain(|x| {
            x.container_ctn().is_none_or(|cc| {
                !(cc.children.is_empty()
                    && cc.sub.is_empty()
                    && (cc.has_children || cc.has_sub)
                    && is_group(x))
            })
        });
        *list = keep;
    }
}

/// A container that only groups effects (a click or with/after group, an
/// interactive sequence, or an effect itself).
fn is_group(n: &TimeNode) -> bool {
    match n {
        TimeNode::Seq { ctn, .. } => ctn.node_type.as_deref() != Some("mainSeq"),
        TimeNode::Par { ctn } | TimeNode::Excl { ctn } => {
            ctn.node_type.as_deref() != Some("tmRoot")
        }
        _ => false,
    }
}

fn describe(n: &TimeNode) -> String {
    match n.container_ctn() {
        Some(c) => match (&c.preset_class, c.preset_id) {
            (Some(class), Some(id)) => format!("an animation ({class} {id})"),
            _ => "an animation".into(),
        },
        None => "an animation step".into(),
    }
}

/// Every `cNvPr id` of a part.
pub fn ids_in(xml: &str) -> BTreeSet<u32> {
    let mut out = BTreeSet::new();
    let mut at = 0;
    while let Some(i) = xml[at..].find("<p:cNvPr ") {
        let s = at + i;
        let e = xml[s..].find('>').map(|e| s + e).unwrap_or(xml.len());
        if let Some(id) = xml::attr(&xml[s..e], "id").and_then(|v| v.parse().ok()) {
            out.insert(id);
        }
        at = e;
    }
    out
}

/// `slide_xml` with its `p:timing` replaced by `timing` (removed for
/// `None`; inserted in schema order when it had none: after `p:cSld`,
/// `p:clrMapOvr` and the transition, before `p:extLst`).
pub fn splice(slide_xml: &str, timing: Option<&Timing>) -> String {
    let Some(root) = xml::root(slide_xml) else {
        return slide_xml.to_string();
    };
    let kids = root.children(slide_xml);
    let body = timing.map(Timing::to_xml).unwrap_or_default();
    if let Some(t) = kids.iter().find(|c| c.name == "p:timing") {
        return xml::splice(slide_xml, t.start, t.end, &body);
    }
    if body.is_empty() {
        return slide_xml.to_string();
    }
    let at = kids
        .iter()
        .filter(|c| {
            matches!(
                c.name.as_str(),
                "p:cSld" | "p:clrMapOvr" | "p:transition" | "mc:AlternateContent"
            )
        })
        .map(|c| c.end)
        .max()
        .unwrap_or(root.inner.1);
    xml::splice(slide_xml, at, at, &body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splices_in_schema_order() {
        let sld = r#"<p:sld><p:cSld/><p:clrMapOvr/><p:extLst/></p:sld>"#;
        let t = Timing::default();
        let out = splice(sld, Some(&t));
        assert_eq!(
            out,
            r#"<p:sld><p:cSld/><p:clrMapOvr/><p:timing></p:timing><p:extLst/></p:sld>"#
        );
        assert_eq!(splice(&out, None), sld);
    }
}

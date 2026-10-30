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

//! Engine ADR 1043 — an appearance through IDML.
//!
//! IDML has one fill and one stroke per page item. The writer therefore
//! BAKES an item with an appearance, on a copy of the model, into what
//! paints the same in InDesign: a `<Group>` in the item's place holding
//! one ordinary item per paint, bottom to top.
//!
//! * The item itself stays as the CARRIER, with its id, geometry, content
//!   and label. It sits where its own fill is drawn and keeps its fill and
//!   its picture; it keeps its stroke too when the stroke is drawn
//!   directly above the fill, and otherwise its stroke becomes an item of
//!   its own at the stroke's place. A text frame's carrier goes on top
//!   (the engine draws a frame's text over all its layers) and gives its
//!   fill and stroke to items of their own.
//! * Each extra layer that paints becomes a rectangle, oval or polygon
//!   with the carrier's outline and that one paint, its opacity and blend
//!   mode as the item's and its effects as the item's effect stack (which
//!   rides the effect-stack label, engine ADR 1008).
//! * The item's opacity, blend mode and drop shadow move to the group,
//!   which applies them to all the paints as the engine does.
//!
//! The carrier's `<Label>` keeps the source under [`KEY`]: the layers, the
//! group's id and the carrier's paint before the bake. Each baked item is
//! labelled [`LAYER_KEY`] with the carrier's id. The reader
//! ([`restore_spread`]) finds the group again, drops it and the baked items
//! and gives the carrier back its appearance and its paint. The `.paged`
//! model part is written from the model itself and keeps the appearance.

use serde::{Deserialize, Serialize};

use super::{drawn_order, AppearanceParts, PaintLayer, PaintLayerKind};
use crate::{DropShadowSetting, FrameRef, Group, GroupTransparency, Rectangle, Spread};

/// The carrier's label key.
pub const KEY: &str = "paged:appearance";
/// A baked item's label key; the value is the carrier's id.
pub const LAYER_KEY: &str = "paged:appearanceLayer";

const NONE_SWATCH: &str = "Swatch/None";

/// What the carrier was before the bake changed it.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Base {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    fill_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    stroke_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    stroke_weight: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    opacity: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    blend_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    drop_shadow: Option<DropShadowSetting>,
}

/// The carrier's label value.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    v: u32,
    group: String,
    layers: Vec<PaintLayer>,
    base: Base,
}

/// The fields of the four kinds the bake reads and writes.
trait Carrier: AppearanceParts {
    fn id(&self) -> Option<&str>;
    fn set_id(&mut self, id: String);
    fn paint_mut(&mut self) -> PaintMut<'_>;
    /// An item painting `layer` with this item's outline, of a kind that
    /// carries no story (a text frame's becomes a rectangle).
    fn derived(&self, layer: &PaintLayer) -> Derived;
}

struct PaintMut<'a> {
    fill_color: &'a mut Option<String>,
    stroke_color: &'a mut Option<String>,
    stroke_weight: &'a mut Option<f32>,
    opacity: &'a mut Option<f32>,
    blend_mode: &'a mut Option<String>,
    drop_shadow: &'a mut Option<DropShadowSetting>,
}

enum Derived {
    Rectangle(Box<crate::Rectangle>),
    Oval(Box<crate::Oval>),
    Polygon(Box<crate::Polygon>),
}

macro_rules! carrier {
    ($ty:ty, $derived:expr) => {
        impl Carrier for $ty {
            fn id(&self) -> Option<&str> {
                self.self_id.as_deref()
            }
            fn set_id(&mut self, id: String) {
                self.self_id = Some(id);
            }
            fn paint_mut(&mut self) -> PaintMut<'_> {
                PaintMut {
                    fill_color: &mut self.fill_color,
                    stroke_color: &mut self.stroke_color,
                    stroke_weight: &mut self.stroke_weight,
                    opacity: &mut self.opacity,
                    blend_mode: &mut self.blend_mode,
                    drop_shadow: &mut self.drop_shadow,
                }
            }
            fn derived(&self, layer: &PaintLayer) -> Derived {
                let f: fn(&$ty, &PaintLayer) -> Derived = $derived;
                f(self, layer)
            }
        }
    };
}

carrier!(crate::Rectangle, |x, l| Derived::Rectangle(Box::new(
    x.layer_item(l)
)));
carrier!(crate::Oval, |x, l| Derived::Oval(Box::new(x.layer_item(l))));
carrier!(crate::Polygon, |x, l| Derived::Polygon(Box::new(
    x.layer_item(l)
)));
carrier!(crate::TextFrame, |x, l| {
    // The frame's outline as a rectangle: its bounds, its path (a
    // non-rectangular text frame keeps its anchors), its corners.
    let mut r = Rectangle::new(x.self_id.clone().unwrap_or_default(), x.bounds);
    r.item_transform = x.item_transform;
    r.anchors = x.anchors.clone();
    r.subpath_starts = x.subpath_starts.clone();
    r.subpath_open = x.subpath_open.clone();
    r.fill_rule = x.fill_rule;
    r.corner_radius = x.corner_radius;
    r.corner_option = x.corner_option.clone();
    r.corners = x.corners;
    r.item_layer = x.item_layer.clone();
    r.visible = x.visible;
    r.locked = x.locked;
    r.nonprinting = x.nonprinting;
    Derived::Rectangle(Box::new(r.layer_item(l)))
});

/// Whether `spread` has an item the writer must bake.
pub fn needs_bake(spread: &Spread) -> bool {
    super::any(spread)
}

/// Bake every item with an appearance on `spread` (see the module docs).
pub fn bake_spread(spread: &mut Spread) {
    if !needs_bake(spread) {
        return;
    }
    let mut taken: std::collections::HashSet<String> = std::collections::HashSet::new();
    collect_ids(spread, &mut taken);
    for i in 0..spread.text_frames.len() {
        if !spread.text_frames[i].appearance.is_empty() {
            bake_one(spread, FrameRef::TextFrame(i), &mut taken);
        }
    }
    for i in 0..spread.rectangles.len() {
        if !spread.rectangles[i].appearance.is_empty() {
            bake_one(spread, FrameRef::Rectangle(i), &mut taken);
        }
    }
    for i in 0..spread.ovals.len() {
        if !spread.ovals[i].appearance.is_empty() {
            bake_one(spread, FrameRef::Oval(i), &mut taken);
        }
    }
    for i in 0..spread.polygons.len() {
        if !spread.polygons[i].appearance.is_empty() {
            bake_one(spread, FrameRef::Polygon(i), &mut taken);
        }
    }
}

fn collect_ids(spread: &Spread, out: &mut std::collections::HashSet<String>) {
    let mut add = |id: &Option<String>| {
        if let Some(id) = id {
            out.insert(id.clone());
        }
    };
    spread.text_frames.iter().for_each(|f| add(&f.self_id));
    spread.rectangles.iter().for_each(|f| add(&f.self_id));
    spread.ovals.iter().for_each(|f| add(&f.self_id));
    spread.polygons.iter().for_each(|f| add(&f.self_id));
    spread.graphic_lines.iter().for_each(|f| add(&f.self_id));
    spread.groups.iter().for_each(|f| add(&f.self_id));
}

fn mint(taken: &mut std::collections::HashSet<String>, base: &str, tag: &str) -> String {
    let mut n = 0usize;
    loop {
        let id = format!("{base}{tag}{n}");
        if taken.insert(id.clone()) {
            return id;
        }
        n += 1;
    }
}

fn with_carrier<R>(
    spread: &mut Spread,
    r: FrameRef,
    f: impl FnOnce(&mut dyn CarrierDyn) -> R,
) -> R {
    match r {
        FrameRef::TextFrame(i) => f(&mut spread.text_frames[i]),
        FrameRef::Rectangle(i) => f(&mut spread.rectangles[i]),
        FrameRef::Oval(i) => f(&mut spread.ovals[i]),
        FrameRef::Polygon(i) => f(&mut spread.polygons[i]),
        _ => unreachable!("only the four appearance-bearing kinds are carriers"),
    }
}

/// The object-safe half of [`Carrier`], for [`with_carrier`].
trait CarrierDyn {
    fn plan(&self) -> Plan;
    fn strip(&mut self, plan: &Plan) -> Base;
    fn restore(&mut self, base: Base, layers: Vec<PaintLayer>);
    fn id_of(&self) -> Option<String>;
    fn layers(&self) -> Vec<PaintLayer>;
}

/// What one carrier bakes to: its pieces bottom to top.
struct Plan {
    pieces: Vec<Piece>,
    /// The carrier keeps its fill (and content).
    keep_fill: bool,
    /// The carrier keeps its stroke.
    keep_stroke: bool,
}

enum Piece {
    Carrier,
    Derived(Derived),
}

impl<T: Carrier + IsText> CarrierDyn for T {
    fn plan(&self) -> Plan {
        let order = drawn_order(self.appearance());
        let text = T::IS_TEXT;
        let mut pieces = Vec::new();
        let mut keep_fill = false;
        let mut keep_stroke = false;
        for (i, l) in order.iter().enumerate() {
            match l.kind {
                PaintLayerKind::FrameFill => {
                    let own = self.own_fill_layer();
                    if text {
                        if l.enabled && own.paints() {
                            pieces.push(Piece::Derived(self.derived(&own)));
                        }
                    } else {
                        keep_fill = l.enabled;
                        pieces.push(Piece::Carrier);
                    }
                }
                PaintLayerKind::FrameStroke => {
                    let after_fill =
                        i > 0 && order[i - 1].kind == PaintLayerKind::FrameFill && !text;
                    if after_fill {
                        keep_stroke = l.enabled;
                    } else {
                        let own = self.own_stroke_layer();
                        if l.enabled && own.paints() {
                            pieces.push(Piece::Derived(self.derived(&own)));
                        }
                    }
                }
                _ => {
                    if l.paints() {
                        pieces.push(Piece::Derived(self.derived(l)));
                    }
                }
            }
        }
        if text {
            pieces.push(Piece::Carrier);
        }
        Plan {
            pieces,
            keep_fill,
            keep_stroke,
        }
    }

    fn strip(&mut self, plan: &Plan) -> Base {
        let p = self.paint_mut();
        let base = Base {
            fill_color: p.fill_color.clone(),
            stroke_color: p.stroke_color.clone(),
            stroke_weight: *p.stroke_weight,
            opacity: p.opacity.take(),
            blend_mode: p.blend_mode.take(),
            drop_shadow: p.drop_shadow.take(),
        };
        if !plan.keep_fill {
            *p.fill_color = Some(NONE_SWATCH.to_string());
        }
        if !plan.keep_stroke {
            *p.stroke_color = Some(NONE_SWATCH.to_string());
        }
        self.appearance_mut().clear();
        base
    }

    fn restore(&mut self, base: Base, layers: Vec<PaintLayer>) {
        let p = self.paint_mut();
        *p.fill_color = base.fill_color;
        *p.stroke_color = base.stroke_color;
        *p.stroke_weight = base.stroke_weight;
        *p.opacity = base.opacity;
        *p.blend_mode = base.blend_mode;
        *p.drop_shadow = base.drop_shadow;
        *self.appearance_mut() = layers;
    }

    fn id_of(&self) -> Option<String> {
        self.id().map(str::to_string)
    }

    fn layers(&self) -> Vec<PaintLayer> {
        self.appearance().to_vec()
    }
}

trait IsText {
    const IS_TEXT: bool;
}
impl IsText for crate::TextFrame {
    const IS_TEXT: bool = true;
}
impl IsText for crate::Rectangle {
    const IS_TEXT: bool = false;
}
impl IsText for crate::Oval {
    const IS_TEXT: bool = false;
}
impl IsText for crate::Polygon {
    const IS_TEXT: bool = false;
}

fn bake_one(spread: &mut Spread, me: FrameRef, taken: &mut std::collections::HashSet<String>) {
    let (plan, id, layers_src) = with_carrier(spread, me, |c| (c.plan(), c.id_of(), c.layers()));
    let Some(id) = id else {
        return;
    };
    let base = with_carrier(spread, me, |c| c.strip(&plan));
    let group_id = mint(taken, &id, "ap");
    let mut members = Vec::with_capacity(plan.pieces.len());
    for piece in plan.pieces {
        match piece {
            Piece::Carrier => members.push(me),
            Piece::Derived(d) => {
                let did = mint(taken, &id, "al");
                let r = match d {
                    Derived::Rectangle(mut x) => {
                        x.set_id(did.clone());
                        spread.rectangles.push(*x);
                        FrameRef::Rectangle(spread.rectangles.len() - 1)
                    }
                    Derived::Oval(mut x) => {
                        x.set_id(did.clone());
                        spread.ovals.push(*x);
                        FrameRef::Oval(spread.ovals.len() - 1)
                    }
                    Derived::Polygon(mut x) => {
                        x.set_id(did.clone());
                        spread.polygons.push(*x);
                        FrameRef::Polygon(spread.polygons.len() - 1)
                    }
                };
                spread
                    .labels
                    .entry(did)
                    .or_default()
                    .push((LAYER_KEY.to_string(), id.clone()));
                members.push(r);
            }
        }
    }
    let record = Record {
        v: 1,
        group: group_id.clone(),
        layers: layers_src,
        base: base.clone(),
    };
    let entries = spread.labels.entry(id).or_default();
    entries.retain(|(k, _)| k != KEY);
    entries.push((
        KEY.to_string(),
        serde_json::to_string(&record).unwrap_or_default(),
    ));
    let group = Group {
        self_id: Some(group_id),
        members,
        transparency: GroupTransparency {
            blend_mode: base.blend_mode,
            opacity: base.opacity,
            drop_shadow: base.drop_shadow,
            ..Default::default()
        },
        item_transform: None,
        corner_radius: None,
        corner_option: None,
        corners: Default::default(),
        clip: false,
    };
    spread.groups.push(group);
    let g = FrameRef::Group(spread.groups.len() - 1);
    // The group takes the carrier's place in whichever list named it.
    let gi = spread.groups.len() - 1;
    let swap = |list: &mut Vec<FrameRef>| {
        if let Some(slot) = list.iter().position(|r| *r == me) {
            list[slot] = g;
        }
    };
    swap(&mut spread.frames_in_order);
    for (i, grp) in spread.groups.iter_mut().enumerate() {
        if i != gi {
            swap(&mut grp.members);
        }
    }
    for children in spread.nested_children.values_mut() {
        swap(children);
    }
}

/// Undo [`bake_spread`] on a spread the reader just parsed: every carrier
/// labelled [`KEY`] whose group is still there gets its appearance and its
/// paint back, and the group and the baked items leave the model. A
/// carrier whose group InDesign dissolved keeps what InDesign wrote (its
/// label is dropped with the rest). Returns how many were restored.
pub fn restore_spread(spread: &mut Spread) -> usize {
    if !spread
        .labels
        .values()
        .any(|v| v.iter().any(|(k, _)| k == KEY || k == LAYER_KEY))
    {
        return 0;
    }
    let mut carriers: Vec<(FrameRef, String, Record)> = Vec::new();
    let mut find = |r: FrameRef, id: &Option<String>| {
        let Some(id) = id else { return };
        let Some(v) = spread
            .labels
            .get(id)
            .and_then(|e| e.iter().find(|(k, _)| k == KEY))
        else {
            return;
        };
        if let Ok(rec) = serde_json::from_str::<Record>(&v.1) {
            carriers.push((r, id.clone(), rec));
        }
    };
    for (i, f) in spread.text_frames.iter().enumerate() {
        find(FrameRef::TextFrame(i), &f.self_id);
    }
    for (i, f) in spread.rectangles.iter().enumerate() {
        find(FrameRef::Rectangle(i), &f.self_id);
    }
    for (i, f) in spread.ovals.iter().enumerate() {
        find(FrameRef::Oval(i), &f.self_id);
    }
    for (i, f) in spread.polygons.iter().enumerate() {
        find(FrameRef::Polygon(i), &f.self_id);
    }
    let mut remove: Vec<FrameRef> = Vec::new();
    let mut restored = 0;
    for (me, id, rec) in carriers {
        let Some(gi) = spread.groups.iter().position(|g| {
            g.self_id.as_deref() == Some(rec.group.as_str()) && g.members.contains(&me)
        }) else {
            continue;
        };
        let g = FrameRef::Group(gi);
        let layered: Vec<FrameRef> = spread.groups[gi]
            .members
            .iter()
            .copied()
            .filter(|r| {
                item_id(spread, *r)
                    .and_then(|mid| spread.labels.get(&mid))
                    .is_some_and(|e| e.iter().any(|(k, v)| k == LAYER_KEY && *v == id))
            })
            .collect();
        for r in &layered {
            if let Some(mid) = item_id(spread, *r) {
                spread.labels.remove(&mid);
            }
        }
        remove.extend(layered);
        remove.push(g);
        spread.groups[gi].members.clear();
        let swap = |list: &mut Vec<FrameRef>| {
            if let Some(slot) = list.iter().position(|r| *r == g) {
                list[slot] = me;
            }
        };
        swap(&mut spread.frames_in_order);
        for grp in spread.groups.iter_mut() {
            swap(&mut grp.members);
        }
        for children in spread.nested_children.values_mut() {
            swap(children);
        }
        with_carrier(spread, me, |c| c.restore(rec.base, rec.layers));
        restored += 1;
    }
    // Every carrier label goes, restored or not: the model holds an
    // appearance once, on the item.
    for v in spread.labels.values_mut() {
        v.retain(|(k, _)| k != KEY);
    }
    spread.labels.retain(|_, v| !v.is_empty());
    remove_refs(spread, &remove);
    restored
}

fn item_id(spread: &Spread, r: FrameRef) -> Option<String> {
    match r {
        FrameRef::TextFrame(i) => spread.text_frames.get(i)?.self_id.clone(),
        FrameRef::Rectangle(i) => spread.rectangles.get(i)?.self_id.clone(),
        FrameRef::Oval(i) => spread.ovals.get(i)?.self_id.clone(),
        FrameRef::Polygon(i) => spread.polygons.get(i)?.self_id.clone(),
        FrameRef::GraphicLine(i) => spread.graphic_lines.get(i)?.self_id.clone(),
        FrameRef::Group(i) => spread.groups.get(i)?.self_id.clone(),
        FrameRef::Instance(_) => None,
    }
}

/// Remove the items `refs` names from their vectors and every list that
/// names them, renumbering what follows them.
fn remove_refs(spread: &mut Spread, refs: &[FrameRef]) {
    if refs.is_empty() {
        return;
    }
    fn keep_map(len: usize, gone: &[usize]) -> Vec<Option<usize>> {
        let mut next = 0;
        (0..len)
            .map(|i| {
                if gone.contains(&i) {
                    None
                } else {
                    next += 1;
                    Some(next - 1)
                }
            })
            .collect()
    }
    let gone = |pick: fn(&FrameRef) -> Option<usize>| -> Vec<usize> {
        refs.iter().filter_map(pick).collect()
    };
    let rect_gone = gone(|r| match r {
        FrameRef::Rectangle(i) => Some(*i),
        _ => None,
    });
    let oval_gone = gone(|r| match r {
        FrameRef::Oval(i) => Some(*i),
        _ => None,
    });
    let poly_gone = gone(|r| match r {
        FrameRef::Polygon(i) => Some(*i),
        _ => None,
    });
    let group_gone = gone(|r| match r {
        FrameRef::Group(i) => Some(*i),
        _ => None,
    });
    let rect_map = keep_map(spread.rectangles.len(), &rect_gone);
    let oval_map = keep_map(spread.ovals.len(), &oval_gone);
    let poly_map = keep_map(spread.polygons.len(), &poly_gone);
    let group_map = keep_map(spread.groups.len(), &group_gone);
    let remap = |r: &FrameRef| -> Option<FrameRef> {
        Some(match *r {
            FrameRef::Rectangle(i) => FrameRef::Rectangle(rect_map.get(i).copied().flatten()?),
            FrameRef::Oval(i) => FrameRef::Oval(oval_map.get(i).copied().flatten()?),
            FrameRef::Polygon(i) => FrameRef::Polygon(poly_map.get(i).copied().flatten()?),
            FrameRef::Group(i) => FrameRef::Group(group_map.get(i).copied().flatten()?),
            other => other,
        })
    };
    let fix = |list: &mut Vec<FrameRef>| {
        *list = list.iter().filter_map(remap).collect();
    };
    fix(&mut spread.frames_in_order);
    for g in spread.groups.iter_mut() {
        fix(&mut g.members);
    }
    for children in spread.nested_children.values_mut() {
        fix(children);
    }
    let mut i = 0;
    spread.rectangles.retain(|_| {
        i += 1;
        !rect_gone.contains(&(i - 1))
    });
    let mut i = 0;
    spread.ovals.retain(|_| {
        i += 1;
        !oval_gone.contains(&(i - 1))
    });
    let mut i = 0;
    spread.polygons.retain(|_| {
        i += 1;
        !poly_gone.contains(&(i - 1))
    });
    let mut i = 0;
    spread.groups.retain(|_| {
        i += 1;
        !group_gone.contains(&(i - 1))
    });
}

/// What the bake of `spread`'s appearances costs in IDML, one line per
/// item: the appearance becomes a group of single-paint items (InDesign
/// shows the paints, and an edit there edits one of them); object effects
/// other than the drop shadow stay on the carrier and no longer reach the
/// extra paints; a layer's blend mode composites inside the group.
pub fn losses(spread: &Spread) -> Vec<String> {
    let mut out = Vec::new();
    let mut line = |kind: &str, id: Option<&str>, layers: &[PaintLayer], effects: bool| {
        if layers.is_empty() {
            return;
        }
        let id = id.unwrap_or("?");
        let fills = layers
            .iter()
            .filter(|l| l.kind == PaintLayerKind::Fill && l.paints())
            .count();
        let strokes = layers
            .iter()
            .filter(|l| l.kind == PaintLayerKind::Stroke && l.paints())
            .count();
        let mut s = format!(
            "the appearance of {kind} `{id}` ({fills} extra fill(s), {strokes} extra stroke(s)) \
             has no IDML form — IDML has one fill and one stroke per item; it is written as a \
             group of single-paint items in its place, with the source kept in the item's \
             `{KEY}` label, which a paged reader turns back into the appearance."
        );
        if effects {
            s.push_str(
                " The item's own effects other than its drop shadow stay on the item and do not \
                 reach the extra paints in InDesign.",
            );
        }
        out.push(s);
    };
    for f in &spread.text_frames {
        line(
            "text frame",
            f.self_id.as_deref(),
            &f.appearance,
            f.effects.is_some() || !f.effect_stack.is_empty(),
        );
    }
    for f in &spread.rectangles {
        line(
            "rectangle",
            f.self_id.as_deref(),
            &f.appearance,
            f.effects.is_some() || !f.effect_stack.is_empty(),
        );
    }
    for f in &spread.ovals {
        line(
            "oval",
            f.self_id.as_deref(),
            &f.appearance,
            f.effects.is_some() || !f.effect_stack.is_empty(),
        );
    }
    for f in &spread.polygons {
        line(
            "polygon",
            f.self_id.as_deref(),
            &f.appearance,
            f.effects.is_some() || !f.effect_stack.is_empty(),
        );
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Bounds, Oval, Rectangle, TextFrame};

    fn b() -> Bounds {
        Bounds {
            top: 0.0,
            left: 0.0,
            bottom: 50.0,
            right: 80.0,
        }
    }

    fn spread_with(rect: Rectangle) -> Spread {
        let mut s = Spread::default();
        s.rectangles.push(Rectangle::new("other", b()));
        s.rectangles.push(rect);
        s.ovals.push(Oval::new("o1", b()));
        s.frames_in_order = vec![
            FrameRef::Rectangle(0),
            FrameRef::Rectangle(1),
            FrameRef::Oval(0),
        ];
        s
    }

    fn layered() -> Rectangle {
        let mut r = Rectangle::new("r1", b());
        r.fill_color = Some("Color/Yellow".into());
        r.stroke_color = Some("Color/Black".into());
        r.stroke_weight = Some(2.0);
        r.opacity = Some(80.0);
        r.blend_mode = Some("Multiply".into());
        let mut red = PaintLayer::fill("Color/Red");
        red.opacity = Some(50.0);
        red.blend_mode = Some("Screen".into());
        r.appearance = vec![
            PaintLayer::frame_fill(),
            red,
            PaintLayer::frame_stroke(),
            PaintLayer::stroke("Color/Blue", 6.0),
        ];
        r
    }

    #[test]
    fn a_bake_is_a_group_in_the_items_place() {
        let mut s = spread_with(layered());
        bake_spread(&mut s);
        assert_eq!(s.groups.len(), 1);
        assert_eq!(s.frames_in_order[1], FrameRef::Group(0));
        let g = &s.groups[0];
        // carrier (fill only), the red fill, the frame's stroke, the blue stroke.
        assert_eq!(g.members.len(), 4);
        assert_eq!(g.members[0], FrameRef::Rectangle(1));
        assert_eq!(g.transparency.opacity, Some(80.0));
        assert_eq!(g.transparency.blend_mode.as_deref(), Some("Multiply"));
        let carrier = &s.rectangles[1];
        assert!(carrier.appearance.is_empty());
        assert_eq!(carrier.fill_color.as_deref(), Some("Color/Yellow"));
        assert_eq!(carrier.stroke_color.as_deref(), Some(NONE_SWATCH));
        assert_eq!(carrier.opacity, None);
        let FrameRef::Rectangle(red) = g.members[1] else {
            panic!()
        };
        let red = &s.rectangles[red];
        assert_eq!(red.fill_color.as_deref(), Some("Color/Red"));
        assert_eq!(red.opacity, Some(50.0));
        assert_eq!(red.blend_mode.as_deref(), Some("Screen"));
        assert_eq!(red.stroke_color.as_deref(), Some(NONE_SWATCH));
        let FrameRef::Rectangle(own) = g.members[2] else {
            panic!()
        };
        assert_eq!(
            s.rectangles[own].stroke_color.as_deref(),
            Some("Color/Black")
        );
        assert_eq!(s.rectangles[own].stroke_weight, Some(2.0));
        let FrameRef::Rectangle(blue) = g.members[3] else {
            panic!()
        };
        assert_eq!(s.rectangles[blue].stroke_weight, Some(6.0));
        assert!(s.labels["r1"].iter().any(|(k, _)| k == KEY));
    }

    #[test]
    fn restore_undoes_the_bake() {
        let mut s = spread_with(layered());
        let before = serde_json::to_string(&s).unwrap();
        bake_spread(&mut s);
        assert_eq!(restore_spread(&mut s), 1);
        assert_eq!(serde_json::to_string(&s).unwrap(), before);
    }

    #[test]
    fn a_text_frames_carrier_goes_on_top() {
        let mut s = Spread::default();
        let mut t = TextFrame::new("t1", Some("st".into()), b());
        t.fill_color = Some("Color/Yellow".into());
        t.appearance = vec![PaintLayer::fill("Color/Red")];
        s.text_frames.push(t);
        s.frames_in_order = vec![FrameRef::TextFrame(0)];
        let before = serde_json::to_string(&s).unwrap();
        bake_spread(&mut s);
        let g = &s.groups[0];
        assert_eq!(g.members.last(), Some(&FrameRef::TextFrame(0)));
        // own fill, red; the frame has no stroke.
        assert_eq!(g.members.len(), 3);
        assert_eq!(s.text_frames[0].fill_color.as_deref(), Some(NONE_SWATCH));
        restore_spread(&mut s);
        assert_eq!(serde_json::to_string(&s).unwrap(), before);
    }

    #[test]
    fn a_dissolved_group_keeps_what_indesign_wrote() {
        let mut s = spread_with(layered());
        bake_spread(&mut s);
        // InDesign ungrouped: the group is gone, its members top level.
        let members = s.groups[0].members.clone();
        s.frames_in_order.splice(1..2, members);
        s.groups.clear();
        assert_eq!(restore_spread(&mut s), 0);
        assert!(s.rectangles[1].appearance.is_empty());
        assert!(!s
            .labels
            .get("r1")
            .is_some_and(|v| v.iter().any(|(k, _)| k == KEY)));
    }

    #[test]
    fn the_loss_line_names_the_label() {
        let s = spread_with(layered());
        let lines = losses(&s);
        assert_eq!(lines.len(), 1);
        assert!(lines[0].contains("`r1`"), "{}", lines[0]);
        assert!(lines[0].contains("1 extra fill(s), 1 extra stroke(s)"));
        assert!(lines[0].contains(KEY));
    }
}

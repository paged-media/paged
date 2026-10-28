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

//! Shape the collected tree into what a designer would have drawn.
//!
//! hayro reports what the PDF did, bracket by bracket: every form XObject
//! opens a clip of its bounding box, every image sits in a transparency
//! group of its own, and Illustrator paints a gradient-filled path as
//! "clip to the path, then paint the shading over the clip's box". This
//! pass undoes those spellings, bottom-up:
//!
//! - a group with nothing in it goes;
//! - a rectangular clip that cuts nothing (everything inside lies within
//!   it) goes;
//! - a clip holding one fill-only rectangle that covers it becomes one
//!   path: the clip's outline with that fill (the gradient-filled path);
//! - a transparency group around one item folds its opacity and blend
//!   mode into the item;
//! - a group that neither clips, fades, blends nor masks dissolves into
//!   its parent.

use kurbo::{Point, Rect};

use super::device::bounds_of_contours;
use super::ir::{Contour, GroupItem, Item, PathItem};

/// The slack (pt) a "within" test allows.
const EPS: f64 = 0.5;

pub(super) fn tidy(items: Vec<Item>, page: Rect) -> Vec<Item> {
    let _ = page;
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        tidy_into(item, &mut out);
    }
    out
}

fn tidy_into(item: Item, out: &mut Vec<Item>) {
    let Item::Group(mut g) = item else {
        out.push(item);
        return;
    };
    g.items = tidy(std::mem::take(&mut g.items), Rect::ZERO);
    if let Some(mask) = g.mask.as_mut() {
        mask.items = tidy(std::mem::take(&mut mask.items), Rect::ZERO);
    }
    if g.items.is_empty() {
        return;
    }
    if let Some(clip) = &g.clip {
        let clip_box = bounds_of_contours(&clip.contours);
        // A rectangle that cuts nothing.
        if is_rect(&clip.contours) {
            if let (Some(cb), Some(ib)) = (clip_box, bounds_of_items(&g.items)) {
                if within(ib, cb) {
                    g.clip = None;
                }
            }
        }
    }
    if let (Some(clip), true) = (&g.clip, plain(&g)) {
        // The clip holds one fill-only rectangle covering it: the clip's
        // outline takes that fill.
        if let [Item::Path(p)] = g.items.as_slice() {
            if p.stroke.is_none() && p.fill.is_some() && is_rect(&p.contours) {
                if let (Some(cb), Some(pb)) = (
                    bounds_of_contours(&clip.contours),
                    bounds_of_contours(&p.contours),
                ) {
                    if within(cb, pb) {
                        out.push(Item::Path(PathItem {
                            contours: clip.contours.clone(),
                            fill: p.fill.clone(),
                            stroke: None,
                            fill_rule: clip.fill_rule,
                            opacity: p.opacity,
                            blend: p.blend,
                        }));
                        return;
                    }
                }
            }
        }
    }
    if g.clip.is_none() && g.mask.is_none() {
        // One item: the group's opacity and blend mode are the item's.
        if g.items.len() == 1 {
            let only = g.items.pop().expect("one item");
            let folded = fold(only, g.opacity, g.blend);
            match folded {
                Ok(item) => {
                    out.push(item);
                    return;
                }
                Err(item) => g.items.push(item),
            }
        }
        if plain(&g) {
            out.append(&mut g.items);
            return;
        }
    }
    out.push(Item::Group(g));
}

/// A group that neither fades nor blends (it may still clip or mask).
fn plain(g: &GroupItem) -> bool {
    (g.opacity - 1.0).abs() < 1e-4 && g.blend.is_none() && !g.knockout
}

/// Fold a group's `opacity` and `blend` into its one `item`; `Err` hands
/// the item back when both blend and the item blend (two modes cannot be
/// one).
#[allow(clippy::result_large_err)]
fn fold(item: Item, opacity: f32, blend: Option<&'static str>) -> Result<Item, Item> {
    let take = |own: &mut Option<&'static str>| -> bool {
        match (blend, *own) {
            (None, _) => true,
            (Some(b), None) => {
                *own = Some(b);
                true
            }
            (Some(_), Some(_)) => false,
        }
    };
    match item {
        Item::Path(mut p) => {
            if !take(&mut p.blend) {
                return Err(Item::Path(p));
            }
            p.opacity *= opacity;
            Ok(Item::Path(p))
        }
        Item::Image(mut i) => {
            if !take(&mut i.blend) {
                return Err(Item::Image(i));
            }
            i.opacity *= opacity;
            Ok(Item::Image(i))
        }
        Item::Text(mut t) => {
            if !take(&mut t.blend) {
                return Err(Item::Text(t));
            }
            t.opacity *= opacity;
            Ok(Item::Text(t))
        }
        Item::Group(mut inner) => {
            if !take(&mut inner.blend) {
                return Err(Item::Group(inner));
            }
            inner.opacity *= opacity;
            Ok(Item::Group(inner))
        }
    }
}

/// `inner` lies within `outer`, give or take [`EPS`].
fn within(inner: Rect, outer: Rect) -> bool {
    inner.x0 >= outer.x0 - EPS
        && inner.y0 >= outer.y0 - EPS
        && inner.x1 <= outer.x1 + EPS
        && inner.y1 <= outer.y1 + EPS
}

/// One closed, axis-aligned rectangle with straight sides.
pub(super) fn is_rect(contours: &[Contour]) -> bool {
    let [c] = contours else {
        return false;
    };
    if !c.closed || c.anchors.len() != 4 {
        return false;
    }
    let straight = c
        .anchors
        .iter()
        .all(|a| a.left == a.anchor && a.right == a.anchor);
    if !straight {
        return false;
    }
    let p: Vec<[f32; 2]> = c.anchors.iter().map(|a| a.anchor).collect();
    let axis = |a: [f32; 2], b: [f32; 2]| (a[0] - b[0]).abs() < 1e-3 || (a[1] - b[1]).abs() < 1e-3;
    (0..4).all(|i| axis(p[i], p[(i + 1) % 4]))
}

/// What `items` paint over, conservatively (handles, stroke widths and
/// image corners included; a mask never widens it).
pub(super) fn bounds_of_items(items: &[Item]) -> Option<Rect> {
    let mut r: Option<Rect> = None;
    let mut add = |b: Rect| {
        r = Some(match r {
            None => b,
            Some(r) => r.union(b),
        })
    };
    for item in items {
        match item {
            Item::Path(p) => {
                if let Some(b) = bounds_of_contours(&p.contours) {
                    let half = p.stroke.as_ref().map_or(0.0, |s| s.width as f64 / 2.0);
                    add(b.inflate(half, half));
                }
            }
            Item::Image(i) => {
                let [a, b, c, d, e, f] = i.transform.map(|v| v as f64);
                let corners = [(0.0, 0.0), (1.0, 0.0), (0.0, 1.0), (1.0, 1.0)]
                    .map(|(x, y)| Point::new(a * x + c * y + e, b * x + d * y + f));
                let mut rr = Rect::from_points(corners[0], corners[0]);
                for p in &corners[1..] {
                    rr = rr.union_pt(*p);
                }
                add(rr);
            }
            Item::Text(t) => {
                let [x, y, w, h] = t.bbox.map(|v| v as f64);
                add(Rect::new(x, y, x + w, y + h));
            }
            Item::Group(g) => {
                let inner = bounds_of_items(&g.items);
                let clip = g
                    .clip
                    .as_ref()
                    .and_then(|c| bounds_of_contours(&c.contours));
                match (inner, clip) {
                    (Some(i), Some(c)) => add(i.intersect(c)),
                    (Some(i), None) => add(i),
                    (None, _) => {}
                }
            }
        }
    }
    r
}

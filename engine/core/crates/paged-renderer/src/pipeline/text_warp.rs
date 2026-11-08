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

//! Text warps (engine ADR 1091): a frame's text, laid out in its unbent box,
//! bent onto its WordArt preset's shape.
//!
//! The pass runs over the display-list commands the frame's text emitted.
//! Every filled or stroked path among them (glyph outlines, underlines,
//! strikethroughs) is flattened in page space, and each point moves through
//! the preset's map (`paged_warp::textshape`): the text's ink box is the
//! map's unit square, the frame's text area its target, so the text fills
//! the shape as WordArt's does. A bent glyph is a path, no longer a glyph:
//! its glyph-run record goes, and a PDF draws it as an outline.

use paged_compose::{DisplayCommand, DisplayList, PathData, PathId, PathSegment, Transform};
use paged_model::text_warp::TextWarp;
use paged_warp::textshape::{text_shape, Box2};

/// How far a flattened outline may stray from the curve, pt.
const FLATTEN_TOLERANCE: f64 = 0.05;

/// The longest straight piece mapped as one, pt.
const MAX_EDGE: f64 = 0.5;

/// A path command's path and transform.
fn path_of(cmd: &DisplayCommand) -> Option<(PathId, Transform)> {
    match cmd {
        DisplayCommand::FillPath {
            path_id, transform, ..
        }
        | DisplayCommand::FillPathBlend {
            path_id, transform, ..
        }
        | DisplayCommand::StrokePath {
            path_id, transform, ..
        } => Some((*path_id, *transform)),
        _ => None,
    }
}

fn set_path(cmd: &mut DisplayCommand, id: PathId) {
    match cmd {
        DisplayCommand::FillPath {
            path_id, transform, ..
        }
        | DisplayCommand::FillPathBlend {
            path_id, transform, ..
        }
        | DisplayCommand::StrokePath {
            path_id, transform, ..
        } => {
            *path_id = id;
            *transform = Transform([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);
        }
        _ => {}
    }
}

/// A flattened contour: its points and whether it is closed.
type Contour = (Vec<(f64, f64)>, bool);

/// `path` through `t`, flattened: one polyline per contour (closed or not).
fn flatten(path: &PathData, t: &Transform) -> Vec<Contour> {
    let [a, b, c, d, e, f] = t.0.map(f64::from);
    let affine = kurbo::Affine::new([a, b, c, d, e, f]);
    let bez = affine * path.to_bez();
    let mut out: Vec<Contour> = Vec::new();
    kurbo::flatten(
        bez.elements().iter().copied(),
        FLATTEN_TOLERANCE,
        |el| match el {
            kurbo::PathEl::MoveTo(p) => out.push((vec![(p.x, p.y)], false)),
            kurbo::PathEl::LineTo(p) => {
                if let Some(last) = out.last_mut() {
                    last.0.push((p.x, p.y));
                }
            }
            kurbo::PathEl::ClosePath => {
                if let Some(last) = out.last_mut() {
                    last.1 = true;
                }
            }
            _ => {}
        },
    );
    out
}

/// Bend the paths of `list.commands[range]` onto `warp`'s shape in `area`
/// (the frame's text area, page pt).
pub(super) fn warp_range(
    list: &mut DisplayList,
    range: std::ops::Range<usize>,
    warp: &TextWarp,
    area: Box2,
) {
    let end = range.end.min(list.commands.len());
    let start = range.start.min(end);
    let mut contours: Vec<(usize, Vec<Contour>, paged_compose::FillRule)> = Vec::new();
    for i in start..end {
        let Some((id, t)) = path_of(&list.commands[i]) else {
            continue;
        };
        let Some(path) = list.paths.get(id) else {
            continue;
        };
        contours.push((i, flatten(path, &t), path.fill_rule));
    }
    // The text's ink box: the map's unit square.
    let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    for (_, cs, _) in &contours {
        for (pts, _) in cs {
            for &(x, y) in pts {
                x0 = x0.min(x);
                y0 = y0.min(y);
                x1 = x1.max(x);
                y1 = y1.max(y);
            }
        }
    }
    let (w, h) = (x1 - x0, y1 - y0);
    if contours.is_empty() || w <= 0.0 || h <= 0.0 || area.w <= 0.0 || area.h <= 0.0 {
        return;
    }
    let Some(shape) = text_shape(&warp.preset, &|n| warp.adjust(n), h / area.h) else {
        return;
    };
    let mut warped = Vec::with_capacity(contours.len());
    for (i, cs, fill_rule) in contours {
        let mut segments = Vec::new();
        for (pts, closed) in cs {
            let mut put = |(x, y): (f64, f64), first: bool| {
                let (mx, my) = shape.map(area, ((x - x0) / w, (y - y0) / h));
                let (x, y) = (mx as f32, my as f32);
                segments.push(if first {
                    PathSegment::MoveTo { x, y }
                } else {
                    PathSegment::LineTo { x, y }
                });
            };
            let mut prev: Option<(f64, f64)> = None;
            let ring = closed.then(|| pts.first().copied()).flatten();
            for &p in pts.iter().chain(ring.iter()) {
                match prev {
                    None => put(p, true),
                    // A straight edge bends under the map: it is cut into
                    // pieces short enough to follow the curve.
                    Some(q) => {
                        let len = ((p.0 - q.0).powi(2) + (p.1 - q.1).powi(2)).sqrt();
                        let n = (len / MAX_EDGE).ceil().clamp(1.0, 256.0) as usize;
                        for k in 1..=n {
                            let f = k as f64 / n as f64;
                            put((q.0 + (p.0 - q.0) * f, q.1 + (p.1 - q.1) * f), false);
                        }
                    }
                }
                prev = Some(p);
            }
            if closed {
                segments.push(PathSegment::Close);
            }
        }
        let id = list.paths.push_anon(PathData {
            segments,
            fill_rule,
        });
        set_path(&mut list.commands[i], id);
        warped.push(i as u32);
    }
    // A bent glyph is no glyph a PDF can set as text.
    if let Some(runs) = list.glyph_runs.as_mut() {
        runs.entries
            .retain(|e| warped.binary_search(&e.command_index).is_err());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use paged_compose::Paint;

    fn rect_list() -> DisplayList {
        let mut list = DisplayList::new();
        let id = list.paths.push_anon(PathData {
            segments: vec![
                PathSegment::MoveTo { x: 0.0, y: 0.0 },
                PathSegment::LineTo { x: 10.0, y: 0.0 },
                PathSegment::LineTo { x: 10.0, y: 2.0 },
                PathSegment::LineTo { x: 0.0, y: 2.0 },
                PathSegment::Close,
            ],
            ..PathData::default()
        });
        list.push(DisplayCommand::FillPath {
            path_id: id,
            paint: Paint::Solid(paged_compose::Color::BLACK),
            transform: Transform([1.0, 0.0, 0.0, 1.0, 5.0, 5.0]),
        });
        list
    }

    fn points(list: &DisplayList) -> Vec<(f32, f32)> {
        let Some((id, t)) = path_of(&list.commands[0]) else {
            return Vec::new();
        };
        assert_eq!(t, Transform([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]));
        list.paths
            .get(id)
            .unwrap()
            .segments
            .iter()
            .filter_map(|s| match *s {
                PathSegment::MoveTo { x, y } | PathSegment::LineTo { x, y } => Some((x, y)),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn the_plain_preset_stretches_the_ink_onto_the_text_area() {
        let mut list = rect_list();
        let warp = TextWarp {
            preset: "textPlain".into(),
            adjusts: Vec::new(),
        };
        let area = Box2 {
            x: 100.0,
            y: 50.0,
            w: 40.0,
            h: 20.0,
        };
        warp_range(&mut list, 0..1, &warp, area);
        let pts = points(&list);
        assert_eq!(pts.first(), Some(&(100.0, 50.0)));
        assert!(pts.contains(&(140.0, 70.0)), "{pts:?}");
    }

    #[test]
    fn an_arch_lifts_the_middle_of_the_text() {
        let mut list = rect_list();
        let warp = TextWarp {
            preset: "textArchUp".into(),
            adjusts: Vec::new(),
        };
        let area = Box2 {
            x: 0.0,
            y: 0.0,
            w: 100.0,
            h: 100.0,
        };
        warp_range(&mut list, 0..1, &warp, area);
        let pts = points(&list);
        // The rectangle's top edge became the arc: its corners are at the
        // sides of the box, half way down; nothing is above the box.
        assert!(pts.iter().all(|p| p.1 >= -1e-3), "{pts:?}");
        assert!((pts[0].0 - 0.0).abs() < 1e-3 && (pts[0].1 - 50.0).abs() < 1e-3);
    }
}

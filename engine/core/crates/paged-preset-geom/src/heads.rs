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
//! Office's line ends as paths (engine ADR 1093, amendment 2): the one head
//! geometry of the model's [`OfficeLineEnd`], which the renderer draws on a
//! line or an open path and paged.doc used before it (DrawingML's
//! `a:headEnd` / `a:tailEnd` map onto it in `dml-geom`). Office sizes a head by the
//! line's width (`sm`, `med`, `lg` for its width and its length, a line
//! under 2 pt taking the heads of a 2 pt line), draws a `stealth` with a
//! notch and an `arrow` as two strokes, and stops the line's stroke inside
//! each head; doc ADR 629 and its amendment 1 measured all of it in
//! PowerPoint's PDF.
//!
//! Anchors are `[x, y, left x, left y, right x, right y]` in points, in the
//! shape's box, the form the module lowerings hand the engine.

use paged_model::{OfficeHeadKind, OfficeHeadSize, OfficeLineEnd};

/// Anchors of one shape: every contour's anchors in order, where each
/// contour starts and whether it is left open (stroked, not filled).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Outline {
    pub anchors: Vec<[f32; 6]>,
    pub starts: Vec<usize>,
    pub open: Vec<bool>,
}

/// One line end (arrow head) of a shape's open outline, in the shape's box:
/// filled in the line's colour, or stroked with the line (`open`, Office's
/// `arrow`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Head {
    pub anchors: Vec<[f32; 6]>,
    pub open: bool,
}

/// Office's arrow head sizes (`sm`, `med`, `lg`) as multiples of the line
/// width.
fn factor(size: OfficeHeadSize) -> f32 {
    match size {
        OfficeHeadSize::Sm => 2.0,
        OfficeHeadSize::Lg => 5.0,
        OfficeHeadSize::Med => 3.0,
    }
}

/// The width Office sizes a line's heads by: a line under 2 pt takes the
/// heads of a 2 pt line (doc ADR 629, amendment 1: PowerPoint's PDF).
fn sizing_width(width_pt: f32) -> f32 {
    width_pt.max(2.0)
}

/// A `stealth` head's notch, back from its tip, in sizing widths: 1, 2
/// and 3 for a `sm`, `med` and `lg` length (2, 3 and 5 long).
fn stealth_notch(len: OfficeHeadSize) -> f32 {
    match len {
        OfficeHeadSize::Sm => 1.0,
        OfficeHeadSize::Lg => 3.0,
        OfficeHeadSize::Med => 2.0,
    }
}

/// An `arrow` head's two strokes: how far across the line each wing's end
/// sits, and how far back from the line's end their meeting point sits,
/// so the outer corner of the mitred stroke lands on the end.
fn arrow_wings(width_pt: f32, we: f32, len: f32, wid: f32) -> (f32, f32) {
    let half = wid / 2.0 + we / 4.0;
    let sin = half / half.hypot(len);
    (half, width_pt / 2.0 / sin.max(1e-3))
}

/// How far the stroke of a line stops short of its end under the line end
/// `e`, along the line (doc ADR 629, amendment 1, from PowerPoint's PDF):
/// half a sizing width short of a `triangle`'s base, at a `stealth`'s
/// notch, at the point an `arrow`'s two strokes meet; a `diamond` and an
/// `oval` sit centred on the end and take none.
pub fn inset(e: &OfficeLineEnd, width_pt: f32) -> f32 {
    let we = sizing_width(width_pt);
    let (len, wid) = (we * factor(e.len), we * factor(e.w));
    match e.kind {
        OfficeHeadKind::Triangle => len - we / 2.0,
        OfficeHeadKind::Stealth => we * stealth_notch(e.len),
        OfficeHeadKind::Arrow => arrow_wings(width_pt, we, len, wid).1,
        OfficeHeadKind::Diamond | OfficeHeadKind::Oval => 0.0,
    }
}

/// `o`'s first open contour, the one [`heads`] finishes, shortened under
/// its heads (doc ADR 629, amendment 1), by the engine's trim along the
/// curve. A contour its two insets take whole is removed.
pub fn cut_under_heads(
    o: &mut Outline,
    head: Option<&OfficeLineEnd>,
    tail: Option<&OfficeLineEnd>,
    width_pt: f32,
) {
    let Some(c) = o.open.iter().position(|open| *open) else {
        return;
    };
    let (a, b) = (
        head.map_or(0.0, |e| inset(e, width_pt)),
        tail.map_or(0.0, |e| inset(e, width_pt)),
    );
    if a <= 0.0 && b <= 0.0 {
        return;
    }
    let start = o.starts[c];
    let end = o.starts.get(c + 1).copied().unwrap_or(o.anchors.len());
    let run: Vec<paged_model::PathAnchor> = o.anchors[start..end]
        .iter()
        .map(|p| paged_model::PathAnchor {
            anchor: (p[0], p[1]),
            left: (p[2], p[3]),
            right: (p[4], p[5]),
        })
        .collect();
    let cut: Vec<[f32; 6]> = paged_geom::trim::trim_run(&run, a, b)
        .unwrap_or_default()
        .iter()
        .map(|p| {
            [
                p.anchor.0, p.anchor.1, p.left.0, p.left.1, p.right.0, p.right.1,
            ]
        })
        .collect();
    let shift = cut.len() as isize - (end - start) as isize;
    let removed = cut.is_empty();
    o.anchors.splice(start..end, cut);
    for s in o.starts.iter_mut().skip(c + 1) {
        *s = (*s as isize + shift) as usize;
    }
    if removed {
        o.starts.remove(c);
        o.open.remove(c);
    }
}

/// The direction a line arrives in at its end `tip`: from the end's handle
/// when the end is curved, else from the neighbouring anchor `next`. A
/// unit vector pointing outward, past the tip.
pub fn outward(tip: (f32, f32), handle: (f32, f32), next: (f32, f32)) -> (f32, f32) {
    let toward = if (handle.0 - tip.0).hypot(handle.1 - tip.1) > 1e-3 {
        handle
    } else {
        next
    };
    let (dx, dy) = (tip.0 - toward.0, tip.1 - toward.1);
    let n = dx.hypot(dy).max(1e-6);
    (dx / n, dy / n)
}

/// Office's head `e` at `tip`, pointing along the unit direction
/// `(dx, dy)` (outward, past the tip), sized by the line's width.
pub fn head_at(e: &OfficeLineEnd, tip: (f32, f32), (dx, dy): (f32, f32), width_pt: f32) -> Head {
    let we = sizing_width(width_pt);
    let (len, wid) = (we * factor(e.len), we * factor(e.w));
    // Along the line (back from the tip) and across it.
    let at = |back: f32, side: f32| (tip.0 - dx * back - dy * side, tip.1 - dy * back + dx * side);
    let corner = |p: (f32, f32)| [p.0, p.1, p.0, p.1, p.0, p.1];
    let (anchors, open): (Vec<[f32; 6]>, bool) = match e.kind {
        OfficeHeadKind::Triangle => (
            [at(0.0, 0.0), at(len, wid / 2.0), at(len, -wid / 2.0)]
                .map(corner)
                .to_vec(),
            false,
        ),
        OfficeHeadKind::Stealth => (
            [
                at(0.0, 0.0),
                at(len, wid / 2.0),
                at(we * stealth_notch(e.len), 0.0),
                at(len, -wid / 2.0),
            ]
            .map(corner)
            .to_vec(),
            false,
        ),
        OfficeHeadKind::Arrow => {
            let (half, back) = arrow_wings(width_pt, we, len, wid);
            (
                [at(back + len, half), at(back, 0.0), at(back + len, -half)]
                    .map(corner)
                    .to_vec(),
                true,
            )
        }
        OfficeHeadKind::Diamond => (
            [
                at(-len / 2.0, 0.0),
                at(0.0, wid / 2.0),
                at(len / 2.0, 0.0),
                at(0.0, -wid / 2.0),
            ]
            .map(corner)
            .to_vec(),
            false,
        ),
        OfficeHeadKind::Oval => {
            // An ellipse about the end point, its axes along and across
            // the line.
            let (a, b) = (len / 2.0, wid / 2.0);
            let pts = [(-a, 0.0), (0.0, b), (a, 0.0), (0.0, -b)];
            let tangents = [(0.0, b), (a, 0.0), (0.0, -b), (-a, 0.0)];
            let anchors = pts
                .iter()
                .zip(tangents)
                .map(|(&(u, v), (tu, tv))| {
                    let p = at(u, v);
                    let l = at(
                        u - paged_geom::KAPPA_F32 * tu,
                        v - paged_geom::KAPPA_F32 * tv,
                    );
                    let r = at(
                        u + paged_geom::KAPPA_F32 * tu,
                        v + paged_geom::KAPPA_F32 * tv,
                    );
                    [p.0, p.1, l.0, l.1, r.0, r.1]
                })
                .collect();
            (anchors, false)
        }
    };
    Head { anchors, open }
}

/// The line ends of the first open contour of `o` (a line, a connector, an
/// arc): `head` at its start, `tail` at its end, sized by the line's width
/// `width_pt`, each pointing along the line. Closed outlines take none, as
/// in Office.
pub fn heads(
    o: &Outline,
    head: Option<&OfficeLineEnd>,
    tail: Option<&OfficeLineEnd>,
    width_pt: f32,
) -> Vec<Head> {
    let mut out = Vec::new();
    let Some(c) = o.open.iter().position(|open| *open) else {
        return out;
    };
    let start = o.starts[c];
    let end = o.starts.get(c + 1).copied().unwrap_or(o.anchors.len());
    if end < start + 2 {
        return out;
    }
    let pt = |a: &[f32; 6]| (a[0], a[1]);
    let first = &o.anchors[start];
    let last = &o.anchors[end - 1];
    let ends = [
        (
            head,
            pt(first),
            outward(pt(first), (first[4], first[5]), pt(&o.anchors[start + 1])),
        ),
        (
            tail,
            pt(last),
            outward(pt(last), (last[2], last[3]), pt(&o.anchors[end - 2])),
        ),
    ];
    for (end, tip, dir) in ends {
        let Some(e) = end else { continue };
        out.push(head_at(e, tip, dir, width_pt));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn end3(kind: &str, w: &str, len: &str) -> OfficeLineEnd {
        let size = |s: &str| match s {
            "sm" => OfficeHeadSize::Sm,
            "lg" => OfficeHeadSize::Lg,
            _ => OfficeHeadSize::Med,
        };
        OfficeLineEnd {
            kind: match kind {
                "triangle" => OfficeHeadKind::Triangle,
                "stealth" => OfficeHeadKind::Stealth,
                "diamond" => OfficeHeadKind::Diamond,
                "oval" => OfficeHeadKind::Oval,
                _ => OfficeHeadKind::Arrow,
            },
            w: size(w),
            len: size(len),
        }
    }

    fn pos(o: &Outline) -> Vec<(f32, f32)> {
        o.anchors.iter().map(|a| (a[0], a[1])).collect()
    }

    /// A straight line from (0, 0) to (`len`, 0).
    fn line(len: f32) -> Outline {
        Outline {
            anchors: vec![[0.0; 6], [len, 0.0, len, 0.0, len, 0.0]],
            starts: vec![0],
            open: vec![true],
        }
    }

    /// A closed square.
    fn square() -> Outline {
        let c = |x: f32, y: f32| [x, y, x, y, x, y];
        Outline {
            anchors: vec![c(0.0, 0.0), c(10.0, 0.0), c(10.0, 10.0), c(0.0, 10.0)],
            starts: vec![0],
            open: vec![false],
        }
    }

    /// Doc ADR 629, amendment 1: where PowerPoint's PDF ends the stroke
    /// of a straight line under each head, back from the line's end.
    #[test]
    fn the_line_stops_where_powerpoint_stops_it() {
        let e = |kind: &str, w: &str, len: &str| end3(kind, w, len);
        let near = |got: f32, want: f32, tol: f32| {
            assert!((got - want).abs() <= tol, "{got} vs {want}");
        };
        // (kind, w, len, line width, measured)
        for (kind, w, len, width, measured, tol) in [
            ("triangle", "med", "med", 1.0, 5.0, 1e-3),
            ("triangle", "med", "med", 4.0, 10.0, 1e-3),
            ("triangle", "med", "med", 10.0, 25.0, 1e-3),
            ("triangle", "med", "med", 0.5, 5.0, 1e-3),
            ("triangle", "med", "med", 2.5, 6.25, 1e-3),
            ("triangle", "sm", "sm", 4.0, 6.0, 1e-3),
            ("triangle", "lg", "lg", 10.0, 45.0, 1e-3),
            ("triangle", "sm", "lg", 6.0, 27.0, 1e-3),
            ("triangle", "lg", "sm", 6.0, 9.0, 1e-3),
            ("stealth", "med", "med", 1.0, 4.0, 1e-3),
            ("stealth", "med", "med", 10.0, 20.0, 1e-3),
            ("stealth", "sm", "sm", 6.0, 6.0, 1e-3),
            ("stealth", "lg", "lg", 6.0, 18.0, 1e-3),
            ("stealth", "sm", "lg", 0.5, 6.0, 1e-3),
            ("diamond", "med", "med", 4.0, 0.0, 0.0),
            ("oval", "med", "med", 4.0, 0.0, 0.0),
            // The `arrow`'s point is fitted: within a tenth of the width.
            ("arrow", "med", "med", 1.0, 0.987, 0.1),
            ("arrow", "med", "med", 10.0, 9.900, 1.0),
            ("arrow", "sm", "sm", 6.0, 5.640, 0.6),
            ("arrow", "lg", "lg", 6.0, 6.180, 0.6),
            ("arrow", "lg", "sm", 6.0, 3.840, 0.6),
            ("arrow", "sm", "sm", 0.5, 0.470, 0.05),
        ] {
            near(inset(&e(kind, w, len), width), measured, tol);
        }
    }

    #[test]
    fn a_line_is_cut_under_its_heads_and_a_closed_outline_is_not() {
        let tri = end3("triangle", "med", "med");
        let mut o = line(100.0);
        cut_under_heads(&mut o, Some(&tri), Some(&tri), 4.0);
        let p = pos(&o);
        assert!(p.len() == 2 && (p[0].0 - 10.0).abs() < 1e-2 && (p[1].0 - 90.0).abs() < 1e-2);
        // Shorter than its two heads: nothing of the stroke is left.
        let mut o = line(15.0);
        cut_under_heads(&mut o, Some(&tri), Some(&tri), 4.0);
        assert!(o.anchors.is_empty() && o.starts.is_empty() && o.open.is_empty());
        let rect = square();
        let mut cut = rect.clone();
        cut_under_heads(&mut cut, Some(&tri), Some(&tri), 4.0);
        assert_eq!(cut, rect);
    }

    #[test]
    fn a_line_takes_a_triangle_at_its_end_and_an_open_arrow_at_its_start() {
        let o = line(100.0);
        let end = |kind: &str| end3(kind, "med", "med");
        let h = heads(&o, Some(&end("arrow")), Some(&end("triangle")), 2.0);
        assert_eq!(h.len(), 2);
        // The open arrow at (0, 0) points left: its strokes meet 1.985 pt
        // in, so their mitred corner is the line's end, and reach 6 pt
        // further, 3.5 pt to either side.
        assert!(h[0].open);
        let wings = pos(&Outline {
            anchors: h[0].anchors.clone(),
            ..Default::default()
        });
        let back = 1.0 / (3.5 / 3.5_f32.hypot(6.0));
        for (got, want) in wings
            .iter()
            .zip([(back + 6.0, -3.5), (back, 0.0), (back + 6.0, 3.5)])
        {
            assert!(
                (got.0 - want.0).abs() < 1e-4 && (got.1 - want.1).abs() < 1e-4,
                "{wings:?}"
            );
        }
        // The triangle's tip is the line's end, its base 6 pt back.
        assert!(!h[1].open);
        assert_eq!(h[1].anchors[0][0], 100.0);
        assert!((h[1].anchors[1][0] - 94.0).abs() < 1e-4);
        // A closed outline takes none.
        let rect = square();
        assert!(heads(&rect, Some(&end("triangle")), None, 1.0).is_empty());
    }
}

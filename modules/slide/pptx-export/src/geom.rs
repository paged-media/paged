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

//! Placement: where a shape sits, as an affine map of its own box, and
//! back to DrawingML's `a:xfrm` (offset, extent, rotation, flips) in its
//! parent's coordinate space; outlines as `a:custGeom`.

use pptx_core::{Xfrm, EMU_PER_PT};

/// `[a, b, c, d, tx, ty]`: x' = a·x + c·y + tx, y' = b·x + d·y + ty.
pub type Affine = [f64; 6];

pub const IDENTITY: Affine = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

pub fn mul(m: &Affine, n: &Affine) -> Affine {
    [
        m[0] * n[0] + m[2] * n[1],
        m[1] * n[0] + m[3] * n[1],
        m[0] * n[2] + m[2] * n[3],
        m[1] * n[2] + m[3] * n[3],
        m[0] * n[4] + m[2] * n[5] + m[4],
        m[1] * n[4] + m[3] * n[5] + m[5],
    ]
}

pub fn apply(m: &Affine, p: (f64, f64)) -> (f64, f64) {
    (
        m[0] * p.0 + m[2] * p.1 + m[4],
        m[1] * p.0 + m[3] * p.1 + m[5],
    )
}

pub fn invert(m: &Affine) -> Option<Affine> {
    let det = m[0] * m[3] - m[1] * m[2];
    if det.abs() < 1e-12 {
        return None;
    }
    let (a, b, c, d) = (m[3] / det, -m[1] / det, -m[2] / det, m[0] / det);
    Some([a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])])
}

pub fn translate(x: f64, y: f64) -> Affine {
    [1.0, 0.0, 0.0, 1.0, x, y]
}

/// Rotation (degrees, clockwise on a y-down page) and flips about the
/// origin, as the resolver composes them.
pub fn orient(rot_deg: f64, flip_h: bool, flip_v: bool) -> Affine {
    let (s, c) = rot_deg.to_radians().sin_cos();
    let r = [c, s, -s, c, 0.0, 0.0];
    let f = [
        if flip_h { -1.0 } else { 1.0 },
        0.0,
        0.0,
        if flip_v { -1.0 } else { 1.0 },
        0.0,
        0.0,
    ];
    mul(&r, &f)
}

/// Two maps equal within `eps` (linear part) and `eps_t` pt (offset).
pub fn near(a: &Affine, b: &Affine, eps: f64, eps_t: f64) -> bool {
    (0..4).all(|i| (a[i] - b[i]).abs() <= eps) && (4..6).all(|i| (a[i] - b[i]).abs() <= eps_t)
}

/// A box placed on the page: `map` takes its own box (0..w, 0..h, pt) to
/// the page, with an orthonormal linear part.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Placed {
    pub map: Affine,
    pub w: f64,
    pub h: f64,
}

impl Placed {
    /// Normalise a map whose linear part may scale: the scale moves into
    /// the box. `None` when it skews (no `a:xfrm` says that).
    pub fn normalised(map: Affine, w: f64, h: f64) -> Option<Placed> {
        let sx = (map[0] * map[0] + map[1] * map[1]).sqrt();
        let sy = (map[2] * map[2] + map[3] * map[3]).sqrt();
        if sx < 1e-9 || sy < 1e-9 {
            return None;
        }
        let dot = (map[0] * map[2] + map[1] * map[3]) / (sx * sy);
        if dot.abs() > 1e-3 {
            return None;
        }
        Some(Placed {
            map: [
                map[0] / sx,
                map[1] / sx,
                map[2] / sy,
                map[3] / sy,
                map[4],
                map[5],
            ],
            w: w * sx,
            h: h * sy,
        })
    }

    pub fn centre(&self) -> (f64, f64) {
        apply(&self.map, (self.w / 2.0, self.h / 2.0))
    }
}

/// A group's child space: child coordinates (pt) → page, the length
/// stretch and the accumulated orientation (the resolver's `Space`).
#[derive(Debug, Clone, Copy)]
pub struct Space {
    pub map: Affine,
    pub scale: (f64, f64),
    pub orient: Affine,
}

impl Space {
    pub const PAGE: Space = Space {
        map: IDENTITY,
        scale: (1.0, 1.0),
        orient: IDENTITY,
    };

    /// Where a box with `x` lands on the page.
    pub fn place(&self, x: &Xfrm) -> Placed {
        let (ox, oy) = (x.off.0 as f64 / EMU_PER_PT, x.off.1 as f64 / EMU_PER_PT);
        let (w, h) = (x.ext.0 as f64 / EMU_PER_PT, x.ext.1 as f64 / EMU_PER_PT);
        let centre = apply(&self.map, (ox + w / 2.0, oy + h / 2.0));
        let (w, h) = (w * self.scale.0, h * self.scale.1);
        let o = mul(
            &self.orient,
            &orient(x.rot as f64 / 60_000.0, x.flip_h, x.flip_v),
        );
        let map = mul(
            &translate(centre.0, centre.1),
            &mul(&o, &translate(-w / 2.0, -h / 2.0)),
        );
        Placed { map, w, h }
    }

    /// The space of a group's children.
    pub fn child(&self, x: &Xfrm) -> Space {
        let p = self.place(x);
        let ext = (x.ext.0 as f64 / EMU_PER_PT, x.ext.1 as f64 / EMU_PER_PT);
        let ch_off = x
            .ch_off
            .map(|o| (o.0 as f64 / EMU_PER_PT, o.1 as f64 / EMU_PER_PT))
            .unwrap_or((0.0, 0.0));
        let ch_ext = x
            .ch_ext
            .map(|e| (e.0 as f64 / EMU_PER_PT, e.1 as f64 / EMU_PER_PT))
            .unwrap_or(ext);
        let sx = if ch_ext.0 > 0.0 { p.w / ch_ext.0 } else { 1.0 };
        let sy = if ch_ext.1 > 0.0 { p.h / ch_ext.1 } else { 1.0 };
        let to_box = [sx, 0.0, 0.0, sy, -ch_off.0 * sx, -ch_off.1 * sy];
        Space {
            map: mul(&p.map, &to_box),
            scale: (sx, sy),
            orient: mul(
                &self.orient,
                &orient(x.rot as f64 / 60_000.0, x.flip_h, x.flip_v),
            ),
        }
    }

    /// The `a:xfrm` (offset, extent, rotation, flips; no child space) that
    /// places a box at `p` in this space. `None` when this space cannot
    /// hold it (it is degenerate).
    pub fn xfrm_of(&self, p: &Placed) -> Option<Xfrm> {
        let inv = invert(&self.map)?;
        let inv_o = invert(&self.orient)?;
        // The box's own orientation within this space.
        let o = mul(&inv_o, &[p.map[0], p.map[1], p.map[2], p.map[3], 0.0, 0.0]);
        let det = o[0] * o[3] - o[1] * o[2];
        let (flip_h, r) = if det < 0.0 {
            // o = R · diag(-1, 1)
            (true, [-o[0], -o[1], o[2], o[3]])
        } else {
            (false, [o[0], o[1], o[2], o[3]])
        };
        let mut rot = r[1].atan2(r[0]).to_degrees();
        if rot < 0.0 {
            rot += 360.0;
        }
        let w = p.w / self.scale.0;
        let h = p.h / self.scale.1;
        let c = apply(&inv, p.centre());
        let emu = |v: f64| (v * EMU_PER_PT).round() as i64;
        let mut rot = (rot * 60_000.0).round() as i32;
        if rot >= 21_600_000 {
            rot -= 21_600_000;
        }
        Some(Xfrm {
            off: (emu(c.0 - w / 2.0), emu(c.1 - h / 2.0)),
            ext: (emu(w).max(0), emu(h).max(0)),
            rot,
            flip_h,
            flip_v: false,
            ch_off: None,
            ch_ext: None,
        })
    }
}

/// Two `a:xfrm`s the same within a rounding EMU or two (a flip pair is
/// a half turn, so both spellings compare equal through their maps).
pub fn same_xfrm(a: &Xfrm, b: &Xfrm) -> bool {
    let close = |x: i64, y: i64| (x - y).abs() <= 2;
    let pa = Space::PAGE.place(a);
    let pb = Space::PAGE.place(b);
    close(a.ext.0, b.ext.0)
        && close(a.ext.1, b.ext.1)
        && near(&pa.map, &pb.map, 1e-4, 0.01)
        && a.ch_off == b.ch_off
        && a.ch_ext == b.ch_ext
}

/// `a:xfrm` (or `p:xfrm` with `prefix` `p`) as XML.
pub fn xfrm_xml(prefix: &str, x: &Xfrm) -> String {
    let mut attrs = String::new();
    if x.rot != 0 {
        attrs.push_str(&format!(r#" rot="{}""#, x.rot));
    }
    if x.flip_h {
        attrs.push_str(r#" flipH="1""#);
    }
    if x.flip_v {
        attrs.push_str(r#" flipV="1""#);
    }
    let mut out = format!(
        r#"<{prefix}:xfrm{attrs}><a:off x="{}" y="{}"/><a:ext cx="{}" cy="{}"/>"#,
        x.off.0, x.off.1, x.ext.0, x.ext.1
    );
    if let (Some(o), Some(e)) = (x.ch_off, x.ch_ext) {
        out.push_str(&format!(
            r#"<a:chOff x="{}" y="{}"/><a:chExt cx="{}" cy="{}"/>"#,
            o.0, o.1, e.0, e.1
        ));
    }
    out.push_str(&format!("</{prefix}:xfrm>"));
    out
}

/// One contour: (anchor, in-handle, out-handle) points, and whether it is
/// closed.
pub type Contour = (Vec<[(f64, f64); 3]>, bool);

/// An outline as `a:custGeom`: `contours` of (anchor, in-handle,
/// out-handle) points in the shape's own box of `w` × `h` pt.
pub fn cust_geom(contours: &[Contour], w: f64, h: f64) -> String {
    let emu = |v: f64| (v * EMU_PER_PT).round() as i64;
    let p = |q: (f64, f64)| format!(r#"<a:pt x="{}" y="{}"/>"#, emu(q.0), emu(q.1));
    let mut path = String::new();
    for (pts, closed) in contours {
        let Some(first) = pts.first() else { continue };
        path.push_str(&format!("<a:moveTo>{}</a:moveTo>", p(first[0])));
        let n = pts.len();
        let segs = if *closed { n } else { n.saturating_sub(1) };
        for i in 0..segs {
            let a = pts[i];
            let b = pts[(i + 1) % n];
            let straight = near_pt(a[2], a[0]) && near_pt(b[1], b[0]);
            if straight {
                path.push_str(&format!("<a:lnTo>{}</a:lnTo>", p(b[0])));
            } else {
                path.push_str(&format!(
                    "<a:cubicBezTo>{}{}{}</a:cubicBezTo>",
                    p(a[2]),
                    p(b[1]),
                    p(b[0])
                ));
            }
        }
        if *closed {
            path.push_str("<a:close/>");
        }
    }
    format!(
        r#"<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="l" t="t" r="r" b="b"/><a:pathLst><a:path w="{}" h="{}">{path}</a:path></a:pathLst></a:custGeom>"#,
        emu(w),
        emu(h)
    )
}

fn near_pt(a: (f64, f64), b: (f64, f64)) -> bool {
    (a.0 - b.0).abs() < 1e-3 && (a.1 - b.1).abs() < 1e-3
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_xfrm_placed_and_read_back_is_itself() {
        for (rot, fh, fv) in [
            (0, false, false),
            (30 * 60_000, false, false),
            (0, true, false),
            (45 * 60_000, true, false),
            (0, false, true),
            (300 * 60_000, false, true),
        ] {
            let x = Xfrm {
                off: (127_000, 254_000),
                ext: (1_270_000, 635_000),
                rot,
                flip_h: fh,
                flip_v: fv,
                ch_off: None,
                ch_ext: None,
            };
            let p = Space::PAGE.place(&x);
            let back = Space::PAGE.xfrm_of(&p).unwrap();
            assert!(same_xfrm(&x, &back), "{x:?} → {back:?}");
        }
    }

    #[test]
    fn a_child_reads_back_in_its_groups_space() {
        let g = Xfrm {
            off: (1_270_000, 1_270_000),
            ext: (2_540_000, 1_270_000),
            rot: 0,
            flip_h: false,
            flip_v: false,
            ch_off: Some((0, 0)),
            ch_ext: Some((1_270_000, 1_270_000)),
        };
        let space = Space::PAGE.child(&g);
        let c = Xfrm {
            off: (127_000, 127_000),
            ext: (254_000, 254_000),
            rot: 0,
            flip_h: false,
            flip_v: false,
            ch_off: None,
            ch_ext: None,
        };
        let p = space.place(&c);
        assert!((p.w - 40.0).abs() < 1e-9 && (p.h - 20.0).abs() < 1e-9);
        let back = space.xfrm_of(&p).unwrap();
        assert!(same_xfrm(&c, &back), "{back:?}");
    }

    #[test]
    fn a_scaling_map_moves_its_scale_into_the_box() {
        let p = Placed::normalised([2.0, 0.0, 0.0, 3.0, 5.0, 7.0], 10.0, 10.0).unwrap();
        assert_eq!((p.w, p.h), (20.0, 30.0));
        assert!(Placed::normalised([1.0, 0.5, 0.0, 1.0, 0.0, 0.0], 1.0, 1.0).is_none());
    }
}

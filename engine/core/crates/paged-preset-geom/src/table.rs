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
//! The preset table `build.rs` compiles from Annex D, in static form, and
//! its conversion to [`CustomGeometry`] on first use.

use crate::{AdjustHandle, ConnectionSite, CustomGeometry, GeomPath, HandleRef, PathCmd};

/// A string of the table: its index in [`STRS`].
type S = u16;

fn st(i: S) -> &'static str {
    STRS[i as usize]
}

/// One preset as the build wrote it.
pub(crate) struct P {
    pub name: S,
    av: &'static [(S, S)],
    gd: &'static [(S, S)],
    paths: &'static [Q],
    ah: &'static [H],
    cxn: &'static [(S, (S, S))],
    rect: Option<[S; 4]>,
}

/// One `a:path`.
struct Q {
    w: Option<i64>,
    h: Option<i64>,
    fill: Option<S>,
    stroke: bool,
    cmds: &'static [C],
}

/// One path command.
enum C {
    M(S, S),
    L(S, S),
    A(S, S, S, S),
    Q([(S, S); 2]),
    B([(S, S); 3]),
    Z,
}

/// A handle reference: the adjust value and its range.
struct R(S, S, S);

/// One adjust handle.
enum H {
    Xy(Option<R>, Option<R>, (S, S)),
    Polar(Option<R>, Option<R>, (S, S)),
}

include!(concat!(env!("OUT_DIR"), "/presets.rs"));

fn own(p: &(S, S)) -> (String, String) {
    (st(p.0).to_string(), st(p.1).to_string())
}

fn r(r: &Option<R>) -> Option<HandleRef> {
    r.as_ref().map(|R(g, lo, hi)| HandleRef {
        guide: st(*g).to_string(),
        min: st(*lo).to_string(),
        max: st(*hi).to_string(),
    })
}

impl P {
    /// The preset's name.
    pub(crate) fn name(&self) -> &'static str {
        st(self.name)
    }

    /// The preset's program and its text rectangle (`l t r b` guides).
    pub(crate) fn definition(&self) -> (CustomGeometry, Option<[String; 4]>) {
        let paths = self
            .paths
            .iter()
            .map(|q| GeomPath {
                w: q.w,
                h: q.h,
                fill: q.fill.map(|f| st(f).to_string()),
                stroke: q.stroke,
                commands: q
                    .cmds
                    .iter()
                    .map(|c| match c {
                        C::M(x, y) => PathCmd::MoveTo(st(*x).to_string(), st(*y).to_string()),
                        C::L(x, y) => PathCmd::LineTo(st(*x).to_string(), st(*y).to_string()),
                        C::A(a, b, c, d) => PathCmd::ArcTo(
                            st(*a).to_string(),
                            st(*b).to_string(),
                            st(*c).to_string(),
                            st(*d).to_string(),
                        ),
                        C::Q(p) => PathCmd::QuadTo(p.each_ref().map(own)),
                        C::B(p) => PathCmd::CubicTo(p.each_ref().map(own)),
                        C::Z => PathCmd::Close,
                    })
                    .collect(),
            })
            .collect();
        let handles = self
            .ah
            .iter()
            .map(|h| match h {
                H::Xy(x, y, pos) => AdjustHandle::Xy {
                    x: r(x),
                    y: r(y),
                    pos: own(pos),
                },
                H::Polar(rr, ang, pos) => AdjustHandle::Polar {
                    r: r(rr),
                    ang: r(ang),
                    pos: own(pos),
                },
            })
            .collect();
        let connections = self
            .cxn
            .iter()
            .map(|(ang, pos)| ConnectionSite {
                ang: st(*ang).to_string(),
                pos: own(pos),
            })
            .collect();
        (
            CustomGeometry {
                adjust: self.av.iter().map(own).collect(),
                guides: self.gd.iter().map(own).collect(),
                paths,
                handles,
                connections,
            },
            self.rect.map(|r| r.map(|v| st(v).to_string())),
        )
    }
}

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

//! gpu↔ref parity and behaviour proofs for `families::stylize` (WP5.2).
//!
//! Each scalar twin mirrors its WGSL module step for step (tap order,
//! clamps, the hash, the scan order and its strict comparisons), so the
//! declared tolerance is the only slack. The parity tests report
//! `unavailable: GPU adapter` without one (PAGED_REQUIRE_GPU=1 fails
//! them); the behaviour proofs run on the twins and need no adapter.
#![allow(non_snake_case)]

use image_conformance::harness::{assert_within, parity_windowed, ParityResult, RefTile};
use image_conformance::Px;
use image_kernels::families::stylize::{
    StylizeExtrudeParams, StylizeSolarizeParams, StylizeTilesParams, StylizeTraceContourParams,
    StylizeWindParams, STYLIZE_EXTRUDE, STYLIZE_SOLARIZE, STYLIZE_TILES, STYLIZE_TRACE_CONTOUR,
    STYLIZE_WIND,
};
use image_kernels::KernelDef;

// ───────────────────────── shared twin helpers ─────────────────────────
// (the pixelate suite uses them too)

pub(crate) fn pcg(v: u32) -> u32 {
    let state = v.wrapping_mul(747_796_405).wrapping_add(2_891_336_453);
    let word = ((state >> ((state >> 28) + 4)) ^ state).wrapping_mul(277_803_737);
    (word >> 22) ^ word
}

pub(crate) fn hash21(x: i32, y: i32, seed: u32) -> f32 {
    let h = pcg((x as u32) ^ pcg((y as u32) ^ pcg(seed)));
    (h >> 8) as f32 * 5.960_464_5e-8
}

/// The image as the module sees it: every pixel, clamped at the edge.
#[derive(Clone, Copy)]
pub(crate) struct Img<'a> {
    pub px: &'a [Px],
    pub w: u32,
    pub h: u32,
}

impl Img<'_> {
    pub fn tap(&self, x: i32, y: i32) -> [f32; 4] {
        let x = x.clamp(0, self.w as i32 - 1) as u32;
        let y = y.clamp(0, self.h as i32 - 1) as u32;
        self.px[(y * self.w + x) as usize].0
    }
}

pub(crate) fn unpremul(c: [f32; 4]) -> [f32; 3] {
    if c[3] == 0.0 {
        [0.0; 3]
    } else {
        [c[0] / c[3], c[1] / c[3], c[2] / c[3]]
    }
}

pub(crate) fn assoc(rgb: [f32; 3], a: f32) -> [f32; 4] {
    [rgb[0] * a, rgb[1] * a, rgb[2] * a, a]
}

/// WGSL `mix(a, b, t)` componentwise.
pub(crate) fn mix4(a: [f32; 4], b: [f32; 4], t: f32) -> [f32; 4] {
    let mut o = [0.0; 4];
    for c in 0..4 {
        o[c] = a[c] * (1.0 - t) + b[c] * t;
    }
    o
}

/// The modules' tail with a full mask: `mix(a, styled, amount)`.
pub(crate) fn finish(a: [f32; 4], styled: [f32; 4], amount: f32) -> Px {
    let r = mix4(a, styled, amount.clamp(0.0, 1.0));
    // mix(a, result, 1) = a·0 + result·1.
    Px(mix4(a, r, 1.0))
}

/// A finite opaque stimulus: ramps, a checker and a hashed component, so
/// thresholds, edges and smears all have something to decide.
pub(crate) fn opaque(w: u32, h: u32) -> RefTile {
    RefTile::from_fn(w, h, |x, y| {
        let n = |c: u32| ((7 * x + 13 * y + 29 * c + 17 * ((x * y) % 11)) % 257) as f32 / 256.0;
        let chk = if (x / 6 + y / 5) % 2 == 0 { 0.8 } else { 0.15 };
        Px([
            0.5 * (x as f32 / w as f32) + 0.5 * n(0),
            0.6 * chk + 0.4 * n(1),
            0.5 * (y as f32 / h as f32) + 0.5 * n(2),
            1.0,
        ])
    })
}

/// The same with alpha in [0.25, 1] (associated).
pub(crate) fn translucent(w: u32, h: u32) -> RefTile {
    let base = opaque(w, h);
    RefTile::from_fn(w, h, |x, y| {
        let c = base.px[(y * w + x) as usize].0;
        let a = 0.25 + 0.75 * (((x * 3 + y * 5) % 16) as f32 / 15.0);
        Px([c[0] * a, c[1] * a, c[2] * a, a])
    })
}

pub(crate) fn require(result: Option<ParityResult>, def: &KernelDef) {
    if let Some(r) = result {
        eprintln!("{}: measured max f16 ULP {}", def.id, r.max_ulp);
        assert_within(r, def);
    }
}

/// Run a twin over a whole image (the module's view), for the behaviour
/// proofs.
pub(crate) fn run_twin<P>(
    img: &RefTile,
    p: &P,
    twin: impl Fn(&[Px], u32, u32, u32, u32, &P) -> Px,
) -> Vec<[f32; 4]> {
    let q = img.quantized_px();
    let mut out = Vec::with_capacity(q.len());
    for y in 0..img.h {
        for x in 0..img.w {
            out.push(twin(&q, img.w, img.h, x, y, p).0);
        }
    }
    out
}

fn img(win: &[Px], w: u32, h: u32) -> Img<'_> {
    Img { px: win, w, h }
}

// ───────────────────────────── solarize ────────────────────────────

fn solarize_ref(win: &[Px], w: u32, h: u32, x: u32, y: u32, p: &StylizeSolarizeParams) -> Px {
    let a = img(win, w, h).tap(x as i32, y as i32);
    let s = unpremul(a);
    let r = s.map(|v| if v > 0.5 { 1.0 - v } else { v });
    finish(a, assoc(r, a[3]), p.amount)
}

#[test]
fn stylize_solarize_parity__feat__image_editor_filters() {
    let p = StylizeSolarizeParams::new(1.0);
    for t in [opaque(48, 40), translucent(48, 40)] {
        require(
            parity_windowed(&STYLIZE_SOLARIZE, solarize_ref, &t, t.w, t.h, &p),
            &STYLIZE_SOLARIZE,
        );
    }
}

#[test]
fn stylize_solarize_folds_the_curve_at_one_half__feat__image_editor_filters() {
    let t = RefTile::from_fn(5, 1, |x, _| {
        let v = [0.0, 0.25, 0.5, 0.75, 1.0][x as usize];
        Px([v, v, v, 1.0])
    });
    let out = run_twin(&t, &StylizeSolarizeParams::new(1.0), solarize_ref);
    let got: Vec<f32> = out.iter().map(|c| c[0]).collect();
    assert_eq!(got, vec![0.0, 0.25, 0.5, 0.25, 0.0]);
}

// ─────────────────────────── trace contour ─────────────────────────

fn trace_contour_ref(
    win: &[Px],
    w: u32,
    h: u32,
    x: u32,
    y: u32,
    p: &StylizeTraceContourParams,
) -> Px {
    let im = img(win, w, h);
    let (x, y) = (x as i32, y as i32);
    let a = im.tap(x, y);
    let v = unpremul(a);
    let lv = p.level;
    let mut line = [1.0f32; 3];
    let ns: Vec<[f32; 3]> = [(-1, 0), (1, 0), (0, -1), (0, 1)]
        .iter()
        .map(|(dx, dy)| unpremul(im.tap(x + dx, y + dy)))
        .collect();
    for c in 0..3 {
        let side = if p.upper != 0 { v[c] >= lv } else { v[c] < lv };
        let across = ns
            .iter()
            .any(|n| if p.upper != 0 { n[c] < lv } else { n[c] >= lv });
        if side && across {
            line[c] = 0.0;
        }
    }
    finish(a, assoc(line, a[3]), p.amount)
}

#[test]
fn stylize_trace_contour_parity__feat__image_editor_filters() {
    for upper in [false, true] {
        let p = StylizeTraceContourParams::new(0.5, upper, 1.0);
        let t = opaque(48, 40);
        require(
            parity_windowed(&STYLIZE_TRACE_CONTOUR, trace_contour_ref, &t, t.w, t.h, &p),
            &STYLIZE_TRACE_CONTOUR,
        );
    }
}

#[test]
fn stylize_trace_contour_outlines_one_side_of_the_level__feat__image_editor_filters() {
    // A vertical step from 0.2 to 0.8 at x = 4.
    let t = RefTile::from_fn(8, 3, |x, _| {
        let v = if x < 4 { 0.2 } else { 0.8 };
        Px([v, v, v, 1.0])
    });
    let row = |upper: bool| -> Vec<f32> {
        let out = run_twin(
            &t,
            &StylizeTraceContourParams::new(0.5, upper, 1.0),
            trace_contour_ref,
        );
        out[8..16].iter().map(|c| c[0]).collect()
    };
    // Lower: the dark pixel beside the step; upper: the light one.
    assert_eq!(row(false), vec![1.0, 1.0, 1.0, 0.0, 1.0, 1.0, 1.0, 1.0]);
    assert_eq!(row(true), vec![1.0, 1.0, 1.0, 1.0, 0.0, 1.0, 1.0, 1.0]);
}

// ──────────────────────────────── wind ─────────────────────────────

fn wind_ref(win: &[Px], w: u32, h: u32, x: u32, y: u32, p: &StylizeWindParams) -> Px {
    let im = img(win, w, h);
    let (x, y) = (x as i32, y as i32);
    let a = im.tap(x, y);
    let gy = p.oy + y;
    let gx = p.ox + x;
    let dir = if p.from_left != 0 { -1 } else { 1 };
    let (mut lmax, mut lmin) = if p.method == 1 {
        (48.0f32, 0.6f32)
    } else {
        (12.0, 0.35)
    };
    let mut hh = hash21(0, gy, p.seed);
    if p.method == 2 {
        let run = (gx as f32 / 16.0).floor() as i32;
        hh = hash21(run, gy, p.seed ^ 2_654_435_769);
        lmax = 20.0;
        lmin = 0.1;
    }
    let len = (lmax * (lmin + (1.0 - lmin) * hh)).floor();
    let mut acc = a;
    for k in 1..=48i32 {
        let kf = k as f32;
        if kf > len {
            break;
        }
        let s = im.tap(x + dir * k, y);
        let mut wt = 1.0 - kf / (len + 1.0);
        if p.method == 1 {
            wt *= wt;
        }
        for c in 0..4 {
            let pull = a[c] + (s[c] - a[c]) * wt;
            if s[c] > a[c] {
                acc[c] = acc[c].max(pull);
            }
        }
    }
    let styled = acc.map(|v| v.clamp(0.0, 1.0));
    finish(a, styled, p.amount)
}

#[test]
fn stylize_wind_parity__feat__image_editor_filters() {
    for (method, left) in [(0, false), (1, true), (2, false)] {
        let p = StylizeWindParams::new(3, -5, 11, method, left, 1.0);
        for t in [opaque(64, 24), translucent(64, 24)] {
            require(
                parity_windowed(&STYLIZE_WIND, wind_ref, &t, t.w, t.h, &p),
                &STYLIZE_WIND,
            );
        }
    }
}

#[test]
fn stylize_wind_streaks_downwind_of_a_light_edge__feat__image_editor_filters() {
    // Dark on the left, light from x = 20: wind from the right streaks the
    // light into the dark (x < 20); wind from the left changes nothing
    // there (its sources are darker).
    let t = RefTile::from_fn(40, 4, |x, _| {
        let v = if x < 20 { 0.1 } else { 0.9 };
        Px([v, v, v, 1.0])
    });
    let streak = |left: bool| {
        let out = run_twin(&t, &StylizeWindParams::new(0, 0, 5, 0, left, 1.0), wind_ref);
        out[18][0]
    };
    assert!(streak(false) > 0.3, "from the right the edge blows left");
    assert_eq!(
        streak(true),
        t.quantized_px()[18].0[0],
        "from the left: no lighter source"
    );
}

// ──────────────────────────────── tiles ────────────────────────────

fn tiles_ref(win: &[Px], w: u32, h: u32, x: u32, y: u32, p: &StylizeTilesParams) -> Px {
    let im = img(win, w, h);
    let (x, y) = (x as i32, y as i32);
    let a = im.tap(x, y);
    let n = p.tiles.clamp(1, 99) as f32;
    let s = (w.min(h) as f32 / n).floor().max(1.0);
    let off_max = p.max_offset.clamp(0.0, 1.0) * s;
    let gp = ((p.ox + x) as f32, (p.oy + y) as f32);
    let ci = ((gp.0 / s).floor() as i32, (gp.1 / s).floor() as i32);
    let mut found = false;
    let mut best_pri = -1.0f32;
    let mut src = (0, 0);
    for j in -1..=1 {
        for i in -1..=1 {
            let c = (ci.0 + i, ci.1 + j);
            let ofs = (
                ((hash21(c.0, c.1, p.seed) * 2.0 - 1.0) * off_max).floor(),
                ((hash21(c.0, c.1, p.seed ^ 3_037_000_493) * 2.0 - 1.0) * off_max).floor(),
            );
            let lo = (c.0 as f32 * s + ofs.0, c.1 as f32 * s + ofs.1);
            let inside = gp.0 >= lo.0 && gp.0 < lo.0 + s && gp.1 >= lo.1 && gp.1 < lo.1 + s;
            let pri = hash21(c.0, c.1, p.seed ^ 1_640_531_527);
            if inside && pri > best_pri {
                found = true;
                best_pri = pri;
                src = (x - ofs.0 as i32, y - ofs.1 as i32);
            }
        }
    }
    let styled = if found {
        im.tap(src.0, src.1)
    } else {
        match p.fill {
            0 => assoc([p.bg_r, p.bg_g, p.bg_b], a[3]),
            1 => assoc([p.fg_r, p.fg_g, p.fg_b], a[3]),
            2 => assoc(unpremul(a).map(|v| 1.0 - v), a[3]),
            _ => a,
        }
    };
    finish(a, styled, p.amount)
}

#[test]
fn stylize_tiles_parity__feat__image_editor_filters() {
    for fill in 0..4 {
        let p = StylizeTilesParams::new(
            2,
            1,
            9,
            5,
            0.25,
            fill,
            [1.0, 0.0, 0.0],
            [0.0, 0.0, 1.0],
            1.0,
        );
        let t = translucent(48, 40);
        require(
            parity_windowed(&STYLIZE_TILES, tiles_ref, &t, t.w, t.h, &p),
            &STYLIZE_TILES,
        );
    }
}

#[test]
fn stylize_tiles_moves_whole_tiles_and_fills_the_gaps__feat__image_editor_filters() {
    let t = opaque(60, 60);
    let q = t.quantized_px();
    let p = StylizeTilesParams::new(0, 0, 3, 6, 0.2, 0, [0.0; 3], [1.0, 0.0, 1.0], 1.0);
    let out = run_twin(&t, &p, tiles_ref);
    let gaps = out.iter().filter(|c| **c == [1.0, 0.0, 1.0, 1.0]).count();
    assert!(gaps > 0, "an offset leaves gaps showing the background");
    // Every non-gap pixel is SOME source pixel (tiles move, never blend).
    assert!(out
        .iter()
        .filter(|c| **c != [1.0, 0.0, 1.0, 1.0])
        .all(|c| q.iter().any(|s| s.0 == *c)));
    // Offset 0: every pixel stays.
    let still = run_twin(
        &t,
        &StylizeTilesParams::new(0, 0, 3, 6, 0.0, 0, [0.0; 3], [1.0; 3], 1.0),
        tiles_ref,
    );
    assert!(still.iter().zip(&q).all(|(o, s)| *o == s.0));
}

// ─────────────────────────────── extrude ───────────────────────────

fn luma(c: [f32; 3]) -> f32 {
    c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722
}

fn extrude_ref(win: &[Px], w: u32, h: u32, x: u32, y: u32, p: &StylizeExtrudeParams) -> Px {
    let im = img(win, w, h);
    let (xi, yi) = (x as i32, y as i32);
    let a = im.tap(xi, yi);
    let s = p.size_px.clamp(2.0, 255.0);
    let o = (p.ox as f32, p.oy as f32);
    let cell_colour = |c: (i32, i32)| {
        let cc = ((c.0 as f32 + 0.5) * s - o.0, (c.1 as f32 + 0.5) * s - o.1);
        im.tap(cc.0.floor() as i32, cc.1.floor() as i32)
    };
    let cell_height = |c: (i32, i32)| {
        let dep = p.depth.clamp(1.0, 255.0) / 255.0;
        if p.level_based != 0 {
            luma(unpremul(cell_colour(c))) * dep
        } else {
            hash21(c.0, c.1, p.seed) * dep
        }
    };
    let incomplete = |c: (i32, i32)| {
        let lo = (c.0 as f32 * s - o.0, c.1 as f32 * s - o.1);
        lo.0 < 0.0 || lo.1 < 0.0 || lo.0 + s > w as f32 || lo.1 + s > h as f32
    };
    let pp = (xi as f32 + 0.5, yi as f32 + 0.5);
    let gp = (pp.0 + o.0, pp.1 + o.1);
    let ci = ((gp.0 / s).floor() as i32, (gp.1 / s).floor() as i32);
    let mut styled;
    if p.pyramids != 0 {
        let hgt = cell_height(ci);
        let col = cell_colour(ci);
        let q = (gp.0 / s - ci.0 as f32 - 0.5, gp.1 / s - ci.1 as f32 - 0.5);
        let shade = if q.0.abs() >= q.1.abs() {
            if q.0 > 0.0 {
                1.0 - 0.45 * hgt
            } else {
                1.0 + 0.25 * hgt
            }
        } else if q.1 > 0.0 {
            1.0 - 0.6 * hgt
        } else {
            1.0 + 0.4 * hgt
        };
        styled = [
            (col[0] * shade).clamp(0.0, col[3]),
            (col[1] * shade).clamp(0.0, col[3]),
            (col[2] * shade).clamp(0.0, col[3]),
            col[3],
        ];
        if p.mask_incomplete != 0 && incomplete(ci) {
            styled = a;
        }
    } else {
        let centre = (w as f32 * 0.5, h as f32 * 0.5);
        let mut best_h = -1.0f32;
        let mut best_t = 0.0f32;
        let mut best_axis = 0;
        let mut best_d = (0.0f32, 0.0f32);
        let mut best_c = ci;
        for j in -2..=2 {
            for i in -2..=2 {
                let c = (ci.0 + i, ci.1 + j);
                let hgt = cell_height(c);
                let lo = (c.0 as f32 * s - o.0, c.1 as f32 * s - o.1);
                let dd = (
                    ((lo.0 + 0.5 * s) - centre.0) * (hgt * 0.35),
                    ((lo.1 + 0.5 * s) - centre.1) * (hgt * 0.35),
                );
                let mut t0 = 0.0f32;
                let mut t1 = 1.0f32;
                let mut axis = 0;
                for k in 0..2 {
                    let (pk, lk, dk) = if k == 0 {
                        (pp.0, lo.0, dd.0)
                    } else {
                        (pp.1, lo.1, dd.1)
                    };
                    if dk.abs() < 1e-6 {
                        if pk < lk || pk >= lk + s {
                            t0 = 2.0;
                        }
                    } else {
                        let ta = (pk - (lk + s)) / dk;
                        let tb = (pk - lk) / dk;
                        t0 = t0.max(ta.min(tb));
                        let th = ta.max(tb);
                        if th < t1 {
                            t1 = th;
                            axis = k + 1;
                        }
                    }
                }
                if t0 <= t1 && hgt > best_h {
                    best_h = hgt;
                    best_t = t1;
                    best_axis = axis;
                    best_d = dd;
                    best_c = c;
                }
            }
        }
        let col = cell_colour(best_c);
        if best_axis == 0 || best_t >= 1.0 {
            styled = if p.solid_front != 0 {
                col
            } else {
                let q = (pp.0 - best_d.0, pp.1 - best_d.1);
                im.tap(q.0.floor() as i32, q.1.floor() as i32)
            };
        } else {
            let shade = if best_axis == 1 {
                if best_d.0 > 0.0 {
                    0.85
                } else {
                    0.6
                }
            } else if best_d.1 < 0.0 {
                0.5
            } else {
                0.75
            };
            styled = [col[0] * shade, col[1] * shade, col[2] * shade, col[3]];
        }
        if p.mask_incomplete != 0 && incomplete(best_c) {
            styled = a;
        }
    }
    finish(a, styled.map(|v| v.clamp(0.0, 1.0)), p.amount)
}

#[test]
fn stylize_extrude_parity__feat__image_editor_filters() {
    for (pyr, level, solid, mask) in [
        (false, false, false, false),
        (false, true, true, false),
        (true, false, false, true),
        (true, true, false, false),
    ] {
        let p = StylizeExtrudeParams::new(0, 0, 4, pyr, 8.0, 60.0, level, solid, mask, 1.0);
        let t = opaque(48, 40);
        require(
            parity_windowed(&STYLIZE_EXTRUDE, extrude_ref, &t, t.w, t.h, &p),
            &STYLIZE_EXTRUDE,
        );
    }
}

#[test]
fn stylize_extrude_pyramids_shade_four_faces__feat__image_editor_filters() {
    // A flat grey image: every pyramid shows at most four shades, and the
    // top face is lighter than the bottom one.
    let t = RefTile::from_fn(32, 32, |_, _| Px([0.5, 0.5, 0.5, 1.0]));
    let p = StylizeExtrudeParams::new(0, 0, 1, true, 16.0, 255.0, true, false, false, 1.0);
    let out = run_twin(&t, &p, extrude_ref);
    let top = out[(2 * 32 + 8) as usize][0];
    let bottom = out[(13 * 32 + 8) as usize][0];
    assert!(top > 0.5 && bottom < 0.5, "top {top}, bottom {bottom}");
    let mut shades: Vec<u32> = out.iter().map(|c| c[0].to_bits()).collect();
    shades.sort_unstable();
    shades.dedup();
    assert!(shades.len() <= 4, "{} shades", shades.len());
}

#[test]
fn stylize_extrude_blocks_keep_a_flat_image_flat_on_the_fronts__feat__image_editor_filters() {
    // Solid fronts of a flat image show the cell colour; sides are darker.
    let t = RefTile::from_fn(40, 40, |_, _| Px([0.6, 0.6, 0.6, 1.0]));
    let p = StylizeExtrudeParams::new(0, 0, 2, false, 8.0, 200.0, false, true, false, 1.0);
    let out = run_twin(&t, &p, extrude_ref);
    let q = t.quantized_px()[0].0[0];
    assert!(out.iter().all(|c| c[0] <= q + 1e-6));
    assert!(out.iter().any(|c| c[0] == q));
    assert!(out.iter().any(|c| c[0] < q * 0.9), "a side shows somewhere");
}

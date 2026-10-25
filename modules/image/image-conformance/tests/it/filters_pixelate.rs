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

//! gpu↔ref parity and behaviour proofs for `families::pixelate` (WP5.2).
//!
//! Each scalar twin mirrors its WGSL module step for step; the helpers
//! (hash, tap, the module tail) are the stylize suite's. Facet has no
//! kernel of its own (it is `gallery.kuwahara` at radius 2), so it is
//! proved where that kernel is.
#![allow(non_snake_case)]

use crate::filters_stylize::{
    assoc, finish, hash21, opaque, require, run_twin, translucent, unpremul, Img,
};
use image_conformance::harness::{parity_windowed, RefTile};
use image_conformance::Px;
use image_kernels::families::pixelate::{
    PixelateColorHalftoneParams, PixelateCrystallizeParams, PixelateMezzotintParams,
    PixelatePointillizeParams, PIXELATE_COLOR_HALFTONE, PIXELATE_CRYSTALLIZE, PIXELATE_MEZZOTINT,
    PIXELATE_POINTILLIZE,
};

fn img(win: &[Px], w: u32, h: u32) -> Img<'_> {
    Img { px: win, w, h }
}

// ───────────────────────────── crystallize ─────────────────────────

fn crystallize_ref(
    win: &[Px],
    w: u32,
    h: u32,
    x: u32,
    y: u32,
    p: &PixelateCrystallizeParams,
) -> Px {
    let im = img(win, w, h);
    let a = im.tap(x as i32, y as i32);
    let s = p.cell_px.clamp(3.0, 300.0);
    let o = (p.ox as f32, p.oy as f32);
    let gp = (x as f32 + 0.5 + o.0, y as f32 + 0.5 + o.1);
    let lp = (gp.0 / s, gp.1 / s);
    let li = (lp.0.floor(), lp.1.floor());
    let mut d1 = 1.0e9f32;
    let mut best = lp;
    for j in -1..=1 {
        for i in -1..=1 {
            let c = (li.0 + i as f32, li.1 + j as f32);
            let jx = hash21(c.0 as i32, c.1 as i32, p.seed);
            let jy = hash21(c.0 as i32, c.1 as i32, p.seed ^ 3_037_000_493);
            let site = (c.0 + jx, c.1 + jy);
            let dv = (lp.0 - site.0, lp.1 - site.1);
            let dd = dv.0 * dv.0 + dv.1 * dv.1;
            if dd < d1 {
                d1 = dd;
                best = site;
            }
        }
    }
    let sp = (best.0 * s - o.0, best.1 * s - o.1);
    finish(
        a,
        im.tap(sp.0.floor() as i32, sp.1.floor() as i32),
        p.amount,
    )
}

#[test]
fn pixelate_crystallize_parity__feat__image_editor_filters() {
    for (cell, seed) in [(8.0, 3), (13.0, 77)] {
        let p = PixelateCrystallizeParams::new(5, -3, seed, cell, 1.0);
        let t = translucent(48, 40);
        require(
            parity_windowed(&PIXELATE_CRYSTALLIZE, crystallize_ref, &t, t.w, t.h, &p),
            &PIXELATE_CRYSTALLIZE,
        );
    }
}

#[test]
fn pixelate_crystallize_makes_flat_cells_of_source_colours__feat__image_editor_filters() {
    let t = opaque(64, 64);
    let q = t.quantized_px();
    let out = run_twin(
        &t,
        &PixelateCrystallizeParams::new(0, 0, 9, 10.0, 1.0),
        crystallize_ref,
    );
    let mut colours: Vec<[u32; 4]> = out.iter().map(|c| c.map(f32::to_bits)).collect();
    colours.sort_unstable();
    colours.dedup();
    // About one colour per cell (6.4² ≈ 41 cells, a few partial ones).
    assert!(colours.len() < 80, "{} colours", colours.len());
    assert!(out.iter().all(|c| q.iter().any(|s| s.0 == *c)));
}

// ───────────────────────────── pointillize ─────────────────────────

fn pointillize_ref(
    win: &[Px],
    w: u32,
    h: u32,
    x: u32,
    y: u32,
    p: &PixelatePointillizeParams,
) -> Px {
    let im = img(win, w, h);
    let a = im.tap(x as i32, y as i32);
    let s = p.cell_px.clamp(3.0, 300.0);
    let o = (p.ox as f32, p.oy as f32);
    let gp = (x as f32 + 0.5 + o.0, y as f32 + 0.5 + o.1);
    let lp = (gp.0 / s, gp.1 / s);
    let li = (lp.0.floor(), lp.1.floor());
    let mut best_cov = 0.0f32;
    let mut best = lp;
    for j in -1..=1 {
        for i in -1..=1 {
            let c = (li.0 + i as f32, li.1 + j as f32);
            let (cx, cy) = (c.0 as i32, c.1 as i32);
            let site = (
                c.0 + hash21(cx, cy, p.seed),
                c.1 + hash21(cx, cy, p.seed ^ 3_037_000_493),
            );
            let rad = 0.55 + 0.2 * hash21(cx, cy, p.seed ^ 1_640_531_527);
            let dv = ((lp.0 - site.0) * s, (lp.1 - site.1) * s);
            let dist = (dv.0 * dv.0 + dv.1 * dv.1).sqrt();
            let cov = (rad * s - dist + 0.5).clamp(0.0, 1.0);
            if cov > best_cov {
                best_cov = cov;
                best = site;
            }
        }
    }
    let sp = (best.0 * s - o.0, best.1 * s - o.1);
    let dot = im.tap(sp.0.floor() as i32, sp.1.floor() as i32);
    let bg = assoc([p.bg_r, p.bg_g, p.bg_b], a[3]);
    let mut styled = [0.0; 4];
    for c in 0..4 {
        styled[c] = bg[c] * (1.0 - best_cov) + dot[c] * best_cov;
    }
    finish(a, styled, p.amount)
}

#[test]
fn pixelate_pointillize_parity__feat__image_editor_filters() {
    for (cell, seed) in [(9.0, 2), (16.0, 41)] {
        let p = PixelatePointillizeParams::new(1, 2, seed, cell, [1.0, 1.0, 0.9], 1.0);
        let t = translucent(48, 40);
        require(
            parity_windowed(&PIXELATE_POINTILLIZE, pointillize_ref, &t, t.w, t.h, &p),
            &PIXELATE_POINTILLIZE,
        );
    }
}

#[test]
fn pixelate_pointillize_shows_the_background_between_dots__feat__image_editor_filters() {
    let t = RefTile::from_fn(64, 64, |_, _| Px([0.0, 0.0, 0.0, 1.0]));
    let p = PixelatePointillizeParams::new(0, 0, 5, 12.0, [1.0, 1.0, 1.0], 1.0);
    let out = run_twin(&t, &p, pointillize_ref);
    let bg = out.iter().filter(|c| c[0] == 1.0).count();
    let dots = out.iter().filter(|c| c[0] == 0.0).count();
    assert!(bg > 64 && dots > 64 * 20, "bg {bg}, dots {dots}");
}

// ────────────────────────────── mezzotint ──────────────────────────

fn fdiv(a: i32, b: i32) -> i32 {
    (a as f32 / b as f32).floor() as i32
}

fn screen(kind: u32, gx: i32, gy: i32, seed: u32) -> f32 {
    match kind {
        0 => return hash21(gx, gy, seed),
        1 => return hash21(fdiv(gx, 2), fdiv(gy, 2), seed),
        2 => {
            return 0.5
                * (hash21(gx, gy, seed) + hash21(fdiv(gx, 2), fdiv(gy, 2), seed ^ 2_246_822_519))
        }
        3 => return hash21(fdiv(gx, 4), fdiv(gy, 4), seed),
        _ => {}
    }
    let len = match kind {
        5 | 8 => 8,
        6 | 9 => 16,
        _ => 4,
    };
    let (u, v) = if kind >= 7 {
        (gx + gy, gx - gy)
    } else {
        (gx, gy)
    };
    let sh = (hash21(0, v, seed ^ 3_266_489_917) * len as f32).floor() as i32;
    hash21(fdiv(u + sh, len), v, seed)
}

fn mezzotint_ref(win: &[Px], w: u32, h: u32, x: u32, y: u32, p: &PixelateMezzotintParams) -> Px {
    let a = img(win, w, h).tap(x as i32, y as i32);
    let v = unpremul(a);
    let (gx, gy) = (p.ox + x as i32, p.oy + y as i32);
    let n = [
        screen(p.kind, gx, gy, p.seed ^ 2_654_435_769),
        screen(p.kind, gx, gy, p.seed ^ 1_013_904_242),
        screen(p.kind, gx, gy, p.seed ^ 3_668_340_011),
    ];
    let on = [0, 1, 2].map(|c| if v[c] > n[c] { 1.0 } else { 0.0 });
    finish(a, assoc(on, a[3]), p.amount)
}

#[test]
fn pixelate_mezzotint_parity_every_kind__feat__image_editor_filters() {
    for kind in 0..10 {
        let p = PixelateMezzotintParams::new(-4, 6, 13, kind, 1.0);
        let t = opaque(48, 40);
        require(
            parity_windowed(&PIXELATE_MEZZOTINT, mezzotint_ref, &t, t.w, t.h, &p),
            &PIXELATE_MEZZOTINT,
        );
    }
}

#[test]
fn pixelate_mezzotint_is_binary_and_keeps_tone_on_average__feat__image_editor_filters() {
    let t = RefTile::from_fn(96, 96, |_, _| Px([0.25, 0.5, 0.75, 1.0]));
    for kind in [0, 3, 5, 9] {
        let out = run_twin(
            &t,
            &PixelateMezzotintParams::new(0, 0, 3, kind, 1.0),
            mezzotint_ref,
        );
        assert!(out
            .iter()
            .all(|c| c[..3].iter().all(|v| *v == 0.0 || *v == 1.0)));
        for (c, want) in [0.25f32, 0.5, 0.75].iter().enumerate() {
            let mean = out.iter().map(|p| p[c]).sum::<f32>() / out.len() as f32;
            assert!(
                (mean - want).abs() < 0.08,
                "kind {kind} ch {c}: mean {mean}"
            );
        }
    }
}

// ──────────────────────────── color halftone ───────────────────────

fn sample_straight(im: Img<'_>, p: (f32, f32)) -> [f32; 3] {
    let q = (p.0 - 0.5, p.1 - 0.5);
    let f0 = (q.0.floor(), q.1.floor());
    let f = (q.0 - f0.0, q.1 - f0.1);
    let i = (f0.0 as i32, f0.1 as i32);
    let c00 = im.tap(i.0, i.1);
    let c10 = im.tap(i.0 + 1, i.1);
    let c01 = im.tap(i.0, i.1 + 1);
    let c11 = im.tap(i.0 + 1, i.1 + 1);
    let mut c = [0.0f32; 4];
    for k in 0..4 {
        let top = c00[k] + (c10[k] - c00[k]) * f.0;
        let bot = c01[k] + (c11[k] - c01[k]) * f.0;
        c[k] = top + (bot - top) * f.1;
    }
    if c[3] <= 0.0 {
        return [0.0; 3];
    }
    [0, 1, 2].map(|k| (c[k] / c[3]).clamp(0.0, 1.0))
}

fn channel_cov(
    im: Img<'_>,
    p: &PixelateColorHalftoneParams,
    gp: (f32, f32),
    deg: f32,
    ch: usize,
    r_max: f32,
) -> f32 {
    let th = deg * 0.017_453_292;
    let (sn, cs) = th.sin_cos();
    let cell = 2.0 * r_max;
    let u = (cs * gp.0 + sn * gp.1, cs * gp.1 - sn * gp.0);
    let idx = ((u.0 / cell).floor(), (u.1 / cell).floor());
    let o = (p.ox as f32, p.oy as f32);
    let mut best = 0.0f32;
    for j in -1..=1 {
        for i in -1..=1 {
            let uc = (
                (idx.0 + i as f32 + 0.5) * cell,
                (idx.1 + j as f32 + 0.5) * cell,
            );
            let pc = (cs * uc.0 - sn * uc.1 - o.0, sn * uc.0 + cs * uc.1 - o.1);
            let v = sample_straight(im, pc)[ch];
            let rad = r_max * (2.0 * v).sqrt();
            let dv = (u.0 - uc.0, u.1 - uc.1);
            let dist = (dv.0 * dv.0 + dv.1 * dv.1).sqrt();
            best = best.max((rad - dist + 0.5).clamp(0.0, 1.0));
        }
    }
    best
}

fn color_halftone_ref(
    win: &[Px],
    w: u32,
    h: u32,
    x: u32,
    y: u32,
    p: &PixelateColorHalftoneParams,
) -> Px {
    let im = img(win, w, h);
    let a = im.tap(x as i32, y as i32);
    let r_max = p.max_radius.clamp(4.0, 127.0);
    let gp = (x as f32 + 0.5 + p.ox as f32, y as f32 + 0.5 + p.oy as f32);
    let cov = [
        channel_cov(im, p, gp, p.angle1, 0, r_max),
        channel_cov(im, p, gp, p.angle2, 1, r_max),
        channel_cov(im, p, gp, p.angle3, 2, r_max),
    ];
    finish(a, assoc(cov, a[3]), p.amount)
}

#[test]
fn pixelate_color_halftone_parity__feat__image_editor_filters() {
    for (r, angles) in [
        (4.0, [108.0, 162.0, 90.0, 45.0]),
        (7.0, [0.0, 30.0, 75.0, 45.0]),
    ] {
        let p = PixelateColorHalftoneParams::new(0, 0, r, angles, 1.0);
        for t in [opaque(48, 40), translucent(48, 40)] {
            require(
                parity_windowed(
                    &PIXELATE_COLOR_HALFTONE,
                    color_halftone_ref,
                    &t,
                    t.w,
                    t.h,
                    &p,
                ),
                &PIXELATE_COLOR_HALFTONE,
            );
        }
    }
}

#[test]
fn pixelate_color_halftone_dot_area_follows_the_value__feat__image_editor_filters() {
    // A constant field: the screen's ink coverage tracks the channel value
    // (≈ π·2v/4 of each cell below closure), and a full channel closes it.
    let t = RefTile::from_fn(96, 96, |_, _| Px([0.2, 0.4, 1.0, 1.0]));
    let p = PixelateColorHalftoneParams::new(0, 0, 6.0, [0.0, 45.0, 90.0, 0.0], 1.0);
    let out = run_twin(&t, &p, color_halftone_ref);
    let mean = |c: usize| out.iter().map(|p| p[c]).sum::<f32>() / out.len() as f32;
    let (r, g, b) = (mean(0), mean(1), mean(2));
    assert!(r < g && g < b, "{r} {g} {b}");
    assert!((r - std::f32::consts::PI * 0.4 / 4.0).abs() < 0.08, "r {r}");
    assert!(b > 0.99, "a full channel closes the screen: {b}");
}

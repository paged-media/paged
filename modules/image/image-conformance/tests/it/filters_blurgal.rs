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

//! gpu↔ref parity and behaviour proofs for `families::blurgal` (WP5.2).
//! The scalar twins below mirror each WGSL module step for step — the
//! Vogel disc schedule (turn-fraction angles), the bilinear tap, the
//! smoothstep, the Shepard weights, the line and arc integrations — so
//! the declared tolerance is the only slack. Behaviour proofs run on the
//! twins (no adapter needed) and pin what each blur is FOR: the sharp
//! regions stay sharp, the blurred ones lose variance.
//!
//! The parity tests report `unavailable: GPU adapter` without a device
//! (and fail under `PAGED_REQUIRE_GPU=1`), never a silent pass.
#![allow(non_snake_case)]

use image_conformance::harness::{assert_within, parity_windowed, RefTile};
use image_conformance::Px;
use image_kernels::families::blurgal::{
    BlurFieldParams, BlurIrisParams, BlurPathParams, BlurSpinParams, BlurTiltShiftParams,
    BLUR_FIELD, BLUR_IRIS, BLUR_MAX_PX, BLUR_PATH, BLUR_SPIN, BLUR_TILT_SHIFT, DISC_MAX_TAPS,
};
use image_kernels::KernelDef;

/// Shared scalar mirrors of the module helpers (gallery_ext's twins use
/// them too).
pub(crate) mod twin {
    use image_conformance::Px;

    pub const TAU: f32 = 6.283_185_3;
    pub const GOLDEN_TURN: f32 = 0.381_966_01;

    pub fn tap(win: &[Px], w: u32, h: u32, x: i32, y: i32) -> Px {
        let x = x.clamp(0, w as i32 - 1) as u32;
        let y = y.clamp(0, h as i32 - 1) as u32;
        win[(y * w + x) as usize]
    }

    /// WGSL `mix(x, y, a) = x·(1 − a) + y·a`.
    pub fn mixp(a: Px, b: Px, t: f32) -> Px {
        a.zip(b, |x, y| x * (1.0 - t) + y * t)
    }

    pub fn bilin(win: &[Px], w: u32, h: u32, px: f32, py: f32) -> Px {
        let (qx, qy) = (px - 0.5, py - 0.5);
        let (fx, fy) = (qx.floor(), qy.floor());
        let (tx, ty) = (qx - fx, qy - fy);
        let (ix, iy) = (fx as i32, fy as i32);
        let top = mixp(tap(win, w, h, ix, iy), tap(win, w, h, ix + 1, iy), tx);
        let bot = mixp(
            tap(win, w, h, ix, iy + 1),
            tap(win, w, h, ix + 1, iy + 1),
            tx,
        );
        mixp(top, bot, ty)
    }

    pub fn luma(p: Px) -> f32 {
        p.0[0] * 0.2126 + p.0[1] * 0.7152 + p.0[2] * 0.0722
    }

    pub fn fract(x: f32) -> f32 {
        x - x.floor()
    }

    pub fn smooth01(t: f32) -> f32 {
        let u = t.clamp(0.0, 1.0);
        u * u * (3.0 - 2.0 * u)
    }

    pub fn radians(d: f32) -> f32 {
        d * (std::f32::consts::PI / 180.0)
    }

    pub fn scale(p: Px, k: f32) -> Px {
        p.map(|v| v * k)
    }

    pub fn disc(win: &[Px], w: u32, h: u32, px: f32, py: f32, r: f32, bokeh: f32) -> Px {
        let n = ((3.0 * r).ceil() as i32).clamp(8, 192);
        let mut acc = Px([0.0; 4]);
        let mut wsum = 0.0f32;
        for k in 0..n {
            let fk = k as f32;
            let rho = r * ((fk + 0.5) / n as f32).sqrt();
            let th = fract(fk * GOLDEN_TURN) * TAU;
            let s = bilin(win, w, h, px + rho * th.cos(), py + rho * th.sin());
            let wt = 1.0 + bokeh.clamp(0.0, 1.0) * 16.0 * (luma(s) - 0.7).max(0.0);
            acc = acc + scale(s, wt);
            wsum += wt;
        }
        scale(acc, 1.0 / wsum)
    }
}

use twin::*;

// ───────────────────────────── stimulus ─────────────────────────────

/// Structured, finite, with a few bright specks (so the bokeh weight
/// has something to act on). Values in [0, 1], opaque.
pub(crate) fn stimulus(w: u32, h: u32) -> RefTile {
    RefTile::from_fn(w, h, |x, y| {
        let hsh = |c: u32| ((7 * x + 13 * y + 29 * c + 17 * ((x * y) % 11)) % 257) as f32 / 256.0;
        let speck = if (x * 5 + y * 3) % 23 == 0 { 0.45 } else { 0.0 };
        Px([
            (0.4 * (x as f32 * 0.21).sin().abs() + 0.4 * hsh(0) + speck).min(1.0),
            (0.5 * (y as f32 * 0.17).cos().abs() + 0.3 * hsh(1) + speck).min(1.0),
            (0.6 * hsh(2) + 0.2 + speck).min(1.0),
            1.0,
        ])
    })
}

const W: u32 = 48;
const H: u32 = 40;

fn require<P: bytemuck::Pod>(
    def: &'static KernelDef,
    reference: impl Fn(&[Px], u32, u32, u32, u32, &P) -> Px,
    p: &P,
) {
    let win = stimulus(W, H);
    match parity_windowed(def, reference, &win, W, H, p) {
        Some(r) => {
            eprintln!("{}: measured max f16 ULP {}", def.id, r.max_ulp);
            assert_within(r, def);
        }
        // `test_device` already reported `unavailable: GPU adapter` (or
        // failed under PAGED_REQUIRE_GPU=1).
        None => {}
    }
}

/// Run a twin over the (quantized) stimulus.
fn run_twin<P>(
    reference: impl Fn(&[Px], u32, u32, u32, u32, &P) -> Px,
    p: &P,
) -> (Vec<Px>, Vec<Px>) {
    let src = stimulus(W, H).quantized_px();
    let mut out = Vec::with_capacity(src.len());
    for y in 0..H {
        for x in 0..W {
            out.push(reference(&src, W, H, x, y, p));
        }
    }
    (src, out)
}

/// Local variance of channel 0 over a 5×5 block centred at (x, y).
fn local_var(img: &[Px], x: u32, y: u32) -> f32 {
    let mut s = 0.0;
    let mut s2 = 0.0;
    for dy in -2i32..=2 {
        for dx in -2i32..=2 {
            let v = tap(img, W, H, x as i32 + dx, y as i32 + dy).0[0];
            s += v;
            s2 += v * v;
        }
    }
    let n = 25.0;
    s2 / n - (s / n) * (s / n)
}

// ───────────────────────────── twins ────────────────────────────────

fn field_ref(win: &[Px], w: u32, h: u32, ox: u32, oy: u32, p: &BlurFieldParams) -> Px {
    let a = tap(win, w, h, ox as i32, oy as i32);
    let (px, py) = (ox as f32 + 0.5, oy as f32 + 0.5);
    let cnt = p.count.min(8) as usize;
    let (mut ws, mut bs) = (0.0f32, 0.0f32);
    for i in 0..cnt {
        let (qx, qy, qb) = p.pin(i);
        let (dx, dy) = (px - qx, py - qy);
        let wt = 1.0 / (dx * dx + dy * dy + 1.0);
        ws += wt;
        bs += wt * qb.clamp(0.0, BLUR_MAX_PX);
    }
    let r = if ws > 0.0 { bs / ws } else { 0.0 };
    if r >= 0.5 {
        disc(win, w, h, px, py, r, p.light_bokeh)
    } else {
        a
    }
}

fn ellipse(px: f32, py: f32, cx: f32, cy: f32, rx: f32, ry: f32, rot: f32) -> (f32, f32, f32) {
    let rad = radians(rot);
    let (cs, sn) = (rad.cos(), rad.sin());
    let (dx, dy) = (px - cx, py - cy);
    let u = (cs * dx + sn * dy) / rx.max(1.0);
    let v = (cs * dy - sn * dx) / ry.max(1.0);
    ((u * u + v * v).sqrt(), dx, dy)
}

fn iris_ref(win: &[Px], w: u32, h: u32, ox: u32, oy: u32, p: &BlurIrisParams) -> Px {
    let a = tap(win, w, h, ox as i32, oy as i32);
    let (px, py) = (ox as f32 + 0.5, oy as f32 + 0.5);
    let (e, _, _) = ellipse(px, py, p.cx, p.cy, p.rx, p.ry, p.rotation_deg);
    let f = p.feather.clamp(0.0, 1.0);
    let t = if f < 1.0 {
        smooth01((e - f) / (1.0 - f))
    } else if e >= 1.0 {
        1.0
    } else {
        0.0
    };
    let r = p.blur_px.clamp(0.0, BLUR_MAX_PX) * t;
    if r >= 0.5 {
        disc(win, w, h, px, py, r, p.light_bokeh)
    } else {
        a
    }
}

fn tilt_ref(win: &[Px], w: u32, h: u32, ox: u32, oy: u32, p: &BlurTiltShiftParams) -> Px {
    let a = tap(win, w, h, ox as i32, oy as i32);
    let (px, py) = (ox as f32 + 0.5, oy as f32 + 0.5);
    let rad = radians(p.angle_deg);
    let (nx, ny) = (-rad.sin(), rad.cos());
    let dist = (px - p.cx) * nx + (py - p.cy) * ny;
    let mut t = 0.0;
    if p.symmetric != 0 || dist >= 0.0 {
        let over = dist.abs() - p.sharp_px.max(0.0);
        if p.feather_px > 0.0 {
            t = smooth01(over / p.feather_px);
        } else if over > 0.0 {
            t = 1.0;
        }
    }
    let r = p.blur_px.clamp(0.0, BLUR_MAX_PX) * t;
    if r >= 0.5 {
        disc(win, w, h, px, py, r, p.light_bokeh)
    } else {
        a
    }
}

fn path_ref(win: &[Px], w: u32, h: u32, ox: u32, oy: u32, p: &BlurPathParams) -> Px {
    let a = tap(win, w, h, ox as i32, oy as i32);
    let (px, py) = (ox as f32 + 0.5, oy as f32 + 0.5);
    let cnt = p.count.min(8) as usize;
    let (mut tx, mut ty, mut ws, mut sacc, mut cum) = (0.0f32, 0.0f32, 0.0f32, 0.0f32, 0.0f32);
    for i in 0..7 {
        if i + 1 >= cnt {
            break;
        }
        let (ax, ay) = p.point(i);
        let (bx, by) = p.point(i + 1);
        let (sx, sy) = (bx - ax, by - ay);
        let len = (sx * sx + sy * sy).sqrt();
        if len < 0.0001 {
            continue;
        }
        let t = (((px - ax) * sx + (py - ay) * sy) / (len * len)).clamp(0.0, 1.0);
        let (dqx, dqy) = (px - (ax + sx * t), py - (ay + sy * t));
        let wt = 1.0 / (dqx * dqx + dqy * dqy + 1.0);
        tx += sx * (wt / len);
        ty += sy * (wt / len);
        sacc += wt * (cum + t * len);
        ws += wt;
        cum += len;
    }
    let tl = (tx * tx + ty * ty).sqrt();
    if !(ws > 0.0 && tl > 0.000_001) {
        return a;
    }
    let (dx, dy) = (tx / tl, ty / tl);
    let s = (sacc / ws) / cum.max(0.0001);
    let l = p.speed_px.clamp(0.0, BLUR_MAX_PX) * (1.0 - p.taper.clamp(0.0, 1.0) * s);
    if l < 0.5 {
        return a;
    }
    let n = (l.ceil() as i32).clamp(1, 64);
    let mut acc = Px([0.0; 4]);
    for j in 0..=n {
        let f = j as f32 / n as f32;
        let off = if p.centered != 0 {
            (f - 0.5) * l
        } else {
            -f * l
        };
        acc = acc + bilin(win, w, h, px + dx * off, py + dy * off);
    }
    scale(acc, 1.0 / (n + 1) as f32)
}

fn spin_ref(win: &[Px], w: u32, h: u32, ox: u32, oy: u32, p: &BlurSpinParams) -> Px {
    let a = tap(win, w, h, ox as i32, oy as i32);
    let (px, py) = (ox as f32 + 0.5, oy as f32 + 0.5);
    let (e, dx, dy) = ellipse(px, py, p.cx, p.cy, p.rx, p.ry, p.rotation_deg);
    if e >= 1.0 {
        return a;
    }
    let f = p.feather.clamp(0.0, 1.0);
    let k = if f > 0.0 {
        smooth01((1.0 - e) / f)
    } else {
        1.0
    };
    let span = radians(p.angle_deg.clamp(0.0, 360.0)) * k;
    let arc = span * (dx * dx + dy * dy).sqrt();
    if arc < 0.5 {
        return a;
    }
    let n = (arc.ceil() as i32).clamp(1, 64);
    let mut acc = Px([0.0; 4]);
    for j in 0..=n {
        let th = (j as f32 / n as f32 - 0.5) * span;
        let (ct, st) = (th.cos(), th.sin());
        acc = acc
            + bilin(
                win,
                w,
                h,
                p.cx + (ct * dx - st * dy),
                p.cy + (st * dx + ct * dy),
            );
    }
    scale(acc, 1.0 / (n + 1) as f32)
}

// ───────────────────────────── parity ───────────────────────────────

#[test]
fn blur_field_parity__feat__image_editor_filters() {
    let p = BlurFieldParams::new(
        &[(6.0, 6.0, 0.0), (40.0, 30.0, 9.0), (24.0, 20.0, 3.0)],
        0.6,
    );
    require(&BLUR_FIELD, field_ref, &p);
}

#[test]
fn blur_iris_parity__feat__image_editor_filters() {
    let p = BlurIrisParams::new(24.0, 20.0, 14.0, 9.0, 30.0, 7.0, 0.4, 0.5);
    require(&BLUR_IRIS, iris_ref, &p);
}

#[test]
fn blur_tilt_shift_parity__feat__image_editor_filters() {
    for sym in [true, false] {
        let p = BlurTiltShiftParams::new(24.0, 20.0, 15.0, 4.0, 8.0, 6.0, sym, 0.3);
        require(&BLUR_TILT_SHIFT, tilt_ref, &p);
    }
}

#[test]
fn blur_path_parity__feat__image_editor_filters() {
    for centered in [true, false] {
        let p = BlurPathParams::new(
            &[(4.0, 30.0), (20.0, 10.0), (44.0, 18.0)],
            14.0,
            0.5,
            centered,
        );
        require(&BLUR_PATH, path_ref, &p);
    }
}

#[test]
fn blur_spin_parity__feat__image_editor_filters() {
    let p = BlurSpinParams::new(24.0, 20.0, 18.0, 14.0, 20.0, 40.0, 0.3);
    require(&BLUR_SPIN, spin_ref, &p);
}

#[test]
fn blur_gallery_identity_parity__feat__image_editor_filters() {
    // Each kernel at its no-op setting, on the adapter.
    require(
        &BLUR_FIELD,
        field_ref,
        &BlurFieldParams::new(&[(10.0, 10.0, 0.0)], 1.0),
    );
    require(
        &BLUR_IRIS,
        iris_ref,
        &BlurIrisParams::new(24.0, 20.0, 10.0, 10.0, 0.0, 0.0, 0.5, 1.0),
    );
    require(
        &BLUR_TILT_SHIFT,
        tilt_ref,
        &BlurTiltShiftParams::new(24.0, 20.0, 0.0, 2.0, 4.0, 0.0, true, 0.0),
    );
    require(
        &BLUR_PATH,
        path_ref,
        &BlurPathParams::new(&[(0.0, 0.0), (40.0, 30.0)], 0.0, 0.0, true),
    );
    require(
        &BLUR_SPIN,
        spin_ref,
        &BlurSpinParams::new(24.0, 20.0, 20.0, 20.0, 0.0, 0.0, 0.2),
    );
}

// ───────────────────────────── behaviour ────────────────────────────

#[test]
fn blur_gallery_neutral_settings_return_the_input_exactly__feat__image_editor_filters() {
    let checks: [(Vec<Px>, Vec<Px>); 5] = [
        run_twin(field_ref, &BlurFieldParams::new(&[(10.0, 10.0, 0.0)], 1.0)),
        run_twin(
            iris_ref,
            &BlurIrisParams::new(24.0, 20.0, 10.0, 10.0, 0.0, 0.0, 0.5, 1.0),
        ),
        run_twin(
            tilt_ref,
            &BlurTiltShiftParams::new(24.0, 20.0, 0.0, 2.0, 4.0, 0.0, true, 0.0),
        ),
        run_twin(
            path_ref,
            &BlurPathParams::new(&[(0.0, 0.0), (40.0, 30.0)], 0.0, 0.0, true),
        ),
        run_twin(
            spin_ref,
            &BlurSpinParams::new(24.0, 20.0, 20.0, 20.0, 0.0, 0.0, 0.2),
        ),
    ];
    for (i, (src, out)) in checks.iter().enumerate() {
        assert_eq!(
            src, out,
            "kernel #{i}: the neutral setting must be the identity"
        );
    }
}

#[test]
fn field_blur_grades_from_the_sharp_pin_to_the_blurred_one__feat__image_editor_filters() {
    let p = BlurFieldParams::new(&[(4.0, 4.0, 0.0), (44.0, 36.0, 10.0)], 0.0);
    let (src, out) = run_twin(field_ref, &p);
    let i = |x: u32, y: u32| (y * W + x) as usize;
    // At the sharp pin the radius is under half a pixel: untouched.
    assert_eq!(out[i(3, 3)], src[i(3, 3)]);
    // At the blurred pin the neighbourhood flattens.
    assert!(local_var(&out, 42, 34) < 0.5 * local_var(&src, 42, 34));
    // One pin blurs evenly: the same pin anywhere gives the same image
    // (up to the rounding of w·b / w).
    let a = run_twin(field_ref, &BlurFieldParams::new(&[(0.0, 0.0, 5.0)], 0.0)).1;
    let b = run_twin(field_ref, &BlurFieldParams::new(&[(40.0, 30.0, 5.0)], 0.0)).1;
    for (x, y) in a.iter().zip(&b) {
        for c in 0..4 {
            assert!((x.0[c] - y.0[c]).abs() < 1e-4);
        }
    }
}

#[test]
fn iris_blur_keeps_the_core_and_blurs_outside__feat__image_editor_filters() {
    let p = BlurIrisParams::new(24.0, 20.0, 12.0, 10.0, 0.0, 8.0, 0.5, 0.0);
    let (src, out) = run_twin(iris_ref, &p);
    for y in 17..23 {
        for x in 21..27 {
            let k = (y * W + x) as usize;
            assert_eq!(out[k], src[k], "the sharp core at ({x}, {y})");
        }
    }
    assert!(local_var(&out, 3, 3) < 0.5 * local_var(&src, 3, 3));
}

#[test]
fn tilt_shift_keeps_the_band_and_one_sided_spares_the_other_side__feat__image_editor_filters() {
    // A horizontal band through y = 20 (angle 0: the normal points down).
    let sym = BlurTiltShiftParams::new(24.0, 20.0, 0.0, 3.0, 4.0, 8.0, true, 0.0);
    let (src, out) = run_twin(tilt_ref, &sym);
    for x in 0..W {
        let k = (20 * W + x) as usize;
        assert_eq!(out[k], src[k], "the band row at x = {x}");
    }
    assert!(local_var(&out, 20, 3) < 0.5 * local_var(&src, 20, 3));
    assert!(local_var(&out, 20, 37) < 0.5 * local_var(&src, 20, 37));
    let one = BlurTiltShiftParams::new(24.0, 20.0, 0.0, 3.0, 4.0, 8.0, false, 0.0);
    let (_, out1) = run_twin(tilt_ref, &one);
    for x in 0..W {
        let k = (3 * W + x) as usize;
        assert_eq!(out1[k], src[k], "above the line is spared at x = {x}");
    }
    assert!(local_var(&out1, 20, 37) < 0.5 * local_var(&src, 20, 37));
}

#[test]
fn path_blur_follows_the_path_direction__feat__image_editor_filters() {
    // Vertical stripes (vary in x only): a horizontal path smears them,
    // a vertical path leaves them (each tap reads the same column).
    let stripes = RefTile::from_fn(W, H, |x, _| {
        let v = if x % 4 < 2 { 0.9 } else { 0.1 };
        Px([v, v, v, 1.0])
    });
    let src = stripes.quantized_px();
    let run = |p: &BlurPathParams| -> Vec<Px> {
        let mut out = Vec::new();
        for y in 0..H {
            for x in 0..W {
                out.push(path_ref(&src, W, H, x, y, p));
            }
        }
        out
    };
    let across = run(&BlurPathParams::new(
        &[(0.0, 20.0), (48.0, 20.0)],
        8.0,
        0.0,
        true,
    ));
    let along = run(&BlurPathParams::new(
        &[(24.0, 0.0), (24.0, 40.0)],
        8.0,
        0.0,
        true,
    ));
    let k = (20 * W + 21) as usize;
    assert!(
        (across[k].0[0] - 0.5).abs() < 0.15,
        "smeared toward the mean"
    );
    for (i, (a, s)) in along.iter().zip(&src).enumerate() {
        assert!(
            (a.0[0] - s.0[0]).abs() < 1e-5,
            "texel {i} along the stripes"
        );
    }
}

#[test]
fn spin_blur_leaves_everything_outside_the_ellipse__feat__image_editor_filters() {
    let p = BlurSpinParams::new(24.0, 20.0, 10.0, 8.0, 0.0, 90.0, 0.2);
    let (src, out) = run_twin(spin_ref, &p);
    for y in 0..H {
        for x in 0..W {
            let (e, _, _) = ellipse(x as f32 + 0.5, y as f32 + 0.5, 24.0, 20.0, 10.0, 8.0, 0.0);
            let k = (y * W + x) as usize;
            if e >= 1.0 {
                assert_eq!(out[k], src[k], "outside at ({x}, {y})");
            }
        }
    }
    assert!(local_var(&out, 28, 20) < local_var(&src, 28, 20));
}

#[test]
fn the_disc_budget_matches_the_published_bound__feat__image_editor_filters() {
    assert_eq!(DISC_MAX_TAPS, 192);
    assert_eq!(BLUR_MAX_PX, 128.0);
}

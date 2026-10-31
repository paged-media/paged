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

//! gpu↔ref parity and behaviour proofs for `families::render` (WP5.2):
//! Clouds, Difference Clouds, Fibers, Lens Flare and Lighting Effects.
//! The scalar twins mirror the WGSL step for step (the PCG hash, the value
//! noise, the octave loop, the shading). The random-seeded kernels are
//! also held to DETERMINISM (one seed, one image, on every run) and to
//! their STATISTICS, which is what the Photoshop oracle compares for them
//! (pixels cannot agree with another implementation's random stream).
#![allow(non_snake_case)]

use half::f16;
use image_conformance::harness::RefTile;
use image_conformance::Px;
use image_kernels::families::render::{
    RenderCloudsParams, RenderFibersParams, RenderLensFlareParams, RenderLightingParams,
    FLARE_105MM, FLARE_35MM, FLARE_MOVIE, FLARE_ZOOM, LIGHTING_SETTINGS, RENDER_CLOUDS,
    RENDER_FIBERS, RENDER_LENS_FLARE, RENDER_LIGHTING,
};

use crate::filters_distort::{gpu, parity, stimulus};

const W: u32 = 64;
const H: u32 = 48;

// ───────────────────────────── noise twin ───────────────────────────

fn pcg(v: u32) -> u32 {
    let state = v.wrapping_mul(747_796_405).wrapping_add(2_891_336_453);
    let word = ((state >> ((state >> 28) + 4)) ^ state).wrapping_mul(277_803_737);
    (word >> 22) ^ word
}

fn hash21(x: i32, y: i32, seed: u32) -> f32 {
    let h = pcg((x as u32) ^ pcg((y as u32) ^ pcg(seed)));
    (h >> 8) as f32 * 5.960_464_5e-8
}

fn vnoise(px: f32, py: f32, seed: u32) -> f32 {
    let (ix0, iy0) = (px.floor(), py.floor());
    let (fx, fy) = (px - ix0, py - iy0);
    let (ix, iy) = (ix0 as i32, iy0 as i32);
    let ux = fx * fx * (3.0 - 2.0 * fx);
    let uy = fy * fy * (3.0 - 2.0 * fy);
    let v00 = hash21(ix, iy, seed);
    let v10 = hash21(ix + 1, iy, seed);
    let v01 = hash21(ix, iy + 1, seed);
    let v11 = hash21(ix + 1, iy + 1, seed);
    let top = v00 * (1.0 - ux) + v10 * ux;
    let bot = v01 * (1.0 - ux) + v11 * ux;
    top * (1.0 - uy) + bot * uy
}

fn unpremul(a: Px) -> [f32; 3] {
    if a.0[3] > 0.0 {
        [a.0[0] / a.0[3], a.0[1] / a.0[3], a.0[2] / a.0[3]]
    } else {
        [a.0[0], a.0[1], a.0[2]]
    }
}

fn bits(v: &[Px]) -> Vec<[u16; 4]> {
    v.iter()
        .map(|p| p.0.map(|c| f16::from_f32(c).to_bits()))
        .collect()
}

fn lum(p: Px) -> f32 {
    0.2126 * p.0[0] + 0.7152 * p.0[1] + 0.0722 * p.0[2]
}

fn mean_std(v: &[f32]) -> (f32, f32) {
    let n = v.len() as f32;
    let m = v.iter().sum::<f32>() / n;
    let var = v.iter().map(|x| (x - m) * (x - m)).sum::<f32>() / n;
    (m, var.sqrt())
}

// ───────────────────────────── clouds ──────────────────────────────

fn clouds_ref(a: Px, p: &RenderCloudsParams, x: u32, y: u32) -> Px {
    let px = (p.ox + x as i32) as f32 + 0.5;
    let py = (p.oy + y as i32) as f32 + 0.5;
    let s = p.scale_px.max(1.0);
    let (mut qx, mut qy) = (px / s, py / s);
    let (mut sum, mut amp, mut norm) = (0.0f32, 0.5f32, 0.0f32);
    for o in 0..8u32 {
        sum += amp * vnoise(qx, qy, p.seed.wrapping_add(o.wrapping_mul(7919)));
        norm += amp;
        amp *= 0.5;
        qx *= 2.0;
        qy *= 2.0;
    }
    let v = ((sum / norm - 0.5) * 1.6 + 0.5).clamp(0.0, 1.0);
    let fg = [p.fg_r, p.fg_g, p.fg_b];
    let bg = [p.bg_r, p.bg_g, p.bg_b];
    let cl = [0, 1, 2].map(|c| fg[c] * (1.0 - v) + bg[c] * v);
    if p.difference == 1 {
        let c = unpremul(a);
        let al = a.0[3];
        Px([
            (c[0] - cl[0]).abs() * al,
            (c[1] - cl[1]).abs() * al,
            (c[2] - cl[2]).abs() * al,
            al,
        ])
    } else {
        Px([cl[0], cl[1], cl[2], 1.0])
    }
}

#[test]
fn render_clouds_parity_both_modes__feat__image_editor_filters() {
    let img = stimulus(W, H);
    let q = img.quantized_px();
    for difference in [false, true] {
        let mut p = RenderCloudsParams::new(
            42,
            [0.1, 0.15, 0.3],
            [0.95, 0.9, 0.8],
            difference,
            RenderCloudsParams::scale_for(W, H),
        );
        p.ox = 13;
        p.oy = -7;
        parity(&RENDER_CLOUDS, &[&img], p.as_bytes(), |x, y| {
            clouds_ref(q[(y * W + x) as usize], &p, x, y)
        });
    }
}

#[test]
fn render_clouds_is_deterministic_per_seed_with_cloud_statistics__feat__image_editor_filters() {
    let n = 128u32;
    let img = stimulus(n, n);
    let p = |seed| {
        RenderCloudsParams::new(
            seed,
            [0.0; 3],
            [1.0; 3],
            false,
            RenderCloudsParams::scale_for(n, n),
        )
    };
    let Some(a1) = gpu(&RENDER_CLOUDS, &[&img], p(1).as_bytes()) else {
        eprintln!("unavailable: GPU adapter");
        return;
    };
    let a2 = gpu(&RENDER_CLOUDS, &[&img], p(1).as_bytes()).expect("device");
    let b = gpu(&RENDER_CLOUDS, &[&img], p(2).as_bytes()).expect("device");
    assert_eq!(bits(&a1), bits(&a2), "one seed, one image");
    assert_ne!(bits(&a1), bits(&b), "another seed, other clouds");
    let l: Vec<f32> = a1.iter().map(|p| p.0[0]).collect();
    let (m, s) = mean_std(&l);
    eprintln!("render.clouds: mean {m:.3} std {s:.3}");
    assert!((0.35..=0.65).contains(&m), "clouds centre on mid grey: {m}");
    assert!(s > 0.08, "clouds vary: {s}");
    assert!(
        a1.iter().all(|p| p.0[3] == 1.0 && p.0[0] == p.0[1]),
        "opaque, grey"
    );
    // Smooth: neighbours differ little (a cloud, not white noise).
    let mut step = 0.0f32;
    for y in 0..n {
        for x in 1..n {
            step += (l[(y * n + x) as usize] - l[(y * n + x - 1) as usize]).abs();
        }
    }
    assert!(step / ((n - 1) * n) as f32 <= s / 4.0, "clouds are smooth");
}

#[test]
fn render_difference_clouds_over_black_is_the_clouds__feat__image_editor_filters() {
    let black = RefTile::from_fn(W, H, |_, _| Px([0.0, 0.0, 0.0, 1.0]));
    let scale = RenderCloudsParams::scale_for(W, H);
    let plain = RenderCloudsParams::new(9, [0.2, 0.3, 0.4], [0.9, 0.8, 0.7], false, scale);
    let diff = RenderCloudsParams::new(9, [0.2, 0.3, 0.4], [0.9, 0.8, 0.7], true, scale);
    let Some(a) = gpu(&RENDER_CLOUDS, &[&black], plain.as_bytes()) else {
        eprintln!("unavailable: GPU adapter");
        return;
    };
    let b = gpu(&RENDER_CLOUDS, &[&black], diff.as_bytes()).expect("device");
    assert_eq!(bits(&a), bits(&b), "|0 − clouds| = clouds");
}

// ───────────────────────────── fibers ──────────────────────────────

fn fibers_ref(p: &RenderFibersParams, x: u32, y: u32) -> Px {
    let px = (p.ox + x as i32) as f32 + 0.5;
    let py = (p.oy + y as i32) as f32 + 0.5;
    let cx = 64.0 / p.variance.clamp(1.0, 64.0);
    let cy = 8.0 * p.strength.clamp(1.0, 64.0);
    let (qx, qy) = (px / cx, py / cy);
    let n = 0.6 * vnoise(qx, qy, p.seed)
        + 0.3 * vnoise(qx * 2.0, qy * 2.0, p.seed.wrapping_add(1))
        + 0.1 * vnoise(qx * 4.0, qy * 4.0, p.seed.wrapping_add(2));
    let v = ((n - 0.5) * 2.0 + 0.5).clamp(0.0, 1.0);
    let fg = [p.fg_r, p.fg_g, p.fg_b];
    let bg = [p.bg_r, p.bg_g, p.bg_b];
    Px([
        fg[0] * (1.0 - v) + bg[0] * v,
        fg[1] * (1.0 - v) + bg[1] * v,
        fg[2] * (1.0 - v) + bg[2] * v,
        1.0,
    ])
}

#[test]
fn render_fibers_parity__feat__image_editor_filters() {
    let img = stimulus(W, H);
    for (variance, strength) in [(16.0, 4.0), (40.0, 12.0)] {
        let mut p =
            RenderFibersParams::new(5, variance, strength, [0.2, 0.15, 0.1], [0.9, 0.85, 0.7]);
        p.ox = 3;
        p.oy = 11;
        parity(&RENDER_FIBERS, &[&img], p.as_bytes(), |x, y| {
            fibers_ref(&p, x, y)
        });
    }
}

#[test]
fn render_fibers_run_vertically_and_repeat_per_seed__feat__image_editor_filters() {
    let n = 128u32;
    let img = stimulus(n, n);
    let p = |seed| RenderFibersParams::new(seed, 16.0, 8.0, [0.0; 3], [1.0; 3]);
    let Some(a) = gpu(&RENDER_FIBERS, &[&img], p(3).as_bytes()) else {
        eprintln!("unavailable: GPU adapter");
        return;
    };
    let again = gpu(&RENDER_FIBERS, &[&img], p(3).as_bytes()).expect("device");
    let other = gpu(&RENDER_FIBERS, &[&img], p(4).as_bytes()).expect("device");
    assert_eq!(bits(&a), bits(&again));
    assert_ne!(bits(&a), bits(&other));
    let v = |x: u32, y: u32| a[(y * n + x) as usize].0[0];
    let (mut dx, mut dy) = (0.0f32, 0.0f32);
    for y in 1..n {
        for x in 1..n {
            dx += (v(x, y) - v(x - 1, y)).abs();
            dy += (v(x, y) - v(x, y - 1)).abs();
        }
    }
    eprintln!("render.fibers: mean |d/dx| {dx} vs |d/dy| {dy}");
    assert!(dy * 4.0 < dx, "fibres are long in y: dx {dx}, dy {dy}");
}

// ──────────────────────────── lens flare ───────────────────────────

fn flare_ref(a: Px, p: &RenderLensFlareParams, x: u32, y: u32) -> Px {
    let (w, h) = (W as f32, H as f32);
    let diag = (w * w + h * h).sqrt();
    let (px, py) = (x as f32 + 0.5, y as f32 + 0.5);
    let dv = ((px - p.cx) / diag, (py - p.cy) / diag);
    let r = (dv.0 * dv.0 + dv.1 * dv.1).sqrt();
    let k = p.kind;
    let g = (-r * r / 0.0008).exp() + 0.4 * (-r / 0.06).exp();
    let mut f = [g, g * 0.95, g * 0.85];
    let add = |f: &mut [f32; 3], s: f32, c: [f32; 3]| {
        for i in 0..3 {
            f[i] += s * c[i];
        }
    };
    if k != 3 {
        let r0 = match k {
            1 => 0.09,
            2 => 0.15,
            _ => 0.12,
        };
        let t = (r - r0) / 0.008;
        add(&mut f, (-t * t).exp() * 0.25, [0.7, 0.8, 1.0]);
    }
    if k == 0 || k == 2 {
        let th = dv.1.atan2(dv.0);
        let rays = 0.15 * (th * 3.0).cos().abs().powf(8.0) * (-r / 0.1).exp();
        add(&mut f, rays, [1.0, 1.0, 1.0]);
    }
    if k == 3 {
        let streak = (-dv.1.abs() / 0.003).exp() * (-dv.0.abs() / 0.35).exp() * 0.8;
        add(&mut f, streak, [0.6, 0.75, 1.0]);
    }
    let axis = (w * 0.5 - p.cx, h * 0.5 - p.cy);
    for i in 0..5u32 {
        let fi = i as f32;
        let t = 0.4 + 0.35 * fi + 0.05 * k as f32;
        let gx = p.cx + axis.0 * t;
        let gy = p.cy + axis.1 * t;
        let size = 0.02 + 0.015 * ((i * 7 + k * 3) % 5) as f32;
        let gd = ((px - gx) * (px - gx) + (py - gy) * (py - gy)).sqrt() / diag;
        let disc = ((size - gd) / (0.2 * size)).clamp(0.0, 1.0) * 0.12;
        let hh = fi * 1.7 + k as f32;
        add(
            &mut f,
            disc,
            [
                0.6 + 0.4 * hh.sin(),
                0.6 + 0.4 * (hh + 2.1).sin(),
                0.6 + 0.4 * (hh + 4.2).sin(),
            ],
        );
    }
    let c = unpremul(a);
    let al = a.0[3];
    let o = [0, 1, 2].map(|i| {
        let fi = (f[i] * p.brightness).clamp(0.0, 1.0);
        (1.0 - (1.0 - c[i]) * (1.0 - fi)) * al
    });
    Px([o[0], o[1], o[2], al])
}

#[test]
fn render_lens_flare_parity_every_lens__feat__image_editor_filters() {
    let img = stimulus(W, H);
    let q = img.quantized_px();
    for kind in [FLARE_ZOOM, FLARE_35MM, FLARE_105MM, FLARE_MOVIE] {
        let p = RenderLensFlareParams::new(20.5, 15.25, 1.2, kind);
        parity(&RENDER_LENS_FLARE, &[&img], p.as_bytes(), |x, y| {
            flare_ref(q[(y * W + x) as usize], &p, x, y)
        });
    }
}

#[test]
fn render_lens_flare_only_brightens_and_peaks_at_its_centre__feat__image_editor_filters() {
    let img = stimulus(W, H);
    let q = img.quantized_px();
    let p = RenderLensFlareParams::new(40.0, 12.0, 1.0, FLARE_ZOOM);
    let Some(got) = gpu(&RENDER_LENS_FLARE, &[&img], p.as_bytes()) else {
        eprintln!("unavailable: GPU adapter");
        return;
    };
    for (g, a) in got.iter().zip(&q) {
        for c in 0..3 {
            assert!(g.0[c] >= a.0[c] - 1e-3, "a screen never darkens");
        }
    }
    let centre = got[(12 * W + 40) as usize];
    assert!(
        centre.0.iter().take(3).all(|v| *v > 0.97),
        "the core is white"
    );
    let far = got[(40 * W + 2) as usize];
    assert!(lum(far) < lum(centre) - 0.2);
    let dimmer = RenderLensFlareParams::new(40.0, 12.0, 0.3, FLARE_ZOOM);
    let d = gpu(&RENDER_LENS_FLARE, &[&img], dimmer.as_bytes()).expect("device");
    let s: f32 = got.iter().map(|p| lum(*p)).sum();
    let sd: f32 = d.iter().map(|p| lum(*p)).sum();
    assert!(sd < s, "brightness scales the flare");
}

// ───────────────────────── lighting effects ────────────────────────

fn smoothstep(e0: f32, e1: f32, x: f32) -> f32 {
    let t = ((x - e0) / (e1 - e0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

fn norm3(v: [f32; 3]) -> [f32; 3] {
    let l = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    [v[0] / l, v[1] / l, v[2] / l]
}

fn dot3(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn height_at(q: &[Px], p: &RenderLightingParams, x: i32, y: i32) -> f32 {
    let t = q[(y.clamp(0, H as i32 - 1) as u32 * W + x.clamp(0, W as i32 - 1) as u32) as usize];
    let c = unpremul(t);
    let mut v = match p.tex {
        1 => c[0],
        2 => c[1],
        3 => c[2],
        4 => t.0[3],
        5 => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2],
        _ => 0.0,
    };
    if p.white_high == 0 {
        v = 1.0 - v;
    }
    v
}

fn lighting_ref(q: &[Px], p: &RenderLightingParams, x: u32, y: u32) -> Px {
    let a = q[(y * W + x) as usize];
    let c = unpremul(a);
    let (xi, yi) = (x as i32, y as i32);
    let mut n = [0.0, 0.0, 1.0];
    if p.tex != 0 {
        let gx = (height_at(q, p, xi + 1, yi) - height_at(q, p, xi - 1, yi)) * 0.5;
        let gy = (height_at(q, p, xi, yi + 1) - height_at(q, p, xi, yi - 1)) * 0.5;
        let k = p.bump * 8.0;
        n = norm3([-gx * k, -gy * k, 1.0]);
    }
    let pos = [x as f32 + 0.5, y as f32 + 0.5, 0.0];
    let dir = [p.dx, p.dy, p.dz];
    let mut l = [-dir[0], -dir[1], -dir[2]];
    let mut spot = 1.0;
    if p.kind != 2 {
        l = norm3([p.lx - pos[0], p.ly - pos[1], p.lz - pos[2]]);
        if p.kind == 0 {
            spot = smoothstep(p.cos_outer, p.cos_cone, dot3([-l[0], -l[1], -l[2]], dir));
        }
    }
    let diff = dot3(n, l).max(0.0) * spot * p.intensity;
    let hv = norm3([l[0], l[1], l[2] + 1.0]);
    let shin = 2.0 + (p.gloss + 100.0) * 0.49;
    let ks = (p.gloss + 100.0) / 200.0 * 0.6;
    let spec = dot3(n, hv).max(0.000_001).powf(shin) * ks * spot * p.intensity;
    let metal = (p.metallic + 100.0) / 200.0;
    let lc = [p.r, p.g, p.b];
    let amb = (p.ambience + 100.0) / 200.0 * 0.6;
    let e = (p.exposure / 100.0).exp2();
    let o = [0, 1, 2].map(|i| {
        let sc = lc[i] * (1.0 - metal) + c[i] * metal;
        (e * (c[i] * (amb + diff * lc[i]) + spec * sc)).clamp(0.0, 1.0) * a.0[3]
    });
    Px([o[0], o[1], o[2], a.0[3]])
}

/// The door's 19 settings: a spot light by default.
fn settings() -> [f32; LIGHTING_SETTINGS] {
    [
        0.0, 0.3, 0.35, 0.5, 30.0, 35.0, 20.0, 1.0, 0.95, 0.85, 0.0, -50.0, 0.0, 8.0, 5.0, 50.0,
        1.0, 40.0, 45.0,
    ]
}

#[test]
fn render_lighting_parity_spot_point_infinite__feat__image_editor_filters() {
    let img = stimulus(W, H);
    let q = img.quantized_px();
    for kind in [0.0f32, 1.0, 2.0] {
        let mut s = settings();
        s[0] = kind;
        let p = RenderLightingParams::from_settings(&s, W, H);
        parity(&RENDER_LIGHTING, &[&img], p.as_bytes(), |x, y| {
            lighting_ref(&q, &p, x, y)
        });
    }
}

#[test]
fn render_lighting_flat_overhead_light_is_a_uniform_gain__feat__image_editor_filters() {
    // No texture, an infinite light straight down: every pixel gets the
    // same gain, so out / in is one number.
    let img = stimulus(W, H);
    let q = img.quantized_px();
    let mut s = settings();
    s[0] = 2.0;
    s[14] = 0.0;
    s[18] = 90.0;
    s[7] = 1.0;
    s[8] = 1.0;
    s[9] = 1.0;
    s[10] = -100.0; // no gloss: no highlight
    let p = RenderLightingParams::from_settings(&s, W, H);
    let Some(got) = gpu(&RENDER_LIGHTING, &[&img], p.as_bytes()) else {
        eprintln!("unavailable: GPU adapter");
        return;
    };
    let ratios: Vec<f32> = got
        .iter()
        .zip(&q)
        .filter(|(g, _)| g.0[0] < 0.99)
        .map(|(g, a)| g.0[0] / a.0[0])
        .collect();
    let (m, sd) = mean_std(&ratios);
    assert!(sd < 0.01 * m, "a uniform gain: mean {m}, std {sd}");
}

#[test]
fn render_lighting_spot_lights_its_target_more_than_the_far_corner__feat__image_editor_filters() {
    let grey = RefTile::from_fn(W, H, |_, _| Px([0.5, 0.5, 0.5, 1.0]));
    let mut s = settings();
    s[14] = 0.0;
    // The spot over the left third, aiming right-and-down at 45°.
    let p = RenderLightingParams::from_settings(&s, W, H);
    let Some(got) = gpu(&RENDER_LIGHTING, &[&grey], p.as_bytes()) else {
        eprintln!("unavailable: GPU adapter");
        return;
    };
    let lit = got[(17 * W + 28) as usize];
    let dark = got[((H - 1) * W) as usize];
    assert!(lum(lit) > lum(dark) + 0.1, "lit {lit:?} vs corner {dark:?}");
}

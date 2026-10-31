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

//! THE BRUSH ORACLE: Photoshop's own dab placement and dab profile,
//! replayed.
//!
//! `scripts/photoshop/probes/brush-strokes.jsx` strokes straight work
//! paths with Photoshop's Brush tool (Stroke Path, every dynamics pane
//! off, black on white) and records the PNGs in
//! `image-conformance/fixtures/photoshop/brush-strokes/`. Photoshop cannot
//! replay a pointer stroke from a script, but Stroke Path IS its dab
//! planner and its tip rasteriser, which is what is compared here:
//!
//! * PLACEMENT — where a single dab's centre lands for an integer and a
//!   half-pixel anchor;
//! * SPACING — the dab centres along a line at 100/150/200 % spacing,
//!   and the extent and coverage of overlapping strokes at 10/25 %;
//! * PROFILE — a single round dab's coverage field at hardness 0/50/100;
//! * ORIENTATION — an elliptical tip's major-axis angle and axis ratio,
//!   and a SAMPLED (bitmap) tip's centroid, angle and mirror under
//!   rotation and flips: the sign convention and the flip/rotate order
//!   the `.abr` registry declined to guess.
//!
//! The round-tip cases paint through the whole engine path
//! (`StrokeSession`, the GPU composite, the f16 bridge). The oriented and
//! sampled cases are compared at the COVERAGE layer
//! (`image_gpu::brush::OrientedTip` stamped into the `StrokeAccumulator`,
//! the field the composite consumes as its mask), so they need no
//! device.
//!
//! Every case is classified in `brush-strokes.ledger.json` next to the
//! fixtures (`agreement` / `convention`, with the measured numbers and
//! the reason). A run fails when a case's class changes or its distance
//! grows past the ledger's by more than the slack; regenerate with
//! `PAGED_PHOTOSHOP_LEDGER=write cargo nextest run -p image-js
//! brush_photoshop` (the classes are computed, the notes are kept in the
//! source below).

use std::path::PathBuf;
use std::sync::Arc;

use image_gpu::brush::OrientedTip;
use image_gpu::dynamics::{BrushDynamics, PenSample};
use image_gpu::{SampledTip, StrokeAccumulator, StrokeSample, TipCoverage};
use image_js::stroke::{StrokeParams, StrokeSession, StrokeTool};
use zune_core::bytestream::ZCursor;
use zune_png::PngDecoder;

const N: u32 = 128;

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../image-conformance/fixtures/photoshop/brush-strokes")
}

/// A fixture as COVERAGE: black paint on white, so `1 − red`.
fn ps_coverage(id: &str) -> Vec<f64> {
    let bytes = std::fs::read(dir().join(format!("{id}.png")))
        .unwrap_or_else(|e| panic!("fixture {id}.png: {e}"));
    let mut dec = PngDecoder::new(ZCursor::new(&bytes[..]));
    dec.decode_headers().expect("png headers");
    let (w, h) = dec.dimensions().expect("dimensions");
    assert_eq!((w, h), (N as usize, N as usize), "{id}: size");
    let channels = dec.colorspace().expect("colourspace").num_components();
    let px: Vec<f64> = match dec.decode().expect("png decode") {
        zune_core::result::DecodingResult::U16(v) => {
            v.iter().map(|&s| s as f64 / 65535.0).collect()
        }
        zune_core::result::DecodingResult::U8(v) => v.iter().map(|&s| s as f64 / 255.0).collect(),
        _ => panic!("{id}: unexpected sample type"),
    };
    px.chunks(channels).map(|c| 1.0 - c[0]).collect()
}

/// Our engine's stroke, through `StrokeSession` on the device: black on
/// opaque white, returned as coverage (`1 − red/255`).
fn ours_session(
    ctx: &image_gpu::GpuContext,
    diameter: f32,
    hardness: f32,
    spacing: f32,
    from: (f32, f32),
    to: (f32, f32),
) -> Vec<f64> {
    let base: Arc<[u8]> = Arc::from(vec![255u8; (N * N * 4) as usize]);
    let mut p = StrokeParams::defaults(StrokeTool::Brush);
    p.size = diameter;
    p.hardness = hardness;
    p.spacing = spacing;
    p.opacity = 1.0;
    p.flow = 1.0;
    p.color = [0.0, 0.0, 0.0, 1.0];
    p.pressure = image_gpu::PressureTarget::None;
    let mut s = StrokeSession::begin_on(1, N, N, base, p, None).expect("begin");
    for (x, y) in [from, to] {
        pollster::block_on(s.extend(ctx, StrokeSample::new(x, y, 1.0))).expect("extend");
    }
    s.commit()
        .chunks(4)
        .map(|c| 1.0 - c[0] as f64 / 255.0)
        .collect()
}

/// A single dab through the ENGINE PATH with Brush Tip Shape set:
/// `StrokeSession::set_dynamics` (angle, roundness, flips) and
/// `set_tip_bitmap`, painted on the device with `extend_pen`.
#[allow(clippy::too_many_arguments)]
fn ours_session_tip(
    ctx: &image_gpu::GpuContext,
    diameter: f32,
    hardness: f32,
    angle: f32,
    roundness: f32,
    flip_x: bool,
    flip_y: bool,
    bitmap: Option<SampledTip>,
) -> Vec<f64> {
    let base: Arc<[u8]> = Arc::from(vec![255u8; (N * N * 4) as usize]);
    let mut p = StrokeParams::defaults(StrokeTool::Brush);
    p.size = diameter;
    p.hardness = hardness;
    p.spacing = 4.0;
    p.color = [0.0, 0.0, 0.0, 1.0];
    p.pressure = image_gpu::PressureTarget::None;
    let mut s = StrokeSession::begin_on(1, N, N, base, p, None).expect("begin");
    let mut d = BrushDynamics::default();
    d.tip.angle = angle;
    d.tip.roundness = roundness;
    d.tip.flip_x = flip_x;
    d.tip.flip_y = flip_y;
    s.set_dynamics(d);
    s.set_tip_bitmap(bitmap);
    for x in [64.0, 74.0] {
        pollster::block_on(s.extend_pen(ctx, PenSample::at(x, 64.0, 1.0))).expect("extend");
    }
    s.commit()
        .chunks(4)
        .map(|c| 1.0 - c[0] as f64 / 255.0)
        .collect()
}

/// A single dab of `tip` at `(cx, cy)`, at the COVERAGE layer.
fn ours_dab(tip: &dyn TipCoverage, cx: f32, cy: f32) -> Vec<f64> {
    let mut acc = StrokeAccumulator::new(N, N);
    acc.stamp(tip, cx, cy, 1.0);
    (0..N * N)
        .map(|i| acc.value_at(i % N, i / N) as f64)
        .collect()
}

/// The sampled tip Photoshop defined: the artwork's coverage cropped to
/// its bounding box (Define Brush Preset crops to the artwork).
fn sampled_tip() -> SampledTip {
    let c = ps_coverage("tip-source");
    let on = |x: u32, y: u32| c[(y * N + x) as usize] > 1.0 / 512.0;
    let (mut x0, mut y0, mut x1, mut y1) = (N, N, 0, 0);
    for y in 0..N {
        for x in 0..N {
            if on(x, y) {
                x0 = x0.min(x);
                y0 = y0.min(y);
                x1 = x1.max(x + 1);
                y1 = y1.max(y + 1);
            }
        }
    }
    let (w, h) = (x1 - x0, y1 - y0);
    let alpha: Vec<u8> = (0..w * h)
        .map(|i| {
            let (x, y) = (x0 + i % w, y0 + i / w);
            (c[(y * N + x) as usize].clamp(0.0, 1.0) * 255.0).round() as u8
        })
        .collect();
    SampledTip::new(w, h, alpha).expect("a non-empty tip")
}

/// Mass, centroid (pixel centres at +0.5), major-axis angle in degrees
/// COUNTER-CLOCKWISE ON SCREEN, and the minor/major axis ratio.
#[derive(Debug, Clone, Copy)]
struct Moments {
    mass: f64,
    cx: f64,
    cy: f64,
    angle: f64,
    ratio: f64,
}

fn moments(c: &[f64]) -> Moments {
    let (mut m, mut sx, mut sy) = (0.0, 0.0, 0.0);
    for (i, &v) in c.iter().enumerate() {
        let (x, y) = ((i as u32 % N) as f64 + 0.5, (i as u32 / N) as f64 + 0.5);
        m += v;
        sx += v * x;
        sy += v * y;
    }
    let (cx, cy) = (sx / m, sy / m);
    let (mut xx, mut yy, mut xy) = (0.0, 0.0, 0.0);
    for (i, &v) in c.iter().enumerate() {
        let (x, y) = (
            (i as u32 % N) as f64 + 0.5 - cx,
            (i as u32 / N) as f64 + 0.5 - cy,
        );
        xx += v * x * x;
        yy += v * y * y;
        xy += v * x * y;
    }
    let (xx, yy, xy) = (xx / m, yy / m, xy / m);
    // Image y points down: negate to report the on-screen CCW angle.
    let angle = -0.5 * (2.0 * xy).atan2(xx - yy).to_degrees();
    let tr = xx + yy;
    let disc = ((xx - yy) * (xx - yy) / 4.0 + xy * xy).sqrt();
    let (big, small) = (tr / 2.0 + disc, tr / 2.0 - disc);
    Moments {
        mass: m,
        cx,
        cy,
        angle,
        ratio: (small.max(0.0) / big).sqrt(),
    }
}

/// Difference between two axis angles (mod 180), in degrees.
fn axis_diff(a: f64, b: f64) -> f64 {
    let d = (a - b).rem_euclid(180.0);
    d.min(180.0 - d)
}

/// Max and mean absolute coverage difference over the union of the two
/// footprints.
fn field_diff(a: &[f64], b: &[f64]) -> (f64, f64) {
    let (mut max, mut sum, mut n) = (0.0f64, 0.0, 0usize);
    for (x, y) in a.iter().zip(b) {
        if *x > 1e-3 || *y > 1e-3 {
            let d = (x - y).abs();
            max = max.max(d);
            sum += d;
            n += 1;
        }
    }
    (max, if n == 0 { 0.0 } else { sum / n as f64 })
}

/// The centres of the separated dabs along row-summed columns.
fn dab_centres(c: &[f64]) -> Vec<f64> {
    let col: Vec<f64> = (0..N)
        .map(|x| (0..N).map(|y| c[(y * N + x) as usize]).sum())
        .collect();
    let mut out = Vec::new();
    let mut x = 0usize;
    while x < N as usize {
        if col[x] > 1e-3 {
            let s = x;
            while x < N as usize && col[x] > 1e-3 {
                x += 1;
            }
            let m: f64 = col[s..x].iter().sum();
            let c: f64 = (s..x).map(|i| col[i] * (i as f64 + 0.5)).sum();
            out.push(c / m);
        } else {
            x += 1;
        }
    }
    out
}

/// The covered column range `[first, last]`.
fn extent(c: &[f64]) -> (u32, u32) {
    let cols: Vec<u32> = (0..N)
        .filter(|&x| (0..N).any(|y| c[(y * N + x) as usize] > 1e-3))
        .collect();
    (cols[0], *cols.last().expect("painted"))
}

/// One measured case.
struct Row {
    id: &'static str,
    class: &'static str,
    /// The case's headline distance (its unit is in `metric`).
    value: f64,
    metric: &'static str,
    detail: String,
    note: &'static str,
}

const PLACEMENT_TOL: f64 = 0.05;
const ANGLE_TOL: f64 = 0.5;
const RATIO_TOL: f64 = 0.02;
const FIELD_AGREE: f64 = 0.08;
/// How far a distance may grow past the ledger's before the run fails.
const SLACK: f64 = 0.02;

fn class_of(ok: bool) -> &'static str {
    if ok {
        "agreement"
    } else {
        "convention"
    }
}

const NOTE_SOFT: &str = "Photoshop's soft falloff is a Gaussian-like bell that reaches PAST the nominal radius (hardness 0: half coverage at ~0.55 R, 9 % at R, ~2 % at 1.25 R); the engine's tip is a hardness plateau plus a smoothstep that ends exactly AT R. Same centre, same size class, a different curve: recorded, not copied.";
const NOTE_HARD: &str = "At hardness 100 both are a disc of radius R with an antialiased rim; Photoshop's rim is ~2 px wide and centred a little inside R (0.68 at R-0.5, 0.19 at R+0.5), the engine's is the 1 px AA band ending at R (0.5 at R-0.5).";
const NOTE_SAMPLED: &str = "Orientation, mirror and the flip-then-rotate order agree with Photoshop (axis within 0.5 deg). Photoshop's sampled stamp sits ~0.45 px toward the tip's top-left corner IN TIP SPACE (the offset flips and rotates with the tip, so it is a half-texel centring of the bitmap, not a placement error); the engine centres the bitmap on the dab exactly.";
const NOTE_OVERLAP: &str = "Overlapping dabs: the stroke's extent and coverage are compared; the residual is the rim difference of the round tip (see the single-dab rows), accumulated along the stroke.";

fn round_rows(ctx: &image_gpu::GpuContext) -> Vec<Row> {
    let mut rows = Vec::new();
    // ── single dabs: placement + profile ──
    for (id, d, h, at) in [
        ("round-d40-h0-single", 40.0, 0.0, (64.0, 64.0)),
        ("round-d40-h50-single", 40.0, 0.5, (64.0, 64.0)),
        ("round-d40-h100-single", 40.0, 1.0, (64.0, 64.0)),
        ("round-d40-h50-single-half", 40.0, 0.5, (64.5, 64.5)),
        ("round-d11-h100-single", 11.0, 1.0, (64.0, 64.0)),
    ] {
        let ps = ps_coverage(id);
        let ours = ours_session(ctx, d, h, 10.0, at, (at.0 + 10.0, at.1));
        let (mp, mo) = (moments(&ps), moments(&ours));
        let placement = ((mp.cx - mo.cx).abs()).max((mp.cy - mo.cy).abs());
        let (max, mean) = field_diff(&ps, &ours);
        rows.push(Row {
            id,
            class: class_of(placement <= PLACEMENT_TOL && max <= FIELD_AGREE),
            value: max,
            metric: "max_coverage",
            detail: format!(
                "\"placement_px\": {placement:.3}, \"mean_coverage\": {mean:.4}, \"mass_ps\": {:.1}, \"mass_ours\": {:.1}",
                mp.mass, mo.mass
            ),
            note: if h >= 1.0 { NOTE_HARD } else { NOTE_SOFT },
        });
        assert!(
            placement <= PLACEMENT_TOL,
            "{id}: the dab centre is {placement:.3} px from Photoshop's — placement is not a convention"
        );
    }
    // ── spacing: separated dabs ──
    for (id, d, sp) in [
        ("round-d10-h100-sp150", 10.0, 1.5),
        ("round-d10-h100-sp200", 10.0, 2.0),
    ] {
        let ps = dab_centres(&ps_coverage(id));
        let ours = dab_centres(&ours_session(ctx, d, 1.0, sp, (14.0, 64.0), (114.0, 64.0)));
        let worst = if ps.len() == ours.len() {
            ps.iter()
                .zip(&ours)
                .map(|(a, b)| (a - b).abs())
                .fold(0.0, f64::max)
        } else {
            f64::INFINITY
        };
        assert!(
            worst <= PLACEMENT_TOL,
            "{id}: dab centres differ — Photoshop {ps:?}, ours {ours:?}"
        );
        rows.push(Row {
            id,
            class: "agreement",
            value: worst,
            metric: "centre_px",
            detail: format!(
                "\"dabs\": {}, \"first\": {:.2}, \"last\": {:.2}",
                ps.len(),
                ps[0],
                ps[ps.len() - 1]
            ),
            note: "",
        });
    }
    // ── spacing: overlapping dabs ──
    for (id, d, h, sp) in [
        ("round-d10-h100-sp100", 10.0, 1.0, 1.0),
        ("round-d20-h100-sp25", 20.0, 1.0, 0.25),
        ("round-d20-h100-sp10", 20.0, 1.0, 0.10),
        ("round-d20-h50-sp25", 20.0, 0.5, 0.25),
    ] {
        let ps = ps_coverage(id);
        let ours = ours_session(ctx, d, h, sp, (14.0, 64.0), (114.0, 64.0));
        let (ep, eo) = (extent(&ps), extent(&ours));
        let (max, mean) = field_diff(&ps, &ours);
        let ext = (ep.0 as f64 - eo.0 as f64)
            .abs()
            .max((ep.1 as f64 - eo.1 as f64).abs());
        // A soft tip's tail reaches past R in Photoshop (the profile
        // convention), so only the HARD tip's extent is a spacing claim.
        if h >= 1.0 {
            assert!(
                ext <= 2.0,
                "{id}: stroke extent Photoshop {ep:?} vs ours {eo:?}"
            );
        }
        rows.push(Row {
            id,
            class: class_of(max <= FIELD_AGREE),
            value: max,
            metric: "max_coverage",
            detail: format!(
                "\"mean_coverage\": {mean:.4}, \"extent_ps\": [{}, {}], \"extent_ours\": [{}, {}]",
                ep.0, ep.1, eo.0, eo.1
            ),
            note: NOTE_OVERLAP,
        });
    }
    rows
}

fn oriented_rows(ctx: Option<&image_gpu::GpuContext>) -> Vec<Row> {
    let mut rows = Vec::new();
    for (id, h, angle, roundness) in [
        ("round-d40-h100-a30-r40", 1.0, 30.0, 0.40),
        ("round-d40-h100-am60-r25", 1.0, -60.0, 0.25),
        ("round-d40-h50-a90-r50", 0.5, 90.0, 0.50),
    ] {
        let tip = OrientedTip {
            diameter: 40.0,
            hardness: h,
            antialias: true,
            angle_deg: angle,
            roundness,
            flip_x: false,
            flip_y: false,
            bitmap: None,
        };
        let ps = ps_coverage(id);
        let ours = match ctx {
            Some(ctx) => ours_session_tip(ctx, 40.0, h, angle, roundness, false, false, None),
            None => ours_dab(&tip, 64.0, 64.0),
        };
        let (mp, mo) = (moments(&ps), moments(&ours));
        let da = axis_diff(mp.angle, mo.angle);
        let dr = (mp.ratio - mo.ratio).abs();
        assert!(
            da <= ANGLE_TOL && dr <= RATIO_TOL,
            "{id}: Photoshop axis {:.2}° ratio {:.3}, ours {:.2}° ratio {:.3}",
            mp.angle,
            mp.ratio,
            mo.angle,
            mo.ratio
        );
        let (max, mean) = field_diff(&ps, &ours);
        rows.push(Row {
            id,
            class: "agreement",
            value: da,
            metric: "axis_deg",
            detail: format!(
                "\"axis_ps\": {:.2}, \"axis_ours\": {:.2}, \"ratio_ps\": {:.3}, \"ratio_ours\": {:.3}, \"max_coverage\": {max:.3}, \"mean_coverage\": {mean:.4}",
                mp.angle, mo.angle, mp.ratio, mo.ratio
            ),
            note: "Angle positive = counter-clockwise on screen; roundness squashes the minor axis. The rim residual is the round tip's (see the single-dab rows).",
        });
    }
    let bmp = sampled_tip();
    for (id, angle, fx, fy) in [
        ("sampled-a0", 0.0, false, false),
        ("sampled-a30", 30.0, false, false),
        ("sampled-am30", -30.0, false, false),
        ("sampled-flipx", 0.0, true, false),
        ("sampled-flipy", 0.0, false, true),
        ("sampled-flipx-a30", 30.0, true, false),
    ] {
        let tip = OrientedTip {
            diameter: 48.0,
            hardness: 1.0,
            antialias: true,
            angle_deg: angle,
            roundness: 1.0,
            flip_x: fx,
            flip_y: fy,
            bitmap: Some(&bmp),
        };
        let ps = ps_coverage(id);
        let ours = match ctx {
            Some(ctx) => ours_session_tip(ctx, 48.0, 1.0, angle, 1.0, fx, fy, Some(bmp.clone())),
            None => ours_dab(&tip, 64.0, 64.0),
        };
        let (mp, mo) = (moments(&ps), moments(&ours));
        let da = axis_diff(mp.angle, mo.angle);
        let shift = ((mp.cx - mo.cx).powi(2) + (mp.cy - mo.cy).powi(2)).sqrt();
        // The orientation and the MIRROR are the claims: a wrong sign or
        // order moves the centroid by many pixels (the tip's centroid sits
        // ~13 px from its centre), the resampling offset by under one.
        assert!(
            da <= 1.0 && shift <= 1.0,
            "{id}: Photoshop centroid ({:.2},{:.2}) axis {:.2}°, ours ({:.2},{:.2}) axis {:.2}°",
            mp.cx,
            mp.cy,
            mp.angle,
            mo.cx,
            mo.cy,
            mo.angle
        );
        let (max, mean) = field_diff(&ps, &ours);
        rows.push(Row {
            id,
            class: "convention",
            value: shift,
            metric: "centroid_px",
            detail: format!(
                "\"axis_ps\": {:.2}, \"axis_ours\": {:.2}, \"centroid_ps\": [{:.2}, {:.2}], \"centroid_ours\": [{:.2}, {:.2}], \"max_coverage\": {max:.3}, \"mean_coverage\": {mean:.4}",
                mp.angle, mo.angle, mp.cx, mp.cy, mo.cx, mo.cy
            ),
            note: NOTE_SAMPLED,
        });
    }
    rows
}

fn ledger_path() -> PathBuf {
    dir().with_file_name("brush-strokes.ledger.json")
}

fn write_ledger(rows: &[Row]) {
    let agree = rows.iter().filter(|r| r.class == "agreement").count();
    let body: Vec<String> = rows
        .iter()
        .map(|r| {
            format!(
                "    \"{}\": {{\"class\": \"{}\", \"{}\": {:.4}, {}, \"note\": \"{}\"}}",
                r.id,
                r.class,
                r.metric,
                r.value,
                r.detail,
                r.note.replace('"', "'")
            )
        })
        .collect();
    let text = format!(
        "{{\n  \"about\": \"Photoshop brush oracle (probes/brush-strokes.jsx): every recorded case, classified, with our measured distance. Coverage is 0..1; px are image pixels. Regenerate with PAGED_PHOTOSHOP_LEDGER=write (image-js tests/it/brush_photoshop.rs).\",\n  \"summary\": {{\"agreement\": {agree}, \"convention\": {}}},\n  \"cases\": {{\n{}\n  }}\n}}\n",
        rows.len() - agree,
        body.join(",\n")
    );
    std::fs::write(ledger_path(), text).expect("write ledger");
}

/// The committed `(class, value)` of `id`, read without a JSON parser
/// (the ledger is this file's own output, one case per line).
fn ledger_entry(text: &str, id: &str, metric: &str) -> Option<(String, f64)> {
    let line = text
        .lines()
        .find(|l| l.trim_start().starts_with(&format!("\"{id}\":")))?;
    let class = line
        .split("\"class\": \"")
        .nth(1)?
        .split('"')
        .next()?
        .to_string();
    let value = line
        .split(&format!("\"{metric}\": "))
        .nth(1)?
        .split([',', '}'])
        .next()?
        .trim()
        .parse()
        .ok()?;
    Some((class, value))
}

fn check(rows: &[Row]) {
    if std::env::var_os("PAGED_PHOTOSHOP_LEDGER").is_some_and(|v| v == "write") {
        write_ledger(rows);
        return;
    }
    let text = std::fs::read_to_string(ledger_path())
        .expect("brush-strokes.ledger.json (PAGED_PHOTOSHOP_LEDGER=write creates it)");
    let mut problems = Vec::new();
    for r in rows {
        match ledger_entry(&text, r.id, r.metric) {
            None => problems.push(format!("{}: not in the ledger", r.id)),
            Some((class, value)) => {
                if class != r.class {
                    problems.push(format!("{}: class {} (ledger {class})", r.id, r.class));
                }
                if r.value > value + SLACK {
                    problems.push(format!(
                        "{}: {} {:.4} grew past the ledger's {value:.4}",
                        r.id, r.metric, r.value
                    ));
                }
            }
        }
    }
    assert!(
        problems.is_empty(),
        "brush oracle:\n  {}",
        problems.join("\n  ")
    );
}

/// The fixture JSON names every case this file replays (a re-recording
/// that dropped one fails here, not silently).
fn fixture_names(ids: &[&str]) {
    let fx = std::fs::read_to_string(dir().with_file_name("brush-strokes.photoshop.json"))
        .expect("brush-strokes.photoshop.json");
    for id in ids {
        assert!(
            fx.contains(&format!("\"id\": \"{id}\"")),
            "{id}: not recorded"
        );
    }
}

#[test]
#[allow(non_snake_case)]
fn round_tip_placement_spacing_and_profile_match_photoshop__feat__image_editor_brush_engine() {
    let Some(ctx) = image_gpu::test_support::device_or_skip("brush oracle") else {
        return;
    };
    let mut rows = round_rows(ctx);
    rows.extend(oriented_rows(Some(ctx)));
    fixture_names(&rows.iter().map(|r| r.id).collect::<Vec<_>>());
    check(&rows);
}

#[test]
#[allow(non_snake_case)]
fn tip_angle_roundness_flips_and_sampled_rotation_match_photoshop__feat__image_editor_brush_engine()
{
    // The coverage-layer half, device-free: it holds on the CPU lane too
    // and pins the sign / order conventions on their own.
    let rows = oriented_rows(None);
    fixture_names(&rows.iter().map(|r| r.id).collect::<Vec<_>>());
    if std::env::var_os("PAGED_PHOTOSHOP_LEDGER").is_none() {
        check(&rows);
    }
}

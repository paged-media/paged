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

//! TRANSFORM AND WARP ON PIXELS (WP5.6, image ADR 483): what the warp
//! doors prepare on the CPU around their kernel dispatches, natively
//! testable (the doors themselves live in `wasm/warps.rs`).
//!
//! - the WORKING WINDOW: a rectangle of a layer as premultiplied
//!   rgba16float, each pixel weighted by the selection's coverage when
//!   the selected pixels float (Warp of a selection);
//! - the FLOAT: the warped pixels landed over what stays,
//!   `moved + stay · (1 − moved.a)` — `geom.warp_projective`'s masked
//!   lane, for the kernels whose source window is not the canvas;
//! - the FIELD WINDOW of `geom.warp_field`: the layer and the field's
//!   nodes packed into one rgba16float window;
//! - PUPPET WARP's mesh over what the layer covers, its solve and its
//!   field (`paged_warp::puppet`), and the bent mesh's edges for the
//!   overlay;
//! - CONTENT-AWARE SCALE of a layer's content (`paged_resample`'s seam
//!   carving, inherently sequential, so CPU — the PatchMatch search's
//!   class, ADR 469), placed about the content's centre.

use half::f16;
use image_kernels::families::warp::WarpFieldParams;
use paged_warp::field::Field;
use paged_warp::puppet::{self, Pin, PuppetMesh, PuppetMode};

use crate::pixels::Pixels;

/// An integer rectangle `(x, y, w, h)`.
pub type Rect = (u32, u32, u32, u32);

/// The bounds of the pixels `px` covers (alpha above 0) on a
/// `width`-wide canvas, or `None` when it covers none.
pub fn content_bounds(px: &Pixels, width: u32, height: u32) -> Option<Rect> {
    let (mut x0, mut y0, mut x1, mut y1) = (u32::MAX, u32::MAX, 0u32, 0u32);
    for y in 0..height {
        for x in 0..width {
            if px.sample16((y * width + x) as usize, 3) == 0 {
                continue;
            }
            x0 = x0.min(x);
            y0 = y0.min(y);
            x1 = x1.max(x + 1);
            y1 = y1.max(y + 1);
        }
    }
    (x0 != u32::MAX).then(|| (x0, y0, x1 - x0, y1 - y0))
}

/// The pixel at `(x, y)` as premultiplied f32, times `weight`.
fn premul(px: &Pixels, width: u32, x: u32, y: u32, weight: f32) -> [f32; 4] {
    let i = (y * width + x) as usize;
    let a = f32::from(px.sample16(i, 3)) / 65535.0 * weight;
    let c = |k: usize| f32::from(px.sample16(i, k)) / 65535.0 * a;
    [c(0), c(1), c(2), a]
}

fn push_f16(out: &mut Vec<u8>, v: [f32; 4]) {
    for c in v {
        out.extend_from_slice(&f16::from_f32(c).to_le_bytes());
    }
}

/// The working window over `rect` of a `width`-wide canvas: premultiplied
/// rgba16float, each pixel's alpha times `weight(x, y)` (canvas
/// coordinates; 1 for the whole layer).
pub fn premul_window(
    px: &Pixels,
    width: u32,
    rect: Rect,
    weight: impl Fn(u32, u32) -> f32,
) -> Vec<u8> {
    let (rx, ry, rw, rh) = rect;
    let mut out = Vec::with_capacity(rw as usize * rh as usize * 8);
    for y in ry..ry + rh {
        for x in rx..rx + rw {
            push_f16(&mut out, premul(px, width, x, y, weight(x, y)));
        }
    }
    out
}

/// Land the warped `moved` (premultiplied rgba16float over the whole
/// `width`×`height` canvas) over what STAYS of `px`: each pixel times
/// `1 − weight(x, y)`, the weight being the part that floated.
pub fn float_over(
    moved: &mut [u8],
    px: &Pixels,
    width: u32,
    height: u32,
    weight: impl Fn(u32, u32) -> f32,
) {
    for y in 0..height {
        for x in 0..width {
            let i = (y * width + x) as usize * 8;
            let m: [f32; 4] = std::array::from_fn(|c| {
                f16::from_le_bytes([moved[i + 2 * c], moved[i + 2 * c + 1]]).to_f32()
            });
            let stay = premul(px, width, x, y, 1.0 - weight(x, y));
            let k = 1.0 - m[3].clamp(0.0, 1.0);
            for c in 0..4 {
                let v = f16::from_f32(m[c] + stay[c] * k).to_le_bytes();
                moved[i + 2 * c] = v[0];
                moved[i + 2 * c + 1] = v[1];
            }
        }
    }
}

/// `geom.warp_field`'s window: the layer (premultiplied) and `field`'s
/// nodes in one rgba16float window no side of which exceeds `max_dim`.
/// Returns the window, its params (bicubic, unmasked) and its size, or
/// `None` when the field does not fit beside the layer.
pub fn field_window(
    px: &Pixels,
    width: u32,
    height: u32,
    field: &Field,
    max_dim: u32,
) -> Option<(Vec<u8>, WarpFieldParams, u32, u32)> {
    let (p, ww, wh) =
        WarpFieldParams::layout(width, height, field.cols, field.rows, field.step, max_dim)?;
    let mut out = Vec::with_capacity(ww as usize * wh as usize * 8);
    for y in 0..wh {
        for x in 0..ww {
            let v = if x < width && y < height {
                premul(px, width, x, y, 1.0)
            } else if x >= p.field_x
                && y >= p.field_y
                && x - p.field_x < field.cols
                && y - p.field_y < field.rows
            {
                let d = field.d[((y - p.field_y) * field.cols + x - p.field_x) as usize];
                WarpFieldParams::encode_node(d[0], d[1])
            } else {
                [0.0; 4]
            };
            push_f16(&mut out, v);
        }
    }
    Some((out, p, ww, wh))
}

/// The coarsest Liquify mesh: nodes on the longer side.
pub const LIQUIFY_NODES: u32 = 512;

/// The parsed Puppet Warp request: pins as flat `[at_x, at_y, to_x, to_y]`.
pub fn parse_pins(flat: &[f32]) -> Result<Vec<Pin>, String> {
    if !flat.len().is_multiple_of(4) || flat.iter().any(|v| !v.is_finite()) {
        return Err(format!(
            "puppet pins are [at x, at y, to x, to y] per pin, got {} numbers",
            flat.len()
        ));
    }
    Ok(flat
        .as_chunks::<4>()
        .0
        .iter()
        .map(|&[ax, ay, tx, ty]| Pin {
            at: [f64::from(ax), f64::from(ay)],
            to: [f64::from(tx), f64::from(ty)],
        })
        .collect())
}

/// Puppet Warp of a layer: its mesh (over what it covers, `expansion` px
/// out, `density` 0 fewer / 1 normal / 2 more points), the bent vertices
/// and the backward field.
pub fn puppet_field(
    px: &Pixels,
    width: u32,
    height: u32,
    pins: &[Pin],
    mode: u32,
    density: u32,
    expansion: f32,
) -> Result<(PuppetMesh, Vec<[f64; 2]>, Field), String> {
    let mode = PuppetMode::from_code(mode)
        .ok_or_else(|| format!("unknown puppet mode {mode} (0 rigid | 1 normal | 2 distort)"))?;
    if !expansion.is_finite() || !(-64.0..=256.0).contains(&expansion) {
        return Err(format!(
            "puppet expansion {expansion} is outside -64..256 px"
        ));
    }
    let alpha: Vec<u8> = (0..width as usize * height as usize)
        .map(|i| (px.sample16(i, 3) >> 8) as u8)
        .collect();
    let spacing = puppet::spacing_for(width, height, density);
    // A negative expansion shrinks the outline: only well-covered pixels.
    let (exp, threshold) = if expansion < 0.0 {
        (0.0, 254)
    } else {
        (f64::from(expansion), 0)
    };
    let mesh = PuppetMesh::from_alpha(&alpha, width, height, spacing, exp, threshold);
    if mesh.triangles.is_empty() {
        return Err("the layer covers no pixels to pin".into());
    }
    let bent = puppet::solve(&mesh, pins, mode);
    let field = puppet::backward_field(&mesh, &bent, width, height);
    Ok((mesh, bent, field))
}

/// The bent mesh's edges for the overlay, flat `[x0, y0, x1, y1, …]`,
/// each edge once.
pub fn mesh_edges(mesh: &PuppetMesh, bent: &[[f64; 2]]) -> Vec<f32> {
    let mut seen = std::collections::BTreeSet::new();
    let mut out = Vec::new();
    for t in &mesh.triangles {
        for k in 0..3 {
            let (a, b) = (t[k], t[(k + 1) % 3]);
            if seen.insert((a.min(b), a.max(b))) {
                let (p, q) = (bent[a as usize], bent[b as usize]);
                out.extend_from_slice(&[p[0] as f32, p[1] as f32, q[0] as f32, q[1] as f32]);
            }
        }
    }
    out
}

/// CONTENT-AWARE SCALE of what `rgba` (straight RGBA8, `width`×`height`)
/// covers: its content box scaled by `sx`×`sy`, `amount` of the change by
/// seam carving and the rest by an ordinary (Lanczos) resize first
/// (Photoshop's Amount), the result centred on the content box's centre
/// on a transparent canvas of the same size. `protect` (one byte per
/// canvas pixel) keeps seams off what it covers.
pub fn content_aware_scale(
    rgba: &[u8],
    width: u32,
    height: u32,
    sx: f32,
    sy: f32,
    amount: f32,
    protect: Option<&[u8]>,
) -> Result<Vec<u8>, String> {
    if !(sx.is_finite() && sy.is_finite() && sx > 0.0 && sy > 0.0 && sx <= 4.0 && sy <= 4.0) {
        return Err(format!("content-aware scale {sx}×{sy} is outside (0, 4]"));
    }
    if !(0.0..=1.0).contains(&amount) {
        return Err(format!("content-aware amount {amount} is outside 0..1"));
    }
    let px = Pixels::from_rgba8(std::sync::Arc::from(rgba));
    let Some((bx, by, bw, bh)) = content_bounds(&px, width, height) else {
        return Err("the layer covers no pixels to scale".into());
    };
    let crop = |src: &[u8], bpp: usize| -> Vec<u8> {
        let mut out = Vec::with_capacity(bw as usize * bh as usize * bpp);
        for y in by..by + bh {
            let i = (y * width + bx) as usize * bpp;
            out.extend_from_slice(&src[i..i + bw as usize * bpp]);
        }
        out
    };
    let mut content = crop(rgba, 4);
    let mut mask = protect.map(|m| crop(m, 1));
    let target = |n: u32, s: f32| ((n as f32 * s).round() as u32).max(1);
    let (tw, th) = (target(bw, sx), target(bh, sy));
    // Amount < 1: the ordinary share of the change first.
    let (mut cw, mut ch) = (bw, bh);
    if amount < 1.0 {
        let k = 1.0 - amount;
        let (nw, nh) = (
            target(bw, 1.0 + (sx - 1.0) * k),
            target(bh, 1.0 + (sy - 1.0) * k),
        );
        if (nw, nh) != (cw, ch) {
            content = paged_resample::resize_rgba8(
                &content,
                cw,
                ch,
                nw,
                nh,
                paged_resample::Filter::Lanczos3,
            )
            .map_err(|e| e.to_string())?;
            mask = mask.map(|m| nearest_mask(&m, cw, ch, nw, nh));
            (cw, ch) = (nw, nh);
        }
    }
    let carved = paged_resample::seam_carve_rgba8(&content, cw, ch, tw, th, mask.as_deref())
        .map_err(|e| e.to_string())?;
    // Centre the result on the content box's centre.
    let cx = f64::from(bx) + f64::from(bw) / 2.0;
    let cy = f64::from(by) + f64::from(bh) / 2.0;
    let ox = (cx - f64::from(tw) / 2.0).round() as i64;
    let oy = (cy - f64::from(th) / 2.0).round() as i64;
    let mut out = vec![0u8; width as usize * height as usize * 4];
    for y in 0..th as i64 {
        let dy = oy + y;
        if dy < 0 || dy >= i64::from(height) {
            continue;
        }
        for x in 0..tw as i64 {
            let dx = ox + x;
            if dx < 0 || dx >= i64::from(width) {
                continue;
            }
            let s = ((y * i64::from(tw) + x) * 4) as usize;
            let d = ((dy * i64::from(width) + dx) * 4) as usize;
            out[d..d + 4].copy_from_slice(&carved[s..s + 4]);
        }
    }
    Ok(out)
}

fn nearest_mask(m: &[u8], w: u32, h: u32, nw: u32, nh: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity(nw as usize * nh as usize);
    for y in 0..nh {
        let sy = ((u64::from(y) * u64::from(h)) / u64::from(nh)) as u32;
        for x in 0..nw {
            let sx = ((u64::from(x) * u64::from(w)) / u64::from(nw)) as u32;
            out.push(m[(sy * w + sx) as usize]);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn layer(w: u32, h: u32, f: impl Fn(u32, u32) -> [u8; 4]) -> Pixels {
        let mut v = Vec::with_capacity((w * h * 4) as usize);
        for y in 0..h {
            for x in 0..w {
                v.extend_from_slice(&f(x, y));
            }
        }
        Pixels::from_rgba8(Arc::from(v))
    }

    fn half_at(win: &[u8], i: usize, c: usize) -> f32 {
        f16::from_le_bytes([win[i * 8 + 2 * c], win[i * 8 + 2 * c + 1]]).to_f32()
    }

    #[test]
    #[allow(non_snake_case)]
    fn content_bounds_are_what_the_layer_covers__feat__image_editor_transform_warp() {
        let px = layer(10, 8, |x, y| {
            if (3..7).contains(&x) && (2..5).contains(&y) {
                [9, 9, 9, 255]
            } else {
                [0; 4]
            }
        });
        assert_eq!(content_bounds(&px, 10, 8), Some((3, 2, 4, 3)));
        assert_eq!(content_bounds(&layer(4, 4, |_, _| [0; 4]), 4, 4), None);
    }

    #[test]
    fn the_window_is_premultiplied_and_weighted() {
        let px = layer(4, 2, |x, _| [255, 0, 0, if x < 2 { 255 } else { 128 }]);
        let win = premul_window(&px, 4, (1, 0, 3, 1), |x, _| if x == 3 { 0.5 } else { 1.0 });
        assert!((half_at(&win, 0, 0) - 1.0).abs() < 1e-3);
        let a = 128.0 / 255.0;
        assert!((half_at(&win, 1, 0) - a).abs() < 1e-3, "premultiplied");
        assert!((half_at(&win, 2, 3) - a * 0.5).abs() < 1e-3, "weighted");
    }

    #[test]
    fn the_float_lands_over_what_stays() {
        let px = layer(2, 1, |_, _| [0, 0, 255, 255]);
        // Pixel 0 floated away (nothing moved in), pixel 1 stayed and
        // half-transparent red moved over it.
        let mut moved = Vec::new();
        push_f16(&mut moved, [0.0; 4]);
        push_f16(&mut moved, [0.5, 0.0, 0.0, 0.5]);
        float_over(&mut moved, &px, 2, 1, |x, _| if x == 0 { 1.0 } else { 0.0 });
        assert_eq!(half_at(&moved, 0, 3), 0.0, "the float's old place is empty");
        assert!((half_at(&moved, 1, 0) - 0.5).abs() < 1e-3);
        assert!(
            (half_at(&moved, 1, 2) - 0.5).abs() < 1e-3,
            "blue shows through"
        );
        assert!((half_at(&moved, 1, 3) - 1.0).abs() < 1e-3);
    }

    #[test]
    fn the_field_window_holds_the_layer_and_the_nodes() {
        let px = layer(6, 4, |_, _| [255, 255, 255, 255]);
        let mut f = Field::new(6, 4, 2);
        f.d[1] = [2.5, -1.0];
        let (win, p, ww, wh) = field_window(&px, 6, 4, &f, 8192).unwrap();
        assert_eq!((p.field_x, p.field_y), (0, 4));
        assert_eq!((ww, wh), (6, 4 + f.rows));
        let node = (p.field_y * ww + p.field_x + 1) as usize;
        assert_eq!(half_at(&win, node, 0) + half_at(&win, node, 1), 2.5);
        assert_eq!(half_at(&win, node, 2) + half_at(&win, node, 3), -1.0);
        assert!(field_window(&px, 6, 4, &f, 5).is_none());
    }

    #[test]
    #[allow(non_snake_case)]
    fn puppet_pins_bend_the_layer_and_the_edges_follow__feat__image_editor_transform_warp() {
        let px = layer(60, 30, |x, y| {
            if (10..50).contains(&x) && (10..20).contains(&y) {
                [200, 50, 50, 255]
            } else {
                [0; 4]
            }
        });
        let pins = parse_pins(&[10.0, 15.0, 10.0, 15.0, 50.0, 15.0, 50.0, 25.0]).unwrap();
        let (mesh, bent, field) = puppet_field(&px, 60, 30, &pins, 0, 1, 2.0).unwrap();
        assert_eq!(mesh_edges(&mesh, &bent).len() % 4, 0);
        // The right end moved down: a pixel below the old bar now reads
        // the bar.
        let (_, sy) = field.source(48.0, 24.0).expect("covered");
        assert!(sy < 20.0, "reads the bar: {sy}");
        assert!(parse_pins(&[1.0, 2.0, 3.0]).is_err());
        assert!(puppet_field(&px, 60, 30, &pins, 7, 1, 2.0).is_err());
        let empty = layer(8, 8, |_, _| [0; 4]);
        assert!(puppet_field(&empty, 8, 8, &pins, 0, 1, 2.0).is_err());
    }

    #[test]
    #[allow(non_snake_case)]
    fn content_aware_scale_shrinks_about_the_centre__feat__image_editor_transform_warp() {
        let (w, h) = (40u32, 20u32);
        let rgba: Vec<u8> = (0..w * h)
            .flat_map(|i| {
                let (x, y) = (i % w, i / w);
                let v = (60 + (x * 53 + y * 31) % 190) as u8;
                if (16..24).contains(&x) {
                    [v, 30, 30, 255]
                } else {
                    [120, 120, 120 + (x % 3) as u8, 255]
                }
            })
            .collect();
        let out = content_aware_scale(&rgba, w, h, 0.5, 1.0, 1.0, None).unwrap();
        let px = Pixels::from_rgba8(Arc::from(out.clone()));
        assert_eq!(content_bounds(&px, w, h), Some((10, 0, 20, 20)));
        // The textured band survives whole.
        let band = (0..w)
            .filter(|&x| (0..h).all(|y| out[((y * w + x) * 4 + 1) as usize] == 30))
            .count();
        assert_eq!(band, 8);
        assert!(content_aware_scale(&rgba, w, h, 0.0, 1.0, 1.0, None).is_err());
        assert!(content_aware_scale(&rgba, w, h, 1.0, 1.0, 2.0, None).is_err());
        // Amount 0 is an ordinary resize of the same size.
        let plain = content_aware_scale(&rgba, w, h, 0.5, 1.0, 0.0, None).unwrap();
        assert_eq!(plain.len(), out.len());
    }
}

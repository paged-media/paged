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

//! A FILL LAYER's render: its source painted over the canvas by the
//! `gen.*` kernels, GPU-only like every other pixel the stack composites.
//!
//! * SOLID — `gen.solid`.
//! * GRADIENT — the style's generator from black to white along the
//!   layer's geometry (that is the gradient's parameter `t`, as a grey),
//!   then `adjust.gradient_map` with the stops' 256-entry ramp. A grey's
//!   Rec.709 luma is the grey itself, so the map reads `t` back exactly:
//!   any number of stops, through the two kernels that exist.
//! * PATTERN — `gen.pattern` over a transparent canvas (its source-over is
//!   premultiplied, so the result is brought back to straight colour).
//!
//! GEOMETRY. A gradient fill is aligned with the canvas (Photoshop's
//! "Align with layer" on a canvas-sized layer): its centre is the
//! canvas centre moved by the offset (percent of the canvas), its
//! direction the angle (counter-clockwise from 3 o'clock, so the image's
//! y-down axis negates the sine), and its half-length the canvas's
//! half-extent projected onto that direction, times the scale. That is
//! how a 90° linear fill spans top to bottom at 100 %; the radial,
//! diamond and reflected styles reach the same half-length. A fill
//! imported from a PSD keeps Photoshop's own render until it is edited.

use std::sync::Arc;

use half::f16;
use image_core::Region;
use image_gpu::{GpuContext, TileInput};
use image_kernels::families::adjust::{AdjustGradientMapParams, ADJUST_GRADIENT_MAP};
use image_kernels::families::cast::{CastUnpremultiplyParams, CAST_UNPREMULTIPLY};
use image_kernels::families::gen::{
    GenAngularGradientParams, GenDiamondGradientParams, GenLinearGradientParams, GenPatternParams,
    GenRadialGradientParams, GenReflectedGradientParams, GenSolidParams, GEN_ANGULAR_GRADIENT,
    GEN_DIAMOND_GRADIENT, GEN_LINEAR_GRADIENT, GEN_PATTERN, GEN_RADIAL_GRADIENT,
    GEN_REFLECTED_GRADIENT, GEN_SOLID,
};
use image_kernels::KernelDef;

use super::kinds::{stop_ramp, FillSource, GradientFill};
use crate::fill::{f16_to_rgba8, GradientKind};
use crate::ingest::IngestError;

/// The geometry of a gradient fill on a `w × h` canvas: centre, unit
/// direction (image axes, y down) and half-length in pixels.
pub(crate) fn gradient_geometry(w: u32, h: u32, g: &GradientFill) -> ((f32, f32), (f32, f32), f32) {
    let (w, h) = (w as f32, h as f32);
    let c = (
        w / 2.0 + g.offset.0 / 100.0 * w,
        h / 2.0 + g.offset.1 / 100.0 * h,
    );
    let t = g.angle.to_radians();
    let d = (t.cos(), -t.sin());
    let half = (w / 2.0 * d.0.abs() + h / 2.0 * d.1.abs()) * g.scale / 100.0;
    (c, d, half.max(1.0))
}

async fn dispatch(
    ctx: &GpuContext,
    def: &'static KernelDef,
    inputs: &[&[u8]],
    params: &[u8],
    w: u32,
    h: u32,
) -> Result<Vec<u8>, IngestError> {
    let tiles: Vec<TileInput> = inputs.iter().map(|b| TileInput { f16_bytes: b }).collect();
    image_gpu::execute_tile_once_async(ctx, def, &tiles, params, None, w, h)
        .await
        .map_err(|e| IngestError::Pipeline(e.to_string()))
}

/// Render `src` at `w × h` as straight RGBA8 (GPU-only: every pixel is a
/// `gen.*` dispatch). A canvas larger than the device's texture or
/// buffer limit renders in bands, each in canvas coordinates (ADR 480).
pub async fn render_fill(
    ctx: &GpuContext,
    w: u32,
    h: u32,
    src: &FillSource,
) -> Result<Arc<[u8]>, IngestError> {
    if w == 0 || h == 0 {
        return Err(IngestError::Unsupported("a fill on an empty canvas".into()));
    }
    let fits = w.max(h) <= ctx.max_texture_dim()
        && u64::from(w) * u64::from(h) * 8 <= ctx.max_buffer_size();
    if fits {
        return Ok(Arc::from(
            render_window(ctx, w, h, Region::new(0, 0, w, h), src)
                .await?
                .into_boxed_slice(),
        ));
    }
    // A pattern's tile must fit inside one window.
    let side = match src {
        FillSource::Pattern(p) => super::fold::TILE_SIDE.max(p.width.max(p.height)),
        _ => super::fold::TILE_SIDE,
    }
    .min(ctx.max_texture_dim());
    let mut out = vec![0u8; w as usize * h as usize * 4];
    for y in (0..h).step_by(side as usize) {
        for x in (0..w).step_by(side as usize) {
            let win = Region::new(x as i32, y as i32, side.min(w - x), side.min(h - y));
            let px = render_window(ctx, w, h, win, src).await?;
            let row = win.w as usize * 4;
            for r in 0..win.h as usize {
                let d = ((y as usize + r) * w as usize + x as usize) * 4;
                out[d..d + row].copy_from_slice(&px[r * row..(r + 1) * row]);
            }
        }
    }
    Ok(Arc::from(out.into_boxed_slice()))
}

/// `win` of `src` rendered on a `cw × ch` canvas, straight RGBA8.
async fn render_window(
    ctx: &GpuContext,
    cw: u32,
    ch: u32,
    win: Region,
    src: &FillSource,
) -> Result<Vec<u8>, IngestError> {
    let (w, h, ox, oy) = (win.w, win.h, win.x, win.y);
    let zeros = vec![0u8; w as usize * h as usize * 8];
    let out = match src {
        FillSource::Solid { rgb } => {
            let c = rgb.map(|v| f32::from(v) / 255.0);
            let p = GenSolidParams::new(ox, oy, c[0], c[1], c[2], 1.0);
            dispatch(ctx, &GEN_SOLID, &[&zeros], p.as_bytes(), w, h).await?
        }
        FillSource::Gradient(g) => {
            let ((cx, cy), (dx, dy), half) = gradient_geometry(cw, ch, g);
            let (black, white) = ([0.0, 0.0, 0.0, 1.0], [1.0, 1.0, 1.0, 1.0]);
            let angle = dy.atan2(dx);
            let ramp = match g.style {
                GradientKind::Linear => {
                    let p = GenLinearGradientParams::new(
                        ox,
                        oy,
                        cx - dx * half,
                        cy - dy * half,
                        cx + dx * half,
                        cy + dy * half,
                        black,
                        white,
                    );
                    dispatch(ctx, &GEN_LINEAR_GRADIENT, &[&zeros], p.as_bytes(), w, h).await?
                }
                GradientKind::Radial => {
                    let p = GenRadialGradientParams::new(ox, oy, cx, cy, half, black, white);
                    dispatch(ctx, &GEN_RADIAL_GRADIENT, &[&zeros], p.as_bytes(), w, h).await?
                }
                GradientKind::Angular => {
                    let p = GenAngularGradientParams::new(ox, oy, cx, cy, angle, black, white);
                    dispatch(ctx, &GEN_ANGULAR_GRADIENT, &[&zeros], p.as_bytes(), w, h).await?
                }
                GradientKind::Reflected => {
                    let p = GenReflectedGradientParams::new(
                        ox,
                        oy,
                        cx,
                        cy,
                        cx + dx * half,
                        cy + dy * half,
                        black,
                        white,
                    );
                    dispatch(ctx, &GEN_REFLECTED_GRADIENT, &[&zeros], p.as_bytes(), w, h).await?
                }
                GradientKind::Diamond => {
                    let p =
                        GenDiamondGradientParams::new(ox, oy, cx, cy, angle, half, black, white);
                    dispatch(ctx, &GEN_DIAMOND_GRADIENT, &[&zeros], p.as_bytes(), w, h).await?
                }
            };
            let stops = stop_ramp(&g.stops, g.reverse);
            let p = AdjustGradientMapParams::from_fn(|t| {
                stops[((t * 255.0).round() as usize).min(255)]
            });
            dispatch(ctx, &ADJUST_GRADIENT_MAP, &[&ramp], p.as_bytes(), w, h).await?
        }
        FillSource::Pattern(pat) => {
            // The tile, premultiplied (the pattern's source-over is), into
            // a canvas-sized zero-padded input; its real extent travels in
            // the params.
            let (tw, th) = (pat.width.min(cw), pat.height.min(ch));
            if tw > w || th > h {
                return Err(IngestError::Unsupported(format!(
                    "a {tw}×{th} pattern tile does not fit a {w}×{h} band"
                )));
            }
            let mut tile = vec![0u8; w as usize * h as usize * 8];
            for y in 0..th as usize {
                for x in 0..tw as usize {
                    let s = (y * pat.width as usize + x) * 4;
                    let d = (y * w as usize + x) * 8;
                    let a = f32::from(pat.tile[s + 3]) / 255.0;
                    for c in 0..4 {
                        let v = f32::from(pat.tile[s + c]) / 255.0;
                        let v = if c < 3 { v * a } else { v };
                        tile[d + c * 2..d + c * 2 + 2]
                            .copy_from_slice(&f16::from_f32(v).to_le_bytes());
                    }
                }
            }
            let p = GenPatternParams::new(
                ox,
                oy,
                (pat.scale / 100.0).max(0.01),
                pat.angle,
                0.0,
                0.0,
                1.0,
                tw,
                th,
            );
            let premul = dispatch(ctx, &GEN_PATTERN, &[&zeros, &tile], p.as_bytes(), w, h).await?;
            dispatch(
                ctx,
                &CAST_UNPREMULTIPLY,
                &[&premul],
                CastUnpremultiplyParams::new().as_bytes(),
                w,
                h,
            )
            .await?
        }
    };
    Ok(f16_to_rgba8(&out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layers::kinds::ColorStop;

    fn fill(angle: f32, scale: f32) -> GradientFill {
        GradientFill {
            style: GradientKind::Linear,
            angle,
            scale,
            reverse: false,
            offset: (0.0, 0.0),
            stops: vec![
                ColorStop {
                    at: 0.0,
                    rgb: [0, 0, 0],
                },
                ColorStop {
                    at: 1.0,
                    rgb: [255, 255, 255],
                },
            ],
        }
    }

    /// 90° runs bottom to top across the whole height at 100 %; 0° across
    /// the width; the scale shortens it.
    #[test]
    #[allow(non_snake_case)]
    fn a_gradient_fill_spans_the_canvas_at_its_angle__feat__image_layers_photoshop_parity() {
        let ((cx, cy), (dx, dy), half) = gradient_geometry(200, 100, &fill(90.0, 100.0));
        assert_eq!((cx, cy), (100.0, 50.0));
        assert!(dx.abs() < 1e-6 && (dy + 1.0).abs() < 1e-6, "up is −y");
        assert!((half - 50.0).abs() < 1e-3);
        let (_, _, half) = gradient_geometry(200, 100, &fill(0.0, 100.0));
        assert!((half - 100.0).abs() < 1e-3);
        let (_, _, half) = gradient_geometry(200, 100, &fill(0.0, 50.0));
        assert!((half - 50.0).abs() < 1e-3);
    }

    #[test]
    #[allow(non_snake_case)]
    fn fills_render_on_the_gpu__feat__image_layers_photoshop_parity() {
        let Some(ctx) = image_gpu::test_support::device_or_skip("fill layers") else {
            return;
        };
        let solid = pollster::block_on(render_fill(
            ctx,
            4,
            2,
            &FillSource::Solid { rgb: [10, 200, 30] },
        ))
        .expect("solid");
        assert!(solid.chunks(4).all(|p| p == [10, 200, 30, 255]));
        // A 0° black→white linear fill: dark on the left, light on the right.
        let g = pollster::block_on(render_fill(
            ctx,
            16,
            1,
            &FillSource::Gradient(fill(0.0, 100.0)),
        ))
        .expect("gradient");
        assert!(g[0] < 20 && g[15 * 4] > 235, "{:?}", &g[..]);
        assert!(g.chunks(4).all(|p| p[3] == 255));
        let mid = g[8 * 4];
        assert!((110..=150).contains(&mid), "{mid}");
    }
}

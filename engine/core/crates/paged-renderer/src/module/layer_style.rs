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

//! Engine ADR 1099 — a frame's LAYER-STYLE entries (`EffectConvention::
//! LayerStyle`), drawn by the layer-style evaluator (`paged-layer-fx`) on
//! its CPU device, as paged.image draws them.
//!
//! A layer style works on the layer's ALPHA: here the frame's picture as
//! the body drew it (the first `Image` of the run), on the picture's own
//! pixel grid, or — a frame without one — its outline's coverage at two
//! pixels per point. The grid is padded by how far the effects reach, the
//! evaluator plans the entries and draws them: the exterior effects and
//! the top ones (the bevel) as RGBA plates in their own effect layers (blend
//! mode, opacity) under and over the run; the interior ones as Photoshop's
//! BODY — at fill 100 % blended onto the layer made opaque, the result
//! replacing the picture through the layer's shape; below it, as plates over
//! the picture through the shape. Everything is a raster, so every lane
//! (both rasterisers, PDF) draws it as it draws a picture.

use paged_compose::{DecodedImage, DisplayCommand, LayerEffect, Rect, Transform};
use paged_layer_fx::cpu::{CpuDevice, CpuTex};
use paged_layer_fx::plan::{Fx, FxPlan, Light, PatternTile};
use paged_layer_fx::{
    paints_native as paints, source_alpha_native as source_alpha, EffectStep, Frame, FxPaint,
    Source,
};
use paged_model::effect_stack::{EffectEntry, IndesignEffect, IndesignParams};
use paged_model::{DropShadowSetting, FrameEffects, Graphic};

use crate::pipeline::{BuiltPage, ColorCtx};

/// Pixels per point of a frame without a picture.
const VECTOR_PX_PER_PT: f32 = 2.0;

/// The largest grid (padded) the evaluator draws on; a larger picture is
/// drawn without its layer-style effects rather than stall a render.
const MAX_GRID_PX: u64 = 16_000_000;

/// The entries the evaluator draws, each with its parameters: the slot's
/// for the first enabled instance of an InDesign kind, the entry's own
/// for a further one (engine ADR 1099).
pub(crate) fn with_params(
    stack: &[EffectEntry],
    effects: Option<&FrameEffects>,
    drop_shadow: Option<&DropShadowSetting>,
) -> Vec<(EffectEntry, Option<IndesignParams>)> {
    use IndesignParams as P;
    let slot = |k: IndesignEffect| -> Option<IndesignParams> {
        let e = effects;
        match k {
            IndesignEffect::DropShadow => drop_shadow.cloned().map(P::DropShadow),
            IndesignEffect::InnerShadow => e?.inner_shadow.clone().map(P::InnerShadow),
            IndesignEffect::OuterGlow => e?.outer_glow.clone().map(P::OuterGlow),
            IndesignEffect::InnerGlow => e?.inner_glow.clone().map(P::InnerGlow),
            IndesignEffect::BevelEmboss => e?.bevel.clone().map(P::BevelEmboss),
            IndesignEffect::Satin => e?.satin.clone().map(P::Satin),
            _ => None,
        }
    };
    let mut first = std::collections::HashSet::new();
    stack
        .iter()
        .filter(|e| e.is_layer_style())
        .map(|e| {
            let params = match e.effect.indesign() {
                Some(k) if first.insert(k) && e.enabled => slot(k),
                Some(_) => e.effect.carried(),
                None => None,
            };
            (e.clone(), params)
        })
        .collect()
}

/// What a frame's layer style draws: under the run and over it.
pub(crate) struct Drawn {
    pub under: Vec<DisplayCommand>,
    pub over: Vec<DisplayCommand>,
}

/// The layer's alpha as the evaluator reads it: premultiplied texels on a
/// grid `w × h` whose pixel `(x, y)` lands on the page at
/// `to_page.apply(x, y)`.
struct Layer {
    /// The picture's `Image` command in the page's list, when the layer is
    /// a picture.
    command: Option<usize>,
    w: u32,
    h: u32,
    rgba: Vec<[f32; 4]>,
    to_page: Transform,
    px_per_pt: f32,
}

/// The picture the run draws, decoded, with its pixel-to-page transform.
fn picture(page: &BuiltPage, run: std::ops::Range<usize>) -> Option<Layer> {
    let start = run.start;
    let (at, id, transform) =
        page.list.commands[run]
            .iter()
            .enumerate()
            .find_map(|(i, c)| match c {
                DisplayCommand::Image {
                    image_id,
                    transform,
                } => Some((start + i, *image_id, *transform)),
                _ => None,
            })?;
    let img = page.list.image(id)?;
    let decoded;
    let (w, h, rgba): (u32, u32, &[u8]) = if img.rgba.is_empty() {
        decoded = crate::pipeline::decode_image_bytes_with(
            &img.encoded,
            img.width.max(img.height),
            img.rendering.unwrap_or_default(),
        )?;
        (decoded.width, decoded.height, &decoded.rgba[..])
    } else {
        (img.width, img.height, &img.rgba[..])
    };
    if w == 0 || h == 0 || rgba.len() != w as usize * h as usize * 4 {
        return None;
    }
    // The command's transform maps the picture's UNIT square onto the
    // page; a pixel of the decoded grid is `1/w × 1/h` of it.
    let to_page = transform.compose(&Transform([
        1.0 / w as f32,
        0.0,
        0.0,
        1.0 / h as f32,
        0.0,
        0.0,
    ]));
    let t = to_page.0;
    let pt_per_px = (t[0] * t[3] - t[1] * t[2]).abs().sqrt();
    if !(pt_per_px.is_finite() && pt_per_px > 0.0) {
        return None;
    }
    let texels = rgba
        .as_chunks::<4>()
        .0
        .iter()
        .map(|p| {
            let a = f32::from(p[3]) / 255.0;
            [0, 1, 2]
                .map(|c| f32::from(p[c]) / 255.0 * a)
                .into_iter()
                .chain([a])
                .collect::<Vec<_>>()
                .try_into()
                .unwrap_or([0.0; 4])
        })
        .collect();
    Some(Layer {
        command: Some(at),
        w,
        h,
        rgba: texels,
        to_page,
        px_per_pt: 1.0 / pt_per_px,
    })
}

/// A frame without a picture: its outline's coverage.
fn outline(page: &BuiltPage, geom: &super::effect_stack::StackGeometry) -> Option<Layer> {
    let path = page.list.paths.get(geom.outline)?;
    let grid =
        paged_compose::mask::Grid::for_path(path, &geom.outer, 0.0, VECTOR_PX_PER_PT * 72.0)?;
    let cov = paged_compose::mask::MaskRaster::interior(grid, path, &geom.outer, (0.0, 0.0));
    let rgba = cov
        .data
        .iter()
        .map(|&v| {
            let a = f32::from(v) / 255.0;
            [a, a, a, a]
        })
        .collect();
    let s = 1.0 / grid.scale;
    Some(Layer {
        command: None,
        w: grid.width_px,
        h: grid.height_px,
        rgba,
        to_page: Transform([s, 0.0, 0.0, s, grid.origin_pt.0, grid.origin_pt.1]),
        px_per_pt: grid.scale,
    })
}

/// Draw `entries` (from [`with_params`]) for the frame whose body the
/// commands `run` drew. `fill` is the layer's fill opacity (the content
/// target's), `seed` the noise stream's.
#[allow(clippy::too_many_arguments)]
pub(crate) fn draw(
    page: &mut BuiltPage,
    run: std::ops::Range<usize>,
    entries: &[(EffectEntry, Option<IndesignParams>)],
    geom: &super::effect_stack::StackGeometry,
    palette: &Graphic,
    color_ctx: ColorCtx<'_>,
    fill: f32,
    seed: u32,
) -> Option<Drawn> {
    let layer = picture(page, run).or_else(|| outline(page, geom))?;
    // A layer style's colours are sRGB swatches: their values as they
    // are; another space through the document's colour settings (whose
    // paint is in the rasteriser's working space, so it is encoded back).
    let color = |id: Option<&str>| -> [u8; 3] {
        let entry = id.and_then(|id| palette.resolve(id));
        if let Some(e) =
            entry.filter(|e| e.space == paged_model::ColorSpace::Rgb && e.value.len() == 3)
        {
            return [0, 1, 2].map(|i| e.value[i].round().clamp(0.0, 255.0) as u8);
        }
        let paint = entry.and_then(|e| crate::pipeline::color_entry_to_paint(e, color_ctx));
        match paint {
            Some(paged_compose::Paint::Solid(c)) => {
                [c.r, c.g, c.b].map(|v| (v.clamp(0.0, 1.0) * 255.0).round() as u8)
            }
            _ => [0, 0, 0],
        }
    };
    let plan = FxPlan::of(entries, layer.px_per_pt, &color);
    if plan.is_empty() {
        return None;
    }
    let reach = plan
        .all()
        .map(|fx| fx.reach(plan.stroke_reach))
        .fold(0.0f32, f32::max);
    let pad = reach.ceil() as u32 + 2;
    let (w, h) = (layer.w + 2 * pad, layer.h + 2 * pad);
    if u64::from(w) * u64::from(h) > MAX_GRID_PX {
        return None;
    }
    let mut texels = vec![[0.0f32; 4]; w as usize * h as usize];
    for y in 0..layer.h {
        let src = (y * layer.w) as usize;
        let dst = ((y + pad) * w + pad) as usize;
        texels[dst..dst + layer.w as usize]
            .copy_from_slice(&layer.rgba[src..src + layer.w as usize]);
    }
    let frame = Frame::whole(w, h);
    let mut dev = CpuDevice::new(frame);
    let plate = CpuTex::new(w, h, texels);
    let alpha = source_alpha(&mut dev, &plate, None).ok()?;
    let shape: Vec<f32> = alpha.px.iter().map(|p| p[0]).collect();
    let mut src = Source::new(alpha);
    let bounds = {
        let a8: Vec<u8> = shape
            .iter()
            .flat_map(|&a| [0, 0, 0, (a * 255.0).round() as u8])
            .collect();
        paged_layer_fx::alpha_bounds(&a8, w, h)
    };
    let light = Light {
        angle: color_ctx.global_light_angle.unwrap_or(120.0),
        altitude: color_ctx.global_light_altitude.unwrap_or(30.0),
    };
    // Pixel (x, y) of the padded grid on the page.
    let to_page = layer
        .to_page
        .compose(&Transform::translate(-(pad as f32), -(pad as f32)));
    let page_rect = {
        let pts = [
            (0.0, 0.0),
            (w as f32, 0.0),
            (0.0, h as f32),
            (w as f32, h as f32),
        ]
        .map(|(x, y)| to_page.apply(x, y));
        let (x0, x1) = pts
            .iter()
            .fold((f32::MAX, f32::MIN), |(a, b), p| (a.min(p.0), b.max(p.0)));
        let (y0, y1) = pts
            .iter()
            .fold((f32::MAX, f32::MIN), |(a, b), p| (a.min(p.1), b.max(p.1)));
        Rect {
            x: x0,
            y: y0,
            w: x1 - x0,
            h: y1 - y0,
        }
    };
    let mut out = Drawn {
        under: Vec::new(),
        over: Vec::new(),
    };
    let step_of = |fx: &Fx| EffectStep {
        pattern: fx.pattern().and_then(|p| p.tile.as_ref()).map(|t| {
            std::sync::Arc::new(PatternTile {
                width: t.width,
                height: t.height,
                rgba: t.rgba.clone().into(),
            })
        }),
        fx: fx.clone(),
        light,
        bounds,
        seed,
        fill,
        stroke_reach: plan.stroke_reach,
    };
    // THE BODY. At fill 100 % a layer's interior effects blend onto the
    // layer itself (made opaque), and the result shows through the layer's
    // shape — Photoshop's body: the picture is replaced by that result, so
    // an anti-aliased edge mixes the effects with the backdrop exactly as
    // Photoshop's does. Below 100 % the body involves the backdrop, which a
    // display list cannot read here: the interior plates are drawn over
    // the picture through the layer's shape instead.
    let interior: Vec<&Fx> = plan.interior.iter().chain(&plan.interior_top).collect();
    let body = layer
        .command
        .filter(|_| fill >= 1.0 && !interior.is_empty());
    if let Some(at) = body {
        let opaque: Vec<[f32; 4]> = plate
            .px
            .iter()
            .map(|c| {
                if c[3] > 0.0 {
                    [c[0] / c[3], c[1] / c[3], c[2] / c[3], 1.0]
                } else {
                    [0.0, 0.0, 0.0, 1.0]
                }
            })
            .collect();
        let mut acc = CpuTex::new(w, h, opaque);
        for fx in &interior {
            if let Ok(next) = paged_layer_fx::draw_native(&mut dev, &acc, &mut src, &step_of(fx)) {
                acc = next;
            }
        }
        let mut rgba = Vec::with_capacity(layer.w as usize * layer.h as usize * 4);
        for y in pad..pad + layer.h {
            for x in pad..pad + layer.w {
                let i = (y * w + x) as usize;
                let c = acc.px[i];
                let a = c[3].max(1e-6);
                let q = |v: f32| ((v / a).clamp(0.0, 1.0) * 255.0).round() as u8;
                rgba.extend_from_slice(&[
                    q(c[0]),
                    q(c[1]),
                    q(c[2]),
                    (shape[i] * 255.0).round() as u8,
                ]);
            }
        }
        let id = page.list.push_image(DecodedImage {
            width: layer.w,
            height: layer.h,
            encoded: bytes::Bytes::new(),
            rgba: bytes::Bytes::from(rgba),
            icc: None,
            rendering: None,
        });
        if let Some(DisplayCommand::Image { image_id, .. }) = page.list.commands.get_mut(at) {
            *image_id = id;
        }
    }
    let places: [(&Vec<Fx>, bool, bool); 4] = [
        (&plan.exterior, false, false),
        (&plan.interior, true, true),
        (&plan.interior_top, true, true),
        (&plan.top, true, false),
    ];
    for (list, over, clip) in places {
        if body.is_some() && clip {
            continue;
        }
        for fx in list {
            let step = EffectStep {
                pattern: fx.pattern().and_then(|p| p.tile.as_ref()).map(|t| {
                    std::sync::Arc::new(PatternTile {
                        width: t.width,
                        height: t.height,
                        rgba: t.rgba.clone().into(),
                    })
                }),
                fx: fx.clone(),
                light,
                bounds,
                seed,
                fill,
                stroke_reach: plan.stroke_reach,
            };
            let Ok(ps) = paints(&mut dev, &mut src, &step) else {
                continue;
            };
            for p in ps {
                let cmds = plate_commands(
                    page,
                    &p,
                    clip.then_some(&shape[..]),
                    w,
                    h,
                    to_page,
                    page_rect,
                );
                if over {
                    out.over.extend(cmds);
                } else {
                    out.under.extend(cmds);
                }
            }
        }
    }
    Some(out)
}

/// One plate as an image in its own effect layer: premultiplied colour
/// times its mask (and the layer's shape for an interior effect), as
/// straight RGBA8.
fn plate_commands(
    page: &mut BuiltPage,
    p: &FxPaint<CpuTex>,
    shape: Option<&[f32]>,
    w: u32,
    h: u32,
    to_page: Transform,
    page_rect: Rect,
) -> Vec<DisplayCommand> {
    let mut rgba = Vec::with_capacity(w as usize * h as usize * 4);
    let mut any = false;
    for (i, c) in p.plate.px.iter().enumerate() {
        let m = p.mask.as_ref().map_or(1.0, |m| m.px[i][0]) * shape.map_or(1.0, |s| s[i]);
        let a = (c[3] * m).clamp(0.0, 1.0);
        if a > 0.0 {
            any = true;
            let un = |v: f32| ((v * m / a).clamp(0.0, 1.0) * 255.0).round() as u8;
            rgba.extend_from_slice(&[un(c[0]), un(c[1]), un(c[2]), (a * 255.0).round() as u8]);
        } else {
            rgba.extend_from_slice(&[0, 0, 0, 0]);
        }
    }
    if !any || p.opacity <= 0.0 {
        return Vec::new();
    }
    let id = page.list.push_image(DecodedImage {
        width: w,
        height: h,
        encoded: bytes::Bytes::new(),
        rgba: bytes::Bytes::from(rgba),
        icc: None,
        rendering: None,
    });
    vec![
        DisplayCommand::PushLayer {
            bounds: page_rect,
            effect: LayerEffect::None,
            blend_mode: p.blend,
            opacity: p.opacity,
            transform: Transform::IDENTITY,
        },
        // An `Image` maps its unit square: the plate's `w × h` pixels.
        DisplayCommand::Image {
            image_id: id,
            transform: to_page.compose(&Transform([w as f32, 0.0, 0.0, h as f32, 0.0, 0.0])),
        },
        DisplayCommand::PopLayer(Transform::IDENTITY),
    ]
}

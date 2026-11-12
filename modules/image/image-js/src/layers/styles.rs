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

//! LAYER STYLES in the fold (WP5.4): each effect of a layer's style is a
//! step around the layer's own pixels. The effects are the engine's
//! layer-style evaluator's (`paged-layer-fx`, engine ADR 1099): the
//! layer's style crosses the PSD boundary onto the effect stack
//! (`paged-psd-fx`, lossless) and the evaluator plans and draws it — on the
//! GPU here, its `style.*`, `gen.*` and `compose.*` dispatches run by the
//! fold's batch ([`Gpu`]); on the CPU in the CPU fold (`fold::cpu`).
//!
//! # The order, and why
//!
//! A styled pixel layer folds as (`LayerStack::plan_fold`):
//!
//! 1. `Save` — the backdrop `B`, when the layer's opacity or a mask that
//!    hides effects will be applied to everything at the end.
//! 2. EXTERIOR effects onto the accumulator, each in its own mode and
//!    opacity: Drop Shadow(s), Outer Glow.
//! 3. The BODY. Without interior effects and clipped layers it is the
//!    layer's own `Pixel` step at its FILL opacity. With them it is a
//!    clipping group whose base is the layer made opaque, closed onto the
//!    backdrop with the layer's mode at its fill opacity but WITHOUT the
//!    layer's shape (`ClipClose { shape: false }`); then the INTERIOR
//!    effects (Pattern, Gradient and Color Overlay, Satin, Inner Glow,
//!    Inner Shadow, bottom up) blend onto that; then `BodyClose` mixes the
//!    result into `B'` (the backdrop with the exterior effects) through the
//!    layer's shape. That is what Photoshop draws: a Normal 100 % overlay on
//!    a soft edge is `mix(B, overlay, α)` (the layer-effects fixtures
//!    agree within a level), and at fill 0 a Multiply Inner Shadow
//!    multiplies the backdrop. With Blend Interior Effects as Group the
//!    interior effects join the group before it closes instead, so the
//!    layer's mode and fill apply to them too.
//! 4. TOP effects: Stroke(s), Bevel & Emboss (highlight, then shadow).
//! 5. `StyleClose` — `mix(B, result, opacity × mask)`: the layer's opacity
//!    fades its effects with it, as a unit (a shadow does not show
//!    through a half-transparent layer), and a mask that hides effects
//!    hides them here. Compositing is linear in the source alpha, so for
//!    an unstyled layer this is exactly blending it at its opacity.
//!
//! An effect's SOURCE is the layer's alpha, times its mask unless the
//! mask hides effects (then the mask applies only at `StyleClose`).
//!
//!
//! # Coverage, light, noise
//!
//! The conventions (a size is a tent of two box blurs, spread and choke
//! go through the signed distance field, a contour after a range remap,
//! noise and jitter from a hashed stream) are the evaluator's, recorded
//! against Photoshop in `image-conformance/tests/it/psd_layer_styles.rs`.

use std::sync::Arc;

use image_gpu::{GpuBatch, GpuContext, Resident, TexFormat};
use image_kernels::KernelDef;
use image_psd::effects::{GlobalLight, LayerStyle};
use paged_layer_fx::plan::{Fx, FxPlan, Light, PatternTile};
use paged_layer_fx::{Frame, FxDevice, FxError, Tex, Textures};

use super::kinds::PatternFill;
use crate::ingest::IngestError;

fn gpu_err(e: image_gpu::GpuError) -> IngestError {
    IngestError::Pipeline(e.to_string())
}

/// A layer's style planned by the engine's evaluator: mapped onto the
/// effect stack at the PSD boundary (in the document's pixels, Scale
/// Effects folded into the sizes), then placed.
pub(super) fn plan(style: &LayerStyle) -> FxPlan {
    let m = paged_psd_fx::map_layer_style(style, &paged_psd_fx::MapOptions::default());
    FxPlan::of(&m.entries(), 1.0, &|id| m.color(id).unwrap_or([0, 0, 0]))
}

/// The document's light, as the evaluator reads it.
pub(super) fn light(l: GlobalLight) -> Light {
    Light {
        angle: l.angle,
        altitude: l.altitude,
    }
}

/// The fold's GPU batch as the evaluator's device: the batch's resident
/// textures behind the evaluator's handles.
pub(super) struct Gpu<'a, 'c> {
    ctx: &'c GpuContext,
    batch: &'a mut GpuBatch<'c>,
    frame: Frame,
    slab: Vec<Resident>,
}

impl<'a, 'c> Gpu<'a, 'c> {
    pub fn new(ctx: &'c GpuContext, batch: &'a mut GpuBatch<'c>, frame: Frame) -> Self {
        Gpu {
            ctx,
            batch,
            frame,
            slab: Vec::new(),
        }
    }
}

/// The evaluator's error as the fold's.
pub(super) fn fx_err(e: FxError) -> IngestError {
    IngestError::Pipeline(e.0)
}

impl Textures for Gpu<'_, '_> {
    type Native = Resident;
    fn put(&mut self, t: Resident) -> Tex {
        self.slab.push(t);
        Tex(self.slab.len() as u32 - 1)
    }
    fn get(&self, t: Tex) -> &Resident {
        &self.slab[t.0 as usize]
    }
}

impl FxDevice for Gpu<'_, '_> {
    fn frame(&self) -> Frame {
        self.frame
    }

    fn run(
        &mut self,
        def: &'static KernelDef,
        inputs: &[&Tex],
        params: &[u8],
        mask: Option<&Tex>,
    ) -> Result<Tex, FxError> {
        let ins: Vec<Resident> = inputs.iter().map(|t| self.get(**t).clone()).collect();
        let ins: Vec<&Resident> = ins.iter().collect();
        let mask = mask.map(|m| self.get(*m).clone());
        let out = self.batch.target(self.frame.w, self.frame.h);
        self.batch
            .dispatch(def, &ins, params, mask.as_ref(), &out)
            .map_err(|e| FxError(gpu_err(e).to_string()))?;
        Ok(self.put(out))
    }

    fn zeros(&mut self) -> Tex {
        let z = self.ctx.zeros(self.frame.w, self.frame.h);
        self.put(z)
    }

    fn upload(&mut self, w: u32, h: u32, f16_rgba: &[u8]) -> Tex {
        let t = self.batch.upload(w, h, TexFormat::Rgba16Float, f16_rgba);
        self.put(t)
    }
}

impl super::LayerStack {
    /// The tile an effect's pattern refers to, from the document's
    /// pattern table (by id, else by name).
    pub(super) fn style_pattern(&self, fx: &Fx) -> Option<Arc<PatternTile>> {
        let want = fx.pattern()?;
        let p = self
            .styles
            .patterns
            .iter()
            .find(|p| !want.pattern_id.is_empty() && p.name == want.pattern_id)
            .or_else(|| {
                self.styles
                    .patterns
                    .iter()
                    .find(|p| p.name == want.pattern_name)
            })?;
        Some(Arc::new(PatternTile {
            width: p.width,
            height: p.height,
            rgba: p.tile.clone(),
        }))
    }
}

impl super::LayerStack {
    /// The document's Global Light and style patterns.
    pub fn style_doc(&self) -> &super::StyleDoc {
        &self.styles
    }
}

fn refuse(why: &str) -> IngestError {
    IngestError::Unsupported(why.to_string())
}

/// THE STYLE VERBS (Layer ▸ Layer Style). Each is one edit; the caller
/// records it (`LayerStack::recorded`), so each is one undo step.
impl super::LayerStack {
    /// Set (or, with `None`, clear) a pixel layer's style. A style coming
    /// in without the descriptors it was read from (the dialog's edit)
    /// keeps the old one's, so a save keeps the keys the model does not
    /// carry.
    pub fn set_style(
        &mut self,
        index: usize,
        style: Option<LayerStyle>,
    ) -> Result<(), IngestError> {
        let layer = self.layer_mut(index)?;
        layer.appearance_editable()?;
        if style.is_some() && !layer.is_pixels() {
            return Err(refuse(
                "a layer style needs a layer with pixels (an adjustment layer has none)",
            ));
        }
        layer.ext.style = style.map(|mut s| {
            if let Some(old) = &layer.ext.style {
                s.adopt_sources(old);
            }
            Arc::new(s)
        });
        Ok(())
    }

    /// The same style on several layers at once (Paste Layer Style).
    pub fn paste_style(
        &mut self,
        indices: &[usize],
        style: &LayerStyle,
    ) -> Result<(), IngestError> {
        for &i in indices {
            self.set_style(i, Some(style.clone()))?;
        }
        Ok(())
    }

    /// Blending Options ▸ Advanced Blending's style switches.
    pub fn set_style_options(
        &mut self,
        index: usize,
        o: super::StyleOptions,
    ) -> Result<(), IngestError> {
        let layer = self.layer_mut(index)?;
        layer.appearance_editable()?;
        layer.ext.style_options = o;
        Ok(())
    }

    /// Layer ▸ Layer Style ▸ Global Light: the angle and altitude every
    /// effect with Use Global Light shares.
    pub fn set_global_light(&mut self, light: GlobalLight) -> Result<(), IngestError> {
        if !(light.angle.is_finite() && light.altitude.is_finite()) {
            return Err(refuse("a global light needs a finite angle and altitude"));
        }
        self.styles.global_light = GlobalLight {
            angle: ((light.angle + 180.0).rem_euclid(360.0)) - 180.0,
            altitude: light.altitude.clamp(0.0, 90.0),
        };
        Ok(())
    }

    /// Layer ▸ Layer Style ▸ Scale Effects: every size and distance of the
    /// layer's style by `percent`.
    pub fn scale_effects(&mut self, index: usize, percent: f32) -> Result<(), IngestError> {
        let layer = self.layer_mut(index)?;
        layer.appearance_editable()?;
        let Some(style) = &layer.ext.style else {
            return Err(refuse("the layer has no style to scale"));
        };
        let mut s = (**style).clone();
        s.scale = percent.clamp(1.0, 1000.0);
        layer.ext.style = Some(Arc::new(s));
        Ok(())
    }

    /// Layer ▸ Layer Style ▸ Hide All Effects / Show All Effects: the
    /// style's master switch.
    pub fn set_effects_visible(&mut self, index: usize, on: bool) -> Result<(), IngestError> {
        let layer = self.layer_mut(index)?;
        layer.appearance_editable()?;
        let Some(style) = &layer.ext.style else {
            return Err(refuse("the layer has no style"));
        };
        let mut s = (**style).clone();
        s.enabled = on;
        layer.ext.style = Some(Arc::new(s));
        Ok(())
    }

    /// Add (or replace, by name) a pattern the styles can draw.
    pub fn define_style_pattern(&mut self, p: PatternFill) -> Result<(), IngestError> {
        if p.width == 0 || p.height == 0 || p.tile.len() != p.width as usize * p.height as usize * 4
        {
            return Err(refuse("a style pattern needs a non-empty, RGBA8 tile"));
        }
        let p = Arc::new(p);
        match self.styles.patterns.iter_mut().find(|q| q.name == p.name) {
            Some(slot) => *slot = p,
            None => self.styles.patterns.push(p),
        }
        Ok(())
    }
}

/// A style from the dialog's JSON (`paged-psd`'s model, serde form);
/// `null` or empty is no style.
pub fn style_from_json(json: &str) -> Result<Option<LayerStyle>, IngestError> {
    let t = json.trim();
    if t.is_empty() || t == "null" {
        return Ok(None);
    }
    serde_json::from_str(t)
        .map(Some)
        .map_err(|e| IngestError::Decode(format!("layer style: {e}")))
}

/// The style as the dialog's JSON (`null` for none).
pub fn style_to_json(style: Option<&LayerStyle>) -> String {
    match style {
        None => "null".into(),
        Some(s) => serde_json::to_string(s).unwrap_or_else(|_| "null".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layers::{LayerStack, StyleOptions};
    use image_core::Region;
    use image_psd::effects::{BlendMode, ColorFill, Shadow, Stroke, StrokeFill};

    fn device() -> Option<&'static GpuContext> {
        image_gpu::test_support::device_or_skip("layer styles")
    }

    const W: u32 = 32;
    const H: u32 = 32;

    /// White background, a red square (8..24) on a layer above.
    fn square() -> LayerStack {
        let white: Vec<u8> = (0..W * H).flat_map(|_| [255u8, 255, 255, 255]).collect();
        let mut s =
            LayerStack::from_image(W, H, Arc::from(white.into_boxed_slice())).expect("stack");
        let px: Vec<u8> = (0..W * H)
            .flat_map(|i| {
                let (x, y) = (i % W, i / W);
                if (8..24).contains(&x) && (8..24).contains(&y) {
                    [200u8, 0, 0, 255]
                } else {
                    [0, 0, 0, 0]
                }
            })
            .collect();
        s.add("square");
        s.edit_active(
            "p",
            Region::new(0, 0, W, H),
            crate::pixels::Pixels::from_rgba8(Arc::from(px.into_boxed_slice())),
        )
        .expect("paint");
        s
    }

    fn fold(s: &LayerStack, ctx: &GpuContext) -> Arc<[u8]> {
        pollster::block_on(s.composite(Some(ctx), None)).expect("composite")
    }

    fn at(px: &[u8], x: u32, y: u32) -> [u8; 4] {
        let i = ((y * W + x) * 4) as usize;
        [px[i], px[i + 1], px[i + 2], px[i + 3]]
    }

    fn shadow() -> LayerStyle {
        LayerStyle {
            drop_shadows: vec![Shadow {
                blend: BlendMode::Normal,
                opacity: 100.0,
                use_global_light: false,
                angle: -90.0,
                distance: 4.0,
                size: 0.0,
                ..Shadow::drop_default()
            }],
            ..LayerStyle::default()
        }
    }

    #[test]
    #[allow(non_snake_case)]
    fn a_drop_shadow_falls_opposite_the_light_and_is_one_undo_step__feat__image_layers_styles() {
        let Some(ctx) = device() else { return };
        let mut s = square();
        let top = s.len() - 1;
        let before = fold(&s, ctx);
        s.recorded("Layer Style", None, |s| s.set_style(top, Some(shadow())))
            .expect("style");
        let out = fold(&s, ctx);
        // Light from below (−90°): the shadow falls 4 px up, above the square.
        assert_eq!(at(&out, 16, 5), [0, 0, 0, 255]);
        assert_eq!(at(&out, 16, 26), [255, 255, 255, 255], "nothing below");
        assert_eq!(
            at(&out, 16, 16),
            [200, 0, 0, 255],
            "the layer covers its shadow"
        );
        s.undo().expect("undo");
        assert_eq!(fold(&s, ctx)[..], before[..]);
    }

    #[test]
    #[allow(non_snake_case)]
    fn layer_opacity_fades_the_layer_and_its_effects_as_one__feat__image_layers_styles() {
        let Some(ctx) = device() else { return };
        let mut s = square();
        let top = s.len() - 1;
        s.set_style(top, Some(shadow())).expect("style");
        s.layer_mut(top).expect("layer").opacity = 0.5;
        let out = fold(&s, ctx);
        let near = |a: [u8; 4], b: [u8; 4]| a.iter().zip(b).all(|(x, y)| x.abs_diff(y) <= 1);
        // The shadow under the square does not show through it.
        assert!(
            near(at(&out, 16, 16), [228, 128, 128, 255]),
            "{:?}",
            at(&out, 16, 16)
        );
        assert!(
            near(at(&out, 16, 5), [128, 128, 128, 255]),
            "{:?}",
            at(&out, 16, 5)
        );
    }

    #[test]
    #[allow(non_snake_case)]
    fn an_overlay_and_a_stroke_draw_and_fill_opacity_spares_them__feat__image_layers_styles() {
        let Some(ctx) = device() else { return };
        let mut s = square();
        let top = s.len() - 1;
        let style = LayerStyle {
            color_overlays: vec![ColorFill {
                color: [0, 0, 255],
                ..ColorFill::default()
            }],
            strokes: vec![Stroke {
                size: 2.0,
                fill: StrokeFill::Color { rgb: [0, 255, 0] },
                ..Stroke::default()
            }],
            ..LayerStyle::default()
        };
        s.set_style(top, Some(style)).expect("style");
        s.set_fill_opacity(top, 0.0).expect("fill");
        let out = fold(&s, ctx);
        assert_eq!(
            at(&out, 16, 16),
            [0, 0, 255, 255],
            "the overlay ignores fill"
        );
        assert_eq!(
            at(&out, 6, 16),
            [0, 255, 0, 255],
            "the stroke outside the edge"
        );
        assert_eq!(at(&out, 3, 16), [255, 255, 255, 255]);
    }

    #[test]
    #[allow(non_snake_case)]
    fn styles_survive_persistence_and_json__feat__image_layers_styles() {
        let mut s = square();
        let top = s.len() - 1;
        s.set_style(top, Some(shadow())).expect("style");
        s.set_style_options(
            top,
            StyleOptions {
                blend_interior: true,
                ..StyleOptions::default()
            },
        )
        .expect("options");
        s.set_global_light(GlobalLight {
            angle: 45.0,
            altitude: 60.0,
        })
        .expect("light");
        let (manifest, buffers) = s.export();
        let back = LayerStack::import(&manifest, &buffers).expect("import");
        let l = &back.layers()[top];
        assert_eq!(
            l.ext.style.as_deref().map(|s| s.drop_shadows.len()),
            Some(1)
        );
        assert!(l.ext.style_options.blend_interior);
        assert_eq!(back.style_doc().global_light.angle, 45.0);
        let json = style_to_json(l.ext.style.as_deref());
        let again = style_from_json(&json).expect("json").expect("a style");
        assert_eq!(again.drop_shadows[0].distance, 4.0);
        assert!(style_from_json("null").expect("null").is_none());
        assert!(style_from_json("{\"dropShadows\": 3}").is_err());
    }

    #[test]
    #[allow(non_snake_case)]
    fn each_style_verb_is_one_undo_step__feat__image_layers_styles() {
        let mut s = square();
        let top = s.len() - 1;
        let depth = |s: &LayerStack| s.history().depth;
        let d0 = depth(&s);
        s.recorded("Layer Style", None, |s| s.set_style(top, Some(shadow())))
            .unwrap();
        s.recorded("Scale Effects", None, |s| s.scale_effects(top, 50.0))
            .unwrap();
        s.recorded("Hide All Effects", None, |s| {
            s.set_effects_visible(top, false)
        })
        .unwrap();
        s.recorded("Global Light", None, |s| {
            s.set_global_light(GlobalLight {
                angle: 10.0,
                altitude: 20.0,
            })
        })
        .unwrap();
        s.recorded("Paste Layer Style", None, |s| {
            s.paste_style(&[top], &shadow())
        })
        .unwrap();
        assert_eq!(depth(&s), d0 + 5);
        for _ in 0..5 {
            s.undo().unwrap();
        }
        assert!(s.layers()[top].ext.style.is_none());
        // An adjustment layer takes no style.
        assert!(
            s.set_style(0, Some(shadow())).is_ok(),
            "the background is pixels"
        );
    }
}

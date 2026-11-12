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

//! Engine ADR 1099 — "Place PSD layers as frames": the model side of
//! `RequestPsdLayersPlace`. `paged-psd-fx::place` lowers the file's
//! layers; this module writes them as ONE batch of wire mutations onto a
//! page: per layer a frame at the layer's place with its pixels (a PNG
//! `data:` URI), its blend mode, opacity and fill opacity (the frame's
//! content opacity), and its layer style as the frame's effect stack (the
//! full effect state, through the stack path's snapshot lane, so the
//! layer-style parameters arrive whole); the swatches the styles name
//! first; the frames grouped when there are several.

use base64::Engine as _;
use paged_model::effect_stack::{EffectBearing, EffectTarget};
use paged_model::report::{LossEntry, LossSeverity};
use paged_mutate::{GradientSpec, GradientStopSpec, PropertyPath, SwatchSpec, Value};
use paged_wire::{ElementId, Mutation, PageId};
use serde::{Deserialize, Serialize};
use tsify_next::Tsify;

use crate::model::CanvasModel;

/// `RequestPsdLayersPlace` options.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi)]
#[serde(rename_all = "camelCase")]
pub struct PsdPlaceOptions {
    /// The page-local point (pt) the canvas's top-left corner lands on.
    /// Absent: the canvas is centred on the page.
    #[serde(default)]
    pub origin: Option<[f32; 2]>,
    /// Wrap the frames in one group when there are several. Absent: true.
    #[serde(default)]
    pub group: Option<bool>,
}

/// `RequestPsdLayersPlace`'s answer.
#[derive(Debug, Clone, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi)]
#[serde(rename_all = "camelCase")]
pub struct PsdPlacePlan {
    /// The one batch to apply (one undo step), or `None` when the file
    /// has no layer to place or could not be read.
    pub mutation: Option<Mutation>,
    /// How many frames the batch makes.
    pub layers: u32,
    /// What a frame could not carry.
    pub losses: Vec<LossEntry>,
    /// The canvas's size on the page (pt).
    pub width: f32,
    pub height: f32,
    /// Why nothing could be planned.
    pub error: Option<String>,
}

impl PsdPlacePlan {
    fn failed(error: String) -> Self {
        PsdPlacePlan {
            mutation: None,
            layers: 0,
            losses: Vec::new(),
            width: 0.0,
            height: 0.0,
            error: Some(error),
        }
    }
}

fn set(id: &ElementId, path: PropertyPath, value: Value) -> Mutation {
    Mutation::SetElementProperty {
        element_id: id.clone(),
        path,
        value,
    }
}

/// CMYK ink (0 = none) to sRGB through the file's profile, or the naive
/// formula where there is none.
fn ink_to_rgba8(icc: Option<&[u8]>) -> impl Fn(&[u8]) -> Vec<u8> + '_ {
    use paged_raster::ColourConvert;
    move |ink: &[u8]| {
        let cmyk: Vec<[u8; 4]> = ink.as_chunks::<4>().0.to_vec();
        let mut rgb = vec![[0u8; 3]; cmyk.len()];
        if !paged_raster::PagedColour::default().cmyk_to_srgb(icc, &cmyk, &mut rgb) {
            for (o, c) in rgb.iter_mut().zip(&cmyk) {
                let k = 255 - u32::from(c[3]);
                *o = [0, 1, 2].map(|i| ((255 - u32::from(c[i])) * k / 255) as u8);
            }
        }
        rgb.iter().flat_map(|p| [p[0], p[1], p[2], 255]).collect()
    }
}

impl CanvasModel {
    /// Engine ADR 1099 — plan placing the layers of the PSD `bytes` onto
    /// `page_id` as frames: one batch (apply it with `Mutate`, one undo
    /// step) and what the frames could not carry. Reads only.
    pub fn psd_layers_place_plan(
        &self,
        page_id: &PageId,
        bytes: &[u8],
        options: &PsdPlaceOptions,
    ) -> PsdPlacePlan {
        let Some((_, _origin, _)) = self.page_insert_context(page_id) else {
            return PsdPlacePlan::failed(format!("no page {}", page_id.0));
        };
        let icc = paged_psd::PsdFile::parse(bytes).ok().and_then(|f| {
            f.resources
                .data(paged_psd::model::RES_ICC_PROFILE)
                .map(<[u8]>::to_vec)
        });
        let ink = ink_to_rgba8(icc.as_deref());
        let placed = match paged_psd_fx::place::place_layers(bytes, Some(&ink)) {
            Ok(p) => p,
            Err(e) => return PsdPlacePlan::failed(format!("not a PSD this can place: {e}")),
        };
        let size = self
            .pages()
            .into_iter()
            .find(|p| p.self_id == page_id.0)
            .map(|p| p.size_pt)
            .unwrap_or([612.0, 792.0]);
        let origin = options.origin.unwrap_or([
            (size[0] - placed.width_pt) / 2.0,
            (size[1] - placed.height_pt) / 2.0,
        ]);
        let palette = &self.scene().palette;
        let mut paint_ops: Vec<Mutation> = Vec::new();
        let mut ops: Vec<Mutation> = Vec::new();
        let mut made: Vec<ElementId> = Vec::new();
        let mut losses = placed.losses.clone();
        let mut swatches = std::collections::HashSet::new();
        let mut gradients = std::collections::HashSet::new();
        for (n, layer) in placed.layers.iter().enumerate() {
            let png = match paged_raster::encode::encode_rgba8_png(
                &layer.rgba,
                layer.width,
                layer.height,
            ) {
                Ok(p) => p,
                Err(e) => {
                    losses.push(LossEntry::new(
                        "psd.layer",
                        LossSeverity::Dropped,
                        format!("the layer {:?}: {e}", layer.name),
                    ));
                    continue;
                }
            };
            let [l, t, r, b] = layer.bounds_pt;
            ops.push(Mutation::InsertFrame {
                page_id: page_id.clone(),
                bounds: (t + origin[1], l + origin[0], b + origin[1], r + origin[0]),
            });
            let handle = format!("psd{}", n + 1);
            ops.push(Mutation::BindCreated {
                handle: handle.clone(),
            });
            let id = ElementId::Rectangle(format!("$h:{handle}"));
            ops.push(set(
                &id,
                PropertyPath::FrameFillColor,
                Value::ColorRef(None),
            ));
            ops.push(set(
                &id,
                PropertyPath::FrameStrokeColor,
                Value::ColorRef(None),
            ));
            ops.push(set(
                &id,
                PropertyPath::FrameStrokeWeight,
                Value::Length(Some(0.0)),
            ));
            ops.push(Mutation::PlaceImage {
                element_id: format!("$h:{handle}"),
                uri: format!(
                    "data:image/png;base64,{}",
                    base64::engine::general_purpose::STANDARD.encode(&png)
                ),
                fit: Some("ContentToFrame".into()),
            });
            if !layer.name.is_empty() {
                ops.push(set(
                    &id,
                    PropertyPath::ItemName,
                    Value::Text(layer.name.clone()),
                ));
            }
            if layer.blend != "Normal" {
                ops.push(set(
                    &id,
                    PropertyPath::FrameBlendMode,
                    Value::Text(layer.blend.to_string()),
                ));
            }
            if layer.opacity_pct < 100.0 {
                ops.push(set(
                    &id,
                    PropertyPath::FrameOpacity,
                    Value::Length(Some(layer.opacity_pct)),
                ));
            }
            if layer.fill_pct < 100.0 {
                ops.push(set(
                    &id,
                    PropertyPath::FrameContentOpacity,
                    Value::Length(Some(layer.fill_pct)),
                ));
            }
            if let Some(style) = &layer.style {
                for c in &style.colors {
                    if palette.colors.contains_key(&c.self_id)
                        || !swatches.insert(c.self_id.clone())
                    {
                        continue;
                    }
                    paint_ops.push(Mutation::CreateSwatch {
                        spec: SwatchSpec {
                            self_id: Some(c.self_id.clone()),
                            name: c.name.clone(),
                            space: "RGB".into(),
                            value: c.value.clone(),
                            model: None,
                            alternate_space: None,
                            alternate_value: Vec::new(),
                            tint: None,
                            alpha: None,
                            pattern: None,
                            theme_ref: None,
                        },
                    });
                }
                for g in &style.gradients {
                    if palette.gradients.contains_key(&g.self_id)
                        || !gradients.insert(g.self_id.clone())
                    {
                        continue;
                    }
                    paint_ops.push(Mutation::CreateGradient {
                        spec: GradientSpec {
                            self_id: Some(g.self_id.clone()),
                            name: g.name.clone(),
                            kind: "Linear".into(),
                            stops: g
                                .stops
                                .iter()
                                .map(|s| GradientStopSpec {
                                    stop_color: s.stop_color.clone(),
                                    location_pct: s.location_pct,
                                    midpoint_pct: s.midpoint_pct,
                                    opacity_pct: None,
                                    color: None,
                                })
                                .collect(),
                        },
                    });
                }
                // The whole effect state, through the stack path's
                // snapshot lane: the slots with their layer-style
                // parameters and the stack in Photoshop's order.
                let mut item = paged_model::Rectangle::new("psd", paged_model::Bounds::ZERO);
                if item
                    .effect_slots_mut(EffectTarget::Object)
                    .set_stack(style.stack.clone())
                    .is_ok()
                {
                    let state = item.effect_state(EffectTarget::Object);
                    if let Ok(prev) = serde_json::to_string(&state) {
                        ops.push(set(
                            &id,
                            PropertyPath::FrameEffectStack,
                            Value::EffectStack {
                                entries: Vec::new(),
                                prev: Some(prev),
                            },
                        ));
                    }
                }
            }
            made.push(id);
        }
        if made.is_empty() {
            return PsdPlacePlan {
                losses,
                width: placed.width_pt,
                height: placed.height_pt,
                ..PsdPlacePlan::failed("the file has no layer to place".into())
            };
        }
        if made.len() > 1 && options.group.unwrap_or(true) {
            ops.push(Mutation::CreateGroup {
                member_ids: made.clone(),
                clip: false,
            });
            ops.push(Mutation::BindCreated {
                handle: "psd-group".into(),
            });
        }
        let layers = made.len() as u32;
        paint_ops.extend(ops);
        PsdPlacePlan {
            mutation: Some(Mutation::Batch { ops: paint_ops }),
            layers,
            losses,
            width: placed.width_pt,
            height: placed.height_pt,
            error: None,
        }
    }
}

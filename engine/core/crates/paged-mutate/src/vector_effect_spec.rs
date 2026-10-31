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

//! Engine ADR 1042 — the live vector effects on the wire: the flat
//! fields of [`EffectEntrySpec`] each vector kind reads (an absent one
//! takes the kind's default), to and from the model's parameter types.

use paged_model::effect_stack::Effect;
use paged_model::vector_effect::*;

use crate::operation::{EffectEntrySpec, EffectKind};

fn finite(name: &str, v: Option<f32>) -> Result<Option<f32>, String> {
    match v {
        Some(x) if !x.is_finite() => Err(format!("`{name}` must be a finite number")),
        _ => Ok(v),
    }
}

fn clamped(name: &str, v: Option<f32>, lo: f32, hi: f32) -> Result<Option<f32>, String> {
    Ok(finite(name, v)?.map(|x| x.clamp(lo, hi)))
}

fn enum_name<T: serde::Serialize>(v: T) -> String {
    serde_json::to_value(v)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default()
}

fn parse_enum<T: serde::de::DeserializeOwned + Default>(
    name: &str,
    v: Option<&str>,
    allowed: &str,
) -> Result<T, String> {
    match v {
        None | Some("") => Ok(T::default()),
        Some(s) => serde_json::from_value(serde_json::Value::String(s.to_string()))
            .map_err(|_| format!("`{name}` is one of {allowed}, not `{s}`")),
    }
}

impl EffectEntrySpec {
    /// Write a vector effect's parameters into the flat fields.
    pub(crate) fn vector_from_model(&mut self, e: &Effect) {
        match e {
            Effect::Roughen(p) => {
                self.size = Some(p.size);
                self.relative = Some(p.relative);
                self.detail_per_inch = Some(p.detail_per_inch);
                self.smooth = Some(p.smooth);
                self.seed = Some(p.seed);
            }
            Effect::ZigZag(p) => {
                self.size = Some(p.size);
                self.relative = Some(p.relative);
                self.ridges = Some(p.ridges);
                self.smooth = Some(p.smooth);
            }
            Effect::PuckerBloat(p) => self.amount_pct = Some(p.amount_pct),
            Effect::Twist(p) => self.angle_deg = Some(p.angle_deg),
            Effect::Tweak(p) => {
                self.amount_h = Some(p.horizontal);
                self.amount_v = Some(p.vertical);
                self.relative = Some(p.relative);
                self.anchors = Some(p.anchors);
                self.in_handles = Some(p.in_handles);
                self.out_handles = Some(p.out_handles);
                self.seed = Some(p.seed);
            }
            Effect::TransformCopies(p) => {
                self.scale_h_pct = Some(p.scale_h_pct);
                self.scale_v_pct = Some(p.scale_v_pct);
                self.move_h = Some(p.move_h);
                self.move_v = Some(p.move_v);
                self.rotate_deg = Some(p.rotate_deg);
                self.reflect_x = Some(p.reflect_x);
                self.reflect_y = Some(p.reflect_y);
                self.copies = Some(p.copies);
                self.origin = Some(enum_name(p.origin));
            }
            Effect::FreeDistort(p) => self.corners = Some(p.corners.to_vec()),
            Effect::Warp(p) => {
                self.style = Some(enum_name(p.style));
                self.horizontal = Some(p.horizontal);
                self.bend_pct = Some(p.bend_pct);
                self.distort_h_pct = Some(p.distort_h_pct);
                self.distort_v_pct = Some(p.distort_v_pct);
            }
            Effect::OffsetPath(p) => {
                self.offset = Some(p.offset);
                self.join = Some(enum_name(p.join));
                self.miter_limit = Some(p.miter_limit);
            }
            Effect::OutlinePath(_) => {}
            Effect::RoundCorners(p) => self.radius = Some(p.radius),
            Effect::Scribble(p) => {
                self.angle_deg = Some(p.angle_deg);
                self.path_overlap = Some(p.path_overlap);
                self.path_overlap_variation = Some(p.path_overlap_variation);
                self.stroke_width = Some(p.stroke_width);
                self.curviness_pct = Some(p.curviness_pct);
                self.curviness_variation_pct = Some(p.curviness_variation_pct);
                self.spacing = Some(p.spacing);
                self.spacing_variation = Some(p.spacing_variation);
                self.seed = Some(p.seed);
            }
            Effect::ConvertToShape(p) => {
                self.shape = Some(enum_name(p.shape));
                self.relative = Some(p.relative);
                self.extra_width = Some(p.extra_width);
                self.extra_height = Some(p.extra_height);
                self.width = Some(p.width);
                self.height = Some(p.height);
                self.corner_radius = Some(p.corner_radius);
            }
            Effect::Pathfinder(p) => self.op = Some(enum_name(p.op)),
            _ => {}
        }
    }

    /// The model effect of a vector kind.
    pub(crate) fn vector_to_model(&self, kind: EffectKind) -> Result<Effect, String> {
        Ok(match kind {
            EffectKind::Roughen => {
                let d = RoughenParams::default();
                Effect::Roughen(RoughenParams {
                    size: clamped("size", self.size, 0.0, 10_000.0)?.unwrap_or(d.size),
                    relative: self.relative.unwrap_or(d.relative),
                    detail_per_inch: clamped("detailPerInch", self.detail_per_inch, 0.0, 1000.0)?
                        .unwrap_or(d.detail_per_inch),
                    smooth: self.smooth.unwrap_or(d.smooth),
                    seed: self.seed.unwrap_or(d.seed),
                })
            }
            EffectKind::ZigZag => {
                let d = ZigZagParams::default();
                Effect::ZigZag(ZigZagParams {
                    size: clamped("size", self.size, -10_000.0, 10_000.0)?.unwrap_or(d.size),
                    relative: self.relative.unwrap_or(d.relative),
                    ridges: self.ridges.map(|r| r.min(1000)).unwrap_or(d.ridges),
                    smooth: self.smooth.unwrap_or(d.smooth),
                })
            }
            EffectKind::PuckerBloat => Effect::PuckerBloat(PuckerBloatParams {
                amount_pct: clamped("amountPct", self.amount_pct, -200.0, 200.0)?.unwrap_or(0.0),
            }),
            EffectKind::Twist => Effect::Twist(TwistParams {
                angle_deg: clamped("angleDeg", self.angle_deg, -3600.0, 3600.0)?.unwrap_or(0.0),
            }),
            EffectKind::Tweak => {
                let d = TweakParams::default();
                Effect::Tweak(TweakParams {
                    horizontal: clamped("amountH", self.amount_h, 0.0, 10_000.0)?
                        .unwrap_or(d.horizontal),
                    vertical: clamped("amountV", self.amount_v, 0.0, 10_000.0)?
                        .unwrap_or(d.vertical),
                    relative: self.relative.unwrap_or(d.relative),
                    anchors: self.anchors.unwrap_or(d.anchors),
                    in_handles: self.in_handles.unwrap_or(d.in_handles),
                    out_handles: self.out_handles.unwrap_or(d.out_handles),
                    seed: self.seed.unwrap_or(d.seed),
                })
            }
            EffectKind::TransformCopies => {
                let d = TransformCopiesParams::default();
                Effect::TransformCopies(TransformCopiesParams {
                    scale_h_pct: clamped("scaleHPct", self.scale_h_pct, -10_000.0, 10_000.0)?
                        .unwrap_or(d.scale_h_pct),
                    scale_v_pct: clamped("scaleVPct", self.scale_v_pct, -10_000.0, 10_000.0)?
                        .unwrap_or(d.scale_v_pct),
                    move_h: finite("moveH", self.move_h)?.unwrap_or(0.0),
                    move_v: finite("moveV", self.move_v)?.unwrap_or(0.0),
                    rotate_deg: finite("rotateDeg", self.rotate_deg)?.unwrap_or(0.0),
                    reflect_x: self.reflect_x.unwrap_or(false),
                    reflect_y: self.reflect_y.unwrap_or(false),
                    copies: self.copies.map(|c| c.min(1000)).unwrap_or(0),
                    origin: parse_enum(
                        "origin",
                        self.origin.as_deref(),
                        "`topLeft` … `bottomRight` (nine box points)",
                    )?,
                })
            }
            EffectKind::FreeDistort => {
                let corners = match &self.corners {
                    None => FreeDistortParams::identity(),
                    Some(c) if c.len() == 4 => {
                        if c.iter().flatten().any(|v| !v.is_finite()) {
                            return Err("`corners` must be finite".to_string());
                        }
                        [c[0], c[1], c[2], c[3]]
                    }
                    Some(c) => {
                        return Err(format!(
                            "`corners` names four corners (top left, top right, bottom right, bottom left), not {}",
                            c.len()
                        ))
                    }
                };
                Effect::FreeDistort(FreeDistortParams { corners })
            }
            EffectKind::Warp => {
                let d = WarpParams::default();
                Effect::Warp(WarpParams {
                    style: parse_enum(
                        "style",
                        self.style.as_deref(),
                        "Illustrator's fifteen warp styles (`arc` … `twist`)",
                    )?,
                    horizontal: self.horizontal.unwrap_or(d.horizontal),
                    bend_pct: clamped("bendPct", self.bend_pct, -100.0, 100.0)?
                        .unwrap_or(d.bend_pct),
                    distort_h_pct: clamped("distortHPct", self.distort_h_pct, -100.0, 100.0)?
                        .unwrap_or(0.0),
                    distort_v_pct: clamped("distortVPct", self.distort_v_pct, -100.0, 100.0)?
                        .unwrap_or(0.0),
                })
            }
            EffectKind::OffsetPath => {
                let d = OffsetPathParams::default();
                Effect::OffsetPath(OffsetPathParams {
                    offset: clamped("offset", self.offset, -10_000.0, 10_000.0)?
                        .unwrap_or(d.offset),
                    join: parse_enum("join", self.join.as_deref(), "`miter`, `round` or `bevel`")?,
                    miter_limit: clamped("miterLimit", self.miter_limit, 1.0, 500.0)?
                        .unwrap_or(d.miter_limit),
                })
            }
            EffectKind::OutlinePath => Effect::OutlinePath(OutlinePathParams {}),
            EffectKind::RoundCorners => Effect::RoundCorners(RoundCornersParams {
                radius: clamped("radius", self.radius, 0.0, 10_000.0)?
                    .unwrap_or(RoundCornersParams::default().radius),
            }),
            EffectKind::Scribble => {
                let d = ScribbleParams::default();
                Effect::Scribble(ScribbleParams {
                    angle_deg: finite("angleDeg", self.angle_deg)?.unwrap_or(d.angle_deg),
                    path_overlap: clamped("pathOverlap", self.path_overlap, -1000.0, 1000.0)?
                        .unwrap_or(0.0),
                    path_overlap_variation: clamped(
                        "pathOverlapVariation",
                        self.path_overlap_variation,
                        0.0,
                        1000.0,
                    )?
                    .unwrap_or(0.0),
                    stroke_width: clamped("strokeWidth", self.stroke_width, 0.01, 1000.0)?
                        .unwrap_or(d.stroke_width),
                    curviness_pct: clamped("curvinessPct", self.curviness_pct, 0.0, 100.0)?
                        .unwrap_or(d.curviness_pct),
                    curviness_variation_pct: clamped(
                        "curvinessVariationPct",
                        self.curviness_variation_pct,
                        0.0,
                        100.0,
                    )?
                    .unwrap_or(0.0),
                    spacing: clamped("spacing", self.spacing, 0.1, 1000.0)?.unwrap_or(d.spacing),
                    spacing_variation: clamped(
                        "spacingVariation",
                        self.spacing_variation,
                        0.0,
                        1000.0,
                    )?
                    .unwrap_or(0.0),
                    seed: self.seed.unwrap_or(0),
                })
            }
            EffectKind::ConvertToShape => {
                let d = ConvertToShapeParams::default();
                Effect::ConvertToShape(ConvertToShapeParams {
                    shape: parse_enum(
                        "shape",
                        self.shape.as_deref(),
                        "`rectangle`, `roundedRectangle` or `ellipse`",
                    )?,
                    relative: self.relative.unwrap_or(d.relative),
                    extra_width: clamped("extraWidth", self.extra_width, -10_000.0, 10_000.0)?
                        .unwrap_or(0.0),
                    extra_height: clamped("extraHeight", self.extra_height, -10_000.0, 10_000.0)?
                        .unwrap_or(0.0),
                    width: clamped("width", self.width, 0.0, 100_000.0)?.unwrap_or(d.width),
                    height: clamped("height", self.height, 0.0, 100_000.0)?.unwrap_or(d.height),
                    corner_radius: clamped("cornerRadius", self.corner_radius, 0.0, 10_000.0)?
                        .unwrap_or(d.corner_radius),
                })
            }
            EffectKind::Pathfinder => Effect::Pathfinder(PathfinderParams {
                op: parse_enum(
                    "op",
                    self.op.as_deref(),
                    "`add`, `subtract`, `intersect` or `exclude`",
                )?,
            }),
            other => return Err(format!("`{}` is not a vector effect", other.name())),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_vector_kind_round_trips_through_the_spec() {
        for name in VECTOR_KINDS {
            let model = Effect::vector_default(name).unwrap();
            let entry = paged_model::effect_stack::EffectEntry::new(model);
            let spec = EffectEntrySpec::from_model(&entry);
            assert_eq!(spec.kind.name(), name);
            let back = spec.to_model().unwrap();
            assert_eq!(
                format!("{:?}", back.effect),
                format!("{:?}", entry.effect),
                "{name}"
            );
        }
    }

    #[test]
    fn bad_values_are_refused() {
        let mut spec = EffectEntrySpec::new(EffectKind::Warp);
        spec.style = Some("spiral".into());
        assert!(spec.to_model().unwrap_err().contains("style"));
        let mut spec = EffectEntrySpec::new(EffectKind::FreeDistort);
        spec.corners = Some(vec![[0.0, 0.0]]);
        assert!(spec.to_model().is_err());
        let mut spec = EffectEntrySpec::new(EffectKind::Roughen);
        spec.size = Some(f32::NAN);
        assert!(spec.to_model().is_err());
    }
}

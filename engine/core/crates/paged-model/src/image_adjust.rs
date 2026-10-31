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

//! Engine ADR 1037 — the image filter stack of an image frame: quick
//! picture fixes (exposure, levels, curves, hue/saturation, duotone,
//! recolor, black & white, sharpen, blur and a few artistic ones) that a
//! placed picture is drawn through, in order, without opening it in an
//! image editor.
//!
//! The ops are data: the renderer evaluates them on the CPU through the
//! kernel twins of `paged-kernels`, the PDF export embeds the result, and
//! IDML, which has no such construct, keeps the stack in a label and
//! reports it as lost (`IMAGE_ADJUSTMENTS_LABEL`).
//!
//! Every colour value is in the picture's own encoded RGB, 0..=1; every
//! length (a blur radius) in the picture's own pixels, so the look does
//! not change with the size the picture is placed or drawn at.

use serde::{Deserialize, Serialize};

/// The `<KeyValuePair>` label key an IDML export writes the stack under
/// (its JSON form), and the import reads it back from.
pub const IMAGE_ADJUSTMENTS_LABEL: &str = "paged:imageAdjustments";

/// One step of an image frame's filter stack (engine ADR 1037).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "wire", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wire", tsify(into_wasm_abi, from_wasm_abi, missing_as_null))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum RasterOp {
    /// Exposure in stops, applied to the light (a 2.2 decode): +1 doubles
    /// it. `adjust.exposure` on encoded input.
    Exposure { ev: f32 },
    /// Brightness as an offset (−1..=1) and contrast as a slope about
    /// mid-grey (1 the identity). `adjust.brightness_contrast`.
    BrightnessContrast { brightness: f32, contrast: f32 },
    /// Photoshop's Levels: input black and white points, the midtone
    /// gamma (1 the identity), output black and white. `adjust.levels`.
    Levels {
        in_black: f32,
        in_white: f32,
        gamma: f32,
        out_black: f32,
        out_white: f32,
    },
    /// A tone curve through control points `[input, output]` (0..=1),
    /// Photoshop's natural cubic spline, on every channel.
    Curves { points: Vec<[f32; 2]> },
    /// Hue (degrees), saturation and lightness (−1..=1) on the whole
    /// picture. `adjust.hue_saturation`'s master row.
    HueSaturation {
        hue: f32,
        saturation: f32,
        lightness: f32,
    },
    /// Recolour to one hue: the picture's tones in `hue` (degrees) at
    /// `saturation` (0..=1), lightness shifted by `lightness` (−1..=1).
    /// `adjust.hue_saturation`'s colorize.
    Recolor {
        hue: f32,
        saturation: f32,
        lightness: f32,
    },
    /// Two inks: the picture's luminance mapped from `shadow` to
    /// `highlight` (RGB). `adjust.gradient_map` with two stops.
    Duotone {
        shadow: [f32; 3],
        highlight: [f32; 3],
    },
    /// Photoshop's Black & White: a grey mixed from six colour ranges
    /// (its default weights are 0.4, 0.6, 0.4, 0.6, 0.2, 0.8).
    /// `adjust.black_white`.
    BlackWhite {
        reds: f32,
        yellows: f32,
        greens: f32,
        cyans: f32,
        blues: f32,
        magentas: f32,
    },
    /// Unsharp mask: `amount` (1 = 100 %) of the difference from a
    /// Gaussian blur of `radius` pixels (σ, at most 64). `conv.unsharp`.
    Sharpen { amount: f32, radius: f32 },
    /// Gaussian blur of `radius` pixels (σ, at most 64: a wide blur runs
    /// as several passes). `conv.gaussian_h`/`_v`.
    Blur { radius: f32 },
    /// Posterize to `levels` tones per channel (2..). `adjust.posterize`.
    Posterize { levels: f32 },
    /// Black where the luminance is below `level` (0..=1), white above.
    /// `adjust.threshold`.
    Threshold { level: f32 },
    /// A negative (alpha kept).
    Invert,
}

impl RasterOp {
    /// The camelCase name the wire and the label spell the op with.
    pub fn name(&self) -> &'static str {
        match self {
            RasterOp::Exposure { .. } => "exposure",
            RasterOp::BrightnessContrast { .. } => "brightnessContrast",
            RasterOp::Levels { .. } => "levels",
            RasterOp::Curves { .. } => "curves",
            RasterOp::HueSaturation { .. } => "hueSaturation",
            RasterOp::Recolor { .. } => "recolor",
            RasterOp::Duotone { .. } => "duotone",
            RasterOp::BlackWhite { .. } => "blackWhite",
            RasterOp::Sharpen { .. } => "sharpen",
            RasterOp::Blur { .. } => "blur",
            RasterOp::Posterize { .. } => "posterize",
            RasterOp::Threshold { .. } => "threshold",
            RasterOp::Invert => "invert",
        }
    }

    /// Whether every number is finite and in the op's range. A stack
    /// written through the wire is checked with it; the renderer clamps
    /// anyway.
    pub fn is_valid(&self) -> bool {
        let fin = |v: &[f32]| v.iter().all(|x| x.is_finite());
        let unit = |x: f32| (0.0..=1.0).contains(&x);
        let signed = |x: f32| (-1.0..=1.0).contains(&x);
        match *self {
            RasterOp::Exposure { ev } => fin(&[ev]) && ev.abs() <= 20.0,
            RasterOp::BrightnessContrast {
                brightness,
                contrast,
            } => {
                fin(&[brightness, contrast])
                    && signed(brightness)
                    && (0.0..=10.0).contains(&contrast)
            }
            RasterOp::Levels {
                in_black,
                in_white,
                gamma,
                out_black,
                out_white,
            } => {
                fin(&[in_black, in_white, gamma, out_black, out_white])
                    && unit(in_black)
                    && unit(in_white)
                    && in_black < in_white
                    && gamma > 0.0
                    && gamma <= 10.0
                    && unit(out_black)
                    && unit(out_white)
            }
            RasterOp::Curves { ref points } => {
                points.len() <= 64 && points.iter().all(|p| fin(p) && unit(p[0]) && unit(p[1]))
            }
            RasterOp::HueSaturation {
                hue,
                saturation,
                lightness,
            } => {
                fin(&[hue, saturation, lightness])
                    && hue.abs() <= 360.0
                    && signed(saturation)
                    && signed(lightness)
            }
            RasterOp::Recolor {
                hue,
                saturation,
                lightness,
            } => {
                fin(&[hue, saturation, lightness])
                    && hue.abs() <= 360.0
                    && unit(saturation)
                    && signed(lightness)
            }
            RasterOp::Duotone { shadow, highlight } => {
                fin(&shadow) && fin(&highlight) && shadow.iter().chain(&highlight).all(|&c| unit(c))
            }
            RasterOp::BlackWhite {
                reds,
                yellows,
                greens,
                cyans,
                blues,
                magentas,
            } => {
                let w = [reds, yellows, greens, cyans, blues, magentas];
                fin(&w) && w.iter().all(|x| (-2.0..=3.0).contains(x))
            }
            RasterOp::Sharpen { amount, radius } => {
                fin(&[amount, radius])
                    && (0.0..=5.0).contains(&amount)
                    && (0.0..=64.0).contains(&radius)
            }
            RasterOp::Blur { radius } => fin(&[radius]) && (0.0..=64.0).contains(&radius),
            RasterOp::Posterize { levels } => fin(&[levels]) && (2.0..=255.0).contains(&levels),
            RasterOp::Threshold { level } => fin(&[level]) && unit(level),
            RasterOp::Invert => true,
        }
    }
}

/// The stack's JSON form: what the IDML label carries.
pub fn adjustments_to_json(ops: &[RasterOp]) -> String {
    // A `Vec` of plain data serialises without error.
    serde_json::to_string(ops).unwrap_or_default()
}

/// Reads a stack from its JSON form; `None` for text that is not one or
/// carries an op out of range.
pub fn adjustments_from_json(text: &str) -> Option<Vec<RasterOp>> {
    let ops: Vec<RasterOp> = serde_json::from_str(text).ok()?;
    ops.iter().all(RasterOp::is_valid).then_some(ops)
}

/// Every image frame of `spread` that carries a filter stack, as `(Self,
/// stack)`: rectangles, ovals and polygons (a group's members are on the
/// same lists).
fn stacks(spread: &crate::Spread) -> Vec<(&str, &[RasterOp])> {
    let rects = spread
        .rectangles
        .iter()
        .map(|r| (r.self_id.as_deref(), r.image_adjustments.as_slice()));
    let ovals = spread
        .ovals
        .iter()
        .map(|o| (o.self_id.as_deref(), o.image_adjustments.as_slice()));
    let polys = spread
        .polygons
        .iter()
        .map(|p| (p.self_id.as_deref(), p.image_adjustments.as_slice()));
    rects
        .chain(ovals)
        .chain(polys)
        .filter_map(|(id, ops)| Some((id?, ops)))
        .filter(|(_, ops)| !ops.is_empty())
        .collect()
}

/// IDML export: writes each image frame's stack into the spread's label
/// side map under [`IMAGE_ADJUSTMENTS_LABEL`] (and drops the key from a
/// frame whose stack is empty), so a paged → IDML → paged round trip keeps
/// it. Returns whether the spread carries any stack.
pub fn write_labels(spread: &mut crate::Spread) -> bool {
    let entries: Vec<(String, String)> = stacks(spread)
        .into_iter()
        .map(|(id, ops)| (id.to_string(), adjustments_to_json(ops)))
        .collect();
    for labels in spread.labels.values_mut() {
        labels.retain(|(k, _)| k != IMAGE_ADJUSTMENTS_LABEL);
    }
    spread.labels.retain(|_, v| !v.is_empty());
    let any = !entries.is_empty();
    for (id, json) in entries {
        spread
            .labels
            .entry(id)
            .or_default()
            .push((IMAGE_ADJUSTMENTS_LABEL.to_string(), json));
    }
    any
}

/// Whether any frame of `spread` carries a stack.
pub fn has_any(spread: &crate::Spread) -> bool {
    !stacks(spread).is_empty()
}

/// IDML import: moves each image frame's [`IMAGE_ADJUSTMENTS_LABEL`] off
/// the label side map onto the frame. A label that does not read as a
/// stack stays where it is, an ordinary label.
pub fn adopt_labels(spread: &mut crate::Spread) {
    if spread.labels.is_empty() {
        return;
    }
    let mut take = |id: Option<&str>, slot: &mut Vec<RasterOp>| {
        let Some(labels) = id.and_then(|id| spread.labels.get_mut(id)) else {
            return;
        };
        let Some(i) = labels
            .iter()
            .position(|(k, _)| k == IMAGE_ADJUSTMENTS_LABEL)
        else {
            return;
        };
        if let Some(ops) = adjustments_from_json(&labels[i].1) {
            *slot = ops;
            labels.remove(i);
        }
    };
    for r in &mut spread.rectangles {
        take(r.self_id.as_deref(), &mut r.image_adjustments);
    }
    for o in &mut spread.ovals {
        take(o.self_id.as_deref(), &mut o.image_adjustments);
    }
    for p in &mut spread.polygons {
        take(p.self_id.as_deref(), &mut p.image_adjustments);
    }
    spread.labels.retain(|_, v| !v.is_empty());
}

#[cfg(test)]
#[allow(non_snake_case)] // `__feat__` suffixes link the cockpit feature row.
mod tests {
    use super::*;

    #[test]
    fn a_stack_round_trips_through_its_json__feat__images_graphics_image_filter_stack() {
        let ops = vec![
            RasterOp::Exposure { ev: 0.5 },
            RasterOp::Curves {
                points: vec![[0.0, 0.0], [0.5, 0.6], [1.0, 1.0]],
            },
            RasterOp::Duotone {
                shadow: [0.1, 0.1, 0.3],
                highlight: [1.0, 0.9, 0.7],
            },
            RasterOp::Invert,
        ];
        let json = adjustments_to_json(&ops);
        assert!(json.contains(r#""op":"exposure""#), "{json}");
        assert!(json.contains(r#""op":"invert""#), "{json}");
        assert_eq!(adjustments_from_json(&json), Some(ops));
    }

    #[test]
    fn the_fields_are_camel_case__feat__images_graphics_image_filter_stack() {
        let json = adjustments_to_json(&[RasterOp::Levels {
            in_black: 0.1,
            in_white: 0.9,
            gamma: 1.2,
            out_black: 0.0,
            out_white: 1.0,
        }]);
        assert!(json.contains(r#""inBlack":0.1"#), "{json}");
    }

    #[test]
    fn a_stack_rides_a_label_and_back__feat__images_graphics_image_filter_stack() {
        let mut spread = crate::Spread::default();
        let mut r = crate::Rectangle::new("r1", crate::Bounds::ZERO);
        r.image_adjustments = vec![RasterOp::Invert];
        spread.rectangles.push(r);
        spread
            .rectangles
            .push(crate::Rectangle::new("r2", crate::Bounds::ZERO));
        spread
            .labels
            .insert("r2".into(), vec![("vendor".into(), "acme".into())]);
        assert!(write_labels(&mut spread));
        assert_eq!(
            spread.labels.get("r1"),
            Some(&vec![(
                IMAGE_ADJUSTMENTS_LABEL.to_string(),
                r#"[{"op":"invert"}]"#.to_string()
            )])
        );
        spread.rectangles[0].image_adjustments.clear();
        adopt_labels(&mut spread);
        assert_eq!(
            spread.rectangles[0].image_adjustments,
            vec![RasterOp::Invert]
        );
        assert!(
            !spread.labels.contains_key("r1"),
            "the label is the frame's now"
        );
        assert_eq!(
            spread.labels.get("r2").map(Vec::len),
            Some(1),
            "others stay"
        );
    }

    #[test]
    fn an_op_out_of_range_is_refused__feat__images_graphics_image_filter_stack() {
        assert!(!RasterOp::Threshold { level: 2.0 }.is_valid());
        assert!(!RasterOp::Exposure { ev: f32::NAN }.is_valid());
        assert!(!RasterOp::Posterize { levels: 1.0 }.is_valid());
        assert_eq!(
            adjustments_from_json(r#"[{"op":"threshold","level":2}]"#),
            None
        );
        assert_eq!(adjustments_from_json("not json"), None);
        assert_eq!(adjustments_from_json(r#"[{"op":"warp"}]"#), None);
    }
}

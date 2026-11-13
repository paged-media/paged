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

//! Engine ADR 1099 — a PSD's layers as page items: each pixel layer one
//! frame, at its place on the canvas, carrying its pixels (its layer mask
//! applied), its blend mode, its opacity, its fill opacity and its layer
//! style as effect-stack entries drawn by the layer-style convention.
//!
//! [`place_layers`] reads the file and lowers it; the caller (the canvas
//! model's `RequestPsdLayersPlace`) turns the result into one batch of
//! wire mutations. What a frame cannot carry is a [`StyleLoss`]: an
//! adjustment layer (no pixels of its own), clipping, a group's opacity,
//! blend mode or mask, a vector mask, Blend If, knockout and the blending
//! options that change how a style composites.

use paged_psd::effects::{GlobalLight, LayerStyle};
use paged_psd::layer_pixels::InkToRgba8;
use paged_psd::model::ColorMode;
use paged_psd::PsdFile;

use paged_model::layer_style::FxPatternTile;
use paged_model::report::LossSeverity;

use crate::{map_layer_style, MapOptions, MappedStyle, StyleLoss};

/// One layer as a frame.
#[derive(Debug, Clone)]
pub struct PlacedLayer {
    pub name: String,
    /// Straight RGBA8, `width × height`, its layer mask applied.
    pub rgba: Vec<u8>,
    pub width: u32,
    pub height: u32,
    /// The pixels' box on the canvas, pt from its top-left:
    /// `[left, top, right, bottom]`.
    pub bounds_pt: [f32; 4],
    /// The model's blend-mode name (`paged_blend::BlendMode::name`).
    pub blend: &'static str,
    /// The layer's opacity, 0–100.
    pub opacity_pct: f32,
    /// Its fill opacity, 0–100: the pixels' own, not the effects'.
    pub fill_pct: f32,
    /// Its style on the stack, when it has one.
    pub style: Option<MappedStyle>,
}

/// A PSD lowered to frames.
#[derive(Debug, Clone, Default)]
pub struct PlacedLayers {
    /// Bottom first, as the page stacks them.
    pub layers: Vec<PlacedLayer>,
    /// The canvas in pt.
    pub width_pt: f32,
    pub height_pt: f32,
    /// The document's Global Light (angle, altitude), for a caller that
    /// sets the page's light from it.
    pub global_light: (f32, f32),
    pub losses: Vec<StyleLoss>,
}

fn loss(out: &mut Vec<StyleLoss>, code: &str, severity: LossSeverity, what: String) {
    match out.iter_mut().find(|l| l.code == code && l.message == what) {
        Some(l) => l.count += 1,
        None => out.push(StyleLoss::new(code, severity, what)),
    }
}

/// The record's blending options a frame cannot carry, by name.
fn unsupported_options(file: &PsdFile, record: usize) -> Vec<&'static str> {
    let Some(rec) = file.layer_mask.layers.get(record) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let flag = |k: &[u8; 4]| -> Option<u8> {
        rec.addl
            .iter()
            .find(|a| &a.key == k)
            .and_then(|a| a.payload(file.container).first().copied())
    };
    // Blend If: a blending range other than the open one (black 0/0,
    // white 255/255 for This Layer and the Underlying, every channel).
    let open = rec
        .blend_ranges
        .raw
        .chunks(4)
        .all(|q| q.len() == 4 && q[0].max(q[1]) == 0 && q[2].min(q[3]) == 255);
    if !open {
        out.push("Blend If");
    }
    if flag(b"knko").is_some_and(|v| v != 0) {
        out.push("knockout");
    }
    // The style's blending options, where they differ from Photoshop's
    // defaults: Blend Interior Effects as Group, Blend Clipped Layers as
    // Group, Transparency Shapes Layer, Layer and Vector Mask Hides
    // Effects.
    if flag(b"infx").is_some_and(|v| v != 0) {
        out.push("Blend Interior Effects as Group");
    }
    if flag(b"clbl").is_some_and(|v| v == 0) {
        out.push("Blend Clipped Layers as Group off");
    }
    if flag(b"tsly").is_some_and(|v| v == 0) {
        out.push("Transparency Shapes Layer off");
    }
    if flag(b"lmgm").is_some_and(|v| v != 0) {
        out.push("Layer Mask Hides Effects");
    }
    if flag(b"vmgm").is_some_and(|v| v != 0) {
        out.push("Vector Mask Hides Effects");
    }
    out
}

/// Read `bytes` (a PSD or PSB) and lower its pixel layers to frames.
/// `ink` converts a CMYK document's ink to RGBA8 (the caller's colour
/// management); without it a CMYK document is refused.
pub fn place_layers(bytes: &[u8], ink: Option<InkToRgba8<'_>>) -> Result<PlacedLayers, String> {
    let file = PsdFile::parse(bytes).map_err(|e| e.to_string())?;
    let import = match (file.header.color_mode, ink) {
        (ColorMode::Cmyk, Some(ink)) => file.layer_plates_rgba8_via(ink),
        _ => file.layer_plates_rgba8(),
    }
    .map_err(|e| e.to_string())?;
    let ppi = file
        .resources
        .resolution()
        .map(|r| r.h_ppi() as f32)
        .filter(|p| p.is_finite() && *p > 0.0)
        .unwrap_or(72.0);
    let pt_per_px = 72.0 / ppi;
    // The patterns the styles name, from the file's own pattern block.
    let patterns: Vec<paged_psd::presets::PatternPreset> = file
        .layer_mask
        .addl_global
        .iter()
        .filter(|a| matches!(&a.key, b"Patt" | b"Pat2" | b"Pat3"))
        .flat_map(|a| paged_psd::presets::read_psd_patterns(a.payload(file.container)).patterns)
        .collect();
    let tiles = |id: &str, name: &str| -> Option<FxPatternTile> {
        patterns
            .iter()
            .find(|p| !id.is_empty() && p.id == id)
            .or_else(|| patterns.iter().find(|p| p.name == name))
            .map(|p| FxPatternTile {
                width: p.width,
                height: p.height,
                rgba: p.rgba.clone(),
            })
    };
    let opts = MapOptions {
        pt_per_px,
        tiles: Some(&tiles),
    };
    let light = GlobalLight::of(&file);
    let mut out = PlacedLayers {
        width_pt: import.width as f32 * pt_per_px,
        height_pt: import.height as f32 * pt_per_px,
        global_light: (light.angle, light.altitude),
        ..PlacedLayers::default()
    };
    let (cw, ch) = (import.width, import.height);
    for plate in &import.layers {
        let mut hidden = plate.hidden;
        let mut g = plate.group;
        while let Some(i) = g {
            let group = &import.groups[i];
            hidden |= group.hidden;
            if group.opacity != 255 || &group.blend_key != b"pass" && &group.blend_key != b"norm" {
                loss(
                    &mut out.losses,
                    "psd.group",
                    LossSeverity::Approximated,
                    format!(
                        "the group {:?}'s opacity and blend mode (its layers placed on their own)",
                        group.name
                    ),
                );
            }
            if group.mask.as_ref().is_some_and(|m| m.enabled) {
                loss(
                    &mut out.losses,
                    "psd.group-mask",
                    LossSeverity::Dropped,
                    format!("the group {:?}'s mask", group.name),
                );
            }
            g = group.parent;
        }
        if hidden {
            loss(
                &mut out.losses,
                "psd.hidden",
                LossSeverity::Info,
                "a hidden layer (not placed)".into(),
            );
            continue;
        }
        if plate.adjustment.is_some() {
            loss(
                &mut out.losses,
                "psd.adjustment",
                LossSeverity::Dropped,
                format!(
                    "the adjustment layer {:?} (a frame has no adjustment of what lies under it)",
                    plate.name
                ),
            );
            continue;
        }
        if plate.clipped {
            loss(
                &mut out.losses,
                "psd.clipping",
                LossSeverity::Approximated,
                format!("the clipping of {:?} (placed unclipped)", plate.name),
            );
        }
        if plate.vector_mask.as_ref().is_some_and(|v| !v.disabled) {
            loss(
                &mut out.losses,
                "psd.vector-mask",
                LossSeverity::Dropped,
                format!("the vector mask of {:?}", plate.name),
            );
        }
        for what in unsupported_options(&file, plate.record) {
            loss(
                &mut out.losses,
                "psd.blending-options",
                LossSeverity::Dropped,
                format!("{what} on {:?}", plate.name),
            );
        }
        // The pixels on their rectangle, the user mask multiplied in.
        let (rx, ry, rw, rh) = match plate.rect {
            Some(r) => (r.x.max(0) as u32, r.y.max(0) as u32, r.w, r.h),
            None => (0, 0, cw, ch),
        };
        if rw == 0 || rh == 0 || plate.rgba.len() != rw as usize * rh as usize * 4 {
            continue;
        }
        let mut rgba = plate.rgba.clone();
        if let Some(m) = plate.mask.as_ref().filter(|m| m.enabled) {
            let (mx, my, mw) = match m.rect {
                Some(r) => (r.x, r.y, r.w),
                None => (0, 0, cw),
            };
            for y in 0..rh {
                for x in 0..rw {
                    let (cx, cy) = (rx + x, ry + y);
                    let (lx, ly) = (cx as i64 - i64::from(mx), cy as i64 - i64::from(my));
                    let cov = if lx >= 0 && ly >= 0 && lx < i64::from(mw) {
                        m.coverage
                            .get(ly as usize * mw as usize + lx as usize)
                            .copied()
                            .unwrap_or(255)
                    } else {
                        255
                    };
                    let a = &mut rgba[((y * rw + x) * 4 + 3) as usize];
                    *a = ((u32::from(*a) * u32::from(cov) + 127) / 255) as u8;
                }
            }
        }
        if rgba.as_chunks::<4>().0.iter().all(|p| p[3] == 0) {
            continue;
        }
        let rec = file.layer_mask.layers.get(plate.record);
        let opacity = rec.map_or(plate.opacity, |r| r.opacity);
        let fill = rec.map_or(255, paged_psd::layer_pixels::fill_opacity);
        let blend = paged_blend::BlendMode::from_psd_key(&plate.blend_key)
            .unwrap_or(paged_blend::BlendMode::Normal);
        let style: Option<MappedStyle> = plate
            .style
            .as_ref()
            .map(|s: &LayerStyle| map_layer_style(s, &opts));
        if let Some(s) = &style {
            out.losses.extend(s.losses.iter().cloned());
        }
        out.layers.push(PlacedLayer {
            name: plate.name.clone(),
            rgba,
            width: rw,
            height: rh,
            bounds_pt: [
                rx as f32 * pt_per_px,
                ry as f32 * pt_per_px,
                (rx + rw) as f32 * pt_per_px,
                (ry + rh) as f32 * pt_per_px,
            ],
            blend: blend.name(),
            opacity_pct: f32::from(opacity) / 255.0 * 100.0,
            fill_pct: f32::from(fill) / 255.0 * 100.0,
            style,
        });
    }
    Ok(out)
}

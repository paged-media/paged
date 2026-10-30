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

//! Engine ADR 1044 — every Photoshop layer effect mapped onto the effect
//! stack: what the stack says natively, in Photoshop's compositing order,
//! with each loss named. The styles are built as `paged-psd` reads them
//! (and round-tripped through the `lfx2` descriptor, so they are what a
//! PSD holds), at 144 ppi so the pixel-to-point scale is exercised.

#![allow(non_snake_case)]

use paged_model::effect_stack::{Effect, EffectBearing, EffectTarget, StrokePosition};
use paged_model::{Bounds, Graphic, Rectangle};
use paged_psd::effects::{
    Bevel, BevelContour, BevelStyle, BevelTechnique, BlendMode, ColorFill, Contour, ContourPoint,
    Glow, GlowFill, GlowSource, Gradient, GradientColorStop, GradientOverlay, GradientStyle,
    LayerStyle, PatternOverlay, Satin, Shadow, Stroke, StrokeFill,
};
use paged_psd_fx::{apply_layer_style, map_layer_style, MapOptions, MappedStyle};

/// 144 ppi: one Photoshop pixel is half a point.
const OPTS: MapOptions = MapOptions { pt_per_px: 0.5 };

/// The style through Photoshop's own block: written as `lfx2` / `lmfx`,
/// read back.
fn as_read(style: LayerStyle) -> LayerStyle {
    let d = style.to_descriptor();
    LayerStyle::from_descriptor(&d)
}

fn map(style: LayerStyle) -> MappedStyle {
    map_layer_style(&as_read(style), &OPTS)
}

fn kinds(m: &MappedStyle) -> Vec<&'static str> {
    m.stack.iter().map(|e| e.effect.kind_name()).collect()
}

fn close(a: f32, b: f32) -> bool {
    (a - b).abs() < 0.01
}

fn red_blue() -> Gradient {
    Gradient {
        name: "Red, Blue".into(),
        stops: vec![
            GradientColorStop {
                at: 0.0,
                rgb: [255, 0, 0],
                midpoint: 0.5,
            },
            GradientColorStop {
                at: 1.0,
                rgb: [0, 0, 255],
                midpoint: 0.5,
            },
        ],
        ..Gradient::default()
    }
}

#[test]
fn drop_shadow__feat__images_graphics_psd_layer_styles() {
    let m = map(LayerStyle {
        drop_shadows: vec![Shadow {
            blend: BlendMode::Multiply,
            color: [10, 20, 30],
            opacity: 60.0,
            angle: 90.0,
            distance: 10.0,
            spread: 20.0,
            size: 8.0,
            noise: 5.0,
            ..Shadow::drop_default()
        }],
        ..LayerStyle::default()
    });
    assert_eq!(kinds(&m), ["dropShadow"]);
    let Effect::DropShadow { parked: Some(p) } = &m.stack[0].effect else {
        panic!("{:?}", m.stack[0])
    };
    // Light from above (90°): the shadow falls down the page, 10 px = 5 pt.
    assert!(close(p.x_offset, 0.0) && close(p.y_offset, 5.0), "{p:?}");
    assert!(close(p.size, 4.0));
    assert_eq!(p.opacity_pct, 60.0);
    assert_eq!(p.spread_pct, Some(20.0));
    assert_eq!(p.noise_pct, Some(5.0));
    assert_eq!(p.blend_mode.as_deref(), Some("Multiply"));
    assert_eq!(p.effect_color.as_deref(), Some("Color/PSD R=10 G=20 B=30"));
    assert_eq!(m.colors.len(), 1);
    assert_eq!(m.colors[0].value, vec![10.0, 20.0, 30.0]);
    assert!(m.losses.is_empty(), "{:?}", m.losses);
}

#[test]
fn a_second_drop_shadow_and_a_contour_are_losses() {
    let curved = Contour {
        name: "Cone".into(),
        points: vec![
            ContourPoint {
                x: 0.0,
                y: 0.0,
                corner: true,
            },
            ContourPoint {
                x: 128.0,
                y: 255.0,
                corner: true,
            },
            ContourPoint {
                x: 255.0,
                y: 0.0,
                corner: true,
            },
        ],
    };
    let m = map(LayerStyle {
        drop_shadows: vec![
            Shadow {
                contour: curved,
                ..Shadow::drop_default()
            },
            Shadow::drop_default(),
        ],
        ..LayerStyle::default()
    });
    assert_eq!(kinds(&m), ["dropShadow"]);
    let lines: Vec<String> = m.losses.iter().map(ToString::to_string).collect();
    assert_eq!(lines.len(), 2, "{lines:?}");
    assert!(lines.iter().any(|l| l.contains("Cone")));
    assert!(lines.iter().any(|l| l.contains("second instance")));
}

#[test]
fn inner_shadow__feat__images_graphics_psd_layer_styles() {
    let m = map(LayerStyle {
        inner_shadows: vec![Shadow {
            angle: 45.0,
            distance: 6.0,
            spread: 10.0,
            size: 4.0,
            ..Shadow::inner_default()
        }],
        ..LayerStyle::default()
    });
    assert_eq!(kinds(&m), ["innerShadow"]);
    let Effect::InnerShadow { parked: Some(p) } = &m.stack[0].effect else {
        panic!()
    };
    assert_eq!(p.angle_deg, Some(45.0));
    assert!(close(p.distance.unwrap(), 3.0));
    assert!(close(p.size.unwrap(), 2.0));
    assert_eq!(p.choke_pct, Some(10.0));
}

#[test]
fn outer_and_inner_glow__feat__images_graphics_psd_layer_styles() {
    let m = map(LayerStyle {
        outer_glow: Some(Glow {
            fill: GlowFill::Color {
                rgb: [255, 255, 190],
            },
            size: 10.0,
            spread: 15.0,
            ..Glow::default()
        }),
        inner_glow: Some(Glow {
            fill: GlowFill::Gradient {
                gradient: red_blue(),
            },
            source: GlowSource::Center,
            size: 6.0,
            ..Glow::default()
        }),
        ..LayerStyle::default()
    });
    assert_eq!(kinds(&m), ["outerGlow", "innerGlow"]);
    let Effect::OuterGlow { parked: Some(o) } = &m.stack[0].effect else {
        panic!()
    };
    assert!(close(o.size.unwrap(), 5.0));
    assert_eq!(o.spread_pct, Some(15.0));
    assert_eq!(
        o.effect_color.as_deref(),
        Some("Color/PSD R=255 G=255 B=190")
    );
    let Effect::InnerGlow { parked: Some(i) } = &m.stack[1].effect else {
        panic!()
    };
    assert_eq!(i.source.as_deref(), Some("CenterGlow"));
    // A gradient glow keeps its first colour and says so.
    assert_eq!(i.effect_color.as_deref(), Some("Color/PSD R=255 G=0 B=0"));
    assert_eq!(m.losses.len(), 1, "{:?}", m.losses);
    assert_eq!(m.losses[0].effect, "Inner Glow");
}

#[test]
fn bevel_and_emboss__feat__images_graphics_psd_layer_styles() {
    let m = map(LayerStyle {
        bevel: Some(Bevel {
            style: BevelStyle::PillowEmboss,
            technique: BevelTechnique::ChiselHard,
            depth: 250.0,
            down: true,
            size: 12.0,
            soften: 2.0,
            angle: 135.0,
            altitude: 40.0,
            contour: Some(BevelContour {
                enabled: true,
                ..BevelContour::default()
            }),
            ..Bevel::default()
        }),
        ..LayerStyle::default()
    });
    assert_eq!(kinds(&m), ["bevelEmboss"]);
    let Effect::BevelEmboss { parked: Some(b) } = &m.stack[0].effect else {
        panic!()
    };
    assert_eq!(b.style.as_deref(), Some("PillowEmboss"));
    assert_eq!(b.technique.as_deref(), Some("ChiselHard"));
    assert_eq!(b.direction.as_deref(), Some("Down"));
    assert_eq!(b.depth_pct, Some(250.0));
    assert!(close(b.size.unwrap(), 6.0) && close(b.soften.unwrap(), 1.0));
    assert_eq!((b.angle_deg, b.altitude_deg), (Some(135.0), Some(40.0)));
    assert!(m.losses.iter().any(|l| l.what.contains("Contour pane")));
}

#[test]
fn satin__feat__images_graphics_psd_layer_styles() {
    let m = map(LayerStyle {
        satin: Some(Satin {
            color: [0, 0, 128],
            invert: false,
            ..Satin::default()
        }),
        ..LayerStyle::default()
    });
    assert_eq!(kinds(&m), ["satin"]);
    let Effect::Satin { parked: Some(s) } = &m.stack[0].effect else {
        panic!()
    };
    assert_eq!(s.invert, Some(false));
    assert!(close(s.distance.unwrap(), 5.5) && close(s.size.unwrap(), 7.0));
    assert_eq!(s.angle_deg, Some(19.0));
}

#[test]
fn color_gradient_and_pattern_overlays__feat__images_graphics_psd_layer_styles() {
    let m = map(LayerStyle {
        color_overlays: vec![ColorFill {
            color: [0, 128, 0],
            opacity: 80.0,
            blend: BlendMode::Screen,
            ..ColorFill::default()
        }],
        gradient_overlays: vec![GradientOverlay {
            fill: paged_psd::effects::GradientFill {
                gradient: red_blue(),
                style: GradientStyle::Radial,
                angle: 30.0,
                reverse: true,
                ..Default::default()
            },
            ..GradientOverlay::default()
        }],
        pattern_overlay: Some(PatternOverlay::default()),
        ..LayerStyle::default()
    });
    // Photoshop's order: pattern (lost), gradient, colour.
    assert_eq!(kinds(&m), ["gradientOverlay", "colorOverlay"]);
    let Effect::GradientOverlay(g) = &m.stack[0].effect else {
        panic!()
    };
    assert_eq!(g.angle_deg, Some(30.0));
    assert!(g.reverse);
    let gid = g.gradient.clone().unwrap();
    let grad = m.gradients.iter().find(|x| x.self_id == gid).unwrap();
    assert_eq!(grad.stops.len(), 2);
    assert_eq!(grad.stops[1].location_pct, 100.0);
    assert_eq!(grad.stops[1].stop_color, "Color/PSD R=0 G=0 B=255");
    let c = &m.stack[1];
    assert_eq!(c.blend_mode.as_deref(), Some("Screen"));
    assert_eq!(c.opacity_pct, Some(80.0));
    let lines: Vec<String> = m.losses.iter().map(ToString::to_string).collect();
    assert!(
        lines.iter().any(|l| l.starts_with("Pattern Overlay")),
        "{lines:?}"
    );
    assert!(lines.iter().any(|l| l.contains("Radial")), "{lines:?}");
}

#[test]
fn stroke__feat__images_graphics_psd_layer_styles() {
    let m = map(LayerStyle {
        strokes: vec![
            Stroke {
                position: StrokePositionPsd::Center,
                fill: StrokeFill::Color { rgb: [200, 0, 0] },
                size: 6.0,
                ..Stroke::default()
            },
            Stroke {
                fill: StrokeFill::Gradient(paged_psd::effects::GradientFill {
                    gradient: red_blue(),
                    ..Default::default()
                }),
                ..Stroke::default()
            },
        ],
        ..LayerStyle::default()
    });
    assert_eq!(kinds(&m), ["outlineStroke", "outlineStroke"]);
    let Effect::OutlineStroke(s) = &m.stack[0].effect else {
        panic!()
    };
    assert_eq!(s.position, StrokePosition::Center);
    assert!(close(s.size_pt, 3.0));
    assert_eq!(s.color.as_deref(), Some("Color/PSD R=200 G=0 B=0"));
    assert_eq!(m.losses.len(), 1, "{:?}", m.losses);
}

use paged_psd::effects::StrokePosition as StrokePositionPsd;

#[test]
fn everything_in_photoshops_compositing_order() {
    let m = map(LayerStyle {
        drop_shadows: vec![Shadow::drop_default()],
        inner_shadows: vec![Shadow::inner_default()],
        outer_glow: Some(Glow::default()),
        inner_glow: Some(Glow::default()),
        bevel: Some(Bevel::default()),
        satin: Some(Satin::default()),
        color_overlays: vec![ColorFill::default()],
        gradient_overlays: vec![GradientOverlay::default()],
        strokes: vec![Stroke::default()],
        ..LayerStyle::default()
    });
    assert_eq!(
        kinds(&m),
        [
            "dropShadow",
            "outerGlow",
            "gradientOverlay",
            "colorOverlay",
            "satin",
            "innerGlow",
            "innerShadow",
            "outlineStroke",
            "bevelEmboss"
        ]
    );
}

#[test]
fn a_switched_off_effect_or_style_is_kept_disabled() {
    let m = map(LayerStyle {
        drop_shadows: vec![Shadow {
            enabled: false,
            ..Shadow::drop_default()
        }],
        strokes: vec![Stroke::default()],
        ..LayerStyle::default()
    });
    assert_eq!(
        m.stack.iter().map(|e| e.enabled).collect::<Vec<_>>(),
        [false, true]
    );
    let off = map_layer_style(
        &LayerStyle {
            enabled: false,
            strokes: vec![Stroke::default()],
            ..LayerStyle::default()
        },
        &OPTS,
    );
    assert!(off.stack.iter().all(|e| !e.enabled));
}

#[test]
fn a_blend_mode_idml_has_no_name_for_is_a_loss() {
    let m = map(LayerStyle {
        color_overlays: vec![ColorFill {
            blend: BlendMode::LinearBurn,
            ..ColorFill::default()
        }],
        ..LayerStyle::default()
    });
    assert_eq!(m.stack[0].blend_mode, None);
    assert!(m.losses[0].what.contains("LinearBurn"));
}

/// Applied to a page item: the InDesign kinds land in their slots, the
/// stack keeps Photoshop's order and the stack-only kinds, the swatches
/// join the document, and the item reads back what the style said.
#[test]
fn applied_to_a_page_item__feat__images_graphics_psd_layer_styles() {
    let mut item = Rectangle::new("r", Bounds::ZERO);
    let mut graphic = Graphic::default();
    let style = as_read(LayerStyle {
        drop_shadows: vec![Shadow::drop_default()],
        inner_glow: Some(Glow::default()),
        strokes: vec![Stroke::default()],
        color_overlays: vec![ColorFill::default()],
        ..LayerStyle::default()
    });
    let losses = apply_layer_style(&style, &OPTS, &mut item, &mut graphic).expect("apply");
    assert!(losses.is_empty(), "{losses:?}");
    assert!(item.drop_shadow.is_some(), "the drop shadow is in its slot");
    assert!(item
        .effects
        .as_ref()
        .is_some_and(|e| e.inner_glow.is_some()));
    let resolved = item.effect_slots(EffectTarget::Object).resolved();
    let names: Vec<_> = resolved.iter().map(|e| e.effect.kind_name()).collect();
    assert_eq!(
        names,
        ["dropShadow", "colorOverlay", "innerGlow", "outlineStroke"]
    );
    for e in &resolved {
        if let Effect::OutlineStroke(s) = &e.effect {
            let id = s.color.as_deref().unwrap();
            assert!(graphic.colors.contains_key(id), "{id}");
        }
    }
    assert!(graphic.colors.contains_key("Color/PSD R=255 G=0 B=0"));
}

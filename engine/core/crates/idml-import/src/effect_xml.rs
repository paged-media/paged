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

//! The effect settings of a page item, as InDesign writes them, read once
//! for the spread reader and the story reader (an anchored frame carries
//! the same settings as a free one, engine ADR 1045): the drop shadow,
//! InDesign's other eight effects and a gradient feather's stops. The
//! caller decides which target's bag they fill.

use crate::util::{attr, parse_f};
use paged_model::{
    BevelEmbossParams, DirectionalFeatherParams, DropShadowSetting, FeatherParams, FrameEffects,
    GradientFeatherParams, GradientFeatherStop, InnerGlowParams, InnerShadowParams,
    OuterGlowParams, SatinParams,
};

pub(crate) fn parse_drop_shadow(e: &quick_xml::events::BytesStart) -> Option<DropShadowSetting> {
    // IDML defaults — see §IDML Defaults Table 84 in the spec:
    // Mode=None, BlendMode=Multiply, Opacity=75, XOffset=7, YOffset=7,
    // Size=5, EffectColor="n" (Black). When `Mode="Drop"` is the only
    // attribute on the element, these are the values InDesign uses for
    // the unspecified ones. Earlier behaviour treated missing offsets
    // / size as zero, which produced a solid black stamp behind the
    // frame instead of a real drop shadow.
    Some(DropShadowSetting {
        mode: attr(e, b"Mode").unwrap_or_else(|| "Drop".to_string()),
        x_offset: attr(e, b"XOffset")
            .and_then(|s| s.parse().ok())
            .unwrap_or(7.0),
        y_offset: attr(e, b"YOffset")
            .and_then(|s| s.parse().ok())
            .unwrap_or(7.0),
        size: attr(e, b"Size").and_then(|s| s.parse().ok()).unwrap_or(5.0),
        opacity_pct: attr(e, b"Opacity")
            .and_then(|s| s.parse().ok())
            .unwrap_or(75.0),
        effect_color: attr(e, b"EffectColor"),
        // R-11: each written only when it differs from InDesign's
        // default, so `None` is that default.
        blend_mode: attr(e, b"BlendMode"),
        spread_pct: attr(e, b"Spread").and_then(|s| s.parse().ok()),
        noise_pct: attr(e, b"Noise").and_then(|s| s.parse().ok()),
        knocked_out: attr(e, b"KnockedOut").and_then(|s| s.parse().ok()),
        honor_other_effects: attr(e, b"HonorOtherEffects").and_then(|s| s.parse().ok()),
        use_global_light: attr(e, b"UseGlobalLight").and_then(|s| s.parse().ok()),
    })
}

/// A boolean attribute, `None` when absent or unreadable.
pub(crate) fn parse_bool(e: &quick_xml::events::BytesStart, name: &[u8]) -> Option<bool> {
    attr(e, name).and_then(|s| s.parse().ok())
}

/// Whether an effect setting is switched on: `Applied="true"`, or for a
/// basic feather InDesign's own `Mode="Standard"` (default "None"). Our
/// own older exports wrote `Applied` on the feather too — still honoured.
pub(crate) fn applied(e: &quick_xml::events::BytesStart) -> bool {
    attr(e, b"Applied")
        .and_then(|s| s.parse::<bool>().ok())
        .unwrap_or(false)
        || (e.name().as_ref() == b"FeatherSetting"
            && attr(e, b"Mode").as_deref() == Some("Standard"))
}

/// Whether `name` is one of InDesign's eight effect settings besides the
/// drop shadow.
pub(crate) fn is_effect_setting(name: &[u8]) -> bool {
    matches!(
        name,
        b"InnerShadowSetting"
            | b"OuterGlowSetting"
            | b"InnerGlowSetting"
            | b"BevelAndEmbossSetting"
            | b"SatinSetting"
            | b"FeatherSetting"
            | b"DirectionalFeatherSetting"
            | b"GradientFeatherSetting"
    )
}

/// Read an (applied) effect setting into `bag`. Returns `true` for a
/// gradient feather, whose `<GradientStop>` / `<OpacityGradientStop>`
/// children follow ([`gradient_stop`]).
pub(crate) fn effect_into(e: &quick_xml::events::BytesStart, bag: &mut FrameEffects) -> bool {
    match e.name().as_ref() {
        b"InnerShadowSetting" => {
            bag.inner_shadow = Some(InnerShadowParams {
                x_offset: parse_f(e, b"XOffset"),
                y_offset: parse_f(e, b"YOffset"),
                size: parse_f(e, b"Size"),
                opacity_pct: parse_f(e, b"Opacity"),
                effect_color: attr(e, b"EffectColor"),
                angle_deg: parse_f(e, b"Angle"),
                distance: parse_f(e, b"Distance"),
                choke_pct: parse_f(e, b"ChokeAmount"),
                blend_mode: attr(e, b"BlendMode"),
                noise_pct: parse_f(e, b"Noise"),
                use_global_light: parse_bool(e, b"UseGlobalLight"),
            });
        }
        b"OuterGlowSetting" => {
            bag.outer_glow = Some(OuterGlowParams {
                size: parse_f(e, b"Size"),
                opacity_pct: parse_f(e, b"Opacity"),
                effect_color: attr(e, b"EffectColor"),
                spread_pct: parse_f(e, b"Spread"),
                blend_mode: attr(e, b"BlendMode"),
                noise_pct: parse_f(e, b"Noise"),
                technique: attr(e, b"Technique"),
            });
        }
        b"InnerGlowSetting" => {
            bag.inner_glow = Some(InnerGlowParams {
                size: parse_f(e, b"Size"),
                opacity_pct: parse_f(e, b"Opacity"),
                effect_color: attr(e, b"EffectColor"),
                // InDesign spells the inner glow's choke `Spread`.
                choke_pct: parse_f(e, b"Spread").or_else(|| parse_f(e, b"ChokeAmount")),
                blend_mode: attr(e, b"BlendMode"),
                source: attr(e, b"Source"),
                noise_pct: parse_f(e, b"Noise"),
                technique: attr(e, b"Technique"),
            });
        }
        b"BevelAndEmbossSetting" => {
            bag.bevel = Some(BevelEmbossParams {
                depth_pct: parse_f(e, b"Depth"),
                size: parse_f(e, b"Size"),
                angle_deg: parse_f(e, b"Angle"),
                altitude_deg: parse_f(e, b"Altitude"),
                highlight_color: attr(e, b"HighlightColor"),
                shadow_color: attr(e, b"ShadowColor"),
                highlight_opacity_pct: parse_f(e, b"HighlightOpacity"),
                shadow_opacity_pct: parse_f(e, b"ShadowOpacity"),
                style: attr(e, b"Style"),
                direction: attr(e, b"Direction"),
                technique: attr(e, b"Technique"),
                soften: parse_f(e, b"Soften"),
                highlight_blend_mode: attr(e, b"HighlightBlendMode"),
                shadow_blend_mode: attr(e, b"ShadowBlendMode"),
                use_global_light: parse_bool(e, b"UseGlobalLight"),
            });
        }
        b"SatinSetting" => {
            bag.satin = Some(SatinParams {
                size: parse_f(e, b"Size"),
                angle_deg: parse_f(e, b"Angle"),
                distance: parse_f(e, b"Distance"),
                effect_color: attr(e, b"EffectColor"),
                opacity_pct: parse_f(e, b"Opacity"),
                blend_mode: attr(e, b"BlendMode"),
                invert: attr(e, b"InvertEffect")
                    .or_else(|| attr(e, b"Invert"))
                    .and_then(|s| s.parse::<bool>().ok()),
            });
        }
        b"FeatherSetting" => {
            bag.feather = Some(FeatherParams {
                width: parse_f(e, b"Width"),
                corner_type: attr(e, b"CornerType"),
                noise_pct: parse_f(e, b"Noise"),
                choke_pct: parse_f(e, b"ChokeAmount"),
            });
        }
        b"DirectionalFeatherSetting" => {
            bag.directional_feather = Some(DirectionalFeatherParams {
                left_width: parse_f(e, b"LeftWidth"),
                right_width: parse_f(e, b"RightWidth"),
                top_width: parse_f(e, b"TopWidth"),
                bottom_width: parse_f(e, b"BottomWidth"),
                angle_deg: parse_f(e, b"Angle"),
                noise_pct: parse_f(e, b"Noise").or_else(|| parse_f(e, b"NoiseAmount")),
                choke_pct: parse_f(e, b"ChokeAmount"),
                corner_type: attr(e, b"CornerType"),
                follow_shape_mode: attr(e, b"FollowShapeMode"),
            });
        }
        b"GradientFeatherSetting" => {
            // InDesign uses `GradientStart`
            // (an "x y" pair) + `Length` +
            // `HiliteAngle` to describe the
            // gradient direction; the IDML
            // spec also accepts an explicit
            // `GradientEnd` pair. We accept
            // both shapes — the parser
            // computes the end point from
            // start + (Length × Angle) when
            // GradientEnd is missing so the
            // renderer sees one canonical
            // pair regardless of the source.
            let start_point = attr(e, b"GradientStart")
                .as_deref()
                .and_then(crate::spread::parse_xy_pair);
            let end_point = attr(e, b"GradientEnd")
                .as_deref()
                .and_then(crate::spread::parse_xy_pair)
                .or_else(|| {
                    // `HiliteAngle` is the *highlight*
                    // ramp orientation, not the
                    // gradient axis direction —
                    // InDesign uses it for the
                    // radial-feather hilite preview
                    // and leaves the gradient axis
                    // horizontal (0°) when no
                    // dedicated angle attribute is
                    // serialised. Tied to the visible
                    // page-5 yellow→white feather in
                    // `manual-sample.idml`, where
                    // `HiliteAngle="-62.2"` paints a
                    // diagonal smudge instead of the
                    // expected left→right fade.
                    let s = start_point?;
                    let length = parse_f(e, b"Length")?;
                    let angle = parse_f(e, b"GradientAngle")
                        .or_else(|| parse_f(e, b"Angle"))
                        .unwrap_or(0.0);
                    let rad = angle.to_radians();
                    let (sin, cos) = rad.sin_cos();
                    Some((s.0 + length * cos, s.1 - length * sin))
                });
            bag.gradient_feather = Some(GradientFeatherParams {
                gradient_type: attr(e, b"Type"),
                start_point,
                end_point,
                angle_deg: parse_f(e, b"GradientAngle").or_else(|| parse_f(e, b"Angle")),
                stops: Vec::new(),
                hilite_angle: parse_f(e, b"HiliteAngle"),
                hilite_length: parse_f(e, b"HiliteLength"),
            });
            return true;
        }
        _ => {}
    }
    false
}

/// One stop of an open gradient feather.
pub(crate) fn gradient_stop(e: &quick_xml::events::BytesStart) -> GradientFeatherStop {
    let location_pct = parse_f(e, b"Location").unwrap_or(0.0);
    // `Opacity` (OpacityGradientStop)
    // takes precedence; `Alpha`
    // (GradientStop spec form) falls
    // back; default 100 (fully opaque)
    // when neither is set.
    let alpha_pct = parse_f(e, b"Opacity")
        .or_else(|| parse_f(e, b"Alpha"))
        .unwrap_or(100.0);
    let midpoint_pct = parse_f(e, b"GradientStopMidpoint")
        .or_else(|| parse_f(e, b"Midpoint"))
        .unwrap_or(50.0);
    GradientFeatherStop {
        stop_color: attr(e, b"StopColor"),
        location_pct,
        alpha_pct,
        midpoint_pct,
    }
}

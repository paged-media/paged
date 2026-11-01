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

//! The resolved paint written back as DrawingML: the inverse of
//! [`super::resolved`], for the modules that save to OOXML. Colours are
//! written by the caller ([`ColorXml`]), so a module that knows its theme
//! can write `a:schemeClr` where the colour still is a theme slot.

use super::resolved::{BevelSide, Effects, Paint, Rgb, Shadow, ThreeD};
use crate::units::{deg_to_angle, fraction_to_pct, pt_to_emu};
use crate::xml::escape_attr;

/// Writes one colour element for a colour and its alpha (0–1).
pub type ColorXml<'a> = &'a dyn Fn(Rgb, f64) -> String;

/// `a:srgbClr`, with an `a:alpha` when below one.
pub fn srgb(rgb: Rgb, alpha: f64) -> String {
    let hex = format!("{:02X}{:02X}{:02X}", rgb[0], rgb[1], rgb[2]);
    if alpha < 0.999 {
        format!(
            r#"<a:srgbClr val="{hex}"><a:alpha val="{}"/></a:srgbClr>"#,
            fraction_to_pct(alpha.clamp(0.0, 1.0))
        )
    } else {
        format!(r#"<a:srgbClr val="{hex}"/>"#)
    }
}

/// The polar form of an offset: `dist` (EMU) and `dir` (60 000ths of a
/// degree, clockwise on a y-down page, 0 ≤ dir < 21 600 000).
pub fn polar(dx: f64, dy: f64) -> (i64, i64) {
    let dist = pt_to_emu(dx.hypot(dy));
    let dir = if dist == 0 {
        0
    } else {
        deg_to_angle(dy.atan2(dx).to_degrees().rem_euclid(360.0)) % 21_600_000
    };
    (dist, dir)
}

fn shadow(tag: &str, s: &Shadow, color: ColorXml, outer: bool) -> String {
    let (dist, dir) = polar(s.dx, s.dy);
    let mut attrs = format!(
        r#" blurRad="{}" dist="{dist}" dir="{dir}""#,
        pt_to_emu(s.blur)
    );
    if outer {
        if let Some((sx, sy, kx, ky)) = s.distortion {
            attrs.push_str(&format!(
                r#" sx="{}" sy="{}" kx="{}" ky="{}""#,
                fraction_to_pct(sx),
                fraction_to_pct(sy),
                deg_to_angle(kx),
                deg_to_angle(ky)
            ));
        }
        attrs.push_str(r#" algn="ctr" rotWithShape="0""#);
    }
    format!("<a:{tag}{attrs}>{}</a:{tag}>", color(s.rgb, s.alpha))
}

/// `a:effectLst` for `fx`, its children in the schema's order (blur,
/// fillOverlay, glow, innerShdw, outerShdw, prstShdw, reflection,
/// softEdge); `None` when there is no effect. A fill overlay is written
/// when its paint is a solid colour or a linear gradient.
pub fn effects(fx: &Effects, color: ColorXml) -> Option<String> {
    let list = Effects {
        three_d: None,
        ..fx.clone()
    };
    if list.is_empty() {
        return None;
    }
    let mut out = String::from("<a:effectLst>");
    if let Some(b) = &fx.blur {
        out.push_str(&format!(
            r#"<a:blur rad="{}" grow="{}"/>"#,
            pt_to_emu(b.radius),
            if b.grow { 1 } else { 0 }
        ));
    }
    if let Some(o) = &fx.fill_overlay {
        let fill = match &o.paint {
            Paint::Solid { rgb, alpha, .. } => Some(format!(
                "<a:solidFill>{}</a:solidFill>",
                color(*rgb, *alpha)
            )),
            Paint::Linear { stops, angle } => Some(format!(
                r#"<a:gradFill rotWithShape="1"><a:gsLst>{}</a:gsLst><a:lin ang="{}" scaled="0"/></a:gradFill>"#,
                stops
                    .iter()
                    .map(|s| format!(
                        r#"<a:gs pos="{}">{}</a:gs>"#,
                        (s.pos * 1000.0).round() as i64,
                        color(s.rgb, s.alpha)
                    ))
                    .collect::<String>(),
                deg_to_angle(angle.rem_euclid(360.0))
            )),
            _ => None,
        };
        if let Some(fill) = fill {
            out.push_str(&format!(
                r#"<a:fillOverlay blend="{}">{fill}</a:fillOverlay>"#,
                escape_attr(&o.blend),
            ));
        }
    }
    if let Some(g) = &fx.glow {
        out.push_str(&format!(
            r#"<a:glow rad="{}">{}</a:glow>"#,
            pt_to_emu(g.radius),
            color(g.rgb, g.alpha)
        ));
    }
    if let Some(s) = &fx.inner_shadow {
        out.push_str(&shadow("innerShdw", s, color, false));
    }
    if let Some(s) = &fx.outer_shadow {
        out.push_str(&shadow("outerShdw", s, color, true));
    }
    if let Some(p) = &fx.preset_shadow {
        let (dist, dir) = polar(p.dx, p.dy);
        out.push_str(&format!(
            r#"<a:prstShdw prst="{}" dist="{dist}" dir="{dir}">{}</a:prstShdw>"#,
            escape_attr(&p.preset),
            color(p.rgb, p.alpha)
        ));
    }
    if let Some(r) = &fx.reflection {
        out.push_str(&format!(
            r#"<a:reflection blurRad="{}" stA="{}" stPos="{}" endA="{}" endPos="{}" dist="{}" dir="{}" fadeDir="{}" sx="{}" sy="{}" kx="{}" ky="{}" algn="{}" rotWithShape="{}"/>"#,
            pt_to_emu(r.blur),
            fraction_to_pct(r.start_alpha),
            fraction_to_pct(r.start_pos),
            fraction_to_pct(r.end_alpha),
            fraction_to_pct(r.end_pos),
            pt_to_emu(r.distance),
            deg_to_angle(r.direction),
            deg_to_angle(r.fade_direction),
            fraction_to_pct(r.sx),
            fraction_to_pct(r.sy),
            deg_to_angle(r.kx),
            deg_to_angle(r.ky),
            escape_attr(&r.align),
            if r.rotate_with_shape { 1 } else { 0 }
        ));
    }
    if let Some(rad) = fx.soft_edge {
        out.push_str(&format!(r#"<a:softEdge rad="{}"/>"#, pt_to_emu(rad)));
    }
    out.push_str("</a:effectLst>");
    Some(out)
}

/// `a:scene3d` and `a:sp3d` for a 3-D look, in that order (they follow
/// the effect list among a shape's properties).
pub fn three_d(t: &ThreeD) -> String {
    let bevel = |tag: &str, b: &BevelSide| {
        format!(
            r#"<a:{tag} w="{}" h="{}" prst="{}"/>"#,
            pt_to_emu(b.width),
            pt_to_emu(b.height),
            escape_attr(&b.preset)
        )
    };
    let mut sp = String::from("<a:sp3d");
    if t.extrusion > 0.0 {
        sp.push_str(&format!(r#" extrusionH="{}""#, pt_to_emu(t.extrusion)));
    }
    if t.contour > 0.0 {
        sp.push_str(&format!(r#" contourW="{}""#, pt_to_emu(t.contour)));
    }
    if let Some(m) = &t.material {
        sp.push_str(&format!(r#" prstMaterial="{}""#, escape_attr(m)));
    }
    sp.push('>');
    if let Some(b) = &t.bevel_top {
        sp.push_str(&bevel("bevelT", b));
    }
    if let Some(b) = &t.bevel_bottom {
        sp.push_str(&bevel("bevelB", b));
    }
    sp.push_str("</a:sp3d>");
    format!(
        r#"<a:scene3d><a:camera prst="{}"/><a:lightRig rig="{}" dir="{}"/></a:scene3d>{sp}"#,
        escape_attr(&t.camera),
        escape_attr(&t.light_rig),
        escape_attr(&t.light_dir)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::drawingml::effect;
    use crate::drawingml::resolved::{self, Blur, Glow, Reflection};
    use crate::tree::parse;

    #[test]
    fn written_effects_read_back_to_the_same_values() {
        let fx = Effects {
            outer_shadow: Some(Shadow {
                dx: 3.0,
                dy: 4.0,
                blur: 6.0,
                rgb: [0, 0, 0],
                alpha: 0.4,
                distortion: None,
            }),
            inner_shadow: Some(Shadow {
                dx: -2.0,
                dy: 0.0,
                blur: 1.0,
                rgb: [255, 0, 0],
                alpha: 1.0,
                distortion: None,
            }),
            glow: Some(Glow {
                radius: 8.0,
                rgb: [255, 192, 0],
                alpha: 0.6,
            }),
            soft_edge: Some(2.5),
            blur: Some(Blur {
                radius: 3.0,
                grow: false,
            }),
            reflection: Some(Reflection {
                blur: 0.5,
                start_alpha: 0.5,
                start_pos: 0.0,
                end_alpha: 0.0,
                end_pos: 0.35,
                distance: 1.0,
                direction: 90.0,
                fade_direction: 90.0,
                sx: 1.0,
                sy: -1.0,
                kx: 0.0,
                ky: 0.0,
                align: "bl".into(),
                rotate_with_shape: false,
            }),
            ..Effects::default()
        };
        let xml = effects(&fx, &srgb).unwrap();
        let ns = r#" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main""#;
        let el = parse(
            xml.replacen("<a:effectLst", &format!("<a:effectLst{ns}"), 1)
                .as_bytes(),
        )
        .unwrap();
        let order: Vec<&str> = el.children.iter().map(|c| c.local.as_str()).collect();
        assert_eq!(
            order,
            [
                "blur",
                "glow",
                "innerShdw",
                "outerShdw",
                "reflection",
                "softEdge"
            ]
        );
        let back = resolved::effects(&effect::effects(&el, &|_| None), &(), &mut |_| {});
        let o = back.outer_shadow.as_ref().unwrap();
        assert!(
            (o.dx - 3.0).abs() < 1e-3 && (o.dy - 4.0).abs() < 1e-3,
            "{o:?}"
        );
        assert_eq!((o.blur, o.alpha), (6.0, 0.4));
        let i = back.inner_shadow.as_ref().unwrap();
        assert!((i.dx + 2.0).abs() < 1e-3 && i.dy.abs() < 1e-3);
        assert_eq!(back.glow, fx.glow);
        assert_eq!(back.soft_edge, fx.soft_edge);
        assert_eq!(back.blur, fx.blur);
        assert_eq!(back.reflection, fx.reflection);
        assert_eq!(effects(&Effects::default(), &srgb), None);
    }

    #[test]
    fn a_gradient_fill_overlay_reads_back() {
        use crate::drawingml::resolved::{FillOverlay, Stop};
        let overlay = FillOverlay {
            blend: "screen".into(),
            paint: Paint::Linear {
                stops: vec![
                    Stop {
                        pos: 0.0,
                        rgb: [255, 0, 0],
                        alpha: 1.0,
                    },
                    Stop {
                        pos: 100.0,
                        rgb: [0, 0, 255],
                        alpha: 0.5,
                    },
                ],
                angle: 90.0,
            },
        };
        let fx = Effects {
            fill_overlay: Some(overlay.clone()),
            ..Effects::default()
        };
        let xml = effects(&fx, &srgb).unwrap();
        let ns = r#" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main""#;
        let el = parse(
            xml.replacen("<a:effectLst", &format!("<a:effectLst{ns}"), 1)
                .as_bytes(),
        )
        .unwrap();
        let back = resolved::effects(&effect::effects(&el, &|_| None), &(), &mut |_| {});
        assert_eq!(back.fill_overlay, Some(overlay));
    }

    #[test]
    fn polar_offsets_run_clockwise_from_plus_x() {
        assert_eq!(polar(0.0, 10.0), (127_000, 5_400_000));
        assert_eq!(polar(-10.0, 0.0), (127_000, 10_800_000));
        assert_eq!(polar(0.0, -1.0), (12_700, 16_200_000));
        assert_eq!(polar(0.0, 0.0), (0, 0));
        assert_eq!(
            srgb([1, 2, 255], 0.5),
            r#"<a:srgbClr val="0102FF"><a:alpha val="50000"/></a:srgbClr>"#
        );
    }

    #[test]
    fn a_bevel_and_its_scene_read_back() {
        let sp = r#"<p:spPr xmlns:p="p" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:prstGeom prst="rect"/><a:scene3d><a:camera prst="orthographicFront"/><a:lightRig rig="threePt" dir="t"/></a:scene3d><a:sp3d><a:bevelT w="228600" prst="angle"/></a:sp3d></p:spPr>"#;
        let el = crate::tree::parse(sp.as_bytes()).unwrap();
        let fx = effect::shape_effects(&el, &|_: &str| None).expect("3-D read");
        let t = crate::drawingml::resolved::three_d(fx.three_d.as_ref().unwrap()).unwrap();
        assert!(t.is_front());
        let top = t.bevel_top.clone().unwrap();
        assert_eq!(
            (top.width, top.height, top.preset.as_str()),
            (18.0, 6.0, "angle")
        );
        // Written back and read again: the same look; no empty effect list.
        let resolved = Effects {
            three_d: Some(t.clone()),
            ..Effects::default()
        };
        assert!(effects(&resolved, &|rgb, a| srgb(rgb, a)).is_none());
        let xml = format!(
            r#"<p:spPr xmlns:p="p" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">{}</p:spPr>"#,
            three_d(&t)
        );
        let el = crate::tree::parse(xml.as_bytes()).unwrap();
        let back = effect::three_d(&el).unwrap();
        assert_eq!(crate::drawingml::resolved::three_d(&back), Some(t));
        // A flat scene alone draws nothing.
        let flat = r#"<p:spPr xmlns:p="p" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:scene3d><a:camera prst="orthographicFront"/><a:lightRig rig="threePt" dir="t"/></a:scene3d><a:sp3d/></p:spPr>"#;
        let el = crate::tree::parse(flat.as_bytes()).unwrap();
        assert!(effect::shape_effects(&el, &|_: &str| None)
            .unwrap()
            .is_empty());
    }
}

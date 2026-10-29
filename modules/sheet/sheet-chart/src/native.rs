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

//! A chart role's gradients, translucency and effects onto native page
//! items (sheet ADR 527, WP10.4).
//!
//! The chart's DrawingML is read as authored ([`DmlFx`]); here it is
//! resolved against the workbook theme (`paged_ooxml::drawingml::resolved`)
//! and lowered through the ONE DrawingML mapper of slide, doc and sheet,
//! `dml-native`: the gradient swatch and its placement, the item opacity,
//! alpha stops as a gradient feather, the outer shadow as the drop shadow,
//! the inner shadow, glow and soft edge as the engine's frame effects, and
//! a line of loss for everything the engine cannot hold yet (reflection,
//! blur, patterns, …). Nothing here maps DrawingML itself.
//!
//! What comes out is [`NativeFx`], an optional field of a geometry
//! primitive: the mapper's result restated with colours as `#RRGGBB` (the
//! page lowering mints its content-addressed chart swatches from them, as
//! it does for every other chart colour) and the gradient's start in
//! chart-content pt (the lowering adds the frame's and the page's origin:
//! the engine reads a page item's gradient start in its spread's
//! coordinates).

use dml_native::{axis_start, feather_of, placement, Mapper, Paint};
use paged_ooxml::drawingml::{resolved, Rgba};

use crate::model::DmlFx;

/// A gradient fill on a native item.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeGradient {
    /// `linear` or `radial`.
    pub kind: &'static str,
    /// (location 0–100, `#RRGGBB`), in position order.
    pub stops: Vec<(f32, String)>,
    /// The engine's angle (counter-clockwise, degrees); linear only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub angle: Option<f32>,
    /// The axis length (linear) or the radius (radial), pt.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub length: Option<f32>,
    /// Where the axis starts (linear) or the centre (radial), in
    /// chart-content pt.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start: Option<(f64, f64)>,
}

/// A drop shadow.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeShadow {
    pub x_offset: f32,
    pub y_offset: f32,
    /// The blur size, pt.
    pub size: f32,
    /// 0–100.
    pub opacity: f32,
    pub color: String,
}

/// An inner shadow, as the engine's editors address it.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeInnerShadow {
    /// Counter-clockwise degrees.
    pub angle: f32,
    pub distance: f32,
    pub size: f32,
    pub opacity: f32,
    pub color: String,
}

/// An outer glow.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeGlow {
    pub size: f32,
    pub opacity: f32,
    pub color: String,
}

/// A gradient feather (a fill whose stops fade).
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeFeather {
    /// `Linear` or `Radial`.
    pub gradient_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub angle: Option<f32>,
    /// (location 0–100, opacity 0–100).
    pub stops: Vec<(f32, f32)>,
}

/// What a primitive carries beyond its solid fill and stroke: each field
/// omitted when unset.
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeFx {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gradient: Option<NativeGradient>,
    /// The item's opacity, 0–100.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opacity: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub drop_shadow: Option<NativeShadow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inner_shadow: Option<NativeInnerShadow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outer_glow: Option<NativeGlow>,
    /// A soft edge's width, pt.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub feather: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gradient_feather: Option<NativeFeather>,
}

impl NativeFx {
    pub fn is_empty(&self) -> bool {
        *self == NativeFx::default()
    }

    /// Every colour it paints with (`#RRGGBB`), for the swatch mint.
    pub fn colors(&self) -> Vec<&str> {
        let mut out: Vec<&str> = Vec::new();
        if let Some(g) = &self.gradient {
            out.extend(g.stops.iter().map(|(_, c)| c.as_str()));
        }
        out.extend(self.drop_shadow.as_ref().map(|s| s.color.as_str()));
        out.extend(self.inner_shadow.as_ref().map(|s| s.color.as_str()));
        out.extend(self.outer_glow.as_ref().map(|s| s.color.as_str()));
        out
    }
}

/// What lowering one role on one item gives: its native look, and the
/// solid colour a pattern is drawn in.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Lowered {
    pub fx: Option<NativeFx>,
    /// A pattern's mixed colour, `#RRGGBB`, in place of the role's fill.
    pub fill: Option<String>,
}

/// The workbook theme as DrawingML scheme slots (with the colour map's
/// aliases Excel charts use: `tx1` is `dk1`, `bg1` is `lt1`, …).
fn scheme_slots(theme: &[u32; 12]) -> Vec<(String, Rgba)> {
    const NAMES: [&[&str]; 12] = [
        &["dk1", "tx1"],
        &["lt1", "bg1"],
        &["dk2", "tx2"],
        &["lt2", "bg2"],
        &["accent1"],
        &["accent2"],
        &["accent3"],
        &["accent4"],
        &["accent5"],
        &["accent6"],
        &["hlink"],
        &["folHlink"],
    ];
    NAMES
        .iter()
        .zip(theme)
        .flat_map(|(names, &rgb)| {
            names
                .iter()
                .map(move |n| (n.to_string(), Rgba::from_hex(rgb)))
        })
        .collect()
}

fn hex(rgb: [u8; 3]) -> String {
    format!("#{:02X}{:02X}{:02X}", rgb[0], rgb[1], rgb[2])
}

/// One chart's lowering: the theme, and the shared mapper with what it
/// could not hold.
pub struct NativeLowering {
    slots: Vec<(String, Rgba)>,
    mapper: Mapper,
}

impl NativeLowering {
    pub fn new(theme: &[u32; 12]) -> NativeLowering {
        NativeLowering {
            slots: scheme_slots(theme),
            mapper: Mapper::default(),
        }
    }

    /// One line per kind of loss, in the order first met.
    pub fn take_losses(&mut self) -> Vec<String> {
        self.mapper.take_losses()
    }

    /// `#RRGGBB` of a colour swatch the mapper minted.
    fn hex_of(&self, id: &str) -> Option<String> {
        self.mapper
            .palette
            .colors()
            .find(|(_, i)| i.as_str() == id)
            .map(|(rgb, _)| hex(*rgb))
    }

    /// Lower `fx` onto an item whose box is `(x, y, w, h)` in chart-content
    /// pt. `filled`: the item is an area (a bar, slice, area band, chart or
    /// plot area); otherwise a line, which takes the effects alone.
    pub fn lower(
        &mut self,
        fx: &DmlFx,
        (x, y, w, h): (f64, f64, f64, f64),
        filled: bool,
    ) -> Lowered {
        let mut notes: Vec<String> = Vec::new();
        let paint = fx
            .fill
            .as_ref()
            .filter(|_| filled)
            .map(|f| resolved::paint(f, &self.slots, &mut |n| notes.push(n)))
            .unwrap_or_default();
        let effects = resolved::effects(&fx.effects, &self.slots, &mut |n| notes.push(n));
        for n in notes {
            self.mapper.lose(n);
        }
        if !filled {
            if let Some(f) = &fx.line_fill {
                let p = resolved::paint(f, &self.slots, &mut |_| {});
                match p {
                    Paint::Linear { .. } | Paint::Radial { .. } => self.mapper.lose(
                        "a gradient line is drawn in its first colour (lines take no gradient yet)",
                    ),
                    Paint::Pattern(_) => self
                        .mapper
                        .lose("a pattern line is drawn in its foreground colour"),
                    _ => {}
                }
            }
        }
        for name in &fx.effects.unknown {
            self.mapper
                .lose(format!("effect {name} is not carried (not read)"));
        }
        let mut out = NativeFx::default();
        let mut lowered = Lowered::default();
        match &paint {
            Paint::Linear { .. } | Paint::Radial { .. } => {
                let id = self.mapper.paint(&paint);
                let entry = self
                    .mapper
                    .palette
                    .gradient_entries()
                    .into_iter()
                    .find(|g| g.self_id == id);
                if let Some(entry) = entry {
                    let p = placement(&paint, w, h);
                    let start = axis_start(&p, w, h).map(|[sx, sy]| (x + sx as f64, y + sy as f64));
                    out.gradient = Some(NativeGradient {
                        kind: if matches!(paint, Paint::Radial { .. }) {
                            "radial"
                        } else {
                            "linear"
                        },
                        stops: entry
                            .stops
                            .iter()
                            .filter_map(|s| Some((s.location_pct, self.hex_of(&s.stop_color)?)))
                            .collect(),
                        angle: p.angle,
                        length: p.length,
                        start,
                    });
                }
            }
            Paint::Pattern(_) => {
                let id = self.mapper.paint(&paint);
                lowered.fill = self.hex_of(&id);
            }
            _ => {}
        }
        // A translucent fill (one alpha throughout) is the item's opacity;
        // stops that differ in alpha fade it through a gradient feather.
        let opacity = paint.uniform_alpha().unwrap_or(1.0);
        let fade = (filled && feather_of(&paint).is_some()).then_some(&paint);
        let t = self.mapper.transparency(opacity, &effects, fade);
        self.restate(&t, &mut out);
        lowered.fx = (!out.is_empty()).then_some(out);
        lowered
    }

    /// A drawing picture's look: its `a:blip` (`a:alphaModFix` as the
    /// opacity; every other picture effect reported, the Office 2010
    /// corrections already in the stored image) and its shape's effect
    /// list, as the shared mapper lowers them.
    pub fn picture(
        &mut self,
        blip: &paged_ooxml::drawingml::Blip,
        effects: &paged_ooxml::drawingml::Effects,
    ) -> Option<NativeFx> {
        let pic = resolved::picture(blip, &self.slots);
        // The filter stack (engine ADR 1037) is not carried here; the
        // opacity is.
        let opacity = self.mapper.picture(&pic).opacity;
        let mut notes: Vec<String> = Vec::new();
        let fx = resolved::effects(effects, &self.slots, &mut |n| notes.push(n));
        for n in notes {
            self.mapper.lose(n);
        }
        for name in &effects.unknown {
            self.mapper
                .lose(format!("effect {name} is not carried (not read)"));
        }
        let t = self.mapper.transparency(opacity, &fx, None);
        let mut out = NativeFx::default();
        self.restate(&t, &mut out);
        (!out.is_empty()).then_some(out)
    }

    /// The mapper's transparency restated for the wire: colours as hex, the
    /// inner shadow by angle and distance.
    fn restate(&self, t: &dml_native::Transparency, out: &mut NativeFx) {
        out.opacity = t.opacity;
        if let Some(s) = &t.shadow {
            out.drop_shadow = Some(NativeShadow {
                x_offset: s.x_offset,
                y_offset: s.y_offset,
                size: s.size,
                opacity: s.opacity_pct,
                color: s
                    .effect_color
                    .as_deref()
                    .and_then(|c| self.hex_of(c))
                    .unwrap_or_else(|| "#000000".into()),
            });
        }
        if let Some(e) = &t.effects {
            let color = |c: &Option<String>| {
                c.as_deref()
                    .and_then(|c| self.hex_of(c))
                    .unwrap_or_else(|| "#000000".into())
            };
            out.inner_shadow = e.inner_shadow.as_ref().map(|s| {
                let (dx, dy) = (
                    s.x_offset.unwrap_or(0.0) as f64,
                    s.y_offset.unwrap_or(0.0) as f64,
                );
                NativeInnerShadow {
                    // The engine's angle runs counter-clockwise on the
                    // y-down page: an offset (dx, dy) is at atan2(−dy, dx).
                    angle: dml_native::pt((-dy).atan2(dx).to_degrees()),
                    distance: dml_native::pt(dx.hypot(dy)),
                    size: s.size.unwrap_or(0.0),
                    opacity: s.opacity_pct.unwrap_or(75.0),
                    color: color(&s.effect_color),
                }
            });
            out.outer_glow = e.outer_glow.as_ref().map(|g| NativeGlow {
                size: g.size.unwrap_or(0.0),
                opacity: g.opacity_pct.unwrap_or(75.0),
                color: color(&g.effect_color),
            });
            out.feather = e.feather.as_ref().and_then(|f| f.width);
            out.gradient_feather = e.gradient_feather.as_ref().map(|g| NativeFeather {
                gradient_type: g.gradient_type.clone().unwrap_or_else(|| "Linear".into()),
                angle: g.angle_deg,
                stops: g
                    .stops
                    .iter()
                    .map(|s| (s.location_pct, s.alpha_pct))
                    .collect(),
            });
        }
    }
}

/// A drawing picture's native look against the workbook theme (sheet ADR
/// 527), and what the page cannot hold of it, one line per kind.
pub fn picture_fx(
    theme: &[u32; 12],
    blip: &paged_ooxml::drawingml::Blip,
    effects: &paged_ooxml::drawingml::Effects,
) -> (Option<NativeFx>, Vec<String>) {
    let mut n = NativeLowering::new(theme);
    let fx = n.picture(blip, effects);
    (fx, n.take_losses())
}

/// The bounding box `(x, y, w, h)` of a point list.
pub(crate) fn bbox(pts: &[(f64, f64)]) -> (f64, f64, f64, f64) {
    let mut b = (
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    );
    for &(px, py) in pts {
        b = (b.0.min(px), b.1.min(py), b.2.max(px), b.3.max(py));
    }
    if !b.0.is_finite() {
        return (0.0, 0.0, 0.0, 0.0);
    }
    (b.0, b.1, b.2 - b.0, b.3 - b.1)
}

/// The box of a wedge as the page lowering flattens it (its centre unless
/// it is a full disc or a ring segment, its arc at 6° steps).
pub(crate) fn wedge_bbox(
    cx: f64,
    cy: f64,
    r: f64,
    inner: f64,
    start: f64,
    end: f64,
) -> (f64, f64, f64, f64) {
    let span = end - start;
    let steps = ((span.abs() / 6.0).ceil() as usize).max(1);
    let mut pts: Vec<(f64, f64)> = Vec::with_capacity(steps * 2 + 2);
    let full = (span - 360.0).abs() < 1e-6 || span.abs() >= 360.0;
    if !full && inner <= 0.0 {
        pts.push((cx, cy));
    }
    let at = |rad: f64, deg: f64| {
        let a = deg.to_radians();
        (cx + rad * a.sin(), cy - rad * a.cos())
    };
    for i in 0..=steps {
        let d = start + span * i as f64 / steps as f64;
        pts.push(at(r, d));
        if inner > 0.0 {
            pts.push(at(inner, d));
        }
    }
    bbox(&pts)
}

/// Theme colours of a chart's lowering, by slot (for the tests).
#[cfg(test)]
pub(crate) fn slots_of(theme: &[u32; 12]) -> std::collections::BTreeMap<String, u32> {
    scheme_slots(theme)
        .into_iter()
        .map(|(k, v)| (k, v.hex()))
        .collect()
}

#[cfg(test)]
#[allow(non_snake_case)] // `__feat__<id>` test-name links (cockpit rule)
mod tests {
    use super::*;
    use crate::colors::OFFICE_THEME;
    use paged_ooxml::tree::parse;

    const NS: &str = r#"xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main""#;

    fn fx_of(sp: &str) -> DmlFx {
        let el = parse(format!(r#"<a:spPr {NS}>{sp}</a:spPr>"#).as_bytes()).unwrap();
        let rels = |_: &str| None;
        DmlFx {
            fill: paged_ooxml::drawingml::fill_in(&el, &rels),
            line_fill: None,
            effects: el
                .child(paged_ooxml::tree::Ns::A, "effectLst")
                .map(|e| paged_ooxml::drawingml::effects(e, &rels))
                .unwrap_or_default(),
        }
    }

    #[test]
    fn theme_slots_carry_the_colour_map_aliases__feat__sheet_chart_native_effects() {
        let s = slots_of(&OFFICE_THEME);
        assert_eq!(s["tx1"], 0x000000);
        assert_eq!(s["bg1"], 0xFFFFFF);
        assert_eq!(s["accent1"], 0x4472C4);
    }

    #[test]
    fn a_vertical_gradient_with_alpha_stops_and_a_shadow__feat__sheet_chart_native_effects() {
        let fx = fx_of(
            r#"<a:gradFill><a:gsLst><a:gs pos="0"><a:schemeClr val="accent1"/></a:gs><a:gs pos="100000"><a:schemeClr val="accent1"><a:alpha val="25000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill><a:effectLst><a:outerShdw blurRad="50800" dist="38100" dir="5400000" algn="t" rotWithShape="0"><a:prstClr val="black"><a:alpha val="40000"/></a:prstClr></a:outerShdw></a:effectLst>"#,
        );
        let mut n = NativeLowering::new(&OFFICE_THEME);
        let l = n.lower(&fx, (10.0, 20.0, 40.0, 100.0), true);
        let f = l.fx.unwrap();
        let g = f.gradient.unwrap();
        assert_eq!(g.kind, "linear");
        assert_eq!(
            g.stops,
            vec![(0.0, "#4472C4".into()), (100.0, "#4472C4".into())]
        );
        assert_eq!(g.angle, Some(-90.0));
        assert_eq!(g.length, Some(100.0));
        // Top to bottom from the middle of the top edge, in content pt.
        assert_eq!(g.start, Some((30.0, 20.0)));
        let gf = f.gradient_feather.unwrap();
        assert_eq!(gf.stops, vec![(0.0, 100.0), (100.0, 25.0)]);
        let s = f.drop_shadow.unwrap();
        assert_eq!(
            (s.x_offset, s.y_offset, s.size, s.opacity),
            (0.0, 3.0, 2.0, 40.0)
        );
        assert_eq!(s.color, "#000000");
        assert!(n.take_losses().is_empty());
    }

    #[test]
    fn inner_shadow_glow_and_soft_edge_become_frame_effects__feat__sheet_chart_native_effects() {
        let fx = fx_of(
            r#"<a:solidFill><a:srgbClr val="FF0000"><a:alpha val="50000"/></a:srgbClr></a:solidFill><a:effectLst><a:glow rad="63500"><a:srgbClr val="FFC000"><a:alpha val="60000"/></a:srgbClr></a:glow><a:innerShdw blurRad="63500" dist="50800" dir="2700000"><a:srgbClr val="000000"/></a:innerShdw><a:softEdge rad="31750"/></a:effectLst>"#,
        );
        let mut n = NativeLowering::new(&OFFICE_THEME);
        let f = n.lower(&fx, (0.0, 0.0, 50.0, 50.0), true).fx.unwrap();
        assert_eq!(f.opacity, Some(50.0));
        let g = f.outer_glow.unwrap();
        assert_eq!(
            (g.size, g.opacity, g.color.as_str()),
            (5.0, 60.0, "#FFC000")
        );
        let i = f.inner_shadow.unwrap();
        // 4 pt down-right (DrawingML 45° clockwise) is the engine's −45°.
        assert_eq!((i.angle, i.size), (-45.0, 2.5));
        // The mapper keeps offsets to the thousandth of a point.
        assert!((i.distance - 4.0).abs() < 2e-3, "{}", i.distance);
        assert_eq!(f.feather, Some(2.5));
        assert!(f.gradient.is_none());
    }

    #[test]
    fn what_the_engine_cannot_hold_is_reported__feat__sheet_chart_native_effects() {
        let fx = fx_of(
            r#"<a:pattFill prst="pct50"><a:fgClr><a:srgbClr val="000000"/></a:fgClr><a:bgClr><a:srgbClr val="FFFFFF"/></a:bgClr></a:pattFill><a:effectLst><a:reflection blurRad="6350" stA="50000" endA="300" endPos="55000" dir="5400000" sy="-100000" algn="bl" rotWithShape="0"/></a:effectLst>"#,
        );
        let mut n = NativeLowering::new(&OFFICE_THEME);
        let l = n.lower(&fx, (0.0, 0.0, 10.0, 10.0), true);
        assert_eq!(l.fill.as_deref(), Some("#808080"));
        assert!(l.fx.is_none());
        let losses = n.take_losses();
        assert!(losses.iter().any(|l| l.contains("pattern")), "{losses:?}");
        assert!(
            losses.iter().any(|l| l.contains("reflection")),
            "{losses:?}"
        );
    }

    #[test]
    fn a_line_takes_the_effects_alone__feat__sheet_chart_native_effects() {
        let mut fx = fx_of(
            r#"<a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="FF0000"/></a:gs><a:gs pos="100000"><a:srgbClr val="0000FF"/></a:gs></a:gsLst></a:gradFill><a:effectLst><a:outerShdw blurRad="25400" dist="25400" dir="0"><a:srgbClr val="000000"/></a:outerShdw></a:effectLst>"#,
        );
        fx.line_fill = fx.fill.clone();
        let mut n = NativeLowering::new(&OFFICE_THEME);
        let f = n.lower(&fx, (0.0, 0.0, 100.0, 10.0), false).fx.unwrap();
        assert!(f.gradient.is_none() && f.gradient_feather.is_none());
        assert_eq!(f.drop_shadow.unwrap().x_offset, 2.0);
        assert!(n.take_losses()[0].contains("gradient line"));
    }

    #[test]
    fn a_picture_takes_its_alpha_and_shadow_and_reports_its_adjustments__feat__sheet_chart_native_effects(
    ) {
        let el = parse(
            format!(r#"<a:blipFill {NS} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><a:blip r:embed="rId1"><a:alphaModFix amt="60000"/><a:grayscl/></a:blip><a:stretch/></a:blipFill>"#)
                .as_bytes(),
        )
        .unwrap();
        let blip = paged_ooxml::drawingml::blip(&el, &|_| None);
        let fx = fx_of(
            r#"<a:effectLst><a:outerShdw blurRad="50800" dist="38100" dir="2700000"><a:srgbClr val="000000"><a:alpha val="40000"/></a:srgbClr></a:outerShdw></a:effectLst>"#,
        );
        let (out, losses) = picture_fx(&OFFICE_THEME, &blip, &fx.effects);
        let out = out.unwrap();
        assert_eq!(out.opacity, Some(60.0));
        assert_eq!(out.drop_shadow.unwrap().opacity, 40.0);
        assert!(losses[0].contains("a:grayscl"), "{losses:?}");
    }

    #[test]
    fn a_wedge_box_follows_its_arc() {
        let (x, y, w, h) = wedge_bbox(50.0, 50.0, 10.0, 0.0, 0.0, 90.0);
        assert!((x - 50.0).abs() < 1e-9 && (y - 40.0).abs() < 1e-9);
        assert!((w - 10.0).abs() < 1e-9 && (h - 10.0).abs() < 1e-9);
    }
}

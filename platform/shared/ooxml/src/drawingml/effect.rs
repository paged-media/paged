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

//! DrawingML effects as authored: `a:effectLst` (ECMA-376 §20.1.8.26) —
//! outer, inner and preset shadows, glow, soft edge, reflection, blur and
//! fill overlay. Lengths in EMU, angles in 60 000ths of a degree,
//! percentages in 1 000ths of a percent.

use super::color::{color_in, Color};
use super::paint::{fill_in, Fill, Rels};
use crate::tree::{El, Ns};

/// `a:effectLst`. Every effect is optional; [`Effects::unknown`] names the
/// children the reader did not model (`a:effectDag` content, extensions).
#[derive(Debug, Clone, Default, PartialEq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct Effects {
    pub outer_shadow: Option<Shadow>,
    pub inner_shadow: Option<Shadow>,
    pub preset_shadow: Option<PresetShadow>,
    pub glow: Option<Glow>,
    /// `a:softEdge rad`, EMU.
    pub soft_edge: Option<i64>,
    pub reflection: Option<Reflection>,
    pub blur: Option<Blur>,
    pub fill_overlay: Option<FillOverlay>,
    /// The shape's 3-D look (`a:scene3d`, `a:sp3d`), read beside the
    /// effect list from the same properties ([`three_d`]).
    #[cfg_attr(feature = "serde", serde(default))]
    pub three_d: Option<Shape3d>,
    /// The properties held a 3-D look and no effect list: the list is
    /// inherited (from a shape style's effect reference), the 3-D look not.
    #[cfg_attr(feature = "serde", serde(default))]
    pub three_d_only: bool,
    /// Local names of the children not modelled, in file order.
    #[cfg_attr(feature = "serde", serde(default))]
    pub unknown: Vec<String>,
}

impl Effects {
    /// No effect at all.
    pub fn is_empty(&self) -> bool {
        self.outer_shadow.is_none()
            && self.inner_shadow.is_none()
            && self.preset_shadow.is_none()
            && self.glow.is_none()
            && self.soft_edge.is_none()
            && self.reflection.is_none()
            && self.blur.is_none()
            && self.fill_overlay.is_none()
            && self.three_d.as_ref().is_none_or(Shape3d::is_flat)
    }
}

/// A shape's 3-D properties: the scene it is seen in (`a:scene3d`) and
/// its own depth (`a:sp3d`, ECMA-376 §20.1.5.12). Lengths in EMU.
#[derive(Debug, Clone, Default, PartialEq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct Shape3d {
    /// `a:camera prst` (`orthographicFront` is the flat view).
    pub camera: Option<String>,
    /// The camera carries a rotation (`a:camera/a:rot`) or a field of view.
    #[cfg_attr(feature = "serde", serde(default))]
    pub camera_turned: bool,
    /// `a:lightRig rig` and `dir` (`threePt`, `t` by default).
    pub light_rig: Option<String>,
    pub light_dir: Option<String>,
    /// `a:bevelT`, `a:bevelB`.
    pub bevel_top: Option<Bevel>,
    pub bevel_bottom: Option<Bevel>,
    /// `extrusionH`, `contourW`, `z` (EMU) and `prstMaterial`.
    #[cfg_attr(feature = "serde", serde(default))]
    pub extrusion: i64,
    #[cfg_attr(feature = "serde", serde(default))]
    pub contour: i64,
    #[cfg_attr(feature = "serde", serde(default))]
    pub z: i64,
    pub material: Option<String>,
}

impl Shape3d {
    /// Nothing 3-D to draw: no bevel, extrusion or contour.
    pub fn is_flat(&self) -> bool {
        self.bevel_top.is_none()
            && self.bevel_bottom.is_none()
            && self.extrusion == 0
            && self.contour == 0
    }
}

/// `a:bevelT` / `a:bevelB`: `w` and `h` in EMU (6 pt each by default),
/// `prst` one of the twelve bevel presets (`circle` by default).
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct Bevel {
    pub w: i64,
    pub h: i64,
    pub preset: String,
}

fn bevel(el: Option<&El>) -> Option<Bevel> {
    let b = el?;
    Some(Bevel {
        w: b.attr_i64("w").unwrap_or(76_200),
        h: b.attr_i64("h").unwrap_or(76_200),
        preset: b.attr("prst").unwrap_or("circle").to_string(),
    })
}

/// The 3-D properties among a shape's properties (`a:spPr`, an
/// `a:effectStyle`), `None` when it has neither `a:scene3d` nor `a:sp3d`.
pub fn three_d(parent: &El) -> Option<Shape3d> {
    let scene = parent.child(Ns::A, "scene3d");
    let sp = parent.child(Ns::A, "sp3d");
    if scene.is_none() && sp.is_none() {
        return None;
    }
    let camera = scene.and_then(|s| s.child(Ns::A, "camera"));
    let rig = scene.and_then(|s| s.child(Ns::A, "lightRig"));
    Some(Shape3d {
        camera: camera.and_then(|c| c.attr("prst")).map(str::to_string),
        camera_turned: camera
            .is_some_and(|c| c.child(Ns::A, "rot").is_some() || c.attr("fov").is_some()),
        light_rig: rig.and_then(|r| r.attr("rig")).map(str::to_string),
        light_dir: rig.and_then(|r| r.attr("dir")).map(str::to_string),
        bevel_top: bevel(sp.and_then(|s| s.child(Ns::A, "bevelT"))),
        bevel_bottom: bevel(sp.and_then(|s| s.child(Ns::A, "bevelB"))),
        extrusion: sp.and_then(|s| s.attr_i64("extrusionH")).unwrap_or(0),
        contour: sp.and_then(|s| s.attr_i64("contourW")).unwrap_or(0),
        z: sp.and_then(|s| s.attr_i64("z")).unwrap_or(0),
        material: sp.and_then(|s| s.attr("prstMaterial")).map(str::to_string),
    })
}

/// A shape's effects and 3-D look: [`effects_in`] with [`three_d`]
/// beside it; `None` when it has neither.
pub fn shape_effects(parent: &El, rels: Rels) -> Option<Effects> {
    let mut fx = container(parent).map(|e| effects(e, rels));
    if let Some(t) = three_d(parent) {
        let only = fx.is_none();
        let fx = fx.get_or_insert_with(Effects::default);
        fx.three_d = Some(t);
        fx.three_d_only = only;
    }
    fx
}

/// `a:outerShdw` / `a:innerShdw`. The scale, skew and alignment are the
/// outer shadow's (an inner one has none: identity, `None`).
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct Shadow {
    /// `blurRad`, EMU.
    pub blur: i64,
    /// `dist`, EMU.
    pub dist: i64,
    /// `dir`, 60 000ths of a degree, clockwise from +x.
    pub dir: i32,
    pub color: Color,
    /// `sx`, `sy` (1 000ths of a percent, default 100 000).
    #[cfg_attr(feature = "serde", serde(default))]
    pub scale: Option<(i32, i32)>,
    /// `kx`, `ky` (60 000ths of a degree, default 0).
    #[cfg_attr(feature = "serde", serde(default))]
    pub skew: Option<(i32, i32)>,
    /// `algn` (default `b`).
    #[cfg_attr(feature = "serde", serde(default))]
    pub align: Option<String>,
    /// `rotWithShape` (default true).
    #[cfg_attr(feature = "serde", serde(default))]
    pub rotate_with_shape: Option<bool>,
}

/// `a:prstShdw`: one of PowerPoint's twenty preset shadows (`shdw1` …
/// `shdw20`), cast at `dist` along `dir`.
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct PresetShadow {
    pub preset: String,
    pub dist: i64,
    pub dir: i32,
    pub color: Color,
}

/// `a:glow`.
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct Glow {
    /// `rad`, EMU.
    pub radius: i64,
    pub color: Color,
}

/// `a:reflection` (every attribute with its schema default).
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct Reflection {
    /// `blurRad`, EMU.
    pub blur: i64,
    /// `stA`, `stPos`, `endA`, `endPos` (1 000ths of a percent): the fade.
    pub start_alpha: i32,
    pub start_pos: i32,
    pub end_alpha: i32,
    pub end_pos: i32,
    /// `dist`, EMU; `dir`, `fadeDir` (60 000ths of a degree).
    pub dist: i64,
    pub dir: i32,
    pub fade_dir: i32,
    /// `sx`, `sy` (1 000ths of a percent): `sy` −100 000 mirrors.
    pub sx: i32,
    pub sy: i32,
    /// `kx`, `ky` (60 000ths of a degree).
    pub kx: i32,
    pub ky: i32,
    /// `algn`.
    pub align: String,
    pub rotate_with_shape: bool,
}

/// `a:blur`.
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct Blur {
    /// `rad`, EMU.
    pub radius: i64,
    /// `grow`: the blur extends past the bounds (default true).
    pub grow: bool,
}

/// `a:fillOverlay`: a fill blended over the shape.
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct FillOverlay {
    /// `blend` (over, mult, screen, darken, lighten).
    pub blend: String,
    pub fill: Box<Fill>,
}

fn shadow(s: &El) -> Option<Shadow> {
    let outer = s.local == "outerShdw";
    let pair = |a: &str, b: &str, d: i32| {
        let (x, y) = (s.attr_i32(a), s.attr_i32(b));
        (outer && (x.is_some() || y.is_some())).then(|| (x.unwrap_or(d), y.unwrap_or(d)))
    };
    Some(Shadow {
        blur: s.attr_i64("blurRad").unwrap_or(0),
        dist: s.attr_i64("dist").unwrap_or(0),
        dir: s.attr_i32("dir").unwrap_or(0),
        color: color_in(s)?,
        scale: pair("sx", "sy", 100_000),
        skew: pair("kx", "ky", 0),
        align: s.attr("algn").filter(|_| outer).map(str::to_string),
        rotate_with_shape: s.attr_bool("rotWithShape").filter(|_| outer),
    })
}

/// The effect container among a shape's properties: its `a:effectLst`,
/// or, when it has none, its `a:effectDag`.
///
/// A DAG's direct children are read as a list ([`effects`]): its effects
/// in the order the list keeps, and its containers (`a:cont`) and the
/// effects only a DAG holds (`a:alphaMod`, `a:xfrm`, …) named in
/// [`Effects::unknown`], so the lowering reports them.
pub fn container(parent: &El) -> Option<&El> {
    parent
        .child(Ns::A, "effectLst")
        .or_else(|| parent.child(Ns::A, "effectDag"))
}

/// The effects of a shape's properties ([`container`]), empty when it
/// has none.
pub fn effects_in(parent: &El, rels: Rels) -> Effects {
    container(parent)
        .map(|e| effects(e, rels))
        .unwrap_or_default()
}

/// `a:effectLst` (an `a:effectDag`'s direct effects read the same way).
pub fn effects(el: &El, rels: Rels) -> Effects {
    let mut fx = Effects::default();
    for c in &el.children {
        if c.ns != Ns::A {
            fx.unknown.push(c.local.clone());
            continue;
        }
        let pct = |n: &str, d: i32| c.attr_i32(n).unwrap_or(d);
        match c.local.as_str() {
            "outerShdw" => fx.outer_shadow = shadow(c),
            "innerShdw" => fx.inner_shadow = shadow(c),
            "prstShdw" => {
                fx.preset_shadow = color_in(c).map(|color| PresetShadow {
                    preset: c.attr("prst").unwrap_or("shdw1").to_string(),
                    dist: c.attr_i64("dist").unwrap_or(0),
                    dir: c.attr_i32("dir").unwrap_or(0),
                    color,
                })
            }
            "glow" => {
                fx.glow = color_in(c).map(|color| Glow {
                    radius: c.attr_i64("rad").unwrap_or(0),
                    color,
                })
            }
            "softEdge" => fx.soft_edge = c.attr_i64("rad"),
            "reflection" => {
                fx.reflection = Some(Reflection {
                    blur: c.attr_i64("blurRad").unwrap_or(0),
                    start_alpha: pct("stA", 100_000),
                    start_pos: pct("stPos", 0),
                    end_alpha: pct("endA", 0),
                    end_pos: pct("endPos", 100_000),
                    dist: c.attr_i64("dist").unwrap_or(0),
                    dir: pct("dir", 0),
                    fade_dir: pct("fadeDir", 5_400_000),
                    sx: pct("sx", 100_000),
                    sy: pct("sy", 100_000),
                    kx: pct("kx", 0),
                    ky: pct("ky", 0),
                    align: c.attr("algn").unwrap_or("b").to_string(),
                    rotate_with_shape: c.attr_bool("rotWithShape").unwrap_or(true),
                })
            }
            "blur" => {
                fx.blur = Some(Blur {
                    radius: c.attr_i64("rad").unwrap_or(0),
                    grow: c.attr_bool("grow").unwrap_or(true),
                })
            }
            "fillOverlay" => {
                fx.fill_overlay = fill_in(c, rels).map(|f| FillOverlay {
                    blend: c.attr("blend").unwrap_or("over").to_string(),
                    fill: Box::new(f),
                })
            }
            other => fx.unknown.push(other.to_string()),
        }
    }
    fx
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::drawingml::color::ColorBase;
    use crate::tree::parse;

    const NS: &str = r#"xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main""#;

    fn read(inner: &str) -> Effects {
        let el = parse(format!(r#"<a:effectLst {NS}>{inner}</a:effectLst>"#).as_bytes()).unwrap();
        effects(&el, &|_| None)
    }

    #[test]
    fn shadows_read_with_distortion_only_on_the_outer_one() {
        let fx = read(
            r#"<a:outerShdw blurRad="50800" dist="38100" dir="2700000" sx="90000" sy="-30000" kx="-1200000" algn="bl" rotWithShape="0"><a:srgbClr val="000000"><a:alpha val="40000"/></a:srgbClr></a:outerShdw><a:innerShdw blurRad="63500" dist="50800" dir="13500000"><a:prstClr val="black"/></a:innerShdw>"#,
        );
        let o = fx.outer_shadow.unwrap();
        assert_eq!((o.blur, o.dist, o.dir), (50_800, 38_100, 2_700_000));
        assert_eq!(o.scale, Some((90_000, -30_000)));
        assert_eq!(o.skew, Some((-1_200_000, 0)));
        assert_eq!(o.align.as_deref(), Some("bl"));
        assert_eq!(o.rotate_with_shape, Some(false));
        let i = fx.inner_shadow.unwrap();
        assert_eq!((i.blur, i.dist, i.dir), (63_500, 50_800, 13_500_000));
        assert_eq!((i.scale, i.skew, i.align), (None, None, None));
        assert_eq!(i.color.base, ColorBase::Preset("black".into()));
    }

    #[test]
    fn glow_soft_edge_blur_reflection_preset_shadow_and_overlay() {
        let fx = read(
            r#"<a:glow rad="101600"><a:schemeClr val="accent1"><a:alpha val="60000"/></a:schemeClr></a:glow><a:softEdge rad="31750"/><a:blur rad="12700" grow="0"/><a:reflection blurRad="6350" stA="52000" endA="300" endPos="35000" dir="5400000" sy="-100000" algn="bl" rotWithShape="0"/><a:prstShdw prst="shdw17" dist="17961" dir="2700000"><a:srgbClr val="808080"/></a:prstShdw><a:fillOverlay blend="mult"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:fillOverlay><a:effectDag/>"#,
        );
        let g = fx.glow.unwrap();
        assert_eq!(g.radius, 101_600);
        assert_eq!(g.color.transforms, vec![("alpha".into(), 60_000)]);
        assert_eq!(fx.soft_edge, Some(31_750));
        assert_eq!(
            fx.blur,
            Some(Blur {
                radius: 12_700,
                grow: false
            })
        );
        let r = fx.reflection.unwrap();
        assert_eq!((r.blur, r.start_alpha, r.start_pos), (6_350, 52_000, 0));
        assert_eq!(
            (r.end_alpha, r.end_pos, r.dir, r.fade_dir),
            (300, 35_000, 5_400_000, 5_400_000)
        );
        assert_eq!(
            (r.sx, r.sy, r.align.as_str(), r.rotate_with_shape),
            (100_000, -100_000, "bl", false)
        );
        let p = fx.preset_shadow.unwrap();
        assert_eq!(
            (p.preset.as_str(), p.dist, p.dir),
            ("shdw17", 17_961, 2_700_000)
        );
        let o = fx.fill_overlay.unwrap();
        assert_eq!(o.blend, "mult");
        assert_eq!(*o.fill, Fill::Solid(Color::srgb(0xff0000)));
        assert_eq!(fx.unknown, ["effectDag"]);
        assert!(read("").is_empty());
    }

    #[test]
    fn an_effect_dag_reads_its_direct_effects_and_names_the_rest() {
        let sp = parse(
            format!(
                r#"<p:spPr xmlns:p="p" {NS}><a:effectDag><a:blur rad="25400"/><a:cont type="tree"><a:glow rad="1"><a:srgbClr val="FF0000"/></a:glow></a:cont><a:alphaModFix amt="50000"/></a:effectDag></p:spPr>"#
            )
            .as_bytes(),
        )
        .unwrap();
        let fx = effects_in(&sp, &|_| None);
        assert_eq!(fx.blur.map(|b| b.radius), Some(25_400));
        assert!(fx.glow.is_none());
        assert_eq!(fx.unknown, ["cont", "alphaModFix"]);
        // A list wins over a DAG beside it.
        let sp = parse(
            format!(
                r#"<p:spPr xmlns:p="p" {NS}><a:effectLst><a:softEdge rad="12700"/></a:effectLst><a:effectDag><a:blur rad="25400"/></a:effectDag></p:spPr>"#
            )
            .as_bytes(),
        )
        .unwrap();
        let fx = effects_in(&sp, &|_| None);
        assert_eq!((fx.soft_edge, fx.blur), (Some(12_700), None));
        assert!(effects_in(
            &parse(format!(r#"<a:spPr {NS}/>"#).as_bytes()).unwrap(),
            &|_| None
        )
        .is_empty());
    }
}

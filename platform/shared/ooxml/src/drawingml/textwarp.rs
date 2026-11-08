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

//! Text warps (WordArt): `a:bodyPr/a:prstTxWarp` (engine ADR 1091).
//!
//! DrawingML bends a text body to one of 41 preset shapes (`ST_TextShapeType`),
//! each with up to three adjust values from an `a:avLst`. Word (`wps:bodyPr`),
//! PowerPoint (`a:bodyPr`) and Excel shapes carry the same element, so one
//! reader serves them. It names the preset and keeps the adjusts as written
//! (`val` strings of the `fmla` attribute, `val 50000`); the *geometry* of a
//! preset (its guide curves) is the engine's, in the envelope the text outline
//! is mapped through (ADR 1091).

use crate::tree::{El, Ns};

macro_rules! presets {
    ($($variant:ident = $name:literal => $family:ident),+ $(,)?) => {
        /// One of the 41 `ST_TextShapeType` presets.
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        pub enum Preset { $($variant),+ }

        impl Preset {
            /// Every preset, in the schema's order.
            pub const ALL: &'static [Preset] = &[$(Preset::$variant),+];

            /// The `prst` attribute value.
            pub fn name(self) -> &'static str {
                match self { $(Preset::$variant => $name),+ }
            }

            pub fn from_name(s: &str) -> Option<Preset> {
                match s { $($name => Some(Preset::$variant),)+ _ => None }
            }

            /// The family of guide curves the preset belongs to; the engine
            /// builds one envelope per family from the adjusts.
            pub fn family(self) -> Family {
                match self { $(Preset::$variant => Family::$family),+ }
            }
        }
    };
}

/// How a preset bends the text box: the shape of its top and bottom guide
/// curves (ADR 1091).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Family {
    /// No warp (`textNoShape`) or the plain box (`textPlain`).
    Plain,
    /// Both guides are corner-pinned straight lines that taper or lean:
    /// stop, triangle, chevron, fade, slant, cascade.
    Taper,
    /// The text follows an arc (up or down): the single-line arches.
    Arch,
    /// A full circle or ring: the text follows it, whatever its length.
    Circle,
    /// Arch or circle with the "pour" (the guides are two concentric arcs).
    Pour,
    /// A button: arc on top, the same arc mirrored below.
    Button,
    /// Top and bottom guides are the same curve (curve up/down, can up/down).
    Curve,
    /// Sinusoidal guides: wave 1, wave 2, double wave, wave 4.
    Wave,
    /// The guides bulge or pinch: inflate, deflate and their halves.
    Inflate,
}

presets! {
    NoShape = "textNoShape" => Plain,
    Plain = "textPlain" => Plain,
    Stop = "textStop" => Taper,
    Triangle = "textTriangle" => Taper,
    TriangleInverted = "textTriangleInverted" => Taper,
    Chevron = "textChevron" => Taper,
    ChevronInverted = "textChevronInverted" => Taper,
    RingInside = "textRingInside" => Circle,
    RingOutside = "textRingOutside" => Circle,
    ArchUp = "textArchUp" => Arch,
    ArchDown = "textArchDown" => Arch,
    Circle = "textCircle" => Circle,
    Button = "textButton" => Button,
    ArchUpPour = "textArchUpPour" => Pour,
    ArchDownPour = "textArchDownPour" => Pour,
    CirclePour = "textCirclePour" => Pour,
    ButtonPour = "textButtonPour" => Pour,
    CurveUp = "textCurveUp" => Curve,
    CurveDown = "textCurveDown" => Curve,
    CanUp = "textCanUp" => Curve,
    CanDown = "textCanDown" => Curve,
    Wave1 = "textWave1" => Wave,
    Wave2 = "textWave2" => Wave,
    DoubleWave1 = "textDoubleWave1" => Wave,
    Wave4 = "textWave4" => Wave,
    Inflate = "textInflate" => Inflate,
    Deflate = "textDeflate" => Inflate,
    InflateBottom = "textInflateBottom" => Inflate,
    DeflateBottom = "textDeflateBottom" => Inflate,
    InflateTop = "textInflateTop" => Inflate,
    DeflateTop = "textDeflateTop" => Inflate,
    DeflateInflate = "textDeflateInflate" => Inflate,
    DeflateInflateDeflate = "textDeflateInflateDeflate" => Inflate,
    FadeRight = "textFadeRight" => Taper,
    FadeLeft = "textFadeLeft" => Taper,
    FadeUp = "textFadeUp" => Taper,
    FadeDown = "textFadeDown" => Taper,
    SlantUp = "textSlantUp" => Taper,
    SlantDown = "textSlantDown" => Taper,
    CascadeUp = "textCascadeUp" => Taper,
    CascadeDown = "textCascadeDown" => Taper,
}

/// A text warp as the file states it.
#[derive(Debug, Clone, PartialEq)]
pub struct TextWarp {
    pub preset: Preset,
    /// The `a:gd` adjust values in order: `(name, formula)`, e.g.
    /// `("adj", "val 10800000")`. Unset adjusts take the preset's defaults.
    pub adjusts: Vec<(String, String)>,
}

impl TextWarp {
    /// The value of the adjust `name` when it is a plain `val N`.
    pub fn adjust(&self, name: &str) -> Option<i64> {
        let (_, f) = self.adjusts.iter().find(|(n, _)| n == name)?;
        f.strip_prefix("val ")?.trim().parse().ok()
    }

    /// Does the warp change the text at all?
    pub fn is_active(&self) -> bool {
        !matches!(self.preset, Preset::NoShape | Preset::Plain)
    }
}

/// The warp of an `a:bodyPr` (or `wps:bodyPr`), or `None` when it has none or
/// names a preset this reader does not know (the element stays in the bytes).
pub fn read(body_pr: &El) -> Option<TextWarp> {
    let w = body_pr.child(Ns::A, "prstTxWarp")?;
    let preset = Preset::from_name(w.attr("prst")?)?;
    let adjusts = w
        .child(Ns::A, "avLst")
        .map(|l| {
            l.children_named(Ns::A, "gd")
                .filter_map(|g| Some((g.attr("name")?.to_string(), g.attr("fmla")?.to_string())))
                .collect()
        })
        .unwrap_or_default();
    Some(TextWarp { preset, adjusts })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tree::parse;

    fn body(xml: &str) -> El {
        parse(
            format!(
                r#"<a:bodyPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">{xml}</a:bodyPr>"#
            )
            .as_bytes(),
        )
        .unwrap()
    }

    #[test]
    fn there_are_41_presets_with_unique_names_that_round_trip() {
        assert_eq!(Preset::ALL.len(), 41);
        let mut names: Vec<_> = Preset::ALL.iter().map(|p| p.name()).collect();
        for p in Preset::ALL {
            assert_eq!(Preset::from_name(p.name()), Some(*p));
        }
        names.sort();
        names.dedup();
        assert_eq!(names.len(), 41);
    }

    #[test]
    fn reads_the_preset_and_its_adjusts() {
        let w = read(&body(
            r#"<a:prstTxWarp prst="textArchUp"><a:avLst><a:gd name="adj" fmla="val 10800000"/></a:avLst></a:prstTxWarp>"#,
        ))
        .unwrap();
        assert_eq!(w.preset, Preset::ArchUp);
        assert_eq!(w.preset.family(), Family::Arch);
        assert_eq!(w.adjust("adj"), Some(10_800_000));
        assert_eq!(w.adjust("adj2"), None);
        assert!(w.is_active());
    }

    #[test]
    fn plain_and_absent_and_unknown_are_not_warps() {
        let plain = read(&body(
            r#"<a:prstTxWarp prst="textNoShape"><a:avLst/></a:prstTxWarp>"#,
        ));
        assert!(!plain.unwrap().is_active());
        assert!(read(&body("")).is_none());
        assert!(read(&body(r#"<a:prstTxWarp prst="textFuture"/>"#)).is_none());
    }

    #[test]
    fn a_formula_that_is_not_a_plain_value_is_not_an_adjust() {
        let w = read(&body(
            r#"<a:prstTxWarp prst="textWave1"><a:avLst><a:gd name="adj1" fmla="*/ w 1 2"/></a:avLst></a:prstTxWarp>"#,
        ))
        .unwrap();
        assert_eq!(w.adjust("adj1"), None);
        assert_eq!(w.adjusts.len(), 1);
    }
}

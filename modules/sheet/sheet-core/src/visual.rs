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

//! The cell visual model — the W2.2 amendment of the frozen style types
//! (sheet ADR 518). Additive: [`crate::CellStyle`] keeps its frozen shape
//! (`font`/`fill`/`border` stay opaque slots into the xlsx sub-tables); what
//! a style LOOKS like is a [`CellVisual`], kept beside it by the xlsx layer
//! and resolved to colours by `sheet_format::resolve`.
//!
//! ## Colours are references
//!
//! Every colour field is a [`ColorRef`]: the CONCRETE colour the workbook
//! stores (an RGB, a theme slot with its tint, an indexed palette entry or
//! "automatic") plus, optionally, a reference to a DOCUMENT swatch (RGB,
//! CMYK, spot or Lab, with the sRGB a non-document reader shows). Fonts are a
//! [`TextStyleRef`]: the concrete font and, optionally, the document's
//! character and paragraph styles. The page output names the document
//! swatch / style; an xlsx save writes the concrete value (the document
//! reference travels in a paged `extLst`, restored on re-import only when
//! the concrete value is unchanged).

/// The colour a workbook stores (ECMA-376 §18.8.3 `CT_Color`).
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ConcreteColor {
    /// `rgb="AARRGGBB"` (alpha dropped).
    Rgb { r: u8, g: u8, b: u8 },
    /// `theme="N"` with its `tint` (−1..1, 0 = none). Index order is the
    /// spreadsheet's (0 = lt1, 1 = dk1, 2 = lt2, 3 = dk2, 4–9 accents,
    /// 10 hlink, 11 folHlink).
    Theme { index: u32, tint: f64 },
    /// `indexed="N"` into the workbook palette (64/65 = system colours).
    Indexed { index: u32 },
    /// `auto="1"` or no colour: the reader's default.
    Auto,
}

/// How a document swatch is defined.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DocColorModel {
    Rgb,
    Cmyk,
    Spot,
    Lab,
}

impl DocColorModel {
    /// The token written to the `extLst` mapping.
    pub fn as_str(self) -> &'static str {
        match self {
            DocColorModel::Rgb => "rgb",
            DocColorModel::Cmyk => "cmyk",
            DocColorModel::Spot => "spot",
            DocColorModel::Lab => "lab",
        }
    }

    /// Parse [`DocColorModel::as_str`]'s token.
    pub fn parse(s: &str) -> Option<DocColorModel> {
        Some(match s {
            "rgb" => DocColorModel::Rgb,
            "cmyk" => DocColorModel::Cmyk,
            "spot" => DocColorModel::Spot,
            "lab" => DocColorModel::Lab,
            _ => return None,
        })
    }
}

/// A reference to a document swatch: its id in the layout document, its
/// colour model and the sRGB a reader without the document shows (what an
/// xlsx save writes as the concrete colour).
#[derive(Clone, Debug, PartialEq, Eq, Hash, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocSwatchRef {
    pub id: String,
    pub model: DocColorModel,
    pub fallback_rgb: (u8, u8, u8),
}

/// A colour: the concrete workbook colour plus an optional document swatch.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColorRef {
    pub concrete: ConcreteColor,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doc: Option<DocSwatchRef>,
}

impl ColorRef {
    /// A plain RGB colour.
    pub fn rgb(r: u8, g: u8, b: u8) -> ColorRef {
        ColorRef {
            concrete: ConcreteColor::Rgb { r, g, b },
            doc: None,
        }
    }

    /// `#RRGGBB` (or `RRGGBB` / `AARRGGBB`) → an RGB colour.
    pub fn from_hex(hex: &str) -> Option<ColorRef> {
        let h = hex.trim().trim_start_matches('#');
        let body = match h.len() {
            8 => &h[2..],
            6 => h,
            _ => return None,
        };
        let p = |i: usize| u8::from_str_radix(&body[i..i + 2], 16).ok();
        Some(ColorRef::rgb(p(0)?, p(2)?, p(4)?))
    }

    /// The automatic colour.
    pub fn auto() -> ColorRef {
        ColorRef {
            concrete: ConcreteColor::Auto,
            doc: None,
        }
    }

    /// A theme colour with a tint.
    pub fn theme(index: u32, tint: f64) -> ColorRef {
        ColorRef {
            concrete: ConcreteColor::Theme { index, tint },
            doc: None,
        }
    }

    /// An indexed palette colour.
    pub fn indexed(index: u32) -> ColorRef {
        ColorRef {
            concrete: ConcreteColor::Indexed { index },
            doc: None,
        }
    }

    /// True for the automatic colour without a document reference.
    pub fn is_auto(&self) -> bool {
        self.doc.is_none() && self.concrete == ConcreteColor::Auto
    }

    /// The same colour referencing a document swatch.
    pub fn with_doc(mut self, doc: DocSwatchRef) -> ColorRef {
        self.doc = Some(doc);
        self
    }
}

/// `<u val>` (ECMA-376 §18.18.82).
#[derive(Copy, Clone, Debug, Default, PartialEq, Eq, Hash, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UnderlineKind {
    #[default]
    None,
    Single,
    Double,
    SingleAccounting,
    DoubleAccounting,
}

impl UnderlineKind {
    /// Parse a `val` token (`<u/>` without `val` is single).
    pub fn parse(s: Option<&str>) -> UnderlineKind {
        match s {
            None | Some("single") => UnderlineKind::Single,
            Some("double") => UnderlineKind::Double,
            Some("singleAccounting") => UnderlineKind::SingleAccounting,
            Some("doubleAccounting") => UnderlineKind::DoubleAccounting,
            _ => UnderlineKind::None,
        }
    }

    /// The `val` token (`None` for no underline).
    pub fn as_xlsx(self) -> Option<&'static str> {
        Some(match self {
            UnderlineKind::None => return None,
            UnderlineKind::Single => "single",
            UnderlineKind::Double => "double",
            UnderlineKind::SingleAccounting => "singleAccounting",
            UnderlineKind::DoubleAccounting => "doubleAccounting",
        })
    }
}

/// `<vertAlign val>`: superscript / subscript.
#[derive(Copy, Clone, Debug, Default, PartialEq, Eq, Hash, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum VertAlign {
    #[default]
    Baseline,
    Superscript,
    Subscript,
}

impl VertAlign {
    pub fn parse(s: &str) -> VertAlign {
        match s {
            "superscript" => VertAlign::Superscript,
            "subscript" => VertAlign::Subscript,
            _ => VertAlign::Baseline,
        }
    }

    pub fn as_xlsx(self) -> &'static str {
        match self {
            VertAlign::Baseline => "baseline",
            VertAlign::Superscript => "superscript",
            VertAlign::Subscript => "subscript",
        }
    }
}

/// A concrete font (`<font>`, ECMA-376 §18.8.22). `None` / default fields
/// carry no explicit attribute.
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontSpec {
    pub name: Option<String>,
    pub size: Option<f64>,
    pub bold: bool,
    pub italic: bool,
    pub underline: UnderlineKind,
    pub strike: bool,
    pub vert_align: VertAlign,
    pub color: Option<ColorRef>,
    /// `<scheme val>` (`major` / `minor`): a theme font.
    pub scheme: Option<String>,
}

/// A font plus optional document character / paragraph styles.
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextStyleRef {
    pub font: FontSpec,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doc_char_style: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doc_para_style: Option<String>,
}

/// The pattern of a `<patternFill>` (ECMA-376 §18.18.55, the 18 patterns
/// plus `none`).
#[derive(Copy, Clone, Debug, Default, PartialEq, Eq, Hash, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PatternKind {
    #[default]
    None,
    Solid,
    MediumGray,
    DarkGray,
    LightGray,
    DarkHorizontal,
    DarkVertical,
    DarkDown,
    DarkUp,
    DarkGrid,
    DarkTrellis,
    LightHorizontal,
    LightVertical,
    LightDown,
    LightUp,
    LightGrid,
    LightTrellis,
    Gray125,
    Gray0625,
}

/// Every pattern with its xlsx token.
pub const PATTERNS: [(PatternKind, &str); 19] = [
    (PatternKind::None, "none"),
    (PatternKind::Solid, "solid"),
    (PatternKind::MediumGray, "mediumGray"),
    (PatternKind::DarkGray, "darkGray"),
    (PatternKind::LightGray, "lightGray"),
    (PatternKind::DarkHorizontal, "darkHorizontal"),
    (PatternKind::DarkVertical, "darkVertical"),
    (PatternKind::DarkDown, "darkDown"),
    (PatternKind::DarkUp, "darkUp"),
    (PatternKind::DarkGrid, "darkGrid"),
    (PatternKind::DarkTrellis, "darkTrellis"),
    (PatternKind::LightHorizontal, "lightHorizontal"),
    (PatternKind::LightVertical, "lightVertical"),
    (PatternKind::LightDown, "lightDown"),
    (PatternKind::LightUp, "lightUp"),
    (PatternKind::LightGrid, "lightGrid"),
    (PatternKind::LightTrellis, "lightTrellis"),
    (PatternKind::Gray125, "gray125"),
    (PatternKind::Gray0625, "gray0625"),
];

impl PatternKind {
    pub fn parse(s: &str) -> Option<PatternKind> {
        PATTERNS.iter().find(|(_, t)| *t == s).map(|(k, _)| *k)
    }

    pub fn as_xlsx(self) -> &'static str {
        PATTERNS
            .iter()
            .find(|(k, _)| *k == self)
            .map(|(_, t)| *t)
            .unwrap_or("none")
    }

    /// The share of the cell the pattern's foreground covers — what a
    /// surface that cannot draw the pattern blends the two colours by
    /// (gray125 is 12.5 %, darkGray 75 %, the line patterns by their
    /// stroke share).
    pub fn coverage(self) -> f64 {
        match self {
            PatternKind::None => 0.0,
            PatternKind::Solid => 1.0,
            PatternKind::MediumGray => 0.5,
            PatternKind::DarkGray => 0.75,
            PatternKind::LightGray => 0.25,
            PatternKind::Gray125 => 0.125,
            PatternKind::Gray0625 => 0.0625,
            PatternKind::DarkHorizontal
            | PatternKind::DarkVertical
            | PatternKind::DarkDown
            | PatternKind::DarkUp => 0.5,
            PatternKind::DarkGrid | PatternKind::DarkTrellis => 0.75,
            PatternKind::LightHorizontal
            | PatternKind::LightVertical
            | PatternKind::LightDown
            | PatternKind::LightUp => 0.25,
            PatternKind::LightGrid | PatternKind::LightTrellis => 0.4375,
        }
    }
}

/// One stop of a gradient fill.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GradientStop {
    /// 0..1 along the gradient.
    pub position: f64,
    pub color: ColorRef,
}

/// A `<gradientFill>`'s geometry.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum GradientKind {
    /// `type="linear" degree`.
    Linear { degree: f64 },
    /// `type="path"` with the inner rectangle (fractions of the cell).
    Path {
        left: f64,
        right: f64,
        top: f64,
        bottom: f64,
    },
}

/// A cell's fill (`<fill>`, ECMA-376 §18.8.20).
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum CellFill {
    #[default]
    None,
    Pattern {
        pattern: PatternKind,
        fg: Option<ColorRef>,
        bg: Option<ColorRef>,
    },
    Gradient {
        gradient: GradientKind,
        stops: Vec<GradientStop>,
    },
}

/// A border line style (ST_BorderStyle, the 13 line styles plus none).
#[derive(Copy, Clone, Debug, Default, PartialEq, Eq, Hash, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BorderStyle {
    #[default]
    None,
    Thin,
    Medium,
    Dashed,
    Dotted,
    Thick,
    Double,
    Hair,
    MediumDashed,
    DashDot,
    MediumDashDot,
    DashDotDot,
    MediumDashDotDot,
    SlantDashDot,
}

/// Every border style with its xlsx token.
pub const BORDER_STYLES: [(BorderStyle, &str); 14] = [
    (BorderStyle::None, "none"),
    (BorderStyle::Thin, "thin"),
    (BorderStyle::Medium, "medium"),
    (BorderStyle::Dashed, "dashed"),
    (BorderStyle::Dotted, "dotted"),
    (BorderStyle::Thick, "thick"),
    (BorderStyle::Double, "double"),
    (BorderStyle::Hair, "hair"),
    (BorderStyle::MediumDashed, "mediumDashed"),
    (BorderStyle::DashDot, "dashDot"),
    (BorderStyle::MediumDashDot, "mediumDashDot"),
    (BorderStyle::DashDotDot, "dashDotDot"),
    (BorderStyle::MediumDashDotDot, "mediumDashDotDot"),
    (BorderStyle::SlantDashDot, "slantDashDot"),
];

impl BorderStyle {
    pub fn parse(s: &str) -> Option<BorderStyle> {
        BORDER_STYLES.iter().find(|(_, t)| *t == s).map(|(k, _)| *k)
    }

    pub fn as_xlsx(self) -> &'static str {
        BORDER_STYLES
            .iter()
            .find(|(k, _)| *k == self)
            .map(|(_, t)| *t)
            .unwrap_or("none")
    }
}

/// One border edge: its line style and colour.
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BorderEdge {
    pub style: BorderStyle,
    pub color: Option<ColorRef>,
}

impl BorderEdge {
    pub fn is_none(&self) -> bool {
        self.style == BorderStyle::None
    }
}

/// A cell's border (`<border>`, ECMA-376 §18.8.4): four edges and the
/// diagonal, drawn up (bottom-left → top-right) and/or down.
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CellBorder {
    pub left: BorderEdge,
    pub right: BorderEdge,
    pub top: BorderEdge,
    pub bottom: BorderEdge,
    pub diagonal: BorderEdge,
    pub diagonal_up: bool,
    pub diagonal_down: bool,
}

/// `<alignment horizontal>` (the full ST_HorizontalAlignment).
#[derive(Copy, Clone, Debug, Default, PartialEq, Eq, Hash, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum HAlign {
    #[default]
    General,
    Left,
    Center,
    Right,
    Fill,
    Justify,
    CenterContinuous,
    Distributed,
}

impl HAlign {
    pub fn parse(s: &str) -> HAlign {
        match s {
            "left" => HAlign::Left,
            "center" => HAlign::Center,
            "right" => HAlign::Right,
            "fill" => HAlign::Fill,
            "justify" => HAlign::Justify,
            "centerContinuous" => HAlign::CenterContinuous,
            "distributed" => HAlign::Distributed,
            _ => HAlign::General,
        }
    }

    pub fn as_xlsx(self) -> &'static str {
        match self {
            HAlign::General => "general",
            HAlign::Left => "left",
            HAlign::Center => "center",
            HAlign::Right => "right",
            HAlign::Fill => "fill",
            HAlign::Justify => "justify",
            HAlign::CenterContinuous => "centerContinuous",
            HAlign::Distributed => "distributed",
        }
    }
}

/// `<alignment vertical>`.
#[derive(Copy, Clone, Debug, Default, PartialEq, Eq, Hash, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum VAlign {
    Top,
    Center,
    #[default]
    Bottom,
    Justify,
    Distributed,
}

impl VAlign {
    pub fn parse(s: &str) -> VAlign {
        match s {
            "top" => VAlign::Top,
            "center" => VAlign::Center,
            "justify" => VAlign::Justify,
            "distributed" => VAlign::Distributed,
            _ => VAlign::Bottom,
        }
    }

    pub fn as_xlsx(self) -> &'static str {
        match self {
            VAlign::Top => "top",
            VAlign::Center => "center",
            VAlign::Bottom => "bottom",
            VAlign::Justify => "justify",
            VAlign::Distributed => "distributed",
        }
    }
}

/// The stacked-text rotation value (`textRotation="255"`).
pub const ROTATION_STACKED: u32 = 255;

/// `<alignment>` (ECMA-376 §18.8.1).
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CellAlignment {
    pub horizontal: HAlign,
    pub vertical: VAlign,
    pub wrap: bool,
    /// Indent levels.
    pub indent: u32,
    /// `textRotation`: 0–90 counter-clockwise degrees, 91–180 clockwise
    /// (`value − 90`), 255 stacked.
    pub rotation: u32,
    pub shrink: bool,
}

/// What a cell style looks like (one `cellXfs` record resolved through its
/// sub-tables, the `apply*` flags honoured).
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CellVisual {
    pub font: TextStyleRef,
    pub fill: CellFill,
    pub border: CellBorder,
    pub alignment: CellAlignment,
    /// The Excel named cell style the record derives from (`xfId` →
    /// `cellStyles`), by name; `None` for Normal.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub named_style: Option<String>,
    /// A document cell style the cell maps to.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doc_cell_style: Option<String>,
}

/// A font change a differential format (`<dxf>`) applies: only the `Some`
/// facets change.
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontDelta {
    pub name: Option<String>,
    pub size: Option<f64>,
    pub bold: Option<bool>,
    pub italic: Option<bool>,
    pub underline: Option<UnderlineKind>,
    pub strike: Option<bool>,
    pub vert_align: Option<VertAlign>,
    pub color: Option<ColorRef>,
}

/// A differential format (`<dxf>`, ECMA-376 §18.8.14): what a conditional
/// format (or a table style element) changes.
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DifferentialFormat {
    pub font: Option<FontDelta>,
    pub fill: Option<CellFill>,
    pub border: Option<CellBorder>,
    pub num_fmt: Option<String>,
    pub alignment: Option<CellAlignment>,
}

/// One Excel named cell style (`cellStyles` + its `cellStyleXfs` record).
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NamedCellStyle {
    pub name: String,
    /// `builtinId` for Excel's built-in styles (0 = Normal).
    pub builtin_id: Option<u32>,
    /// The `cellStyleXfs` index.
    pub xf_id: u32,
    pub visual: CellVisual,
    /// The number format of the style record.
    pub num_fmt: String,
    /// A document cell style the named style maps to.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doc_cell_style: Option<String>,
}

/// One run of a rich-text cell: its text and the font it overrides (`None`
/// = the cell's font).
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RichRunVisual {
    pub text: String,
    pub font: Option<FontSpec>,
}

/// Excel's built-in cell styles by `builtinId` (ECMA-376 §18.8.7, Part 1
/// Annex; the names Excel 2007+ shows). Ids not listed are reserved.
pub fn builtin_style_name(id: u32) -> Option<&'static str> {
    Some(match id {
        0 => "Normal",
        1 => "RowLevel_1",
        2 => "ColLevel_1",
        3 => "Comma",
        4 => "Currency",
        5 => "Percent",
        6 => "Comma [0]",
        7 => "Currency [0]",
        8 => "Hyperlink",
        9 => "Followed Hyperlink",
        10 => "Note",
        11 => "Warning Text",
        15 => "Title",
        16 => "Heading 1",
        17 => "Heading 2",
        18 => "Heading 3",
        19 => "Heading 4",
        20 => "Input",
        21 => "Output",
        22 => "Calculation",
        23 => "Check Cell",
        24 => "Linked Cell",
        25 => "Total",
        26 => "Good",
        27 => "Bad",
        28 => "Neutral",
        29 => "Accent1",
        30 => "20% - Accent1",
        31 => "40% - Accent1",
        32 => "60% - Accent1",
        33 => "Accent2",
        34 => "20% - Accent2",
        35 => "40% - Accent2",
        36 => "60% - Accent2",
        37 => "Accent3",
        38 => "20% - Accent3",
        39 => "40% - Accent3",
        40 => "60% - Accent3",
        41 => "Accent4",
        42 => "20% - Accent4",
        43 => "40% - Accent4",
        44 => "60% - Accent4",
        45 => "Accent5",
        46 => "20% - Accent5",
        47 => "40% - Accent5",
        48 => "60% - Accent5",
        49 => "Accent6",
        50 => "20% - Accent6",
        51 => "40% - Accent6",
        52 => "60% - Accent6",
        53 => "Explanatory Text",
        _ => return None,
    })
}

#[cfg(test)]
#[allow(non_snake_case)]
mod tests {
    use super::*;

    #[test]
    fn tokens_round_trip__feat__sheet_format_cell_style() {
        for (k, t) in PATTERNS {
            assert_eq!(PatternKind::parse(t), Some(k));
            assert_eq!(k.as_xlsx(), t);
        }
        for (k, t) in BORDER_STYLES {
            assert_eq!(BorderStyle::parse(t), Some(k));
            assert_eq!(k.as_xlsx(), t);
        }
        assert_eq!(PATTERNS.len() - 1, 18, "the 18 patterns plus none");
        assert_eq!(BORDER_STYLES.len() - 1, 13, "the 13 line styles plus none");
        assert_eq!(UnderlineKind::parse(None), UnderlineKind::Single);
        assert_eq!(UnderlineKind::parse(Some("none")), UnderlineKind::None);
        assert_eq!(
            HAlign::parse("centerContinuous").as_xlsx(),
            "centerContinuous"
        );
        assert_eq!(builtin_style_name(16), Some("Heading 1"));
        assert_eq!(builtin_style_name(12), None);
    }

    #[test]
    fn colour_refs__feat__sheet_format_cell_style() {
        assert_eq!(
            ColorRef::from_hex("#FF8000"),
            Some(ColorRef::rgb(255, 128, 0))
        );
        assert_eq!(
            ColorRef::from_hex("FFFF8000"),
            Some(ColorRef::rgb(255, 128, 0))
        );
        assert_eq!(ColorRef::from_hex("nope"), None);
        assert!(ColorRef::auto().is_auto());
        let doc = DocSwatchRef {
            id: "Color/u12".into(),
            model: DocColorModel::Cmyk,
            fallback_rgb: (0, 160, 220),
        };
        assert!(!ColorRef::auto().with_doc(doc).is_auto());
        assert_eq!(DocColorModel::parse("spot"), Some(DocColorModel::Spot));
    }
}

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

//! TYPE LAYERS (`TySh`, Photoshop 6.0+ type tool object setting): the
//! text of a layer, its character and paragraph runs, point or paragraph
//! (box) type, its transform and its Warp Text — read into [`TypeLayer`]
//! and written back from one (WP5.10).
//!
//! Block layout (Adobe Photoshop File Formats Specification, "Type tool
//! object setting"): version 1, the transform as six doubles (`xx xy yx
//! yy tx ty`), text version 50 and a versioned `TxLr` descriptor (`Txt `,
//! orientation, anti-alias, bounds, `EngineData`), warp version 1 and a
//! versioned `warp` descriptor (`warpStyle`, `warpValue`,
//! `warpPerspective`, `warpPerspectiveOther`, `warpRotate`), then four
//! 32-bit bounds, the whole padded to a multiple of four.
//!
//! The styled content lives in the text engine's data
//! ([`crate::engine_data`]); its field names and nesting are established
//! by observation of Photoshop-written files (registry/psd-blocks.yaml).
//! A run that does not name a value takes the document's normal style
//! sheet's, as Photoshop resolves it.
//!
//! # Preservation
//!
//! A type layer read from a file and NOT edited keeps its source block
//! (the additional-layer-info `raw_block`), so Photoshop gets its own
//! bytes back. [`TypeLayer::to_block_data`] is the canonical writer for a
//! new or edited layer: it writes what this model holds (text, fonts,
//! runs, paragraphs, shape, warp) and Photoshop's defaults for the rest,
//! so engine settings the model does not carry (kerning pairs, OpenType
//! features, a stroke on the glyphs) are not written back for an edited
//! layer.

use crate::descriptor::{read_versioned_descriptor, Descriptor, DescriptorValue, Key};
use crate::descriptor_write::write_versioned_descriptor;
use crate::engine_data::{self, EdValue};
use crate::reader::ByteReader;
use crate::writer::ByteWriter;
use crate::{PsdError, Result};

/// One type layer.
#[derive(Debug, Clone, PartialEq)]
pub struct TypeLayer {
    /// `[xx, xy, yx, yy, tx, ty]`: text space → canvas pixels. For point
    /// type `(tx, ty)` is the first line's baseline origin; for a box it is
    /// the box's top-left.
    pub transform: [f64; 6],
    /// The text, paragraphs separated by `\r` (no trailing separator).
    pub text: String,
    /// Character runs over `text + "\r"` (UTF-16 code units; the last run
    /// covers the trailing paragraph mark, as the engine's do).
    pub runs: Vec<TextStyleRun>,
    /// Paragraph runs over the same units.
    pub paragraphs: Vec<TextParagraphRun>,
    pub shape: TextShape,
    pub warp: TextWarp,
    /// The `AntA` value: `Anno` (none), `AnCr` (crisp), `AnSt` (strong),
    /// `AnSm` (smooth), `AnSh` (sharp).
    pub antialias: String,
    /// Vertical type (`Ornt` = `Vrtc`).
    pub vertical: bool,
    /// The text's bounds in text space, `[left, top, right, bottom]`
    /// (pt): the descriptor's `bounds`.
    pub bounds: [f64; 4],
}

/// One character run.
#[derive(Debug, Clone, PartialEq)]
pub struct TextStyleRun {
    /// UTF-16 code units.
    pub length: usize,
    /// PostScript name (`MyriadPro-Regular`).
    pub font: String,
    /// Size in pt of text space (pixels at the layer's transform).
    pub size: f64,
    pub color: [u8; 3],
    pub faux_bold: bool,
    pub faux_italic: bool,
    pub auto_leading: bool,
    /// Leading in pt when not auto.
    pub leading: f64,
    /// 1/1000 em.
    pub tracking: f64,
    pub baseline_shift: f64,
    /// 1.0 = 100 %.
    pub horizontal_scale: f64,
    pub vertical_scale: f64,
    pub underline: bool,
    pub strikethrough: bool,
    pub ligatures: bool,
    /// `FontCaps`: 0 normal, 1 small caps, 2 all caps.
    pub caps: u8,
    /// `FontBaseline`: 0 normal, 1 superscript, 2 subscript.
    pub baseline: u8,
}

impl Default for TextStyleRun {
    fn default() -> Self {
        Self {
            length: 0,
            font: "MyriadPro-Regular".into(),
            size: 12.0,
            color: [0, 0, 0],
            faux_bold: false,
            faux_italic: false,
            auto_leading: true,
            leading: 0.0,
            tracking: 0.0,
            baseline_shift: 0.0,
            horizontal_scale: 1.0,
            vertical_scale: 1.0,
            underline: false,
            strikethrough: false,
            ligatures: true,
            caps: 0,
            baseline: 0,
        }
    }
}

/// One paragraph run.
#[derive(Debug, Clone, PartialEq)]
pub struct TextParagraphRun {
    pub length: usize,
    /// `Justification`: 0 left, 1 right, 2 center, 3 justify last left,
    /// 4 justify last right, 5 justify last center, 6 justify all.
    pub justification: u8,
    pub first_line_indent: f64,
    pub start_indent: f64,
    pub end_indent: f64,
    pub space_before: f64,
    pub space_after: f64,
    pub auto_hyphenate: bool,
}

impl Default for TextParagraphRun {
    fn default() -> Self {
        Self {
            length: 0,
            justification: 0,
            first_line_indent: 0.0,
            start_indent: 0.0,
            end_indent: 0.0,
            space_before: 0.0,
            space_after: 0.0,
            auto_hyphenate: true,
        }
    }
}

/// Point type or paragraph type.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum TextShape {
    Point,
    /// A text box of this size (text space), its top-left at the origin.
    Box { width: f64, height: f64 },
}

/// A type layer's Warp Text.
#[derive(Debug, Clone, PartialEq)]
pub struct TextWarp {
    /// The `warpStyle` value (`warpNone`, `warpArc`, …).
    pub style: String,
    /// Bend, percent (−100 to 100).
    pub value: f64,
    /// Horizontal distortion, percent.
    pub perspective: f64,
    /// Vertical distortion, percent.
    pub perspective_other: f64,
    /// `warpRotate` = `Vrtc`.
    pub vertical: bool,
}

impl Default for TextWarp {
    fn default() -> Self {
        Self {
            style: "warpNone".into(),
            value: 0.0,
            perspective: 0.0,
            perspective_other: 0.0,
            vertical: false,
        }
    }
}

fn malformed(detail: impl Into<String>) -> PsdError {
    PsdError::Malformed {
        section: "type layer (TySh)",
        detail: detail.into(),
    }
}

impl TypeLayer {
    /// A layer of `text` in one run and one paragraph.
    pub fn new(text: &str, run: TextStyleRun, paragraph: TextParagraphRun) -> Self {
        let n = text.encode_utf16().count() + 1;
        Self {
            transform: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
            text: text.to_string(),
            runs: vec![TextStyleRun { length: n, ..run }],
            paragraphs: vec![TextParagraphRun {
                length: n,
                ..paragraph
            }],
            shape: TextShape::Point,
            warp: TextWarp::default(),
            antialias: "AnCr".into(),
            vertical: false,
            bounds: [0.0; 4],
        }
    }

    /// Read a `TySh` block's DATA (after its signature, key and length).
    pub fn parse(data: &[u8]) -> Result<TypeLayer> {
        let mut r = ByteReader::new(data);
        let version = r.u16()?;
        if version != 1 {
            return Err(PsdError::Unsupported(format!("TySh version {version}")));
        }
        let mut transform = [0.0; 6];
        for t in &mut transform {
            *t = f64::from_bits(r.u64()?);
        }
        let _text_version = r.u16()?;
        let (_, text_desc) = read_versioned_descriptor(&mut r)?;
        let _warp_version = r.u16()?;
        let (_, warp_desc) = read_versioned_descriptor(&mut r)?;

        let text = text_desc
            .text(b"Txt ")
            .unwrap_or_default()
            .trim_end_matches('\r')
            .to_string();
        let vertical = matches!(text_desc.enum_value(b"Ornt"), Some((_, v)) if v.matches(b"Vrtc"));
        let antialias = text_desc
            .enum_value(b"AntA")
            .map(|(_, v)| v.text_lossy())
            .unwrap_or_else(|| "AnCr".into());
        let bounds = text_desc
            .descriptor(b"bounds")
            .map(|b| {
                let f = |k: &[u8]| b.unit_float(k).map(|(_, v)| v).unwrap_or(0.0);
                [f(b"Left"), f(b"Top "), f(b"Rght"), f(b"Btom")]
            })
            .unwrap_or([0.0; 4]);
        let engine = text_desc
            .raw_data(b"EngineData")
            .ok_or_else(|| malformed("no EngineData"))?;
        let engine = engine_data::parse(engine)?;
        let (runs, paragraphs, shape) = read_engine(&engine)?;

        let warp = TextWarp {
            style: warp_desc
                .enum_value(b"warpStyle")
                .map(|(_, v)| v.text_lossy())
                .unwrap_or_else(|| "warpNone".into()),
            value: warp_desc.number(b"warpValue").unwrap_or(0.0),
            perspective: warp_desc.number(b"warpPerspective").unwrap_or(0.0),
            perspective_other: warp_desc.number(b"warpPerspectiveOther").unwrap_or(0.0),
            vertical: matches!(warp_desc.enum_value(b"warpRotate"), Some((_, v)) if v.matches(b"Vrtc")),
        };
        Ok(TypeLayer {
            transform,
            text,
            runs,
            paragraphs,
            shape,
            warp,
            antialias,
            vertical,
            bounds,
        })
    }

    /// The fonts the runs name, in first-use order (the engine's
    /// `FontSet`).
    pub fn fonts(&self) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for r in &self.runs {
            if !out.contains(&r.font) {
                out.push(r.font.clone());
            }
        }
        if out.is_empty() {
            out.push(TextStyleRun::default().font);
        }
        out
    }

    /// The `TySh` block's DATA for this layer (see the module note on
    /// preservation).
    pub fn to_block_data(&self) -> Vec<u8> {
        let mut w = ByteWriter::new();
        w.u16(1);
        for t in self.transform {
            w.u64(t.to_bits());
        }
        w.u16(50);
        write_versioned_descriptor(&mut w, &self.text_descriptor());
        w.u16(1);
        write_versioned_descriptor(&mut w, &self.warp_descriptor());
        // Four 32-bit bounds, written as Photoshop writes them (zero),
        // then the block padded to a multiple of four.
        for _ in 0..4 {
            w.i32(0);
        }
        while !w.len().is_multiple_of(4) {
            w.u8(0);
        }
        w.into_bytes()
    }

    fn text_descriptor(&self) -> Descriptor {
        let unit = |v: f64| DescriptorValue::UnitFloat {
            unit: *b"#Pnt",
            value: v,
        };
        let rect = |name: &str, b: [f64; 4]| {
            DescriptorValue::Descriptor(Descriptor {
                class_name: String::new(),
                class_id: Key::long(name),
                items: vec![
                    (Key::four(b"Left"), unit(b[0])),
                    (Key::four(b"Top "), unit(b[1])),
                    (Key::four(b"Rght"), unit(b[2])),
                    (Key::four(b"Btom"), unit(b[3])),
                ],
            })
        };
        let en = |t: &[u8; 4], v: &str| DescriptorValue::Enum {
            type_key: Key::four(t),
            value: if v.len() == 4 {
                Key::four(v.as_bytes().try_into().expect("four bytes"))
            } else {
                Key::long(v)
            },
        };
        Descriptor {
            class_name: String::new(),
            class_id: Key::four(b"TxLr"),
            items: vec![
                (Key::four(b"Txt "), DescriptorValue::Text(self.text.clone())),
                (
                    Key::long("textGridding"),
                    DescriptorValue::Enum {
                        type_key: Key::long("textGridding"),
                        value: Key::four(b"None"),
                    },
                ),
                (
                    Key::four(b"Ornt"),
                    en(b"Ornt", if self.vertical { "Vrtc" } else { "Hrzn" }),
                ),
                (Key::four(b"AntA"), en(b"Annt", &self.antialias)),
                (Key::four(b"TxMP"), DescriptorValue::Bool(false)),
                (Key::long("bounds"), rect("bounds", self.bounds)),
                (Key::long("boundingBox"), rect("boundingBox", self.bounds)),
                (Key::long("TextIndex"), DescriptorValue::Integer(0)),
                (
                    Key::long("EngineData"),
                    DescriptorValue::RawData(engine_data::emit(&self.engine_data())),
                ),
            ],
        }
    }

    fn warp_descriptor(&self) -> Descriptor {
        Descriptor {
            class_name: String::new(),
            class_id: Key::long("warp"),
            items: vec![
                (
                    Key::long("warpStyle"),
                    DescriptorValue::Enum {
                        type_key: Key::long("warpStyle"),
                        value: Key::long(&self.warp.style),
                    },
                ),
                (
                    Key::long("warpValue"),
                    DescriptorValue::Double(self.warp.value),
                ),
                (
                    Key::long("warpPerspective"),
                    DescriptorValue::Double(self.warp.perspective),
                ),
                (
                    Key::long("warpPerspectiveOther"),
                    DescriptorValue::Double(self.warp.perspective_other),
                ),
                (
                    Key::long("warpRotate"),
                    DescriptorValue::Enum {
                        type_key: Key::four(b"Ornt"),
                        value: Key::four(if self.warp.vertical { b"Vrtc" } else { b"Hrzn" }),
                    },
                ),
            ],
        }
    }

    /// The engine data this layer writes.
    pub fn engine_data(&self) -> EdValue {
        let fonts = self.fonts();
        let total = self.text.encode_utf16().count() + 1;
        let runs = normalized(&self.runs, total, |r| r.length, |r, n| r.length = n);
        let paras = normalized(&self.paragraphs, total, |p| p.length, |p, n| p.length = n);
        let style_runs = EdValue::Array(
            runs.iter()
                .map(|r| {
                    let font = fonts.iter().position(|f| *f == r.font).unwrap_or(0);
                    EdValue::dict([(
                        "StyleSheet",
                        EdValue::dict([("StyleSheetData", style_sheet_data(r, font as i64))]),
                    )])
                })
                .collect(),
        );
        let para_runs = EdValue::Array(
            paras
                .iter()
                .map(|p| {
                    EdValue::dict([
                        (
                            "ParagraphSheet",
                            EdValue::dict([
                                ("DefaultStyleSheet", EdValue::Int(0)),
                                ("Properties", paragraph_properties(p)),
                            ]),
                        ),
                        ("Adjustments", adjustments()),
                    ])
                })
                .collect(),
        );
        let lengths = |v: Vec<usize>| EdValue::Array(v.into_iter().map(|n| EdValue::Int(n as i64)).collect());
        let (shape_type, shape_geometry) = match self.shape {
            TextShape::Point => (0, ("PointBase", EdValue::floats(&[0.0, 0.0]))),
            TextShape::Box { width, height } => {
                (1, ("BoxBounds", EdValue::floats(&[0.0, 0.0, width, height])))
            }
        };
        let rendered = EdValue::dict([
            ("Version", EdValue::Int(1)),
            (
                "Shapes",
                EdValue::dict([
                    ("WritingDirection", EdValue::Int(i64::from(self.vertical) * 2)),
                    (
                        "Children",
                        EdValue::Array(vec![EdValue::dict([
                            ("ShapeType", EdValue::Int(shape_type)),
                            ("Procession", EdValue::Int(0)),
                            (
                                "Lines",
                                EdValue::dict([
                                    ("WritingDirection", EdValue::Int(i64::from(self.vertical) * 2)),
                                    ("Children", EdValue::Array(Vec::new())),
                                ]),
                            ),
                            (
                                "Cookie",
                                EdValue::dict([(
                                    "Photoshop",
                                    EdValue::dict([
                                        ("ShapeType", EdValue::Int(shape_type)),
                                        shape_geometry,
                                        (
                                            "Base",
                                            EdValue::dict([
                                                ("ShapeType", EdValue::Int(shape_type)),
                                                ("TransformPoint0", EdValue::floats(&[1.0, 0.0])),
                                                ("TransformPoint1", EdValue::floats(&[0.0, 1.0])),
                                                ("TransformPoint2", EdValue::floats(&[0.0, 0.0])),
                                            ]),
                                        ),
                                    ]),
                                )]),
                            ),
                        ])]),
                    ),
                ]),
            ),
        ]);
        let mut text = self.text.clone();
        text.push('\r');
        let engine_dict = EdValue::dict([
            ("Editor", EdValue::dict([("Text", EdValue::Str(text))])),
            (
                "ParagraphRun",
                EdValue::dict([
                    (
                        "DefaultRunData",
                        EdValue::dict([
                            (
                                "ParagraphSheet",
                                EdValue::dict([
                                    ("DefaultStyleSheet", EdValue::Int(0)),
                                    ("Properties", EdValue::Dict(Vec::new())),
                                ]),
                            ),
                            ("Adjustments", adjustments()),
                        ]),
                    ),
                    ("RunArray", para_runs),
                    ("RunLengthArray", lengths(paras.iter().map(|p| p.length).collect())),
                    ("IsJoinable", EdValue::Int(1)),
                ]),
            ),
            (
                "StyleRun",
                EdValue::dict([
                    (
                        "DefaultRunData",
                        EdValue::dict([(
                            "StyleSheet",
                            EdValue::dict([("StyleSheetData", EdValue::Dict(Vec::new()))]),
                        )]),
                    ),
                    ("RunArray", style_runs),
                    ("RunLengthArray", lengths(runs.iter().map(|r| r.length).collect())),
                    ("IsJoinable", EdValue::Int(2)),
                ]),
            ),
            ("GridInfo", grid_info()),
            ("AntiAlias", EdValue::Int(antialias_code(&self.antialias))),
            ("UseFractionalGlyphWidths", EdValue::Bool(true)),
            ("Rendered", rendered),
        ]);
        let resources = resource_dict(&fonts);
        EdValue::dict([
            ("EngineDict", engine_dict),
            ("ResourceDict", resources.clone()),
            ("DocumentResources", resources),
        ])
    }
}

/// Runs whose lengths sum to `total`: the last one stretched or the
/// tail cut, a default run when there are none.
fn normalized<T: Clone + Default>(
    runs: &[T],
    total: usize,
    len: impl Fn(&T) -> usize,
    set: impl Fn(&mut T, usize),
) -> Vec<T> {
    let mut out = Vec::new();
    let mut left = total;
    for r in runs {
        if left == 0 {
            break;
        }
        let n = len(r).min(left);
        if n == 0 {
            continue;
        }
        let mut r = r.clone();
        set(&mut r, n);
        left -= n;
        out.push(r);
    }
    if out.is_empty() {
        let mut r = runs.first().cloned().unwrap_or_default();
        set(&mut r, total);
        return vec![r];
    }
    if left > 0 {
        let last = out.last_mut().expect("non-empty");
        let n = len(last) + left;
        set(last, n);
    }
    out
}

fn adjustments() -> EdValue {
    EdValue::dict([
        ("Axis", EdValue::floats(&[1.0, 0.0, 1.0])),
        ("XY", EdValue::floats(&[0.0, 0.0])),
    ])
}

fn color(rgb: [u8; 3]) -> EdValue {
    let c = |v: u8| f64::from(v) / 255.0;
    EdValue::dict([
        ("Type", EdValue::Int(1)),
        ("Values", EdValue::floats(&[1.0, c(rgb[0]), c(rgb[1]), c(rgb[2])])),
    ])
}

fn style_sheet_data(r: &TextStyleRun, font: i64) -> EdValue {
    EdValue::dict([
        ("Font", EdValue::Int(font)),
        ("FontSize", EdValue::Float(r.size)),
        ("FauxBold", EdValue::Bool(r.faux_bold)),
        ("FauxItalic", EdValue::Bool(r.faux_italic)),
        ("AutoLeading", EdValue::Bool(r.auto_leading)),
        ("Leading", EdValue::Float(r.leading)),
        ("HorizontalScale", EdValue::Float(r.horizontal_scale)),
        ("VerticalScale", EdValue::Float(r.vertical_scale)),
        ("Tracking", EdValue::Int(r.tracking.round() as i64)),
        ("AutoKerning", EdValue::Bool(true)),
        ("Kerning", EdValue::Int(0)),
        ("BaselineShift", EdValue::Float(r.baseline_shift)),
        ("FontCaps", EdValue::Int(i64::from(r.caps))),
        ("FontBaseline", EdValue::Int(i64::from(r.baseline))),
        ("Underline", EdValue::Bool(r.underline)),
        ("Strikethrough", EdValue::Bool(r.strikethrough)),
        ("Ligatures", EdValue::Bool(r.ligatures)),
        ("DLigatures", EdValue::Bool(false)),
        ("BaselineDirection", EdValue::Int(1)),
        ("Tsume", EdValue::Float(0.0)),
        ("StyleRunAlignment", EdValue::Int(2)),
        ("Language", EdValue::Int(0)),
        ("NoBreak", EdValue::Bool(false)),
        ("FillColor", color(r.color)),
        ("StrokeColor", color([0, 0, 0])),
        ("YUnderline", EdValue::Int(1)),
        ("HindiNumbers", EdValue::Bool(false)),
        ("Kashida", EdValue::Int(1)),
    ])
}

fn paragraph_properties(p: &TextParagraphRun) -> EdValue {
    EdValue::dict([
        ("Justification", EdValue::Int(i64::from(p.justification))),
        ("FirstLineIndent", EdValue::Float(p.first_line_indent)),
        ("StartIndent", EdValue::Float(p.start_indent)),
        ("EndIndent", EdValue::Float(p.end_indent)),
        ("SpaceBefore", EdValue::Float(p.space_before)),
        ("SpaceAfter", EdValue::Float(p.space_after)),
        ("AutoHyphenate", EdValue::Bool(p.auto_hyphenate)),
        ("HyphenatedWordSize", EdValue::Int(6)),
        ("PreHyphen", EdValue::Int(2)),
        ("PostHyphen", EdValue::Int(2)),
        ("ConsecutiveHyphens", EdValue::Int(8)),
        ("Zone", EdValue::Float(36.0)),
        ("WordSpacing", EdValue::floats(&[0.8, 1.0, 1.33])),
        ("LetterSpacing", EdValue::floats(&[0.0, 0.0, 0.0])),
        ("GlyphSpacing", EdValue::floats(&[1.0, 1.0, 1.0])),
        ("AutoLeading", EdValue::Float(1.2)),
        ("LeadingType", EdValue::Int(0)),
        ("Hanging", EdValue::Bool(false)),
        ("Burasagari", EdValue::Bool(false)),
        ("KinsokuOrder", EdValue::Int(0)),
        ("EveryLineComposer", EdValue::Bool(false)),
    ])
}

fn grid_info() -> EdValue {
    let black = EdValue::dict([
        ("Type", EdValue::Int(1)),
        ("Values", EdValue::floats(&[0.0, 0.0, 0.0, 1.0])),
    ]);
    EdValue::dict([
        ("GridIsOn", EdValue::Bool(false)),
        ("ShowGrid", EdValue::Bool(false)),
        ("GridSize", EdValue::Float(18.0)),
        ("GridLeading", EdValue::Float(22.0)),
        ("GridColor", black.clone()),
        ("GridLeadingFillColor", black),
        ("AlignLineHeightToGridFlags", EdValue::Bool(false)),
    ])
}

fn antialias_code(key: &str) -> i64 {
    match key {
        "Anno" => 0,
        "AnSh" => 2,
        "AnSt" => 3,
        "AnSm" => 4,
        _ => 1,
    }
}

/// The kinsoku (line-breaking) sets Photoshop writes into every type
/// layer's resources: the characters that may not start or end a line in
/// Japanese text, by Photoshop's hard and soft rules (observed data).
const KINSOKU_HARD_NO_START: &str = "\u{3001}\u{3002}\u{ff0c}\u{ff0e}\u{30fb}\u{ff1a}\u{ff1b}\u{ff1f}\u{ff01}\u{30fc}\u{2015}\u{2019}\u{201d}\u{ff09}\u{3015}\u{ff3d}\u{ff5d}\u{3009}\u{300b}\u{300d}\u{300f}\u{3011}\u{30fd}\u{30fe}\u{309d}\u{309e}\u{3005}\u{3041}\u{3043}\u{3045}\u{3047}\u{3049}\u{3063}\u{3083}\u{3085}\u{3087}\u{308e}\u{30a1}\u{30a3}\u{30a5}\u{30a7}\u{30a9}\u{30c3}\u{30e3}\u{30e5}\u{30e7}\u{30ee}\u{30f5}\u{30f6}\u{309b}\u{309c}?!)]},.:;\u{2103}\u{2109}\u{a2}\u{ff05}\u{2030}";
const KINSOKU_HARD_NO_END: &str = "\u{2018}\u{201c}\u{ff08}\u{3014}\u{ff3b}\u{ff5b}\u{3008}\u{300a}\u{300c}\u{300e}\u{3010}([{\u{ffe5}\u{ff04}\u{a3}\u{ff20}\u{a7}\u{3012}\u{ff03}";
const KINSOKU_SOFT_NO_START: &str = "\u{3001}\u{3002}\u{ff0c}\u{ff0e}\u{30fb}\u{ff1a}\u{ff1b}\u{ff1f}\u{ff01}\u{2019}\u{201d}\u{ff09}\u{3015}\u{ff3d}\u{ff5d}\u{3009}\u{300b}\u{300d}\u{300f}\u{3011}\u{30fd}\u{30fe}\u{309d}\u{309e}\u{3005}";
const KINSOKU_SOFT_NO_END: &str = "\u{2018}\u{201c}\u{ff08}\u{3014}\u{ff3b}\u{ff5b}\u{3008}\u{300a}\u{300c}\u{300e}\u{3010}";
const KINSOKU_KEEP: &str = "\u{2015}\u{2025}";
const KINSOKU_HANGING: &str = "\u{3001}\u{3002}.,";

fn resource_dict(fonts: &[String]) -> EdValue {
    let kinsoku = |name: &str, no_start: &str, no_end: &str| {
        EdValue::dict([
            ("Name", EdValue::Str(name.into())),
            ("NoStart", EdValue::Str(no_start.into())),
            ("NoEnd", EdValue::Str(no_end.into())),
            ("Keep", EdValue::Str(KINSOKU_KEEP.into())),
            ("Hanging", EdValue::Str(KINSOKU_HANGING.into())),
        ])
    };
    let moji = |i: u32| {
        EdValue::dict([(
            "InternalName",
            EdValue::Str(format!("Photoshop6MojiKumiSet{i}")),
        )])
    };
    let mut font_set: Vec<EdValue> = fonts
        .iter()
        .map(|f| {
            EdValue::dict([
                ("Name", EdValue::Str(f.clone())),
                ("Script", EdValue::Int(0)),
                ("FontType", EdValue::Int(0)),
                ("Synthetic", EdValue::Int(0)),
            ])
        })
        .collect();
    font_set.push(EdValue::dict([
        ("Name", EdValue::Str("AdobeInvisFont".into())),
        ("Script", EdValue::Int(0)),
        ("FontType", EdValue::Int(0)),
        ("Synthetic", EdValue::Int(0)),
    ]));
    let normal_run = TextStyleRun::default();
    let mut normal_sheet = style_sheet_data(&normal_run, 0);
    if let EdValue::Dict(items) = &mut normal_sheet {
        items.push(("FillFlag".into(), EdValue::Bool(true)));
        items.push(("StrokeFlag".into(), EdValue::Bool(false)));
        items.push(("FillFirst".into(), EdValue::Bool(true)));
        items.push(("OutlineWidth".into(), EdValue::Float(1.0)));
    }
    EdValue::dict([
        (
            "KinsokuSet",
            EdValue::Array(vec![
                kinsoku(
                    "PhotoshopKinsokuHard",
                    KINSOKU_HARD_NO_START,
                    KINSOKU_HARD_NO_END,
                ),
                kinsoku(
                    "PhotoshopKinsokuSoft",
                    KINSOKU_SOFT_NO_START,
                    KINSOKU_SOFT_NO_END,
                ),
            ]),
        ),
        ("MojiKumiSet", EdValue::Array((1..=4).map(moji).collect())),
        ("TheNormalStyleSheet", EdValue::Int(0)),
        ("TheNormalParagraphSheet", EdValue::Int(0)),
        (
            "ParagraphSheetSet",
            EdValue::Array(vec![EdValue::dict([
                ("Name", EdValue::Str("Normal RGB".into())),
                ("DefaultStyleSheet", EdValue::Int(0)),
                (
                    "Properties",
                    paragraph_properties(&TextParagraphRun::default()),
                ),
            ])]),
        ),
        (
            "StyleSheetSet",
            EdValue::Array(vec![EdValue::dict([
                ("Name", EdValue::Str("Normal RGB".into())),
                ("StyleSheetData", normal_sheet),
            ])]),
        ),
        ("FontSet", EdValue::Array(font_set)),
        ("SuperscriptSize", EdValue::Float(0.583)),
        ("SuperscriptPosition", EdValue::Float(0.333)),
        ("SubscriptSize", EdValue::Float(0.583)),
        ("SubscriptPosition", EdValue::Float(0.333)),
        ("SmallCapSize", EdValue::Float(0.7)),
    ])
}

/// The runs, paragraphs and shape of an engine-data tree.
fn read_engine(root: &EdValue) -> Result<(Vec<TextStyleRun>, Vec<TextParagraphRun>, TextShape)> {
    let engine = root
        .get("EngineDict")
        .ok_or_else(|| malformed("no EngineDict"))?;
    let resources = root.get("ResourceDict");
    let fonts: Vec<String> = resources
        .and_then(|r| r.get("FontSet"))
        .and_then(EdValue::as_array)
        .map(|a| {
            a.iter()
                .map(|f| f.get("Name").and_then(EdValue::as_str).unwrap_or("").to_string())
                .collect()
        })
        .unwrap_or_default();
    let pick = |set: &str, index: &str, inner: &str| -> Option<EdValue> {
        let r = resources?;
        let i = r.get(index).and_then(EdValue::as_i64).unwrap_or(0) as usize;
        r.get(set)?.as_array()?.get(i)?.get(inner).cloned()
    };
    let normal_style = pick("StyleSheetSet", "TheNormalStyleSheet", "StyleSheetData");
    let normal_para = pick("ParagraphSheetSet", "TheNormalParagraphSheet", "Properties");

    let lengths = |v: Option<&EdValue>| -> Vec<usize> {
        v.and_then(EdValue::as_array)
            .map(|a| a.iter().map(|n| n.as_i64().unwrap_or(0).max(0) as usize).collect())
            .unwrap_or_default()
    };

    let style = engine.get("StyleRun");
    let style_lengths = lengths(style.and_then(|s| s.get("RunLengthArray")));
    let style_array = style
        .and_then(|s| s.get("RunArray"))
        .and_then(EdValue::as_array)
        .unwrap_or(&[]);
    let mut runs = Vec::new();
    for (i, entry) in style_array.iter().enumerate() {
        let data = entry.at(&["StyleSheet", "StyleSheetData"]);
        let get = |k: &str| {
            data.and_then(|d| d.get(k))
                .or_else(|| normal_style.as_ref().and_then(|n| n.get(k)))
        };
        let num = |k: &str, d: f64| get(k).and_then(EdValue::as_f64).unwrap_or(d);
        let flag = |k: &str, d: bool| get(k).and_then(EdValue::as_bool).unwrap_or(d);
        let font = get("Font")
            .and_then(EdValue::as_i64)
            .and_then(|i| fonts.get(i as usize))
            .cloned()
            .unwrap_or_else(|| TextStyleRun::default().font);
        let color = get("FillColor")
            .and_then(|c| c.get("Values"))
            .and_then(EdValue::as_array)
            .map(|v| {
                let at = |i: usize| v.get(i).and_then(EdValue::as_f64).unwrap_or(0.0);
                let b = |x: f64| (x.clamp(0.0, 1.0) * 255.0).round() as u8;
                [b(at(1)), b(at(2)), b(at(3))]
            })
            .unwrap_or([0, 0, 0]);
        runs.push(TextStyleRun {
            length: style_lengths.get(i).copied().unwrap_or(0),
            font,
            size: num("FontSize", 12.0),
            color,
            faux_bold: flag("FauxBold", false),
            faux_italic: flag("FauxItalic", false),
            auto_leading: flag("AutoLeading", true),
            leading: num("Leading", 0.0),
            tracking: num("Tracking", 0.0),
            baseline_shift: num("BaselineShift", 0.0),
            horizontal_scale: num("HorizontalScale", 1.0),
            vertical_scale: num("VerticalScale", 1.0),
            underline: flag("Underline", false),
            strikethrough: flag("Strikethrough", false),
            ligatures: flag("Ligatures", true),
            caps: num("FontCaps", 0.0) as u8,
            baseline: num("FontBaseline", 0.0) as u8,
        });
    }

    let para = engine.get("ParagraphRun");
    let para_lengths = lengths(para.and_then(|s| s.get("RunLengthArray")));
    let para_array = para
        .and_then(|s| s.get("RunArray"))
        .and_then(EdValue::as_array)
        .unwrap_or(&[]);
    let mut paragraphs = Vec::new();
    for (i, entry) in para_array.iter().enumerate() {
        let props = entry.at(&["ParagraphSheet", "Properties"]);
        let get = |k: &str| {
            props
                .and_then(|d| d.get(k))
                .or_else(|| normal_para.as_ref().and_then(|n| n.get(k)))
        };
        let num = |k: &str, d: f64| get(k).and_then(EdValue::as_f64).unwrap_or(d);
        paragraphs.push(TextParagraphRun {
            length: para_lengths.get(i).copied().unwrap_or(0),
            justification: num("Justification", 0.0) as u8,
            first_line_indent: num("FirstLineIndent", 0.0),
            start_indent: num("StartIndent", 0.0),
            end_indent: num("EndIndent", 0.0),
            space_before: num("SpaceBefore", 0.0),
            space_after: num("SpaceAfter", 0.0),
            auto_hyphenate: get("AutoHyphenate").and_then(EdValue::as_bool).unwrap_or(true),
        });
    }

    let photoshop = engine
        .at(&["Rendered", "Shapes", "Children"])
        .and_then(EdValue::as_array)
        .and_then(|c| c.first())
        .and_then(|c| c.at(&["Cookie", "Photoshop"]));
    let shape = match photoshop.and_then(|p| p.get("ShapeType")).and_then(EdValue::as_i64) {
        Some(1) => {
            let b = photoshop
                .and_then(|p| p.get("BoxBounds"))
                .and_then(EdValue::as_array)
                .map(|a| a.iter().map(|v| v.as_f64().unwrap_or(0.0)).collect::<Vec<_>>())
                .unwrap_or_default();
            if b.len() == 4 {
                TextShape::Box {
                    width: b[2] - b[0],
                    height: b[3] - b[1],
                }
            } else {
                TextShape::Point
            }
        }
        _ => TextShape::Point,
    };
    Ok((runs, paragraphs, shape))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> TypeLayer {
        let mut l = TypeLayer::new(
            "Hello\rWorld",
            TextStyleRun {
                font: "ArialMT".into(),
                size: 24.0,
                color: [200, 10, 30],
                tracking: 50.0,
                ..TextStyleRun::default()
            },
            TextParagraphRun {
                justification: 2,
                ..TextParagraphRun::default()
            },
        );
        l.transform = [1.0, 0.0, 0.0, 1.0, 12.0, 40.0];
        l.runs = vec![
            TextStyleRun {
                length: 6,
                ..l.runs[0].clone()
            },
            TextStyleRun {
                length: 6,
                font: "ArialMT-Bold".into(),
                underline: true,
                ..l.runs[0].clone()
            },
        ];
        l.shape = TextShape::Box {
            width: 300.0,
            height: 120.0,
        };
        l.warp = TextWarp {
            style: "warpArc".into(),
            value: 50.0,
            perspective: -10.0,
            perspective_other: 0.0,
            vertical: false,
        };
        l.bounds = [0.0, 0.0, 300.0, 120.0];
        l
    }

    #[test]
    fn a_written_type_layer_reads_back_the_same() {
        let l = sample();
        let back = TypeLayer::parse(&l.to_block_data()).expect("parses");
        assert_eq!(back, l);
        assert_eq!(back.fonts(), vec!["ArialMT", "ArialMT-Bold"]);
    }

    #[test]
    fn run_lengths_are_made_to_cover_the_text() {
        let mut l = sample();
        l.runs.truncate(1); // covers 6 of 12 units
        let back = TypeLayer::parse(&l.to_block_data()).expect("parses");
        assert_eq!(back.runs.len(), 1);
        assert_eq!(back.runs[0].length, 12, "stretched to text + paragraph mark");
    }

    #[test]
    fn the_block_is_padded_to_four() {
        assert_eq!(sample().to_block_data().len() % 4, 0);
    }
}

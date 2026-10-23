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

//! Style resolution — model + visual styles → the IR-v2 [`LoweredStyle`]
//! table (spec §8.3, "the most important property of the whole plugin").
//!
//! ## What this resolves (the cross-surface-parity contract)
//!
//! A cell carries a `sheet_core::StyleId` (an index into the workbook's
//! interned `StyleTable`). The *visual* attributes of that style —
//! bold/italic, point size, font name, fill/text colours (`#RRGGBB`),
//! per-edge border presence — live in a SIDE table parsed by `sheet-xlsx`
//! (`VisualStyles`, kept out of the frozen `CellStyle` whose
//! `font`/`fill`/`border` stay opaque `u32` slots). This module turns a
//! cell's `StyleId` into a deduplicated `Vec<LoweredStyle>` plus a per-cell
//! `style_key`, the IR v2 the host translator consumes.
//!
//! The SAME [`StyleResolver`] is used by BOTH render surfaces — the page
//! lowering ([`crate::lower_range_styled`]) and the grid scene
//! (`sheet_grid::grid_scene_styled`) — so a cell resolves to an IDENTICAL
//! `LoweredStyle` on each. That is the `sheet.style.cross-surface-parity`
//! row: "the two surfaces may differ in pipeline, never in styling"
//! (spec §8.3).
//!
//! ## The decoupling (dependency rule)
//!
//! `sheet-lower` depends only on `sheet-core` + `sheet-format` — it CANNOT
//! see `sheet_xlsx::VisualStyles`. So the resolver takes the visual
//! attributes through the [`VisualStyleSource`] trait: a `StyleId` →
//! [`VisualAttrs`] lookup. `sheet-xlsx` (or any caller) implements it; a
//! blanket impl for `Fn(StyleId) -> Option<VisualAttrs>` lets a caller pass
//! a closure when it does not want to name a type. The frozen `lower_range`
//! delegates to the styled path with the zero-source [`NoStyles`], so its
//! output is unchanged (a single default key-0 entry, `style_key` 0
//! everywhere) — backward-compatible by construction.

use crate::LoweredStyle;
use sheet_core::StyleId;
use std::collections::HashMap;

/// The flat visual attributes of one resolved style — the dialect-neutral
/// mirror of `sheet_xlsx::VisualStyle` (and of [`LoweredStyle`] minus the
/// wire `key`). A `None`/`false` field means "no explicit attribute" (the
/// document default wins). This is the value a [`VisualStyleSource`] hands
/// the resolver; keeping it a `sheet-lower`-local type is what frees the
/// crate from a `sheet-xlsx` dependency.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct VisualAttrs {
    pub bold: bool,
    pub italic: bool,
    pub font_size_pt: Option<f64>,
    pub font_name: Option<String>,
    pub fill_rgb: Option<String>,
    pub text_rgb: Option<String>,
    pub border_top: bool,
    pub border_right: bool,
    pub border_bottom: bool,
    pub border_left: bool,
    /// Underlined text (Wave 6, additive).
    pub underline: bool,
    /// Vertical alignment inside the cell: `"top"`, `"center"` or
    /// `"bottom"`; `None` = the document default (bottom).
    pub v_align: Option<String>,
    /// Wrap text inside the cell.
    pub wrap: bool,
    /// The per-edge border LINES (style, weight, colour) behind the
    /// presence flags above; `None` for an edge without a line.
    pub border_lines: BorderLines,
    // ---- W2.2 (sheet ADR 518): the full cell visual model, resolved. ----
    /// The document swatch the fill colour names (beside `fill_rgb`).
    pub fill_swatch: Option<String>,
    /// The document swatch the text colour names (beside `text_rgb`).
    pub text_swatch: Option<String>,
    /// A pattern fill other than solid; `fill_rgb` then holds the blend a
    /// surface that cannot draw the pattern shows.
    pub fill_pattern: Option<FillPattern>,
    /// A gradient fill; `fill_rgb` then holds its mean colour.
    pub fill_gradient: Option<FillGradient>,
    /// The indent (pt; one Excel level is [`INDENT_LEVEL_PT`]).
    pub indent_pt: Option<f64>,
    /// `textRotation` (1–180, 255 = stacked); `None` = upright.
    pub rotation: Option<u32>,
    /// Shrink the text to fit the cell width.
    pub shrink: bool,
    /// Strike-through text.
    pub strike: bool,
    /// `"superscript"` / `"subscript"`.
    pub vert_align: Option<String>,
    /// The underline beyond single (`"double"`, `"singleAccounting"`,
    /// `"doubleAccounting"`); `underline` stays the presence flag.
    pub underline_style: Option<String>,
    /// The horizontal alignments the frozen `Align` has no slot for:
    /// `"fill"`, `"justify"`, `"centerContinuous"`, `"distributed"`.
    pub h_align: Option<String>,
    /// The Excel named cell style (not Normal).
    pub named_style: Option<String>,
    /// Document character / paragraph / cell styles the cell maps to.
    pub doc_char_style: Option<String>,
    pub doc_para_style: Option<String>,
    pub doc_cell_style: Option<String>,
}

/// One Excel indent level in points (Excel 16 indents by about 9 px — three
/// spaces' width of the default font — per level at 100 %: 6.75 pt).
pub const INDENT_LEVEL_PT: f64 = 6.75;

/// A pattern fill as surfaces draw it (W2.2): the xlsx pattern name and its
/// two colours (`#RRGGBB`, `None` = automatic) with their document swatches.
#[derive(serde::Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FillPattern {
    pub pattern: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fg_rgb: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bg_rgb: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fg_swatch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bg_swatch: Option<String>,
}

/// A gradient fill (W2.2): `"linear"` at `degree`, or `"path"` from the
/// inner rectangle `left`/`right`/`top`/`bottom` (fractions of the cell).
#[derive(serde::Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FillGradient {
    pub kind: String,
    pub degree: f64,
    pub left: f64,
    pub right: f64,
    pub top: f64,
    pub bottom: f64,
    pub stops: Vec<FillGradientStop>,
}

/// One resolved gradient stop.
#[derive(serde::Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FillGradientStop {
    pub position: f64,
    pub rgb: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub swatch: Option<String>,
}

/// One border edge's line (Wave 6): the xlsx style name (`thin`, `medium`,
/// `thick`, `dashed`, `dotted`, `double`, `hair`, …), its weight in points
/// (the style's nominal stroke) and its colour (`#RRGGBB`, `None` = auto).
#[derive(serde::Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BorderLine {
    pub style: String,
    pub weight_pt: f64,
    pub rgb: Option<String>,
    /// The document swatch the line colour names (W2.2).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub swatch: Option<String>,
}

impl BorderLine {
    /// The nominal stroke weight (pt) of an xlsx border style: Excel draws
    /// hair/thin/medium/thick as 1/4, 1, 2 and 3 device pixels at 96 dpi.
    pub fn weight_of(style: &str) -> f64 {
        match style {
            "hair" => 0.25,
            "medium" | "mediumDashed" | "mediumDashDot" | "mediumDashDotDot" | "slantDashDot" => {
                1.5
            }
            "thick" | "double" => 2.25,
            _ => 0.75,
        }
    }
}

/// The four edges' [`BorderLine`]s.
#[derive(serde::Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BorderLines {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top: Option<BorderLine>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub right: Option<BorderLine>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bottom: Option<BorderLine>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub left: Option<BorderLine>,
    /// The diagonal from the bottom-left to the top-right corner (W2.2).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagonal_up: Option<BorderLine>,
    /// The diagonal from the top-left to the bottom-right corner (W2.2).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagonal_down: Option<BorderLine>,
}

impl BorderLines {
    /// True when no edge carries a line.
    pub fn is_empty(&self) -> bool {
        self.top.is_none()
            && self.right.is_none()
            && self.bottom.is_none()
            && self.left.is_none()
            && self.diagonal_up.is_none()
            && self.diagonal_down.is_none()
    }
}

impl VisualAttrs {
    /// True if this carries NO visual override (every field default) — the
    /// resolver folds these onto the default style key 0 (no new entry).
    pub fn is_default(&self) -> bool {
        *self == VisualAttrs::default()
    }

    /// Promote to a wire [`LoweredStyle`] under the given `key`.
    pub(crate) fn into_lowered(self, key: u32) -> LoweredStyle {
        LoweredStyle {
            key,
            bold: self.bold,
            italic: self.italic,
            font_size_pt: self.font_size_pt,
            font_name: self.font_name,
            fill_rgb: self.fill_rgb,
            text_rgb: self.text_rgb,
            border_top: self.border_top,
            border_right: self.border_right,
            border_bottom: self.border_bottom,
            border_left: self.border_left,
            underline: self.underline,
            v_align: self.v_align,
            wrap: self.wrap,
            border_lines: self.border_lines,
            fill_swatch: self.fill_swatch,
            text_swatch: self.text_swatch,
            fill_pattern: self.fill_pattern,
            fill_gradient: self.fill_gradient,
            indent_pt: self.indent_pt,
            rotation: self.rotation,
            shrink: self.shrink,
            strike: self.strike,
            vert_align: self.vert_align,
            underline_style: self.underline_style,
            h_align: self.h_align,
            named_style: self.named_style,
            doc_char_style: self.doc_char_style,
            doc_para_style: self.doc_para_style,
            doc_cell_style: self.doc_cell_style,
        }
    }
}

// ---- Resolving the cell visual model (W2.2, sheet ADR 518). ----

use sheet_core::visual::{
    BorderEdge, BorderStyle, CellBorder, CellFill, CellVisual, ColorRef, DifferentialFormat,
    FontSpec, GradientKind, HAlign, PatternKind, UnderlineKind, VAlign, VertAlign,
    ROTATION_STACKED,
};
use sheet_format::resolve::{blend, hex, resolve, ColorPalette};

/// One edge → its resolved [`BorderLine`] (`None` without a line).
fn line_of(edge: &BorderEdge, palette: &ColorPalette) -> Option<BorderLine> {
    if edge.style == BorderStyle::None {
        return None;
    }
    let style = edge.style.as_xlsx().to_string();
    let resolved = edge.color.as_ref().and_then(|c| resolve(c, palette));
    Some(BorderLine {
        weight_pt: BorderLine::weight_of(&style),
        style,
        rgb: resolved.as_ref().map(|r| r.hex()),
        swatch: resolved.and_then(|r| r.swatch),
    })
}

/// A border → the presence flags and lines.
fn apply_border(a: &mut VisualAttrs, b: &CellBorder, palette: &ColorPalette) {
    a.border_lines = BorderLines {
        top: line_of(&b.top, palette),
        right: line_of(&b.right, palette),
        bottom: line_of(&b.bottom, palette),
        left: line_of(&b.left, palette),
        diagonal_up: b
            .diagonal_up
            .then(|| line_of(&b.diagonal, palette))
            .flatten(),
        diagonal_down: b
            .diagonal_down
            .then(|| line_of(&b.diagonal, palette))
            .flatten(),
    };
    a.border_top = a.border_lines.top.is_some();
    a.border_right = a.border_lines.right.is_some();
    a.border_bottom = a.border_lines.bottom.is_some();
    a.border_left = a.border_lines.left.is_some();
}

/// A fill → `fill_rgb` (+ swatch) and the pattern / gradient facets.
fn apply_fill(a: &mut VisualAttrs, fill: &CellFill, palette: &ColorPalette) {
    let res = |c: &Option<ColorRef>| c.as_ref().and_then(|c| resolve(c, palette));
    match fill {
        CellFill::None => {}
        CellFill::Pattern {
            pattern: PatternKind::None,
            ..
        } => {}
        CellFill::Pattern {
            pattern: PatternKind::Solid,
            fg,
            ..
        } => {
            if let Some(r) = res(fg) {
                a.fill_rgb = Some(r.hex());
                a.fill_swatch = r.swatch;
            }
        }
        CellFill::Pattern { pattern, fg, bg } => {
            let (fg, bg) = (res(fg), res(bg));
            // An automatic pattern colour is the system foreground (black)
            // over the system background (white).
            let fg_rgb = fg.as_ref().map(|r| r.rgb).unwrap_or((0, 0, 0));
            let bg_rgb = bg.as_ref().map(|r| r.rgb).unwrap_or((255, 255, 255));
            a.fill_rgb = Some(hex(blend(fg_rgb, bg_rgb, pattern.coverage())));
            a.fill_pattern = Some(FillPattern {
                pattern: pattern.as_xlsx().to_string(),
                fg_rgb: fg.as_ref().map(|r| r.hex()),
                bg_rgb: bg.as_ref().map(|r| r.hex()),
                fg_swatch: fg.and_then(|r| r.swatch),
                bg_swatch: bg.and_then(|r| r.swatch),
            });
        }
        CellFill::Gradient { gradient, stops } => {
            let stops: Vec<FillGradientStop> = stops
                .iter()
                .map(|s| {
                    let r = resolve(&s.color, palette);
                    FillGradientStop {
                        position: s.position,
                        rgb: r
                            .as_ref()
                            .map(|r| r.hex())
                            .unwrap_or_else(|| "#FFFFFF".into()),
                        swatch: r.and_then(|r| r.swatch),
                    }
                })
                .collect();
            if stops.is_empty() {
                return;
            }
            let mean = |i: usize| {
                let sum: u32 = stops
                    .iter()
                    .map(|s| u32::from_str_radix(&s.rgb[1 + 2 * i..3 + 2 * i], 16).unwrap_or(255))
                    .sum();
                (sum as f64 / stops.len() as f64).round() as u8
            };
            a.fill_rgb = Some(hex((mean(0), mean(1), mean(2))));
            let mut g = FillGradient {
                stops,
                ..FillGradient::default()
            };
            match gradient {
                GradientKind::Linear { degree } => {
                    g.kind = "linear".into();
                    g.degree = *degree;
                }
                GradientKind::Path {
                    left,
                    right,
                    top,
                    bottom,
                } => {
                    g.kind = "path".into();
                    (g.left, g.right, g.top, g.bottom) = (*left, *right, *top, *bottom);
                }
            }
            a.fill_gradient = Some(g);
        }
    }
}

/// The font facets of `font` that override `default` (the workbook's base
/// font: its size and face are the document default, not an override).
fn apply_font(a: &mut VisualAttrs, font: &FontSpec, default: &FontSpec, palette: &ColorPalette) {
    a.bold = font.bold;
    a.italic = font.italic;
    if font.size != default.size {
        a.font_size_pt = font.size;
    }
    if font.name != default.name {
        a.font_name = font.name.clone();
    }
    if let Some(r) = font.color.as_ref().and_then(|c| resolve(c, palette)) {
        a.text_rgb = Some(r.hex());
        a.text_swatch = r.swatch;
    }
    a.underline = font.underline != UnderlineKind::None;
    a.underline_style = match font.underline {
        UnderlineKind::None | UnderlineKind::Single => None,
        u => u.as_xlsx().map(str::to_string),
    };
    a.strike = font.strike;
    a.vert_align = match font.vert_align {
        VertAlign::Baseline => None,
        v => Some(v.as_xlsx().to_string()),
    };
}

/// Resolve a cell visual into the flat [`VisualAttrs`] both surfaces draw
/// (the one path from the model to the IR; colours through
/// `sheet_format::resolve`). `default_font` is the workbook's base font.
pub fn resolve_visual(
    v: &CellVisual,
    palette: &ColorPalette,
    default_font: &FontSpec,
) -> VisualAttrs {
    let mut a = VisualAttrs::default();
    apply_font(&mut a, &v.font.font, default_font, palette);
    apply_fill(&mut a, &v.fill, palette);
    apply_border(&mut a, &v.border, palette);
    let al = &v.alignment;
    a.v_align = match al.vertical {
        VAlign::Top => Some("top".into()),
        VAlign::Center => Some("center".into()),
        _ => None,
    };
    a.wrap = al.wrap;
    a.h_align = match al.horizontal {
        HAlign::Fill | HAlign::Justify | HAlign::CenterContinuous | HAlign::Distributed => {
            Some(al.horizontal.as_xlsx().to_string())
        }
        _ => None,
    };
    a.indent_pt = (al.indent > 0).then_some(al.indent as f64 * INDENT_LEVEL_PT);
    a.rotation = (al.rotation > 0 && (al.rotation <= 180 || al.rotation == ROTATION_STACKED))
        .then_some(al.rotation);
    a.shrink = al.shrink && !al.wrap;
    a.named_style = v.named_style.clone();
    a.doc_char_style = v.font.doc_char_style.clone();
    a.doc_para_style = v.font.doc_para_style.clone();
    a.doc_cell_style = v.doc_cell_style.clone();
    a
}

/// A rich-text run's effective style: the cell's resolved style with the
/// run's font facets.
pub fn run_attrs(
    base: &VisualAttrs,
    font: &FontSpec,
    palette: &ColorPalette,
    default_font: &FontSpec,
) -> VisualAttrs {
    let mut a = base.clone();
    a.text_rgb = None;
    a.text_swatch = None;
    a.font_size_pt = None;
    a.font_name = None;
    apply_font(&mut a, font, default_font, palette);
    if a.text_rgb.is_none() {
        a.text_rgb = base.text_rgb.clone();
        a.text_swatch = base.text_swatch.clone();
    }
    if a.font_size_pt.is_none() && font.size.is_none() {
        a.font_size_pt = base.font_size_pt;
    }
    if a.font_name.is_none() && font.name.is_none() {
        a.font_name = base.font_name.clone();
    }
    a
}

/// Resolve a differential format into the facets it sets (an unset facet
/// stays default — the conditional-formatting bridge).
pub fn resolve_delta(d: &DifferentialFormat, palette: &ColorPalette) -> VisualAttrs {
    let mut a = VisualAttrs::default();
    if let Some(f) = &d.font {
        a.bold = f.bold.unwrap_or(false);
        a.italic = f.italic.unwrap_or(false);
        a.font_size_pt = f.size;
        a.font_name = f.name.clone();
        if let Some(r) = f.color.as_ref().and_then(|c| resolve(c, palette)) {
            a.text_rgb = Some(r.hex());
            a.text_swatch = r.swatch;
        }
        a.underline = f.underline.is_some_and(|u| u != UnderlineKind::None);
        a.strike = f.strike.unwrap_or(false);
    }
    if let Some(fill) = &d.fill {
        apply_fill(&mut a, fill, palette);
    }
    if let Some(b) = &d.border {
        apply_border(&mut a, b, palette);
    }
    a
}

/// A `StyleId` → [`VisualAttrs`] lookup. The resolver is generic over this
/// so `sheet-lower` never names `sheet_xlsx::VisualStyles` (dependency
/// rule). Returning `None` (or a default `VisualAttrs`) means "this style
/// has no visual styling" — it folds onto key 0.
pub trait VisualStyleSource {
    /// The visual attributes for a resolved `StyleId`, or `None` (default).
    fn visual(&self, id: StyleId) -> Option<VisualAttrs>;

    /// The `#RRGGBB` a number format's colour bracket names (`[Red]`,
    /// `[Color12]`): the workbook palette's entry when it overrides the
    /// default (`<indexedColors>`), else the default palette's. The default
    /// method knows only the default palette.
    fn format_color_rgb(&self, color: sheet_format::FormatColor) -> String {
        let (r, g, b) = color.default_rgb();
        format!("#{r:02X}{g:02X}{b:02X}")
    }

    /// The formatted runs of a rich-text cell (W2.2): each run's text and
    /// its effective style (`base`, the cell's style, with the run's font
    /// facets). `None` = plain text. `text` is what the cell shows now — a
    /// source answers `None` when its runs no longer spell it.
    fn rich_runs(
        &self,
        _sheet: sheet_core::SheetId,
        _row: u32,
        _col: u32,
        _text: &str,
        _base: &VisualAttrs,
    ) -> Option<Vec<(String, VisualAttrs)>> {
        None
    }
}

/// Any `Fn(StyleId) -> Option<VisualAttrs>` is a source — a caller that does
/// not want to name a type can pass a closure.
impl<F> VisualStyleSource for F
where
    F: Fn(StyleId) -> Option<VisualAttrs>,
{
    fn visual(&self, id: StyleId) -> Option<VisualAttrs> {
        self(id)
    }
}

/// The zero source: every style is default. The frozen `lower_range`
/// resolves against this so its IR is unchanged (key-0-only table).
#[derive(Copy, Clone, Debug, Default)]
pub struct NoStyles;

impl VisualStyleSource for NoStyles {
    fn visual(&self, _id: StyleId) -> Option<VisualAttrs> {
        None
    }
}

/// Builds the deduplicated [`LoweredStyle`] table incrementally as cells are
/// lowered, assigning each distinct visual style a stable `style_key`. Key 0
/// is ALWAYS the default style ([`LoweredStyle::default_key0`]); a cell with
/// no visual styling (an unstyled `StyleId`, or a `StyleId` the source maps
/// to a default `VisualAttrs`) reuses key 0.
///
/// Determinism (spec §12.4): keys are assigned in the order cells are
/// resolved, and the page lowering / grid scene both walk cells in index
/// order, so the same `(model, range, source)` yields the same table. The
/// resolver caches by `StyleId` so two cells sharing a style share a key
/// without re-querying the source.
pub struct StyleResolver<'a, S: VisualStyleSource> {
    source: &'a S,
    /// The output table; index == `key`. Seeded with the default at key 0.
    styles: Vec<LoweredStyle>,
    /// `StyleId.0` → assigned `style_key`, memoizing the source lookup +
    /// the dedup search so each distinct `StyleId` is resolved once.
    by_style_id: HashMap<u32, u32>,
    /// `VisualAttrs` (as its wire `LoweredStyle` minus key) → `style_key`,
    /// so two DIFFERENT `StyleId`s that resolve to the SAME visual style
    /// share one table entry (true deduplication, not just per-id caching).
    dedup: HashMap<StyleKeyless, u32>,
}

/// A `LoweredStyle` without its `key`, used as the dedup map key: its debug
/// rendering with the key zeroed (`f64` sizes have no `Hash`; style sizes
/// are exact small decimals from the xlsx, so the rendering is a faithful
/// equality).
#[derive(Clone, PartialEq, Eq, Hash)]
pub(crate) struct StyleKeyless(String);

impl StyleKeyless {
    pub(crate) fn of(s: &LoweredStyle) -> Self {
        let mut k = s.clone();
        k.key = 0;
        StyleKeyless(format!("{k:?}"))
    }
}

impl<'a, S: VisualStyleSource> StyleResolver<'a, S> {
    /// A fresh resolver, table seeded with the default style at key 0.
    pub fn new(source: &'a S) -> Self {
        StyleResolver {
            source,
            styles: vec![LoweredStyle::default_key0()],
            by_style_id: HashMap::new(),
            dedup: HashMap::new(),
            // The default style occupies key 0; record it so a source that
            // explicitly returns a default `VisualAttrs` reuses it.
        }
    }

    /// Resolve a cell's `StyleId` to its `style_key`, interning a new
    /// [`LoweredStyle`] into the table the first time a distinct visual style
    /// is seen. An unstyled / default style returns key 0.
    pub fn key_for(&mut self, id: StyleId) -> u32 {
        if let Some(&k) = self.by_style_id.get(&id.0) {
            return k;
        }
        let attrs = self.source.visual(id).unwrap_or_default();
        let key = if attrs.is_default() {
            0 // folds onto the default entry
        } else {
            let lowered = attrs.into_lowered(0); // key fixed below
            let dedup_key = StyleKeyless::of(&lowered);
            if let Some(&existing) = self.dedup.get(&dedup_key) {
                existing
            } else {
                let new_key = self.styles.len() as u32;
                self.styles.push(LoweredStyle {
                    key: new_key,
                    ..lowered
                });
                self.dedup.insert(dedup_key, new_key);
                new_key
            }
        };
        self.by_style_id.insert(id.0, key);
        key
    }

    /// Consume the resolver, yielding the finished `styles` table (index ==
    /// key; entry 0 is always the default). The page lowering puts this in
    /// `LoweredContent.styles`; the grid scene in `GridScene.styles`.
    pub fn into_styles(self) -> Vec<LoweredStyle> {
        self.styles
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    /// A map-backed source for tests (StyleId.0 → attrs).
    fn source(map: BTreeMap<u32, VisualAttrs>) -> impl VisualStyleSource {
        move |id: StyleId| map.get(&id.0).cloned()
    }

    fn bold() -> VisualAttrs {
        VisualAttrs {
            bold: true,
            font_size_pt: Some(11.0),
            font_name: Some("Calibri".into()),
            ..Default::default()
        }
    }

    fn yellow_fill() -> VisualAttrs {
        VisualAttrs {
            fill_rgb: Some("#FFFF00".into()),
            ..Default::default()
        }
    }

    #[test]
    fn default_table_has_only_key0() {
        let r = StyleResolver::new(&NoStyles);
        let styles = r.into_styles();
        assert_eq!(styles, vec![LoweredStyle::default_key0()]);
    }

    #[test]
    fn no_styles_source_folds_everything_to_key0() {
        let mut r = StyleResolver::new(&NoStyles);
        assert_eq!(r.key_for(StyleId(0)), 0);
        assert_eq!(r.key_for(StyleId(5)), 0);
        assert_eq!(r.key_for(StyleId(99)), 0);
        assert_eq!(r.into_styles().len(), 1);
    }

    #[test]
    fn distinct_styles_get_distinct_keys() {
        let mut map = BTreeMap::new();
        map.insert(1u32, bold());
        map.insert(2u32, yellow_fill());
        let src = source(map);
        let mut r = StyleResolver::new(&src);

        assert_eq!(r.key_for(StyleId(0)), 0); // default → key 0
        let kb = r.key_for(StyleId(1));
        let ky = r.key_for(StyleId(2));
        assert_ne!(kb, 0);
        assert_ne!(ky, 0);
        assert_ne!(kb, ky);

        let styles = r.into_styles();
        assert_eq!(styles.len(), 3); // default + bold + fill
        assert_eq!(styles[0], LoweredStyle::default_key0());
        assert!(styles[kb as usize].bold);
        assert_eq!(styles[ky as usize].fill_rgb.as_deref(), Some("#FFFF00"));
        // The key field equals the table index.
        for (i, s) in styles.iter().enumerate() {
            assert_eq!(s.key, i as u32);
        }
    }

    #[test]
    fn same_style_id_reuses_key() {
        let mut map = BTreeMap::new();
        map.insert(1u32, bold());
        let src = source(map);
        let mut r = StyleResolver::new(&src);
        let a = r.key_for(StyleId(1));
        let b = r.key_for(StyleId(1));
        assert_eq!(a, b);
        assert_eq!(r.into_styles().len(), 2); // default + the one bold
    }

    #[test]
    fn distinct_ids_same_visual_dedup_to_one_entry() {
        // Two different StyleIds whose visual attributes are identical share
        // ONE table entry (true dedup — the IR carries each visual style once).
        let mut map = BTreeMap::new();
        map.insert(1u32, bold());
        map.insert(7u32, bold());
        let src = source(map);
        let mut r = StyleResolver::new(&src);
        let k1 = r.key_for(StyleId(1));
        let k7 = r.key_for(StyleId(7));
        assert_eq!(k1, k7);
        assert_eq!(r.into_styles().len(), 2); // default + one shared bold
    }

    #[test]
    fn explicit_default_attrs_fold_to_key0() {
        // A source that returns a *default* VisualAttrs (not None) still
        // folds onto key 0 — `is_default` is the "has styling?" test.
        let mut map = BTreeMap::new();
        map.insert(3u32, VisualAttrs::default());
        let src = source(map);
        let mut r = StyleResolver::new(&src);
        assert_eq!(r.key_for(StyleId(3)), 0);
        assert_eq!(r.into_styles().len(), 1);
    }
}

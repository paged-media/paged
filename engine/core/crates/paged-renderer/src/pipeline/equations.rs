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

//! Equations in text (engine ADR 1090): the math face an equation is set
//! in, its metrics as `paged_math` asks for them, and the paint of the set
//! boxes.
//!
//! An equation is an inline object of its line ([`super::anchored`]): it is
//! set here before the paragraph is composed, takes the layout's width in
//! the line, rises its ascent above the baseline and hangs its descent below
//! it, and is drawn where its character landed. The face is the first math
//! family the document's font resolver has ([`MATH_FAMILIES`]), else the
//! face of the run it stands in; the layout's constants are the face's
//! OpenType `MATH` table where it has one, TeX's otherwise.

use bytes::Bytes;
use paged_compose::{DisplayCommand, DisplayList, Paint, PathData, PathSegment, Stroke, Transform};
use paged_math::{alphabet, Constants, Item, Layout, MathMetrics, Variant};

use super::font_table::{font_id, FontTable};

/// The math faces asked for, in order: Word's, then the two free ones.
pub(super) const MATH_FAMILIES: [&str; 3] = ["Cambria Math", "STIX Two Math", "Latin Modern Math"];

/// The lean of a math-italic letter drawn from an upright face that has no
/// math-italic one, degrees.
const FALLBACK_SLANT_DEG: f32 = 12.0;

/// One equation of a paragraph, set: its layout, the face its text is
/// drawn in and the size it was set at.
#[derive(Debug, Clone)]
pub(super) struct SetEquation {
    /// Its character offset in the paragraph's text.
    pub offset: u32,
    pub layout: Layout,
    pub face: Bytes,
}

/// A face's metrics for the layout: advances from shaping, extents from the
/// glyphs' bounding boxes.
struct FaceMetrics<'f> {
    shaping: &'f paged_text::Face<'f>,
    outline: &'f ttf_parser::Face<'f>,
}

/// `text` in the face's characters for `variant`: the styled letter where
/// the face has it, the plain one otherwise (with whether it must lean).
fn face_text(outline: &ttf_parser::Face, text: &str, variant: Variant) -> (String, bool) {
    let mut lean = false;
    let out = text
        .chars()
        .map(|c| {
            let s = alphabet::styled(c, variant);
            if s != c && outline.glyph_index(s).is_none() {
                lean |= alphabet::slants(variant) && c.is_alphabetic();
                c
            } else {
                s
            }
        })
        .collect();
    (out, lean)
}

impl MathMetrics for FaceMetrics<'_> {
    fn advance(&self, text: &str, size: f32, variant: Variant) -> f32 {
        let (t, _) = face_text(self.outline, text, variant);
        paged_text::shape_run(self.shaping, &t, size).total_advance as f32
            / paged_text::shape::ADVANCE_PRECISION
    }

    fn extent(&self, text: &str, size: f32, variant: Variant) -> (f32, f32) {
        let (t, _) = face_text(self.outline, text, variant);
        let upem = f32::from(self.outline.units_per_em()).max(1.0);
        let (mut a, mut d) = (0.0f32, 0.0f32);
        for g in paged_text::shape_run(self.shaping, &t, size).glyphs {
            if let Some(r) = self
                .outline
                .glyph_bounding_box(ttf_parser::GlyphId(g.glyph_id as u16))
            {
                a = a.max(f32::from(r.y_max));
                d = d.max(-f32::from(r.y_min));
            }
        }
        (a * size / upem, d * size / upem)
    }
}

/// The layout constants of a face's `MATH` table, in em; `None` without one.
fn math_constants(face: &ttf_parser::Face) -> Option<Constants> {
    let m = face.tables().math?.constants?;
    let upem = f32::from(face.units_per_em()).max(1.0);
    let em = |v: i16| f32::from(v) / upem;
    let k = Constants::default();
    let rule = em(m.fraction_rule_thickness().value);
    Some(Constants {
        axis: em(m.axis_height().value),
        rule: if rule > 0.0 { rule } else { k.rule },
        x_height: em(m.accent_base_height().value),
        num_display: em(m.fraction_numerator_display_style_shift_up().value),
        num_text: em(m.fraction_numerator_shift_up().value),
        den_display: em(m.fraction_denominator_display_style_shift_down().value),
        den_text: em(m.fraction_denominator_shift_down().value),
        sup_display: em(m.superscript_shift_up().value),
        sup_text: em(m.superscript_shift_up().value),
        sub_alone: em(m.subscript_shift_down().value),
        sub_with_sup: em(m.subscript_shift_down().value).max(k.sub_with_sup),
        sup_drop: em(m.superscript_baseline_drop_max().value),
        sub_drop: em(m.subscript_baseline_drop_min().value),
        script_space: em(m.space_after_script().value),
        limit_gap: em(m.upper_limit_gap_min().value).max(k.limit_gap * 0.5),
        ..k
    })
}

/// The face an equation in a run of `family`/`style` is set in: the first
/// math family the table holds as itself, else the run's own face.
fn math_face(table: &FontTable, family: Option<&str>, style: Option<&str>) -> Option<Bytes> {
    MATH_FAMILIES
        .iter()
        .find_map(|f| match table.bytes_for(Some(f), None) {
            Some((b, false)) => Some(b),
            _ => None,
        })
        .or_else(|| table.bytes_for(family, style).map(|(b, _)| b))
}

/// Set the equations of `paragraph`, each at the size of the run it stands
/// in. An equation with no face to set it in is left out.
pub(super) fn set_equations(
    document: &paged_scene::Document,
    table: &FontTable,
    paragraph: &paged_model::Paragraph,
    font_scale: f32,
) -> Vec<SetEquation> {
    let mut out = Vec::with_capacity(paragraph.equations.len());
    for eq in &paragraph.equations {
        let host = host_run(paragraph, eq.offset);
        let default_run = paged_model::CharacterRun::default();
        let resolved = document.resolved_run_attrs(paragraph, host.unwrap_or(&default_run));
        let size = (eq.point_size.or(resolved.point_size).unwrap_or(12.0) * font_scale).max(0.1);
        let Some(face) = math_face(
            table,
            resolved.font.as_deref(),
            resolved.font_style.as_deref(),
        ) else {
            continue;
        };
        let (Some(shaping), Ok(outline)) = (
            paged_text::Face::from_bytes(&face, 0),
            ttf_parser::Face::parse(&face, 0),
        ) else {
            continue;
        };
        let metrics = FaceMetrics {
            shaping: &shaping,
            outline: &outline,
        };
        let k = math_constants(&outline).unwrap_or_default();
        let layout = paged_math::layout_with(&eq.math, &metrics, size, &k);
        out.push(SetEquation {
            offset: eq.offset,
            layout,
            face,
        });
    }
    out
}

/// The run character `offset` of `paragraph` falls in (the last run past
/// the text): the one whose size and paint the equation takes.
fn host_run(paragraph: &paged_model::Paragraph, offset: u32) -> Option<&paged_model::CharacterRun> {
    let mut at = 0u32;
    for run in &paragraph.runs {
        let n = run.text.chars().count() as u32;
        if offset < at + n {
            return Some(run);
        }
        at += n;
    }
    paragraph.runs.last()
}

/// A path's intern key: its points' bits, hashed.
fn path_key(path: &PathData) -> u64 {
    let mut h: u64 = 0x6d61_7468_0000_0000;
    let mut mix = |v: f32| {
        h = (h ^ u64::from(v.to_bits())).wrapping_mul(0x0000_0100_0000_01b3);
    };
    for s in &path.segments {
        match *s {
            PathSegment::MoveTo { x, y } => {
                mix(1.0);
                mix(x);
                mix(y);
            }
            PathSegment::LineTo { x, y } => {
                mix(2.0);
                mix(x);
                mix(y);
            }
            PathSegment::Close => mix(3.0),
            PathSegment::QuadTo { cx, cy, x, y } => {
                for v in [4.0, cx, cy, x, y] {
                    mix(v);
                }
            }
            PathSegment::CubicTo {
                cx1,
                cy1,
                cx2,
                cy2,
                x,
                y,
            } => {
                for v in [5.0, cx1, cy1, cx2, cy2, x, y] {
                    mix(v);
                }
            }
        }
    }
    h
}

/// Draw a set equation with its baseline origin at page-local `(x, y)`.
pub(super) fn paint_equation(
    set: &SetEquation,
    table: &FontTable,
    origin: (f32, f32),
    paint: Paint,
    list: &mut DisplayList,
) {
    let (Some(shaping), Ok(outline)) = (
        paged_text::Face::from_bytes(&set.face, 0),
        ttf_parser::Face::parse(&set.face, 0),
    ) else {
        return;
    };
    let font = table.font_ref(font_id(&set.face) ^ 400f32.to_bits());
    let outliner = paged_compose::TtfOutliner::new(&outline);
    let translate = Transform([1.0, 0.0, 0.0, 1.0, origin.0, origin.1]);
    for item in &set.layout.items {
        match item {
            Item::Glyphs {
                text,
                x,
                y,
                size,
                variant,
                scale_y,
            } => {
                let (t, lean) = face_text(&outline, text, *variant);
                let shaped = paged_text::shape_run(&shaping, &t, *size);
                let mut pen = 0i32;
                let glyphs: Vec<paged_text::PositionedGlyph> = shaped
                    .glyphs
                    .iter()
                    .map(|g| {
                        let p = paged_text::PositionedGlyph {
                            glyph_id: g.glyph_id,
                            cluster: 0,
                            x: pen + g.x_offset,
                            y: g.y_offset,
                            x_advance: g.x_advance,
                            font_id: font.outline,
                            point_size: *size,
                            underline: false,
                            strikethru: false,
                            substituted: false,
                            x_scale: 1.0,
                            y_scale: *scale_y,
                            skew_deg: if lean { FALLBACK_SLANT_DEG } else { 0.0 },
                            ch: t.get(g.cluster as usize..).and_then(|s| s.chars().next()),
                            upright: None,
                        };
                        pen += g.x_advance;
                        p
                    })
                    .collect();
                paged_compose::emit_glyph_slice(
                    &glyphs,
                    font,
                    *size,
                    |_| paint,
                    (origin.0 + x, origin.1 + y),
                    &outliner,
                    list,
                );
            }
            Item::Rule { x, y, w, h } => {
                let path = PathData {
                    segments: vec![
                        PathSegment::MoveTo { x: *x, y: *y },
                        PathSegment::LineTo { x: x + w, y: *y },
                        PathSegment::LineTo { x: x + w, y: y + h },
                        PathSegment::LineTo { x: *x, y: y + h },
                        PathSegment::Close,
                    ],
                    ..PathData::default()
                };
                let (path_id, _) = list.paths.intern(path_key(&path), path);
                list.push(DisplayCommand::FillPath {
                    path_id,
                    paint,
                    transform: translate,
                });
            }
            Item::Stroke { points, width } => {
                let segments: Vec<PathSegment> = points
                    .iter()
                    .enumerate()
                    .map(|(i, &(x, y))| {
                        if i == 0 {
                            PathSegment::MoveTo { x, y }
                        } else {
                            PathSegment::LineTo { x, y }
                        }
                    })
                    .collect();
                if segments.len() < 2 {
                    continue;
                }
                let path = PathData {
                    segments,
                    ..PathData::default()
                };
                let (path_id, _) = list.paths.intern(path_key(&path), path);
                let mut stroke = Stroke::new(*width);
                stroke.join = paged_compose::LineJoin::Round;
                list.push(DisplayCommand::StrokePath {
                    path_id,
                    paint,
                    stroke,
                    transform: translate,
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_keys_differ_by_geometry() {
        let rect = |w: f32| PathData {
            segments: vec![
                PathSegment::MoveTo { x: 0.0, y: 0.0 },
                PathSegment::LineTo { x: w, y: 0.0 },
                PathSegment::Close,
            ],
            ..PathData::default()
        };
        assert_ne!(path_key(&rect(1.0)), path_key(&rect(2.0)));
        assert_eq!(path_key(&rect(1.0)), path_key(&rect(1.0)));
    }
}

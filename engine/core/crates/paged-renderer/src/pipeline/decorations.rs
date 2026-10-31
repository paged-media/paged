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

//! Line-level text decorations — kenten (emphasis marks), ruby, and
//! underline/strike decorations — extracted from pipeline/mod.rs (audit
//! 1.6b). Net-zero behaviour.

use super::*;

use paged_compose::{Color, DisplayList, Paint, Rect, Stroke};

/// Walk a laid-out line's glyphs and emit horizontal stroke
/// commands for any underlined or struck-through ranges. The stroke
/// uses the run's resolved fill colour (per cluster, via the same
/// picker as the glyphs themselves) so coloured text gets coloured
/// decoration, unless the run names an underline colour. The underline's
/// kind and double strikethrough come from `decor` (engine ADR 1018).
pub(super) fn emit_line_decorations(
    line: &paged_text::layout::LaidOutLine,
    picker: &RunPaintPicker,
    decor: &super::color_paint::RunDecorPicker,
    frame_origin_pt: (f32, f32),
    list: &mut DisplayList,
) {
    use paged_text::shape::ADVANCE_PRECISION;
    if line.glyphs.is_empty() {
        return;
    }
    // Two passes — underline (12% of em below baseline) then
    // strikethrough (30% above) — so a glyph with both gets two
    // stripes. Offsets are crude approximations until we read the
    // font's `OS/2` table for the spec'd y_offset / strikeout_pos.
    const UNDERLINE_OFFSET_EM: f32 = 0.12;
    const STRIKETHRU_OFFSET_EM: f32 = -0.30;
    let baseline_pt = frame_origin_pt.1 + (line.baseline_y as f32) / ADVANCE_PRECISION;
    let x_of =
        |g: &paged_text::PositionedGlyph| frame_origin_pt.0 + (g.x as f32) / ADVANCE_PRECISION;
    let x_end_of = |g: &paged_text::PositionedGlyph| {
        frame_origin_pt.0 + ((g.x + g.x_advance) as f32) / ADVANCE_PRECISION
    };
    for pass in [Pass::Underline, Pass::Strike] {
        // A segment runs while the flag holds and the band's look stays.
        let key = |g: &paged_text::PositionedGlyph| -> Option<DecorKey> {
            let band = decor.pick(g.cluster);
            match pass {
                Pass::Underline if g.underline => Some(DecorKey::Underline(
                    band.underline.unwrap_or(paged_model::UnderlineKind::Single),
                    band.underline_paint,
                )),
                Pass::Strike if g.strikethru => Some(DecorKey::Strike(band.double_strike)),
                _ => None,
            }
        };
        let mut start = 0;
        while start < line.glyphs.len() {
            let Some(k) = key(&line.glyphs[start]) else {
                start += 1;
                continue;
            };
            let mut end = start + 1;
            while end < line.glyphs.len() && key(&line.glyphs[end]) == Some(k) {
                end += 1;
            }
            let g0 = &line.glyphs[start];
            let w = (g0.point_size * 0.06_f32).max(0.4);
            let paint_at = |cluster: u32| picker.pick(cluster);
            match k {
                DecorKey::Underline(kind, own_paint) => {
                    let paint = own_paint.unwrap_or_else(|| paint_at(g0.cluster));
                    let y = baseline_pt + g0.point_size * UNDERLINE_OFFSET_EM;
                    // `Words` leaves the spaces bare: one line per word.
                    let pieces: Vec<(usize, usize)> = if kind == paged_model::UnderlineKind::Words {
                        word_pieces(&line.glyphs[start..end])
                            .into_iter()
                            .map(|(a, b)| (start + a, start + b))
                            .collect()
                    } else {
                        vec![(start, end)]
                    };
                    for (a, b) in pieces {
                        let x0 = x_of(&line.glyphs[a]);
                        let x1 = x_end_of(&line.glyphs[b - 1]);
                        emit_underline(kind, x0, x1, y, w, paint, list);
                    }
                }
                DecorKey::Strike(double) => {
                    let paint = paint_at(g0.cluster);
                    let x0 = x_of(g0);
                    let x1 = x_end_of(&line.glyphs[end - 1]);
                    let y = baseline_pt + g0.point_size * STRIKETHRU_OFFSET_EM;
                    if double {
                        for dy in [-w, w] {
                            paged_compose::emit_line(
                                x0,
                                y + dy,
                                x1,
                                y + dy,
                                Stroke::new(w * 0.75),
                                paint,
                                list,
                            );
                        }
                    } else {
                        paged_compose::emit_line(x0, y, x1, y, Stroke::new(w), paint, list);
                    }
                }
            }
            start = end;
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Pass {
    Underline,
    Strike,
}

#[derive(Clone, Copy, PartialEq)]
enum DecorKey {
    Underline(paged_model::UnderlineKind, Option<Paint>),
    Strike(bool),
}

/// The maximal runs of non-space glyphs in `glyphs`, as index pairs.
fn word_pieces(glyphs: &[paged_text::PositionedGlyph]) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut open: Option<usize> = None;
    for (i, g) in glyphs.iter().enumerate() {
        let space = g.ch.is_some_and(char::is_whitespace);
        match (space, open) {
            (false, None) => open = Some(i),
            (true, Some(a)) => {
                out.push((a, i));
                open = None;
            }
            _ => {}
        }
    }
    if let Some(a) = open {
        out.push((a, glyphs.len()));
    }
    out
}

/// One underline of `kind` from `x0` to `x1` at `y`, `w` its base weight.
fn emit_underline(
    kind: paged_model::UnderlineKind,
    x0: f32,
    x1: f32,
    y: f32,
    w: f32,
    paint: Paint,
    list: &mut DisplayList,
) {
    use paged_compose::{DashPattern, LineCap};
    use paged_model::UnderlineKind as K;
    let dashed = |pattern: &[f32], cap: LineCap| {
        let mut s = Stroke::new(w);
        s.dash = DashPattern::from_slice(pattern);
        s.cap = cap;
        s
    };
    match kind {
        K::None => {}
        K::Single | K::Words => paged_compose::emit_line(x0, y, x1, y, Stroke::new(w), paint, list),
        K::Thick => paged_compose::emit_line(x0, y, x1, y, Stroke::new(w * 2.0), paint, list),
        K::Double => {
            let thin = Stroke::new(w * 0.75);
            paged_compose::emit_line(x0, y - w * 0.6, x1, y - w * 0.6, thin, paint, list);
            paged_compose::emit_line(x0, y + w * 1.2, x1, y + w * 1.2, thin, paint, list);
        }
        K::Dotted => {
            let s = dashed(&[0.0, w * 2.0], LineCap::Round);
            paged_compose::emit_line(x0, y, x1, y, s, paint, list);
        }
        K::Dashed => {
            let s = dashed(&[w * 4.0, w * 2.5], LineCap::Butt);
            paged_compose::emit_line(x0, y, x1, y, s, paint, list);
        }
        K::DotDash => {
            let s = dashed(&[w * 4.0, w * 2.0, 0.0, w * 2.0], LineCap::Round);
            paged_compose::emit_line(x0, y, x1, y, s, paint, list);
        }
        K::DotDotDash => {
            let s = dashed(
                &[w * 4.0, w * 2.0, 0.0, w * 2.0, 0.0, w * 2.0],
                LineCap::Round,
            );
            paged_compose::emit_line(x0, y, x1, y, s, paint, list);
        }
        K::Wave | K::DoubleWave => {
            let rows: &[f32] = if kind == K::Wave {
                &[0.0]
            } else {
                &[-w, w * 1.5]
            };
            for dy in rows {
                emit_wave(x0, x1, y + dy, w, paint, list);
            }
        }
    }
}

/// A wavy line as short straight steps: amplitude `w`, wavelength `4w`.
fn emit_wave(x0: f32, x1: f32, y: f32, w: f32, paint: Paint, list: &mut DisplayList) {
    let wavelength = (w * 4.0).max(1.0);
    let step = wavelength / 8.0;
    let n = (((x1 - x0) / step).ceil() as usize).min(4096);
    let at = |x: f32| y + w * (std::f32::consts::TAU * (x - x0) / wavelength).sin();
    let mut x = x0;
    for _ in 0..n {
        let nx = (x + step).min(x1);
        paged_compose::emit_line(x, at(x), nx, at(nx), Stroke::new(w * 0.8), paint, list);
        x = nx;
    }
}

/// Engine ADR 1018 — a run's highlight: per highlighted segment of the
/// line, one rect from ascent to descent behind the glyphs (emitted
/// before them), as Word paints `w:highlight`.
pub(super) fn emit_highlight_for_line(
    line: &paged_text::layout::LaidOutLine,
    decor: &super::color_paint::RunDecorPicker,
    metrics_for_glyph: &dyn Fn(u32) -> Option<FontMetrics>,
    frame_origin_pt: (f32, f32),
    list: &mut DisplayList,
) {
    use paged_text::shape::ADVANCE_PRECISION;
    let paint_of = |g: &paged_text::PositionedGlyph| decor.pick(g.cluster).highlight;
    let mut start = 0;
    while start < line.glyphs.len() {
        let Some(paint) = paint_of(&line.glyphs[start]) else {
            start += 1;
            continue;
        };
        let mut end = start + 1;
        while end < line.glyphs.len() && paint_of(&line.glyphs[end]) == Some(paint) {
            end += 1;
        }
        let g0 = &line.glyphs[start];
        let g_last = &line.glyphs[end - 1];
        let x0 = frame_origin_pt.0 + (g0.x as f32) / ADVANCE_PRECISION;
        let x1 = frame_origin_pt.0 + ((g_last.x + g_last.x_advance) as f32) / ADVANCE_PRECISION;
        let baseline = frame_origin_pt.1 + (line.baseline_y as f32) / ADVANCE_PRECISION;
        let (ascender, descender) = metrics_for_glyph(g0.font_id)
            .map(|m| (m.ascender, m.descender))
            .unwrap_or((0.8, 0.2));
        let size = g0.point_size.max(1.0);
        let rect = Rect {
            x: x0,
            y: baseline - ascender * size,
            w: x1 - x0,
            h: (ascender + descender) * size,
        };
        if rect.w > 0.0 && rect.h > 0.0 {
            paged_compose::emit_rect_transformed(rect, Transform::IDENTITY, paint, list);
        }
        start = end;
    }
}

/// A3 — pink "this text renders in a substituted font" highlight.
/// Same contiguous-segment walk as [`emit_line_decorations`], keyed on
/// [`paged_text::PositionedGlyph::substituted`]: per substituted
/// segment, one `FillPath` rect spanning the segment horizontally and
/// ascent→descent vertically. `metrics_for_glyph` maps a glyph's
/// `font_id` to the face's parsed metrics (the caller resolves the
/// wght-mixed glyph id back to the `FontTable::metrics_for` key); a
/// miss falls back to the pipeline's usual 0.8 / 0.2 em split.
///
/// Emitted BEFORE the line's glyph fills so the pink composites behind
/// the text, and gated on `PipelineOptions::degraded_asset_markers` at
/// the call site (default off — exports stay byte-identical).
pub(super) fn emit_substituted_highlight_for_line(
    line: &paged_text::layout::LaidOutLine,
    metrics_for_glyph: &dyn Fn(u32) -> Option<FontMetrics>,
    frame_origin_pt: (f32, f32),
    list: &mut DisplayList,
) {
    use paged_text::shape::ADVANCE_PRECISION;
    if line.glyphs.is_empty() || !line.glyphs.iter().any(|g| g.substituted) {
        return;
    }
    let pink = Paint::Solid(Color {
        r: SUBSTITUTED_HIGHLIGHT_R,
        g: SUBSTITUTED_HIGHLIGHT_G,
        b: SUBSTITUTED_HIGHLIGHT_B,
        a: 1.0,
    });
    let mut start = 0;
    while start < line.glyphs.len() {
        if !line.glyphs[start].substituted {
            start += 1;
            continue;
        }
        let mut end = start + 1;
        while end < line.glyphs.len() && line.glyphs[end].substituted {
            end += 1;
        }
        let g0 = &line.glyphs[start];
        let g_last = &line.glyphs[end - 1];
        let x_start_pt = frame_origin_pt.0 + (g0.x as f32) / ADVANCE_PRECISION;
        let x_end_pt =
            frame_origin_pt.0 + ((g_last.x + g_last.x_advance) as f32) / ADVANCE_PRECISION;
        let baseline_pt = frame_origin_pt.1 + (line.baseline_y as f32) / ADVANCE_PRECISION;
        let (ascender, descender) = metrics_for_glyph(g0.font_id)
            .map(|m| (m.ascender, m.descender))
            .unwrap_or((0.8, 0.2));
        let point_size = g0.point_size.max(1.0);
        let rect = Rect {
            x: x_start_pt,
            y: baseline_pt - ascender * point_size,
            w: x_end_pt - x_start_pt,
            h: (ascender + descender) * point_size,
        };
        if rect.w > 0.0 && rect.h > 0.0 {
            paged_compose::emit_rect_transformed(rect, Transform::IDENTITY, pink, list);
        }
        start = end;
    }
}

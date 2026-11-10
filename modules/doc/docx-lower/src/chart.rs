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

//! Word's charts (doc ADR 628): a chart drawn from its cached values by
//! paged.slide's chart layout (`slide_chart::layout`, PowerPoint's, which is
//! Word's: both are Office's chart engine), as the pieces of an anchored
//! group. Bars, lines, areas, wedges and gridlines are outlined frames with
//! their look through the shared DrawingML mapper; titles, legend entries
//! and labels are text frames whose one paragraph is lowered as a text
//! box's is.

use docx_core::{
    ChartDrawing, Justification, LineRule, LineSpacing, ParaProps, Paragraph, Run, RunProps,
};
use paged_ooxml::drawingml::{resolved::Paint, Fill, ShapeProperties};
use slide_chart::outline::contour;
use slide_chart::{Align, Prim};

use crate::ir::{LoweredGroup, LoweredPiece};
use crate::{emu_to_pt, sections};

/// Width of a label's text frame per character, as a share of its size: wide
/// enough that no label wraps (the text is aligned in it).
const LABEL_ADVANCE: f32 = 0.62;

impl crate::Lowering {
    /// A chart as an anchored group of its paragraph, placed as a shape is.
    pub(crate) fn lower_chart(&mut self, c: &ChartDrawing, at: u32) -> LoweredGroup {
        let w = emu_to_pt(c.width_emu);
        let h = emu_to_pt(c.height_emu);
        let (anchor, layout, at) =
            self.anchored_place(c.float.as_ref(), c.width_emu, c.height_emu, at);
        let prims = slide_chart::layout(&c.chart, w as f64, h as f64);
        let mut pieces = Vec::new();
        for prim in &prims {
            let piece = match prim {
                Prim::Label {
                    x,
                    cy,
                    align,
                    text,
                    props,
                } => self.chart_label(*x as f32, *cy as f32, *align, text, props),
                Prim::Rect { fill, line, .. }
                | Prim::Path { fill, line, .. }
                | Prim::Wedge { fill, line, .. } => self.chart_shape(prim, fill, line),
            };
            pieces.extend(piece);
        }
        self.w4.charts += 1;
        LoweredGroup {
            at,
            width_pt: w,
            height_pt: h,
            anchor,
            layout,
            part: c.part.clone(),
            pieces,
        }
    }

    /// A shape primitive as an outlined frame in its own box.
    fn chart_shape(
        &mut self,
        prim: &Prim,
        fill: &Option<Fill>,
        line: &Option<paged_ooxml::drawingml::Line>,
    ) -> Option<LoweredPiece> {
        let c = contour(prim)?;
        let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
        for p in &c.points {
            for (x, y) in [p.anchor, p.left, p.right] {
                x0 = x0.min(x);
                y0 = y0.min(y);
                x1 = x1.max(x);
                y1 = y1.max(y);
            }
        }
        // A gridline or an axis has no height (or width); the frame needs
        // one to be drawn, its outline does not.
        let (bw, bh) = ((x1 - x0).max(0.01), (y1 - y0).max(0.01));
        let mut mapper = dml_native::native::Lowering::new(self.dml_slots.clone());
        let sp = ShapeProperties {
            fill: fill.clone(),
            line: line.clone(),
            ..Default::default()
        };
        let fx = mapper.shape(&sp, bw, bh);
        if fx.is_empty() {
            return None;
        }
        for col in fx.colors() {
            self.swatch_for(col.trim_start_matches('#'));
        }
        let rel = |(x, y): (f64, f64)| ((x - x0) as f32, (y - y0) as f32);
        let anchors = c
            .points
            .iter()
            .map(|p| {
                let (a, l, r) = (rel(p.anchor), rel(p.left), rel(p.right));
                [a.0, a.1, l.0, l.1, r.0, r.1]
            })
            .collect();
        Some(LoweredPiece::Shape {
            bounds: [x0 as f32, y0 as f32, bw as f32, bh as f32],
            anchors,
            starts: vec![0],
            open: vec![!c.closed],
            fx: Some(Box::new(fx)),
        })
    }

    /// A label as a text frame of one paragraph, lowered as a text box's
    /// paragraphs are: the label's size, weight, colour and font as direct
    /// formatting, no spacing, single lines, aligned against `x` and centred
    /// on `cy`.
    fn chart_label(
        &mut self,
        x: f32,
        cy: f32,
        align: Align,
        text: &str,
        props: &pptx_core::RunProps,
    ) -> Option<LoweredPiece> {
        if text.trim().is_empty() {
            return None;
        }
        let size = props.size.unwrap_or(1197) as f32 / 100.0;
        let width = text.chars().count() as f32 * size * LABEL_ADVANCE + size;
        let (left, justification) = match align {
            Align::Left => (x, Justification::Left),
            Align::Center => (x - width / 2.0, Justification::Center),
            Align::Right => (x - width, Justification::Right),
        };
        let run = self.drawing_run(
            size,
            props.bold,
            props.italic,
            props.fill.as_ref(),
            props.latin.as_deref(),
        );
        let paragraph = drawing_paragraph(justification, 240, vec![(text.to_string(), run)]);
        let lowered = self.lower_drawing_paragraphs(&[paragraph], width);
        // Two lines high: a line that does not fit its frame is not set.
        Some(LoweredPiece::Label {
            bounds: [left, cy - 0.6 * size, width, 2.0 * size],
            paragraphs: lowered,
            insets: [0.0; 4],
            valign: None,
            rotation: 0.0,
        })
    }

    /// A drawing's run formatting (a chart label's, a diagram shape's text)
    /// as Word's direct formatting: the size in points, the weight, the
    /// colour resolved against the theme, the font (the theme's minor or
    /// major face for `+mn-lt` / `+mj-lt` and when none is named).
    pub(crate) fn drawing_run(
        &mut self,
        size: f32,
        bold: Option<bool>,
        italic: Option<bool>,
        fill: Option<&Fill>,
        latin: Option<&str>,
    ) -> RunProps {
        let mut run = RunProps {
            size_half_pts: Some((size * 2.0).round().max(1.0) as u32),
            bold,
            italic,
            ..Default::default()
        };
        if let Some(fill) = fill {
            let mut mapper = dml_native::native::Lowering::new(self.dml_slots.clone());
            if let Paint::Solid { rgb, .. } = mapper.resolve_paint(fill) {
                let hex = dml_native::native::hex(rgb);
                run.color = Some(hex.trim_start_matches('#').to_string());
            }
        }
        match latin {
            Some("+mn-lt") | None => {
                run.font = self.word_theme.as_ref().and_then(|t| t.minor.latin.clone());
                run.font_theme = run.font.as_ref().map(|_| "minorHAnsi".to_string());
            }
            Some("+mj-lt") => {
                run.font = self.word_theme.as_ref().and_then(|t| t.major.latin.clone());
                run.font_theme = run.font.as_ref().map(|_| "majorHAnsi".to_string());
            }
            Some(face) => run.font = Some(face.to_string()),
        }
        run
    }

    /// A drawing's paragraphs lowered as a text box's are, in a frame
    /// `width` pt wide.
    pub(crate) fn lower_drawing_paragraphs(
        &mut self,
        paragraphs: &[Paragraph],
        width: f32,
    ) -> Vec<crate::ir::LoweredParagraph> {
        let saved = (
            self.text_width,
            self.section_indent,
            self.section_columns,
            self.in_cell,
            self.spacing_override,
        );
        self.text_width = Some(width.max(1.0));
        self.section_indent = (0.0, 0.0);
        self.section_columns = sections::SectionColumns::Frame;
        let out = paragraphs
            .iter()
            .map(|p| {
                self.spacing_override = (None, false);
                self.lower_body_paragraph(p, 0, None, Some(false)).0
            })
            .collect();
        (
            self.text_width,
            self.section_indent,
            self.section_columns,
            self.in_cell,
            self.spacing_override,
        ) = saved;
        out
    }
}

/// A drawing's paragraph: aligned, no indents or spacing, its lines at
/// `line` 240ths of single spacing, its runs' text and formatting.
pub(crate) fn drawing_paragraph(
    justification: Justification,
    line: i32,
    runs: Vec<(String, RunProps)>,
) -> Paragraph {
    Paragraph {
        props: ParaProps {
            justification: Some(justification),
            left_indent: Some(0),
            right_indent: Some(0),
            first_line_indent: Some(0),
            space_before: Some(0),
            space_after: Some(0),
            line_spacing: Some(LineSpacing {
                value: line,
                rule: LineRule::Auto,
            }),
            ..Default::default()
        },
        runs: runs
            .into_iter()
            .map(|(text, props)| Run {
                props,
                text,
                ..Default::default()
            })
            .collect(),
        ..Default::default()
    }
}

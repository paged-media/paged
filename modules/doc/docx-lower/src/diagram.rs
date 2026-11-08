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

//! SmartArt (doc ADR 629): the shapes of the drawing Word saved of the
//! diagram, each lowered as a Word shape is (ADR 627: its outline through
//! the preset evaluator, its look through the shared DrawingML mapper) and
//! its text as a text frame over the box Word sets it in, all pieces of one
//! anchored group.

use docx_core::{DiagramDrawing, DiagramText, Justification};

use crate::chart::drawing_paragraph;
use crate::emu_to_pt;
use crate::ir::{LoweredGroup, LoweredPiece};

impl crate::Lowering {
    /// A diagram as an anchored group of its paragraph, placed as a shape is.
    pub(crate) fn lower_diagram(&mut self, d: &DiagramDrawing, at: u32) -> LoweredGroup {
        let (anchor, layout, at) =
            self.anchored_place(d.float.as_ref(), d.width_emu, d.height_emu, at);
        let mut pieces = Vec::new();
        for ds in &d.shapes {
            let (x, y) = (emu_to_pt(ds.x_emu), emu_to_pt(ds.y_emu));
            let (w, h) = (
                emu_to_pt(ds.shape.width_emu),
                emu_to_pt(ds.shape.height_emu),
            );
            match crate::shape_geom::outline(&ds.shape, w, h) {
                Ok(outline) => {
                    let fx = ds.shape.look.as_ref().and_then(|look| {
                        let mut mapper = dml_native::native::Lowering::new(self.dml_slots.to_vec());
                        let fx = mapper.picture(&look.blip, &look.shape, w as f64, h as f64);
                        (!fx.is_empty()).then_some(fx)
                    });
                    if let Some(fx) = &fx {
                        for c in fx.colors() {
                            self.swatch_for(c.trim_start_matches('#'));
                        }
                    }
                    if fx.is_some() {
                        pieces.push(LoweredPiece::Shape {
                            bounds: [x, y, w.max(0.01), h.max(0.01)],
                            anchors: outline.anchors,
                            starts: outline.starts,
                            open: outline.open,
                            fx: fx.map(Box::new),
                        });
                    }
                }
                Err(reason) => {
                    if !self.w4.undrawn_shapes.contains(&reason) {
                        self.w4.undrawn_shapes.push(reason);
                    }
                }
            }
            if let Some(t) = &ds.text {
                pieces.push(self.diagram_text(t));
            }
        }
        self.w4.diagrams += 1;
        LoweredGroup {
            at,
            width_pt: emu_to_pt(d.width_emu),
            height_pt: emu_to_pt(d.height_emu),
            anchor,
            layout,
            part: d.part.clone(),
            pieces,
        }
    }

    /// A diagram shape's text as a text frame over its text box.
    fn diagram_text(&mut self, t: &DiagramText) -> LoweredPiece {
        let [l, top, r, b] = t.insets_emu.map(emu_to_pt);
        let width = emu_to_pt(t.width_emu);
        let paragraphs: Vec<_> = t
            .paragraphs
            .iter()
            .map(|p| {
                let justification = match p.align.as_deref() {
                    Some("l") => Justification::Left,
                    Some("r") => Justification::Right,
                    Some("just") | Some("dist") => Justification::Both,
                    _ => Justification::Center,
                };
                // Word's diagram text states its line spacing as a share
                // of single spacing (`a:spcPct`, 1 000ths of a percent).
                let line = p
                    .line_pct
                    .map_or(240, |v| (v as f32 * 240.0 / 100_000.0).round() as i32);
                let runs = p
                    .runs
                    .iter()
                    .map(|r| {
                        let size = r.size.unwrap_or(1800) as f32 / 100.0;
                        let props = self.drawing_run(
                            size,
                            r.bold,
                            r.italic,
                            r.fill.as_ref(),
                            r.latin.as_deref(),
                        );
                        (r.text.clone(), props)
                    })
                    .collect();
                drawing_paragraph(justification, line, runs)
            })
            .collect();
        let paragraphs = self.lower_drawing_paragraphs(&paragraphs, width - l - r);
        LoweredPiece::Label {
            bounds: [
                emu_to_pt(t.x_emu),
                emu_to_pt(t.y_emu),
                width,
                emu_to_pt(t.height_emu),
            ],
            paragraphs,
            insets: [top, l, b, r],
            valign: match t.anchor.as_str() {
                "ctr" => Some("CenterAlign".into()),
                "b" => Some("BottomAlign".into()),
                _ => None,
            },
        }
    }
}

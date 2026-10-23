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

//! The chart frame: title, legend and the rectangle left for the plot.
//! The title sits centred at the top; the legend takes the side its
//! position names (right, left, top, bottom, top-right corner) unless it
//! overlays the plot.

use crate::colors::Paint;
use crate::geometry::{Pen, TextAnchor, TextSpec, LABEL_PT, TITLE_PT};
use crate::model::{ChartModel, LegendPosition, MarkerSymbol};

/// Outer padding of the content box, pt.
pub(crate) const PAD: f64 = 6.0;
const SWATCH: f64 = 7.0;
const SWATCH_GAP: f64 = 4.0;
const ENTRY_GAP: f64 = 10.0;

/// A rectangle in content pt.
#[derive(Copy, Clone, Debug, PartialEq)]
pub(crate) struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Rect {
    pub fn right(&self) -> f64 {
        self.x + self.w
    }
    pub fn bottom(&self) -> f64 {
        self.y + self.h
    }
    pub fn cx(&self) -> f64 {
        self.x + self.w / 2.0
    }
    pub fn cy(&self) -> f64 {
        self.y + self.h / 2.0
    }
    pub fn ok(&self) -> bool {
        self.w > 1.0 && self.h > 1.0
    }
    pub fn inset(&self, l: f64, t: f64, r: f64, b: f64) -> Rect {
        Rect {
            x: self.x + l,
            y: self.y + t,
            w: (self.w - l - r).max(0.0),
            h: (self.h - t - b).max(0.0),
        }
    }
}

/// How a legend entry is drawn.
#[derive(Clone, Debug)]
pub(crate) enum Glyph {
    /// A filled box (bars, areas, slices).
    Box(Paint),
    /// A short line, with a marker when the series has one.
    Line(Paint, Option<(MarkerSymbol, Paint)>),
    /// A marker alone (scatter without lines).
    Marker(MarkerSymbol, Paint),
}

/// One legend entry.
#[derive(Clone, Debug)]
pub(crate) struct Entry {
    pub label: String,
    pub glyph: Glyph,
}

/// Lay out the title and legend, draw them, and return the plot rectangle.
pub(crate) fn frame(pen: &Pen, model: &ChartModel, entries: &[Entry]) -> Rect {
    let mut r = Rect {
        x: PAD,
        y: PAD,
        w: (pen.w - 2.0 * PAD).max(0.0),
        h: (pen.h - 2.0 * PAD).max(0.0),
    };
    if let Some(t) = model.title.as_deref().filter(|t| !t.is_empty()) {
        let spec = TextSpec::of(
            &model.title_style,
            &model.text,
            TITLE_PT,
            TextAnchor::Middle,
            "title",
            &pen.theme,
        );
        let lines = crate::geometry::wrap(t, r.w, spec.size);
        let lh = spec.size * 1.2;
        let mut y = r.y + spec.size;
        for l in &lines {
            pen.text(pen.w / 2.0, y, l, &spec);
            y += lh;
        }
        if !model.title_overlay {
            let used = lh * lines.len() as f64 + 4.0;
            r = r.inset(0.0, used, 0.0, 0.0);
        }
    }
    if let (Some(legend), false) = (&model.legend, entries.is_empty()) {
        let spec = TextSpec::of(
            &legend.style,
            &model.text,
            LABEL_PT,
            TextAnchor::Start,
            "legend",
            &pen.theme,
        );
        let item_w = |e: &Entry| SWATCH + SWATCH_GAP + spec.width(&e.label);
        let row_h = spec.size * 1.4;
        match legend.position {
            LegendPosition::Right | LegendPosition::Left | LegendPosition::TopRight => {
                let w = entries.iter().map(item_w).fold(0.0, f64::max) + 8.0;
                let w = w.min(r.w * 0.4);
                let h = row_h * entries.len() as f64;
                let x = if legend.position == LegendPosition::Left {
                    r.x
                } else {
                    r.right() - w
                };
                let y = if legend.position == LegendPosition::TopRight {
                    r.y
                } else {
                    r.y + ((r.h - h) / 2.0).max(0.0)
                };
                for (i, e) in entries.iter().enumerate() {
                    draw_entry(pen, x + 4.0, y + i as f64 * row_h, row_h, e, &spec);
                }
                if !legend.overlay {
                    r = if legend.position == LegendPosition::Left {
                        r.inset(w + 4.0, 0.0, 0.0, 0.0)
                    } else {
                        r.inset(0.0, 0.0, w + 4.0, 0.0)
                    };
                }
            }
            LegendPosition::Top | LegendPosition::Bottom => {
                // Rows of entries, each row centred, wrapped to the width.
                let mut rows: Vec<Vec<&Entry>> = vec![Vec::new()];
                let mut row_w = 0.0;
                for e in entries {
                    let w = item_w(e) + ENTRY_GAP;
                    if row_w + w > r.w && !rows.last().unwrap().is_empty() {
                        rows.push(Vec::new());
                        row_w = 0.0;
                    }
                    rows.last_mut().unwrap().push(e);
                    row_w += w;
                }
                let h = row_h * rows.len() as f64;
                let top = if legend.position == LegendPosition::Top {
                    r.y
                } else {
                    r.bottom() - h
                };
                for (ri, row) in rows.iter().enumerate() {
                    let total: f64 = row.iter().map(|e| item_w(e)).sum::<f64>()
                        + ENTRY_GAP * (row.len() as f64 - 1.0);
                    let mut x = r.x + ((r.w - total) / 2.0).max(0.0);
                    for e in row {
                        draw_entry(pen, x, top + ri as f64 * row_h, row_h, e, &spec);
                        x += item_w(e) + ENTRY_GAP;
                    }
                }
                if !legend.overlay {
                    r = if legend.position == LegendPosition::Top {
                        r.inset(0.0, h + 4.0, 0.0, 0.0)
                    } else {
                        r.inset(0.0, 0.0, 0.0, h + 4.0)
                    };
                }
            }
        }
    }
    r
}

fn draw_entry(pen: &Pen, x: f64, y: f64, row_h: f64, e: &Entry, spec: &TextSpec) {
    let cy = y + row_h / 2.0;
    match &e.glyph {
        Glyph::Box(p) => pen.bar(x, cy - SWATCH / 2.0, SWATCH, SWATCH, p),
        Glyph::Line(p, m) => {
            pen.line(vec![(x - 2.0, cy), (x + SWATCH + 2.0, cy)], p, 1.5, None);
            if let Some((sym, mp)) = m {
                crate::extras::marker(pen, x + SWATCH / 2.0, cy, *sym, 5.0, mp, None);
            }
        }
        Glyph::Marker(sym, p) => {
            crate::extras::marker(pen, x + SWATCH / 2.0, cy, *sym, 5.0, p, None)
        }
    }
    pen.text(
        x + SWATCH + SWATCH_GAP,
        cy + spec.size * 0.35,
        &e.label,
        &spec.anchored(TextAnchor::Start),
    );
}

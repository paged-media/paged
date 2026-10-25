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

//! What a shape's text looks like with nothing set: the defaults it
//! inherits from its placeholder, layout, master and the presentation,
//! level by level. A regenerated run or paragraph writes only what differs
//! from them (ADR 704: placeholders as differences from their layout).
//!
//! The answer comes from the resolver itself, the code import draws with:
//! a probe slide on the shape's layout holds a copy of the shape whose
//! text is one bare run per list level, and what the resolver makes of it
//! is the default. So what export leaves out reads back as what import
//! would have drawn.

use std::collections::BTreeMap;

use pptx_core::{
    FrameContent, Paragraph, ParagraphProps, Presentation, Run, RunKind, RunProps, Shape, Slide,
    TextBody,
};
use slide_resolve::model::{Deck, Item, ItemKind, Para, TextFrame};

/// The probe text: one paragraph per list level, each one bare run.
pub fn probe_body(body: Option<&TextBody>) -> TextBody {
    let mut tb = body.cloned().unwrap_or_default();
    tb.paragraphs = (0..9u8)
        .map(|l| Paragraph {
            props: ParagraphProps {
                level: Some(l),
                ..ParagraphProps::default()
            },
            runs: vec![Run {
                kind: RunKind::Text("x".into()),
                props: RunProps::default(),
            }],
            end_props: None,
        })
        .collect();
    tb
}

/// A shape with its text (and each table cell's) replaced by the probe.
pub fn probe_shape(s: &Shape) -> Shape {
    match s {
        Shape::Sp(sp) => {
            let mut sp = sp.clone();
            sp.text = Some(probe_body(sp.text.as_ref()));
            Shape::Sp(sp)
        }
        Shape::Connector(sp) => {
            let mut sp = sp.clone();
            sp.text = Some(probe_body(sp.text.as_ref()));
            Shape::Connector(sp)
        }
        Shape::Frame(f) => {
            let mut f = f.clone();
            if let FrameContent::Table(t) = &mut f.content {
                for r in &mut t.rows {
                    for c in &mut r.cells {
                        c.text = Some(probe_body(c.text.as_ref()));
                    }
                }
            }
            Shape::Frame(f)
        }
        Shape::Group(g) => {
            let mut g = g.clone();
            g.children = g.children.iter().map(probe_shape).collect();
            Shape::Group(g)
        }
        other => other.clone(),
    }
}

/// Per list level (0–8) defaults of one text: a shape's, or a table
/// cell's.
#[derive(Debug, Clone)]
pub struct Defaults {
    pub levels: Vec<Para>,
    /// `normAutofit` font scale the resolver applied to every size.
    pub font_scale: f64,
}

impl Defaults {
    pub fn level(&self, l: usize) -> Option<&Para> {
        self.levels.get(l.min(8)).or(self.levels.first())
    }

    fn of(tf: &TextFrame) -> Defaults {
        Defaults {
            levels: tf.paragraphs.clone(),
            font_scale: tf.shrink.map(|s| s.0).unwrap_or(1.0),
        }
    }
}

/// What the probe resolved, by the probe shapes' `cNvPr` ids: the
/// resolved item and its text defaults; a table's cells by (row, column).
#[derive(Debug, Default)]
pub struct Probed {
    pub items: BTreeMap<u32, Item>,
    pub text: BTreeMap<u32, Defaults>,
    pub cells: BTreeMap<(u32, usize, usize), Defaults>,
    pub deck: Deck,
}

/// Resolve `shapes` on a probe slide of `layout_part` (the deck's first
/// layout when `None`). Each shape's `cNvPr` id must be distinct.
pub fn probe(ir: &Presentation, layout_part: Option<&str>, shapes: Vec<Shape>) -> Probed {
    let mut deck = ir.clone();
    let layout_part = layout_part
        .map(str::to_string)
        .or_else(|| ir.layouts.first().map(|l| l.part.clone()));
    deck.slides = vec![Slide {
        part: "ppt/slides/probe.xml".into(),
        slide_id: 256,
        layout_part,
        show_master_shapes: true,
        shapes,
        ..Slide::default()
    }];
    let resolved = slide_resolve::resolve(&deck);
    let mut out = Probed::default();
    fn walk(items: &[Item], out: &mut Probed) {
        for it in items {
            match &it.kind {
                ItemKind::Shape { text: Some(tf), .. } => {
                    out.text.insert(it.meta.shape_id, Defaults::of(tf));
                }
                ItemKind::Table(t) => {
                    for (r, (_, cells)) in t.rows.iter().enumerate() {
                        for (c, cell) in cells.iter().enumerate() {
                            if let Some(tf) = &cell.text {
                                out.cells.insert((it.meta.shape_id, r, c), Defaults::of(tf));
                            }
                        }
                    }
                }
                ItemKind::Group { children } if it.meta.frame.is_none() => walk(children, out),
                _ => {}
            }
            out.items.insert(it.meta.shape_id, it.clone());
        }
    }
    if let Some(s) = resolved.slides.first() {
        walk(&s.items, &mut out);
    }
    out.deck = resolved;
    out
}

/// `p:ph type` as the resolver names it (`obj` and no type are `body`,
/// `ctrTitle` is `title`).
pub fn canonical(kind: Option<&str>) -> &str {
    match kind {
        None | Some("obj") => "body",
        Some("ctrTitle") => "title",
        Some(k) => k,
    }
}

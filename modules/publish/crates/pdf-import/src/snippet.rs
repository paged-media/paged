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

//! **Place as vectors** into the open document (publish ADR 658): one PDF
//! or Illustrator page as an engine snippet (engine ADR 193) — the copied
//! page items the editor's Paste takes — which the bundle hands to
//! `pasteElements` as one mutation: one batch, one undo step, the items
//! grafted on top of the target spread under fresh ids, the colours and
//! gradients they name added where the document lacks them.

use std::collections::{BTreeMap, HashSet};

use kurbo::Affine;
use paged_model::{FrameRef, Group, PathAnchor, Polygon, Spread};
use paged_scene::snippet::{ItemSnippet, SnippetResources, SNIPPET_FORMAT};
use paged_scene::ParsedStory;
use serde::{Deserialize, Serialize};

use crate::ir::TextFrameIr;
use crate::lower::{bounds_of_refs, IdGen, Lowering, Palette, TextMode, TextPlan, IDENTITY};
use crate::vectors::{self, ir::Loss, PageBox, ReadError, ReadOptions};

/// What to place, and how (the bundle's `placeVectors` request).
#[derive(Debug, Clone, Deserialize)]
pub struct PlaceRequest {
    /// 0-based page of the file.
    pub page: usize,
    /// `"crop"` (default), `"media"`, `"trim"`, `"bleed"`, `"art"`.
    #[serde(default)]
    pub page_box: Option<String>,
    /// The page box's points (top-left origin, y down) → the target
    /// page's coordinates, `[a, b, c, d, e, f]`.
    pub placement: [f64; 6],
    /// The page's text frames as the bundle's text reader recovered them,
    /// in the page box's points.
    #[serde(default)]
    pub text_frames: Vec<TextFrameIr>,
    /// Font families the host does not have.
    #[serde(default)]
    pub missing_fonts: Vec<String>,
    /// `"frames"` (default) or `"outlines"`.
    #[serde(default)]
    pub text: Option<String>,
    /// Wrap what lands in one group (default true).
    #[serde(default)]
    pub group: Option<bool>,
    /// The group's name.
    #[serde(default)]
    pub name: Option<String>,
    /// Clip what lands to this outline (target page coordinates): a
    /// converted placed PDF keeps its frame's crop.
    #[serde(default)]
    pub clip: Option<Vec<[f32; 2]>>,
    /// Resolution a shading without a native form is sampled at.
    #[serde(default)]
    pub sample_ppi: Option<f32>,
}

/// How many of each kind of item a placement made.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct Counts {
    pub paths: usize,
    pub images: usize,
    pub groups: usize,
    pub clip_groups: usize,
    pub text_frames: usize,
    pub opacity_masks: usize,
    pub gradients: usize,
    pub colors: usize,
}

/// The snippet and what it holds.
#[derive(Debug, Clone, Serialize)]
pub struct PlaceResult {
    /// The snippet JSON `pasteElements` takes.
    pub snippet: String,
    /// The page's size in points (the box read).
    pub width_pt: f32,
    pub height_pt: f32,
    /// What lands, target page coordinates: `[top, left, bottom, right]`.
    pub bounds: [f32; 4],
    pub counts: Counts,
    /// Every loss, the page reader's and the lowering's, by code.
    pub losses: Vec<Loss>,
}

/// Why a placement failed.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PlaceError {
    #[error(transparent)]
    Read(#[from] ReadError),
    #[error("the page paints nothing")]
    Empty,
    #[error("the request is not valid: {0}")]
    Request(String),
}

impl PlaceError {
    pub fn code(&self) -> &'static str {
        match self {
            PlaceError::Read(e) => e.code(),
            PlaceError::Empty => "empty",
            PlaceError::Request(_) => "invalidRequest",
        }
    }
}

/// Read `req.page` of `bytes` and lower it into a snippet.
pub fn place(bytes: &[u8], req: &PlaceRequest) -> Result<PlaceResult, PlaceError> {
    if req.placement.iter().any(|v| !v.is_finite()) {
        return Err(PlaceError::Request("the placement is not a number".into()));
    }
    let place = Affine::new(req.placement);
    if place.determinant().abs() < 1e-12 {
        return Err(PlaceError::Request("the placement has no area".into()));
    }
    let defaults = ReadOptions::default();
    let opts = ReadOptions {
        page_box: PageBox::parse(req.page_box.as_deref().unwrap_or("crop")),
        sample_ppi: req
            .sample_ppi
            .unwrap_or(defaults.sample_ppi)
            .clamp(36.0, 600.0),
        ..defaults
    };
    let page = vectors::read_page(bytes, req.page, &opts)?;
    let plan = TextPlan {
        frames: req.text_frames.clone(),
        missing_fonts: req.missing_fonts.iter().cloned().collect::<HashSet<_>>(),
        mode: match req.text.as_deref() {
            Some("outlines") => TextMode::Outlines,
            _ => TextMode::Frames,
        },
    };
    let mut spread = Spread {
        self_id: Some("pdf-place".into()),
        item_transform: Some(IDENTITY),
        ..Spread::default()
    };
    let mut stories: Vec<ParsedStory> = Vec::new();
    let mut palette = Palette::new();
    let mut ids = IdGen::new();
    let mut losses: BTreeMap<&'static str, u32> = BTreeMap::new();
    for l in &page.losses {
        *losses.entry(l.code).or_default() += l.count;
    }
    let mut roots = {
        let mut low = Lowering::new(
            &mut spread,
            &mut stories,
            &mut palette,
            &mut ids,
            place,
            plan,
        );
        let mut roots = low.items(&page.items);
        roots.extend(low.remaining_text());
        for (code, n) in &low.losses {
            *losses.entry(code).or_default() += n;
        }
        roots
    };
    if roots.is_empty() {
        return Err(PlaceError::Empty);
    }
    let clipped = match &req.clip {
        Some(outline) if outline.len() >= 3 => {
            let anchors: Vec<PathAnchor> = outline
                .iter()
                .map(|p| PathAnchor {
                    anchor: (p[0], p[1]),
                    left: (p[0], p[1]),
                    right: (p[0], p[1]),
                })
                .collect();
            let (mut l, mut t, mut r, mut b) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
            for p in outline {
                l = l.min(p[0]);
                t = t.min(p[1]);
                r = r.max(p[0]);
                b = b.max(p[1]);
            }
            let poly = Polygon {
                item_transform: Some(IDENTITY),
                anchors,
                stroke_weight: Some(0.0),
                ..Polygon::new(
                    ids.id("pdfc"),
                    paged_model::Bounds {
                        top: t,
                        left: l,
                        bottom: b,
                        right: r,
                    },
                )
            };
            spread.polygons.push(poly);
            roots.push(FrameRef::Polygon(spread.polygons.len() - 1));
            true
        }
        _ => false,
    };
    if clipped || (req.group.unwrap_or(true) && roots.len() > 1) {
        let id = ids.id("pdfg");
        if let Some(name) = req.name.as_deref().filter(|n| !n.is_empty()) {
            spread.item_names.insert(id.clone(), name.to_string());
        }
        spread.groups.push(Group {
            self_id: Some(id),
            members: std::mem::take(&mut roots),
            item_transform: Some(IDENTITY),
            clip: clipped,
            ..Default::default()
        });
        roots = vec![FrameRef::Group(spread.groups.len() - 1)];
    }
    let bounds = bounds_of_refs(&spread, &roots).unwrap_or([0.0; 4]);
    spread.frames_in_order = roots;
    let counts = Counts {
        paths: spread.polygons.len(),
        images: spread.rectangles.len(),
        groups: spread.groups.len(),
        clip_groups: spread.groups.iter().filter(|g| g.clip).count(),
        text_frames: spread.text_frames.len(),
        opacity_masks: spread.opacity_masks.len(),
        gradients: palette.graphic.gradients.len(),
        colors: palette.graphic.colors.len(),
    };
    let text = stories
        .iter()
        .map(|s| {
            s.story
                .paragraphs
                .iter()
                .map(|p| p.runs.iter().map(|r| r.text.as_str()).collect::<String>())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    let snippet = ItemSnippet {
        format: SNIPPET_FORMAT.to_string(),
        spread,
        stories,
        hyperlinks: Vec::new(),
        bounds,
        page_origin: Some([0.0, 0.0]),
        page_id: None,
        resources: SnippetResources {
            colors: palette.graphic.colors,
            gradients: palette.graphic.gradients,
            ..Default::default()
        },
        text,
    };
    let snippet = serde_json::to_string(&snippet)
        .map_err(|e| PlaceError::Request(format!("the snippet does not encode: {e}")))?;
    Ok(PlaceResult {
        snippet,
        width_pt: page.width_pt,
        height_pt: page.height_pt,
        bounds,
        counts,
        losses: losses
            .into_iter()
            .map(|(code, count)| Loss { code, count })
            .collect(),
    })
}

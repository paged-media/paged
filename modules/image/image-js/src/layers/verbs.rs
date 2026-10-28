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

//! The Layer menu's verbs Photoshop has: fill layers, the blending
//! options, locks, labels and links; Merge Down, Merge Visible, Stamp
//! Visible, Flatten Image, Merge Group, Layer via Copy and Cut; layer comps;
//! moving, aligning and distributing layers.
//!
//! Every verb is ONE undo step ([`LayerStack::recorded`]): its snapshot
//! holds the layers' pixels by `Arc`, so a verb that replaces several
//! layers' pixels at once (a merge, a linked move, an align) costs the old
//! buffers' references, not copies — and undo puts every layer back
//! together.
//!
//! A MERGE is a composite of a few layers on their own: the verb builds a
//! stack of just those layers ([`LayerStack::sub_stack`]) and folds it on
//! the GPU like any other composite, so a merged layer looks exactly as
//! its parts did (blend modes, masks, clipping, blending options and all),
//! and no second blend path exists. Every GPU pass runs before the stack
//! changes, so a failure leaves it as it was.
//!
//! Layer via Copy and Cut, and the moves, are exact CPU byte work — an
//! alpha times a coverage, a whole-pixel translation — the same class of
//! work as a crop or the clip base's coverage product.

use std::sync::Arc;

use image_core::Region;
use image_gpu::{GpuContext, SelectionCoverage};
use image_graph::journal::TileJournal;
use image_kernels::families::compose::COMPOSE_NORMAL;

use super::{
    BlendIf, CompAppearance, CompEntry, FillLayer, FillSource, Knockout, Layer, LayerComp,
    LayerExt, LayerGroup, LayerKind, LayerLocks, LayerMask, LayerStack, BACKGROUND_LAYER_NAME,
    COLOR_LABELS,
};
use crate::ingest::IngestError;
use crate::pixels::Pixels;

/// Which edge or centre Align lines layers up on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AlignEdge {
    Left,
    HorizontalCenter,
    Right,
    Top,
    VerticalCenter,
    Bottom,
}

impl AlignEdge {
    pub fn from_wire(s: &str) -> Option<AlignEdge> {
        Some(match s {
            "left" => AlignEdge::Left,
            "hcenter" => AlignEdge::HorizontalCenter,
            "right" => AlignEdge::Right,
            "top" => AlignEdge::Top,
            "vcenter" => AlignEdge::VerticalCenter,
            "bottom" => AlignEdge::Bottom,
            _ => return None,
        })
    }
}

/// The axis Distribute spaces layers' centres along.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Axis {
    Horizontal,
    Vertical,
}

fn refuse(msg: impl Into<String>) -> IngestError {
    IngestError::Unsupported(msg.into())
}

/// `rgba` (straight, 8 or 16 bits) with each alpha multiplied by
/// `coverage` (one byte per pixel) — or by its complement.
fn alpha_times(px: &Pixels, coverage: &[u8], complement: bool) -> Pixels {
    let mut out = px.raw().to_vec();
    let bpp = px.bytes_per_pixel();
    for (i, &c) in coverage.iter().enumerate() {
        let c = u32::from(if complement { 255 - c } else { c });
        if bpp == 4 {
            let a = &mut out[i * 4 + 3];
            *a = ((u32::from(*a) * c + 127) / 255) as u8;
        } else {
            let at = i * 8 + 6;
            let a = u32::from(u16::from_ne_bytes([out[at], out[at + 1]]));
            let v = ((a * c + 127) / 255) as u16;
            out[at..at + 2].copy_from_slice(&v.to_ne_bytes());
        }
    }
    Pixels::from_raw(Arc::from(out.into_boxed_slice()), px.depth())
}

/// Does any pixel of `px` have alpha?
fn any_alpha(px: &Pixels) -> bool {
    let bpp = px.bytes_per_pixel();
    px.raw().chunks_exact(bpp).any(|p| {
        if bpp == 4 {
            p[3] != 0
        } else {
            p[6] != 0 || p[7] != 0
        }
    })
}

/// `src` (`w × h`, `bpp` bytes per pixel) moved by whole pixels; the area
/// it leaves takes `fill` (one pixel's bytes), or the nearest edge pixel
/// when `fill` is `None`.
fn shift(src: &[u8], w: u32, h: u32, bpp: usize, dx: i32, dy: i32, fill: Option<&[u8]>) -> Vec<u8> {
    let mut out = vec![0u8; src.len()];
    for y in 0..h as i64 {
        for x in 0..w as i64 {
            let (sx, sy) = (x - i64::from(dx), y - i64::from(dy));
            let d = (y as usize * w as usize + x as usize) * bpp;
            let inside = sx >= 0 && sy >= 0 && sx < i64::from(w) && sy < i64::from(h);
            match (inside, fill) {
                (true, _) | (false, None) => {
                    let (cx, cy) = (
                        sx.clamp(0, i64::from(w) - 1) as usize,
                        sy.clamp(0, i64::from(h) - 1) as usize,
                    );
                    let s = (cy * w as usize + cx) * bpp;
                    out[d..d + bpp].copy_from_slice(&src[s..s + bpp]);
                }
                (false, Some(f)) => out[d..d + bpp].copy_from_slice(f),
            }
        }
    }
    out
}

impl LayerStack {
    /// A stack of just `layers` (and `groups`) on this canvas, with no
    /// history — what a merge composites.
    pub(super) fn sub_stack(&self, layers: Vec<Layer>, groups: Vec<LayerGroup>) -> LayerStack {
        LayerStack {
            width: self.width,
            height: self.height,
            active: layers.len().saturating_sub(1),
            layers,
            groups,
            next_id: self.next_id,
            journal: TileJournal::new(),
            steps: Vec::new(),
            undone: Vec::new(),
            dropped_steps: 0,
            structure_generation: 0,
            edit_mask: false,
            fold: Default::default(),
            comps: Vec::new(),
            history_states: Default::default(),
            masking: Default::default(),
        }
    }

    /// A plain layer (normal, full opacity, unmasked) holding `px`.
    fn plain_layer(&mut self, name: String, px: Pixels, group: Option<u32>) -> Layer {
        Layer {
            kind: LayerKind::Pixels,
            id: self.fresh_id(),
            name,
            visible: true,
            locked: false,
            opacity: 1.0,
            blend: &COMPOSE_NORMAL,
            rgba: px.into(),
            mask: None,
            mask_enabled: true,
            group,
            clipped: false,
            blend_gamma: None,
            ext: LayerExt::default(),
        }
    }

    // ─────────────────────────── fill layers ───────────────────────────

    /// Layer ▸ New Fill Layer: a fill layer of `source` above the active
    /// layer, in its group, made active. Its render is due (stale) — the
    /// caller renders it ([`LayerStack::refresh_fills`]) or the next
    /// composite does. An empty `name` takes Photoshop's ("Color Fill 1").
    pub fn add_fill_layer(&mut self, name: &str, source: FillSource) -> usize {
        let name = if name.is_empty() {
            self.numbered(source.default_layer_name())
        } else {
            name.to_string()
        };
        let group = self.layers[self.active].group;
        let px = Pixels::from_rgba8(self.transparent());
        let mut layer = self.plain_layer(name, px, group);
        layer.kind = LayerKind::Fill(Box::new(FillLayer {
            source,
            stale: true,
        }));
        let at = self.active + 1;
        self.layers.insert(at, layer);
        self.active = at;
        self.edit_mask = false;
        at
    }

    /// Change a fill layer's source (its Properties); the render is due.
    pub fn set_fill(&mut self, index: usize, source: FillSource) -> Result<(), IngestError> {
        let layer = self.layer_mut(index)?;
        layer.appearance_editable()?;
        match &mut layer.kind {
            LayerKind::Fill(f) => {
                f.source = source;
                f.stale = true;
                Ok(())
            }
            _ => Err(refuse(format!("layer {index} is not a fill layer"))),
        }
    }

    /// Rasterize a fill layer: its render becomes pixels of its own.
    pub fn rasterize(&mut self, index: usize) -> Result<(), IngestError> {
        let layer = self.layer_mut(index)?;
        match &layer.kind {
            LayerKind::Fill(f) if f.stale => Err(refuse(
                "the fill layer is not rendered yet — composite first",
            )),
            LayerKind::Fill(_) | LayerKind::Smart(_) => {
                layer.kind = LayerKind::Pixels;
                Ok(())
            }
            _ => Err(refuse(format!(
                "layer {index} is not a fill layer or smart object"
            ))),
        }
    }

    // ───────────────────────── blending options ─────────────────────────

    /// Fill opacity, 0–1 (clamped).
    pub fn set_fill_opacity(&mut self, index: usize, fill: f32) -> Result<(), IngestError> {
        let layer = self.layer_mut(index)?;
        layer.appearance_editable()?;
        layer.ext.fill_opacity = if fill.is_finite() {
            fill.clamp(0.0, 1.0)
        } else {
            1.0
        };
        Ok(())
    }

    /// Blend If; `None` (or all sliders open) passes everything.
    pub fn set_blend_if(&mut self, index: usize, bi: Option<BlendIf>) -> Result<(), IngestError> {
        let layer = self.layer_mut(index)?;
        layer.appearance_editable()?;
        if layer.adjustment().is_some() && bi.is_some_and(|b| !b.is_open()) {
            return Err(refuse(
                "Blend If on an adjustment layer is not modelled (it has no pixels of its own \
                 for This Layer)",
            ));
        }
        layer.ext.blend_if = bi.filter(|b| !b.is_open()).map(Box::new);
        Ok(())
    }

    pub fn set_knockout(&mut self, index: usize, k: Knockout) -> Result<(), IngestError> {
        let layer = self.layer_mut(index)?;
        layer.appearance_editable()?;
        if k != Knockout::None && layer.adjustment().is_some() {
            return Err(refuse(
                "knockout needs pixels to cut with — an adjustment layer has none",
            ));
        }
        layer.ext.knockout = k;
        Ok(())
    }

    /// The four locks: image pixels (`Layer::locked`), transparency,
    /// position and all.
    pub fn set_locks(
        &mut self,
        index: usize,
        pixels: bool,
        locks: LayerLocks,
    ) -> Result<(), IngestError> {
        let layer = self.layer_mut(index)?;
        layer.locked = pixels;
        layer.ext.locks = locks;
        Ok(())
    }

    /// The colour label (an index into [`COLOR_LABELS`]).
    pub fn set_color(&mut self, index: usize, color: u8) -> Result<(), IngestError> {
        if usize::from(color) >= COLOR_LABELS.len() {
            return Err(refuse(format!("colour label {color} (0–7)")));
        }
        self.layer_mut(index)?.ext.color = color;
        Ok(())
    }

    pub fn set_group_color(&mut self, id: u32, color: u8) -> Result<(), IngestError> {
        if usize::from(color) >= COLOR_LABELS.len() {
            return Err(refuse(format!("colour label {color} (0–7)")));
        }
        let g = self
            .groups
            .iter_mut()
            .find(|g| g.id == id)
            .ok_or_else(|| refuse(format!("unknown group {id}")))?;
        g.color = color;
        Ok(())
    }

    // ─────────────────────────────── links ───────────────────────────────

    /// LINK `indices` (two or more): they move together. A layer already
    /// linked brings its links along, so linking is transitive. Returns
    /// the link.
    pub fn link(&mut self, indices: &[usize]) -> Result<u32, IngestError> {
        if indices.len() < 2 {
            return Err(refuse("link needs two layers or more"));
        }
        for &i in indices {
            self.layer_mut(i)?;
        }
        let existing: Vec<u32> = indices
            .iter()
            .filter_map(|&i| self.layers[i].ext.link)
            .collect();
        let id = existing.first().copied().unwrap_or_else(|| self.fresh_id());
        for l in &mut self.layers {
            if l.ext.link.is_some_and(|k| existing.contains(&k)) {
                l.ext.link = Some(id);
            }
        }
        for &i in indices {
            self.layers[i].ext.link = Some(id);
        }
        Ok(id)
    }

    /// Unlink `index`; a link left with one member dissolves.
    pub fn unlink(&mut self, index: usize) -> Result<(), IngestError> {
        let Some(id) = self.layer_mut(index)?.ext.link.take() else {
            return Ok(());
        };
        let left: Vec<usize> = self.linked(id);
        if left.len() == 1 {
            self.layers[left[0]].ext.link = None;
        }
        Ok(())
    }

    /// The indices of link `id`'s members.
    pub fn linked(&self, id: u32) -> Vec<usize> {
        (0..self.layers.len())
            .filter(|&i| self.layers[i].ext.link == Some(id))
            .collect()
    }

    /// `index` and every layer linked with it.
    pub fn with_links(&self, index: usize) -> Vec<usize> {
        match self.layers.get(index).and_then(|l| l.ext.link) {
            Some(id) => self.linked(id),
            None => vec![index],
        }
    }

    // ─────────────────────────────── merges ───────────────────────────────

    /// MERGE DOWN: the active layer composited onto the one beneath it,
    /// which keeps its name, opacity, mode and place. The lower layer's
    /// mask and fill opacity are applied into the result.
    pub async fn merge_down(&mut self, ctx: Option<&GpuContext>) -> Result<usize, IngestError> {
        let up = self.active;
        if up == 0 {
            return Err(refuse("there is no layer below to merge into"));
        }
        let lo = up - 1;
        let (u, l) = (&self.layers[up], &self.layers[lo]);
        if u.group != l.group {
            return Err(refuse(
                "the layer below is in another group — Merge Group merges a group",
            ));
        }
        if !l.is_pixels() {
            return Err(refuse(format!(
                "\"{}\" is an adjustment layer; merge onto a layer with pixels",
                l.name
            )));
        }
        l.pixels_editable()?;
        if !u.visible {
            return Err(refuse(format!(
                "\"{}\" is hidden; show it to merge it down",
                u.name
            )));
        }
        let mut base = l.clone();
        base.visible = true;
        base.opacity = 1.0;
        base.blend = &COMPOSE_NORMAL;
        base.clipped = false;
        base.group = None;
        base.kind = LayerKind::Pixels;
        base.ext = LayerExt {
            fill_opacity: l.ext.fill_opacity,
            ..LayerExt::default()
        };
        let mut top = u.clone();
        top.group = None;
        let px = self
            .sub_stack(vec![base, top], Vec::new())
            .composite(ctx, None)
            .await?;
        self.recorded("Merge Down", None, move |s| {
            let merged = &mut s.layers[lo];
            merged.rgba = Pixels::from_rgba8(px).into();
            merged.kind = LayerKind::Pixels;
            merged.mask = None;
            merged.mask_enabled = true;
            merged.ext.fill_opacity = 1.0;
            merged.ext.blend_if = None;
            merged.ext.knockout = Knockout::None;
            s.layers.remove(up);
            s.active = lo;
            s.edit_mask = false;
            Ok(lo)
        })
    }

    /// The indices of the layers the composite shows (visible, in visible
    /// groups).
    fn shown(&self) -> Vec<usize> {
        (0..self.layers.len())
            .filter(|&i| {
                let l = &self.layers[i];
                l.visible
                    && self
                        .chain_of(l.group)
                        .iter()
                        .all(|g| self.groups.iter().any(|x| x.id == *g && x.visible))
            })
            .collect()
    }

    /// Drop groups with no member layer left (nor a member group that
    /// has one).
    fn prune_groups(&mut self) {
        loop {
            let used: Vec<u32> = self
                .layers
                .iter()
                .filter_map(|l| l.group)
                .chain(self.groups.iter().filter_map(|g| g.parent))
                .collect();
            let before = self.groups.len();
            self.groups.retain(|g| used.contains(&g.id));
            if self.groups.len() == before {
                break;
            }
        }
    }

    /// Where a top-level layer can go at or below `at` without splitting a
    /// group's contiguous run.
    fn top_level_slot(&self, mut at: usize) -> usize {
        while at > 0 && at < self.layers.len() {
            let (below, above) = (
                self.chain_of(self.layers[at - 1].group),
                self.chain_of(self.layers[at].group),
            );
            match (below.first(), above.first()) {
                (Some(a), Some(b)) if a == b => at -= 1,
                _ => break,
            }
        }
        at
    }

    /// MERGE VISIBLE: every shown layer becomes one pixel layer (the
    /// composite), placed where the lowest of them was; hidden layers stay.
    pub async fn merge_visible(&mut self, ctx: Option<&GpuContext>) -> Result<usize, IngestError> {
        let shown = self.shown();
        if shown.len() < 2 {
            return Err(refuse("Merge Visible needs two visible layers or more"));
        }
        let px = self.composite(ctx, None).await?;
        self.recorded("Merge Visible", None, move |s| {
            let name = s.layers[shown[0]].name.clone();
            let below = shown[0];
            let mut keep = Vec::with_capacity(s.layers.len());
            for (i, l) in std::mem::take(&mut s.layers).into_iter().enumerate() {
                if !shown.contains(&i) {
                    keep.push((i, l));
                }
            }
            let at = keep.iter().filter(|(i, _)| *i < below).count();
            s.layers = keep.into_iter().map(|(_, l)| l).collect();
            let at = s.top_level_slot(at);
            let layer = s.plain_layer(name, Pixels::from_rgba8(px), None);
            s.layers.insert(at, layer);
            s.prune_groups();
            s.active = at;
            s.edit_mask = false;
            Ok(at)
        })
    }

    /// STAMP VISIBLE: a new layer above the active one holding the
    /// composite; nothing else changes.
    pub async fn stamp_visible(&mut self, ctx: Option<&GpuContext>) -> Result<usize, IngestError> {
        let px = self.composite(ctx, None).await?;
        self.recorded("Stamp Visible", None, move |s| {
            let group = s.layers[s.active].group;
            let name = s.numbered("Layer");
            let layer = s.plain_layer(name, Pixels::from_rgba8(px), group);
            let at = s.active + 1;
            s.layers.insert(at, layer);
            s.active = at;
            s.edit_mask = false;
            Ok(at)
        })
    }

    /// FLATTEN IMAGE: one opaque Background layer — the composite over
    /// white, as Photoshop's flatten fills transparency with white.
    /// Hidden layers are discarded.
    pub async fn flatten(&mut self, ctx: Option<&GpuContext>) -> Result<(), IngestError> {
        let composite = self.composite(ctx, None).await?;
        let white = Pixels::from_rgba8(Arc::from(
            vec![255u8; self.width as usize * self.height as usize * 4].into_boxed_slice(),
        ));
        let mut tmp = self.sub_stack(Vec::new(), Vec::new());
        let under = tmp.plain_layer("white".into(), white, None);
        let over = tmp.plain_layer("image".into(), Pixels::from_rgba8(composite), None);
        tmp.layers = vec![under, over];
        let px = tmp.composite(ctx, None).await?;
        self.recorded("Flatten Image", None, move |s| {
            let layer = s.plain_layer(BACKGROUND_LAYER_NAME.into(), Pixels::from_rgba8(px), None);
            s.layers = vec![layer];
            s.groups.clear();
            s.active = 0;
            s.edit_mask = false;
            Ok(())
        })
    }

    /// The contiguous run of layers inside group `gid` (nested included).
    fn group_run(&self, gid: u32) -> Option<(usize, usize)> {
        let inside: Vec<usize> = (0..self.layers.len())
            .filter(|&i| self.chain_of(self.layers[i].group).contains(&gid))
            .collect();
        Some((*inside.first()?, *inside.last()?))
    }

    /// MERGE GROUP: the group's members, composited on their own, become
    /// one pixel layer that takes the group's place, name, opacity, mode,
    /// mask, visibility and label.
    pub async fn merge_group(
        &mut self,
        gid: u32,
        ctx: Option<&GpuContext>,
    ) -> Result<usize, IngestError> {
        let g = self
            .groups
            .iter()
            .find(|g| g.id == gid)
            .cloned()
            .ok_or_else(|| refuse(format!("unknown group {gid}")))?;
        let Some((lo, hi)) = self.group_run(gid) else {
            return Err(refuse(format!("group \"{}\" has no layers", g.name)));
        };
        if let Some(l) = self.layers[lo..=hi]
            .iter()
            .find(|l| l.locked || l.ext.locks.all)
        {
            return Err(refuse(format!("layer \"{}\" is locked", l.name)));
        }
        // The members and their groups, the merged group neutral (its own
        // opacity, mode and mask go onto the merged layer instead).
        let inner: Vec<u32> = self
            .groups
            .iter()
            .filter(|x| self.chain_of(Some(x.id)).contains(&gid))
            .map(|x| x.id)
            .collect();
        let mut groups: Vec<LayerGroup> = self
            .groups
            .iter()
            .filter(|x| inner.contains(&x.id))
            .cloned()
            .collect();
        for x in &mut groups {
            if x.id == gid {
                x.parent = None;
                x.visible = true;
                x.opacity = 1.0;
                x.blend = &COMPOSE_NORMAL;
                x.pass_through = false;
                x.mask = None;
            }
        }
        let members: Vec<Layer> = self.layers[lo..=hi].to_vec();
        let px = self.sub_stack(members, groups).composite(ctx, None).await?;
        self.recorded("Merge Group", None, move |s| {
            let mut layer = s.plain_layer(g.name.clone(), Pixels::from_rgba8(px), g.parent);
            layer.visible = g.visible;
            layer.opacity = g.opacity;
            if !g.pass_through {
                layer.blend = g.blend;
            }
            layer.mask = g.mask.clone().map(LayerMask::Canvas);
            layer.mask_enabled = g.mask_enabled;
            layer.ext.color = g.color;
            s.layers.splice(lo..=hi, std::iter::once(layer));
            s.groups.retain(|x| !inner.contains(&x.id));
            s.active = lo;
            s.edit_mask = false;
            Ok(lo)
        })
    }

    /// LAYER VIA COPY (`cut == false`) or VIA CUT: the active layer's
    /// pixels inside `selection` become a new layer above it; a cut also
    /// takes them out of the active layer.
    pub fn layer_via(
        &mut self,
        selection: &SelectionCoverage,
        cut: bool,
    ) -> Result<usize, IngestError> {
        let (w, h) = (self.width, self.height);
        if selection.width() != w || selection.height() != h {
            return Err(refuse("the selection does not match the canvas"));
        }
        let src = &self.layers[self.active];
        if !src.is_pixels() {
            return Err(refuse(format!(
                "\"{}\" is an adjustment layer — it has no pixels to copy",
                src.name
            )));
        }
        if cut {
            src.pixels_editable()?;
            if !matches!(src.kind, LayerKind::Pixels) {
                return Err(refuse(format!(
                    "\"{}\" is a fill layer or smart object — rasterize it to cut from it",
                    src.name
                )));
            }
        }
        let px = src.rgba.canvas().clone();
        let copy = alpha_times(&px, selection.data(), false);
        if !any_alpha(&copy) {
            return Err(refuse("the selected area of this layer is empty"));
        }
        let rest = cut.then(|| alpha_times(&px, selection.data(), true));
        let label = if cut {
            "Layer via Cut"
        } else {
            "Layer via Copy"
        };
        self.recorded(label, None, move |s| {
            let i = s.active;
            if let Some(rest) = rest {
                s.layers[i].rgba = rest.into();
            }
            let group = s.layers[i].group;
            let name = s.numbered("Layer");
            let layer = s.plain_layer(name, copy, group);
            s.layers.insert(i + 1, layer);
            s.active = i + 1;
            s.edit_mask = false;
            Ok(i + 1)
        })
    }

    // ───────────────────────────── layer comps ─────────────────────────────

    fn comp_entries(&self, position: bool, appearance: bool) -> Vec<CompEntry> {
        self.layers
            .iter()
            .map(|l| CompEntry {
                id: l.id,
                visible: l.visible,
                // Only a layer of pixels of its own has a position apart
                // from a source (a fill or smart object re-renders).
                pixels: (position && matches!(l.kind, LayerKind::Pixels)).then(|| l.rgba.clone()),
                appearance: appearance.then(|| CompAppearance {
                    opacity: l.opacity,
                    fill_opacity: l.ext.fill_opacity,
                    blend: l.blend,
                    blend_if: l.ext.blend_if.clone(),
                    knockout: l.ext.knockout,
                }),
            })
            .collect()
    }

    /// The layer comps, in the panel's order.
    pub fn comps(&self) -> &[LayerComp] {
        &self.comps
    }

    /// NEW LAYER COMP: record what `visibility`, `position` and
    /// `appearance` say of every layer now. Returns its id.
    pub fn new_comp(
        &mut self,
        name: &str,
        visibility: bool,
        position: bool,
        appearance: bool,
    ) -> u32 {
        let id = self.fresh_id();
        let name = if name.is_empty() {
            format!("Layer Comp {}", self.comps.len() + 1)
        } else {
            name.to_string()
        };
        let entries = self.comp_entries(position, appearance);
        self.comps.push(LayerComp {
            id,
            name,
            visibility,
            position,
            appearance,
            entries,
        });
        id
    }

    fn comp_index(&self, id: u32) -> Result<usize, IngestError> {
        self.comps
            .iter()
            .position(|c| c.id == id)
            .ok_or_else(|| refuse(format!("unknown layer comp {id}")))
    }

    /// UPDATE: record the layers again, with the comp's own options.
    pub fn update_comp(&mut self, id: u32) -> Result<(), IngestError> {
        let k = self.comp_index(id)?;
        let (p, a) = (self.comps[k].position, self.comps[k].appearance);
        self.comps[k].entries = self.comp_entries(p, a);
        Ok(())
    }

    /// APPLY: put back what the comp recorded, for every layer it knows;
    /// layers added since stay as they are. A recorded position whose
    /// extent no longer fits is skipped.
    pub fn apply_comp(&mut self, id: u32) -> Result<(), IngestError> {
        let comp = self.comps[self.comp_index(id)?].clone();
        let (w, h) = (self.width as usize, self.height as usize);
        for e in &comp.entries {
            let Some(l) = self.layers.iter_mut().find(|l| l.id == e.id) else {
                continue;
            };
            if comp.visibility {
                l.visible = e.visible;
            }
            if let Some(px) = e.pixels.as_ref().filter(|_| comp.position) {
                let fits = px.canvas().pixel_count() == w * h;
                if fits && matches!(l.kind, LayerKind::Pixels) {
                    l.rgba = px.clone();
                }
            }
            if let Some(a) = e.appearance.as_ref().filter(|_| comp.appearance) {
                l.opacity = a.opacity;
                l.ext.fill_opacity = a.fill_opacity;
                l.blend = a.blend;
                l.ext.blend_if = a.blend_if.clone();
                l.ext.knockout = a.knockout;
            }
        }
        Ok(())
    }

    pub fn delete_comp(&mut self, id: u32) -> Result<(), IngestError> {
        let k = self.comp_index(id)?;
        self.comps.remove(k);
        Ok(())
    }

    pub fn rename_comp(&mut self, id: u32, name: &str) -> Result<(), IngestError> {
        let k = self.comp_index(id)?;
        self.comps[k].name = name.to_string();
        Ok(())
    }

    // ─────────────────────── move, align, distribute ───────────────────────

    /// The bounding box of the pixels `index` shows (alpha above zero, or
    /// for an adjustment layer its mask's coverage); `None` when empty.
    pub fn content_bounds(&self, index: usize) -> Option<Region> {
        let l = self.layers.get(index)?;
        let (w, h) = (self.width as usize, self.height as usize);
        let px = l.rgba.canvas();
        let bpp = px.bytes_per_pixel();
        let raw = px.raw();
        let hit = |i: usize| -> bool {
            if l.adjustment().is_some() {
                return l
                    .mask
                    .as_ref()
                    .is_none_or(|m| m.at((i % w) as u32, (i / w) as u32) > 0);
            }
            if bpp == 4 {
                raw[i * 4 + 3] != 0
            } else {
                raw[i * 8 + 6] != 0 || raw[i * 8 + 7] != 0
            }
        };
        let (mut x0, mut y0, mut x1, mut y1) = (usize::MAX, usize::MAX, 0usize, 0usize);
        for y in 0..h {
            for x in 0..w {
                if hit(y * w + x) {
                    x0 = x0.min(x);
                    y0 = y0.min(y);
                    x1 = x1.max(x);
                    y1 = y1.max(y);
                }
            }
        }
        (x0 != usize::MAX).then(|| {
            Region::new(
                x0 as i32,
                y0 as i32,
                (x1 - x0 + 1) as u32,
                (y1 - y0 + 1) as u32,
            )
        })
    }

    /// Move `index` by whole pixels (exact): its pixels and mask move
    /// together; a gradient fill's offset follows; an adjustment layer's
    /// mask moves. A smart object does not (its render follows its
    /// source).
    fn translate_one(&mut self, index: usize, dx: i32, dy: i32) -> Result<(), IngestError> {
        let (w, h) = (self.width, self.height);
        let l = &self.layers[index];
        l.position_editable()?;
        if l.smart_source().is_some() {
            return Err(refuse(format!(
                "\"{}\" is a smart object, which is not moved by whole pixels",
                l.name
            )));
        }
        let mask = l.mask.as_ref().map(|m| {
            let c = m.to_canvas();
            let data = shift(c.data(), w, h, 1, dx, dy, None);
            SelectionCoverage::from_data(w, h, data).map(|c| LayerMask::Canvas(Arc::new(c)))
        });
        let l = &mut self.layers[index];
        if let Some(m) = mask {
            l.mask = m;
        }
        // A LINKED vector mask moves with its layer (a shape layer's
        // shape is its vector mask, so this is what moves a shape).
        if l.ext.vector_mask.as_ref().is_some_and(|v| !v.not_linked) {
            let (fx, fy) = (dx as f32, dy as f32);
            crate::layers::follow_vector_mask(l, |p| [p[0] + fx, p[1] + fy], w, h);
        }
        match &mut l.kind {
            LayerKind::Pixels => {
                let px = l.rgba.canvas().clone();
                let bpp = px.bytes_per_pixel();
                let clear = vec![0u8; bpp];
                let moved = shift(px.raw(), w, h, bpp, dx, dy, Some(&clear));
                l.rgba = Pixels::from_raw(Arc::from(moved.into_boxed_slice()), px.depth()).into();
            }
            LayerKind::Fill(f) => {
                if let FillSource::Gradient(g) = &mut f.source {
                    g.offset.0 += dx as f32 / w as f32 * 100.0;
                    g.offset.1 += dy as f32 / h as f32 * 100.0;
                    f.stale = true;
                }
            }
            LayerKind::Adjustment(_) | LayerKind::Smart(_) => {}
        }
        Ok(())
    }

    /// Move `indices` by whole pixels, together. Answers whether anything
    /// moved.
    pub fn translate(&mut self, indices: &[usize], dx: i32, dy: i32) -> Result<bool, IngestError> {
        for &i in indices {
            self.layer_mut(i)?.position_editable()?;
        }
        if dx == 0 && dy == 0 {
            return Ok(false);
        }
        for &i in indices {
            self.translate_one(i, dx, dy)?;
        }
        Ok(true)
    }

    /// ALIGN `indices` on `edge` of `to` (the selection, or the canvas):
    /// each layer's content box moves onto it. Layers with no content stay.
    /// Answers whether anything moved.
    pub fn align(
        &mut self,
        indices: &[usize],
        edge: AlignEdge,
        to: Region,
    ) -> Result<bool, IngestError> {
        for &i in indices {
            self.layer_mut(i)?.position_editable()?;
        }
        let mut moved = false;
        for &i in indices {
            let Some(b) = self.content_bounds(i) else {
                continue;
            };
            let (dx, dy) = match edge {
                AlignEdge::Left => (to.x - b.x, 0),
                AlignEdge::Right => ((to.x + to.w as i32) - (b.x + b.w as i32), 0),
                AlignEdge::HorizontalCenter => {
                    ((to.x * 2 + to.w as i32 - b.x * 2 - b.w as i32) / 2, 0)
                }
                AlignEdge::Top => (0, to.y - b.y),
                AlignEdge::Bottom => (0, (to.y + to.h as i32) - (b.y + b.h as i32)),
                AlignEdge::VerticalCenter => {
                    (0, (to.y * 2 + to.h as i32 - b.y * 2 - b.h as i32) / 2)
                }
            };
            if dx != 0 || dy != 0 {
                self.translate_one(i, dx, dy)?;
                moved = true;
            }
        }
        Ok(moved)
    }

    /// DISTRIBUTE the centres of three or more layers evenly between the
    /// outermost two, along `axis`.
    pub fn distribute(&mut self, indices: &[usize], axis: Axis) -> Result<bool, IngestError> {
        let mut boxes: Vec<(usize, Region)> = indices
            .iter()
            .filter_map(|&i| self.content_bounds(i).map(|b| (i, b)))
            .collect();
        if boxes.len() < 3 {
            return Err(refuse("Distribute needs three layers with pixels or more"));
        }
        for (i, _) in &boxes {
            self.layers[*i].position_editable()?;
        }
        let centre = |b: &Region| match axis {
            Axis::Horizontal => b.x as f32 + b.w as f32 / 2.0,
            Axis::Vertical => b.y as f32 + b.h as f32 / 2.0,
        };
        boxes.sort_by(|a, b| centre(&a.1).total_cmp(&centre(&b.1)));
        let (first, last) = (centre(&boxes[0].1), centre(&boxes[boxes.len() - 1].1));
        let step = (last - first) / (boxes.len() - 1) as f32;
        let mut moved = false;
        for (k, (i, b)) in boxes.iter().enumerate() {
            let d = (first + step * k as f32 - centre(b)).round() as i32;
            let (dx, dy) = match axis {
                Axis::Horizontal => (d, 0),
                Axis::Vertical => (0, d),
            };
            if d != 0 {
                self.translate_one(*i, dx, dy)?;
                moved = true;
            }
        }
        Ok(moved)
    }
}

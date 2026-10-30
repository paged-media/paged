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

//! SMART OBJECTS in full (image ADR 482): a smart object is a SOURCE (a
//! file — embedded, linked, or the pixels a layer was converted from, or
//! page items drawn by the host), a PLACEMENT (the four corners the
//! source's rectangle lands on) and an optional stack of SMART FILTERS
//! with a filter mask. The layer's pixels are only the render of the
//! three, made again whenever one of them changes:
//!
//! 1. the source is decoded (once, and cached with the file);
//! 2. it is drawn through the placement's homography on the CPU
//!    ([`render_placed`]: Lanczos-reduced first when the placement
//!    shrinks it, then the bicubic projective warp of `paged-resample`);
//! 3. the filters run over that render on the GPU, driven by the bundle
//!    through the same catalogue the Filter dialog runs
//!    (`glue/src/smart-filters.ts`), and land through the filter mask.
//!
//! Nothing here touches the source: a transform, a scale down and up
//! again, or a filter edit re-renders from it, so nothing is lost.

use std::sync::{Arc, OnceLock};

use image_core::Region;
use image_psd::descriptor::build::{desc, key};
use image_psd::descriptor::DescriptorValue;
use image_psd::model::PsdFile;
use image_psd::smart_object::{
    parse_linked_files, quad_bounds, FilterEffects, LinkKind, LinkedFile, PlacedLayer, SmartFilter,
    SmartFilters, FILTER_EFFECTS_KEYS, LINKED_KEYS,
};
use image_psd::Container;
use paged_resample::{resize_rgba8, warp_projective_rgba8, Filter, WarpFilter, Window};

use crate::ingest::IngestError;
use crate::layers::mask::BoundedMask;
use crate::layers::LayerMask;
use crate::pixels::{LayerPixels, Pixels};

/// Four corners `[x0, y0, x1, y1, x2, y2, x3, y3]` — top-left, top-right,
/// bottom-right, bottom-left of the source — in canvas pixels.
pub type Quad = image_psd::smart_object::Quad;

/// A decoded source.
#[derive(Debug)]
pub struct SourceRaster {
    pub width: u32,
    pub height: u32,
    /// Straight RGBA8.
    pub rgba: Arc<[u8]>,
}

/// The file behind a smart object: embedded bytes, or a link.
#[derive(Debug)]
pub struct SmartFile {
    /// The uuid a PSD placed-layer record names (`Idnt`).
    pub uuid: String,
    /// The file's own name (`art.psb`).
    pub name: String,
    /// `8BPB`, `8BPS`, `png `, …
    pub file_type: [u8; 4],
    /// The file's bytes; empty for a link whose file is not at hand.
    pub bytes: Arc<[u8]>,
    /// A LINKED smart object: the path the link names.
    pub link: Option<String>,
    /// The PSD entry it was read from — written back byte for byte while
    /// the bytes are unchanged.
    pub entry: Option<LinkedFile>,
    raster: OnceLock<Result<Arc<SourceRaster>, String>>,
}

impl SmartFile {
    pub fn new(
        uuid: impl Into<String>,
        name: impl Into<String>,
        file_type: [u8; 4],
        bytes: Arc<[u8]>,
        link: Option<String>,
    ) -> Self {
        Self {
            uuid: uuid.into(),
            name: name.into(),
            file_type,
            bytes,
            link,
            entry: None,
            raster: OnceLock::new(),
        }
    }

    /// The same file with its decode already known (the caller decoded
    /// it, or holds the pixels it encodes).
    pub fn with_raster(self, raster: SourceRaster) -> Self {
        let _ = self.raster.set(Ok(Arc::new(raster)));
        self
    }

    /// Is the source at hand (embedded, or a link whose file was read)?
    pub fn is_available(&self) -> bool {
        !self.bytes.is_empty() || matches!(self.raster.get(), Some(Ok(_)))
    }

    /// The source decoded to straight RGBA8 — once; every later call
    /// shares the decode.
    pub fn raster(&self) -> Result<Arc<SourceRaster>, IngestError> {
        self.raster
            .get_or_init(|| {
                if self.bytes.is_empty() {
                    return Err(match &self.link {
                        Some(p) => format!("the linked file \"{p}\" is missing (relink it)"),
                        None => format!("the smart object \"{}\" has no source", self.name),
                    });
                }
                if let Some(r) = psd_without_composite(&self.bytes)? {
                    return Ok(Arc::new(r));
                }
                let img = crate::ingest::decode_rgba8(&self.bytes).map_err(|e| e.to_string())?;
                Ok(Arc::new(SourceRaster {
                    width: img.width,
                    height: img.height,
                    rgba: img.rgba.to_rgba8().into_owned().into(),
                }))
            })
            .clone()
            .map_err(IngestError::Unsupported)
    }
}

/// The contents of a PSD/PSB saved WITHOUT a real merged composite — what
/// Photoshop embeds in a new smart object (its composite is a white
/// placeholder [OBS]) — flattened from its layers on the CPU. Only a plain
/// stack is flattened here: pixel layers in Normal mode, with opacity and
/// user masks, no groups, effects, clipping or adjustments (a richer one
/// needs the GPU fold: Edit Contents opens and saves it, which writes a
/// real composite). `Ok(None)`: not a PSD, or its composite is real.
fn psd_without_composite(bytes: &[u8]) -> Result<Option<SourceRaster>, String> {
    if paged_raster::sniff(bytes) != Some(paged_raster::Format::Psd) {
        return Ok(None);
    }
    let file = PsdFile::parse(bytes).map_err(|e| e.to_string())?;
    if file.merged_data() == image_psd::composite::MergedData::Real
        || file.layer_mask.layers.is_empty()
    {
        return Ok(None);
    }
    let import = file.layer_plates_rgba8().map_err(|e| e.to_string())?;
    let (w, h) = (import.width as usize, import.height as usize);
    let mut acc = vec![0f32; w * h * 4];
    for p in &import.layers {
        if p.hidden {
            continue;
        }
        if &p.blend_key != b"norm"
            || p.adjustment.is_some()
            || p.style.is_some()
            || p.clipped
            || p.group.is_some()
            || p.vector_mask.is_some()
        {
            return Err(format!(
                "the contents' layer \"{}\" needs the GPU fold to flatten (no merged composite)",
                p.name
            ));
        }
        let r = p.rect.unwrap_or(Region::new(0, 0, w as u32, h as u32));
        let op = f32::from(p.opacity) / 255.0;
        let mask = p.mask.as_ref().filter(|m| m.enabled);
        for y in 0..r.h as usize {
            for x in 0..r.w as usize {
                let (cx, cy) = (r.x as usize + x, r.y as usize + y);
                if cx >= w || cy >= h {
                    continue;
                }
                let s = &p.rgba[(y * r.w as usize + x) * 4..][..4];
                let mut a = f32::from(s[3]) / 255.0 * op;
                if let Some(m) = mask {
                    let mv = match m.rect {
                        Some(mr) => {
                            let (mx, my) =
                                (cx as i64 - i64::from(mr.x), cy as i64 - i64::from(mr.y));
                            if mx >= 0 && my >= 0 && (mx as u32) < mr.w && (my as u32) < mr.h {
                                m.coverage[my as usize * mr.w as usize + mx as usize]
                            } else {
                                255
                            }
                        }
                        None => m.coverage[cy * w + cx],
                    };
                    a *= f32::from(mv) / 255.0;
                }
                let d = &mut acc[(cy * w + cx) * 4..][..4];
                for c in 0..3 {
                    d[c] = f32::from(s[c]) / 255.0 * a + d[c] * (1.0 - a);
                }
                d[3] = a + d[3] * (1.0 - a);
            }
        }
    }
    let mut rgba = vec![0u8; w * h * 4];
    for (o, d) in rgba
        .as_chunks_mut::<4>()
        .0
        .iter_mut()
        .zip(acc.as_chunks::<4>().0.iter())
    {
        if d[3] <= 0.0 {
            continue;
        }
        for c in 0..3 {
            o[c] = (d[c] / d[3] * 255.0).round().clamp(0.0, 255.0) as u8;
        }
        o[3] = (d[3] * 255.0).round().clamp(0.0, 255.0) as u8;
    }
    Ok(Some(SourceRaster {
        width: w as u32,
        height: h as u32,
        rgba: rgba.into(),
    }))
}

/// A VECTOR smart object's source: page items the host renders
/// (`host.render.element`, `render.snapshot@2`), rasterised at the
/// resolution the placement needs and again when it grows.
#[derive(Debug, Clone, PartialEq)]
pub struct VectorSource {
    /// The items, in the host's addressing.
    pub items: Vec<String>,
    /// The items' bounds on their page, in pt (`x, y, w, h`).
    pub region: [f64; 4],
    /// Pixels per pt the current source was rendered at.
    pub px_per_pt: f64,
}

// ───────────────────────────── placement ───────────────────────────────

/// The rectangle `x, y, w, h` as a quad.
pub fn rect_quad(x: f64, y: f64, w: f64, h: f64) -> Quad {
    [x, y, x + w, y, x + w, y + h, x, y + h]
}

/// The homography taking the `w × h` source rectangle onto `q`.
pub fn homography(w: f64, h: f64, q: &Quad) -> Option<paged_warp::Homography> {
    paged_warp::from_quads(
        [(0.0, 0.0), (w, 0.0), (w, h), (0.0, h)],
        [(q[0], q[1]), (q[2], q[3]), (q[4], q[5]), (q[6], q[7])],
    )
}

/// `q` mapped through `f` corner by corner.
pub fn map_quad(q: &Quad, f: impl Fn((f64, f64)) -> (f64, f64)) -> Quad {
    let mut out = [0.0; 8];
    for i in 0..4 {
        let (x, y) = f((q[2 * i], q[2 * i + 1]));
        out[2 * i] = x;
        out[2 * i + 1] = y;
    }
    out
}

/// The scale a placement draws the source at along each of its axes
/// (the longer of each pair of opposite edges over the source's side).
pub fn quad_scale(w: f64, h: f64, q: &Quad) -> (f64, f64) {
    let len = |a: usize, b: usize| (q[2 * b] - q[2 * a]).hypot(q[2 * b + 1] - q[2 * a + 1]);
    let sx = len(0, 1).max(len(3, 2)) / w.max(1.0);
    let sy = len(0, 3).max(len(1, 2)) / h.max(1.0);
    (sx, sy)
}

/// The canvas window a placement covers (its bounding box, grown to
/// whole pixels, clipped to the canvas); `None` when it misses the canvas.
pub fn quad_window(q: &Quad, cw: u32, ch: u32) -> Option<Region> {
    let (l, t, r, b) = quad_bounds(q);
    if !(l.is_finite() && t.is_finite() && r.is_finite() && b.is_finite()) {
        return None;
    }
    let x0 = l.floor().max(0.0);
    let y0 = t.floor().max(0.0);
    let x1 = r.ceil().min(f64::from(cw));
    let y1 = b.ceil().min(f64::from(ch));
    (x1 > x0 && y1 > y0)
        .then(|| Region::new(x0 as i32, y0 as i32, (x1 - x0) as u32, (y1 - y0) as u32))
}

/// The rectangle of a `w`-wide straight RGBA8 picture that is not
/// transparent, or `None` when all of it is.
pub fn opaque_bounds(px: &[u8], w: u32, h: u32) -> Option<Region> {
    let (mut x0, mut y0, mut x1, mut y1) = (u32::MAX, u32::MAX, 0u32, 0u32);
    for y in 0..h {
        for x in 0..w {
            if px[((y * w + x) * 4 + 3) as usize] != 0 {
                x0 = x0.min(x);
                y0 = y0.min(y);
                x1 = x1.max(x + 1);
                y1 = y1.max(y + 1);
            }
        }
    }
    (x1 > x0).then(|| Region::new(x0 as i32, y0 as i32, x1 - x0, y1 - y0))
}

/// The `r` window of a `w`-wide straight RGBA8 picture.
pub fn crop_rgba8(px: &[u8], w: u32, r: Region) -> Vec<u8> {
    let mut out = Vec::with_capacity(r.w as usize * r.h as usize * 4);
    for y in 0..r.h {
        let from = (((r.y as u32 + y) * w + r.x as u32) * 4) as usize;
        out.extend_from_slice(&px[from..from + r.w as usize * 4]);
    }
    out
}

/// Below this scale a placement is drawn from a Lanczos-reduced copy of
/// the source, so the bicubic's taps do not alias.
const REDUCE_BELOW: f64 = 0.8;

/// DRAW a source into its placement on a `cw × ch` canvas: the layer's
/// pixels, bounded to the window the placement covers (ADR 464).
pub fn render_placed(
    raster: &SourceRaster,
    q: &Quad,
    cw: u32,
    ch: u32,
) -> Result<LayerPixels, IngestError> {
    let empty = || -> Result<LayerPixels, IngestError> {
        crate::pixels::Bounded::new(
            Region::new(0, 0, 0, 0),
            Pixels::from_rgba8(Arc::from(Vec::new())),
            cw,
            ch,
        )
        .map(LayerPixels::Bounded)
        .ok_or_else(|| IngestError::Decode("an empty smart-object render".into()))
    };
    let Some(win) = quad_window(q, cw, ch) else {
        return empty();
    };
    let (w, h) = (f64::from(raster.width), f64::from(raster.height));
    let (sx, sy) = quad_scale(w, h, q);
    // Reduce first when the placement shrinks the source.
    let (src, sw, sh): (std::borrow::Cow<'_, [u8]>, u32, u32) =
        if sx < REDUCE_BELOW || sy < REDUCE_BELOW {
            let rw = ((w * sx.min(1.0)).round().max(1.0)) as u32;
            let rh = ((h * sy.min(1.0)).round().max(1.0)) as u32;
            let small = resize_rgba8(
                &raster.rgba,
                raster.width,
                raster.height,
                rw,
                rh,
                Filter::Lanczos3,
            )
            .map_err(|e| IngestError::Unsupported(e.to_string()))?;
            (small.into(), rw, rh)
        } else {
            ((&raster.rgba[..]).into(), raster.width, raster.height)
        };
    let fwd = homography(f64::from(sw), f64::from(sh), q).ok_or_else(|| {
        IngestError::Unsupported("the smart object's placement folds it flat".into())
    })?;
    let inv = paged_warp::invert(fwd).ok_or_else(|| {
        IngestError::Unsupported("the smart object's placement folds it flat".into())
    })?;
    let px = warp_projective_rgba8(
        &src,
        sw,
        sh,
        inv,
        Window {
            x: win.x,
            y: win.y,
            w: win.w,
            h: win.h,
        },
        WarpFilter::Bicubic,
    )
    .map_err(|e| IngestError::Unsupported(e.to_string()))?;
    let px = Pixels::from_rgba8(Arc::from(px.into_boxed_slice()));
    if win == Region::new(0, 0, cw, ch) {
        return Ok(px.into());
    }
    crate::pixels::Bounded::new(win, px, cw, ch)
        .map(LayerPixels::Bounded)
        .ok_or_else(|| IngestError::Decode("a smart-object render outside its canvas".into()))
}

/// The placement of `src` at `scale` of its source's size: the first
/// corner and the edges' directions kept (a perspective is dropped).
pub fn scaled_quad(src: &crate::layers::SmartSource, scale: f64) -> Quad {
    let q = src.quad();
    let (w, h) = (f64::from(src.width) * scale, f64::from(src.height) * scale);
    let (ox, oy) = (q[0], q[1]);
    let unit = |dx: f64, dy: f64, fx: f64, fy: f64| {
        let l = dx.hypot(dy);
        if l > 1e-9 {
            (dx / l, dy / l)
        } else {
            (fx, fy)
        }
    };
    let (ux, uy) = unit(q[2] - ox, q[3] - oy, 1.0, 0.0);
    let (vx, vy) = unit(q[6] - ox, q[7] - oy, 0.0, 1.0);
    [
        ox,
        oy,
        ox + ux * w,
        oy + uy * w,
        ox + ux * w + vx * h,
        oy + uy * w + vy * h,
        ox + vx * h,
        oy + vy * h,
    ]
}

/// RE-RENDER the smart object of `layer` from its source into its
/// placement on a `cw × ch` canvas. Its live filters are then pending (a
/// GPU pass from the bundle). Refused without a source at hand, or for a
/// placement with a warp paged does not draw.
pub fn rerender(layer: &mut crate::layers::Layer, cw: u32, ch: u32) -> Result<(), IngestError> {
    let crate::layers::LayerKind::Smart(src) = &mut layer.kind else {
        return Err(IngestError::Unsupported(format!(
            "layer \"{}\" is not a smart object",
            layer.name
        )));
    };
    if src.warped {
        return Err(IngestError::Unsupported(format!(
            "the smart object \"{}\" is warped, which paged does not draw: it keeps Photoshop's render",
            layer.name
        )));
    }
    let raster = src.raster()?;
    let q = src.quad();
    layer.rgba = render_placed(&raster, &q, cw, ch)?;
    let (sx, _) = quad_scale(f64::from(raster.width), f64::from(raster.height), &q);
    src.scale = sx as f32;
    src.pending_filters = src.live_filters().is_some();
    Ok(())
}

/// A resampling canvas op's effect on a smart object: its placement maps
/// through `f` and it re-renders from its source onto the `ow × oh`
/// canvas. `false` when the layer is not a smart object, or is one that
/// cannot re-render (a missing link, a warp) — the caller then resamples
/// its render as pixels; its placement has moved either way.
pub fn follow_canvas_op(
    layer: &mut crate::layers::Layer,
    f: impl Fn([f32; 2]) -> [f32; 2],
    ow: u32,
    oh: u32,
) -> Result<bool, IngestError> {
    let crate::layers::LayerKind::Smart(src) = &mut layer.kind else {
        return Ok(false);
    };
    let q = src.quad();
    src.placement = Some(map_quad(&q, |(x, y)| {
        let p = f([x as f32, y as f32]);
        (f64::from(p[0]), f64::from(p[1]))
    }));
    let can = !src.warped && (src.file.as_ref().is_none_or(|f| f.is_available()));
    if !can {
        return Ok(false);
    }
    rerender(layer, ow, oh)?;
    Ok(true)
}

// ───────────────────────────── smart filters ───────────────────────────

/// One smart filter, in paged's terms: the catalogue filter (`id`, the
/// Filter dialog's `FilterDef`) and its values, its switch and blending.
#[derive(Debug, Clone, PartialEq)]
pub struct SmartFilterEntry {
    /// The catalogue id (`gaussianBlur`, `motionBlur`, …); empty for a
    /// filter read from a PSD that paged has no counterpart for.
    pub id: String,
    /// The dialog's values as a JSON object.
    pub values: String,
    /// The name the list shows.
    pub name: String,
    pub enabled: bool,
    /// Blending options: opacity in [0, 1] and the mode (`normal`, …).
    pub opacity: f32,
    pub mode: String,
    /// The filter as read from a PSD, written back unchanged while the
    /// entry is.
    pub psd: Option<SmartFilter>,
}

/// A smart object's filters, bottom (first applied) first, and the
/// filter mask that confines them.
#[derive(Debug, Clone)]
pub struct SmartFilterStack {
    /// The whole stack is on.
    pub enabled: bool,
    pub filters: Vec<SmartFilterEntry>,
    /// The filter mask (canvas coordinates; white where the filters
    /// show), absent when it is all white.
    pub mask: Option<LayerMask>,
    pub mask_enabled: bool,
    /// The mask moves with the smart object (Photoshop's link icon).
    pub mask_linked: bool,
}

impl Default for SmartFilterStack {
    fn default() -> Self {
        Self {
            enabled: true,
            filters: Vec::new(),
            mask: None,
            mask_enabled: true,
            mask_linked: false,
        }
    }
}

impl PartialEq for SmartFilterStack {
    fn eq(&self, o: &Self) -> bool {
        self.enabled == o.enabled
            && self.filters == o.filters
            && self.mask_enabled == o.mask_enabled
            && self.mask_linked == o.mask_linked
            && match (&self.mask, &o.mask) {
                (None, None) => true,
                (Some(a), Some(b)) => a.same(b),
                _ => false,
            }
    }
}

impl SmartFilterStack {
    /// The filters that draw.
    pub fn live(&self) -> impl Iterator<Item = &SmartFilterEntry> {
        self.filters
            .iter()
            .filter(move |f| self.enabled && f.enabled)
    }

    /// Can paged draw this stack? `Err` names the first enabled filter
    /// without a counterpart (its render is then Photoshop's, kept).
    pub fn drawable(&self) -> Result<(), String> {
        if let Some(f) = self.live().find(|f| f.id.is_empty()) {
            return Err(format!(
                "the smart filter \"{}\" has no counterpart in paged (switch it off or rasterize the layer)",
                f.name
            ));
        }
        if let Some(f) = self.live().find(|f| f.mode != "normal") {
            return Err(format!(
                "the smart filter \"{}\" blends in {} mode, which paged does not draw for a smart filter",
                f.name, f.mode
            ));
        }
        Ok(())
    }

    /// The stack from the panel's (and the stored manifest's) JSON —
    /// `{enabled, maskEnabled, maskLinked, filters: [{id, values, enabled,
    /// opacity, mode, name, from?}]}`. A filter read from a PSD keeps its
    /// PSD form while it is the same filter (`from`: its index in `old`,
    /// else its own); the mask is `old`'s.
    pub fn from_json(
        json: &str,
        old: Option<&SmartFilterStack>,
    ) -> Result<SmartFilterStack, String> {
        let v: serde_json::Value =
            serde_json::from_str(json).map_err(|e| format!("smart filters: {e}"))?;
        let list = v
            .get("filters")
            .and_then(|f| f.as_array())
            .ok_or_else(|| "smart filters: no \"filters\" list".to_string())?;
        let mut filters = Vec::new();
        for (i, f) in list.iter().enumerate() {
            let id = f
                .get("id")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            let values = f
                .get("values")
                .cloned()
                .unwrap_or(serde_json::json!({}))
                .to_string();
            // A filter read from a PSD keeps its PSD form while it is the
            // same filter (by its position in the old list, or its `from`).
            let from = f
                .get("from")
                .and_then(|x| x.as_u64())
                .map_or(i, |x| x as usize);
            let psd = old
                .and_then(|o| o.filters.get(from))
                .filter(|o| o.id == id)
                .and_then(|o| o.psd.clone());
            filters.push(SmartFilterEntry {
                name: f
                    .get("name")
                    .and_then(|x| x.as_str())
                    .map(str::to_string)
                    .or_else(|| psd.as_ref().map(|p| p.name.clone()))
                    .unwrap_or_else(|| filter_name(&id)),
                id,
                values,
                enabled: f.get("enabled").and_then(|x| x.as_bool()).unwrap_or(true),
                opacity: f
                    .get("opacity")
                    .and_then(|x| x.as_f64())
                    .unwrap_or(1.0)
                    .clamp(0.0, 1.0) as f32,
                mode: f
                    .get("mode")
                    .and_then(|x| x.as_str())
                    .unwrap_or("normal")
                    .to_string(),
                psd,
            });
        }
        let b = |k: &str, d: bool| v.get(k).and_then(|x| x.as_bool()).unwrap_or(d);
        Ok(SmartFilterStack {
            enabled: b("enabled", true),
            filters,
            mask: old.and_then(|o| o.mask.clone()),
            mask_enabled: b("maskEnabled", old.is_none_or(|o| o.mask_enabled)),
            mask_linked: b("maskLinked", old.is_some_and(|o| o.mask_linked)),
        })
    }

    /// The list as JSON for the panel: `[{id, name, values, enabled,
    /// opacity, mode, known}]` plus the switches.
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "enabled": self.enabled,
            "maskEnabled": self.mask_enabled,
            "maskLinked": self.mask_linked,
            "hasMask": self.mask.is_some(),
            "filters": self.filters.iter().map(|f| serde_json::json!({
                "id": f.id,
                "name": f.name,
                "values": serde_json::from_str::<serde_json::Value>(&f.values)
                    .unwrap_or(serde_json::Value::Null),
                "enabled": f.enabled,
                "opacity": f.opacity,
                "mode": f.mode,
                "known": !f.id.is_empty(),
            })).collect::<Vec<_>>(),
        })
    }
}

/// The catalogue's name for a filter (English; the panel translates).
fn filter_name(id: &str) -> String {
    match id {
        "gaussianBlur" => "Gaussian Blur",
        "motionBlur" => "Motion Blur",
        "boxBlur" => "Box Blur",
        "highPass" => "High Pass",
        "median" => "Median",
        "maximum" => "Maximum",
        "minimum" => "Minimum",
        other => other,
    }
    .to_string()
}

/// A PSD smart filter as paged's: the filters paged reproduces map onto
/// their catalogue entry; any other keeps its PSD form and an empty id.
pub fn filter_from_psd(f: &SmartFilter) -> SmartFilterEntry {
    let num = |k: &[u8]| {
        f.filter
            .get(k)
            .and_then(|v| v.as_number().or_else(|| v.as_unit_float().map(|(_, x)| x)))
    };
    let cls = f.filter.class_id.as_bytes().to_vec();
    let mapped: Option<(&str, serde_json::Value)> = match &cls[..] {
        b"GsnB" => num(b"Rds ").map(|r| ("gaussianBlur", serde_json::json!({ "radius": r }))),
        b"MtnB" => match (num(b"Angl"), num(b"Dstn")) {
            (Some(a), Some(d)) => {
                Some(("motionBlur", serde_json::json!({ "angle": a, "length": d })))
            }
            _ => None,
        },
        b"boxblur" => num(b"Rds ").map(|r| ("boxBlur", serde_json::json!({ "radius": r }))),
        b"HghP" => num(b"Rds ").map(|r| ("highPass", serde_json::json!({ "radius": r }))),
        b"Mdn " => num(b"Rds ").map(|r| ("median", serde_json::json!({ "radius": r }))),
        b"Mxm " => num(b"Rds ").map(|r| ("maximum", serde_json::json!({ "radius": r }))),
        b"Mnm " => num(b"Rds ").map(|r| ("minimum", serde_json::json!({ "radius": r }))),
        _ => None,
    };
    let mode = if f.mode.matches(b"normal") || f.mode.matches(b"Nrml") {
        "normal".to_string()
    } else {
        f.mode.text_lossy()
    };
    let (id, values) = mapped.map_or((String::new(), "{}".to_string()), |(i, v)| {
        (i.to_string(), v.to_string())
    });
    SmartFilterEntry {
        id,
        values,
        name: image_psd::descriptor::localized_display(&f.name).to_string(),
        enabled: f.enabled,
        opacity: (f.opacity / 100.0).clamp(0.0, 1.0) as f32,
        mode,
        psd: Some(f.clone()),
    }
}

/// A filter's class key, items, name and event id.
type FilterForm = (
    &'static [u8],
    Vec<(&'static [u8], DescriptorValue)>,
    &'static str,
    i32,
);

/// Photoshop's form of a paged smart filter — `None` when the filter has
/// no Photoshop smart filter of the same parameters. An entry read from a
/// PSD and unchanged is its own PSD form.
pub fn filter_to_psd(e: &SmartFilterEntry) -> Option<SmartFilter> {
    if let Some(p) = &e.psd {
        if filter_from_psd(p) == *e {
            return Some(p.clone());
        }
    }
    let v: serde_json::Value = serde_json::from_str(&e.values).ok()?;
    let get = |k: &str| v.get(k).and_then(serde_json::Value::as_f64);
    let px = |x: f64| DescriptorValue::UnitFloat {
        unit: *b"#Pxl",
        value: x,
    };
    let radius = |k: &str| -> Option<Vec<(&'static [u8], DescriptorValue)>> {
        Some(vec![(b"Rds ".as_slice(), px(get(k)?))])
    };
    // Photoshop's Maximum, Minimum and Median preserve squareness: a
    // round neighbourhood has no smart filter of the same parameters.
    let square = || get("round").is_none_or(|r| r == 0.0);
    // The class key, its items, the name and the event id (`filterID`:
    // the class's char code, or the event's own number for a filter
    // with a string id) — as Photoshop 27.10 writes them [OBS].
    let (class, items, name, filter_id): FilterForm = match e.id.as_str() {
        "gaussianBlur" => (
            b"GsnB",
            radius("radius")?,
            "Gaussian Blur...",
            i32::from_be_bytes(*b"GsnB"),
        ),
        "motionBlur" => (
            b"MtnB",
            vec![
                (
                    b"Angl",
                    DescriptorValue::Integer(get("angle")?.round() as i32),
                ),
                (b"Dstn", px(get("length")?)),
            ],
            "Motion Blur...",
            i32::from_be_bytes(*b"MtnB"),
        ),
        "boxBlur" => (b"boxblur", radius("radius")?, "Box Blur...", 840),
        "highPass" => (
            b"HghP",
            radius("radius")?,
            "High Pass...",
            i32::from_be_bytes(*b"HghP"),
        ),
        "median" if square() => (
            b"Mdn ",
            radius("radius")?,
            "Median...",
            i32::from_be_bytes(*b"Mdn "),
        ),
        "maximum" if square() => (
            b"Mxm ",
            radius("radius")?,
            "Maximum...",
            i32::from_be_bytes(*b"Mxm "),
        ),
        "minimum" if square() => (
            b"Mnm ",
            radius("radius")?,
            "Minimum...",
            i32::from_be_bytes(*b"Mnm "),
        ),
        _ => return None,
    };
    let mode = match e.mode.as_str() {
        "normal" | "" => key(b"normal"),
        m => key(m.as_bytes()),
    };
    // The descriptor's class name is the filter's display name, which
    // Photoshop writes in its own language (`Gaußscher Weichzeichner`);
    // paged writes the English one.
    let mut filter = desc(class, items);
    filter.class_name = name.trim_end_matches("...").to_string();
    Some(SmartFilter {
        name: name.to_string(),
        filter,
        filter_id,
        enabled: e.enabled,
        opacity: f64::from(e.opacity * 100.0).round(),
        mode,
        has_options: true,
        fg: [0.0; 3],
        bg: [255.0; 3],
    })
}

/// Smart filters from a PSD record, with the filter mask of the document's
/// filter-effects entry for `placed`.
pub fn filters_from_psd(
    fx: &SmartFilters,
    effects: Option<&FilterEffects>,
    placed: Option<&str>,
    cw: u32,
    ch: u32,
) -> SmartFilterStack {
    let mask = placed
        .and_then(|p| effects.and_then(|e| e.entry(p)))
        .and_then(|e| e.mask_plane().ok().flatten())
        .and_then(|(r, plane)| fx_mask(r, plane, fx.mask_extend_with_white, cw, ch));
    SmartFilterStack {
        enabled: fx.enabled,
        filters: fx.list.iter().map(filter_from_psd).collect(),
        mask,
        mask_enabled: fx.mask_enabled,
        mask_linked: fx.mask_linked,
    }
}

/// A filter-effects mask plane as a layer mask on the canvas (`None`
/// when it is all white, which is no mask).
fn fx_mask(
    rect: [i32; 4],
    plane: Vec<u8>,
    extend_white: bool,
    cw: u32,
    ch: u32,
) -> Option<LayerMask> {
    let [t, l, b, r] = rect;
    let (w, h) = ((r - l).max(0) as u32, (b - t).max(0) as u32);
    let outside = if extend_white { 255 } else { 0 };
    if plane.iter().all(|&v| v == 255) && outside == 255 {
        return None;
    }
    // Clip the plane to the canvas.
    let x0 = l.max(0);
    let y0 = t.max(0);
    let x1 = r.min(cw as i32);
    let y1 = b.min(ch as i32);
    if x1 <= x0 || y1 <= y0 {
        return None;
    }
    let (cwid, chei) = ((x1 - x0) as u32, (y1 - y0) as u32);
    let mut data = Vec::with_capacity((cwid * chei) as usize);
    for y in y0..y1 {
        let row = ((y - t) as u32 * w) as usize;
        let from = row + (x0 - l) as usize;
        data.extend_from_slice(&plane[from..from + cwid as usize]);
    }
    let _ = h;
    BoundedMask::new(Region::new(x0, y0, cwid, chei), outside, data, cw, ch)
        .map(|m| LayerMask::Bounded(Arc::new(m)))
}

/// Land a filter result through the filter mask: where the mask is
/// black the unfiltered render shows, where white the filtered one, in
/// between a premultiplied mix. Both are canvas-sized straight RGBA8.
pub fn through_filter_mask(
    base: &[u8],
    filtered: &[u8],
    mask: Option<&LayerMask>,
    cw: u32,
) -> Vec<u8> {
    let Some(mask) = mask else {
        return filtered.to_vec();
    };
    let mut out = filtered.to_vec();
    for (i, (o, b)) in out
        .as_chunks_mut::<4>()
        .0
        .iter_mut()
        .zip(base.as_chunks::<4>().0.iter())
        .enumerate()
    {
        let (x, y) = ((i as u32) % cw, (i as u32) / cw);
        let m = u32::from(mask.at(x, y));
        if m == 255 {
            continue;
        }
        mix_into(o, b, m as f32 / 255.0);
    }
    out
}

/// `o = mix(b, o, t)` in premultiplied space, straight out.
fn mix_into(o: &mut [u8], b: &[u8], t: f32) {
    let pa = f32::from(o[3]) * t + f32::from(b[3]) * (1.0 - t);
    if pa <= 0.0 {
        o.copy_from_slice(&[0, 0, 0, 0]);
        return;
    }
    for c in 0..3 {
        let v =
            f32::from(o[c]) * f32::from(o[3]) * t + f32::from(b[c]) * f32::from(b[3]) * (1.0 - t);
        o[c] = (v / pa).round().clamp(0.0, 255.0) as u8;
    }
    o[3] = pa.round().clamp(0.0, 255.0) as u8;
}

/// The catalogue filters that average neighbours (the blurs): on a smart
/// object they run over ASSOCIATED colour — Photoshop's smart filters do,
/// so a transparent neighbour lends no colour to an edge (measured against
/// its Gaussian Blur smart filter, `smart_objects_photoshop.rs`).
pub const ASSOCIATED_FILTERS: [&str; 6] = [
    "gaussianBlur",
    "boxBlur",
    "motionBlur",
    "radialBlur",
    "lensBlur",
    "surfaceBlur",
];

/// Straight RGBA8 to associated (`c · a`), alpha kept.
pub fn associate(px: &[u8]) -> Vec<u8> {
    px.as_chunks::<4>()
        .0
        .iter()
        .flat_map(|p| {
            let a = u32::from(p[3]);
            let m = |c: u8| ((u32::from(c) * a + 127) / 255) as u8;
            [m(p[0]), m(p[1]), m(p[2]), p[3]]
        })
        .collect()
}

/// [`associate`]'s inverse (a transparent pixel is `0, 0, 0, 0`).
pub fn dissociate(px: &[u8]) -> Vec<u8> {
    px.as_chunks::<4>()
        .0
        .iter()
        .flat_map(|p| {
            let a = u32::from(p[3]);
            if a == 0 {
                return [0, 0, 0, 0];
            }
            let d = |c: u8| ((u32::from(c).min(a) * 255 + a / 2) / a).min(255) as u8;
            [d(p[0]), d(p[1]), d(p[2]), p[3]]
        })
        .collect()
}

/// A filter's result faded over its input by `opacity` (its blending
/// options; Normal mode).
pub fn fade(input: &[u8], output: &[u8], opacity: f32) -> Vec<u8> {
    let mut out = output.to_vec();
    if opacity >= 1.0 {
        return out;
    }
    for (o, b) in out
        .as_chunks_mut::<4>()
        .0
        .iter_mut()
        .zip(input.as_chunks::<4>().0.iter())
    {
        mix_into(o, b, opacity.max(0.0));
    }
    out
}

// ─────────────────────────── PSD import ───────────────────────────────

/// The linked files of a parsed PSD, from every linked-file block.
pub fn psd_linked_files(file: &PsdFile) -> Vec<LinkedFile> {
    let container: Container = file.container;
    file.layer_mask
        .addl_global
        .iter()
        .filter(|a| LINKED_KEYS.contains(&&a.key))
        .flat_map(|a| parse_linked_files(a.payload(container)).unwrap_or_default())
        .collect()
}

/// The document's filter-effects cache, when it has one.
pub fn psd_filter_effects(file: &PsdFile) -> Option<FilterEffects> {
    let container: Container = file.container;
    file.layer_mask
        .addl_global
        .iter()
        .find(|a| FILTER_EFFECTS_KEYS.contains(&&a.key))
        .and_then(|a| FilterEffects::parse(a.payload(container)).ok())
}

/// A record's placed-layer block, when it is a smart object.
pub fn placed_layer(
    rec: &image_psd::model::LayerRecord,
    container: Container,
) -> Option<PlacedLayer> {
    rec.addl
        .iter()
        .find(|a| matches!(&a.key, b"SoLd" | b"SoLE"))
        .and_then(|a| PlacedLayer::parse(&a.key, a.payload(container)).ok())
}

/// The UNFILTERED render Photoshop cached for a smart object with
/// filters (its filter-effects entry's colour channels and transparency),
/// canvas-sized straight RGBA8 — `None` without a readable entry.
pub fn fx_base(effects: &FilterEffects, placed: &str, cw: u32, ch: u32) -> Option<Vec<u8>> {
    let e = effects.entry(placed)?;
    let [t, l, b, r] = e.rect;
    let (w, h) = ((r - l).max(0) as usize, (b - t).max(0) as usize);
    let plane = |slot: usize| {
        e.channels
            .get(slot)?
            .as_ref()
            .and_then(|c| image_psd::smart_object::decode_fx_channel(c, &e.rect).ok())
    };
    let (rr, gg, bb) = (plane(0)?, plane(1)?, plane(2)?);
    let aa = plane(e.max_channels as usize + 1)?;
    let mut out = vec![0u8; cw as usize * ch as usize * 4];
    for y in 0..h {
        for x in 0..w {
            let (cx, cy) = (l + x as i32, t + y as i32);
            if cx < 0 || cy < 0 || cx >= cw as i32 || cy >= ch as i32 {
                continue;
            }
            let i = y * w + x;
            let o = (cy as usize * cw as usize + cx as usize) * 4;
            out[o..o + 4].copy_from_slice(&[rr[i], gg[i], bb[i], aa[i]]);
        }
    }
    Some(out)
}

/// What the import made of a PSD smart object.
pub struct ImportedSmart {
    pub source: crate::layers::SmartSource,
    /// Why it stays the stored render only (a warp, an unknown filter, a
    /// missing link): it opens as a smart object whose render is kept
    /// until its source can be drawn.
    pub note: Option<String>,
}

/// A PSD smart object's source, placement and filters.
pub fn import_smart(
    placed: &PlacedLayer,
    files: &[LinkedFile],
    effects: Option<&FilterEffects>,
    cw: u32,
    ch: u32,
) -> ImportedSmart {
    let uuid = placed.uuid().unwrap_or("").to_string();
    let entry = files.iter().find(|f| f.uuid == uuid);
    let file = entry.map(|e| {
        let (bytes, link): (Arc<[u8]>, Option<String>) = match e.kind {
            LinkKind::Data => (Arc::from(e.data.clone().into_boxed_slice()), None),
            LinkKind::External | LinkKind::Alias => {
                (Arc::from(Vec::new()), Some(e.link_path().to_string()))
            }
        };
        let mut f = SmartFile::new(uuid.clone(), e.name.clone(), e.file_type, bytes, link);
        f.entry = Some(e.clone());
        Arc::new(f)
    });
    let (w, h) = placed.size().unwrap_or((0.0, 0.0));
    let quad = placed.quad();
    let filters = placed
        .filter_fx()
        .and_then(|d| SmartFilters::from_descriptor(d).ok())
        .map(|fx| Arc::new(filters_from_psd(&fx, effects, placed.placed_id(), cw, ch)));
    let mut note = None;
    if !placed.warp_is_none() {
        note = Some("its warp is kept, not drawn: it renders as Photoshop stored it".to_string());
    } else if file.is_none() {
        note = Some(format!("its source {uuid} is not in the file"));
    } else if let Some(Err(e)) = filters.as_deref().map(SmartFilterStack::drawable) {
        note = Some(e);
    }
    ImportedSmart {
        source: crate::layers::SmartSource {
            rgba: Arc::from(Vec::new()),
            width: w.round().max(0.0) as u32,
            height: h.round().max(0.0) as u32,
            scale: 1.0,
            placement: quad,
            file,
            filters,
            vector: None,
            record: Some(Arc::new(placed.clone())),
            warped: !placed.warp_is_none(),
            pending_filters: false,
        },
        note,
    }
}

/// The name of the PSB a nested document is saved as: a PSD/PSB keeps
/// its name, any other file takes `.psb`.
pub fn psb_name(name: &str, file_type: &[u8; 4]) -> String {
    if matches!(file_type, b"8BPB" | b"8BPS") {
        return name.to_string();
    }
    let stem = name.rsplit_once('.').map_or(name, |(s, _)| s);
    format!("{stem}.psb")
}

/// A minimal flat PSB (RGB, 8 bits, transparency in the merged image) of
/// `rgba` — the document the layered save writes a nested stack into
/// when the contents were not a PSD.
pub fn blank_psb(width: u32, height: u32, rgba: &[u8]) -> Vec<u8> {
    let mut b = Vec::new();
    b.extend_from_slice(b"8BPS");
    b.extend_from_slice(&2u16.to_be_bytes());
    b.extend_from_slice(&[0; 6]);
    b.extend_from_slice(&4u16.to_be_bytes());
    b.extend_from_slice(&height.to_be_bytes());
    b.extend_from_slice(&width.to_be_bytes());
    b.extend_from_slice(&8u16.to_be_bytes());
    b.extend_from_slice(&3u16.to_be_bytes());
    b.extend_from_slice(&0u32.to_be_bytes()); // colour mode data
    b.extend_from_slice(&0u32.to_be_bytes()); // image resources
    b.extend_from_slice(&0u64.to_be_bytes()); // layer and mask information
    b.extend_from_slice(&0u16.to_be_bytes()); // raw
    for c in 0..4 {
        b.extend(rgba.as_chunks::<4>().0.iter().map(|p| p[c]));
    }
    b
}

/// The bytes a nested document is saved back as: the layered save into
/// the PSD/PSB it was opened from, or into a new PSB.
pub fn contents_bytes(
    stack: &crate::layers::LayerStack,
    psd: Option<PsdFile>,
    composite: &[u8],
) -> Result<Vec<u8>, IngestError> {
    let (w, h) = (stack.width(), stack.height());
    let mut file = match psd {
        Some(f) if (f.header.width, f.header.height) == (w, h) => f,
        _ => PsdFile::parse(&blank_psb(w, h, composite))
            .map_err(|e| IngestError::Decode(e.to_string()))?,
    };
    crate::saveback::psd_write_stack(&mut file, stack, composite)?;
    file.write().map_err(|e| IngestError::Decode(e.to_string()))
}

/// A new uuid for a source or a placement — deterministic per call
/// order within the realm (tests reproduce files byte for byte), in the
/// 8-4-4-4-12 form Photoshop writes. The count is the thread's: the wasm
/// realm has one, and a test runner's tests, each on a thread of its own,
/// do not shift each other's uuids (a process-wide count made a recorded
/// file's hash depend on which tests ran first).
pub fn new_uuid(seed: &[u8]) -> String {
    use std::cell::Cell;
    thread_local! {
        static COUNTER: Cell<u64> = const { Cell::new(1) };
    }
    let n = COUNTER.with(|c| {
        let n = c.get();
        c.set(n.wrapping_add(1));
        n
    });
    let mut h: u64 = 0xcbf2_9ce4_8422_2325 ^ n;
    let mut g: u64 = 0x8422_2325_cbf2_9ce4 ^ n.rotate_left(17);
    for &b in seed {
        h = (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3);
        g = (g ^ u64::from(b))
            .wrapping_mul(0x0000_0100_0000_01b3)
            .rotate_left(5);
    }
    let a = h.to_be_bytes();
    let b = g.to_be_bytes();
    let hex = |s: &[u8]| s.iter().map(|x| format!("{x:02x}")).collect::<String>();
    format!(
        "{}-{}-{}-{}-{}",
        hex(&a[0..4]),
        hex(&a[4..6]),
        hex(&a[6..8]),
        hex(&b[0..2]),
        hex(&b[2..8])
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn checker(w: u32, h: u32) -> SourceRaster {
        let mut px = Vec::new();
        for y in 0..h {
            for x in 0..w {
                let v = if (x / 2 + y / 2) % 2 == 0 { 220 } else { 30 };
                px.extend_from_slice(&[v, 255 - v, 90, 255]);
            }
        }
        SourceRaster {
            width: w,
            height: h,
            rgba: px.into(),
        }
    }

    #[test]
    #[allow(non_snake_case)]
    fn an_integer_placement_is_the_source_at_its_offset__feat__image_layers_smart_objects_full() {
        let r = checker(8, 6);
        let out = render_placed(&r, &rect_quad(3.0, 2.0, 8.0, 6.0), 16, 12).expect("render");
        let b = out.bounded().expect("bounded");
        assert_eq!(b.rect, Region::new(3, 2, 8, 6));
        assert_eq!(&*b.px.to_rgba8(), &r.rgba[..]);
        // Off the canvas: empty.
        let none = render_placed(&r, &rect_quad(40.0, 2.0, 8.0, 6.0), 16, 12).expect("render");
        assert_eq!(none.bounded().map(|b| b.rect.w), Some(0));
    }

    #[test]
    fn scaling_down_and_back_up_draws_from_the_source() {
        let r = checker(32, 32);
        let small = render_placed(&r, &rect_quad(0.0, 0.0, 8.0, 8.0), 32, 32).expect("small");
        assert_eq!(
            small.bounded().map(|b| b.rect),
            Some(Region::new(0, 0, 8, 8))
        );
        let back = render_placed(&r, &rect_quad(0.0, 0.0, 32.0, 32.0), 32, 32).expect("back");
        assert_eq!(
            &*back.to_rgba8(),
            &r.rgba[..],
            "the source, not the 8 px render"
        );
    }

    #[test]
    fn a_mirrored_placement_flips_the_source() {
        let r = checker(4, 2);
        let q = [4.0, 0.0, 0.0, 0.0, 0.0, 2.0, 4.0, 2.0];
        let out = render_placed(&r, &q, 4, 2).expect("render");
        let px = out.to_rgba8();
        for y in 0..2usize {
            for x in 0..4usize {
                let s = (y * 4 + (3 - x)) * 4;
                assert_eq!(px[(y * 4 + x) * 4..(y * 4 + x) * 4 + 4], r.rgba[s..s + 4]);
            }
        }
    }

    #[test]
    fn the_filter_mask_mixes_the_unfiltered_render_back() {
        let base = [10u8, 20, 30, 255].repeat(4);
        let filtered = [200u8, 100, 50, 255].repeat(4);
        let m = BoundedMask::new(Region::new(0, 0, 2, 1), 255, vec![0, 128], 2, 2).expect("mask");
        let out = through_filter_mask(&base, &filtered, Some(&LayerMask::Bounded(Arc::new(m))), 2);
        assert_eq!(&out[0..4], &[10, 20, 30, 255]);
        assert_eq!(out[4], 105);
        assert_eq!(&out[8..12], &[200, 100, 50, 255]);
        assert_eq!(fade(&base, &filtered, 0.0)[..4], base[..4]);
    }

    #[test]
    fn psd_filters_map_both_ways() {
        let f = SmartFilter {
            name: "Gaussian Blur...".into(),
            filter: desc(
                b"GsnB",
                vec![(
                    b"Rds ",
                    DescriptorValue::UnitFloat {
                        unit: *b"#Pxl",
                        value: 3.0,
                    },
                )],
            ),
            filter_id: i32::from_be_bytes(*b"GsnB"),
            enabled: true,
            opacity: 100.0,
            mode: key(b"normal"),
            has_options: true,
            fg: [0.0; 3],
            bg: [255.0; 3],
        };
        let e = filter_from_psd(&f);
        assert_eq!(
            (e.id.as_str(), e.values.as_str()),
            ("gaussianBlur", r#"{"radius":3.0}"#)
        );
        assert_eq!(
            filter_to_psd(&e),
            Some(f.clone()),
            "an unchanged filter is its own PSD form"
        );
        let mut edited = e.clone();
        edited.values = r#"{"radius":5}"#.into();
        let back = filter_to_psd(&edited).expect("written");
        assert_eq!(back.filter.unit_float(b"Rds "), Some((*b"#Pxl", 5.0)));
        let unknown = SmartFilter {
            filter: desc(b"Wave", vec![]),
            ..f
        };
        let u = filter_from_psd(&unknown);
        assert!(u.id.is_empty());
        let stack = SmartFilterStack {
            filters: vec![u],
            ..Default::default()
        };
        assert!(stack.drawable().is_err());
    }

    #[test]
    fn uuids_are_distinct_and_well_formed() {
        let a = new_uuid(b"x");
        let b = new_uuid(b"x");
        assert_ne!(a, b);
        assert_eq!(a.len(), 36);
        assert_eq!(a.matches('-').count(), 4);
    }

    #[test]
    fn a_missing_link_says_so() {
        let f = SmartFile::new(
            "u",
            "a.png",
            *b"png ",
            Arc::from(Vec::new()),
            Some("/x/a.png".into()),
        );
        assert!(!f.is_available());
        assert!(f.raster().unwrap_err().to_string().contains("missing"));
    }

    #[test]
    fn quad_scale_reads_each_axis() {
        let (sx, sy) = quad_scale(10.0, 20.0, &rect_quad(0.0, 0.0, 5.0, 40.0));
        assert!((sx - 0.5).abs() < 1e-12 && (sy - 2.0).abs() < 1e-12);
        let _ = map_quad(&rect_quad(0.0, 0.0, 1.0, 1.0), |(x, y)| (y, x));
        let _ = VectorSource {
            items: vec![],
            region: [0.0; 4],
            px_per_pt: 1.0,
        };
    }
}

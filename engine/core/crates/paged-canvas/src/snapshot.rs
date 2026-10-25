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

//! Snapshot tier of the LOD cache.
//!
//! The lowest-resolution rendered output a page can have. The page
//! navigator, the minimap, and the canvas at overview zoom all draw
//! from here. Per the canvas spec (§4.4):
//!
//! - Target width: 256–512 px per page.
//! - Lifetime: never evicted.
//! - Regeneration: only when `(layout_generation, numbering_generation)`
//!   advance for the page.
//!
//! Phase 1 produces snapshots on demand through this module; future
//! work adds the atlas packing + LRU bookkeeping that turn the
//! per-page output into a single GPU texture.
//!
//! Two backends draw a snapshot. This module's functions rasterise on
//! the CPU (the `cpu` feature's rasterizer); the canvas worker
//! draws the same page with Vello on its WebGPU device when it has one
//! (`renderSnapshotGpu` in `paged-canvas-wasm`). Both resolve the page
//! and the dpi through [`snapshot_page`] and encode through
//! [`encode_snapshot_png`], so the two differ only in the rasterizer.
//!
//! The wire-format types (`SnapshotPng`, `SnapshotError`) are always
//! compiled so the typed message channel stays wire-compatible across
//! feature configs.

use paged_renderer::{BuiltPage, PageId};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tsify_next::Tsify;

use crate::model::CanvasModel;
use image::{codecs::png::PngEncoder, ImageEncoder};
#[cfg(feature = "cpu")]
use paged_renderer::render_built_page;

/// A rendered page bitmap. RGBA8, tightly packed (no row padding),
/// row-major from top to bottom. Caller decides whether to encode to
/// PNG, hand to a `<canvas>`, or pack into a WebGPU texture.
#[derive(Debug, Clone)]
pub struct Snapshot {
    pub page_id: PageId,
    pub width_px: u32,
    pub height_px: u32,
    /// Generation pair from the source `BuiltPage` at the time of
    /// snapshotting. Callers compare against the current page state
    /// to detect staleness before regenerating.
    pub layout_generation: u64,
    pub numbering_generation: u64,
    pub rgba: Vec<u8>,
}

/// Lightweight serialisable variant — the canvas worker hands this
/// (encoded as a `WorkerToMain` message) to the main thread. The
/// `rgba` payload becomes a PNG so the main thread can stash it in
/// an `<img>` or `ImageBitmap` without per-byte serialisation cost.
#[derive(Debug, Clone, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi, missing_as_null)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotPng {
    pub page_id: PageId,
    pub width_px: u32,
    pub height_px: u32,
    pub layout_generation: u64,
    pub numbering_generation: u64,
    /// The PNG. Empty when the request asked for `format: "rgba"`.
    #[tsify(type = "number[]")]
    pub png_bytes: Vec<u8>,
    /// Extensions ADR 338 — what the bytes are. Absent for a PNG (the v1
    /// reply), `"rgba"` when `rgba` carries them.
    #[serde(default, skip_serializing_if = "SnapshotFormat::is_png")]
    pub format: SnapshotFormat,
    /// Extensions ADR 338 — `format: "rgba"`: `widthPx × heightPx`
    /// pixels, 4 bytes each, rows top to bottom, STRAIGHT (not
    /// premultiplied) sRGB alpha. Absent for a PNG.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[tsify(type = "number[]")]
    pub rgba: Vec<u8>,
    /// Extensions ADR 338 — the page region the image covers, in page pt,
    /// when the request had a `clip`: the clip grown outward to whole
    /// pixels at the snapshot's resolution, so the image maps onto it
    /// exactly. Absent for a whole page.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region: Option<SnapshotClip>,
    /// Engine ADR 10XX — the request's `story` was drawn (alone). Absent
    /// when there was none, and from an engine that does not know the
    /// field (it drew the page instead).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub story: bool,
}

/// Extensions ADR 338 — the encoding of a snapshot's pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Tsify)]
#[serde(rename_all = "camelCase")]
pub enum SnapshotFormat {
    /// A PNG (`pngBytes`), the v1 reply.
    #[default]
    Png,
    /// Raw straight-alpha RGBA8 (`rgba`), for a caller that works on the
    /// pixels (an image layer, a rasterized vector).
    Rgba,
}

impl SnapshotFormat {
    pub fn is_png(&self) -> bool {
        *self == SnapshotFormat::Png
    }
}

/// Extensions ADR 338 — what lies under a snapshot's content.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Tsify)]
#[serde(rename_all = "camelCase")]
pub enum SnapshotBackground {
    /// White paper, as the page prints (the v1 snapshot).
    #[default]
    Paper,
    /// Nothing: uncovered pixels are fully transparent.
    Transparent,
}

/// Extensions ADR 338 — a rectangle in page pt (`(0, 0)` is the page's
/// top-left corner; it may reach past the page, onto the pasteboard).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Tsify)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotClip {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

impl SnapshotClip {
    /// Finite, with an area.
    pub fn is_valid(&self) -> bool {
        [self.x, self.y, self.width, self.height]
            .iter()
            .all(|v| v.is_finite())
            && self.width > 0.0
            && self.height > 0.0
    }
}

/// The largest side, in pixels, a snapshot draws (`SnapshotError::TooLarge`
/// past it): 16 384 px is 54 in at 300 ppi.
pub const MAX_SNAPSHOT_SIDE_PX: u32 = 16_384;

/// Engine ADR 10XX — a story the document does not hold, drawn by the
/// snapshot alone: laid out by the engine's text stack (the composer,
/// justification, hyphenation and the document's fonts) in a frame at
/// `bounds` on the snapshot's page, in a copy of the document. The
/// document is not changed; no undo step, no id is minted in it.
///
/// What paged.image's type layers are made of: their text lives in the
/// image, and the engine draws it at the image's resolution.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Tsify)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotStory {
    /// The text frame, page pt: `[top, left, bottom, right]`.
    pub bounds: [f32; 4],
    /// The paragraphs, in order. An empty list draws nothing.
    #[serde(default)]
    pub paragraphs: Vec<SnapshotParagraph>,
    /// `"top"` (the default), `"center"`, `"bottom"` or `"justify"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vertical_justification: Option<String>,
}

/// One paragraph of a [`SnapshotStory`]. Every absent value is the
/// document's default paragraph style's.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Tsify)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotParagraph {
    pub runs: Vec<SnapshotRun>,
    /// IDML's names: `LeftAlign`, `CenterAlign`, `RightAlign`,
    /// `LeftJustified`, `CenterJustified`, `RightJustified`,
    /// `FullyJustified`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub justification: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_line_indent: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub left_indent: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub right_indent: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub space_before: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub space_after: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hyphenation: Option<bool>,
    /// `"paragraph"` (Adobe Paragraph Composer) or `"single"` (Single-line).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub composer: Option<String>,
}

/// One run of a [`SnapshotParagraph`]: text in one set of character
/// attributes. Absent values inherit (the paragraph style's).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Tsify)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotRun {
    /// The text; a `\n` or `\r` inside it is a forced line break.
    pub text: String,
    /// Family name, as the document's fonts name it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_style: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub point_size: Option<f32>,
    /// Leading in pt; absent is auto.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub leading: Option<f32>,
    /// The fill, sRGB 0–255. Absent is the style's (black).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fill_rgb: Option<[u8; 3]>,
    /// 1/1000 em.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tracking: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub baseline_shift: Option<f32>,
    /// Percent (100 = none).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub horizontal_scale: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vertical_scale: Option<f32>,
    /// Degrees.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skew: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub underline: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub strikethru: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ligatures: Option<bool>,
    /// IDML's `Normal`, `AllCaps`, `SmallCaps`, `CapToSmallCap`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capitalization: Option<String>,
    /// IDML's `Normal`, `Superscript`, `Subscript`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position: Option<String>,
}

impl SnapshotStory {
    /// Finite bounds with an area.
    pub fn is_valid(&self) -> bool {
        let [t, l, b, r] = self.bounds;
        [t, l, b, r].iter().all(|v| v.is_finite()) && b > t && r > l
    }
}

/// One `RequestSnapshot`, every option in one place.
#[derive(Debug, Clone, Copy)]
pub struct SnapshotRequest<'a> {
    pub page_id: &'a PageId,
    pub target_width_px: u32,
    pub dpi: Option<f32>,
    pub hide: &'a [crate::element_selection::ElementId],
    pub only: &'a [crate::element_selection::ElementId],
    pub clip: Option<SnapshotClip>,
    pub format: SnapshotFormat,
    pub background: SnapshotBackground,
    pub markers: bool,
    /// Crop the image to the pixels something was drawn on (on a
    /// transparent ground; a paper ground is never trimmed).
    pub trim: bool,
    /// Engine ADR 10XX — draw this story alone instead of the page's items
    /// (`only` is then ignored).
    pub story: Option<&'a SnapshotStory>,
}

impl<'a> SnapshotRequest<'a> {
    /// A v1 request: a whole page as a PNG on paper.
    pub fn page(page_id: &'a PageId, target_width_px: u32) -> Self {
        Self {
            page_id,
            target_width_px,
            dpi: None,
            hide: &[],
            only: &[],
            clip: None,
            format: SnapshotFormat::Png,
            background: SnapshotBackground::Paper,
            markers: false,
            trim: false,
            story: None,
        }
    }

    /// Asks for nothing past v1 (`hideItems`, `dpi`, `markers` are v1):
    /// the GPU snapshot path draws exactly these.
    pub fn is_v1(&self) -> bool {
        self.only.is_empty()
            && self.story.is_none()
            && self.clip.is_none()
            && !self.trim
            && self.format == SnapshotFormat::Png
            && self.background == SnapshotBackground::Paper
    }
}

#[derive(Debug, Clone, Error, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi, missing_as_null)]
#[serde(rename_all = "camelCase", tag = "kind", content = "details")]
pub enum SnapshotError {
    #[error("unknown page id: {page_id}")]
    UnknownPage { page_id: PageId },
    #[error("png encoding failed: {0}")]
    PngEncode(String),
    #[error("invalid target width: {0}")]
    InvalidWidth(u32),
    /// Extensions ADR 338 — a `clip` with a non-finite value or no area.
    #[error("invalid clip rectangle")]
    InvalidClip,
    /// Extensions ADR 338 — the image would be wider or taller than
    /// [`MAX_SNAPSHOT_SIDE_PX`].
    #[error("snapshot too large: {width_px} x {height_px} px")]
    TooLarge { width_px: u32, height_px: u32 },
    /// Extensions ADR 338 — `trim` found nothing drawn (the items are not
    /// on this page, or draw nothing).
    #[error("nothing drawn")]
    NothingDrawn,
}

/// Render `page_id` at `target_width_px` wide. Height is derived
/// from the page's aspect ratio. Background is white (matching the
/// renderer's default for `render_document`).
///
/// This draws the canvas's own page, editor-only markers included (ADR
/// 205): it backs the worker's tile loop. A snapshot for anything else
/// goes through [`render_snapshot_png_hiding`] / [`snapshot_page`].
#[cfg(feature = "cpu")]
pub fn render_snapshot(
    model: &CanvasModel,
    page_id: &PageId,
    target_width_px: u32,
) -> Result<Snapshot, SnapshotError> {
    render_snapshot_inner(model, page_id, SnapshotSize::WidthPx(target_width_px))
}

/// Render `page_id` at a specific DPI. Both width and height fall out
/// of the renderer's `RasterOptions` rounding (`ceil(width_pt × dpi / 72)`),
/// so the resulting PNG matches `paged-inspect --dpi <dpi>` exactly —
/// crucial for fidelity diffs against `pdftoppm -r <dpi>`.
#[cfg(feature = "cpu")]
pub fn render_snapshot_at_dpi(
    model: &CanvasModel,
    page_id: &PageId,
    dpi: f32,
) -> Result<Snapshot, SnapshotError> {
    if !(dpi.is_finite() && dpi > 0.0) {
        return Err(SnapshotError::InvalidWidth(0));
    }
    render_snapshot_inner(model, page_id, SnapshotSize::Dpi(dpi))
}

/// The page a snapshot draws: the model's own, a copy built with items
/// hidden, or a page of the export build (ADR 205).
pub enum SnapshotPage<'a> {
    Built(&'a BuiltPage),
    Hiding(Box<BuiltPage>),
    /// Page `.1` of the model's export build: the page without the
    /// canvas's editor-only markers.
    Export(std::rc::Rc<paged_renderer::BuiltDocument>, usize),
}

impl std::ops::Deref for SnapshotPage<'_> {
    type Target = BuiltPage;
    fn deref(&self) -> &BuiltPage {
        match self {
            SnapshotPage::Built(p) => p,
            SnapshotPage::Hiding(p) => p,
            SnapshotPage::Export(doc, i) => &doc.pages[*i],
        }
    }
}

/// What a `RequestSnapshot` draws and at what dpi — the one resolution
/// both snapshot backends use. An explicit `dpi` (> 0) wins over
/// `target_width_px`, which sets the dpi from the page width; `hide`
/// draws the page without those items (a slideshow build step) and a
/// non-empty `only` (extensions ADR 338) with nothing but those items.
///
/// ADR 205 — `markers` says whose page it is. `false` (the wire's
/// default) draws the page as the exports do: without the canvas's
/// editor-only markers (the pink substituted-font highlight, the
/// ghost-cross over undrawable EPS/PDF), in the working space and at
/// full resource resolution. When the live build already draws that,
/// its page is used; otherwise the model's export build is. `true`
/// draws the page the canvas shows, markers and soft proof included (a
/// page thumbnail). A page with items hidden is always built for
/// export, so `markers` changes nothing there.
pub fn snapshot_page<'a>(
    model: &'a CanvasModel,
    page_id: &PageId,
    target_width_px: u32,
    dpi: Option<f32>,
    hide: &[crate::element_selection::ElementId],
    only: &[crate::element_selection::ElementId],
    markers: bool,
) -> Result<(SnapshotPage<'a>, f32), SnapshotError> {
    snapshot_page_with_story(
        model,
        page_id,
        target_width_px,
        dpi,
        hide,
        only,
        markers,
        None,
    )
}

/// [`snapshot_page`], or — with `story` (engine ADR 10XX) — the page with
/// nothing on it but that story, laid out in a copy of the document.
#[allow(clippy::too_many_arguments)]
pub fn snapshot_page_with_story<'a>(
    model: &'a CanvasModel,
    page_id: &PageId,
    target_width_px: u32,
    dpi: Option<f32>,
    hide: &[crate::element_selection::ElementId],
    only: &[crate::element_selection::ElementId],
    markers: bool,
    story: Option<&SnapshotStory>,
) -> Result<(SnapshotPage<'a>, f32), SnapshotError> {
    let unknown = || SnapshotError::UnknownPage {
        page_id: page_id.clone(),
    };
    let page = if let Some(story) = story {
        if !story.is_valid() {
            return Err(SnapshotError::InvalidClip);
        }
        SnapshotPage::Hiding(Box::new(
            model
                .build_page_with_story(page_id, story)
                .map_err(|_| unknown())?,
        ))
    } else if !hide.is_empty() || !only.is_empty() {
        SnapshotPage::Hiding(Box::new(
            model
                .build_page_filtered(page_id, hide, only)
                .map_err(|_| unknown())?,
        ))
    } else if markers || model.live_build_is_export_faithful() {
        SnapshotPage::Built(model.page(page_id).ok_or_else(unknown)?)
    } else {
        let doc = model.export_build().map_err(|_| unknown())?;
        let i = doc
            .pages
            .iter()
            .position(|p| &p.id == page_id)
            .ok_or_else(unknown)?;
        SnapshotPage::Export(doc, i)
    };
    let dpi = match dpi {
        Some(d) if d > 0.0 && d.is_finite() => d,
        _ if target_width_px == 0 => return Err(SnapshotError::InvalidWidth(0)),
        _ => (target_width_px as f32) / page.width_pt * 72.0,
    };
    Ok((page, dpi))
}

/// A `RequestSnapshot` on the CPU rasterizer: the page [`snapshot_page`]
/// resolves (v70 `hide` items hidden, ADR 205 `markers`), PNG-encoded.
/// `dpi` wins over `target_width_px` when given.
#[cfg(feature = "cpu")]
pub fn render_snapshot_png_hiding(
    model: &CanvasModel,
    page_id: &PageId,
    target_width_px: u32,
    dpi: Option<f32>,
    hide: &[crate::element_selection::ElementId],
    markers: bool,
) -> Result<SnapshotPng, SnapshotError> {
    render_snapshot_request(
        model,
        &SnapshotRequest {
            dpi,
            hide,
            markers,
            ..SnapshotRequest::page(page_id, target_width_px)
        },
    )
}

/// A `RequestSnapshot` on the CPU rasterizer, every option honoured
/// (extensions ADR 338):
///
/// - `only` draws nothing but those items (see
///   [`CanvasModel::build_page_filtered`]);
/// - `clip` draws that page region alone, grown outward to whole pixels
///   (the reply's `region`); `target_width_px` is then the REGION's width,
///   unless `dpi` is given;
/// - `background: Transparent` leaves uncovered pixels transparent;
/// - `format: Rgba` replies with straight-alpha RGBA8 instead of a PNG
///   (a PNG of a transparent snapshot is straight alpha too);
/// - `trim` (on a transparent ground) crops to the drawn pixels: what an
///   item covers with its stroke and effects, which no geometry read
///   reports. The reply's `region` is then the trimmed one.
#[cfg(feature = "cpu")]
pub fn render_snapshot_request(
    model: &CanvasModel,
    req: &SnapshotRequest<'_>,
) -> Result<SnapshotPng, SnapshotError> {
    let explicit_dpi = req.dpi.filter(|d| *d > 0.0 && d.is_finite());
    // A story without a clip draws its frame's box (engine ADR 10XX).
    let clip = req.clip.or_else(|| {
        req.story.map(|s| {
            let [t, l, b, r] = s.bounds;
            SnapshotClip {
                x: l,
                y: t,
                width: r - l,
                height: b - t,
            }
        })
    });
    let dpi = match (explicit_dpi, clip) {
        (_, Some(c)) if !c.is_valid() => return Err(SnapshotError::InvalidClip),
        (Some(d), _) => Some(d),
        (None, Some(_)) if req.target_width_px == 0 => return Err(SnapshotError::InvalidWidth(0)),
        (None, Some(c)) => Some(req.target_width_px as f32 / c.width * 72.0),
        (None, None) => None,
    };
    let (page, dpi) = snapshot_page_with_story(
        model,
        req.page_id,
        req.target_width_px,
        dpi,
        req.hide,
        req.only,
        req.markers,
        req.story,
    )?;
    let transparent = req.background == SnapshotBackground::Transparent;
    let background = if transparent {
        paged_compose::Color {
            r: 0.0,
            g: 0.0,
            b: 0.0,
            a: 0.0,
        }
    } else {
        paged_compose::Color::WHITE
    };
    let scale = dpi / 72.0;
    let fits = |w: u32, h: u32| {
        if w > MAX_SNAPSHOT_SIDE_PX || h > MAX_SNAPSHOT_SIDE_PX {
            Err(SnapshotError::TooLarge {
                width_px: w,
                height_px: h,
            })
        } else {
            Ok(())
        }
    };
    let (img, region) = match clip {
        None => {
            let px = |pt: f32| ((pt * scale).ceil().max(1.0)) as u32;
            fits(px(page.width_pt), px(page.height_pt))?;
            (render_built_page(&page, dpi, background), None)
        }
        Some(c) => {
            let (x0, y0) = ((c.x * scale).floor(), (c.y * scale).floor());
            let (x1, y1) = (
                ((c.x + c.width) * scale).ceil(),
                ((c.y + c.height) * scale).ceil(),
            );
            let (w, h) = (((x1 - x0) as u32).max(1), ((y1 - y0) as u32).max(1));
            fits(w, h)?;
            let origin = (x0 / scale, y0 / scale);
            let img =
                paged_renderer::render_built_page_region(&page, origin, (w, h), dpi, background);
            let region = SnapshotClip {
                x: origin.0,
                y: origin.1,
                width: w as f32 / scale,
                height: h as f32 / scale,
            };
            (img, Some(region))
        }
    };
    let (img, region) = if req.trim && transparent {
        let (img, (dx, dy)) = trim_to_drawn(img).ok_or(SnapshotError::NothingDrawn)?;
        let base = region.unwrap_or(SnapshotClip {
            x: 0.0,
            y: 0.0,
            width: 0.0,
            height: 0.0,
        });
        let region = SnapshotClip {
            x: base.x + dx as f32 / scale,
            y: base.y + dy as f32 / scale,
            width: img.width() as f32 / scale,
            height: img.height() as f32 / scale,
        };
        (img, Some(region))
    } else {
        (img, region)
    };
    let (width_px, height_px) = (img.width(), img.height());
    let mut rgba = img.into_raw();
    if transparent {
        unpremultiply(&mut rgba);
    }
    let snap = Snapshot {
        page_id: req.page_id.clone(),
        width_px,
        height_px,
        layout_generation: page.layout_generation,
        numbering_generation: page.numbering_generation,
        rgba,
    };
    let mut reply = match req.format {
        SnapshotFormat::Png => encode_snapshot_png(snap)?,
        SnapshotFormat::Rgba => SnapshotPng {
            page_id: snap.page_id,
            width_px: snap.width_px,
            height_px: snap.height_px,
            layout_generation: snap.layout_generation,
            numbering_generation: snap.numbering_generation,
            png_bytes: Vec::new(),
            format: SnapshotFormat::Rgba,
            rgba: snap.rgba,
            region: None,
            story: false,
        },
    };
    reply.region = region;
    reply.story = req.story.is_some();
    Ok(reply)
}

/// The smallest part of `img` holding every pixel with alpha, and its
/// top-left corner in `img`; `None` when no pixel has any.
#[cfg(feature = "cpu")]
fn trim_to_drawn(img: image::RgbaImage) -> Option<(image::RgbaImage, (u32, u32))> {
    let (w, h) = (img.width(), img.height());
    let (mut x0, mut y0, mut x1, mut y1) = (w, h, 0, 0);
    for (x, y, p) in img.enumerate_pixels() {
        if p.0[3] > 0 {
            x0 = x0.min(x);
            y0 = y0.min(y);
            x1 = x1.max(x + 1);
            y1 = y1.max(y + 1);
        }
    }
    if x0 >= x1 || y0 >= y1 {
        return None;
    }
    if (x0, y0, x1, y1) == (0, 0, w, h) {
        return Some((img, (0, 0)));
    }
    let cropped = image::imageops::crop_imm(&img, x0, y0, x1 - x0, y1 - y0).to_image();
    Some((cropped, (x0, y0)))
}

/// Premultiplied RGBA8 (what the rasterizer leaves on a transparent
/// ground) to straight alpha, in place.
#[cfg(feature = "cpu")]
fn unpremultiply(rgba: &mut [u8]) {
    for px in rgba.as_chunks_mut::<4>().0 {
        let a = px[3] as u32;
        if a == 0 {
            px[..3].fill(0);
        } else if a < 255 {
            for c in &mut px[..3] {
                *c = ((*c as u32 * 255 + a / 2) / a).min(255) as u8;
            }
        }
    }
}

#[cfg(feature = "cpu")]
enum SnapshotSize {
    WidthPx(u32),
    Dpi(f32),
}

#[cfg(feature = "cpu")]
fn render_snapshot_inner(
    model: &CanvasModel,
    page_id: &PageId,
    size: SnapshotSize,
) -> Result<Snapshot, SnapshotError> {
    let page = model
        .page(page_id)
        .ok_or_else(|| SnapshotError::UnknownPage {
            page_id: page_id.clone(),
        })?;
    let dpi = match size {
        SnapshotSize::WidthPx(0) => return Err(SnapshotError::InvalidWidth(0)),
        SnapshotSize::WidthPx(w) => (w as f32) / page.width_pt * 72.0,
        SnapshotSize::Dpi(d) => d,
    };
    let img = render_built_page(page, dpi, paged_compose::Color::WHITE);

    Ok(Snapshot {
        page_id: page_id.clone(),
        width_px: img.width(),
        height_px: img.height(),
        layout_generation: page.layout_generation,
        numbering_generation: page.numbering_generation,
        rgba: img.into_raw(),
    })
}

/// Convenience: render + PNG-encode in one call. The worker uses
/// this on a `RequestSnapshot` message so the PNG bytes can ride
/// directly into the `SnapshotReady` reply.
#[cfg(feature = "cpu")]
pub fn render_snapshot_png(
    model: &CanvasModel,
    page_id: &PageId,
    target_width_px: u32,
) -> Result<SnapshotPng, SnapshotError> {
    let snap = render_snapshot(model, page_id, target_width_px)?;
    encode_snapshot_png(snap)
}

/// Same as `render_snapshot_png` but takes DPI directly. Use this
/// when the caller already has an explicit DPI (e.g. a fidelity
/// suite matching `pdftoppm -r <dpi>` output) and wants to avoid the
/// round-trip through `target_width_px` that drifts by sub-pixel.
#[cfg(feature = "cpu")]
pub fn render_snapshot_png_at_dpi(
    model: &CanvasModel,
    page_id: &PageId,
    dpi: f32,
) -> Result<SnapshotPng, SnapshotError> {
    let snap = render_snapshot_at_dpi(model, page_id, dpi)?;
    encode_snapshot_png(snap)
}

/// PNG-encode a snapshot for the `SnapshotReady` reply.
pub fn encode_snapshot_png(snap: Snapshot) -> Result<SnapshotPng, SnapshotError> {
    let mut png_bytes = Vec::with_capacity((snap.width_px * snap.height_px) as usize);
    PngEncoder::new(&mut png_bytes)
        .write_image(
            &snap.rgba,
            snap.width_px,
            snap.height_px,
            image::ExtendedColorType::Rgba8,
        )
        .map_err(|e| SnapshotError::PngEncode(e.to_string()))?;
    Ok(SnapshotPng {
        page_id: snap.page_id,
        width_px: snap.width_px,
        height_px: snap.height_px,
        layout_generation: snap.layout_generation,
        numbering_generation: snap.numbering_generation,
        png_bytes,
        format: SnapshotFormat::Png,
        rgba: Vec::new(),
        region: None,
        story: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{CanvasModel, CanvasOptions};

    // Re-use the minimal IDML fixture from model.rs's tests.
    fn minimal_idml_bytes() -> Vec<u8> {
        use std::io::Write;
        let mut buf = Vec::new();
        {
            let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            let opts: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);

            zip.start_file("mimetype", opts).unwrap();
            zip.write_all(b"application/vnd.adobe.indesign-idml-package")
                .unwrap();

            zip.start_file("META-INF/container.xml", opts).unwrap();
            zip.write_all(
                br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="designmap.xml" media-type="text/xml"/></rootfiles></container>"#,
            )
            .unwrap();

            zip.start_file("designmap.xml", opts).unwrap();
            zip.write_all(
                br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<?aid style="50" type="document" readerVersion="13.0" featureSet="513" product="13.1(255)"?>
<Document DOMVersion="13.1" Self="d1">
<idPkg:Spread src="Spreads/Spread_s1.xml" xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"/>
</Document>"#,
            )
            .unwrap();

            zip.start_file("Spreads/Spread_s1.xml", opts).unwrap();
            zip.write_all(
                br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<idPkg:Spread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="13.1">
<Spread Self="s1" PageCount="1">
<Page Self="p1" Name="1" GeometricBounds="0 0 792 612" ItemTransform="1 0 0 1 0 0"/>
</Spread></idPkg:Spread>"#,
            )
            .unwrap();

            zip.finish().unwrap();
        }
        buf
    }

    fn load_model() -> CanvasModel {
        let bytes = minimal_idml_bytes();
        CanvasModel::load("doc-1", &bytes, CanvasOptions::default()).unwrap()
    }

    #[test]
    fn snapshot_dimensions_track_target_width() {
        let model = load_model();
        let pid = PageId("p1".into());
        let snap = render_snapshot(&model, &pid, 256).expect("snapshot ok");
        assert_eq!(snap.width_px, 256);
        // Letter aspect: 612 / 792. Height should be ≈ 256 * 792/612 = 331.3.
        // Renderer rounds; expect 331 or 332.
        assert!(
            (snap.height_px as i32 - 331).abs() <= 1,
            "expected ~331 height, got {}",
            snap.height_px
        );
        assert_eq!(
            snap.rgba.len(),
            (snap.width_px * snap.height_px * 4) as usize
        );
        assert_eq!(snap.page_id.as_str(), "p1");
        assert_eq!(snap.layout_generation, 0);
        assert_eq!(snap.numbering_generation, 0);
    }

    #[test]
    fn snapshot_background_is_white_for_empty_page() {
        let model = load_model();
        let pid = PageId("p1".into());
        let snap = render_snapshot(&model, &pid, 64).unwrap();
        // No frames on the page -> background fill should be the
        // entire bitmap. Each pixel = (255, 255, 255, 255).
        let centre = ((snap.height_px / 2 * snap.width_px + snap.width_px / 2) * 4) as usize;
        assert_eq!(&snap.rgba[centre..centre + 4], &[255, 255, 255, 255]);
    }

    #[test]
    fn unknown_page_returns_typed_error() {
        let model = load_model();
        let err = render_snapshot(&model, &PageId("nope".into()), 256).unwrap_err();
        match err {
            SnapshotError::UnknownPage { page_id } => assert_eq!(page_id.as_str(), "nope"),
            other => panic!("expected UnknownPage, got {other:?}"),
        }
    }

    #[test]
    fn zero_width_rejected() {
        let model = load_model();
        let err = render_snapshot(&model, &PageId("p1".into()), 0).unwrap_err();
        assert!(matches!(err, SnapshotError::InvalidWidth(0)));
    }

    #[test]
    fn png_encoding_produces_decodable_bytes() {
        let model = load_model();
        let snap = render_snapshot_png(&model, &PageId("p1".into()), 128).unwrap();
        assert!(snap.png_bytes.starts_with(&[0x89, b'P', b'N', b'G']));
        // Round-trip: image::load_from_memory should produce the same dimensions.
        let decoded = image::load_from_memory(&snap.png_bytes).unwrap();
        assert_eq!(decoded.width(), snap.width_px);
        assert_eq!(decoded.height(), snap.height_px);
    }
}

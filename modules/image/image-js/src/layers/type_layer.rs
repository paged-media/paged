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

//! TYPE LAYERS (WP5.10, image ADR 474): a layer whose pixels are the
//! render of a text source — its text, character runs, paragraphs, point
//! or box frame and Warp Text — that stays editable.
//!
//! The text is laid out and drawn by the ENGINE (`host.render.story`,
//! extensions ADR 342: paged-text's composer, justification and
//! hyphenation with the document's fonts), not here: the bundle renders a
//! [`TypeSource`] and hands this module the pixels, which a non-identity
//! warp then bends on the GPU (`geom.warp_mesh` over `paged-warp`'s mesh).
//! Like a fill layer the pixels composite as pixels; like a smart object
//! they are a cached render of a source.
//!
//! A type layer read from a PSD keeps Photoshop's own render and its
//! `TySh` block until it is edited, so an untouched layer is written back
//! byte for byte.

use std::sync::Arc;

use serde::{Deserialize, Serialize};

/// The source of a type layer. Lengths are canvas pixels; run lengths are
/// UTF-16 code units of `text`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeSource {
    /// Paragraphs separated by `\n`; a forced line break is U+2028.
    pub text: String,
    #[serde(default)]
    pub runs: Vec<TypeRun>,
    /// One per paragraph; a missing one repeats the last.
    #[serde(default)]
    pub paragraphs: Vec<TypeParagraph>,
    pub frame: TypeFrame,
    #[serde(default)]
    pub warp: TypeWarp,
    /// Photoshop's anti-alias method key (`AnCr`, `AnSh`, …), kept for the
    /// write-back.
    #[serde(default = "default_antialias")]
    pub antialias: String,
}

fn default_antialias() -> String {
    "AnCr".into()
}

/// Where the text sits (canvas px).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TypeFrame {
    /// POINT type: `(x, y)` is the first line's baseline at its alignment
    /// point (left, centre or right edge of the line). No wrapping.
    Point { x: f64, y: f64 },
    /// PARAGRAPH type: a box; lines wrap at its width.
    Box {
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    },
}

impl TypeFrame {
    pub fn translate(&mut self, dx: f64, dy: f64) {
        match self {
            TypeFrame::Point { x, y } | TypeFrame::Box { x, y, .. } => {
                *x += dx;
                *y += dy;
            }
        }
    }
}

/// One character run.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TypeRun {
    /// UTF-16 code units; the last run covers the rest of the text.
    pub length: usize,
    /// Family name.
    pub font: String,
    pub style: Option<String>,
    /// The PostScript name the run came with (a PSD's), written back.
    pub postscript: Option<String>,
    /// Size, px.
    pub size: f64,
    pub color: [u8; 3],
    /// 1/1000 em.
    pub tracking: f64,
    /// px; `None` is auto.
    pub leading: Option<f64>,
    pub baseline_shift: f64,
    /// 1.0 = 100 %.
    pub horizontal_scale: f64,
    pub vertical_scale: f64,
    pub underline: bool,
    pub strikethrough: bool,
    pub ligatures: bool,
    /// `normal`, `smallCaps` or `allCaps`.
    pub caps: String,
    /// `normal`, `superscript` or `subscript`.
    pub position: String,
    pub faux_bold: bool,
    pub faux_italic: bool,
}

impl Default for TypeRun {
    fn default() -> Self {
        Self {
            length: 0,
            font: "Myriad Pro".into(),
            style: None,
            postscript: None,
            size: 24.0,
            color: [0, 0, 0],
            tracking: 0.0,
            leading: None,
            baseline_shift: 0.0,
            horizontal_scale: 1.0,
            vertical_scale: 1.0,
            underline: false,
            strikethrough: false,
            ligatures: true,
            caps: "normal".into(),
            position: "normal".into(),
            faux_bold: false,
            faux_italic: false,
        }
    }
}

/// One paragraph's settings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TypeParagraph {
    /// `left`, `center`, `right`, `justifyLeft`, `justifyCenter`,
    /// `justifyRight` or `justifyAll`.
    pub align: String,
    pub hyphenate: bool,
    pub first_line_indent: f64,
    pub left_indent: f64,
    pub right_indent: f64,
    pub space_before: f64,
    pub space_after: f64,
}

impl Default for TypeParagraph {
    fn default() -> Self {
        Self {
            align: "left".into(),
            hyphenate: true,
            first_line_indent: 0.0,
            left_indent: 0.0,
            right_indent: 0.0,
            space_before: 0.0,
            space_after: 0.0,
        }
    }
}

/// Warp Text: a `paged-warp` style name, bend and distortions (−1 to 1).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TypeWarp {
    pub style: String,
    pub bend: f64,
    pub horizontal: f64,
    pub vertical: f64,
    /// Bend along the height (Photoshop's Vertical orientation).
    pub rotate_vertical: bool,
}

impl Default for TypeWarp {
    fn default() -> Self {
        Self {
            style: "none".into(),
            bend: 0.0,
            horizontal: 0.0,
            vertical: 0.0,
            rotate_vertical: false,
        }
    }
}

impl TypeWarp {
    /// As `paged-warp`'s warp (an unknown style is none).
    pub fn to_warp(&self) -> paged_warp::envelope::Warp {
        paged_warp::envelope::Warp {
            style: paged_warp::envelope::WarpStyle::from_name(&self.style)
                .unwrap_or(paged_warp::envelope::WarpStyle::None),
            bend: self.bend.clamp(-1.0, 1.0),
            horizontal_distortion: self.horizontal.clamp(-1.0, 1.0),
            vertical_distortion: self.vertical.clamp(-1.0, 1.0),
            vertical: self.rotate_vertical,
        }
    }
}

/// A type layer: its source, and what its pixels are.
#[derive(Debug, Clone, PartialEq)]
pub struct TypeLayer {
    pub source: TypeSource,
    /// The pixels no longer show `source` (a canvas op moved or scaled
    /// it); the bundle re-renders it.
    pub stale: bool,
    /// The `TySh` block (signature to padding) a PSD gave this layer,
    /// while it is unedited.
    pub psd: Option<Arc<[u8]>>,
}

impl TypeSource {
    /// Parse the bundle's JSON.
    pub fn from_json(s: &str) -> Result<Self, String> {
        let src: TypeSource = serde_json::from_str(s).map_err(|e| format!("type source: {e}"))?;
        src.check()?;
        Ok(src)
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("a type source serializes")
    }

    fn check(&self) -> Result<(), String> {
        let finite = |v: f64| v.is_finite();
        let frame_ok = match self.frame {
            TypeFrame::Point { x, y } => finite(x) && finite(y),
            TypeFrame::Box {
                x,
                y,
                width,
                height,
            } => finite(x) && finite(y) && width > 0.0 && height > 0.0,
        };
        if !frame_ok {
            return Err("type source: the frame must be finite (a box with an area)".into());
        }
        if self
            .runs
            .iter()
            .any(|r| !(r.size.is_finite() && r.size > 0.0))
        {
            return Err("type source: every run needs a positive size".into());
        }
        Ok(())
    }

    /// The source scaled by `k` (Image Size): sizes, leading, indents and
    /// the frame.
    pub fn scaled(&self, kx: f64, ky: f64) -> TypeSource {
        let k = (kx * ky).abs().sqrt();
        let mut s = self.clone();
        for r in &mut s.runs {
            r.size *= k;
            r.leading = r.leading.map(|l| l * k);
            r.baseline_shift *= k;
        }
        for p in &mut s.paragraphs {
            p.first_line_indent *= k;
            p.left_indent *= k;
            p.right_indent *= k;
            p.space_before *= k;
            p.space_after *= k;
        }
        s.frame = match s.frame {
            TypeFrame::Point { x, y } => TypeFrame::Point {
                x: x * kx,
                y: y * ky,
            },
            TypeFrame::Box {
                x,
                y,
                width,
                height,
            } => TypeFrame::Box {
                x: x * kx,
                y: y * ky,
                width: width * kx,
                height: height * ky,
            },
        };
        s
    }

    // ───────────────────────────── PSD ─────────────────────────────

    /// From a PSD type layer (`TySh`). The transform's translation places
    /// the frame; its scale multiplies the sizes (a rotation or shear is
    /// not modelled: re-rendering draws the text upright).
    pub fn from_psd(t: &image_psd::text_layer::TypeLayer) -> TypeSource {
        let [xx, xy, yx, yy, tx, ty] = t.transform;
        let k = (xx * yy - xy * yx).abs().sqrt();
        let k = if k.is_finite() && k > 0.0 { k } else { 1.0 };
        let text = t.text.replace('\r', "\n");
        let total = text.encode_utf16().count();
        let mut runs: Vec<TypeRun> = t
            .runs
            .iter()
            .map(|r| {
                let (font, style) = split_postscript(&r.font);
                TypeRun {
                    length: r.length,
                    font,
                    style: Some(style),
                    postscript: Some(r.font.clone()),
                    size: r.size * k,
                    color: r.color,
                    tracking: r.tracking,
                    leading: (!r.auto_leading).then_some(r.leading * k),
                    baseline_shift: r.baseline_shift * k,
                    horizontal_scale: r.horizontal_scale,
                    vertical_scale: r.vertical_scale,
                    underline: r.underline,
                    strikethrough: r.strikethrough,
                    ligatures: r.ligatures,
                    caps: match r.caps {
                        1 => "smallCaps",
                        2 => "allCaps",
                        _ => "normal",
                    }
                    .into(),
                    position: match r.baseline {
                        1 => "superscript",
                        2 => "subscript",
                        _ => "normal",
                    }
                    .into(),
                    faux_bold: r.faux_bold,
                    faux_italic: r.faux_italic,
                }
            })
            .collect();
        clamp_lengths(&mut runs, total);
        // The engine's paragraph runs cover whole paragraphs (and their
        // marks): one setting per paragraph, in order.
        let paragraphs = t
            .paragraphs
            .iter()
            .flat_map(|p| {
                let para = TypeParagraph {
                    align: match p.justification {
                        1 => "right",
                        2 => "center",
                        3 => "justifyLeft",
                        4 => "justifyRight",
                        5 => "justifyCenter",
                        6 => "justifyAll",
                        _ => "left",
                    }
                    .into(),
                    hyphenate: p.auto_hyphenate,
                    first_line_indent: p.first_line_indent * k,
                    left_indent: p.start_indent * k,
                    right_indent: p.end_indent * k,
                    space_before: p.space_before * k,
                    space_after: p.space_after * k,
                };
                let marks = paragraph_marks(&t.text, p.length);
                std::iter::repeat_n(para, marks.max(1))
            })
            .collect();
        let frame = match t.shape {
            image_psd::text_layer::TextShape::Point => TypeFrame::Point { x: tx, y: ty },
            image_psd::text_layer::TextShape::Box { width, height } => TypeFrame::Box {
                x: tx,
                y: ty,
                width: width * xx.abs().max(1e-9),
                height: height * yy.abs().max(1e-9),
            },
        };
        let style = paged_warp::envelope::WarpStyle::from_psd(&t.warp.style)
            .unwrap_or(paged_warp::envelope::WarpStyle::None);
        TypeSource {
            text,
            runs,
            paragraphs,
            frame,
            warp: TypeWarp {
                style: style.name().into(),
                bend: t.warp.value / 100.0,
                horizontal: t.warp.perspective / 100.0,
                vertical: t.warp.perspective_other / 100.0,
                rotate_vertical: t.warp.vertical,
            },
            antialias: t.antialias.clone(),
        }
    }

    /// As a PSD type layer, `bounds` the drawn pixels relative to the
    /// frame origin (`[left, top, right, bottom]`).
    pub fn to_psd(&self, bounds: [f64; 4]) -> image_psd::text_layer::TypeLayer {
        use image_psd::text_layer as t;
        let text = self.text.replace('\n', "\r");
        let total = text.encode_utf16().count() + 1;
        let mut runs: Vec<t::TextStyleRun> = self
            .runs
            .iter()
            .map(|r| t::TextStyleRun {
                length: r.length,
                font: r
                    .postscript
                    .clone()
                    .unwrap_or_else(|| postscript_of(&r.font, r.style.as_deref())),
                size: r.size,
                color: r.color,
                faux_bold: r.faux_bold,
                faux_italic: r.faux_italic,
                auto_leading: r.leading.is_none(),
                leading: r.leading.unwrap_or(0.0),
                tracking: r.tracking,
                baseline_shift: r.baseline_shift,
                horizontal_scale: r.horizontal_scale,
                vertical_scale: r.vertical_scale,
                underline: r.underline,
                strikethrough: r.strikethrough,
                ligatures: r.ligatures,
                caps: match r.caps.as_str() {
                    "smallCaps" => 1,
                    "allCaps" => 2,
                    _ => 0,
                },
                baseline: match r.position.as_str() {
                    "superscript" => 1,
                    "subscript" => 2,
                    _ => 0,
                },
            })
            .collect();
        if runs.is_empty() {
            runs.push(t::TextStyleRun::default());
        }
        // The paragraph mark at the end belongs to the last run.
        clamp_lengths_psd(&mut runs, total);
        let mut paragraphs = Vec::new();
        for (i, para_text) in text.split('\r').enumerate() {
            let p = self
                .paragraphs
                .get(i)
                .or(self.paragraphs.last())
                .cloned()
                .unwrap_or_default();
            paragraphs.push(t::TextParagraphRun {
                length: para_text.encode_utf16().count() + 1,
                justification: match p.align.as_str() {
                    "right" => 1,
                    "center" => 2,
                    "justifyLeft" => 3,
                    "justifyRight" => 4,
                    "justifyCenter" => 5,
                    "justifyAll" => 6,
                    _ => 0,
                },
                first_line_indent: p.first_line_indent,
                start_indent: p.left_indent,
                end_indent: p.right_indent,
                space_before: p.space_before,
                space_after: p.space_after,
                auto_hyphenate: p.hyphenate,
            });
        }
        let (tx, ty, shape) = match self.frame {
            TypeFrame::Point { x, y } => (x, y, t::TextShape::Point),
            TypeFrame::Box {
                x,
                y,
                width,
                height,
            } => (x, y, t::TextShape::Box { width, height }),
        };
        let warp = self.warp.to_warp();
        t::TypeLayer {
            transform: [1.0, 0.0, 0.0, 1.0, tx, ty],
            text,
            runs,
            paragraphs,
            shape,
            warp: t::TextWarp {
                style: warp.style.psd_key().into(),
                value: warp.bend * 100.0,
                perspective: warp.horizontal_distortion * 100.0,
                perspective_other: warp.vertical_distortion * 100.0,
                vertical: warp.vertical,
            },
            antialias: self.antialias.clone(),
            vertical: false,
            bounds,
        }
    }
}

/// A layer record's `TySh` block (signature through padding) as a type
/// layer: its source and the block itself, kept for the write-back.
pub fn from_psd_record(record: &image_psd::model::LayerRecord) -> Option<TypeLayer> {
    let block = record
        .addl
        .iter()
        .find(|a| &a.key == b"TySh")?
        .raw_block
        .as_ref()?;
    // `8BIM TySh` and a 4-byte length, then the data.
    let len = u32::from_be_bytes(block.get(8..12)?.try_into().ok()?) as usize;
    let data = block.get(12..12 + len)?;
    let parsed = image_psd::text_layer::TypeLayer::parse(data).ok()?;
    Some(TypeLayer {
        source: TypeSource::from_psd(&parsed),
        stale: false,
        psd: Some(Arc::from(block.as_slice())),
    })
}

/// The `TySh` block a type layer writes: its PSD's own while unedited,
/// else this source written out (`bounds`: the drawn pixels relative to
/// the frame origin).
pub fn psd_block(t: &TypeLayer, bounds: [f64; 4]) -> image_psd::model::AdditionalLayerInfo {
    use image_psd::model::{AdditionalLayerInfo, AddlBody};
    let raw = match &t.psd {
        Some(b) => b.to_vec(),
        None => {
            let data = t.source.to_psd(bounds).to_block_data();
            let mut raw = Vec::with_capacity(data.len() + 12);
            raw.extend_from_slice(b"8BIMTySh");
            raw.extend_from_slice(&(data.len() as u32).to_be_bytes());
            raw.extend_from_slice(&data);
            raw
        }
    };
    AdditionalLayerInfo {
        sig: *b"8BIM",
        key: *b"TySh",
        body: AddlBody::Opaque,
        raw_block: Some(raw),
    }
}

/// The drawn pixels' box relative to the frame origin,
/// `[left, top, right, bottom]` (zero when nothing is drawn).
pub fn ink_bounds(rgba: &[u8], width: u32, height: u32, frame: &TypeFrame) -> [f64; 4] {
    let (mut x0, mut y0, mut x1, mut y1) = (u32::MAX, u32::MAX, 0u32, 0u32);
    for y in 0..height {
        for x in 0..width {
            if rgba[((y * width + x) * 4 + 3) as usize] > 0 {
                x0 = x0.min(x);
                y0 = y0.min(y);
                x1 = x1.max(x + 1);
                y1 = y1.max(y + 1);
            }
        }
    }
    if x0 > x1 {
        return [0.0; 4];
    }
    let (ox, oy) = match *frame {
        TypeFrame::Point { x, y } | TypeFrame::Box { x, y, .. } => (x, y),
    };
    [
        f64::from(x0) - ox,
        f64::from(y0) - oy,
        f64::from(x1) - ox,
        f64::from(y1) - oy,
    ]
}

/// A rendered window of type: `rgba` (straight RGBA8, `w × h`) whose
/// top-left sits at `(x, y)` on the canvas.
#[derive(Debug, Clone)]
pub struct TypeRender {
    pub rgba: Vec<u8>,
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
}

impl TypeRender {
    fn check(&self) -> Result<(), crate::ingest::IngestError> {
        if self.rgba.len() == self.w as usize * self.h as usize * 4 {
            Ok(())
        } else {
            Err(crate::ingest::IngestError::Decode(format!(
                "type render: {} bytes for {}×{}",
                self.rgba.len(),
                self.w,
                self.h
            )))
        }
    }

    /// Onto a transparent `cw × ch` canvas, clipped to it.
    pub fn place(&self, cw: u32, ch: u32) -> Result<Vec<u8>, crate::ingest::IngestError> {
        self.check()?;
        let mut out = vec![0u8; cw as usize * ch as usize * 4];
        for row in 0..self.h as i32 {
            let cy = self.y + row;
            if cy < 0 || cy >= ch as i32 {
                continue;
            }
            for col in 0..self.w as i32 {
                let cx = self.x + col;
                if cx < 0 || cx >= cw as i32 {
                    continue;
                }
                let s = ((row as u32 * self.w + col as u32) * 4) as usize;
                let d = ((cy as u32 * cw + cx as u32) * 4) as usize;
                out[d..d + 4].copy_from_slice(&self.rgba[s..s + 4]);
            }
        }
        Ok(out)
    }

    /// Bent through `warp` around its own box (Photoshop warps the text's
    /// bounds), on the GPU (`geom.warp_mesh`), then placed on the canvas.
    /// The identity warp is a plain placement.
    pub async fn warped(
        &self,
        ctx: Option<&image_gpu::GpuContext>,
        warp: &TypeWarp,
        cw: u32,
        ch: u32,
    ) -> Result<Vec<u8>, crate::ingest::IngestError> {
        use crate::ingest::IngestError;
        use paged_warp::envelope;
        self.check()?;
        let w = warp.to_warp();
        if w.is_identity() || self.w == 0 || self.h == 0 {
            return self.place(cw, ch);
        }
        let ctx = ctx.ok_or_else(|| {
            IngestError::Unsupported(
                "Warp Text runs on the GPU (geom.warp_mesh) — call init_gpu first".into(),
            )
        })?;
        let rect = envelope::Rect {
            x: f64::from(self.x),
            y: f64::from(self.y),
            w: f64::from(self.w),
            h: f64::from(self.h),
        };
        let mut mesh = envelope::mesh(&w, rect);
        let e = envelope::extent(&mesh);
        // The output window: the warped extent on the canvas.
        let x0 = e.x.floor().max(0.0) as i32;
        let y0 = e.y.floor().max(0.0) as i32;
        let x1 = ((e.x + e.w).ceil() as i32).min(cw as i32);
        let y1 = ((e.y + e.h).ceil() as i32).min(ch as i32);
        if x1 <= x0 || y1 <= y0 {
            return Ok(vec![0u8; cw as usize * ch as usize * 4]);
        }
        for p in &mut mesh {
            p[0] -= f64::from(x0);
            p[1] -= f64::from(y0);
        }
        let (ow, oh) = ((x1 - x0) as u32, (y1 - y0) as u32);
        // Associated alpha in, so the sampler interpolates against the
        // transparent outside exactly.
        let mut win = Vec::with_capacity(self.rgba.len() * 2);
        for px in self.rgba.as_chunks::<4>().0 {
            let a = f32::from(px[3]) / 255.0;
            for &v in &px[..3] {
                win.extend_from_slice(&half::f16::from_f32(f32::from(v) / 255.0 * a).to_le_bytes());
            }
            win.extend_from_slice(&half::f16::from_f32(a).to_le_bytes());
        }
        let params = image_kernels::families::warp::WarpMeshParams::new(&mesh, self.w, self.h);
        let out = image_gpu::execute_windowed_once_async(
            ctx,
            &image_kernels::families::warp::GEOM_WARP_MESH,
            &win,
            self.w,
            self.h,
            params.as_bytes(),
            None,
            ow,
            oh,
        )
        .await
        .map_err(|e| IngestError::Pipeline(e.to_string()))?;
        TypeRender {
            rgba: crate::fill::f16_to_rgba8_unpremul(&out),
            x: x0,
            y: y0,
            w: ow,
            h: oh,
        }
        .place(cw, ch)
    }
}

/// Paragraph marks (`\r`) a PSD paragraph run of `length` units covers,
/// counted from its start — approximated as one paragraph per run when
/// the run lengths do not line up with the text (they always do in
/// Photoshop's files).
fn paragraph_marks(text: &str, length: usize) -> usize {
    let _ = text;
    usize::from(length > 0)
}

/// Run lengths that sum to `total` (the last run takes the rest).
fn clamp_lengths(runs: &mut Vec<TypeRun>, total: usize) {
    let mut left = total;
    runs.retain(|r| r.length > 0);
    for r in runs.iter_mut() {
        r.length = r.length.min(left);
        left -= r.length;
    }
    runs.retain(|r| r.length > 0);
    if let Some(last) = runs.last_mut() {
        last.length += left;
    }
}

fn clamp_lengths_psd(runs: &mut [image_psd::text_layer::TextStyleRun], total: usize) {
    let mut left = total;
    let n = runs.len();
    for (i, r) in runs.iter_mut().enumerate() {
        if i + 1 == n {
            r.length = left;
        } else {
            r.length = r.length.min(left);
            left -= r.length;
        }
    }
}

/// A PostScript name as family and style: `MyriadPro-Regular` →
/// (`Myriad Pro`, `Regular`), `ArialMT` → (`Arial`, `Regular`),
/// `Arial-BoldMT` → (`Arial`, `Bold`).
pub fn split_postscript(ps: &str) -> (String, String) {
    let (fam, style) = ps.split_once('-').unwrap_or((ps, "Regular"));
    let strip = |s: &str| s.strip_suffix("MT").unwrap_or(s).to_string();
    let spaced = |s: &str| {
        let mut out = String::new();
        let chars: Vec<char> = s.chars().collect();
        for (i, c) in chars.iter().enumerate() {
            if i > 0 && c.is_uppercase() && chars[i - 1].is_lowercase() {
                out.push(' ');
            }
            out.push(*c);
        }
        out
    };
    let style = strip(style);
    (
        spaced(&strip(fam)),
        if style.is_empty() {
            "Regular".into()
        } else {
            spaced(&style)
        },
    )
}

/// The PostScript name a family and style are written under when no
/// file named one: spaces dropped, `Family-Style`.
pub fn postscript_of(family: &str, style: Option<&str>) -> String {
    let fam: String = family.split_whitespace().collect();
    let style: String = style.unwrap_or("Regular").split_whitespace().collect();
    format!("{fam}-{style}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source() -> TypeSource {
        TypeSource {
            text: "Hello\nWorld".into(),
            runs: vec![
                TypeRun {
                    length: 6,
                    font: "Myriad Pro".into(),
                    style: Some("Regular".into()),
                    size: 30.0,
                    color: [200, 10, 20],
                    ..TypeRun::default()
                },
                TypeRun {
                    length: 5,
                    font: "Myriad Pro".into(),
                    style: Some("Bold".into()),
                    size: 30.0,
                    underline: true,
                    ..TypeRun::default()
                },
            ],
            paragraphs: vec![
                TypeParagraph {
                    align: "center".into(),
                    ..TypeParagraph::default()
                },
                TypeParagraph::default(),
            ],
            frame: TypeFrame::Box {
                x: 10.0,
                y: 20.0,
                width: 300.0,
                height: 100.0,
            },
            warp: TypeWarp {
                style: "arc".into(),
                bend: 0.5,
                ..TypeWarp::default()
            },
            antialias: "AnSm".into(),
        }
    }

    #[test]
    fn json_round_trips_and_defaults_fill_in() {
        let s = source();
        assert_eq!(TypeSource::from_json(&s.to_json()).unwrap(), s);
        let minimal = TypeSource::from_json(
            r#"{"text":"Hi","frame":{"kind":"point","x":4,"y":40},"runs":[{"length":2,"font":"Inter","size":12}]}"#,
        )
        .unwrap();
        assert_eq!(minimal.runs[0].horizontal_scale, 1.0);
        assert_eq!(minimal.warp.style, "none");
        assert!(TypeSource::from_json(
            r#"{"text":"x","frame":{"kind":"box","x":0,"y":0,"width":0,"height":5}}"#
        )
        .is_err());
    }

    #[test]
    #[allow(non_snake_case)]
    fn a_type_source_goes_through_a_psd_type_layer_and_back__feat__image_layers_type() {
        let s = source();
        let psd = s.to_psd([0.0, 0.0, 300.0, 100.0]);
        let bytes = psd.to_block_data();
        let back = image_psd::text_layer::TypeLayer::parse(&bytes).unwrap();
        let again = TypeSource::from_psd(&back);
        assert_eq!(again.text, s.text);
        assert_eq!(again.frame, s.frame);
        assert_eq!(again.warp, s.warp);
        assert_eq!(again.runs.len(), 2);
        assert_eq!(again.runs[0].length, 6);
        assert_eq!(again.runs[1].length, 5);
        assert_eq!(again.runs[1].font, "Myriad Pro");
        assert_eq!(again.runs[1].style.as_deref(), Some("Bold"));
        assert!(again.runs[1].underline);
        assert_eq!(again.runs[0].color, [200, 10, 20]);
        assert_eq!(again.paragraphs[0].align, "center");
        assert_eq!(again.paragraphs[1].align, "left");
        assert_eq!(again.antialias, "AnSm");
    }

    #[test]
    fn postscript_names_split_into_family_and_style() {
        assert_eq!(
            split_postscript("MyriadPro-Regular"),
            ("Myriad Pro".into(), "Regular".into())
        );
        assert_eq!(
            split_postscript("ArialMT"),
            ("Arial".into(), "Regular".into())
        );
        assert_eq!(
            split_postscript("Arial-BoldMT"),
            ("Arial".into(), "Bold".into())
        );
        assert_eq!(
            postscript_of("Myriad Pro", Some("Semibold Italic")),
            "MyriadPro-SemiboldItalic"
        );
    }

    #[test]
    fn scaling_scales_sizes_and_the_frame() {
        let s = source().scaled(2.0, 2.0);
        assert_eq!(s.runs[0].size, 60.0);
        assert_eq!(
            s.frame,
            TypeFrame::Box {
                x: 20.0,
                y: 40.0,
                width: 600.0,
                height: 200.0
            }
        );
    }
}

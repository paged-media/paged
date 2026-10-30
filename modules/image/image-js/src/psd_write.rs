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

//! The LAYERED PSD save (image ADR 478): the session's layer stack
//! written as the file's layers, so the file reopens in Photoshop with
//! live layers.
//!
//! * A layer read from the file and NOT edited is written as the very
//!   record it was read from — every block, the channel payloads, byte for
//!   byte: text (`TySh`), smart objects (`PlLd`/`SoLd`/`SoLE`, their
//!   sources in the document's `lnk2`/`lnkE` blocks, which the save keeps),
//!   vector masks and shapes, metadata, and whatever paged does not model.
//! * An EDITED layer read from the file is that record with only the edited
//!   parts replaced: its name, opacity, blend, visibility, clipping, fill
//!   opacity, knockout, locks, colour label, Blend If, style, adjustment or
//!   fill content, mask and pixels. New pixels (or a rasterized kind) drop
//!   what described the old ones — text, smart object and shape blocks — so
//!   the layer reopens as the pixels it now has; a changed mask replaces the
//!   user and vector masks with the one mask the stack holds.
//! * A layer made in paged is built: pixels, masks, the typed adjustment
//!   (every kind Photoshop has a layer for, `paged-psd`'s
//!   `adjustment::Adjustment`), the fill content (colour and gradient; a
//!   pattern fill as its render), the style and the parity properties.
//! * The document keeps its depth and colour mode: an 8- or 16-bit RGB or
//!   CMYK document, PSD or PSB. A 16-bit document's layers are written into
//!   its `Lr16` block (ZIP with prediction, as Photoshop writes them) and
//!   its composite RAW; a CMYK document's new pixels are converted from the
//!   stack's sRGB through the document's profile (`paged_raster::
//!   srgb8_to_cmyk8`) and stored as ink (inverted, 255 = none).
//!
//! Refused (so the caller falls back to the flattened save and says why):
//! a Develop, Color Lookup or stored-chain adjustment layer (no Photoshop
//! adjustment layer of that form), an edited or new adjustment layer in a
//! CMYK document (the stack evaluates adjustments in RGB; Photoshop would
//! apply the block to inks), another colour mode or depth, a size mismatch.

use std::collections::HashSet;
use std::sync::Arc;

use image_core::Region;
use image_gpu::SelectionCoverage;
use image_psd::model::{
    AdditionalLayerInfo, AddlBody, BlendRanges, ChannelData, ChannelInfo, ColorMode, Compression,
    GlobalImageData, LayerMaskData, LayerRecord, LsctData, PascalString, PsdFile, SectionKind,
};
use image_psd::Container;

use crate::ingest::IngestError;
use crate::layers::{Layer, LayerKind, LayerMask, LayerStack};
use crate::psd_layer_ext::raw_block;
use crate::psd_source::{state_of, KindState, PsdSource};
use crate::saveback::PsdSaveBackShape;

fn err(e: image_psd::PsdError) -> IngestError {
    IngestError::Decode(e.to_string())
}

/// The PSD blend-mode key for a `compose.*` name — the inverse of
/// `layers::psd_blend_kernel` (same 26 modes, Adobe's keys).
pub fn psd_blend_key(name: &str) -> [u8; 4] {
    match name.strip_prefix("compose.").unwrap_or(name) {
        "multiply" => *b"mul ",
        "screen" => *b"scrn",
        "overlay" => *b"over",
        "darken" => *b"dark",
        "lighten" => *b"lite",
        "color_dodge" => *b"div ",
        "color_burn" => *b"idiv",
        "hard_light" => *b"hLit",
        "soft_light" => *b"sLit",
        "difference" => *b"diff",
        "exclusion" => *b"smud",
        "hue" => *b"hue ",
        "saturation" => *b"sat ",
        "color" => *b"colr",
        "luminosity" => *b"lum ",
        "linear_burn" => *b"lbrn",
        "linear_dodge" => *b"lddg",
        "darker_color" => *b"dkCl",
        "lighter_color" => *b"lgCl",
        "vivid_light" => *b"vLit",
        "linear_light" => *b"lLit",
        "pin_light" => *b"pLit",
        "hard_mix" => *b"hMix",
        "subtract" => *b"fsub",
        "divide" => *b"fdiv",
        _ => *b"norm",
    }
}

fn opacity_u8(o: f32) -> u8 {
    (o.clamp(0.0, 1.0) * 255.0).round() as u8
}

/// The blocks that make up an adjustment layer's adjustment, as record
/// blocks; `None` for a kind Photoshop has no layer for.
fn adjustment_blocks(a: &crate::layers::Adjustment) -> Option<Vec<AdditionalLayerInfo>> {
    let psd = crate::layers::adjustment_to_psd(a)?;
    Some(
        psd.to_blocks()
            .into_iter()
            .map(|(k, v)| raw_block(k, &v))
            .collect(),
    )
}

fn unwritable(l: &Layer, a: &crate::layers::Adjustment) -> IngestError {
    IngestError::Unsupported(format!(
        "adjustment layer \"{}\" is a {} layer, which is not written as a PSD adjustment layer \
         (Photoshop has no adjustment layer of that form)",
        l.name,
        a.default_layer_name()
    ))
}

// ─────────────────────────── the document's store ──────────────────────────

/// How the document stores its pixels.
struct Store {
    container: Container,
    sixteen: bool,
    /// `Some(profile)` for a CMYK document.
    cmyk: Option<Option<Vec<u8>>>,
    width: u32,
    height: u32,
}

impl Store {
    fn of(file: &PsdFile, width: u32, height: u32) -> Result<Store, IngestError> {
        let h = &file.header;
        if h.depth != 8 && h.depth != 16 {
            return Err(IngestError::Unsupported(format!(
                "a layered PSD save at depth {} (8- and 16-bit documents are written)",
                h.depth
            )));
        }
        let cmyk = match h.color_mode {
            ColorMode::Rgb => None,
            ColorMode::Cmyk => Some(file.resources.icc_profile().map(<[u8]>::to_vec)),
            other => {
                return Err(IngestError::Unsupported(format!(
                    "a layered PSD save in colour mode {other:?} (RGB and CMYK are written)"
                )))
            }
        };
        if h.width != width || h.height != height {
            return Err(IngestError::Unsupported(format!(
                "layered PSD save: the layers are {width}×{height}, the file is {}×{}",
                h.width, h.height
            )));
        }
        Ok(Store {
            container: file.container,
            sixteen: h.depth == 16,
            cmyk,
            width,
            height,
        })
    }

    /// Colour channel ids: R, G, B — or C, M, Y, K.
    fn colour_ids(&self) -> &'static [i16] {
        if self.cmyk.is_some() {
            &[0, 1, 2, 3]
        } else {
            &[0, 1, 2]
        }
    }

    /// One plane of samples at the store's depth (8-bit values in a
    /// `u16` when the document is 8-bit) as channel data: RLE at 8 bits,
    /// ZIP with prediction at 16 (Photoshop's choices [OBS]); an empty
    /// plane RAW.
    fn encode(&self, plane: &[u16], rows: u32, cols: u32) -> Result<ChannelData, IngestError> {
        if rows == 0 || cols == 0 {
            return Ok(ChannelData {
                compression: Compression::Raw,
                bytes: Vec::new(),
            });
        }
        if self.sixteen {
            ChannelData::encode_zip_predicted16(plane, rows, cols).map_err(err)
        } else {
            let bytes: Vec<u8> = plane.iter().map(|&v| v as u8).collect();
            ChannelData::encode_rle(&bytes, self.container, rows, cols).map_err(err)
        }
    }

    /// An 8-bit coverage value at the store's depth.
    fn widen(&self, v: u8) -> u16 {
        if self.sixteen {
            u16::from(v) * 257
        } else {
            u16::from(v)
        }
    }

    /// The colour planes (R, G, B or the inverted inks) and the alpha
    /// plane of `px` (`n` pixels), at the store's depth.
    fn planes(&self, px: &crate::pixels::Pixels, n: usize) -> (Vec<Vec<u16>>, Vec<u16>) {
        let colours = self.colour_ids().len();
        let mut planes = vec![vec![0u16; n]; colours];
        let mut alpha = vec![0u16; n];
        if let Some(profile) = &self.cmyk {
            let rgba = px.to_rgba8();
            let rgb: Vec<[u8; 3]> = rgba
                .as_chunks::<4>()
                .0
                .iter()
                .map(|p| [p[0], p[1], p[2]])
                .collect();
            let (ink, _) = paged_raster::srgb8_to_cmyk8(
                &rgb,
                profile.as_deref(),
                paged_raster::Intent::RelativeColorimetric,
            );
            for (i, c) in ink.iter().enumerate() {
                for k in 0..4 {
                    // Stored inverted: 255 = no ink.
                    planes[k][i] = self.widen(255 - c[k]);
                }
                alpha[i] = self.widen(rgba[i * 4 + 3]);
            }
            return (planes, alpha);
        }
        if px.is_16bit() {
            for i in 0..n {
                for (k, plane) in planes.iter_mut().enumerate() {
                    let s = px.sample16(i, k);
                    plane[i] = if self.sixteen { s } else { s >> 8 };
                }
                let a = px.sample16(i, 3);
                alpha[i] = if self.sixteen { a } else { a >> 8 };
            }
        } else {
            let raw = px.raw();
            for i in 0..n {
                for (k, plane) in planes.iter_mut().enumerate() {
                    plane[i] = self.widen(raw[i * 4 + k]);
                }
                alpha[i] = self.widen(raw[i * 4 + 3]);
            }
        }
        (planes, alpha)
    }

    /// A layer's pixels at their bounds (canvas-sized when the layer has
    /// none) as transparency + colour channels.
    fn pixel_channels(
        &self,
        rgba: &crate::pixels::LayerPixels,
    ) -> Result<(Region, Vec<ChannelInfo>, Vec<ChannelData>), IngestError> {
        let (rect, px) = match rgba.bounded() {
            Some(b) => (b.rect, b.px.clone()),
            None => (
                Region::new(0, 0, self.width, self.height),
                rgba.canvas().clone(),
            ),
        };
        let n = rect.w as usize * rect.h as usize;
        let (planes, alpha) = self.planes(&px, n);
        let mut infos = Vec::new();
        let mut data = Vec::new();
        let cd = self.encode(&alpha, rect.h, rect.w)?;
        infos.push(info(-1, &cd));
        data.push(cd);
        for (&id, plane) in self.colour_ids().iter().zip(&planes) {
            let cd = self.encode(plane, rect.h, rect.w)?;
            infos.push(info(id, &cd));
            data.push(cd);
        }
        Ok((rect, infos, data))
    }

    /// A layer with no pixels (an adjustment, a group record): every
    /// channel empty.
    fn empty_channels(&self) -> Result<(Vec<ChannelInfo>, Vec<ChannelData>), IngestError> {
        let mut infos = Vec::new();
        let mut data = Vec::new();
        for &id in std::iter::once(&-1i16).chain(self.colour_ids()) {
            let cd = self.encode(&[], 0, 0)?;
            infos.push(info(id, &cd));
            data.push(cd);
        }
        Ok((infos, data))
    }

    /// A user mask as channel −2 and its mask record: at its bounds with
    /// its outside value as the default colour, or canvas-sized with 0;
    /// flags bit 1 = disabled.
    fn mask_channel(
        &self,
        mask: &LayerMask,
        enabled: bool,
    ) -> Result<(ChannelInfo, ChannelData, LayerMaskData), IngestError> {
        let (rect, default, cov): (Region, u8, &[u8]) = match mask {
            LayerMask::Bounded(b) => (b.rect, b.outside, &b.data),
            LayerMask::Canvas(c) => (Region::new(0, 0, self.width, self.height), 0, c.data()),
        };
        self.mask_from(rect, default, cov, enabled)
    }

    fn mask_from(
        &self,
        rect: Region,
        default: u8,
        cov: &[u8],
        enabled: bool,
    ) -> Result<(ChannelInfo, ChannelData, LayerMaskData), IngestError> {
        let plane: Vec<u16> = cov.iter().map(|&v| self.widen(v)).collect();
        let cd = self.encode(&plane, rect.h, rect.w)?;
        let flags = if enabled { 0 } else { 0x02 };
        let (top, left) = (rect.y, rect.x);
        let (bottom, right) = (rect.y + rect.h as i32, rect.x + rect.w as i32);
        let mut raw = Vec::with_capacity(20);
        for v in [top, left, bottom, right] {
            raw.extend_from_slice(&v.to_be_bytes());
        }
        raw.extend_from_slice(&[default, flags, 0, 0]);
        Ok((
            info(-2, &cd),
            cd,
            LayerMaskData {
                top,
                left,
                bottom,
                right,
                default_color: default,
                flags,
                raw,
            },
        ))
    }

    /// The merged composite (straight RGBA8, canvas-sized) with its
    /// transparency: RLE at 8 bits, RAW at 16 (Photoshop writes a 16-bit
    /// document's composite RAW [OBS]).
    fn composite(&self, rgba: &[u8]) -> Result<GlobalImageData, IngestError> {
        let n = self.width as usize * self.height as usize;
        let px = crate::pixels::Pixels::from_rgba8(Arc::from(rgba));
        let (mut planes, alpha) = self.planes(&px, n);
        planes.push(alpha);
        if self.sixteen {
            let mut raw = Vec::with_capacity(planes.len() * n * 2);
            for p in &planes {
                for v in p {
                    raw.extend_from_slice(&v.to_be_bytes());
                }
            }
            return Ok(GlobalImageData {
                compression: Compression::Raw.code(),
                raw,
            });
        }
        // RLE: every plane's row table first, then the packed rows.
        let cw = match self.container {
            Container::Psb => 4usize,
            Container::Psd => 2usize,
        };
        let split = self.height as usize * cw;
        let mut counts = Vec::new();
        let mut rows = Vec::new();
        for p in &planes {
            let cd = self.encode(p, self.height, self.width)?;
            counts.extend_from_slice(&cd.bytes[..split]);
            rows.extend_from_slice(&cd.bytes[split..]);
        }
        counts.extend_from_slice(&rows);
        Ok(GlobalImageData {
            compression: Compression::Rle.code(),
            raw: counts,
        })
    }
}

fn info(id: i16, cd: &ChannelData) -> ChannelInfo {
    ChannelInfo {
        id,
        data_len: 2 + cd.bytes.len() as u64,
    }
}

// ───────────────────────────────── records ─────────────────────────────────

fn name_blocks(name: &str) -> (PascalString, AdditionalLayerInfo) {
    let legacy: String = name.chars().filter(char::is_ascii).collect();
    (
        PascalString::new(&legacy),
        AdditionalLayerInfo {
            sig: *b"8BIM",
            key: *b"luni",
            body: AddlBody::UnicodeName(name.to_string()),
            raw_block: None,
        },
    )
}

/// Replace every block keyed in `keys` with `new` (placed where the first
/// removed one was, else appended).
fn replace_blocks(rec: &mut LayerRecord, keys: &[&[u8; 4]], new: Vec<AdditionalLayerInfo>) {
    let at = rec.addl.iter().position(|a| keys.contains(&&a.key));
    rec.addl.retain(|a| !keys.contains(&&a.key));
    let at = at.unwrap_or(rec.addl.len()).min(rec.addl.len());
    rec.addl.splice(at..at, new);
}

/// What describes a layer's PIXELS rather than its compositing: dropped
/// when the pixels change (the layer reopens as the pixels it now has).
const CONTENT_KEYS: [&[u8; 4]; 10] = [
    b"TySh", b"tySh", b"SoLd", b"PlLd", b"plLd", b"SoLE", b"vscg", b"vstk", b"vogk", b"PtFl",
];
/// A fill layer's content.
const FILL_KEYS: [&[u8; 4]; 3] = [b"SoCo", b"GdFl", b"PtFl"];
/// A layer's style.
const STYLE_KEYS: [&[u8; 4]; 3] = [b"lfx2", b"lmfx", b"lrFX"];
/// The vector mask.
const VECTOR_MASK_KEYS: [&[u8; 4]; 2] = [b"vmsk", b"vsms"];

/// The blocks among `blocks` keyed `key`.
fn keyed(blocks: Vec<AdditionalLayerInfo>, key: &[u8; 4]) -> Vec<AdditionalLayerInfo> {
    blocks.into_iter().filter(|a| &a.key == key).collect()
}

/// A section record (a group's folder, above its members, or its closing
/// divider, below them): no pixels, and the group's mask on the folder.
#[allow(clippy::too_many_arguments)]
fn section_record(
    store: &Store,
    name: &str,
    lsct: LsctData,
    opacity: u8,
    flags: u8,
    blend_key: [u8; 4],
    mask: Option<(&SelectionCoverage, bool)>,
) -> Result<LayerRecord, IngestError> {
    let (mut channels, mut channel_data) = store.empty_channels()?;
    let mask = match mask {
        Some((cov, enabled)) => {
            let (i, cd, m) = store.mask_from(
                Region::new(0, 0, store.width, store.height),
                0,
                cov.data(),
                enabled,
            )?;
            channels.push(i);
            channel_data.push(cd);
            Some(m)
        }
        None => None,
    };
    let (name_legacy, luni) = name_blocks(name);
    Ok(LayerRecord {
        top: 0,
        left: 0,
        bottom: 0,
        right: 0,
        channels,
        blend_sig: *b"8BIM",
        blend_key,
        opacity,
        clipping: 0,
        flags,
        filler: 0,
        mask,
        blend_ranges: BlendRanges::default(),
        name_legacy,
        addl: vec![
            AdditionalLayerInfo {
                sig: *b"8BIM",
                key: *b"lsct",
                body: AddlBody::SectionDivider(lsct),
                raw_block: None,
            },
            luni,
        ],
        extra_raw: None,
        channel_data,
    })
}

/// The visibility bit in a record's flags.
fn with_visibility(flags: u8, visible: bool) -> u8 {
    if visible {
        flags & !0x02
    } else {
        flags | 0x02
    }
}

/// The pixels a layer is written with: a SHAPE layer's stored pixels are
/// its fill already cut by its path — what Photoshop stores, and does not
/// cut a second time (image ADR 476); the fill render is the whole canvas.
fn written_pixels(l: &Layer) -> std::borrow::Cow<'_, crate::pixels::LayerPixels> {
    let Some(v) = l.live_vector_mask().filter(|_| l.fill().is_some()) else {
        return std::borrow::Cow::Borrowed(&l.rgba);
    };
    let mut rgba = l.rgba.to_rgba8().into_owned();
    for (px, &c) in rgba
        .as_chunks_mut::<4>()
        .0
        .iter_mut()
        .zip(v.raster().data())
    {
        px[3] = ((u32::from(px[3]) * u32::from(c) + 127) / 255) as u8;
    }
    std::borrow::Cow::Owned(crate::pixels::Pixels::from_rgba8(rgba.into()).into())
}

/// The vector mask as its `vmsk` block (a shape layer's too, beside its
/// fill content), the way Photoshop 27 writes both (image ADR 476).
fn vector_mask_blocks(store: &Store, l: &Layer) -> Vec<AdditionalLayerInfo> {
    l.ext
        .vector_mask
        .iter()
        .map(|v| {
            crate::psd_layer_ext::raw_block(
                *b"vmsk",
                &v.to_psd_mask().encode(store.width, store.height),
            )
        })
        .collect()
}

/// A type layer's `TySh` (image ADR 474): the text stays editable in
/// Photoshop — the block it was read with while unedited, else its source
/// written out at the bounds of its ink.
fn type_block(store: &Store, l: &Layer) -> Option<AdditionalLayerInfo> {
    let t = l.type_layer()?;
    let px = l.rgba.canvas().to_rgba8();
    Some(crate::layers::type_layer::psd_block(
        t,
        crate::layers::type_layer::ink_bounds(&px, store.width, store.height, &t.source.frame),
    ))
}

/// A layer MADE in paged, as a new record.
fn built_record(store: &Store, l: &Layer) -> Result<LayerRecord, IngestError> {
    // A new SHAPE layer's stored pixels are its fill cut by its path
    // (ADR 476), so its fill must be rendered. A plain fill layer's content
    // block is what Photoshop draws (it renders the fill again), so it is
    // written as it stands.
    if l.fill().is_some_and(|f| f.stale) && l.live_vector_mask().is_some() {
        return Err(IngestError::Unsupported(format!(
            "fill layer \"{}\" is not rendered yet — composite before saving",
            l.name
        )));
    }
    let mut addl = Vec::new();
    let (rect, mut channels, mut channel_data) = match &l.kind {
        LayerKind::Adjustment(a) => {
            if store.cmyk.is_some() {
                return Err(cmyk_adjustment(l));
            }
            addl.extend(adjustment_blocks(a).ok_or_else(|| unwritable(l, a))?);
            let (i, d) = store.empty_channels()?;
            (Region::new(0, 0, 0, 0), i, d)
        }
        _ => store.pixel_channels(&written_pixels(l))?,
    };
    // The user mask as channel −2. A pixel layer whose only mask is an
    // enabled VECTOR mask carries its drawing there instead, flagged "came
    // from rendering other data" (flags bit 3), which is how Photoshop
    // caches it and how a reader that draws no paths still sees the layer
    // masked (ADR 476).
    let cached_vector = match (&l.mask, l.live_vector_mask()) {
        (None, Some(v)) if l.fill().is_none() => Some(v.raster()),
        _ => None,
    };
    let mask = match (&l.mask, cached_vector) {
        (Some(m), _) => {
            let (i, cd, rec) = store.mask_channel(m, l.mask_enabled)?;
            channels.push(i);
            channel_data.push(cd);
            Some(rec)
        }
        (None, Some(render)) => {
            let rect = Region::new(0, 0, store.width, store.height);
            let (i, cd, mut rec) = store.mask_from(rect, 0, render.data(), true)?;
            rec.flags |= 0x08;
            rec.raw[17] |= 0x08;
            channels.push(i);
            channel_data.push(cd);
            Some(rec)
        }
        (None, None) => None,
    };
    let (name_legacy, luni) = name_blocks(&l.name);
    addl.push(luni);
    // The parity properties (fill opacity, knockout, locks, label), the
    // style and its blending options, a fill layer's content.
    addl.extend(crate::psd_layer_ext::ext_blocks(&l.ext, l.locked));
    addl.extend(crate::psd_layer_ext::style_blocks(&l.ext));
    if let Some(f) = l.fill() {
        // A pattern fill's pixels belong in the document's pattern block,
        // which is not written: it is saved as its render.
        addl.extend(crate::psd_layer_ext::fill_block(&f.source));
    }
    addl.extend(vector_mask_blocks(store, l));
    addl.extend(type_block(store, l));
    let adjustment = matches!(l.kind, LayerKind::Adjustment(_));
    Ok(LayerRecord {
        top: rect.y,
        left: rect.x,
        bottom: rect.y + rect.h as i32,
        right: rect.x + rect.w as i32,
        channels,
        blend_sig: *b"8BIM",
        blend_key: psd_blend_key(l.blend.id),
        opacity: opacity_u8(l.opacity),
        clipping: u8::from(l.clipped),
        // Bit 3: bit 4 is meaningful; bit 4: the pixels are irrelevant to
        // the look (an adjustment) — what Photoshop writes [OBS].
        flags: with_visibility(if adjustment { 0x18 } else { 0x08 }, l.visible),
        filler: 0,
        mask,
        blend_ranges: match l.live_blend_if() {
            Some(bi) => BlendRanges {
                raw: crate::psd_layer_ext::blend_ranges_bytes(Some(bi)),
            },
            None => BlendRanges::default(),
        },
        name_legacy,
        addl,
        extra_raw: None,
        channel_data,
    })
}

fn cmyk_adjustment(l: &Layer) -> IngestError {
    IngestError::Unsupported(format!(
        "adjustment layer \"{}\" is new or edited in a CMYK document: the stack evaluates it in \
         RGB, Photoshop would apply it to the inks",
        l.name
    ))
}

/// A layer READ from the file: its record, with what was edited replaced
/// (an unedited layer's record unchanged, so it is written byte for byte).
/// `first` is false for the second and later layers sharing one source (a
/// duplicate), whose layer id is dropped for Photoshop to assign.
fn source_record(
    store: &Store,
    l: &Layer,
    src: &PsdSource,
    first: bool,
) -> Result<LayerRecord, IngestError> {
    let now = state_of(l);
    let was = &src.imported;
    if now == *was && first {
        return Ok(src.record.clone());
    }
    let mut rec = src.record.clone();
    rec.extra_raw = None;
    if !first {
        rec.addl.retain(|a| &a.key != b"lyid");
    }
    if now.name != was.name {
        let (legacy, luni) = name_blocks(&l.name);
        rec.name_legacy = legacy;
        replace_blocks(&mut rec, &[b"luni"], vec![luni]);
    }
    if now.opacity != was.opacity {
        rec.opacity = opacity_u8(l.opacity);
    }
    if now.blend != was.blend {
        rec.blend_key = psd_blend_key(l.blend.id);
    }
    if now.visible != was.visible {
        rec.flags = with_visibility(rec.flags, l.visible);
    }
    if now.clipped != was.clipped {
        rec.clipping = u8::from(l.clipped);
    }
    // The parity properties, each block only when its value changed.
    let (e, w) = (&now.ext, &was.ext);
    let ext = || crate::psd_layer_ext::ext_blocks(&l.ext, l.locked);
    if e.fill_opacity != w.fill_opacity {
        replace_blocks(&mut rec, &[b"iOpa"], keyed(ext(), b"iOpa"));
    }
    if e.knockout != w.knockout {
        replace_blocks(&mut rec, &[b"knko"], keyed(ext(), b"knko"));
    }
    if e.locks != w.locks || now.locked != was.locked {
        replace_blocks(&mut rec, &[b"lspf"], keyed(ext(), b"lspf"));
    }
    if e.color != w.color {
        replace_blocks(&mut rec, &[b"lclr"], keyed(ext(), b"lclr"));
    }
    if e.blend_if != w.blend_if {
        rec.blend_ranges = BlendRanges {
            raw: crate::psd_layer_ext::blend_ranges_bytes(l.live_blend_if()),
        };
    }
    let style = || crate::psd_layer_ext::style_blocks(&l.ext);
    if e.style != w.style {
        let blocks = style()
            .into_iter()
            .filter(|a| STYLE_KEYS.contains(&&a.key))
            .collect();
        replace_blocks(&mut rec, &STYLE_KEYS, blocks);
    }
    if e.style_options != w.style_options {
        for key in [b"infx", b"clbl", b"tsly", b"lmgm", b"vmgm"] {
            replace_blocks(&mut rec, &[key], keyed(style(), key));
        }
    }
    // The vector mask (image ADR 476), only when it was edited here.
    if e.vector_mask != w.vector_mask {
        replace_blocks(&mut rec, &VECTOR_MASK_KEYS, vector_mask_blocks(store, l));
    }
    // The content: an adjustment, a fill, pixels.
    if now.kind != was.kind {
        match (&l.kind, &was.kind) {
            (LayerKind::Adjustment(a), KindState::Adjustment(_)) => {
                if store.cmyk.is_some() {
                    return Err(cmyk_adjustment(l));
                }
                let blocks = adjustment_blocks(a).ok_or_else(|| unwritable(l, a))?;
                replace_blocks(
                    &mut rec,
                    &image_psd::adjustment::Adjustment::ALL_KEYS,
                    blocks,
                );
            }
            (LayerKind::Type(_), KindState::Type(_)) => {
                // The text was edited: its TySh is written from the source.
                replace_blocks(
                    &mut rec,
                    &[b"TySh", b"tySh"],
                    type_block(store, l).into_iter().collect(),
                );
            }
            (LayerKind::Fill(f), KindState::Fill(_)) => {
                let blocks = crate::psd_layer_ext::fill_block(&f.source)
                    .into_iter()
                    .collect();
                replace_blocks(&mut rec, &FILL_KEYS, blocks);
            }
            (LayerKind::Adjustment(_), _) | (_, KindState::Adjustment(_)) => {
                // A layer that became (or stopped being) an adjustment is
                // a different layer: build it, keeping its id.
                let mut built = built_record(store, l)?;
                if first {
                    built
                        .addl
                        .extend(rec.addl.iter().filter(|a| &a.key == b"lyid").cloned());
                }
                return Ok(built);
            }
            // Rasterized (a smart object or fill now plain pixels): the
            // content blocks go with the pixels below.
            _ => {}
        }
    }
    let pixels_changed = now.pixels != was.pixels
        || (now.kind != was.kind && !matches!(l.kind, LayerKind::Adjustment(_)));
    let mask_changed = now.mask != was.mask;
    if pixels_changed || mask_changed {
        // Keep the channels that did not change, in their order.
        let mut kept: Vec<(ChannelInfo, ChannelData)> = rec
            .channels
            .iter()
            .copied()
            .zip(rec.channel_data.iter().cloned())
            .filter(|(c, _)| {
                let is_mask = c.id == -2 || c.id == -3;
                if is_mask {
                    !mask_changed
                } else {
                    !pixels_changed
                }
            })
            .collect();
        if pixels_changed {
            let (rect, infos, data) = if matches!(l.kind, LayerKind::Adjustment(_)) {
                let (i, d) = store.empty_channels()?;
                (Region::new(0, 0, 0, 0), i, d)
            } else {
                store.pixel_channels(&written_pixels(l))?
            };
            rec.top = rect.y;
            rec.left = rect.x;
            rec.bottom = rect.y + rect.h as i32;
            rec.right = rect.x + rect.w as i32;
            let colour: Vec<_> = infos.into_iter().zip(data).collect();
            kept.splice(0..0, colour);
            let keep_fill = matches!(l.kind, LayerKind::Fill(_));
            // A type layer's new pixels are its text's render: its TySh stays.
            let keep_type = matches!(l.kind, LayerKind::Type(_));
            rec.addl.retain(|a| {
                !CONTENT_KEYS.contains(&&a.key)
                    || (keep_fill && FILL_KEYS.contains(&&a.key))
                    || (keep_type && matches!(&a.key, b"TySh" | b"tySh"))
            });
            if !keep_fill {
                rec.addl.retain(|a| !FILL_KEYS.contains(&&a.key));
            }
        }
        if mask_changed {
            // A vector mask the stack keeps as paths (ADR 476) stays; one
            // the import drew into the user mask goes with it.
            if l.ext.vector_mask.is_none() {
                rec.addl.retain(|a| !VECTOR_MASK_KEYS.contains(&&a.key));
            }
            rec.mask = None;
            if let Some(m) = &l.mask {
                let (i, cd, m) = store.mask_channel(m, l.mask_enabled)?;
                kept.push((i, cd));
                rec.mask = Some(m);
            }
        }
        rec.channels = kept.iter().map(|(c, _)| *c).collect();
        rec.channel_data = kept.into_iter().map(|(_, d)| d).collect();
    } else if now.mask_enabled != was.mask_enabled {
        if let Some(m) = &mut rec.mask {
            m.flags = with_visibility(m.flags, l.mask_enabled);
            if let Some(b) = m.raw.get_mut(17) {
                *b = m.flags;
            }
        }
    }
    Ok(rec)
}

/// Write the session's layer STACK into the retained PSD as its layers,
/// with `composite` (straight RGBA8, the stack's fold) as the merged
/// image. Refuses — so the caller can fall back to the flattened save — a
/// stack holding a layer Photoshop has no counterpart for, a document of
/// another depth or colour mode, or a size mismatch (see the module docs).
pub fn psd_write_stack(
    file: &mut PsdFile,
    stack: &LayerStack,
    composite: &[u8],
) -> Result<PsdSaveBackShape, IngestError> {
    let (width, height) = (stack.width(), stack.height());
    let store = Store::of(file, width, height)?;
    let n = width as usize * height as usize;
    if composite.len() != n * 4 {
        return Err(IngestError::Decode(
            "layered PSD save: composite is mis-sized".into(),
        ));
    }
    // The styles' Global Light lives in the document's resources.
    if stack.layers().iter().any(|l| l.ext.style.is_some()) {
        stack.style_doc().global_light.store(file);
    }
    let group = |id: u32| stack.groups().iter().find(|g| g.id == id);
    let mut records: Vec<LayerRecord> = Vec::new();
    let mut seen: HashSet<*const PsdSource> = HashSet::new();
    // Bottom-first, opening and closing groups as the chain changes. A
    // group CLOSES (its folder record goes above its members) when a
    // layer leaves it, and OPENS (its divider goes below) when one enters.
    let mut open: Vec<u32> = Vec::new();
    let close = |records: &mut Vec<LayerRecord>, id: u32| -> Result<(), IngestError> {
        let g = group(id).ok_or_else(|| IngestError::Decode(format!("no group {id}")))?;
        let blend = psd_blend_key(g.blend.id);
        let (key, lsct_blend) = if g.pass_through {
            (*b"pass", *b"pass")
        } else {
            (blend, blend)
        };
        records.push(section_record(
            &store,
            &g.name,
            LsctData {
                kind: SectionKind::OpenFolder,
                blend_key: Some(lsct_blend),
                sub_kind: None,
            },
            opacity_u8(g.opacity),
            with_visibility(0x08, g.visible),
            key,
            g.mask.as_deref().map(|m| (m, g.mask_enabled)),
        )?);
        Ok(())
    };
    for layer in stack.layers() {
        let want = stack.group_chain(layer.group);
        while let Some(&top) = open.last() {
            if want.starts_with(&open) {
                break;
            }
            open.pop();
            close(&mut records, top)?;
        }
        for &g in &want[open.len()..] {
            records.push(section_record(
                &store,
                "</Layer group>",
                LsctData {
                    kind: SectionKind::BoundingDivider,
                    blend_key: None,
                    sub_kind: None,
                },
                255,
                0x08,
                *b"norm",
                None,
            )?);
            open.push(g);
        }
        records.push(match &layer.ext.source {
            Some(src) => {
                let first = seen.insert(Arc::as_ptr(src));
                source_record(&store, layer, src, first)?
            }
            None => built_record(&store, layer)?,
        });
    }
    while let Some(top) = open.pop() {
        close(&mut records, top)?;
    }

    // The merged composite (with transparency), and a header that says so.
    file.composite = store.composite(composite)?;
    file.header.channels = store.colour_ids().len() as u16 + 1;
    file.layer_mask.layers = records;
    file.layer_mask.transparency_in_merged = true;
    // A 16-bit document keeps its layers in its `Lr16` block, as
    // Photoshop writes them.
    file.layer_mask.deep_key = store.sixteen.then_some(*b"Lr16");
    file.layer_mask.section_raw = None;
    // The document's paths: the saved ones and the work path (ADR 476).
    crate::vectors::paths_into_psd(file, stack.masking()).map_err(IngestError::Unsupported)?;
    Ok(PsdSaveBackShape::Layered)
}

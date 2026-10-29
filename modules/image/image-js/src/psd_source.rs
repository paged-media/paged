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

//! Where a layer came from in the PSD the stack was opened from — the
//! record it was read from, and what the import made of it — so the
//! layered save can write an UNEDITED layer as the very record it read
//! (byte for byte: its text, smart-object, vector and every other block
//! included) and an edited one as that record with only the edited
//! parts replaced (image ADR 478).
//!
//! An edit is told apart by comparing the layer with the state the
//! import left it in: the scalar properties by value, the pixels and the
//! mask by a hash of their stored bytes (the import's `Arc`s are not kept
//! alive for the comparison, so an edited layer does not hold its old
//! pixels).

use std::sync::Arc;

use image_psd::model::LayerRecord;

use crate::layers::{Layer, LayerKind, LayerMask};
use crate::pixels::LayerPixels;

/// A layer's PSD origin (shared by every snapshot of the layer).
#[derive(Debug)]
pub struct PsdSource {
    /// The record as read, channel payloads included.
    pub record: LayerRecord,
    /// The layer as the import made it.
    pub imported: Imported,
}

/// The state of a layer the save compares against.
#[derive(Debug, Clone, PartialEq)]
pub struct Imported {
    pub name: String,
    pub visible: bool,
    pub locked: bool,
    pub opacity: f32,
    pub blend: &'static str,
    pub clipped: bool,
    pub mask_enabled: bool,
    pub pixels: u64,
    pub mask: Option<u64>,
    pub kind: KindState,
    pub ext: crate::layers::LayerExt,
}

/// What a layer's kind carries, for the comparison.
#[derive(Debug, Clone, PartialEq)]
pub enum KindState {
    Pixels,
    /// A smart object: its placement, its source file (by identity) and
    /// its filters (ADR 482).
    Smart {
        quad: [f64; 8],
        file: usize,
        filters: Option<crate::smart::SmartFilterStack>,
    },
    Adjustment(Box<crate::layers::Adjustment>),
    Fill(crate::layers::FillSource),
}

/// Two sources are the same source only by identity.
impl PartialEq for PsdSource {
    fn eq(&self, other: &Self) -> bool {
        std::ptr::eq(self, other)
    }
}

/// The shared content hash (FNV-1a, `image_core::ContentHash`) of a
/// shape header and its bytes.
fn content_hash(header: &[i64], bytes: &[u8]) -> u64 {
    let mut h: Vec<u8> = header.iter().flat_map(|v| v.to_le_bytes()).collect();
    h.extend_from_slice(&image_core::ContentHash::of(bytes).0.to_le_bytes());
    image_core::ContentHash::of(&h).0
}

/// A hash of a layer's stored pixels (their shape and bytes).
pub fn pixels_hash(px: &LayerPixels) -> u64 {
    match px {
        LayerPixels::Canvas(p) => content_hash(&[0, p.depth() as i64], p.raw()),
        LayerPixels::Bounded(b) => content_hash(
            &[
                1,
                b.px.depth() as i64,
                i64::from(b.rect.x),
                i64::from(b.rect.y),
                i64::from(b.rect.w),
                i64::from(b.rect.h),
            ],
            b.px.raw(),
        ),
    }
}

/// A hash of a layer mask's coverage (its shape and bytes).
pub fn mask_hash(m: &LayerMask) -> u64 {
    match m {
        LayerMask::Canvas(c) => content_hash(&[0], c.data()),
        LayerMask::Bounded(b) => content_hash(
            &[
                1,
                i64::from(b.rect.x),
                i64::from(b.rect.y),
                i64::from(b.rect.w),
                i64::from(b.rect.h),
                i64::from(b.outside),
            ],
            &b.data,
        ),
    }
}

fn kind_state(l: &Layer) -> KindState {
    match &l.kind {
        LayerKind::Pixels => KindState::Pixels,
        LayerKind::Smart(s) => KindState::Smart {
            quad: s.quad(),
            file: s.file.as_ref().map_or(0, |f| Arc::as_ptr(f) as usize),
            filters: s.filters.as_deref().cloned(),
        },
        LayerKind::Adjustment(a) => KindState::Adjustment(a.clone()),
        LayerKind::Fill(f) => KindState::Fill(f.source.clone()),
    }
}

/// The comparison state of `l` (its `ext.source` left out).
pub fn state_of(l: &Layer) -> Imported {
    let mut ext = l.ext.clone();
    ext.source = None;
    Imported {
        name: l.name.clone(),
        visible: l.visible,
        locked: l.locked,
        opacity: l.opacity,
        blend: l.blend.id,
        clipped: l.clipped,
        mask_enabled: l.mask_enabled,
        pixels: match l.kind {
            // An adjustment has no pixels of its own.
            LayerKind::Adjustment(_) => 0,
            _ => pixels_hash(&l.rgba),
        },
        mask: l.mask.as_ref().map(mask_hash),
        kind: kind_state(l),
        ext,
    }
}

/// Remember `record` as the origin of `l`, as `l` is now.
pub fn attach(l: &mut Layer, record: &LayerRecord) {
    let imported = state_of(l);
    l.ext.source = Some(Arc::new(PsdSource {
        record: record.clone(),
        imported,
    }));
}

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

//! The layered save's SMART OBJECTS (image ADR 482): a smart object is
//! written as a LIVE placed layer — its `SoLd` (and the legacy `PlLd`)
//! with its placement and smart filters, its source in the document's
//! `lnk2` block, and the filter mask in the `FEid` cache — whatever was
//! done to it, so Photoshop reopens a transformed, re-filtered or
//! re-contented object as a smart object.
//!
//! - An UNCHANGED smart object keeps its record byte for byte, and its
//!   source entry and filter cache are written back as read.
//! - A changed one gets its record patched (the corners, the source's
//!   size and uuid, the filter list), a new source entry when its
//!   contents changed (an `liFD` embedding the file; a source that is not
//!   a file is written as a one-layer PSB of its pixels), and a new
//!   filter-cache entry (its unfiltered render and its filter mask).
//! - A smart filter Photoshop has no counterpart for cannot be written
//!   live: the object is then saved as the pixels it shows, and the save
//!   says so.

use std::collections::HashSet;
use std::sync::Arc;

use image_psd::model::{AdditionalLayerInfo, AddlPad, PsdFile};
use image_psd::smart_object::{
    write_linked_files, FilterEffects, FilterEffectsEntry, LinkKind, LinkedFile, PlacedLayer,
    SmartFilters,
};
use image_psd::Container;

use crate::ingest::IngestError;
use crate::layers::{Layer, LayerKind, LayerStack};

/// The layer blocks that make a layer a smart object.
pub const SMART_KEYS: [&[u8; 4]; 4] = [b"PlLd", b"plLd", b"SoLd", b"SoLE"];

/// What the save gathers about the document's smart objects.
pub struct SmartDoc {
    container: Container,
    width: u32,
    height: u32,
    /// The `lnk2` entries as read, in order.
    original: Vec<LinkedFile>,
    /// Sources in other link blocks (`lnkD`, `lnk3`, `lnkE`), written
    /// back with their blocks.
    elsewhere: HashSet<String>,
    /// The new entries, by uuid, in the order they were met.
    added: Vec<LinkedFile>,
    /// The uuids some smart object names.
    referenced: HashSet<String>,
    effects_original: Option<FilterEffects>,
    effects: Vec<FilterEffectsEntry>,
    /// What the save could not write as it is (said to the user).
    pub notes: Vec<String>,
}

fn payload(a: &AdditionalLayerInfo, c: Container) -> &[u8] {
    a.payload(c)
}

/// A smart-object block as Photoshop frames it: the data zero-padded to a
/// multiple of 4 and the length counting the pad (`SoLd` 1388, `PlLd` 480,
/// `lnk2`, `FEid` all multiples of 4 [OBS]; Photoshop refuses to open a
/// file whose `SoLd` length is odd).
fn block4(key: [u8; 4], data: &[u8], c: Container, pad: AddlPad) -> AdditionalLayerInfo {
    let mut d = data.to_vec();
    while !d.len().is_multiple_of(4) {
        d.push(0);
    }
    AdditionalLayerInfo::opaque(key, &d, c, pad)
}

impl SmartDoc {
    pub fn of(file: &PsdFile, width: u32, height: u32) -> Self {
        let c = file.container;
        let mut original = Vec::new();
        let mut elsewhere = HashSet::new();
        for a in &file.layer_mask.addl_global {
            if !image_psd::smart_object::LINKED_KEYS.contains(&&a.key) {
                continue;
            }
            let entries =
                image_psd::smart_object::parse_linked_files(payload(a, c)).unwrap_or_default();
            if &a.key == b"lnk2" {
                original.extend(entries);
            } else {
                elsewhere.extend(entries.into_iter().map(|e| e.uuid));
            }
        }
        Self {
            container: c,
            width,
            height,
            original,
            elsewhere,
            added: Vec::new(),
            referenced: HashSet::new(),
            effects_original: crate::smart::psd_filter_effects(file),
            effects: Vec::new(),
            notes: Vec::new(),
        }
    }

    /// An UNCHANGED smart object read from the file: its source and its
    /// filter cache stay as they are.
    pub fn keep(&mut self, l: &Layer) {
        let Some(s) = l.smart_source() else {
            return;
        };
        if let Some(f) = &s.file {
            self.referenced.insert(f.uuid.clone());
        }
        let placed = s
            .record
            .as_ref()
            .and_then(|r| r.placed_id().map(str::to_string));
        if let (Some(p), Some(fx)) = (placed, &self.effects_original) {
            if let Some(e) = fx.entry(&p) {
                self.effects.push(e.clone());
            }
        }
    }

    /// The source entry of `s` (its uuid), added when the file is new or
    /// its contents changed.
    fn source_entry(&mut self, l: &Layer) -> Result<String, IngestError> {
        let s = l.smart_source().expect("a smart object");
        if let Some(f) = &s.file {
            // Unchanged: the entry it was read from.
            let same = f.entry.as_ref().is_some_and(|e| match e.kind {
                LinkKind::Data => e.data.len() == f.bytes.len() && e.data[..] == f.bytes[..],
                // A link to the same place.
                _ => f.link.as_deref() == Some(e.link_path()),
            });
            if same || self.elsewhere.contains(&f.uuid) && f.entry.is_some() {
                self.referenced.insert(f.uuid.clone());
                return Ok(f.uuid.clone());
            }
            if f.link.is_some() {
                self.notes.push(format!(
                    "the linked smart object \"{}\" was saved embedded (a new link is not written)",
                    l.name
                ));
            }
            if !f.bytes.is_empty() {
                let entry = LinkedFile::embedded(&f.uuid, &f.name, f.file_type, f.bytes.to_vec());
                self.add(entry);
                return Ok(f.uuid.clone());
            }
        }
        // Pixels (or page items) without a file: a one-layer PSB of them.
        let r = s.raster()?;
        let stack = LayerStack::from_image(r.width, r.height, Arc::clone(&r.rgba))?;
        let bytes = crate::smart::contents_bytes(&stack, None, &r.rgba)?;
        let uuid = s.file.as_ref().map_or_else(
            || crate::smart::new_uuid(l.name.as_bytes()),
            |f| f.uuid.clone(),
        );
        let name = format!("{}.psb", l.name.replace(['/', '\\'], "-"));
        self.add(LinkedFile::embedded(&uuid, &name, *b"8BPB", bytes));
        Ok(uuid)
    }

    fn add(&mut self, entry: LinkedFile) {
        self.referenced.insert(entry.uuid.clone());
        self.added.retain(|e| e.uuid != entry.uuid);
        self.added.push(entry);
    }

    /// The blocks of a smart object written LIVE — `PlLd` and `SoLd` —
    /// with its source and filter cache recorded for the document; `None`
    /// when it cannot be (a filter without a Photoshop counterpart), in
    /// which case it is written as its pixels and a note says why.
    pub fn blocks_for(
        &mut self,
        l: &Layer,
    ) -> Result<Option<Vec<AdditionalLayerInfo>>, IngestError> {
        let Some(s) = l.smart_source() else {
            return Ok(None);
        };
        // The filters, each in Photoshop's form.
        let fx = match s.filters.as_deref().filter(|f| !f.filters.is_empty()) {
            Some(f) => {
                let mut list = Vec::new();
                for e in &f.filters {
                    match crate::smart::filter_to_psd(e) {
                        Some(p) => list.push(p),
                        None => {
                            self.notes.push(format!(
                                "the smart filter \"{}\" of \"{}\" has no Photoshop counterpart: the \
                                 layer was saved as the pixels it shows",
                                e.name, l.name
                            ));
                            return Ok(None);
                        }
                    }
                }
                Some(SmartFilters {
                    enabled: f.enabled,
                    valid_at_position: true,
                    mask_enabled: f.mask_enabled,
                    mask_linked: f.mask_linked,
                    mask_extend_with_white: true,
                    list,
                })
            }
            None => None,
        };
        let uuid = self.source_entry(l)?;
        let quad = s.quad();
        let (w, h) = (f64::from(s.width), f64::from(s.height));
        let mut placed = match s.record.as_deref() {
            Some(r) => r.clone(),
            None => {
                PlacedLayer::embedded(&uuid, &crate::smart::new_uuid(b"placed"), w, h, 72.0, quad)
            }
        };
        placed.set_uuid(&uuid);
        placed.set_quad(quad);
        placed.set_size(w, h);
        placed.set_filter_fx(fx.as_ref().map(SmartFilters::to_descriptor));
        if fx.is_some() {
            let placed_id = placed.placed_id().unwrap_or("").to_string();
            let base = crate::smart::render_placed(&*s.raster()?, &quad, self.width, self.height)?;
            let base = base.to_rgba8();
            let mask = s
                .filters
                .as_deref()
                .and_then(|f| f.mask.as_ref())
                .map(|m| m.to_canvas().data().to_vec());
            let rect = [0, 0, self.height as i32, self.width as i32];
            self.effects.retain(|e| e.id != placed_id);
            self.effects.push(FilterEffectsEntry::build(
                &placed_id,
                rect,
                &base,
                mask.as_deref(),
            ));
        }
        let c = self.container;
        Ok(Some(vec![
            block4(*b"PlLd", &placed.plld_payload(), c, AddlPad::Even),
            block4(*b"SoLd", &placed.to_payload(), c, AddlPad::Even),
        ]))
    }

    /// Write the document blocks: `lnk2` with the sources still named, the
    /// filter cache and its mask colour. Blocks whose content did not
    /// change are left byte for byte.
    pub fn finish(mut self, file: &mut PsdFile) {
        let c = self.container;
        // Every record written with a placed-layer block names its source
        // and its filter cache — a smart object the stack holds as pixels
        // (an import that was not adopted) as much as one it holds live.
        for rec in &file.layer_mask.layers {
            if let Some(p) = crate::smart::placed_layer(rec, c) {
                if let Some(u) = p.uuid() {
                    self.referenced.insert(u.to_string());
                }
                if let (Some(id), Some(fx)) = (p.placed_id(), &self.effects_original) {
                    if !self.effects.iter().any(|e| e.id == id) {
                        if let Some(e) = fx.entry(id) {
                            self.effects.push(e.clone());
                        }
                    }
                }
            }
        }
        // The original cache's order where nothing changed.
        if let Some(fx) = &self.effects_original {
            let pos = |id: &str| {
                fx.entries
                    .iter()
                    .position(|e| e.id == id)
                    .unwrap_or(usize::MAX)
            };
            self.effects.sort_by_key(|e| pos(&e.id));
        }
        let mut entries: Vec<LinkedFile> = self
            .original
            .iter()
            .filter(|e| self.referenced.contains(&e.uuid))
            .filter(|e| !self.added.iter().any(|a| a.uuid == e.uuid))
            .cloned()
            .collect();
        entries.extend(self.added.iter().cloned());
        let unchanged_links = self.added.is_empty() && entries.len() == self.original.len();
        if !unchanged_links {
            let at = file
                .layer_mask
                .addl_global
                .iter()
                .position(|a| &a.key == b"lnk2");
            file.layer_mask.addl_global.retain(|a| &a.key != b"lnk2");
            if !entries.is_empty() {
                let block = block4(*b"lnk2", &write_linked_files(&entries), c, AddlPad::Four);
                let at = at.unwrap_or_else(|| {
                    before_any(file, &[b"lnkE", b"FEid", b"FXid", b"FMsk", b"cinf"])
                });
                file.layer_mask.addl_global.insert(at, block);
            }
        }
        let original_fx = self
            .effects_original
            .as_ref()
            .map(|f| f.entries.clone())
            .unwrap_or_default();
        if self.effects != original_fx {
            let at = file
                .layer_mask
                .addl_global
                .iter()
                .position(|a| image_psd::smart_object::FILTER_EFFECTS_KEYS.contains(&&a.key));
            file.layer_mask
                .addl_global
                .retain(|a| !image_psd::smart_object::FILTER_EFFECTS_KEYS.contains(&&a.key));
            if !self.effects.is_empty() {
                let fx = FilterEffects {
                    version: self.effects_original.as_ref().map_or(3, |f| f.version),
                    entries: self.effects,
                };
                let at = at.unwrap_or_else(|| before_any(file, &[b"FMsk", b"cinf"]));
                file.layer_mask
                    .addl_global
                    .insert(at, block4(*b"FEid", &fx.to_payload(), c, AddlPad::Four));
                if !file
                    .layer_mask
                    .addl_global
                    .iter()
                    .any(|a| &a.key == b"FMsk")
                {
                    // The filter mask's overlay colour and opacity, as
                    // Photoshop writes them for a new document [OBS].
                    let fmsk = [0, 0, 0xff, 0xff, 0, 0, 0, 0, 0, 0, 0, 0x32];
                    let at = before_any(file, &[b"cinf"]);
                    file.layer_mask
                        .addl_global
                        .insert(at, block4(*b"FMsk", &fmsk, c, AddlPad::Four));
                }
            }
        }
    }
}

/// The index before the first block keyed one of `keys`, else the end.
fn before_any(file: &PsdFile, keys: &[&[u8; 4]]) -> usize {
    file.layer_mask
        .addl_global
        .iter()
        .position(|a| keys.contains(&&a.key))
        .unwrap_or(file.layer_mask.addl_global.len())
}

/// Is `l` a smart object?
pub fn is_smart(l: &Layer) -> bool {
    matches!(l.kind, LayerKind::Smart(_))
}

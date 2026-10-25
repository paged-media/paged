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

//! The GPU screen's per-page scene cache, keyed by page AND view.
//!
//! Generic over the cached value so the keying and eviction rules are
//! tested natively (`tests/it/scene_cache.rs`); the wasm shell stores
//! `vello::Scene`s in it.
//!
//! A page's scene depends on the view it is drawn in (editor ADR 287): a
//! Preview scene draws overprints as knockouts, an Outline scene carries
//! hairlines sized for one camera scale, and an Overprint Preview scene of
//! a page that overprints is a CPU raster made at one scale. So the key is
//! `(page, SceneView)`, switching views never serves a stale scene, and
//! switching back finds the earlier one still cached.

use std::collections::{HashMap, VecDeque};

use paged_canvas::ViewMode;

/// Which drawing of a page a cached scene is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SceneView {
    /// Vector scene, overprints as knockouts: Preview and Pixel Preview,
    /// and Overprint Preview of a page with no overprint.
    Knockout,
    /// Hairline outlines built for the camera scale bucket (the bucket's
    /// `f32` bits).
    Outline(u32),
    /// The CPU raster of an overprinting page at the scale bucket.
    OverprintRaster(u32),
}

impl SceneView {
    /// The scene `mode` needs for a page at device scale `px_per_pt`.
    pub fn for_page(mode: ViewMode, page_overprints: bool, px_per_pt: f32) -> Self {
        let bucket = || paged_gpu_bucket(px_per_pt).to_bits();
        match mode {
            ViewMode::Outline => SceneView::Outline(bucket()),
            ViewMode::OverprintPreview if page_overprints => SceneView::OverprintRaster(bucket()),
            _ => SceneView::Knockout,
        }
    }

    /// The scale the scene is built for, when it depends on one.
    pub fn scale(self) -> Option<f32> {
        match self {
            SceneView::Knockout => None,
            SceneView::Outline(bits) | SceneView::OverprintRaster(bits) => {
                Some(f32::from_bits(bits))
            }
        }
    }
}

/// [`paged_gpu::view::outline_scale_bucket`], restated so this module
/// builds without the `gpu` feature (the native tests); the two are pinned
/// equal by `tests/it/scene_cache.rs` when the feature is on.
pub fn paged_gpu_bucket(px_per_pt: f32) -> f32 {
    let s = px_per_pt.max(1e-3);
    let step = (s.log2() * 4.0).round();
    (step / 4.0).exp2()
}

/// LRU cache of page scenes. Keys are `(page index, view)`; eviction drops
/// the least recently used entry once there are more than `max_entries`.
pub struct SceneCache<V> {
    pub entries: HashMap<(usize, SceneView), V>,
    order: VecDeque<(usize, SceneView)>,
    pub max_entries: usize,
}

impl<V> SceneCache<V> {
    pub fn new(max_entries: usize) -> Self {
        Self {
            entries: HashMap::new(),
            order: VecDeque::new(),
            max_entries: max_entries.max(1),
        }
    }

    pub fn clear(&mut self) {
        self.entries.clear();
        self.order.clear();
    }

    /// Drop every view's scene of `pages`; other pages keep theirs.
    pub fn invalidate_pages(&mut self, pages: &[usize]) {
        if pages.is_empty() {
            return;
        }
        self.entries.retain(|(p, _), _| !pages.contains(p));
        self.order.retain(|(p, _)| !pages.contains(p));
    }

    fn touch(&mut self, key: (usize, SceneView)) {
        if let Some(pos) = self.order.iter().position(|k| *k == key) {
            self.order.remove(pos);
        }
        self.order.push_front(key);
    }

    pub fn get(&mut self, key: (usize, SceneView)) -> Option<&V> {
        if self.entries.contains_key(&key) {
            self.touch(key);
            self.entries.get(&key)
        } else {
            None
        }
    }

    pub fn contains(&self, key: (usize, SceneView)) -> bool {
        self.entries.contains_key(&key)
    }

    pub fn insert(&mut self, key: (usize, SceneView), value: V) {
        self.entries.insert(key, value);
        self.touch(key);
        self.trim();
    }

    /// Lower the budget (or apply it again) and evict down to it.
    pub fn set_max_entries(&mut self, max_entries: usize) {
        self.max_entries = max_entries.max(1);
        self.trim();
    }

    fn trim(&mut self) {
        while self.entries.len() > self.max_entries {
            match self.order.pop_back() {
                Some(victim) => {
                    self.entries.remove(&victim);
                }
                None => break,
            }
        }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

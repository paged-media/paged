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

//! The decoded-picture store (engine ADR 1311): the one place a placed
//! picture's pixels are kept while they are drawn.
//!
//! A live build keeps a picture's encoded bytes and the size it is placed
//! at (`DecodedImage::rgba` empty: the lazy pictures of the wasm32 build);
//! both lanes ask this store for its pixels at the *level* the draw needs.
//! Level `k` is the picture at `1 / 2^k` of its recorded size on both axes,
//! and a draw takes the deepest level that still gives every device pixel
//! at least one picture pixel ([`level_for`]): a page thumbnail asks for a
//! level a JPEG decodes at an eighth of its size (its DCT scale), a page at
//! 400 % for level 0. A picture the build decoded itself (an export build,
//! the native command line) is always drawn at level 0, so exports and the
//! fidelity gates keep every pixel.
//!
//! One store per thread (the editor's worker is one thread): the CPU tiles,
//! the page thumbnails and the GPU page scenes share one decode of a
//! picture at a level, and the GPU lane draws the CPU lane's premultiplied
//! pixmap without a copy. The store keeps at most its budget of pixel bytes
//! ([`DEFAULT_BUDGET_BYTES`], [`set_budget`]); past it the pictures drawn
//! longest ago go first. A decode larger than the whole budget is drawn and
//! not kept. [`stats`] says what it holds.

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;

/// Pixel bytes the store keeps by default: sixteen 2 000 × 2 000 photos,
/// a screen of pages at full size and their neighbours.
pub const DEFAULT_BUDGET_BYTES: usize = 256 * 1024 * 1024;

/// The deepest level: a picture at 1/64 of its recorded size.
pub const MAX_LEVEL: u8 = 6;

/// What the store holds and has done, on this thread.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct StoreStats {
    /// Pictures held (one per picture and level).
    pub entries: usize,
    /// Pixel bytes held.
    pub bytes: usize,
    /// The most pixel bytes held at once.
    pub peak_bytes: usize,
    /// The budget in force.
    pub budget: usize,
    /// Decodes run.
    pub decodes: u64,
    /// Draws served from a decode already held.
    pub hits: u64,
    /// Entries dropped to stay within the budget.
    pub evictions: u64,
    /// Decodes larger than the budget, drawn and not kept.
    pub uncached: u64,
}

/// The size of `level` of a `width × height` picture.
pub fn level_dims(width: u32, height: u32, level: u8) -> (u32, u32) {
    let d = 1u32 << level.min(MAX_LEVEL);
    (width.div_ceil(d).max(1), height.div_ceil(d).max(1))
}

/// The level a `width × height` picture drawn across `px_w × px_h` device
/// pixels needs: the deepest level that still has at least as many pixels
/// as the draw on both axes.
pub fn level_for(width: u32, height: u32, px_w: f64, px_h: f64) -> u8 {
    if !(px_w.is_finite() && px_h.is_finite()) {
        return 0;
    }
    let mut level = 0;
    while level < MAX_LEVEL {
        let (w, h) = level_dims(width, height, level + 1);
        if (w as f64) < px_w || (h as f64) < px_h {
            break;
        }
        level += 1;
    }
    level
}

/// The level `img` is drawn at through `unit_to_px` (its unit square to
/// device pixels, as kurbo coefficients): level 0 for a picture the build
/// decoded, else [`level_for`] its extent on the device.
pub fn level_for_draw(img: &paged_compose::DecodedImage, unit_to_px: [f64; 6]) -> u8 {
    if is_eager(img) {
        return 0;
    }
    let [a, b, c, d, _, _] = unit_to_px;
    level_for(img.width, img.height, a.hypot(b), c.hypot(d))
}

fn is_eager(img: &paged_compose::DecodedImage) -> bool {
    img.rgba.len() == img.width as usize * img.height as usize * 4
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
struct Key {
    addr: usize,
    len: usize,
    width: u32,
    height: u32,
    level: u8,
}

impl Key {
    fn of(img: &paged_compose::DecodedImage, level: u8) -> Option<Self> {
        let source: &[u8] = if is_eager(img) {
            &img.rgba
        } else {
            &img.encoded
        };
        (!source.is_empty()).then_some(Key {
            addr: source.as_ptr() as usize,
            len: source.len(),
            width: img.width,
            height: img.height,
            level,
        })
    }
}

/// A held decode, as the lanes draw it.
#[derive(Clone)]
enum Pixels {
    /// Straight-alpha RGBA8, as decoded (a GPU-only build).
    #[cfg_attr(feature = "cpu", allow(dead_code))]
    Straight(Arc<Vec<u8>>),
    /// The CPU lane's premultiplied pixmap; the GPU lane shares its bytes.
    #[cfg(feature = "cpu")]
    Pixmap(Arc<vello_cpu::Pixmap>),
}

struct Entry {
    /// Holds the picture's buffer alive, so its address (the key) is not
    /// reused by another picture while the entry exists.
    _source: paged_compose::DecodedImage,
    pixels: Pixels,
    /// The GPU lane's image of `pixels`, made once so its blob keeps one
    /// id (Vello uploads it once).
    #[cfg(feature = "vello-backend")]
    gpu: Option<vello::peniko::ImageData>,
    bytes: usize,
    used: u64,
}

struct Store {
    entries: HashMap<Key, Entry>,
    tick: u64,
    stats: StoreStats,
}

impl Store {
    fn touch(&mut self, key: Key) -> Option<&mut Entry> {
        self.tick += 1;
        let tick = self.tick;
        let entry = self.entries.get_mut(&key)?;
        entry.used = tick;
        Some(entry)
    }

    /// Hold `entry`, unless it is larger than the whole budget.
    fn keep(&mut self, key: Key, entry: Entry) {
        self.stats.decodes += 1;
        if entry.bytes > self.stats.budget {
            self.stats.uncached += 1;
            return;
        }
        self.stats.bytes += entry.bytes;
        self.entries.insert(key, entry);
        self.trim(Some(key));
        self.stats.peak_bytes = self.stats.peak_bytes.max(self.stats.bytes);
    }

    /// Drop the entries drawn longest ago (never `keep`) until the store
    /// is within its budget.
    fn trim(&mut self, keep: Option<Key>) {
        while self.stats.bytes > self.stats.budget {
            let Some(oldest) = self
                .entries
                .iter()
                .filter(|(k, _)| Some(**k) != keep)
                .min_by_key(|(_, e)| e.used)
                .map(|(k, _)| *k)
            else {
                break;
            };
            if let Some(e) = self.entries.remove(&oldest) {
                self.stats.bytes -= e.bytes;
                self.stats.evictions += 1;
            }
        }
        self.stats.entries = self.entries.len();
    }
}

thread_local! {
    static STORE: RefCell<Store> = RefCell::new(Store {
        entries: HashMap::new(),
        tick: 0,
        stats: StoreStats {
            budget: DEFAULT_BUDGET_BYTES,
            ..StoreStats::default()
        },
    });
}

/// What the store holds and has done on this thread.
pub fn stats() -> StoreStats {
    STORE.with(|s| s.borrow().stats)
}

/// Set the budget, in bytes, and evict down to it.
pub fn set_budget(bytes: usize) {
    STORE.with(|s| {
        let mut s = s.borrow_mut();
        s.stats.budget = bytes;
        s.trim(None);
    });
}

/// Drop every held decode (a document was closed or replaced). The
/// counters and the budget stay.
pub fn clear() {
    STORE.with(|s| {
        let mut s = s.borrow_mut();
        s.entries.clear();
        s.stats.bytes = 0;
        s.stats.entries = 0;
    });
}

/// `img`'s straight-alpha pixels at `level`: the build's own pixels at
/// level 0, else decoded from the encoded bytes at the level's size (a
/// JPEG at its DCT scale: `paged_raster::decode_rgba8_at_with`) with the
/// intent the build recorded.
fn decode(img: &paged_compose::DecodedImage, level: u8) -> Option<Vec<u8>> {
    if is_eager(img) {
        return Some(img.rgba.as_ref().to_vec());
    }
    if img.encoded.is_empty() {
        return None;
    }
    let (w, h) = level_dims(img.width, img.height, level);
    let conv = paged_raster::PagedColour::new(img.rendering.unwrap_or_default());
    paged_compose::perf::count(|c| c.scene_image_decodes += 1);
    paged_raster::decode_rgba8_at_with(&img.encoded, w, h, &conv)
}

#[cfg(feature = "cpu")]
fn to_pixmap(rgba: Vec<u8>, w: u32, h: u32) -> Arc<vello_cpu::Pixmap> {
    Arc::new(vello_cpu::Pixmap::from_parts(
        rgba,
        w as u16,
        h as u16,
        vello_cpu::PixelMetadata::new(vello_cpu::peniko::ImageAlphaType::Alpha, true),
    ))
}

/// `img` at `level` (level 0 when the build decoded it) as a `vello_cpu`
/// pixmap, with the pixmap's size. Every later draw of the picture at that
/// level, on either lane, shares it while it is held.
#[cfg(feature = "cpu")]
pub(crate) fn pixmap(
    img: &paged_compose::DecodedImage,
    level: u8,
) -> Option<(Arc<vello_cpu::Pixmap>, u32, u32)> {
    let level = if is_eager(img) { 0 } else { level };
    let (w, h) = level_dims(img.width, img.height, level);
    if w > u32::from(u16::MAX) || h > u32::from(u16::MAX) {
        return None;
    }
    let key = Key::of(img, level)?;
    STORE.with(|s| {
        let mut s = s.borrow_mut();
        if let Some(entry) = s.touch(key) {
            let (pixmap, grew) = match &entry.pixels {
                Pixels::Pixmap(p) => (p.clone(), 0),
                Pixels::Straight(rgba) => {
                    // A GPU-only decode the CPU lane now draws too: the GPU
                    // image keeps the straight bytes it was made from.
                    let p = to_pixmap(rgba.as_ref().clone(), w, h);
                    #[cfg(feature = "vello-backend")]
                    let grew = if entry.gpu.is_some() { rgba.len() } else { 0 };
                    #[cfg(not(feature = "vello-backend"))]
                    let grew = 0;
                    entry.pixels = Pixels::Pixmap(p.clone());
                    entry.bytes += grew;
                    (p, grew)
                }
            };
            s.stats.hits += 1;
            if grew > 0 {
                s.stats.bytes += grew;
                s.trim(Some(key));
                s.stats.peak_bytes = s.stats.peak_bytes.max(s.stats.bytes);
            }
            return Some((pixmap, w, h));
        }
        let rgba = decode(img, level)?;
        if rgba.len() != w as usize * h as usize * 4 {
            return None;
        }
        let bytes = rgba.len();
        let pixmap = to_pixmap(rgba, w, h);
        let used = s.tick;
        s.keep(
            key,
            Entry {
                _source: img.clone(),
                pixels: Pixels::Pixmap(pixmap.clone()),
                #[cfg(feature = "vello-backend")]
                gpu: None,
                bytes,
                used,
            },
        );
        Some((pixmap, w, h))
    })
}

/// The bytes of a held pixmap, for a GPU image that shares them.
#[cfg(all(feature = "cpu", feature = "vello-backend"))]
struct PixmapBytes(Arc<vello_cpu::Pixmap>);

#[cfg(all(feature = "cpu", feature = "vello-backend"))]
impl AsRef<[u8]> for PixmapBytes {
    fn as_ref(&self) -> &[u8] {
        self.0.data_as_u8_slice()
    }
}

/// The GPU lane's image of `pixels`, `w × h`.
#[cfg(feature = "vello-backend")]
fn gpu_image(pixels: &Pixels, w: u32, h: u32) -> vello::peniko::ImageData {
    use vello::peniko::{Blob, ImageAlphaType, ImageData, ImageFormat};
    let (data, alpha_type) = match pixels {
        Pixels::Straight(rgba) => (Blob::new(rgba.clone()), ImageAlphaType::Alpha),
        #[cfg(feature = "cpu")]
        Pixels::Pixmap(p) => (
            Blob::new(Arc::new(PixmapBytes(p.clone()))),
            ImageAlphaType::AlphaPremultiplied,
        ),
    };
    ImageData {
        data,
        format: ImageFormat::Rgba8,
        alpha_type,
        width: w,
        height: h,
    }
}

/// `img` at `level` (level 0 when the build decoded it) as the GPU lane's
/// image. The same blob, so the same GPU upload, for every later scene
/// while the entry is held.
#[cfg(feature = "vello-backend")]
pub(crate) fn image_data(
    img: &paged_compose::DecodedImage,
    level: u8,
) -> Option<vello::peniko::ImageData> {
    let level = if is_eager(img) { 0 } else { level };
    let (w, h) = level_dims(img.width, img.height, level);
    let key = Key::of(img, level)?;
    STORE.with(|s| {
        let mut s = s.borrow_mut();
        if let Some(entry) = s.touch(key) {
            let data = match &entry.gpu {
                Some(d) => d.clone(),
                None => {
                    let d = gpu_image(&entry.pixels, w, h);
                    entry.gpu = Some(d.clone());
                    d
                }
            };
            s.stats.hits += 1;
            return Some(data);
        }
        let rgba = decode(img, level)?;
        if rgba.len() != w as usize * h as usize * 4 {
            return None;
        }
        let bytes = rgba.len();
        #[cfg(feature = "cpu")]
        let pixels = Pixels::Pixmap(to_pixmap(rgba, w, h));
        #[cfg(not(feature = "cpu"))]
        let pixels = Pixels::Straight(Arc::new(rgba));
        let data = gpu_image(&pixels, w, h);
        let used = s.tick;
        s.keep(
            key,
            Entry {
                _source: img.clone(),
                pixels,
                gpu: Some(data.clone()),
                bytes,
                used,
            },
        );
        Some(data)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_level_is_the_deepest_that_still_covers_the_draw() {
        assert_eq!(level_dims(4096, 2048, 0), (4096, 2048));
        assert_eq!(level_dims(4096, 2048, 3), (512, 256));
        assert_eq!(level_dims(5, 3, 2), (2, 1));
        // Drawn at its own size or larger: level 0.
        assert_eq!(level_for(4096, 2048, 4096.0, 2048.0), 0);
        assert_eq!(level_for(100, 100, 400.0, 400.0), 0);
        // A 4096 px picture across 300 device pixels: level 3 (512 px),
        // level 4 (256 px) would be fewer than the draw.
        assert_eq!(level_for(4096, 4096, 300.0, 300.0), 3);
        assert_eq!(level_for(4096, 4096, 256.0, 256.0), 4);
        // The tighter axis decides.
        assert_eq!(level_for(4096, 1024, 300.0, 300.0), 1);
        // Never past the deepest level, never on nonsense.
        assert_eq!(level_for(1 << 20, 1 << 20, 1.0, 1.0), MAX_LEVEL);
        assert_eq!(level_for(4096, 4096, f64::NAN, 1.0), 0);
    }
}

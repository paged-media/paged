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

//! The image's WORKSPACE (WP5.12, image ADR 474): the ruler guides, the
//! Count tool's numbered marks in their groups, the Note tool's
//! annotations and the Slice tool's rectangles — the parts of a
//! Photoshop document that are about working on the image rather than
//! its pixels.
//!
//! [`Workspace`] lives in the layer stack's snapshot like the masking
//! state, so every change is one structure step on the one undo list
//! (ADR 463), and it is persisted as a trailing block of the layer
//! manifest (`"PGWS"`, after the masking block). The guides also travel
//! through a PSD as Photoshop's grid-and-guides resource (id 1032).
//!
//! Every coordinate is in image pixels on the continuous plane (a guide
//! at 10 lies on the edge between pixel 9 and pixel 10), so a canvas
//! operation moves the workspace with the same point map the paths use.

use crate::ingest::IngestError;
use crate::masking::{json_str, Reader};

/// Most guides a document keeps.
pub const MAX_GUIDES: usize = 4096;
/// Most count groups, and most marks in one group (Photoshop numbers
/// up to 9999 per group).
pub const MAX_COUNT_GROUPS: usize = 64;
pub const MAX_COUNT_MARKS: usize = 9999;
/// Most notes and most slices.
pub const MAX_NOTES: usize = 1024;
pub const MAX_SLICES: usize = 1024;
/// The longest note text and name kept, in bytes.
pub const MAX_TEXT: usize = 16 * 1024;

/// One ruler guide.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Guide {
    /// A vertical guide marks an x position; a horizontal one a y.
    pub vertical: bool,
    /// The position in image pixels.
    pub pos: f32,
}

/// One group of the Count tool's marks: its own numbering from 1, its
/// own colour.
#[derive(Debug, Clone, PartialEq)]
pub struct CountGroup {
    pub name: String,
    pub color: [u8; 3],
    pub visible: bool,
    pub marks: Vec<[f32; 2]>,
}

/// A note pinned to a point of the image.
#[derive(Debug, Clone, PartialEq)]
pub struct Note {
    pub at: [f32; 2],
    pub author: String,
    pub text: String,
}

/// A slice: a named rectangle of whole pixels the export cuts out.
#[derive(Debug, Clone, PartialEq)]
pub struct Slice {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
    pub name: String,
}

/// The Count tool's group colours, in the order new groups take them
/// (Photoshop starts with red).
pub const COUNT_COLORS: [[u8; 3]; 6] = [
    [230, 30, 30],
    [30, 120, 230],
    [20, 160, 60],
    [220, 140, 0],
    [150, 50, 200],
    [0, 160, 170],
];

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Workspace {
    pub guides: Vec<Guide>,
    pub counts: Vec<CountGroup>,
    /// The group new marks go into (an index into `counts`).
    pub active_count: usize,
    pub notes: Vec<Note>,
    pub slices: Vec<Slice>,
}

fn bad(what: impl Into<String>) -> IngestError {
    IngestError::Unsupported(what.into())
}

fn finite(p: [f32; 2]) -> Result<[f32; 2], IngestError> {
    if p[0].is_finite() && p[1].is_finite() {
        Ok(p)
    } else {
        Err(bad("a workspace position must be a finite number"))
    }
}

fn clipped_text(s: &str) -> String {
    if s.len() <= MAX_TEXT {
        return s.to_string();
    }
    let mut end = MAX_TEXT;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_string()
}

impl Workspace {
    pub fn is_empty(&self) -> bool {
        self.guides.is_empty()
            && self.counts.is_empty()
            && self.notes.is_empty()
            && self.slices.is_empty()
    }

    // ── guides ──────────────────────────────────────────────────────

    /// Add a guide; answers its index.
    pub fn add_guide(&mut self, vertical: bool, pos: f32) -> Result<usize, IngestError> {
        if !pos.is_finite() {
            return Err(bad("a guide position must be a finite number"));
        }
        if self.guides.len() >= MAX_GUIDES {
            return Err(bad(format!("an image keeps at most {MAX_GUIDES} guides")));
        }
        self.guides.push(Guide { vertical, pos });
        Ok(self.guides.len() - 1)
    }

    /// Move guide `index` to `pos`; false when it is already there.
    pub fn move_guide(&mut self, index: usize, pos: f32) -> Result<bool, IngestError> {
        if !pos.is_finite() {
            return Err(bad("a guide position must be a finite number"));
        }
        let g = self
            .guides
            .get_mut(index)
            .ok_or_else(|| bad(format!("no guide {index}")))?;
        if g.pos == pos {
            return Ok(false);
        }
        g.pos = pos;
        Ok(true)
    }

    pub fn delete_guide(&mut self, index: usize) -> Result<(), IngestError> {
        if index >= self.guides.len() {
            return Err(bad(format!("no guide {index}")));
        }
        self.guides.remove(index);
        Ok(())
    }

    /// Remove every guide; false when there were none.
    pub fn clear_guides(&mut self) -> bool {
        let had = !self.guides.is_empty();
        self.guides.clear();
        had
    }

    // ── count ───────────────────────────────────────────────────────

    /// The group a new mark goes into, creating the first group when
    /// there is none.
    fn count_group_for_mark(&mut self) -> Result<usize, IngestError> {
        if self.counts.is_empty() {
            self.new_count_group(None)?;
        }
        Ok(self.active_count.min(self.counts.len() - 1))
    }

    /// A new count group (named "Count Group n" when `name` is None),
    /// made the active one; answers its index.
    pub fn new_count_group(&mut self, name: Option<&str>) -> Result<usize, IngestError> {
        if self.counts.len() >= MAX_COUNT_GROUPS {
            return Err(bad(format!(
                "an image keeps at most {MAX_COUNT_GROUPS} count groups"
            )));
        }
        let n = self.counts.len();
        let name = name
            .map(clipped_text)
            .unwrap_or_else(|| format!("Count Group {}", n + 1));
        self.counts.push(CountGroup {
            name,
            color: COUNT_COLORS[n % COUNT_COLORS.len()],
            visible: true,
            marks: Vec::new(),
        });
        self.active_count = n;
        Ok(n)
    }

    /// Mark `at` in the active group; answers (group, the mark's number
    /// from 1).
    pub fn add_count(&mut self, at: [f32; 2]) -> Result<(usize, usize), IngestError> {
        let at = finite(at)?;
        let g = self.count_group_for_mark()?;
        let group = &mut self.counts[g];
        if group.marks.len() >= MAX_COUNT_MARKS {
            return Err(bad(format!(
                "a count group numbers at most {MAX_COUNT_MARKS} marks"
            )));
        }
        group.marks.push(at);
        Ok((g, group.marks.len()))
    }

    /// Move mark `index` of `group`.
    pub fn move_count(
        &mut self,
        group: usize,
        index: usize,
        at: [f32; 2],
    ) -> Result<bool, IngestError> {
        let at = finite(at)?;
        let m = self
            .counts
            .get_mut(group)
            .and_then(|g| g.marks.get_mut(index))
            .ok_or_else(|| bad(format!("no count mark {group}/{index}")))?;
        if *m == at {
            return Ok(false);
        }
        *m = at;
        Ok(true)
    }

    /// Remove mark `index` of `group`; the marks after it renumber.
    pub fn remove_count(&mut self, group: usize, index: usize) -> Result<(), IngestError> {
        let g = self
            .counts
            .get_mut(group)
            .ok_or_else(|| bad(format!("no count group {group}")))?;
        if index >= g.marks.len() {
            return Err(bad(format!("no count mark {group}/{index}")));
        }
        g.marks.remove(index);
        Ok(())
    }

    /// Clear the marks of `group` (the group stays); false when it had none.
    pub fn clear_counts(&mut self, group: usize) -> Result<bool, IngestError> {
        let g = self
            .counts
            .get_mut(group)
            .ok_or_else(|| bad(format!("no count group {group}")))?;
        let had = !g.marks.is_empty();
        g.marks.clear();
        Ok(had)
    }

    pub fn set_active_count(&mut self, group: usize) -> Result<bool, IngestError> {
        if group >= self.counts.len() {
            return Err(bad(format!("no count group {group}")));
        }
        let changed = self.active_count != group;
        self.active_count = group;
        Ok(changed)
    }

    pub fn set_count_group(
        &mut self,
        group: usize,
        name: Option<&str>,
        color: Option<[u8; 3]>,
        visible: Option<bool>,
    ) -> Result<bool, IngestError> {
        let g = self
            .counts
            .get_mut(group)
            .ok_or_else(|| bad(format!("no count group {group}")))?;
        let before = g.clone();
        if let Some(n) = name {
            g.name = clipped_text(n);
        }
        if let Some(c) = color {
            g.color = c;
        }
        if let Some(v) = visible {
            g.visible = v;
        }
        Ok(*g != before)
    }

    pub fn delete_count_group(&mut self, group: usize) -> Result<(), IngestError> {
        if group >= self.counts.len() {
            return Err(bad(format!("no count group {group}")));
        }
        self.counts.remove(group);
        if self.active_count >= group && self.active_count > 0 {
            self.active_count -= 1;
        }
        Ok(())
    }

    // ── notes ───────────────────────────────────────────────────────

    pub fn add_note(
        &mut self,
        at: [f32; 2],
        author: &str,
        text: &str,
    ) -> Result<usize, IngestError> {
        let at = finite(at)?;
        if self.notes.len() >= MAX_NOTES {
            return Err(bad(format!("an image keeps at most {MAX_NOTES} notes")));
        }
        self.notes.push(Note {
            at,
            author: clipped_text(author),
            text: clipped_text(text),
        });
        Ok(self.notes.len() - 1)
    }

    pub fn edit_note(
        &mut self,
        index: usize,
        author: &str,
        text: &str,
    ) -> Result<bool, IngestError> {
        let n = self
            .notes
            .get_mut(index)
            .ok_or_else(|| bad(format!("no note {index}")))?;
        let (author, text) = (clipped_text(author), clipped_text(text));
        if n.author == author && n.text == text {
            return Ok(false);
        }
        n.author = author;
        n.text = text;
        Ok(true)
    }

    pub fn move_note(&mut self, index: usize, at: [f32; 2]) -> Result<bool, IngestError> {
        let at = finite(at)?;
        let n = self
            .notes
            .get_mut(index)
            .ok_or_else(|| bad(format!("no note {index}")))?;
        if n.at == at {
            return Ok(false);
        }
        n.at = at;
        Ok(true)
    }

    pub fn delete_note(&mut self, index: usize) -> Result<(), IngestError> {
        if index >= self.notes.len() {
            return Err(bad(format!("no note {index}")));
        }
        self.notes.remove(index);
        Ok(())
    }

    pub fn clear_notes(&mut self) -> bool {
        let had = !self.notes.is_empty();
        self.notes.clear();
        had
    }

    // ── slices ──────────────────────────────────────────────────────

    /// The rectangle clipped to a `width`×`height` canvas, or an error
    /// when nothing of it is left.
    fn clip_rect(
        x: i64,
        y: i64,
        w: i64,
        h: i64,
        width: u32,
        height: u32,
    ) -> Result<(u32, u32, u32, u32), IngestError> {
        let x0 = x.clamp(0, i64::from(width));
        let y0 = y.clamp(0, i64::from(height));
        let x1 = (x + w).clamp(0, i64::from(width));
        let y1 = (y + h).clamp(0, i64::from(height));
        if x1 <= x0 || y1 <= y0 {
            return Err(bad("a slice must cover at least one pixel of the image"));
        }
        Ok((x0 as u32, y0 as u32, (x1 - x0) as u32, (y1 - y0) as u32))
    }

    /// Add a slice (clipped to the canvas), named "<base>_<nn>" when
    /// `name` is empty; answers its index.
    #[allow(clippy::too_many_arguments)]
    pub fn add_slice(
        &mut self,
        x: i64,
        y: i64,
        w: i64,
        h: i64,
        name: &str,
        width: u32,
        height: u32,
    ) -> Result<usize, IngestError> {
        if self.slices.len() >= MAX_SLICES {
            return Err(bad(format!("an image keeps at most {MAX_SLICES} slices")));
        }
        let (x, y, w, h) = Self::clip_rect(x, y, w, h, width, height)?;
        let name = if name.trim().is_empty() {
            self.next_slice_name()
        } else {
            clipped_text(name.trim())
        };
        self.slices.push(Slice { x, y, w, h, name });
        Ok(self.slices.len() - 1)
    }

    fn next_slice_name(&self) -> String {
        (1..)
            .map(|n| format!("slice_{n:02}"))
            .find(|n| !self.slices.iter().any(|s| &s.name == n))
            .expect("an unused name")
    }

    #[allow(clippy::too_many_arguments)]
    pub fn set_slice(
        &mut self,
        index: usize,
        x: i64,
        y: i64,
        w: i64,
        h: i64,
        name: Option<&str>,
        width: u32,
        height: u32,
    ) -> Result<bool, IngestError> {
        let (x, y, w, h) = Self::clip_rect(x, y, w, h, width, height)?;
        let s = self
            .slices
            .get_mut(index)
            .ok_or_else(|| bad(format!("no slice {index}")))?;
        let before = s.clone();
        (s.x, s.y, s.w, s.h) = (x, y, w, h);
        if let Some(n) = name.map(str::trim).filter(|n| !n.is_empty()) {
            s.name = clipped_text(n);
        }
        Ok(*s != before)
    }

    pub fn delete_slice(&mut self, index: usize) -> Result<(), IngestError> {
        if index >= self.slices.len() {
            return Err(bad(format!("no slice {index}")));
        }
        self.slices.remove(index);
        Ok(())
    }

    pub fn clear_slices(&mut self) -> bool {
        let had = !self.slices.is_empty();
        self.slices.clear();
        had
    }

    /// One slice per guide cell: the guides cut the canvas into a grid
    /// (Photoshop's Slices From Guides). Replaces the slices; answers
    /// how many there are.
    pub fn slices_from_guides(&mut self, width: u32, height: u32) -> Result<usize, IngestError> {
        let cuts = |vertical: bool, extent: u32| -> Vec<u32> {
            let mut c: Vec<u32> = self
                .guides
                .iter()
                .filter(|g| g.vertical == vertical)
                .map(|g| g.pos.round())
                .filter(|p| *p > 0.0 && *p < extent as f32)
                .map(|p| p as u32)
                .collect();
            c.push(0);
            c.push(extent);
            c.sort_unstable();
            c.dedup();
            c
        };
        let xs = cuts(true, width);
        let ys = cuts(false, height);
        let n = (xs.len() - 1) * (ys.len() - 1);
        if n > MAX_SLICES {
            return Err(bad(format!("an image keeps at most {MAX_SLICES} slices")));
        }
        let mut slices = Vec::with_capacity(n);
        for row in ys.windows(2) {
            for col in xs.windows(2) {
                slices.push(Slice {
                    x: col[0],
                    y: row[0],
                    w: col[1] - col[0],
                    h: row[1] - row[0],
                    name: format!("slice_{:02}", slices.len() + 1),
                });
            }
        }
        self.slices = slices;
        Ok(n)
    }

    // ── canvas operations ───────────────────────────────────────────

    /// Follow a canvas operation: every point moves through `f` (the
    /// same map the paths take) onto the new `width`×`height` canvas. A
    /// guide maps as a line and survives only while it stays axis-
    /// aligned (an arbitrary rotation drops it, as Photoshop's does);
    /// a slice maps to the bounds of its mapped corners, clipped, and
    /// goes when nothing of it is left on the canvas. Marks and notes
    /// keep their place on the image wherever it lands.
    pub fn map_canvas(&mut self, f: impl Fn([f32; 2]) -> [f32; 2], width: u32, height: u32) {
        const EPS: f32 = 1e-3;
        self.guides = self
            .guides
            .iter()
            .filter_map(|g| {
                let (a, b) = if g.vertical {
                    (f([g.pos, 0.0]), f([g.pos, 1.0]))
                } else {
                    (f([0.0, g.pos]), f([1.0, g.pos]))
                };
                if (a[0] - b[0]).abs() < EPS {
                    Some(Guide {
                        vertical: true,
                        pos: a[0],
                    })
                } else if (a[1] - b[1]).abs() < EPS {
                    Some(Guide {
                        vertical: false,
                        pos: a[1],
                    })
                } else {
                    None
                }
            })
            .collect();
        for g in &mut self.counts {
            for m in &mut g.marks {
                *m = f(*m);
            }
        }
        for n in &mut self.notes {
            n.at = f(n.at);
        }
        self.slices = self
            .slices
            .iter()
            .filter_map(|s| {
                let corners = [
                    f([s.x as f32, s.y as f32]),
                    f([(s.x + s.w) as f32, s.y as f32]),
                    f([s.x as f32, (s.y + s.h) as f32]),
                    f([(s.x + s.w) as f32, (s.y + s.h) as f32]),
                ];
                let x0 = corners.iter().map(|c| c[0]).fold(f32::INFINITY, f32::min);
                let y0 = corners.iter().map(|c| c[1]).fold(f32::INFINITY, f32::min);
                let x1 = corners
                    .iter()
                    .map(|c| c[0])
                    .fold(f32::NEG_INFINITY, f32::max);
                let y1 = corners
                    .iter()
                    .map(|c| c[1])
                    .fold(f32::NEG_INFINITY, f32::max);
                let (x0, y0) = (x0.round() as i64, y0.round() as i64);
                let (x1, y1) = (x1.round() as i64, y1.round() as i64);
                Self::clip_rect(x0, y0, x1 - x0, y1 - y0, width, height)
                    .ok()
                    .map(|(x, y, w, h)| Slice {
                        x,
                        y,
                        w,
                        h,
                        name: s.name.clone(),
                    })
            })
            .collect();
    }

    // ── PSD ─────────────────────────────────────────────────────────

    /// The guides as Photoshop's grid-and-guides record entries.
    pub fn psd_guides(&self) -> Vec<image_psd::model::PsdGuide> {
        self.guides
            .iter()
            .map(|g| image_psd::model::PsdGuide::at_pixels(f64::from(g.pos), !g.vertical))
            .collect()
    }

    /// The guides of a PSD's grid-and-guides record (at most
    /// [`MAX_GUIDES`]).
    pub fn guides_from_psd(guides: &[image_psd::model::PsdGuide]) -> Vec<Guide> {
        guides
            .iter()
            .take(MAX_GUIDES)
            .map(|g| Guide {
                vertical: !g.horizontal,
                pos: g.pixels() as f32,
            })
            .collect()
    }

    // ── persistence ─────────────────────────────────────────────────

    /// The trailing manifest block (`"PGWS"`, version 1), all
    /// little-endian: u32 guide count and per guide {u8 vertical, f32
    /// position}; u32 active count group, u32 group count and per group
    /// {str name, u8 r, g, b, u8 visible, u32 marks, 2 f32 each}; u32
    /// note count and per note {2 f32, str author, str text}; u32 slice
    /// count and per slice {u32 x, y, w, h, str name}. A `str` is u32
    /// length + UTF-8. An empty workspace writes nothing at all.
    pub fn encode(&self, out: &mut Vec<u8>) {
        if self.is_empty() {
            return;
        }
        let u32 = |o: &mut Vec<u8>, v: u32| o.extend_from_slice(&v.to_le_bytes());
        let f32 = |o: &mut Vec<u8>, v: f32| o.extend_from_slice(&v.to_le_bytes());
        let s = |o: &mut Vec<u8>, v: &str| {
            o.extend_from_slice(&(v.len() as u32).to_le_bytes());
            o.extend_from_slice(v.as_bytes());
        };
        out.extend_from_slice(WORKSPACE_MAGIC);
        u32(out, WORKSPACE_VERSION);
        u32(out, self.guides.len() as u32);
        for g in &self.guides {
            out.push(u8::from(g.vertical));
            f32(out, g.pos);
        }
        u32(out, self.active_count as u32);
        u32(out, self.counts.len() as u32);
        for g in &self.counts {
            s(out, &g.name);
            out.extend_from_slice(&g.color);
            out.push(u8::from(g.visible));
            u32(out, g.marks.len() as u32);
            for m in &g.marks {
                f32(out, m[0]);
                f32(out, m[1]);
            }
        }
        u32(out, self.notes.len() as u32);
        for n in &self.notes {
            f32(out, n.at[0]);
            f32(out, n.at[1]);
            s(out, &n.author);
            s(out, &n.text);
        }
        u32(out, self.slices.len() as u32);
        for sl in &self.slices {
            u32(out, sl.x);
            u32(out, sl.y);
            u32(out, sl.w);
            u32(out, sl.h);
            s(out, &sl.name);
        }
    }

    /// Read the block back from `rest` (empty, or another block's bytes:
    /// no workspace).
    pub fn decode(rest: &[u8]) -> Result<Workspace, String> {
        if rest.len() < 4 || &rest[..4] != WORKSPACE_MAGIC {
            return Ok(Workspace::default());
        }
        let mut r = Reader { b: rest, at: 4 };
        let version = r.u32()?;
        if version != WORKSPACE_VERSION {
            return Err(format!(
                "workspace block version {version} (this engine reads {WORKSPACE_VERSION})"
            ));
        }
        // Every count is checked against what is left, so a damaged
        // block cannot ask for a huge allocation.
        let count = |r: &mut Reader<'_>, each: usize, max: usize| -> Result<usize, String> {
            let n = r.u32()? as usize;
            if n > max || n.saturating_mul(each) > r.b.len() - r.at {
                return Err("workspace block is truncated".to_string());
            }
            Ok(n)
        };
        let mut ws = Workspace::default();
        for _ in 0..count(&mut r, 5, MAX_GUIDES)? {
            let vertical = r.u8()? != 0;
            let pos = r.f32()?;
            ws.guides.push(Guide { vertical, pos });
        }
        let active = r.u32()? as usize;
        for _ in 0..count(&mut r, 12, MAX_COUNT_GROUPS)? {
            let name = r.str()?;
            let color = [r.u8()?, r.u8()?, r.u8()?];
            let visible = r.u8()? != 0;
            let mut marks = Vec::new();
            for _ in 0..count(&mut r, 8, MAX_COUNT_MARKS)? {
                marks.push([r.f32()?, r.f32()?]);
            }
            ws.counts.push(CountGroup {
                name,
                color,
                visible,
                marks,
            });
        }
        ws.active_count = active.min(ws.counts.len().saturating_sub(1));
        for _ in 0..count(&mut r, 16, MAX_NOTES)? {
            let at = [r.f32()?, r.f32()?];
            let author = r.str()?;
            let text = r.str()?;
            ws.notes.push(Note { at, author, text });
        }
        for _ in 0..count(&mut r, 20, MAX_SLICES)? {
            let (x, y, w, h) = (r.u32()?, r.u32()?, r.u32()?, r.u32()?);
            let name = r.str()?;
            ws.slices.push(Slice { x, y, w, h, name });
        }
        Ok(ws)
    }

    /// The readout the bundle reads (`layers_workspace`).
    pub fn to_json(&self) -> String {
        let guides: Vec<String> = self
            .guides
            .iter()
            .map(|g| {
                format!(
                    "{{\"orientation\":\"{}\",\"position\":{}}}",
                    if g.vertical { "vertical" } else { "horizontal" },
                    g.pos
                )
            })
            .collect();
        let counts: Vec<String> = self
            .counts
            .iter()
            .map(|g| {
                let marks: Vec<String> = g
                    .marks
                    .iter()
                    .map(|m| format!("[{},{}]", m[0], m[1]))
                    .collect();
                format!(
                    "{{\"name\":{},\"color\":[{},{},{}],\"visible\":{},\"marks\":[{}]}}",
                    json_str(&g.name),
                    g.color[0],
                    g.color[1],
                    g.color[2],
                    g.visible,
                    marks.join(",")
                )
            })
            .collect();
        let notes: Vec<String> = self
            .notes
            .iter()
            .map(|n| {
                format!(
                    "{{\"at\":[{},{}],\"author\":{},\"text\":{}}}",
                    n.at[0],
                    n.at[1],
                    json_str(&n.author),
                    json_str(&n.text)
                )
            })
            .collect();
        let slices: Vec<String> = self
            .slices
            .iter()
            .map(|s| {
                format!(
                    "{{\"x\":{},\"y\":{},\"w\":{},\"h\":{},\"name\":{}}}",
                    s.x,
                    s.y,
                    s.w,
                    s.h,
                    json_str(&s.name)
                )
            })
            .collect();
        format!(
            "{{\"guides\":[{}],\"counts\":[{}],\"activeCount\":{},\"notes\":[{}],\"slices\":[{}]}}",
            guides.join(","),
            counts.join(","),
            self.active_count,
            notes.join(","),
            slices.join(",")
        )
    }
}

const WORKSPACE_MAGIC: &[u8; 4] = b"PGWS";
const WORKSPACE_VERSION: u32 = 1;

#[cfg(test)]
mod tests {
    use super::*;

    fn full() -> Workspace {
        let mut ws = Workspace::default();
        ws.add_guide(true, 10.0).unwrap();
        ws.add_guide(false, 2.5).unwrap();
        ws.add_count([1.0, 2.0]).unwrap();
        ws.add_count([3.0, 4.0]).unwrap();
        ws.new_count_group(Some("Cells")).unwrap();
        ws.add_count([5.0, 6.0]).unwrap();
        ws.add_note([7.0, 8.0], "A", "check \"this\"\nline")
            .unwrap();
        ws.add_slice(0, 0, 4, 4, "", 20, 10).unwrap();
        ws.add_slice(4, 0, 4, 4, "logo", 20, 10).unwrap();
        ws
    }

    #[test]
    fn the_block_round_trips_every_part() {
        let ws = full();
        let mut out = Vec::new();
        ws.encode(&mut out);
        assert_eq!(Workspace::decode(&out).unwrap(), ws);
    }

    #[test]
    fn an_empty_workspace_writes_nothing_and_reads_back_empty() {
        let mut out = Vec::new();
        Workspace::default().encode(&mut out);
        assert!(out.is_empty());
        assert_eq!(Workspace::decode(&out).unwrap(), Workspace::default());
        assert_eq!(
            Workspace::decode(b"PGMKxxxx").unwrap(),
            Workspace::default()
        );
    }

    #[test]
    fn a_truncated_block_is_refused_not_misread() {
        let mut out = Vec::new();
        full().encode(&mut out);
        for cut in [8, 12, out.len() - 1] {
            assert!(Workspace::decode(&out[..cut]).is_err(), "cut at {cut}");
        }
    }

    #[test]
    fn count_groups_number_their_own_marks() {
        let ws = full();
        assert_eq!(ws.counts.len(), 2);
        assert_eq!(ws.counts[0].name, "Count Group 1");
        assert_eq!(ws.counts[0].marks.len(), 2);
        assert_eq!(ws.counts[1].marks, vec![[5.0, 6.0]]);
        assert_eq!(ws.active_count, 1);
        assert_ne!(ws.counts[0].color, ws.counts[1].color);
    }

    #[test]
    fn slices_are_clipped_and_named() {
        let mut ws = Workspace::default();
        ws.add_slice(-5, -5, 10, 10, "", 8, 8).unwrap();
        assert_eq!((ws.slices[0].x, ws.slices[0].y, ws.slices[0].w), (0, 0, 5));
        assert_eq!(ws.slices[0].name, "slice_01");
        assert!(ws.add_slice(20, 20, 4, 4, "", 8, 8).is_err());
        ws.add_slice(1, 1, 1, 1, "", 8, 8).unwrap();
        assert_eq!(ws.slices[1].name, "slice_02");
    }

    #[test]
    fn slices_from_guides_cut_the_canvas_into_cells() {
        let mut ws = Workspace::default();
        ws.add_guide(true, 4.0).unwrap();
        ws.add_guide(false, 3.0).unwrap();
        ws.add_guide(true, 99.0).unwrap(); // outside: ignored
        assert_eq!(ws.slices_from_guides(10, 6).unwrap(), 4);
        let rects: Vec<_> = ws.slices.iter().map(|s| (s.x, s.y, s.w, s.h)).collect();
        assert_eq!(
            rects,
            vec![(0, 0, 4, 3), (4, 0, 6, 3), (0, 3, 4, 3), (4, 3, 6, 3)]
        );
    }

    #[test]
    fn a_quarter_turn_turns_guides_and_an_arbitrary_one_drops_them() {
        let mut ws = Workspace::default();
        ws.add_guide(true, 3.0).unwrap();
        ws.add_guide(false, 1.0).unwrap();
        ws.add_slice(0, 0, 2, 1, "s", 4, 2).unwrap();
        // Rotate 90° clockwise over a 4×2 canvas: (x, y) → (h − y, x).
        let mut cw = ws.clone();
        cw.map_canvas(|p| [2.0 - p[1], p[0]], 2, 4);
        assert_eq!(
            cw.guides,
            vec![
                Guide {
                    vertical: false,
                    pos: 3.0
                },
                Guide {
                    vertical: true,
                    pos: 1.0
                }
            ]
        );
        assert_eq!(
            (
                cw.slices[0].x,
                cw.slices[0].y,
                cw.slices[0].w,
                cw.slices[0].h
            ),
            (1, 0, 1, 2)
        );
        let mut tilted = ws.clone();
        let (s, c) = 0.3f32.sin_cos();
        tilted.map_canvas(|p| [p[0] * c - p[1] * s, p[0] * s + p[1] * c], 10, 10);
        assert!(tilted.guides.is_empty());
    }

    #[test]
    fn psd_guides_round_trip_at_a_32nd_of_a_pixel() {
        let mut ws = Workspace::default();
        ws.add_guide(true, 12.5).unwrap();
        ws.add_guide(false, 0.03125).unwrap();
        let back = Workspace::guides_from_psd(&ws.psd_guides());
        assert_eq!(back, ws.guides);
        assert!(!ws.psd_guides()[0].horizontal);
        assert_eq!(ws.psd_guides()[0].location, 400);
    }

    #[test]
    fn the_json_names_every_part() {
        let j = full().to_json();
        assert!(j.contains("\"orientation\":\"vertical\",\"position\":10"));
        assert!(j.contains("\"name\":\"Cells\""));
        assert!(j.contains("\\\"this\\\""));
        assert!(j.contains("\"name\":\"logo\""));
        assert!(j.contains("\"activeCount\":1"));
    }
}

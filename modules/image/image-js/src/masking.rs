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

//! The document's MASKING state (image ADR 470): its alpha and spot
//! CHANNELS (saved selections, Quick Mask's temporary channel) and its
//! image PATHS — the parts of a Photoshop document beyond the layers.
//!
//! [`MaskingDoc`] lives inside the layer stack's snapshot, so every
//! change to it is one structure undo step on the one undo list (ADR
//! 463), and it is persisted beside the layers as a trailing block of
//! the layer manifest ([`MaskingDoc::encode`]), which older readers
//! skip.
//!
//! Also here: the DISPLAY views — showing one channel as grey, the
//! Quick Mask overlay, the Select and Mask view modes. A view is a
//! transform of the composite on its way to the frame; it never touches
//! the document's pixels (the scene image is a preview; Apply and the
//! commit write the composite itself).

use std::sync::Arc;

use image_gpu::SelectionCoverage;

/// What a channel is.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ChannelKind {
    /// An alpha channel: a saved selection (white = selected).
    Alpha,
    /// A spot-colour channel: the coverage of one ink, shown in its
    /// colour at its solidity (0…1).
    Spot { colour: [u8; 3], solidity: f32 },
    /// Quick Mask's temporary channel (exists only while Quick Mask is
    /// on; white = selected, the overlay tints the rest).
    QuickMask,
}

impl ChannelKind {
    pub fn wire(&self) -> &'static str {
        match self {
            ChannelKind::Alpha => "alpha",
            ChannelKind::Spot { .. } => "spot",
            ChannelKind::QuickMask => "quickMask",
        }
    }
}

/// One stored channel at canvas size.
#[derive(Debug, Clone)]
pub struct DocChannel {
    pub id: u32,
    pub name: String,
    pub kind: ChannelKind,
    pub data: Arc<SelectionCoverage>,
}

/// One anchor of a path: the point and its two handles (absolute image
/// px; a corner has its handles on the point).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PathAnchor {
    pub p: [f32; 2],
    pub i: [f32; 2],
    pub o: [f32; 2],
}

impl PathAnchor {
    pub fn corner(x: f32, y: f32) -> Self {
        PathAnchor {
            p: [x, y],
            i: [x, y],
            o: [x, y],
        }
    }
}

/// How a subpath joins the path's shape (image ADR 476): the operation
/// and fill rule of the PSD length record, as Photoshop stores them. A
/// subpath that STARTS a component carries its operation (0 exclude, 1
/// combine, 2 subtract, 3 intersect) and fill rule (1 even-odd, 2
/// non-zero); one that continues the component before it carries
/// `0xFFFF` and 0 ([`SubOp::CONTINUE`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SubOp {
    pub op: u16,
    pub rule: u16,
}

impl SubOp {
    /// A new component that COMBINES, even-odd — what Photoshop 27
    /// writes for a subpath drawn with the default path operation
    /// ([OBS], its own files).
    pub const COMBINE: SubOp = SubOp { op: 1, rule: 1 };
    /// The subpath continues the component before it.
    pub const CONTINUE: SubOp = SubOp {
        op: 0xFFFF,
        rule: 0,
    };

    /// A new component with operation `op` (0–3; anything else combines).
    pub fn component(op: u16) -> SubOp {
        SubOp {
            op: if op <= 3 { op } else { 1 },
            rule: 1,
        }
    }
}

impl Default for SubOp {
    fn default() -> Self {
        SubOp::COMBINE
    }
}

/// One subpath (a closed one fills; an open one is a stroke path and
/// contributes nothing to a selection unless closed implicitly).
#[derive(Debug, Clone, PartialEq)]
pub struct SubPath {
    pub closed: bool,
    pub anchors: Vec<PathAnchor>,
    /// How it joins the path's shape.
    pub op: SubOp,
}

impl SubPath {
    /// A subpath that starts a combining component.
    pub fn new(closed: bool, anchors: Vec<PathAnchor>) -> SubPath {
        SubPath {
            closed,
            anchors,
            op: SubOp::COMBINE,
        }
    }
}

/// A path stored in the image session (Photoshop's Paths panel), in
/// image px.
#[derive(Debug, Clone, PartialEq)]
pub struct DocPath {
    pub id: u32,
    pub name: String,
    pub subpaths: Vec<SubPath>,
    /// The WORK PATH: the temporary path the Pen and the shape tools
    /// draw into while no saved path is chosen, and Make Work Path
    /// replaces. At most one per document (image ADR 476).
    pub work: bool,
}

/// The masking state of one document.
#[derive(Debug, Clone, Default)]
pub struct MaskingDoc {
    pub channels: Vec<DocChannel>,
    pub paths: Vec<DocPath>,
    next_id: u32,
}

/// What the layer stack keeps for masking: the document part (in every
/// structure snapshot) and the session part (the selection's undo
/// mirror, the channel being painted).
#[derive(Debug, Default)]
pub struct MaskingState {
    /// Channels and paths — document state, snapshotted and persisted.
    pub doc: MaskingDoc,
    /// The selection as the undo list last saw it (Selection steps swap
    /// it; the wasm door copies it back into the session selection).
    pub live_selection: Option<Arc<SelectionCoverage>>,
    /// An undo or redo changed `live_selection`.
    pub selection_dirty: bool,
    /// The channel pixel tools paint (Quick Mask's, or an alpha channel
    /// chosen in the Channels panel); `None` = a layer.
    pub edit_channel: Option<u32>,
    /// The channel stroke in flight (shown by the display view).
    pub channel_preview: Option<Arc<SelectionCoverage>>,
}

/// The display name a new channel or path takes, numbered after the
/// ones that exist (`Alpha 1`, `Alpha 2`, …).
fn next_name(prefix: &str, taken: &[&str]) -> String {
    (1..)
        .map(|n| format!("{prefix} {n}"))
        .find(|n| !taken.contains(&n.as_str()))
        .unwrap_or_else(|| prefix.to_string())
}

impl MaskingDoc {
    fn fresh_id(&mut self) -> u32 {
        self.next_id = self.next_id.max(1);
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    pub fn is_empty(&self) -> bool {
        self.channels.is_empty() && self.paths.is_empty()
    }

    pub fn channel(&self, id: u32) -> Option<&DocChannel> {
        self.channels.iter().find(|c| c.id == id)
    }

    fn channel_index(&self, id: u32) -> Result<usize, String> {
        self.channels
            .iter()
            .position(|c| c.id == id)
            .ok_or_else(|| format!("no channel {id}"))
    }

    /// Add a channel; `name` empty takes the next free `Alpha n` / `Spot
    /// Color n`. Returns its id.
    pub fn add_channel(&mut self, name: &str, kind: ChannelKind, data: SelectionCoverage) -> u32 {
        let id = self.fresh_id();
        let name = if name.trim().is_empty() {
            let taken: Vec<&str> = self.channels.iter().map(|c| c.name.as_str()).collect();
            match kind {
                ChannelKind::Alpha => next_name("Alpha", &taken),
                ChannelKind::Spot { .. } => next_name("Spot Color", &taken),
                ChannelKind::QuickMask => "Quick Mask".to_string(),
            }
        } else {
            name.trim().to_string()
        };
        self.channels.push(DocChannel {
            id,
            name,
            kind,
            data: Arc::new(data),
        });
        id
    }

    pub fn remove_channel(&mut self, id: u32) -> Result<(), String> {
        let i = self.channel_index(id)?;
        self.channels.remove(i);
        Ok(())
    }

    pub fn rename_channel(&mut self, id: u32, name: &str) -> Result<(), String> {
        let name = name.trim();
        if name.is_empty() {
            return Err("a channel needs a name".into());
        }
        let i = self.channel_index(id)?;
        self.channels[i].name = name.to_string();
        Ok(())
    }

    /// Duplicate a channel (a Quick Mask duplicates as an alpha channel).
    pub fn duplicate_channel(&mut self, id: u32) -> Result<u32, String> {
        let i = self.channel_index(id)?;
        let src = self.channels[i].clone();
        let kind = match src.kind {
            ChannelKind::QuickMask => ChannelKind::Alpha,
            k => k,
        };
        let new = self.fresh_id();
        self.channels.insert(
            i + 1,
            DocChannel {
                id: new,
                name: format!("{} copy", src.name),
                kind,
                data: src.data,
            },
        );
        Ok(new)
    }

    /// Change a spot channel's ink colour and solidity (an alpha channel
    /// becomes a spot channel).
    pub fn set_spot(&mut self, id: u32, colour: [u8; 3], solidity: f32) -> Result<(), String> {
        let i = self.channel_index(id)?;
        if self.channels[i].kind == ChannelKind::QuickMask {
            return Err("Quick Mask is not a spot channel".into());
        }
        self.channels[i].kind = ChannelKind::Spot {
            colour,
            solidity: solidity.clamp(0.0, 1.0),
        };
        Ok(())
    }

    /// Replace a channel's coverage (a painted channel, a Load into it).
    pub fn set_channel_data(&mut self, id: u32, data: SelectionCoverage) -> Result<(), String> {
        let i = self.channel_index(id)?;
        self.channels[i].data = Arc::new(data);
        Ok(())
    }

    /// Quick Mask's channel id, while Quick Mask is on.
    pub fn quick_mask(&self) -> Option<u32> {
        self.channels
            .iter()
            .find(|c| c.kind == ChannelKind::QuickMask)
            .map(|c| c.id)
    }

    // ── paths ───────────────────────────────────────────────────────

    pub fn path(&self, id: u32) -> Option<&DocPath> {
        self.paths.iter().find(|p| p.id == id)
    }

    fn path_index(&self, id: u32) -> Result<usize, String> {
        self.paths
            .iter()
            .position(|p| p.id == id)
            .ok_or_else(|| format!("no path {id}"))
    }

    pub fn add_path(&mut self, name: &str, subpaths: Vec<SubPath>) -> u32 {
        let id = self.fresh_id();
        let name = if name.trim().is_empty() {
            let taken: Vec<&str> = self.paths.iter().map(|p| p.name.as_str()).collect();
            next_name("Path", &taken)
        } else {
            name.trim().to_string()
        };
        self.paths.push(DocPath {
            id,
            name,
            subpaths,
            work: false,
        });
        id
    }

    /// The work path's id, when there is one.
    pub fn work_path(&self) -> Option<u32> {
        self.paths.iter().find(|p| p.work).map(|p| p.id)
    }

    /// Put `subpaths` in the WORK PATH: replaced when there is one (it
    /// keeps its id and place), created at the end otherwise. Answers its
    /// id.
    pub fn set_work_path(&mut self, subpaths: Vec<SubPath>) -> u32 {
        if let Some(p) = self.paths.iter_mut().find(|p| p.work) {
            p.subpaths = subpaths;
            return p.id;
        }
        let id = self.fresh_id();
        self.paths.push(DocPath {
            id,
            name: WORK_PATH_NAME.to_string(),
            subpaths,
            work: true,
        });
        id
    }

    /// Save Path: the work path becomes a saved path named `name` (empty:
    /// the next free `Path n`). Refused for a path that is not the work
    /// path.
    pub fn save_path(&mut self, id: u32, name: &str) -> Result<(), String> {
        let i = self.path_index(id)?;
        if !self.paths[i].work {
            return Err("only the work path is saved".into());
        }
        let name = if name.trim().is_empty() {
            let taken: Vec<&str> = self.paths.iter().map(|p| p.name.as_str()).collect();
            next_name("Path", &taken)
        } else {
            name.trim().to_string()
        };
        self.paths[i].work = false;
        self.paths[i].name = name;
        Ok(())
    }

    /// Add paths read from a file (its saved paths and work path, in its
    /// order), WITHOUT a step: the document had them all along. A second
    /// work path is kept as a saved path.
    pub fn import_paths(&mut self, paths: Vec<(String, bool, Vec<SubPath>)>) {
        for (name, work, subpaths) in paths {
            let work = work && self.work_path().is_none();
            let id = self.fresh_id();
            let name = if work {
                WORK_PATH_NAME.to_string()
            } else if name.trim().is_empty() {
                let taken: Vec<&str> = self.paths.iter().map(|p| p.name.as_str()).collect();
                next_name("Path", &taken)
            } else {
                name
            };
            self.paths.push(DocPath {
                id,
                name,
                subpaths,
                work,
            });
        }
    }

    /// Replace a path's geometry (the Pen, Direct Selection and Path
    /// Selection edit it so).
    pub fn set_path_subpaths(&mut self, id: u32, subpaths: Vec<SubPath>) -> Result<(), String> {
        let i = self.path_index(id)?;
        self.paths[i].subpaths = subpaths;
        Ok(())
    }

    pub fn remove_path(&mut self, id: u32) -> Result<(), String> {
        let i = self.path_index(id)?;
        self.paths.remove(i);
        Ok(())
    }

    pub fn rename_path(&mut self, id: u32, name: &str) -> Result<(), String> {
        let name = name.trim();
        if name.is_empty() {
            return Err("a path needs a name".into());
        }
        let i = self.path_index(id)?;
        self.paths[i].name = name.to_string();
        // Naming the work path saves it (Photoshop's Save Path).
        self.paths[i].work = false;
        Ok(())
    }

    pub fn duplicate_path(&mut self, id: u32) -> Result<u32, String> {
        let i = self.path_index(id)?;
        let src = self.paths[i].clone();
        let new = self.fresh_id();
        self.paths.insert(
            i + 1,
            DocPath {
                id: new,
                name: format!("{} copy", src.name),
                subpaths: src.subpaths,
                // A duplicate is a saved path, even of the work path.
                work: false,
            },
        );
        Ok(new)
    }

    /// The panel's readout: `{"channels":[…],"paths":[…],"quickMask":id|null}`.
    pub fn list_json(&self) -> String {
        let ch: Vec<String> = self
            .channels
            .iter()
            .map(|c| {
                let (colour, solidity) = match c.kind {
                    ChannelKind::Spot { colour, solidity } => (
                        format!("[{},{},{}]", colour[0], colour[1], colour[2]),
                        format!("{solidity}"),
                    ),
                    _ => ("null".into(), "null".into()),
                };
                format!(
                    "{{\"id\":{},\"name\":{},\"kind\":\"{}\",\"colour\":{colour},\"solidity\":{solidity},\"coverage\":{:.6}}}",
                    c.id,
                    json_str(&c.name),
                    c.kind.wire(),
                    c.data.selected_fraction()
                )
            })
            .collect();
        let paths: Vec<String> = self
            .paths
            .iter()
            .map(|p| {
                format!(
                    "{{\"id\":{},\"name\":{},\"work\":{},\"subpaths\":{},\"anchors\":{}}}",
                    p.id,
                    json_str(&p.name),
                    p.work,
                    p.subpaths.len(),
                    p.subpaths.iter().map(|s| s.anchors.len()).sum::<usize>()
                )
            })
            .collect();
        format!(
            "{{\"channels\":[{}],\"paths\":[{}],\"quickMask\":{}}}",
            ch.join(","),
            paths.join(","),
            self.quick_mask()
                .map_or_else(|| "null".to_string(), |id| id.to_string())
        )
    }

    // ── canvas operations ───────────────────────────────────────────

    /// Follow an EXACT canvas op (`remap` is the layer stack's pixel
    /// remap: the channel bytes, input extent, bytes per texel, fill).
    /// Added area is unselected in every channel.
    pub fn follow_exact(
        &mut self,
        ow: u32,
        oh: u32,
        remap: impl Fn(&[u8]) -> Vec<u8>,
        map_point: impl Fn([f32; 2]) -> [f32; 2],
    ) {
        for c in &mut self.channels {
            let m = remap(c.data.data());
            if let Some(cov) = SelectionCoverage::from_data(ow, oh, m) {
                c.data = Arc::new(cov);
            }
        }
        self.map_paths(map_point);
    }

    /// Move every path's points through `f`.
    pub fn map_paths(&mut self, f: impl Fn([f32; 2]) -> [f32; 2]) {
        for p in &mut self.paths {
            for s in &mut p.subpaths {
                for a in &mut s.anchors {
                    a.p = f(a.p);
                    a.i = f(a.i);
                    a.o = f(a.o);
                }
            }
        }
    }

    // ── persistence ─────────────────────────────────────────────────

    /// The trailing manifest block (`"PGMK"`, version 2): u32 next id;
    /// u32 channel count and per channel {u32 id, str name, u8 kind (0
    /// alpha, 1 spot, 2 quick mask), u8 r, g, b, f32 solidity, u32
    /// buffer slot}; u32 path count and per path {u32 id, str name,
    /// (version 2) u8 work, u32 subpaths and per subpath {u8 closed,
    /// (version 2) u16 op, u16 rule, u32 anchors, 6 f32 each}}. Version 1
    /// (no work flag, every subpath combining) is still read. Empty state
    /// writes nothing at all.
    pub fn encode(&self, out: &mut Vec<u8>, mut slot: impl FnMut(Arc<[u8]>) -> u32) {
        if self.is_empty() {
            return;
        }
        let u32 = |o: &mut Vec<u8>, v: u32| o.extend_from_slice(&v.to_le_bytes());
        let f32 = |o: &mut Vec<u8>, v: f32| o.extend_from_slice(&v.to_le_bytes());
        let s = |o: &mut Vec<u8>, v: &str| {
            o.extend_from_slice(&(v.len() as u32).to_le_bytes());
            o.extend_from_slice(v.as_bytes());
        };
        out.extend_from_slice(MASKING_MAGIC);
        u32(out, MASKING_VERSION);
        u32(out, self.next_id);
        u32(out, self.channels.len() as u32);
        for c in &self.channels {
            u32(out, c.id);
            s(out, &c.name);
            let (k, col, sol) = match c.kind {
                ChannelKind::Alpha => (0u8, [0u8; 3], 0.0),
                ChannelKind::Spot { colour, solidity } => (1, colour, solidity),
                ChannelKind::QuickMask => (2, [0; 3], 0.0),
            };
            out.push(k);
            out.extend_from_slice(&col);
            f32(out, sol);
            let n = slot(Arc::from(c.data.data().to_vec().into_boxed_slice()));
            u32(out, n);
        }
        u32(out, self.paths.len() as u32);
        for p in &self.paths {
            u32(out, p.id);
            s(out, &p.name);
            out.push(u8::from(p.work));
            u32(out, p.subpaths.len() as u32);
            for sp in &p.subpaths {
                out.push(u8::from(sp.closed));
                out.extend_from_slice(&sp.op.op.to_le_bytes());
                out.extend_from_slice(&sp.op.rule.to_le_bytes());
                u32(out, sp.anchors.len() as u32);
                for a in &sp.anchors {
                    for v in [a.p, a.i, a.o] {
                        f32(out, v[0]);
                        f32(out, v[1]);
                    }
                }
            }
        }
    }

    /// Read the block back from `rest` (what follows the layer manifest;
    /// empty = no masking state). Channel sizes are checked against the
    /// canvas.
    pub fn decode(
        rest: &[u8],
        width: u32,
        height: u32,
        buffer: impl Fn(u32) -> Result<Arc<[u8]>, String>,
    ) -> Result<MaskingDoc, String> {
        if rest.is_empty() {
            return Ok(MaskingDoc::default());
        }
        let mut r = Reader { b: rest, at: 0 };
        if r.take(4)? != MASKING_MAGIC {
            // Bytes another block wrote: not ours, so no masking state.
            return Ok(MaskingDoc::default());
        }
        let version = r.u32()?;
        if !(1..=MASKING_VERSION).contains(&version) {
            return Err(format!(
                "masking block version {version} (this engine reads {MASKING_VERSION})"
            ));
        }
        let mut doc = MaskingDoc {
            next_id: r.u32()?,
            ..MaskingDoc::default()
        };
        for _ in 0..r.u32()? {
            let id = r.u32()?;
            let name = r.str()?;
            let k = r.u8()?;
            let col = [r.u8()?, r.u8()?, r.u8()?];
            let sol = r.f32()?;
            let slot = r.u32()?;
            let data = buffer(slot)?;
            let cov = SelectionCoverage::from_data(width, height, data.to_vec())
                .ok_or_else(|| format!("channel \"{name}\" is mis-sized"))?;
            let kind = match k {
                0 => ChannelKind::Alpha,
                1 => ChannelKind::Spot {
                    colour: col,
                    solidity: sol,
                },
                2 => ChannelKind::QuickMask,
                k => return Err(format!("channel kind {k}")),
            };
            doc.channels.push(DocChannel {
                id,
                name,
                kind,
                data: Arc::new(cov),
            });
        }
        for _ in 0..r.u32()? {
            let id = r.u32()?;
            let name = r.str()?;
            let work = version >= 2 && r.u8()? != 0;
            let mut subpaths = Vec::new();
            for _ in 0..r.u32()? {
                let closed = r.u8()? != 0;
                let op = if version >= 2 {
                    SubOp {
                        op: r.u16()?,
                        rule: r.u16()?,
                    }
                } else {
                    SubOp::COMBINE
                };
                let mut anchors = Vec::new();
                for _ in 0..r.u32()? {
                    let mut v = [0f32; 6];
                    for x in &mut v {
                        *x = r.f32()?;
                    }
                    anchors.push(PathAnchor {
                        p: [v[0], v[1]],
                        i: [v[2], v[3]],
                        o: [v[4], v[5]],
                    });
                }
                subpaths.push(SubPath {
                    closed,
                    anchors,
                    op,
                });
            }
            doc.paths.push(DocPath {
                id,
                name,
                subpaths,
                work,
            });
        }
        let max_id = doc
            .channels
            .iter()
            .map(|c| c.id)
            .chain(doc.paths.iter().map(|p| p.id))
            .max()
            .unwrap_or(0);
        doc.next_id = doc.next_id.max(max_id + 1);
        Ok(doc)
    }
}

const MASKING_MAGIC: &[u8; 4] = b"PGMK";
const MASKING_VERSION: u32 = 2;

/// Photoshop's name for the work path.
pub const WORK_PATH_NAME: &str = "Work Path";

struct Reader<'a> {
    b: &'a [u8],
    at: usize,
}

impl Reader<'_> {
    fn take(&mut self, n: usize) -> Result<&[u8], String> {
        let end = self
            .at
            .checked_add(n)
            .filter(|&e| e <= self.b.len())
            .ok_or("masking block is truncated")?;
        let s = &self.b[self.at..end];
        self.at = end;
        Ok(s)
    }
    fn u8(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }
    fn u16(&mut self) -> Result<u16, String> {
        Ok(u16::from_le_bytes(self.take(2)?.try_into().expect("2")))
    }
    fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().expect("4")))
    }
    fn f32(&mut self) -> Result<f32, String> {
        Ok(f32::from_le_bytes(self.take(4)?.try_into().expect("4")))
    }
    fn str(&mut self) -> Result<String, String> {
        let n = self.u32()? as usize;
        String::from_utf8(self.take(n)?.to_vec()).map_err(|_| "a name is not UTF-8".to_string())
    }
}

pub(crate) fn json_str(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

// ── path geometry ───────────────────────────────────────────────────

/// Flatten a subpath into a polyline (cubic segments split into `steps`
/// lines each; a closed subpath includes its closing segment).
pub fn flatten(sp: &SubPath, steps: usize) -> Vec<[f32; 2]> {
    let n = sp.anchors.len();
    if n == 0 {
        return Vec::new();
    }
    let mut out = vec![sp.anchors[0].p];
    let segs = if sp.closed { n } else { n - 1 };
    for k in 0..segs {
        let a = sp.anchors[k];
        let b = sp.anchors[(k + 1) % n];
        let straight = a.o == a.p && b.i == b.p;
        if straight {
            out.push(b.p);
            continue;
        }
        for s in 1..=steps.max(1) {
            let t = s as f32 / steps.max(1) as f32;
            let u = 1.0 - t;
            let w = [u * u * u, 3.0 * u * u * t, 3.0 * u * t * t, t * t * t];
            out.push([
                w[0] * a.p[0] + w[1] * a.o[0] + w[2] * b.i[0] + w[3] * b.p[0],
                w[0] * a.p[1] + w[1] * a.o[1] + w[2] * b.i[1] + w[3] * b.p[1],
            ]);
        }
    }
    if sp.closed && out.len() > 1 && out.first() == out.last() {
        out.pop();
    }
    out
}

/// Rasterize polygons (every one closed implicitly) under the NONZERO
/// winding rule, anti-aliased at 4×4 samples per pixel. Holes traced in
/// the opposite winding stay holes.
pub fn rasterize_nonzero(width: u32, height: u32, polys: &[Vec<[f32; 2]>]) -> SelectionCoverage {
    const S: usize = 4;
    let (w, h) = (width as usize, height as usize);
    let mut acc = vec![0u16; w * h];
    let mut xs: Vec<(f32, i32)> = Vec::new();
    for row in 0..h * S {
        let sy = (row as f32 + 0.5) / S as f32;
        xs.clear();
        for poly in polys {
            let n = poly.len();
            if n < 3 {
                continue;
            }
            for k in 0..n {
                let a = poly[k];
                let b = poly[(k + 1) % n];
                if (a[1] <= sy) == (b[1] <= sy) {
                    continue;
                }
                let t = (sy - a[1]) / (b[1] - a[1]);
                let x = a[0] + t * (b[0] - a[0]);
                xs.push((x, if b[1] > a[1] { 1 } else { -1 }));
            }
        }
        if xs.is_empty() {
            continue;
        }
        xs.sort_by(|p, q| p.0.total_cmp(&q.0));
        let y = row / S;
        let mut wind = 0;
        for k in 0..xs.len() {
            let before = wind;
            wind += xs[k].1;
            if before == 0 && wind != 0 {
                // A span starts here; it ends where the winding returns to 0.
                let x0 = xs[k].0;
                let mut j = k + 1;
                let mut wj = wind;
                while j < xs.len() {
                    wj += xs[j].1;
                    if wj == 0 {
                        break;
                    }
                    j += 1;
                }
                let x1 = if j < xs.len() { xs[j].0 } else { w as f32 };
                for sx in 0..w * S {
                    let cx = (sx as f32 + 0.5) / S as f32;
                    if cx >= x0 && cx < x1 {
                        acc[y * w + sx / S] += 1;
                    }
                }
            }
        }
    }
    let data = acc
        .iter()
        .map(|&c| ((u32::from(c) * 255 + (S * S / 2) as u32) / (S * S) as u32).min(255) as u8)
        .collect();
    SelectionCoverage::from_data(width, height, data)
        .unwrap_or_else(|| SelectionCoverage::empty(width, height))
}

/// A path as a selection, drawn the way Photoshop draws a vector mask
/// (image ADR 476: its components' operations and fill rules, open
/// subpaths closed by a straight line, 17 × 15 samples per pixel —
/// `psd_vector_mask::rasterize`).
pub fn path_coverage(path: &DocPath, width: u32, height: u32) -> SelectionCoverage {
    crate::vectors::coverage(&path.subpaths, width, height)
}

/// Traced contours (`paths::trace`) as subpaths of corner anchors.
pub fn subpaths_from_contours(contours: &[crate::paths::Contour]) -> Vec<SubPath> {
    contours
        .iter()
        .map(|c| SubPath {
            closed: true,
            op: SubOp::COMBINE,
            anchors: c
                .points
                .iter()
                .map(|&(x, y)| PathAnchor::corner(x, y))
                .collect(),
        })
        .collect()
}

/// A path's subpaths as `[[x, y, ix, iy, ox, oy, …], …]` with a closed
/// flag per subpath: `{"closed":[…],"anchors":[[…],…]}` — what the glue
/// draws and converts to host shapes.
pub fn path_json(path: &DocPath) -> String {
    let closed: Vec<&str> = path
        .subpaths
        .iter()
        .map(|s| if s.closed { "true" } else { "false" })
        .collect();
    let anchors: Vec<String> = path
        .subpaths
        .iter()
        .map(|s| {
            let v: Vec<String> = s
                .anchors
                .iter()
                .flat_map(|a| [a.p[0], a.p[1], a.i[0], a.i[1], a.o[0], a.o[1]])
                .map(|f| format!("{f}"))
                .collect();
            format!("[{}]", v.join(","))
        })
        .collect();
    format!(
        "{{\"id\":{},\"name\":{},\"closed\":[{}],\"anchors\":[{}]}}",
        path.id,
        json_str(&path.name),
        closed.join(","),
        anchors.join(",")
    )
}

/// Parse the glue's flat subpath encoding: per subpath `closed` and its
/// anchors as 6 floats each.
pub fn subpaths_from_flat(closed: &[bool], flat: &[Vec<f32>]) -> Result<Vec<SubPath>, String> {
    if closed.len() != flat.len() {
        return Err("one closed flag per subpath".into());
    }
    closed
        .iter()
        .zip(flat)
        .map(|(&c, v)| {
            if v.len() % 6 != 0 || v.is_empty() {
                return Err("a subpath is 6 numbers per anchor".to_string());
            }
            Ok(SubPath {
                closed: c,
                op: SubOp::COMBINE,
                anchors: v
                    .as_chunks::<6>()
                    .0
                    .iter()
                    .map(|a| PathAnchor {
                        p: [a[0], a[1]],
                        i: [a[2], a[3]],
                        o: [a[4], a[5]],
                    })
                    .collect(),
            })
        })
        .collect()
}

// ── display views ───────────────────────────────────────────────────

/// What the frame shows instead of the plain composite.
#[derive(Debug, Clone, PartialEq, Default)]
pub enum View {
    /// The composite (the default).
    #[default]
    Composite,
    /// One colour channel of the composite as grey (`red` | `green` |
    /// `blue` | `alpha` | `luma`).
    Component(crate::channels::Channel),
    /// A stored channel as grey (white = selected), or a spot channel in
    /// its ink over white.
    Channel(u32),
    /// The composite with Quick Mask's red overlay over the unselected.
    QuickMask,
    /// A matte preview (Color Range's selection preview, Select and
    /// Mask's view modes) over the coverage the caller passes.
    Matte(MatteMode),
}

/// The Select and Mask / Color Range preview modes.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum MatteMode {
    /// Red over the unselected at the given opacity (Photoshop's
    /// "Overlay" / Quick Mask look).
    Overlay(f32),
    /// The selected part over black.
    OnBlack,
    /// The selected part over white.
    OnWhite,
    /// The coverage itself as grey.
    BlackWhite,
    /// The selected part over a transparency checkerboard ("On Layers").
    OnLayers,
}

impl MatteMode {
    pub fn from_wire(s: &str, opacity: f32) -> Option<Self> {
        Some(match s {
            "overlay" => MatteMode::Overlay(opacity.clamp(0.0, 1.0)),
            "onBlack" => MatteMode::OnBlack,
            "onWhite" => MatteMode::OnWhite,
            "blackWhite" => MatteMode::BlackWhite,
            "onLayers" => MatteMode::OnLayers,
            _ => return None,
        })
    }
}

/// Quick Mask's overlay colour and opacity (Photoshop's defaults).
pub const QUICK_MASK_TINT: [u8; 3] = [255, 0, 0];
pub const QUICK_MASK_OPACITY: f32 = 0.5;

fn lerp(a: u8, b: u8, t: f32) -> u8 {
    (f32::from(a) + (f32::from(b) - f32::from(a)) * t)
        .round()
        .clamp(0.0, 255.0) as u8
}

/// Sample a `cw`×`ch` coverage at the pixel of an `ow`×`oh` image
/// (nearest; the display may be a proxy of another size).
fn sample(cov: &SelectionCoverage, ow: u32, oh: u32, x: u32, y: u32) -> u8 {
    if cov.width() == ow && cov.height() == oh {
        return cov.data()[(y * ow + x) as usize];
    }
    let sx = (u64::from(x) * u64::from(cov.width()) / u64::from(ow.max(1))) as u32;
    let sy = (u64::from(y) * u64::from(cov.height()) / u64::from(oh.max(1))) as u32;
    cov.coverage_at(sx, sy)
}

/// Apply a matte over an RGBA8 composite, given the coverage.
pub fn matte(rgba: &[u8], w: u32, h: u32, cov: &SelectionCoverage, mode: MatteMode) -> Vec<u8> {
    let mut out = rgba.to_vec();
    for y in 0..h {
        for x in 0..w {
            let i = ((y * w + x) * 4) as usize;
            let m = f32::from(sample(cov, w, h, x, y)) / 255.0;
            let px = &mut out[i..i + 4];
            match mode {
                MatteMode::Overlay(op) => {
                    let t = (1.0 - m) * op;
                    for (c, tint) in px.iter_mut().take(3).zip(QUICK_MASK_TINT) {
                        *c = lerp(*c, tint, t);
                    }
                }
                MatteMode::OnBlack => {
                    for c in px.iter_mut().take(3) {
                        *c = lerp(0, *c, m);
                    }
                }
                MatteMode::OnWhite => {
                    for c in px.iter_mut().take(3) {
                        *c = lerp(255, *c, m);
                    }
                }
                MatteMode::BlackWhite => {
                    let v = (m * 255.0).round() as u8;
                    px[0] = v;
                    px[1] = v;
                    px[2] = v;
                }
                MatteMode::OnLayers => {
                    let check = if ((x / 8) + (y / 8)) % 2 == 0 {
                        255
                    } else {
                        204
                    };
                    for c in px.iter_mut().take(3) {
                        *c = lerp(check, *c, m);
                    }
                }
            }
            px[3] = 255;
        }
    }
    out
}

/// One channel as grey (alpha / quick mask: the coverage; spot: its ink
/// over white at its solidity).
pub fn channel_view(w: u32, h: u32, ch: &DocChannel) -> Vec<u8> {
    let mut out = vec![255u8; (w * h * 4) as usize];
    for y in 0..h {
        for x in 0..w {
            let i = ((y * w + x) * 4) as usize;
            let v = sample(&ch.data, w, h, x, y);
            match ch.kind {
                ChannelKind::Spot { colour, solidity } => {
                    let t = f32::from(v) / 255.0 * solidity.max(0.05);
                    for (k, ink) in colour.iter().enumerate() {
                        out[i + k] = lerp(255, *ink, t);
                    }
                }
                _ => {
                    out[i] = v;
                    out[i + 1] = v;
                    out[i + 2] = v;
                }
            }
        }
    }
    out
}

/// Spot channels shown on the composite (the Channels panel's eye):
/// each ink multiplied over the image at its solidity.
pub fn with_spots(rgba: &[u8], w: u32, h: u32, spots: &[&DocChannel]) -> Vec<u8> {
    let mut out = rgba.to_vec();
    for ch in spots {
        let ChannelKind::Spot { colour, solidity } = ch.kind else {
            continue;
        };
        for y in 0..h {
            for x in 0..w {
                let i = ((y * w + x) * 4) as usize;
                let t = f32::from(sample(&ch.data, w, h, x, y)) / 255.0 * solidity;
                for k in 0..3 {
                    let mult = (u16::from(out[i + k]) * u16::from(colour[k]) / 255) as u8;
                    out[i + k] = lerp(out[i + k], mult, t);
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cov(w: u32, h: u32, v: &[u8]) -> SelectionCoverage {
        SelectionCoverage::from_data(w, h, v.to_vec()).unwrap()
    }

    #[test]
    #[allow(non_snake_case)]
    fn channels_add_rename_duplicate_remove__feat__image_selection_select_and_mask() {
        let mut d = MaskingDoc::default();
        let a = d.add_channel("", ChannelKind::Alpha, cov(2, 1, &[255, 0]));
        let b = d.add_channel("", ChannelKind::Alpha, cov(2, 1, &[0, 255]));
        assert_eq!(d.channel(a).unwrap().name, "Alpha 1");
        assert_eq!(d.channel(b).unwrap().name, "Alpha 2");
        d.rename_channel(a, "Sky").unwrap();
        assert!(d.rename_channel(a, "  ").is_err());
        let c = d.duplicate_channel(a).unwrap();
        assert_eq!(d.channel(c).unwrap().name, "Sky copy");
        assert_eq!(d.channels[1].id, c, "the copy sits after its source");
        d.set_spot(b, [0, 120, 200], 0.4).unwrap();
        assert!(matches!(
            d.channel(b).unwrap().kind,
            ChannelKind::Spot { .. }
        ));
        d.remove_channel(a).unwrap();
        assert!(d.remove_channel(a).is_err());
        assert_eq!(d.quick_mask(), None);
        let q = d.add_channel("", ChannelKind::QuickMask, cov(2, 1, &[0, 0]));
        assert_eq!(d.quick_mask(), Some(q));
        assert!(d.set_spot(q, [0; 3], 1.0).is_err());
        let j = d.list_json();
        assert!(
            j.contains("\"quickMask\":") && j.contains("\"kind\":\"spot\""),
            "{j}"
        );
    }

    #[test]
    #[allow(non_snake_case)]
    fn the_block_round_trips_and_an_empty_doc_writes_nothing__feat__image_selection_select_and_mask(
    ) {
        let mut out = Vec::new();
        MaskingDoc::default().encode(&mut out, |_| 0);
        assert!(out.is_empty());
        let mut d = MaskingDoc::default();
        d.add_channel("Sky", ChannelKind::Alpha, cov(2, 2, &[1, 2, 3, 4]));
        let s = d.add_channel("", ChannelKind::Alpha, cov(2, 2, &[9, 9, 9, 9]));
        d.set_spot(s, [10, 20, 30], 0.5).unwrap();
        d.add_path(
            "",
            vec![SubPath {
                closed: true,
                op: crate::masking::SubOp::COMBINE,
                anchors: vec![
                    PathAnchor::corner(0.0, 0.0),
                    PathAnchor {
                        p: [2.0, 0.0],
                        i: [1.5, 0.0],
                        o: [2.5, 1.0],
                    },
                    PathAnchor::corner(2.0, 2.0),
                ],
            }],
        );
        let mut bufs: Vec<Arc<[u8]>> = Vec::new();
        d.encode(&mut out, |b| {
            bufs.push(b);
            (bufs.len() - 1) as u32
        });
        let back = MaskingDoc::decode(&out, 2, 2, |i| {
            bufs.get(i as usize).cloned().ok_or("no buffer".into())
        })
        .unwrap();
        assert_eq!(back.channels.len(), 2);
        assert_eq!(back.channels[0].data.data(), &[1, 2, 3, 4]);
        assert_eq!(
            back.channels[1].kind,
            ChannelKind::Spot {
                colour: [10, 20, 30],
                solidity: 0.5
            }
        );
        assert_eq!(back.paths, d.paths);
        assert_eq!(back.paths[0].name, "Path 1");
        // A wrong size is refused; foreign bytes are no masking state.
        assert!(MaskingDoc::decode(&out, 3, 2, |i| Ok(bufs[i as usize].clone())).is_err());
        assert!(MaskingDoc::decode(b"XXXXjunk", 2, 2, |_| Err("x".into()))
            .unwrap()
            .is_empty());
        // Ids keep counting after a reload.
        let mut back = back;
        let n = back.add_path("", Vec::new());
        assert!(n > d.paths[0].id);
    }

    #[test]
    fn nonzero_rasterization_keeps_holes_and_antialiases() {
        // A 6×6 square with a 2×2 hole traced the other way.
        let outer = vec![[1.0, 1.0], [5.0, 1.0], [5.0, 5.0], [1.0, 5.0]];
        let hole = vec![[2.0, 2.0], [2.0, 4.0], [4.0, 4.0], [4.0, 2.0]];
        let c = rasterize_nonzero(6, 6, &[outer.clone(), hole]);
        assert_eq!(c.coverage_at(1, 1), 255);
        assert_eq!(c.coverage_at(2, 2), 0, "the hole stays a hole");
        assert_eq!(c.coverage_at(0, 0), 0);
        let half = rasterize_nonzero(
            4,
            1,
            &[vec![[0.0, 0.0], [1.5, 0.0], [1.5, 1.0], [0.0, 1.0]]],
        );
        assert_eq!(half.coverage_at(0, 0), 255);
        assert_eq!(half.coverage_at(1, 0), 128, "a half-covered pixel");
        // A Bézier flattens through its handles.
        let sp = SubPath {
            closed: false,
            op: crate::masking::SubOp::COMBINE,
            anchors: vec![
                PathAnchor {
                    p: [0.0, 0.0],
                    i: [0.0, 0.0],
                    o: [0.0, 10.0],
                },
                PathAnchor {
                    p: [10.0, 0.0],
                    i: [10.0, 10.0],
                    o: [10.0, 0.0],
                },
            ],
        };
        let pl = flatten(&sp, 8);
        assert_eq!(pl.len(), 9);
        assert!((pl[4][1] - 7.5).abs() < 1e-4, "the midpoint of the arch");
    }

    #[test]
    fn views_tint_matte_and_show_channels() {
        let rgba = vec![100u8, 100, 100, 255, 100, 100, 100, 255];
        let c = cov(2, 1, &[255, 0]);
        let ov = matte(&rgba, 2, 1, &c, MatteMode::Overlay(0.5));
        assert_eq!(&ov[0..3], &[100, 100, 100], "the selected part is untinted");
        assert_eq!(&ov[4..7], &[178, 50, 50], "the rest is half red");
        let bk = matte(&rgba, 2, 1, &c, MatteMode::OnBlack);
        assert_eq!(&bk[4..7], &[0, 0, 0]);
        let wh = matte(&rgba, 2, 1, &c, MatteMode::OnWhite);
        assert_eq!(&wh[4..7], &[255, 255, 255]);
        let bw = matte(&rgba, 2, 1, &c, MatteMode::BlackWhite);
        assert_eq!(&bw[0..3], &[255, 255, 255]);
        // A proxy display samples the coverage by position.
        let big = cov(4, 2, &[255, 255, 0, 0, 255, 255, 0, 0]);
        let px = matte(&rgba, 2, 1, &big, MatteMode::BlackWhite);
        assert_eq!((px[0], px[4]), (255, 0));
        let ch = DocChannel {
            id: 1,
            name: "a".into(),
            kind: ChannelKind::Alpha,
            data: Arc::new(c.clone()),
        };
        assert_eq!(&channel_view(2, 1, &ch)[..4], &[255, 255, 255, 255]);
        let spot = DocChannel {
            kind: ChannelKind::Spot {
                colour: [0, 0, 255],
                solidity: 1.0,
            },
            ..ch
        };
        assert_eq!(&channel_view(2, 1, &spot)[..3], &[0, 0, 255]);
        let shown = with_spots(&rgba, 2, 1, &[&spot]);
        assert_eq!(&shown[0..3], &[0, 0, 100], "the ink multiplies");
        assert_eq!(&shown[4..7], &[100, 100, 100]);
        assert_eq!(
            MatteMode::from_wire("overlay", 2.0),
            Some(MatteMode::Overlay(1.0))
        );
        assert_eq!(MatteMode::from_wire("x", 1.0), None);
    }
}

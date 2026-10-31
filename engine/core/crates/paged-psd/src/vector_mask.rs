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

//! VECTOR MASKS — the `vmsk` / `vsms` additional-layer-info block as
//! paths in canvas pixels, plus everything Photoshop reads from it when
//! it draws the mask. Plain data: rasterizing is the consumer's job
//! (`image-js`), where the coverage type lives.
//!
//! # The layout ([PUB] Adobe Photoshop File Formats Specification)
//!
//! "Vector mask setting": `u32` version (3), `u32` flags (bit 0 invert,
//! bit 1 not linked, bit 2 disabled), then path records in the "Path
//! resource format": 26 bytes each, a `u16` selector first. Selectors
//! 0/3 are closed/open subpath LENGTH records, 1/2 closed knots (linked,
//! unlinked), 4/5 open knots, 6 the path fill-rule record, 7 the
//! clipboard record, 8 the initial fill rule. A knot is three points —
//! the control point preceding the anchor, the anchor, the control point
//! leaving it — each `(vertical, horizontal)` as signed fixed-point 8.24
//! fractions of the document height and width.
//!
//! # What Photoshop does with it ([OBS], Photoshop 27.10)
//!
//! The specification documents the length record's knot count only.
//! Photoshop 27 writes, and reads, three more fields there — observed by
//! having it build masks with each choice and diffing the bytes, then by
//! patching single fields of its own files and having it re-open them:
//!
//! * **bytes 4–5: the path operation** Photoshop's "path operations"
//!   menu offers per path COMPONENT — 0 exclude overlapping shapes,
//!   1 combine, 2 subtract front shape, 3 intersect. `0xFFFF` marks a
//!   subpath that belongs to the component started by the previous
//!   length record (what "Merge Shape Components" produces).
//! * **bytes 6–7: the component's fill rule** — 2 non-zero winding,
//!   1 even-odd (a five-point star self-intersecting in one subpath has
//!   a hole under 1 and none under 2; an inner rectangle in the same
//!   component is a hole under 1 whatever its direction). Continuation
//!   subpaths carry 0 and take their component's rule; a head carrying
//!   0, which Photoshop never writes, renders even-odd.
//! * **bytes 14–15: the component index** (0, 1, … shared by a
//!   component's subpaths). Informational; not needed to draw.
//!
//! Components fold in file order. The first one's operation decides the
//! starting state: SUBTRACT starts from a FULL mask (a lone subtract
//! component is a hole in an otherwise opaque mask), anything else from
//! an empty one and adds the component. The rest apply their operation
//! to the running result. The fill-rule record (selector 6) carries no
//! data, and the initial-fill record (selector 8) has no visible effect
//! on read: patched to 1, the mask draws exactly as with 0. OPEN
//! subpaths fill as if closed by a STRAIGHT line, whatever their end
//! handles say. Flag bit 0 inverts, bit 2 disables (the mask is kept,
//! not applied), bit 1 (unlinked) does not change the pixels.
//!
//! # Writing, and the paths of the document
//!
//! [`VectorMask::encode`] writes the block back the way Photoshop 27
//! writes it ([OBS], its own files): the fill-rule and initial-fill
//! records first, then per subpath a length record carrying the
//! component's operation and fill rule on its first subpath only and the
//! component index at bytes 14–15. The same records, without the version
//! and flags, are the data of the image resources that hold the
//! document's PATHS — the saved ones (ids 2000–2997, the name in the
//! resource's name field) and the work path (1025) [PUB]: see
//! [`parse_path_records`] and [`encode_path_records`].

use crate::reader::ByteReader;
use crate::{PsdError, Result};

/// A point in canvas pixels, `x` right, `y` down.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PathPoint {
    pub x: f64,
    pub y: f64,
}

/// One Bezier knot: the anchor and its two control points.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Knot {
    /// Selector 1/4 (linked) rather than 2/5 (unlinked). Editing only.
    pub linked: bool,
    /// The control point of the segment ARRIVING at the anchor.
    pub control_in: PathPoint,
    pub anchor: PathPoint,
    /// The control point of the segment LEAVING the anchor.
    pub control_out: PathPoint,
}

/// One subpath: knots in order. A closed subpath's last segment runs
/// back to the first knot as a Bezier; an open one is filled as if a
/// straight line closed it.
#[derive(Debug, Clone, PartialEq)]
pub struct SubPath {
    pub closed: bool,
    pub knots: Vec<Knot>,
}

/// How a component folds into the components before it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathOp {
    /// 0: exclude overlapping shapes (XOR).
    Exclude,
    /// 1: combine shapes (union).
    Combine,
    /// 2: subtract front shape.
    Subtract,
    /// 3: intersect shape areas.
    Intersect,
}

/// The fill rule inside one component.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FillRule {
    EvenOdd,
    NonZero,
}

/// One path component: an operation, a fill rule, and its subpaths.
#[derive(Debug, Clone, PartialEq)]
pub struct PathComponent {
    pub op: PathOp,
    pub fill_rule: FillRule,
    pub subpaths: Vec<SubPath>,
}

/// A parsed vector mask.
#[derive(Debug, Clone, PartialEq)]
pub struct VectorMask {
    /// Always 3 in every file observed; anything else is refused.
    pub version: u32,
    /// Flags bit 0.
    pub invert: bool,
    /// Flags bit 1: the mask does not move with the layer. No pixel
    /// effect.
    pub not_linked: bool,
    /// Flags bit 2: kept, not applied.
    pub disabled: bool,
    /// The initial-fill record's value (selector 8). Recorded for
    /// fidelity; Photoshop draws the same mask whatever it says.
    pub initial_fill: bool,
    pub components: Vec<PathComponent>,
}

/// Bytes per path record.
pub const PATH_RECORD_LEN: usize = 26;

/// Signed fixed-point 8.24 → `f64`.
fn fixed_8_24(v: i32) -> f64 {
    f64::from(v) / f64::from(1u32 << 24)
}

fn read_point(r: &mut ByteReader, width: u32, height: u32) -> Result<PathPoint> {
    let y = fixed_8_24(r.i32()?) * f64::from(height);
    let x = fixed_8_24(r.i32()?) * f64::from(width);
    Ok(PathPoint { x, y })
}

fn malformed(detail: String) -> PsdError {
    PsdError::Malformed {
        section: "vector mask",
        detail,
    }
}

/// The records of a "Path resource format" body, in order: the
/// components and the initial-fill record's value. Shared by the vector
/// mask block (after its version and flags) and the image resources that
/// hold PATHS (ids 2000–2997, the work path 1025), whose data is nothing
/// but these records.
fn parse_records(
    r: &mut ByteReader,
    width: u32,
    height: u32,
) -> Result<(Vec<PathComponent>, bool)> {
    let mut components: Vec<PathComponent> = Vec::new();
    let mut initial_fill = false;
    // Knots still owed to the subpath whose length record came last.
    let mut owed = 0usize;
    let mut open = false;
    while r.remaining() >= PATH_RECORD_LEN {
        let mut rec = r.sub(PATH_RECORD_LEN)?;
        let selector = rec.u16()?;
        match selector {
            0 | 3 => {
                if owed != 0 {
                    return Err(malformed(format!(
                        "a subpath length record arrived {owed} knot(s) early"
                    )));
                }
                let count = usize::from(rec.u16()?);
                let op = rec.u16()?;
                let rule = rec.u16()?;
                let sub = SubPath {
                    closed: selector == 0,
                    knots: Vec::with_capacity(count),
                };
                if op == 0xFFFF {
                    let Some(c) = components.last_mut() else {
                        return Err(PsdError::Unsupported(
                            "a vector mask whose first subpath continues a component \
                             (operation 0xFFFF) — there is no component before it"
                                .into(),
                        ));
                    };
                    c.subpaths.push(sub);
                } else {
                    let op = match op {
                        0 => PathOp::Exclude,
                        1 => PathOp::Combine,
                        2 => PathOp::Subtract,
                        3 => PathOp::Intersect,
                        other => {
                            return Err(PsdError::Unsupported(format!(
                                "vector mask path operation {other} (0–3 are known)"
                            )))
                        }
                    };
                    let fill_rule = match rule {
                        0 | 1 => FillRule::EvenOdd,
                        2 => FillRule::NonZero,
                        other => {
                            return Err(PsdError::Unsupported(format!(
                                "vector mask fill rule {other} (1 even-odd and 2 \
                                 non-zero are known)"
                            )))
                        }
                    };
                    components.push(PathComponent {
                        op,
                        fill_rule,
                        subpaths: vec![sub],
                    });
                }
                owed = count;
                open = selector == 3;
            }
            1 | 2 | 4 | 5 => {
                let open_knot = selector >= 4;
                if owed == 0 || open_knot != open {
                    return Err(malformed(format!(
                        "knot record (selector {selector}) outside a matching subpath"
                    )));
                }
                let control_in = read_point(&mut rec, width, height)?;
                let anchor = read_point(&mut rec, width, height)?;
                let control_out = read_point(&mut rec, width, height)?;
                let sub = components
                    .last_mut()
                    .and_then(|c| c.subpaths.last_mut())
                    .ok_or_else(|| malformed("knot before any subpath".into()))?;
                sub.knots.push(Knot {
                    linked: selector == 1 || selector == 4,
                    control_in,
                    anchor,
                    control_out,
                });
                owed -= 1;
            }
            6 | 7 => {}
            8 => initial_fill = rec.u16()? != 0,
            other => {
                return Err(malformed(format!("unknown path record selector {other}")));
            }
        }
    }
    if owed != 0 {
        return Err(malformed(format!(
            "the last subpath is missing {owed} knot(s)"
        )));
    }
    Ok((components, initial_fill))
}

/// `f64` canvas coordinate → signed fixed-point 8.24 fraction of `extent`.
fn to_fixed_8_24(v: f64, extent: u32) -> i32 {
    let f = v / f64::from(extent.max(1)) * f64::from(1u32 << 24);
    f.round().clamp(f64::from(i32::MIN), f64::from(i32::MAX)) as i32
}

/// One 26-byte record: the selector, the body, zero padding.
fn push_record(out: &mut Vec<u8>, selector: u16, body: &[u8]) {
    let at = out.len();
    out.extend_from_slice(&selector.to_be_bytes());
    out.extend_from_slice(body);
    out.resize(at + PATH_RECORD_LEN, 0);
}

/// Encode `components` in the "Path resource format", the way Photoshop
/// 27 writes them ([OBS], its own files): the fill-rule record
/// (selector 6) and the initial-fill record (selector 8) first, then per
/// subpath its length record — the knot count, the component's operation
/// and fill rule on its FIRST subpath (`0xFFFF` and 0 on the subpaths
/// that continue it), the component index at bytes 14–15 — and its knots.
/// A knot is linked (selector 1 / 4) when [`Knot::linked`] says so.
/// Coordinates are 8.24 fractions of `width` (x) and `height` (y), stored
/// y first. [`parse_path_records`] reads the result back.
pub fn encode_path_records(
    components: &[PathComponent],
    initial_fill: bool,
    width: u32,
    height: u32,
) -> Vec<u8> {
    let knots: usize = components
        .iter()
        .flat_map(|c| &c.subpaths)
        .map(|s| s.knots.len() + 1)
        .sum();
    let mut out = Vec::with_capacity((2 + knots) * PATH_RECORD_LEN);
    push_record(&mut out, 6, &[]);
    push_record(&mut out, 8, &u16::from(initial_fill).to_be_bytes());
    for (ci, c) in components.iter().enumerate() {
        for (si, sub) in c.subpaths.iter().enumerate() {
            let mut body = Vec::with_capacity(24);
            let count = u16::try_from(sub.knots.len()).unwrap_or(u16::MAX);
            body.extend_from_slice(&count.to_be_bytes());
            let (op, rule) = if si == 0 {
                let op = match c.op {
                    PathOp::Exclude => 0u16,
                    PathOp::Combine => 1,
                    PathOp::Subtract => 2,
                    PathOp::Intersect => 3,
                };
                let rule = match c.fill_rule {
                    FillRule::EvenOdd => 1u16,
                    FillRule::NonZero => 2,
                };
                (op, rule)
            } else {
                (0xFFFF, 0)
            };
            body.extend_from_slice(&op.to_be_bytes());
            body.extend_from_slice(&rule.to_be_bytes());
            body.resize(12, 0);
            let index = u16::try_from(ci).unwrap_or(u16::MAX);
            body.extend_from_slice(&index.to_be_bytes());
            push_record(&mut out, if sub.closed { 0 } else { 3 }, &body);
            for k in sub.knots.iter().take(usize::from(count)) {
                let selector = match (sub.closed, k.linked) {
                    (true, true) => 1,
                    (true, false) => 2,
                    (false, true) => 4,
                    (false, false) => 5,
                };
                let mut b = Vec::with_capacity(24);
                for p in [k.control_in, k.anchor, k.control_out] {
                    b.extend_from_slice(&to_fixed_8_24(p.y, height).to_be_bytes());
                    b.extend_from_slice(&to_fixed_8_24(p.x, width).to_be_bytes());
                }
                push_record(&mut out, selector, &b);
            }
        }
    }
    out
}

/// Parse a path resource's data (ids 2000–2997 and the work path 1025 —
/// nothing but path records) for a `width`×`height` document: the
/// components and the initial-fill record's value. Refuses what
/// [`VectorMask::parse`] refuses.
pub fn parse_path_records(
    data: &[u8],
    width: u32,
    height: u32,
) -> Result<(Vec<PathComponent>, bool)> {
    parse_records(&mut ByteReader::new(data), width, height)
}

/// The image resource that holds the WORK PATH.
pub const RES_WORK_PATH: u16 = 1025;
/// The first and last image resource ids that hold SAVED paths, one path
/// per resource, its name in the resource's name field.
pub const RES_PATH_FIRST: u16 = 2000;
pub const RES_PATH_LAST: u16 = 2997;
/// The clipping path's NAME (it refers to a saved path by name).
pub const RES_CLIPPING_PATH_NAME: u16 = 2999;

/// Is `id` an image resource that holds a path (saved or work)?
pub fn is_path_resource(id: u16) -> bool {
    id == RES_WORK_PATH || (RES_PATH_FIRST..=RES_PATH_LAST).contains(&id)
}

impl VectorMask {
    /// Parse a `vmsk`/`vsms` payload (after the block's signature, key
    /// and length) for a `width`×`height` document. Path coordinates
    /// come back in canvas pixels.
    ///
    /// Refuses (rather than guesses) a version other than 3, an
    /// operation or fill rule outside the observed values, and records
    /// that do not frame (knots without a length record, a count that
    /// runs past the block, an unknown selector).
    pub fn parse(payload: &[u8], width: u32, height: u32) -> Result<VectorMask> {
        let mut r = ByteReader::new(payload);
        let version = r.u32()?;
        if version != 3 {
            return Err(PsdError::Unsupported(format!(
                "vector mask version {version} (only 3 is known)"
            )));
        }
        let flags = r.u32()?;
        let (components, initial_fill) = parse_records(&mut r, width, height)?;
        Ok(VectorMask {
            version,
            invert: flags & 0x01 != 0,
            not_linked: flags & 0x02 != 0,
            disabled: flags & 0x04 != 0,
            initial_fill,
            components,
        })
    }

    /// The `vmsk` payload for this mask on a `width`×`height` document:
    /// version 3, the flags, then [`encode_path_records`], zero-padded to
    /// a multiple of four as Photoshop writes it. Parsing the result gives
    /// this mask back (coordinates to 8.24 precision).
    pub fn encode(&self, width: u32, height: u32) -> Vec<u8> {
        let mut out = 3u32.to_be_bytes().to_vec();
        let flags = u32::from(self.invert)
            | u32::from(self.not_linked) << 1
            | u32::from(self.disabled) << 2;
        out.extend_from_slice(&flags.to_be_bytes());
        out.extend(encode_path_records(
            &self.components,
            self.initial_fill,
            width,
            height,
        ));
        // Photoshop pads the payload to a multiple of four with zeros and
        // counts the pad in the block's length ([OBS], its own files).
        out.resize(out.len().next_multiple_of(4), 0);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One 26-byte record: a selector and up to 24 payload bytes.
    fn rec(selector: u16, body: &[u8]) -> Vec<u8> {
        let mut v = selector.to_be_bytes().to_vec();
        v.extend_from_slice(body);
        v.resize(PATH_RECORD_LEN, 0);
        v
    }

    fn length(selector: u16, count: u16, op: u16, rule: u16) -> Vec<u8> {
        let mut b = count.to_be_bytes().to_vec();
        b.extend_from_slice(&op.to_be_bytes());
        b.extend_from_slice(&rule.to_be_bytes());
        rec(selector, &b)
    }

    /// A corner knot at canvas `(x, y)` of a `w`×`h` document.
    fn knot(selector: u16, x: f64, y: f64, w: f64, h: f64) -> Vec<u8> {
        let fy = ((y / h) * f64::from(1u32 << 24)).round() as i32;
        let fx = ((x / w) * f64::from(1u32 << 24)).round() as i32;
        let mut b = Vec::new();
        for _ in 0..3 {
            b.extend_from_slice(&fy.to_be_bytes());
            b.extend_from_slice(&fx.to_be_bytes());
        }
        rec(selector, &b)
    }

    fn block(flags: u32, records: &[Vec<u8>]) -> Vec<u8> {
        let mut v = 3u32.to_be_bytes().to_vec();
        v.extend_from_slice(&flags.to_be_bytes());
        for r in records {
            v.extend_from_slice(r);
        }
        v
    }

    fn rect(op: u16, rule: u16, x0: f64, y0: f64, x1: f64, y1: f64) -> Vec<Vec<u8>> {
        vec![
            length(0, 4, op, rule),
            knot(2, x0, y0, 64.0, 32.0),
            knot(2, x1, y0, 64.0, 32.0),
            knot(2, x1, y1, 64.0, 32.0),
            knot(2, x0, y1, 64.0, 32.0),
        ]
    }

    #[test]
    #[allow(non_snake_case)]
    fn vector_mask_records_parse_to_canvas_pixels__feat__image_psd_layer_import() {
        let mut records = vec![rec(6, &[]), rec(8, &[0, 1])];
        records.extend(rect(1, 1, 10.25, 4.5, 40.0, 20.0));
        let mut bytes = block(0, &records);
        bytes.extend_from_slice(&[0, 0]); // the block's padding
        let m = VectorMask::parse(&bytes, 64, 32).expect("parses");
        assert!(m.initial_fill);
        assert!(!m.invert && !m.disabled && !m.not_linked);
        assert_eq!(m.components.len(), 1);
        let c = &m.components[0];
        assert_eq!((c.op, c.fill_rule), (PathOp::Combine, FillRule::EvenOdd));
        let k = &c.subpaths[0].knots;
        assert_eq!(k.len(), 4);
        // 8.24 fractions of WIDTH for x and HEIGHT for y, stored y first.
        assert!((k[0].anchor.x - 10.25).abs() < 1e-5, "{:?}", k[0].anchor);
        assert!((k[0].anchor.y - 4.5).abs() < 1e-5, "{:?}", k[0].anchor);
        assert!((k[2].anchor.x - 40.0).abs() < 1e-5 && (k[2].anchor.y - 20.0).abs() < 1e-5);
        assert!(!k[0].linked);
    }

    #[test]
    #[allow(non_snake_case)]
    fn vector_mask_flags_and_operations_decode__feat__image_psd_layer_import() {
        let mut records = rect(2, 2, 0.0, 0.0, 8.0, 8.0);
        records.extend(rect(3, 1, 4.0, 4.0, 12.0, 12.0));
        records.extend(rect(0, 1, 2.0, 2.0, 6.0, 6.0));
        let m = VectorMask::parse(&block(0b101, &records), 64, 32).expect("parses");
        assert!(m.invert && m.disabled && !m.not_linked);
        let ops: Vec<_> = m.components.iter().map(|c| (c.op, c.fill_rule)).collect();
        assert_eq!(
            ops,
            [
                (PathOp::Subtract, FillRule::NonZero),
                (PathOp::Intersect, FillRule::EvenOdd),
                (PathOp::Exclude, FillRule::EvenOdd),
            ]
        );
    }

    #[test]
    #[allow(non_snake_case)]
    fn vector_mask_continuation_subpaths_join_their_component__feat__image_psd_layer_import() {
        let mut records = rect(1, 2, 0.0, 0.0, 30.0, 30.0);
        let mut inner = rect(0xFFFF, 0, 10.0, 10.0, 20.0, 20.0);
        records.append(&mut inner);
        // An open subpath (selector 3, knots 4/5) as its own component.
        records.push(length(3, 2, 1, 1));
        records.push(knot(5, 40.0, 2.0, 64.0, 32.0));
        records.push(knot(4, 50.0, 9.0, 64.0, 32.0));
        let m = VectorMask::parse(&block(0, &records), 64, 32).expect("parses");
        assert_eq!(m.components.len(), 2);
        assert_eq!(
            m.components[0].subpaths.len(),
            2,
            "the 0xFFFF subpath joins"
        );
        assert_eq!(m.components[0].fill_rule, FillRule::NonZero);
        let open = &m.components[1].subpaths[0];
        assert!(!open.closed);
        assert!(open.knots[1].linked && !open.knots[0].linked);
    }

    #[test]
    #[allow(non_snake_case)]
    fn vector_mask_encode_parses_back_to_the_same_mask__feat__image_paths_vectors() {
        let mut records = rect(1, 1, 0.0, 0.0, 30.0, 30.0);
        records.append(&mut rect(0xFFFF, 0, 10.0, 10.0, 20.0, 20.0));
        records.extend(rect(2, 2, 4.5, 6.25, 40.0, 28.0));
        records.push(length(3, 2, 3, 1));
        records.push(knot(5, 40.0, 2.0, 64.0, 32.0));
        records.push(knot(4, 50.0, 9.0, 64.0, 32.0));
        let m = VectorMask::parse(&block(0b101, &records), 64, 32).expect("parses");
        let bytes = m.encode(64, 32);
        assert_eq!(bytes.len(), 8 + (2 + 5 + 5 + 5 + 3) * PATH_RECORD_LEN);
        let back = VectorMask::parse(&bytes, 64, 32).expect("re-parses");
        assert_eq!(back, m, "every field survives the write");
        // Written as Photoshop writes it: the fill-rule and initial-fill
        // records first, the continuation subpath as 0xFFFF / 0, and the
        // component index at bytes 14–15 of each length record.
        let rec = |i: usize| &bytes[8 + i * PATH_RECORD_LEN..8 + (i + 1) * PATH_RECORD_LEN];
        assert_eq!(&rec(0)[..2], &[0, 6]);
        assert_eq!(&rec(1)[..2], &[0, 8]);
        assert_eq!(&rec(7)[..8], &[0, 0, 0, 4, 0xFF, 0xFF, 0, 0]);
        assert_eq!(&rec(12)[..8], &[0, 0, 0, 4, 0, 2, 0, 2]);
        assert_eq!(&rec(12)[14..16], &[0, 1], "the second component is index 1");
        assert_eq!(&rec(17)[..8], &[0, 3, 0, 2, 0, 3, 0, 1]);
    }

    #[test]
    #[allow(non_snake_case)]
    fn path_resource_records_round_trip_without_a_header__feat__image_paths_vectors() {
        let comps = vec![PathComponent {
            op: PathOp::Combine,
            fill_rule: FillRule::EvenOdd,
            subpaths: vec![SubPath {
                closed: true,
                knots: vec![
                    Knot {
                        linked: true,
                        control_in: PathPoint { x: 1.5, y: 2.0 },
                        anchor: PathPoint { x: 10.0, y: 4.0 },
                        control_out: PathPoint { x: 18.5, y: 6.0 },
                    },
                    Knot {
                        linked: false,
                        control_in: PathPoint { x: 30.0, y: 30.0 },
                        anchor: PathPoint { x: 30.0, y: 30.0 },
                        control_out: PathPoint { x: 30.0, y: 30.0 },
                    },
                ],
            }],
        }];
        let data = encode_path_records(&comps, true, 64, 32);
        let (back, initial) = parse_path_records(&data, 64, 32).expect("parses");
        assert!(initial);
        assert_eq!(back, comps);
        assert!(is_path_resource(RES_WORK_PATH));
        assert!(is_path_resource(2000) && is_path_resource(2997));
        assert!(!is_path_resource(RES_CLIPPING_PATH_NAME));
        // Coordinates off the canvas still encode (8.24 is signed).
        let far = vec![PathComponent {
            op: PathOp::Combine,
            fill_rule: FillRule::NonZero,
            subpaths: vec![SubPath {
                closed: false,
                knots: vec![Knot {
                    linked: false,
                    control_in: PathPoint { x: -8.0, y: 40.0 },
                    anchor: PathPoint { x: -8.0, y: 40.0 },
                    control_out: PathPoint { x: -8.0, y: 40.0 },
                }],
            }],
        }];
        let (b2, _) =
            parse_path_records(&encode_path_records(&far, false, 64, 32), 64, 32).expect("parses");
        assert_eq!(b2, far);
    }

    #[test]
    #[allow(non_snake_case)]
    fn vector_mask_refuses_what_it_cannot_frame__feat__image_psd_layer_import() {
        // Version.
        let mut bad = block(0, &rect(1, 1, 0.0, 0.0, 1.0, 1.0));
        bad[3] = 2;
        assert!(matches!(
            VectorMask::parse(&bad, 64, 32),
            Err(PsdError::Unsupported(_))
        ));
        // Unknown operation, unknown fill rule.
        for (op, rule) in [(4u16, 1u16), (1, 3)] {
            let b = block(0, &rect(op, rule, 0.0, 0.0, 1.0, 1.0));
            assert!(matches!(
                VectorMask::parse(&b, 64, 32),
                Err(PsdError::Unsupported(_))
            ));
        }
        // A continuation with nothing to continue.
        let b = block(0, &rect(0xFFFF, 0, 0.0, 0.0, 1.0, 1.0));
        assert!(VectorMask::parse(&b, 64, 32).is_err());
        // A count that runs past the block.
        let mut short = rect(1, 1, 0.0, 0.0, 1.0, 1.0);
        short.pop();
        assert!(matches!(
            VectorMask::parse(&block(0, &short), 64, 32),
            Err(PsdError::Malformed { .. })
        ));
        // A knot with no subpath, an open knot in a closed subpath, an
        // unknown selector.
        let stray = vec![knot(2, 0.0, 0.0, 64.0, 32.0)];
        assert!(VectorMask::parse(&block(0, &stray), 64, 32).is_err());
        let mut mixed = rect(1, 1, 0.0, 0.0, 1.0, 1.0);
        mixed[1] = knot(5, 0.0, 0.0, 64.0, 32.0);
        assert!(VectorMask::parse(&block(0, &mixed), 64, 32).is_err());
        assert!(VectorMask::parse(&block(0, &[rec(9, &[])]), 64, 32).is_err());
    }
}

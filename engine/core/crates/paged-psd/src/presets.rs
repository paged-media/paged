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

//! Photoshop PRESET FILES beside `.abr` (`crate::abr`): gradients
//! (`.grd`), patterns (`.pat`) and layer styles (`.asl`), read and
//! written.
//!
//! # Provenance
//!
//! The pattern record and its virtual memory array list are documented in
//! Adobe's Photoshop File Formats Specification (the `Patt` additional
//! layer information, "Virtual Memory Array List"). The `.grd` and `.asl`
//! containers are action descriptors (`crate::descriptor`) behind a short
//! signature header, laid out as preset files have been described in
//! public format notes; the gradient and the effects inside them are the
//! same descriptors a PSD's `lfx2` block carries, so they are read and
//! written by `crate::effects`. `references/` is never read here.
//!
//! # What is kept
//!
//! * `.grd`: every SOLID (custom) gradient. A NOISE gradient (`GrdF` =
//!   `ClNs`) has no stops to model and is counted in `skipped`, never
//!   silently turned into something else.
//! * `.pat`: Grayscale, Indexed, RGB and CMYK patterns at 8 bits, read to
//!   straight RGBA8 (CMYK by the naive complement, which a preset
//!   thumbnail-grade swatch can afford; a colour-managed conversion is
//!   the CMS's job); Multichannel and Duotone ones as grey from their
//!   first plane. Lab and 16-bit planes are `skipped`.
//!   Transparency is the list's user-mask slot.
//! * `.asl`: each style's name, id and effects ([`LayerStyle`]), and the
//!   patterns the file embeds for them.

use crate::descriptor::build::{desc, key};
use crate::descriptor::{
    read_unicode_string, read_versioned_descriptor, write_unicode_string,
    write_versioned_descriptor, Descriptor, DescriptorValue,
};
use crate::effects::{gradient_value, read_gradient, Gradient, LayerStyle};
use crate::reader::ByteReader;
use crate::vm_array::{read_vm_array_list_body, VmArrayList, VmSamples, COMPRESSION_RAW};
use crate::writer::ByteWriter;
use crate::{PsdError, Result};

/// The signature of a `.grd` file.
pub const GRD_SIGNATURE: &[u8; 4] = b"8BGR";
/// The signature of a `.pat` file.
pub const PAT_SIGNATURE: &[u8; 4] = b"8BPT";
/// The signature of a `.asl` file.
pub const ASL_SIGNATURE: &[u8; 4] = b"8BSL";

/// The descriptor-based `.grd` version (Photoshop 6 and later).
const GRD_VERSION: u16 = 5;
/// The channel slots a pattern's list declares (what Photoshop writes).
const PATTERN_ARRAY_COUNT: u32 = 24;
/// The largest pattern side read or written.
pub const MAX_PATTERN_SIDE: u32 = 8192;

fn malformed(section: &'static str, detail: impl Into<String>) -> PsdError {
    PsdError::Malformed {
        section,
        detail: detail.into(),
    }
}

// ───────────────────────────── gradients ─────────────────────────────

/// A `.grd` file: its solid gradients and how many entries were not.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct GradientFile {
    pub gradients: Vec<Gradient>,
    /// Noise gradients and entries without a gradient.
    pub skipped: usize,
}

/// Read a `.grd` (version 5: a descriptor whose `GrdL` lists the presets).
pub fn read_grd(bytes: &[u8]) -> Result<GradientFile> {
    let mut r = ByteReader::new(bytes);
    let sig = r.fourcc()?;
    if &sig != GRD_SIGNATURE {
        return Err(PsdError::BadSignature(format!(
            "not a gradient file (signature {:?})",
            String::from_utf8_lossy(&sig)
        )));
    }
    let version = r.u16()?;
    if version != GRD_VERSION {
        return Err(PsdError::Unsupported(format!(
            "gradient file version {version}: only the descriptor form (5) is read"
        )));
    }
    let (_, root) = read_versioned_descriptor(&mut r)?;
    let list = root
        .list(b"GrdL")
        .ok_or_else(|| malformed("gradient file", "no GrdL list"))?;
    let mut out = GradientFile::default();
    for item in list {
        let Some(entry) = item.as_descriptor() else {
            out.skipped += 1;
            continue;
        };
        let Some(g) = entry.descriptor(b"Grad") else {
            out.skipped += 1;
            continue;
        };
        let noise = matches!(g.enum_value(b"GrdF"), Some((_, v)) if v.matches(b"ClNs"));
        if noise || g.list(b"Clrs").is_none() {
            out.skipped += 1;
            continue;
        }
        out.gradients.push(read_gradient(g));
    }
    Ok(out)
}

/// Write gradients as a `.grd` (version 5).
pub fn write_grd(gradients: &[Gradient]) -> Vec<u8> {
    let list = gradients
        .iter()
        .map(|g| DescriptorValue::Descriptor(desc(b"Grdn", vec![(b"Grad", gradient_value(g))])))
        .collect();
    let root = desc(b"null", vec![(b"GrdL", DescriptorValue::List(list))]);
    let mut out = GRD_SIGNATURE.to_vec();
    out.extend_from_slice(&GRD_VERSION.to_be_bytes());
    write_versioned_descriptor(&mut out, &root);
    out
}

// ───────────────────────────── patterns ──────────────────────────────

/// One pattern, as straight RGBA8.
#[derive(Debug, Clone, PartialEq)]
pub struct PatternPreset {
    pub name: String,
    /// Photoshop's unique id (a GUID string); styles refer to it.
    pub id: String,
    pub width: u32,
    pub height: u32,
    /// `width × height × 4` straight RGBA8.
    pub rgba: Vec<u8>,
}

/// A `.pat` file's patterns and how many it could not read.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct PatternFile {
    pub patterns: Vec<PatternPreset>,
    /// Unsupported modes or depths; the reasons, in file order.
    pub skipped: Vec<String>,
}

/// Read a `.pat` (signature, version 1, a count, then the records).
pub fn read_pat(bytes: &[u8]) -> Result<PatternFile> {
    let mut r = ByteReader::new(bytes);
    let sig = r.fourcc()?;
    if &sig != PAT_SIGNATURE {
        return Err(PsdError::BadSignature(format!(
            "not a pattern file (signature {:?})",
            String::from_utf8_lossy(&sig)
        )));
    }
    let version = r.u16()?;
    if version != 1 {
        return Err(PsdError::Unsupported(format!(
            "pattern file version {version}"
        )));
    }
    let count = r.u32()? as usize;
    // A record is at least its fixed header; a count the input cannot
    // hold is malformed rather than a large allocation.
    if count > r.remaining() / 16 {
        return Err(malformed(
            "pattern file",
            format!("{count} patterns cannot fit in {} bytes", r.remaining()),
        ));
    }
    let mut out = PatternFile::default();
    for _ in 0..count {
        match read_pattern_record(&mut r)? {
            Ok(p) => out.patterns.push(p),
            Err(why) => out.skipped.push(why),
        }
    }
    Ok(out)
}

/// One pattern record (from its version word). The outer `Result` is a
/// broken file; the inner one a readable record of a kind not modelled.
fn read_pattern_record(r: &mut ByteReader) -> Result<std::result::Result<PatternPreset, String>> {
    let version = r.u32()?;
    if version != 1 {
        return Err(malformed(
            "pattern record",
            format!("version {version} (expected 1)"),
        ));
    }
    let mode = r.u32()?;
    let height = u32::from(r.u16()?);
    let width = u32::from(r.u16()?);
    let name = read_unicode_string(r)?;
    let id_len = usize::from(r.u8()?);
    let id = String::from_utf8_lossy(r.take(id_len)?).into_owned();
    // An indexed pattern carries its colour table, then two words: the
    // count of colours used and a transparent index (observed in
    // Photoshop's own preset files; the table alone leaves the list's
    // version four bytes later than the specification's layout implies).
    let palette = if mode == 2 {
        let table = r.take(256 * 3)?.to_vec();
        let _colours = r.u16()?;
        let _transparent = r.u16()?;
        Some(table)
    } else {
        None
    };
    let list = read_vm_array_list_body(r)?;
    Ok(
        pattern_pixels(&name, mode, width, height, palette.as_deref(), &list).map(|rgba| {
            PatternPreset {
                name,
                id,
                width,
                height,
                rgba,
            }
        }),
    )
}

fn pattern_pixels(
    name: &str,
    mode: u32,
    width: u32,
    height: u32,
    palette: Option<&[u8]>,
    list: &VmArrayList,
) -> std::result::Result<Vec<u8>, String> {
    if width == 0 || height == 0 || width > MAX_PATTERN_SIDE || height > MAX_PATTERN_SIDE {
        return Err(format!("{name}: a {width}×{height} pattern"));
    }
    // Multichannel and duotone patterns (Photoshop's legacy textures) read
    // as grey from their first plane.
    let colour_count = match mode {
        1 | 2 | 7 | 8 => 1,
        3 => 3,
        4 => 4,
        _ => return Err(format!("{name}: image mode {mode} is not read")),
    };
    let n = (width * height) as usize;
    let mut planes: Vec<Vec<u8>> = Vec::new();
    let mut alpha: Option<Vec<u8>> = None;
    for a in &list.arrays {
        let samples = a.decode().map_err(|e| format!("{name}: {e}"))?;
        let eight = match samples {
            VmSamples::Eight(v) => v,
            VmSamples::Sixteen(_) => return Err(format!("{name}: 16-bit patterns are not read")),
        };
        // A plane smaller than the pattern (Photoshop crops a channel to
        // its content) is placed at its bounds; anything else is refused.
        let plane = place(&eight, a.bounds, list.bounds, width, height)
            .ok_or_else(|| format!("{name}: a plane outside the pattern"))?;
        if a.slot < list.array_count {
            if planes.len() < colour_count {
                planes.push(plane);
            }
        } else if a.slot == list.array_count {
            alpha = Some(plane);
        }
    }
    if planes.len() < colour_count {
        return Err(format!(
            "{name}: {} of {colour_count} colour planes",
            planes.len()
        ));
    }
    let mut rgba = vec![0u8; n * 4];
    for i in 0..n {
        let (r, g, b) = match mode {
            1 | 7 | 8 => (planes[0][i], planes[0][i], planes[0][i]),
            2 => {
                let p = palette.unwrap_or(&[]);
                let k = usize::from(planes[0][i]) * 3;
                if k + 2 >= p.len() {
                    (0, 0, 0)
                } else {
                    (p[k], p[k + 1], p[k + 2])
                }
            }
            3 => (planes[0][i], planes[1][i], planes[2][i]),
            _ => {
                // PSD stores CMYK inverted (255 = no ink).
                let k = u16::from(planes[3][i]);
                let ch = |c: u8| ((u16::from(c) * k) / 255) as u8;
                (ch(planes[0][i]), ch(planes[1][i]), ch(planes[2][i]))
            }
        };
        rgba[i * 4] = r;
        rgba[i * 4 + 1] = g;
        rgba[i * 4 + 2] = b;
        rgba[i * 4 + 3] = alpha.as_ref().map_or(255, |a| a[i]);
    }
    Ok(rgba)
}

/// A plane at `at` inside the list's `whole` rect, as a full
/// `width × height` plane (zero outside).
fn place(
    data: &[u8],
    at: crate::vm_array::VmRect,
    whole: crate::vm_array::VmRect,
    width: u32,
    height: u32,
) -> Option<Vec<u8>> {
    let (pw, ph) = (at.width()? as usize, at.height()? as usize);
    if data.len() < pw * ph {
        return None;
    }
    let (ox, oy) = ((at.left - whole.left) as i64, (at.top - whole.top) as i64);
    if (pw, ph, ox, oy) == (width as usize, height as usize, 0, 0) {
        return Some(data[..pw * ph].to_vec());
    }
    if ox < 0 || oy < 0 || ox as usize + pw > width as usize || oy as usize + ph > height as usize {
        return None;
    }
    let mut out = vec![0u8; (width * height) as usize];
    for y in 0..ph {
        let d = (oy as usize + y) * width as usize + ox as usize;
        out[d..d + pw].copy_from_slice(&data[y * pw..(y + 1) * pw]);
    }
    Some(out)
}

/// One pattern record (version word onward): RGB, the alpha in the
/// user-mask slot when any pixel is not opaque, raw 8-bit planes.
fn write_pattern_record(w: &mut ByteWriter, p: &PatternPreset) {
    w.u32(1);
    w.u32(3); // RGB
    w.u16(p.height.min(u32::from(u16::MAX)) as u16);
    w.u16(p.width.min(u32::from(u16::MAX)) as u16);
    let mut name = Vec::new();
    write_unicode_string(&mut name, &p.name);
    w.bytes(&name);
    let id = p.id.as_bytes();
    let n = id.len().min(255);
    w.u8(n as u8);
    w.bytes(&id[..n]);

    let px = (p.width * p.height) as usize;
    let plane = |c: usize| -> Vec<u8> { (0..px).map(|i| p.rgba[i * 4 + c]).collect() };
    let opaque = (0..px).all(|i| p.rgba[i * 4 + 3] == 255);
    let mut planes: Vec<(u32, Vec<u8>)> = (0..3).map(|c| (c as u32, plane(c))).collect();
    if !opaque {
        planes.push((PATTERN_ARRAY_COUNT, plane(3)));
    }
    let rect = [0i32, 0, p.height as i32, p.width as i32];
    let mut body = ByteWriter::new();
    for v in rect {
        body.i32(v);
    }
    body.u32(PATTERN_ARRAY_COUNT);
    for slot in 0..PATTERN_ARRAY_COUNT + 2 {
        match planes.iter().find(|(s, _)| *s == slot) {
            None => body.u32(0),
            Some((_, data)) => {
                body.u32(1);
                body.u32((4 + 16 + 2 + 1 + data.len()) as u32);
                body.u32(8);
                for v in rect {
                    body.i32(v);
                }
                body.u16(8);
                body.u8(COMPRESSION_RAW);
                body.bytes(data);
            }
        }
    }
    let body = body.into_bytes();
    w.u32(3); // the list's version
    w.u32(body.len() as u32);
    w.bytes(&body);
}

/// Write patterns as a `.pat`.
pub fn write_pat(patterns: &[PatternPreset]) -> Vec<u8> {
    let mut w = ByteWriter::new();
    w.fourcc(*PAT_SIGNATURE);
    w.u16(1);
    w.u32(patterns.len() as u32);
    for p in patterns {
        write_pattern_record(&mut w, p);
    }
    w.into_bytes()
}

// ───────────────────────────── styles ────────────────────────────────

/// One layer style preset.
#[derive(Debug, Clone, PartialEq)]
pub struct StylePreset {
    pub name: String,
    pub id: String,
    pub style: LayerStyle,
}

/// A `.asl` file: its styles and the patterns they draw.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct StyleFile {
    pub styles: Vec<StylePreset>,
    pub patterns: Vec<PatternPreset>,
    /// Patterns and styles that could not be read, with the reason.
    pub skipped: Vec<String>,
}

/// Read a `.asl`: version 2, the signature, version 3, a length-framed
/// run of pattern records, then a count of styles, each a length-framed
/// pair of descriptors (its name and id; its effects under `Lefx`).
pub fn read_asl(bytes: &[u8]) -> Result<StyleFile> {
    let mut r = ByteReader::new(bytes);
    let version = r.u16()?;
    let sig = r.fourcc()?;
    if &sig != ASL_SIGNATURE {
        return Err(PsdError::BadSignature(format!(
            "not a style file (signature {:?})",
            String::from_utf8_lossy(&sig)
        )));
    }
    let pattern_version = r.u16()?;
    if version != 2 || pattern_version != 3 {
        return Err(PsdError::Unsupported(format!(
            "style file version {version}/{pattern_version} (2/3 is read)"
        )));
    }
    let mut out = StyleFile::default();
    let patterns_len = r.u32()? as usize;
    let mut pr = r.sub(patterns_len)?;
    while pr.remaining() >= 4 {
        let len = pr.u32()? as usize;
        if len == 0 {
            break;
        }
        let start = pr.pos();
        let mut rec = pr.sub(len)?;
        match read_pattern_record(&mut rec)? {
            Ok(p) => out.patterns.push(p),
            Err(why) => out.skipped.push(why),
        }
        pr.align(4, start)?;
    }
    let count = r.u32()? as usize;
    if count > r.remaining() / 8 {
        return Err(malformed(
            "style file",
            format!("{count} styles cannot fit in {} bytes", r.remaining()),
        ));
    }
    for _ in 0..count {
        let len = r.u32()? as usize;
        let start = r.pos();
        let mut s = r.sub(len)?;
        let (_, head) = read_versioned_descriptor(&mut s)?;
        let (_, body) = read_versioned_descriptor(&mut s)?;
        let name = head.text_display(b"Nm  ").unwrap_or("Style").to_string();
        let id = head.text(b"Idnt").unwrap_or_default().to_string();
        // A style without `Lefx` is a style of no effects (Photoshop's
        // "Default Style (None)"), which clears a layer's style.
        let style = match body.descriptor(b"Lefx") {
            Some(fx) => LayerStyle::from_descriptor(fx),
            None => LayerStyle::default(),
        };
        out.styles.push(StylePreset { name, id, style });
        let used = r.pos() - start;
        skip_style_pad(&mut r, used)?;
    }
    Ok(out)
}

/// Writers pad a style record to four bytes; a reader cannot rely on it,
/// so the pad is skipped only when it is zeros and what follows still
/// reads as a record length (or the file ends).
fn skip_style_pad(r: &mut ByteReader, len: usize) -> Result<()> {
    let pad = (4 - len % 4) % 4;
    if pad == 0 || r.remaining() < pad {
        return Ok(());
    }
    let rest = r.rest();
    if rest[..pad].iter().any(|&b| b != 0) {
        return Ok(());
    }
    let after = &rest[pad..];
    let plausible = after.is_empty()
        || (after.len() >= 4
            && (u32::from_be_bytes([after[0], after[1], after[2], after[3]]) as usize)
                <= after.len() - 4);
    if plausible {
        r.take(pad)?;
    }
    Ok(())
}

/// Write styles (and the patterns they draw) as a `.asl`.
pub fn write_asl(styles: &[StylePreset], patterns: &[PatternPreset]) -> Vec<u8> {
    let mut w = ByteWriter::new();
    w.u16(2);
    w.fourcc(*ASL_SIGNATURE);
    w.u16(3);
    let mut pats = ByteWriter::new();
    for p in patterns {
        let mut rec = ByteWriter::new();
        write_pattern_record(&mut rec, p);
        let rec = rec.into_bytes();
        pats.u32(rec.len() as u32);
        pats.bytes(&rec);
        let pad = (4 - rec.len() % 4) % 4;
        pats.bytes(&[0u8; 3][..pad]);
    }
    let pats = pats.into_bytes();
    w.u32(pats.len() as u32);
    w.bytes(&pats);
    w.u32(styles.len() as u32);
    for s in styles {
        let head = desc(
            b"null",
            vec![
                (b"Nm  ", DescriptorValue::Text(s.name.clone())),
                (b"Idnt", DescriptorValue::Text(s.id.clone())),
            ],
        );
        let mut fx: Descriptor = s.style.to_descriptor();
        fx.class_id = key(b"Lefx");
        let body = desc(
            b"Styl",
            vec![
                (
                    b"documentMode",
                    DescriptorValue::Descriptor(desc(b"documentMode", vec![])),
                ),
                (b"Lefx", DescriptorValue::Descriptor(fx)),
            ],
        );
        let mut rec = Vec::new();
        write_versioned_descriptor(&mut rec, &head);
        write_versioned_descriptor(&mut rec, &body);
        w.u32(rec.len() as u32);
        w.bytes(&rec);
        let pad = (4 - rec.len() % 4) % 4;
        w.bytes(&[0u8; 3][..pad]);
    }
    w.into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::effects::{GradientColorStop, Shadow};

    fn grad(name: &str, a: [u8; 3], b: [u8; 3]) -> Gradient {
        Gradient {
            name: name.into(),
            ..Gradient::two(a, b)
        }
    }

    #[test]
    #[allow(non_snake_case)]
    fn a_grd_round_trips_its_gradients__feat__image_editor_snapshots_presets() {
        let mut three = grad("Three", [255, 0, 0], [0, 0, 255]);
        three.stops.insert(
            1,
            GradientColorStop {
                at: 0.25,
                rgb: [0, 255, 0],
                midpoint: 0.4,
            },
        );
        three.opacity_stops[1].opacity = 0.5;
        let bytes = write_grd(&[grad("Black, White", [0; 3], [255; 3]), three.clone()]);
        assert_eq!(&bytes[..4], b"8BGR");
        let back = read_grd(&bytes).expect("read");
        assert_eq!(back.skipped, 0);
        assert_eq!(back.gradients.len(), 2);
        assert_eq!(back.gradients[0].name, "Black, White");
        let g = &back.gradients[1];
        assert_eq!(g.name, "Three");
        assert_eq!(g.stops.len(), 3);
        assert_eq!(g.stops[1].rgb, [0, 255, 0]);
        assert!((g.stops[1].at - 0.25).abs() < 1e-3);
        assert!((g.stops[1].midpoint - 0.4).abs() < 1e-3);
        assert!((g.opacity_stops[1].opacity - 0.5).abs() < 1e-3);
        assert!((g.smoothness - 100.0).abs() < 1e-3);
    }

    #[test]
    #[allow(non_snake_case)]
    fn a_noise_gradient_is_counted_not_guessed__feat__image_editor_snapshots_presets() {
        use crate::descriptor::build::{en, obj};
        let noise = obj(
            b"Grdn",
            vec![
                (b"Nm  ", DescriptorValue::Text("Noise".into())),
                (b"GrdF", en(b"GrdF", b"ClNs")),
            ],
        );
        let root = desc(
            b"null",
            vec![(
                b"GrdL",
                DescriptorValue::List(vec![obj(b"Grdn", vec![(b"Grad", noise)])]),
            )],
        );
        let mut bytes = b"8BGR".to_vec();
        bytes.extend_from_slice(&5u16.to_be_bytes());
        write_versioned_descriptor(&mut bytes, &root);
        let f = read_grd(&bytes).expect("read");
        assert!(f.gradients.is_empty());
        assert_eq!(f.skipped, 1);
        assert!(read_grd(b"8BPT\0\x05").is_err(), "a wrong signature");
    }

    fn pattern(name: &str, w: u32, h: u32, alpha: bool) -> PatternPreset {
        let rgba = (0..w * h)
            .flat_map(|i| {
                let v = (i * 37 % 256) as u8;
                [
                    v,
                    255 - v,
                    v / 2,
                    if alpha { (i * 11 % 256) as u8 } else { 255 },
                ]
            })
            .collect();
        PatternPreset {
            name: name.into(),
            id: format!("id-{name}"),
            width: w,
            height: h,
            rgba,
        }
    }

    #[test]
    #[allow(non_snake_case)]
    fn a_pat_round_trips_pixels_names_ids_and_alpha__feat__image_editor_snapshots_presets() {
        let ps = vec![pattern("Opaque", 5, 3, false), pattern("Alpha", 4, 4, true)];
        let bytes = write_pat(&ps);
        assert_eq!(&bytes[..4], b"8BPT");
        let back = read_pat(&bytes).expect("read");
        assert!(back.skipped.is_empty(), "{:?}", back.skipped);
        assert_eq!(back.patterns, ps);
    }

    #[test]
    #[allow(non_snake_case)]
    fn a_grey_pattern_with_an_rle_plane_reads__feat__image_editor_snapshots_presets() {
        // Hand-built: mode 1, 2×2, one RLE plane (a literal run per row).
        let mut w = ByteWriter::new();
        w.fourcc(*PAT_SIGNATURE);
        w.u16(1);
        w.u32(1);
        w.u32(1);
        w.u32(1); // grayscale
        w.u16(2);
        w.u16(2);
        let mut name = Vec::new();
        write_unicode_string(&mut name, "Grey");
        w.bytes(&name);
        w.u8(2);
        w.bytes(b"g1");
        let mut body = ByteWriter::new();
        for v in [0i32, 0, 2, 2] {
            body.i32(v);
        }
        body.u32(24);
        let rle: Vec<u8> = vec![0, 3, 0, 3, 1, 10, 20, 1, 30, 40];
        for slot in 0..26u32 {
            if slot != 0 {
                body.u32(0);
                continue;
            }
            body.u32(1);
            body.u32((23 + rle.len()) as u32);
            body.u32(8);
            for v in [0i32, 0, 2, 2] {
                body.i32(v);
            }
            body.u16(8);
            body.u8(1);
            body.bytes(&rle);
        }
        let body = body.into_bytes();
        w.u32(3);
        w.u32(body.len() as u32);
        w.bytes(&body);
        let f = read_pat(&w.into_bytes()).expect("read");
        assert_eq!(f.patterns.len(), 1);
        let p = &f.patterns[0];
        assert_eq!((p.name.as_str(), p.id.as_str()), ("Grey", "g1"));
        let greys: Vec<u8> = p.rgba.chunks(4).map(|c| c[0]).collect();
        assert_eq!(greys, vec![10, 20, 30, 40]);
        assert!(p.rgba.chunks(4).all(|c| c[3] == 255 && c[0] == c[2]));
    }

    #[test]
    #[allow(non_snake_case)]
    fn an_asl_round_trips_styles_and_their_patterns__feat__image_editor_snapshots_presets() {
        let mut style = LayerStyle::default();
        let mut shadow = Shadow::drop_default();
        shadow.distance = 12.0;
        style.drop_shadows.push(shadow);
        let styles = vec![StylePreset {
            name: "Lifted".into(),
            id: "s-1".into(),
            style,
        }];
        let pats = vec![pattern("Tile", 3, 2, true)];
        let bytes = write_asl(&styles, &pats);
        assert_eq!(&bytes[2..6], b"8BSL");
        let back = read_asl(&bytes).expect("read");
        assert!(back.skipped.is_empty(), "{:?}", back.skipped);
        assert_eq!(back.patterns, pats);
        assert_eq!(back.styles.len(), 1);
        let s = &back.styles[0];
        assert_eq!((s.name.as_str(), s.id.as_str()), ("Lifted", "s-1"));
        assert_eq!(s.style.drop_shadows.len(), 1);
        assert!((s.style.drop_shadows[0].distance - 12.0).abs() < 1e-3);
    }
}

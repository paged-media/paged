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

//! Text-as-text: glyph runs from the side-channel become real PDF
//! text (`BT/Tf/Tm/TJ/ET`) over subset, CID-keyed Type0 fonts with
//! `/ToUnicode` CMaps — selectable, searchable, accessible. Fonts
//! whose fsType forbids embedding stay as outlines + a diagnostic
//! (concept E8: surfaced, never silent).

use std::collections::BTreeMap;

use pdf_writer::{Content, Finish, Name, Pdf, Ref, Str};

use crate::writer::RefAllocator;
use crate::{ExportDiagnostic, ExportError, ExportInput, RestrictedFontPolicy};

/// Per-document font usage, accumulated across pages; subsets are
/// written at finish time.
#[derive(Default)]
pub struct FontPool {
    /// font_id → (pre-allocated Type0 ref, used glyph ids,
    /// glyph→unicode, embeddable).
    pub fonts: BTreeMap<u32, FontUsage>,
}

pub struct FontUsage {
    pub type0_ref: Ref,
    /// Old→new gid mapping, assigned INCREMENTALLY at use time so
    /// the content stream can write the remapped (subset) gid
    /// directly; the SAME remapper drives `subsetter::subset` at
    /// finish, so the two agree by construction.
    pub remapper: subsetter::GlyphRemapper,
    /// new gid → the source characters it stands for (for /ToUnicode):
    /// one for most glyphs, several for a ligature. The first use of a
    /// glyph decides; a later use standing for other characters is
    /// written with `/ActualText` instead (see [`FontPool::use_glyph`]).
    pub to_unicode: BTreeMap<u16, String>,
    pub embeddable: Option<bool>,
    pub outlined_runs: usize,
    /// The id that resolves to FACE BYTES for this usage — not the
    /// pool's own key, which is the glyph-outline id. One variable face
    /// at two weights is two pooled fonts and one set of bytes; using
    /// the key to fetch them finds nothing at all.
    pub face_id: Option<u32>,
}

impl FontPool {
    /// Record one glyph's use; returns the page-resource font name,
    /// the (stable, pre-allocated) Type0 ref, the REMAPPED gid to show
    /// in the content stream, and whether the font's `/ToUnicode` says
    /// `text` for that gid. `text` is the source characters the glyph
    /// stands for here. It is `false` when the glyph was first used for
    /// other characters (one glyph drawn for "A" and for a Greek alpha,
    /// a ligature glyph reached from two spellings): the caller then
    /// names the characters with `/ActualText` around this one use.
    pub fn use_glyph(
        &mut self,
        refs: &mut RefAllocator,
        font_id: u32,
        face_id: Option<u32>,
        glyph_id: u32,
        text: Option<&str>,
    ) -> (String, Ref, u16, bool) {
        let usage = self.fonts.entry(font_id).or_insert_with(|| FontUsage {
            type0_ref: refs.alloc(),
            face_id,
            remapper: subsetter::GlyphRemapper::new(),
            to_unicode: BTreeMap::new(),
            embeddable: None,
            outlined_runs: 0,
        });
        let new_gid = usage.remapper.remap(glyph_id as u16);
        let mapped = match text.filter(|t| !t.is_empty()) {
            Some(t) => {
                usage
                    .to_unicode
                    .entry(new_gid)
                    .or_insert_with(|| t.to_owned())
                    == t
            }
            None => true,
        };
        (format!("F{font_id}"), usage.type0_ref, new_gid, mapped)
    }

    /// fsType gate, memoised per font. `true` = embeddable. `face_index`
    /// is the face in `face_bytes` when they are a collection
    /// ([`crate::FontByteSource::face_index`]).
    pub fn check_embeddable(&mut self, font_id: u32, face_bytes: &[u8], face_index: u32) -> bool {
        if let Some(usage) = self.fonts.get(&font_id) {
            if let Some(known) = usage.embeddable {
                return known;
            }
        }
        let embeddable = fs_type_allows_embedding(face_bytes, face_index);
        if let Some(usage) = self.fonts.get_mut(&font_id) {
            usage.embeddable = Some(embeddable);
        }
        embeddable
    }
}

/// The source characters a captured glyph stands for: its whole cluster
/// when it holds several, else its one character.
pub fn glyph_text(entry: &paged_compose::GlyphRunEntry) -> Option<String> {
    match &entry.text {
        Some(text) => Some(text.to_string()),
        None => entry.unicode.map(String::from),
    }
}

/// `text` as the hex digits of its UTF-16BE code units: the destination
/// of a ToUnicode `bfchar` entry.
fn utf16_hex(text: &str) -> String {
    text.encode_utf16().map(|u| format!("{u:04X}")).collect()
}

/// OS/2 fsType bit 0x0002 = "restricted licence embedding" (the
/// only combination that forbids embedding outright when no other
/// permissive bit is set).
fn fs_type_allows_embedding(face_bytes: &[u8], face_index: u32) -> bool {
    let Ok(face) = ttf_parser::Face::parse(face_bytes, face_index) else {
        return false;
    };
    match face.tables().os2 {
        Some(os2) => {
            let permissions = os2.permissions();
            !matches!(permissions, Some(ttf_parser::Permissions::Restricted))
        }
        None => true,
    }
}

/// Emit one consecutive glyph slice as a text object. The entries
/// share (font_id, font_size, paint) — the caller groups them.
///
/// Exactness contract: the captured outline affine maps FONT-UNIT
/// outline points to the page (`P · [sx 0; 0 -sy] + (gx, gy)`, with
/// `sx = size·x_scale/upem`). PDF text maps EM-unit glyph space
/// through `Tf size` then `Tm`, i.e. `P/upem · size · Tm`. Equality
/// ⇒ `Tm_linear = transform_linear · upem / size`,
/// `Tm_t = (gx, gy)` — the glyph lands pixel-identical to the
/// outline it replaces, REMAPPED to the subset gid at finish.
///
/// An entry's third member is the text to name with `/ActualText`
/// around that one glyph, for a use the font's `/ToUnicode` does not
/// describe ([`FontPool::use_glyph`]); `None` for every other glyph.
pub fn emit_text_slice(
    content: &mut Content,
    font_name: &str,
    font_size: f32,
    units_per_em: f32,
    entries: &[(&paged_compose::GlyphRunEntry, u16, Option<String>)],
) {
    content.begin_text();
    content.set_font(Name(font_name.as_bytes()), font_size);
    let k = units_per_em / font_size.max(1e-6);
    for (e, new_gid, actual_text) in entries {
        let t = e.transform.0;
        if let Some(text) = actual_text {
            content
                .begin_marked_content_with_properties(Name(b"Span"))
                .properties()
                .actual_text(pdf_writer::TextStr(text));
        }
        content.set_text_matrix([t[0] * k, t[1] * k, t[2] * k, t[3] * k, t[4], t[5]]);
        content.show(Str(&new_gid.to_be_bytes()));
        if actual_text.is_some() {
            content.end_marked_content();
        }
    }
    content.end_text();
}

/// Subset + write every used font. Returns name → Type0 ref (refs
/// were pre-allocated at use time, so page resources already point
/// at the right objects).
pub fn write_fonts(
    pdf: &mut Pdf,
    refs: &mut RefAllocator,
    pool: &mut FontPool,
    input: &ExportInput<'_>,
    diagnostics: &mut Vec<ExportDiagnostic>,
) -> Result<BTreeMap<String, Ref>, ExportError> {
    let mut out = BTreeMap::new();
    let Some(fonts) = input.fonts else {
        return Ok(out);
    };
    for (font_id, usage) in &pool.fonts {
        let name = format!("F{font_id}");
        let Some(face_bytes) = usage.face_id.and_then(|f| fonts.font_bytes(f)) else {
            diagnostics.push(ExportDiagnostic::FontNotEmbeddable {
                font_id: *font_id,
                runs_outlined: usage.remapper.num_gids() as usize,
            });
            continue;
        };
        if usage.embeddable == Some(false) {
            match input.options.restricted_fonts {
                RestrictedFontPolicy::Fail => {
                    return Err(ExportError::FontNotEmbeddable { font_id: *font_id })
                }
                RestrictedFontPolicy::Outline => {
                    diagnostics.push(ExportDiagnostic::FontNotEmbeddable {
                        font_id: *font_id,
                        runs_outlined: usage.outlined_runs,
                    });
                    continue;
                }
            }
        }

        // Subset with the SAME remapper the content streams used.
        let glyph_remapper = &usage.remapper;
        // The face of a collection the layout shaped with: the subset,
        // its metrics and its widths all come from that one face.
        let face_index = usage.face_id.map_or(0, |f| fonts.face_index(f));
        let subset = subsetter::subset(face_bytes, face_index, glyph_remapper)
            .map_err(|e| ExportError::Subset(format!("{e:?}")))?;
        let is_cff = {
            let face = ttf_parser::Face::parse(face_bytes, face_index).ok();
            face.map(|f| {
                f.tables().cff.is_some()
                    || f.raw_face()
                        .table(ttf_parser::Tag::from_bytes(b"CFF2"))
                        .is_some()
            })
            .unwrap_or(false)
        };

        // Metrics for the CIDFont (from the ORIGINAL face; ids are
        // remapped in the subset, widths must be in subset-gid
        // space).
        let face = ttf_parser::Face::parse(face_bytes, face_index)
            .map_err(|e| ExportError::Subset(format!("face parse: {e:?}")))?;
        let units = face.units_per_em() as f32;
        let scale = 1000.0 / units;

        let old_gids: Vec<u16> = glyph_remapper.remapped_gids().collect();
        let base_name = format!("{}+PAGED{}", subset_tag(&old_gids), font_id);

        // Font program stream.
        let file_ref = refs.alloc();
        {
            let data = subset.as_ref();
            let compressed = {
                use std::io::Write as _;
                let mut enc =
                    flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
                let _ = enc.write_all(data);
                enc.finish().unwrap_or_default()
            };
            let mut stream = pdf.stream(file_ref, &compressed);
            stream.filter(pdf_writer::Filter::FlateDecode);
            if is_cff {
                stream.pair(Name(b"Subtype"), Name(b"OpenType"));
            } else {
                stream.pair(Name(b"Length1"), data.len() as i32);
            }
            stream.finish();
        }

        // FontDescriptor.
        let desc_ref = refs.alloc();
        {
            let bbox = face.global_bounding_box();
            let mut d = pdf.font_descriptor(desc_ref);
            d.name(Name(base_name.as_bytes()));
            d.flags(pdf_writer::types::FontFlags::SYMBOLIC);
            d.bbox(pdf_writer::Rect::new(
                bbox.x_min as f32 * scale,
                bbox.y_min as f32 * scale,
                bbox.x_max as f32 * scale,
                bbox.y_max as f32 * scale,
            ));
            d.italic_angle(face.italic_angle());
            d.ascent(face.ascender() as f32 * scale);
            d.descent(face.descender() as f32 * scale);
            d.cap_height(face.capital_height().unwrap_or(face.ascender()) as f32 * scale);
            d.stem_v(95.0);
            if is_cff {
                d.font_file3(file_ref);
            } else {
                d.font_file2(file_ref);
            }
            d.finish();
        }

        // CIDFont (Type0 descendant). CIDs are the REMAPPED subset
        // gids; widths from the original gids.
        let cid_ref = refs.alloc();
        {
            let mut cid = pdf.cid_font(cid_ref);
            cid.subtype(if is_cff {
                pdf_writer::types::CidFontType::Type0
            } else {
                pdf_writer::types::CidFontType::Type2
            });
            cid.base_font(Name(base_name.as_bytes()));
            cid.system_info(pdf_writer::types::SystemInfo {
                registry: Str(b"Adobe"),
                ordering: Str(b"Identity"),
                supplement: 0,
            });
            cid.font_descriptor(desc_ref);
            if !is_cff {
                cid.cid_to_gid_map_predefined(Name(b"Identity"));
            }
            cid.default_width(
                face.glyph_hor_advance(ttf_parser::GlyphId(0))
                    .map(|a| a as f32 * scale)
                    .unwrap_or(500.0),
            );
            // `remapped_gids()` yields old ids in NEW-gid order
            // (0, 1, 2, …) — one consecutive widths run.
            let advances: Vec<f32> = old_gids
                .iter()
                .map(|old| {
                    face.glyph_hor_advance(ttf_parser::GlyphId(*old))
                        .map(|a| a as f32 * scale)
                        .unwrap_or(0.0)
                })
                .collect();
            let mut widths = cid.widths();
            widths.consecutive(0, advances.iter().copied());
            widths.finish();
            cid.finish();
        }

        // ToUnicode CMap (remapped gid → unicode).
        let tounicode_ref = refs.alloc();
        {
            let mut cmap = String::new();
            cmap.push_str(
                "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n",
            );
            // One code to one string of UTF-16BE units: a ligature's
            // glyph maps to all of its letters. A section holds at most
            // 100 entries (the CMap format's limit).
            let pairs: Vec<(u16, &str)> = usage
                .to_unicode
                .iter()
                .map(|(gid, text)| (*gid, text.as_str()))
                .collect();
            for section in pairs.chunks(100) {
                cmap.push_str(&format!("{} beginbfchar\n", section.len()));
                for (gid, text) in section {
                    cmap.push_str(&format!("<{gid:04X}> <{}>\n", utf16_hex(text)));
                }
                cmap.push_str("endbfchar\n");
            }
            cmap.push_str("endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n");
            let stream = pdf.stream(tounicode_ref, cmap.as_bytes());
            stream.finish();
        }

        // Type0 root at the PRE-ALLOCATED ref.
        {
            let mut t0 = pdf.type0_font(usage.type0_ref);
            t0.base_font(Name(base_name.as_bytes()));
            t0.encoding_predefined(Name(b"Identity-H"));
            t0.descendant_font(cid_ref);
            t0.to_unicode(tounicode_ref);
            t0.finish();
        }
        out.insert(name, usage.type0_ref);
    }
    Ok(out)
}

/// The conventional 6-letter subset tag, derived deterministically
/// from the glyph set (NOT random — determinism).
fn subset_tag(gids: &[u16]) -> String {
    // FNV-1a's constants over whole glyph ids rather than bytes.
    let mut h = paged_pixel::FNV1A_32_OFFSET;
    for g in gids {
        h ^= *g as u32;
        h = h.wrapping_mul(paged_pixel::FNV1A_32_PRIME);
    }
    let mut tag = String::with_capacity(6);
    let mut v = h;
    for _ in 0..6 {
        tag.push(char::from(b'A' + (v % 26) as u8));
        v /= 26;
    }
    tag
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn use_glyph_remaps_in_first_use_order() {
        let mut pool = FontPool::default();
        let mut refs = crate::writer::RefAllocator::new();
        // .notdef is pinned at 0, so the first real glyph gets 1,
        // the second 2, and a REPEAT of the first stays 1.
        let (_, _, a, _) = pool.use_glyph(&mut refs, 7, Some(7), 42, Some("A"));
        let (_, _, b, _) = pool.use_glyph(&mut refs, 7, Some(7), 17, Some("B"));
        let (_, _, a2, _) = pool.use_glyph(&mut refs, 7, Some(7), 42, Some("A"));
        assert_eq!((a, b, a2), (1, 2, 1));
        // ToUnicode keys by the REMAPPED gid.
        let usage = pool.fonts.get(&7).unwrap();
        assert_eq!(usage.to_unicode.get(&1).map(String::as_str), Some("A"));
        assert_eq!(usage.to_unicode.get(&2).map(String::as_str), Some("B"));
        // Same font ⇒ same resource name + ref; other font differs.
        let (name_a, ref_a, _, _) = pool.use_glyph(&mut refs, 7, Some(7), 99, None);
        let (name_b, ref_b, _, _) = pool.use_glyph(&mut refs, 8, Some(8), 99, None);
        assert_eq!(name_a, "F7");
        assert_eq!(name_b, "F8");
        assert_ne!(ref_a, ref_b);
    }

    #[test]
    fn text_matrix_is_exact_for_the_glyph_affine() {
        // Contract: Tm = glyph_transform_linear × (upem / font_size),
        // translation untouched — so Tf(font_size) × Tm lands glyphs
        // at IDENTICAL page coordinates to the outline path fill.
        let mut content = Content::new();
        let entry = paged_compose::GlyphRunEntry {
            command_index: 0,
            font_id: 1,
            face_id: Some(1),
            glyph_id: 5,
            font_size: 12.0,
            // sx = 12/1000 (point_size/upem), y negated, at (100, 200).
            transform: paged_compose::Transform([0.012, 0.0, 0.0, -0.012, 100.0, 200.0]),
            paint: paged_compose::Paint::Solid(paged_compose::Color::BLACK),
            unicode: Some('x'),
            text: None,
            is_stroke: false,
            structure: None,
        };
        emit_text_slice(&mut content, "F1", 12.0, 1000.0, &[(&entry, 1, None)]);
        let ops = String::from_utf8(content.finish().to_vec()).unwrap();
        // 0.012 × (1000/12) = 1 exactly.
        assert!(ops.contains("BT"), "{ops}");
        assert!(ops.contains("/F1 12 Tf"), "{ops}");
        assert!(ops.contains("1 0 0 -1 100 200 Tm"), "{ops}");
        // pdf-writer encodes the 2-byte CID as a literal string.
        assert!(ops.contains("(\\000\\001) Tj"), "{ops}");
    }

    #[test]
    fn a_glyph_standing_for_other_characters_is_named_in_place() {
        let mut pool = FontPool::default();
        let mut refs = crate::writer::RefAllocator::new();
        // A ligature glyph maps to all of its letters.
        let (_, _, lig, mapped) = pool.use_glyph(&mut refs, 3, Some(3), 80, Some("ffl"));
        assert!(mapped);
        assert_eq!(pool.fonts[&3].to_unicode[&lig], "ffl");
        assert_eq!(utf16_hex("ffl"), "00660066006C");
        // The same glyph for other characters: ToUnicode keeps the first,
        // and the caller is told to name this use.
        let (_, _, again, mapped) = pool.use_glyph(&mut refs, 3, Some(3), 80, Some("fl"));
        assert_eq!(again, lig);
        assert!(!mapped);
        assert_eq!(pool.fonts[&3].to_unicode[&lig], "ffl");
        // A glyph with no known character says nothing either way.
        let (_, _, _, mapped) = pool.use_glyph(&mut refs, 3, Some(3), 80, None);
        assert!(mapped);

        let entry = paged_compose::GlyphRunEntry {
            command_index: 0,
            font_id: 3,
            face_id: Some(3),
            glyph_id: 80,
            font_size: 10.0,
            transform: paged_compose::Transform([0.01, 0.0, 0.0, -0.01, 0.0, 0.0]),
            paint: paged_compose::Paint::Solid(paged_compose::Color::BLACK),
            unicode: Some('f'),
            text: Some("fl".into()),
            is_stroke: false,
            structure: None,
        };
        assert_eq!(glyph_text(&entry).as_deref(), Some("fl"));
        let mut content = Content::new();
        emit_text_slice(
            &mut content,
            "F3",
            10.0,
            1000.0,
            &[(&entry, lig, Some("fl".to_string()))],
        );
        let ops = String::from_utf8_lossy(&content.finish()).into_owned();
        let open = ops.find("/Span").expect("a Span");
        let show = ops.find("Tj").expect("a shown glyph");
        let close = ops.find("EMC").expect("the Span closes");
        assert!(ops.contains("/ActualText"), "{ops}");
        assert!(open < show && show < close, "{ops}");
    }

    #[test]
    fn subset_tag_is_deterministic_and_wellformed() {
        let a = subset_tag(&[0, 1, 2, 3]);
        let b = subset_tag(&[0, 1, 2, 3]);
        let c = subset_tag(&[0, 1, 2, 4]);
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert_eq!(a.len(), 6);
        assert!(a.chars().all(|ch| ch.is_ascii_uppercase()));
    }
}

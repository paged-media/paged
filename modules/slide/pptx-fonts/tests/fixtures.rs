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

//! The decoder against PowerPoint: the `fonts` and `fonts-full` fixtures are
//! decks PowerPoint wrote with their fonts embedded (OFL faces: Lato in four
//! styles, Gloria Hallelujah, Caveat), as MicroType Express compressed
//! Embedded OpenType, whole (`fonts-full`) and as subsets (`fonts`,
//! PowerPoint's default).
//!
//! `fonts.faces.json` holds what the SOURCE fonts say, recorded from the
//! original TrueType files (`PAGED_FONT_SOURCES=<dir> cargo test -p
//! pptx-fonts --test fixtures record -- --ignored`): per face its glyph
//! count, a hash of every glyph's outline and of its program (the push
//! values and the rest of its instructions, so a different but equivalent
//! push encoding still matches), its advance widths and every other table.
//! A decoded face must give the same answers: all of them for a whole face,
//! the glyphs it holds for a subset.

use std::collections::BTreeMap;
use std::io::Read;
use std::path::PathBuf;

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../slide-conformance/fixtures")
}

/// The `.fntdata` parts of a fixture deck, by part name.
fn parts(name: &str) -> BTreeMap<String, Vec<u8>> {
    let bytes = std::fs::read(fixtures().join(format!("{name}.pptx"))).unwrap();
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let mut out = BTreeMap::new();
    for i in 0..zip.len() {
        let mut f = zip.by_index(i).unwrap();
        if f.name().ends_with(".fntdata") {
            let mut b = Vec::new();
            f.read_to_end(&mut b).unwrap();
            out.insert(f.name().to_string(), b);
        }
    }
    out
}

/// FNV-1a, 64 bits.
fn fnv(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325u64, |h, &b| {
        (h ^ b as u64).wrapping_mul(0x0100_0000_01b3)
    })
}

struct Pen(Vec<u8>);
impl ttf_parser::OutlineBuilder for Pen {
    fn move_to(&mut self, x: f32, y: f32) {
        self.0.push(b'M');
        self.0.extend_from_slice(&x.to_le_bytes());
        self.0.extend_from_slice(&y.to_le_bytes());
    }
    fn line_to(&mut self, x: f32, y: f32) {
        self.0.push(b'L');
        self.0.extend_from_slice(&x.to_le_bytes());
        self.0.extend_from_slice(&y.to_le_bytes());
    }
    fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
        self.0.push(b'Q');
        for v in [x1, y1, x, y] {
            self.0.extend_from_slice(&v.to_le_bytes());
        }
    }
    fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
        self.0.push(b'C');
        for v in [x1, y1, x2, y2, x, y] {
            self.0.extend_from_slice(&v.to_le_bytes());
        }
    }
    fn close(&mut self) {
        self.0.push(b'Z');
    }
}

fn table<'a>(font: &'a [u8], tag: &[u8; 4]) -> Option<&'a [u8]> {
    let n = u16::from_be_bytes([font[4], font[5]]) as usize;
    (0..n).find_map(|i| {
        let r = &font[12 + 16 * i..28 + 16 * i];
        let off = u32::from_be_bytes([r[8], r[9], r[10], r[11]]) as usize;
        let len = u32::from_be_bytes([r[12], r[13], r[14], r[15]]) as usize;
        (&r[0..4] == tag).then(|| &font[off..off + len])
    })
}

fn tags(font: &[u8]) -> Vec<String> {
    let n = u16::from_be_bytes([font[4], font[5]]) as usize;
    (0..n)
        .map(|i| String::from_utf8_lossy(&font[12 + 16 * i..16 + 16 * i]).into_owned())
        .collect()
}

/// Each glyph's program read independently of the decoder: the values its
/// leading PUSHB / PUSHW / NPUSHB / NPUSHW instructions push, then the rest
/// of its bytes.
fn programs(font: &[u8]) -> Vec<(Vec<i32>, Vec<u8>)> {
    let head = table(font, b"head").unwrap();
    let long = i16::from_be_bytes([head[50], head[51]]) != 0;
    let maxp = table(font, b"maxp").unwrap();
    let n = u16::from_be_bytes([maxp[4], maxp[5]]) as usize;
    let loca = table(font, b"loca").unwrap();
    let glyf = table(font, b"glyf").unwrap();
    let at = |i: usize| {
        if long {
            u32::from_be_bytes([
                loca[4 * i],
                loca[4 * i + 1],
                loca[4 * i + 2],
                loca[4 * i + 3],
            ]) as usize
        } else {
            2 * u16::from_be_bytes([loca[2 * i], loca[2 * i + 1]]) as usize
        }
    };
    let be16 = |b: &[u8], o: usize| u16::from_be_bytes([b[o], b[o + 1]]);
    (0..n)
        .map(|g| {
            let (s, e) = (at(g), at(g + 1));
            if s == e {
                return (Vec::new(), Vec::new());
            }
            let d = &glyf[s..e];
            let contours = be16(d, 0) as i16;
            let mut o;
            if contours >= 0 {
                o = 10 + 2 * contours as usize;
            } else {
                o = 10;
                let mut flags;
                loop {
                    flags = be16(d, o);
                    o += 4 + if flags & 1 != 0 { 4 } else { 2 };
                    o += if flags & 8 != 0 {
                        2
                    } else if flags & 0x40 != 0 {
                        4
                    } else if flags & 0x80 != 0 {
                        8
                    } else {
                        0
                    };
                    if flags & 0x20 == 0 {
                        break;
                    }
                }
                if flags & 0x100 == 0 {
                    return (Vec::new(), Vec::new());
                }
            }
            let len = be16(d, o) as usize;
            let code = &d[o + 2..o + 2 + len];
            let (mut values, mut i) = (Vec::new(), 0);
            while i < code.len() {
                let op = code[i];
                let (count, words, head) = match op {
                    0x40 => (code[i + 1] as usize, false, 2),
                    0x41 => (code[i + 1] as usize, true, 2),
                    0xB0..=0xB7 => ((op - 0xB0 + 1) as usize, false, 1),
                    0xB8..=0xBF => ((op - 0xB8 + 1) as usize, true, 1),
                    _ => break,
                };
                i += head;
                for _ in 0..count {
                    if words {
                        values.push(i16::from_be_bytes([code[i], code[i + 1]]) as i32);
                        i += 2;
                    } else {
                        values.push(code[i] as i32);
                        i += 1;
                    }
                }
            }
            (values, code[i..].to_vec())
        })
        .collect()
}

/// What a face says: per glyph the outline hash (0 for none) and program
/// hash, the advances, and each table other than the glyph data's.
#[derive(Debug, PartialEq)]
struct Answers {
    outlines: Vec<u64>,
    programs: Vec<u64>,
    advances: Vec<u16>,
    tables: BTreeMap<String, u64>,
}

fn answers(font: &[u8]) -> Answers {
    let face = ttf_parser::Face::parse(font, 0).unwrap();
    let n = face.number_of_glyphs();
    let outlines = (0..n)
        .map(|g| {
            let mut pen = Pen(Vec::new());
            face.outline_glyph(ttf_parser::GlyphId(g), &mut pen)
                .map(|_| fnv(&pen.0))
                .unwrap_or(0)
        })
        .collect();
    let programs = programs(font)
        .into_iter()
        .map(|(v, rest)| {
            let mut b: Vec<u8> = v.iter().flat_map(|x| x.to_le_bytes()).collect();
            b.push(0xFF);
            b.extend_from_slice(&rest);
            fnv(&b)
        })
        .collect();
    let advances = (0..n)
        .map(|g| face.glyph_hor_advance(ttf_parser::GlyphId(g)).unwrap_or(0))
        .collect();
    let tables = tags(font)
        .into_iter()
        .filter(|t| !matches!(t.as_str(), "glyf" | "loca" | "head" | "DSIG"))
        .map(|t| {
            let tag: [u8; 4] = t.as_bytes().try_into().unwrap();
            let h = fnv(table(font, &tag).unwrap());
            (t, h)
        })
        .collect();
    Answers {
        outlines,
        programs,
        advances,
        tables,
    }
}

// ─── the recorded oracle (a small JSON reader/writer, no dependency) ───

fn hex_list(v: &[u64]) -> String {
    v.iter()
        .map(|h| format!("\"{h:016x}\""))
        .collect::<Vec<_>>()
        .join(",")
}

fn write_answers(name: &str, file: &str, a: &Answers) -> String {
    let tables = a
        .tables
        .iter()
        .map(|(t, h)| format!("\"{t}\":\"{h:016x}\""))
        .collect::<Vec<_>>()
        .join(",");
    let adv = a
        .advances
        .iter()
        .map(|x| x.to_string())
        .collect::<Vec<_>>()
        .join(",");
    format!(
        "  \"{name}\": {{\n   \"source\": \"{file}\",\n   \"tables\": {{{tables}}},\n   \"advances\": [{adv}],\n   \"outlines\": [{}],\n   \"programs\": [{}]\n  }}",
        hex_list(&a.outlines),
        hex_list(&a.programs)
    )
}

/// The value after `"key":` in `s` (from `from`), up to its closing bracket.
fn field<'a>(s: &'a str, key: &str) -> &'a str {
    let at = s
        .find(&format!("\"{key}\":"))
        .unwrap_or_else(|| panic!("no {key}"))
        + key.len()
        + 3;
    let rest = s[at..].trim_start();
    let (open, close) = if rest.starts_with('[') {
        ('[', ']')
    } else {
        ('{', '}')
    };
    let mut depth = 0;
    for (i, c) in rest.char_indices() {
        if c == open {
            depth += 1;
        } else if c == close {
            depth -= 1;
            if depth == 0 {
                return &rest[1..i];
            }
        }
    }
    panic!("unclosed {key}")
}

fn read_answers(json: &str, face: &str) -> Answers {
    let body = field(json, face);
    let hexes = |s: &str| -> Vec<u64> {
        s.split(',')
            .filter(|x| !x.trim().is_empty())
            .map(|x| u64::from_str_radix(x.trim().trim_matches('"'), 16).unwrap())
            .collect()
    };
    let tables = field(body, "tables")
        .split(',')
        .filter(|x| !x.trim().is_empty())
        .map(|kv| {
            let (k, v) = kv.split_once(':').unwrap();
            (
                k.trim().trim_matches('"').to_string(),
                u64::from_str_radix(v.trim().trim_matches('"'), 16).unwrap(),
            )
        })
        .collect();
    Answers {
        outlines: hexes(field(body, "outlines")),
        programs: hexes(field(body, "programs")),
        advances: field(body, "advances")
            .split(',')
            .filter(|x| !x.trim().is_empty())
            .map(|x| x.trim().parse().unwrap())
            .collect(),
        tables,
    }
}

/// The face's key in the oracle and its source file name.
fn face_key(face: &pptx_fonts::EmbeddedFace) -> (String, String) {
    let h = face.header.as_ref().unwrap();
    (
        format!("{} {}", h.family, h.style),
        format!(
            "{}-{}.ttf",
            h.family.replace(' ', ""),
            h.style.replace(' ', "")
        ),
    )
}

const ORACLE: &str = "fonts.faces.json";

#[test]
#[ignore = "records the oracle from the source fonts (PAGED_FONT_SOURCES)"]
fn record() {
    let dir = PathBuf::from(std::env::var("PAGED_FONT_SOURCES").expect("PAGED_FONT_SOURCES"));
    let mut faces = BTreeMap::new();
    for deck in ["fonts", "fonts-full"] {
        for bytes in parts(deck).values() {
            let face = pptx_fonts::decode(bytes).unwrap();
            let (key, file) = face_key(&face);
            let src = std::fs::read(dir.join(&file)).unwrap_or_else(|e| panic!("{file}: {e}"));
            faces.insert(key.clone(), write_answers(&key, &file, &answers(&src)));
        }
    }
    let body = faces.into_values().collect::<Vec<_>>().join(",\n");
    std::fs::write(
        fixtures().join(ORACLE),
        format!("{{\n \"about\": \"What the source fonts of the fonts fixtures say, per face: FNV-1a hashes of each glyph's outline (0: none) and program (push values, then the other instructions), advance widths, and a hash of every table but glyf, loca, head and DSIG. Recorded by pptx-fonts/tests/fixtures.rs (record).\",\n \"faces\": {{\n{body}\n }}\n}}\n"),
    )
    .unwrap();
}

#[test]
fn whole_faces_decode_to_their_source_fonts() {
    let oracle = std::fs::read_to_string(fixtures().join(ORACLE)).unwrap();
    let decks = parts("fonts-full");
    assert_eq!(decks.len(), 5, "Lato in four styles and Gloria Hallelujah");
    for (part, bytes) in decks {
        let face = pptx_fonts::decode(&bytes).unwrap_or_else(|e| panic!("{part}: {e}"));
        let h = face.header.as_ref().unwrap();
        assert!(
            h.compressed() && !h.subset(),
            "{part}: flags {:#x}",
            h.flags
        );
        assert!(face.notes.is_empty(), "{part}: {:?}", face.notes);
        let (key, _) = face_key(&face);
        let want = read_answers(&oracle, &key);
        let got = answers(&face.sfnt);
        assert_eq!(
            got.outlines.len(),
            want.outlines.len(),
            "{key}: glyph count"
        );
        let differ = |a: &[u64], b: &[u64]| (0..a.len()).filter(|&i| a[i] != b[i]).count();
        assert_eq!(differ(&got.outlines, &want.outlines), 0, "{key}: outlines");
        assert_eq!(differ(&got.programs, &want.programs), 0, "{key}: programs");
        assert_eq!(got.advances, want.advances, "{key}: advances");
        assert_eq!(got.tables, want.tables, "{key}: tables");
    }
}

#[test]
fn subset_faces_hold_their_source_glyphs_for_the_decks_text() {
    let oracle = std::fs::read_to_string(fixtures().join(ORACLE)).unwrap();
    let text = "The quick brown fox jumps over the lazy dog SPHINX OF BLACK QUARTZ, JUDGE MY VOW 0123456789 .,;:!?&@()";
    let decks = parts("fonts");
    assert_eq!(
        decks.len(),
        7,
        "Lato ×4, Gloria Hallelujah, Caveat regular and bold"
    );
    for (part, bytes) in decks {
        let face = pptx_fonts::decode(&bytes).unwrap_or_else(|e| panic!("{part}: {e}"));
        assert!(face.permissions.subset, "{part}");
        assert!(face.notes.is_empty(), "{part}: {:?}", face.notes);
        let (key, _) = face_key(&face);
        let want = read_answers(&oracle, &key);
        let got = answers(&face.sfnt);
        assert_eq!(
            got.outlines.len(),
            want.outlines.len(),
            "{key}: a subset keeps the glyph ids"
        );
        // Every glyph the subset holds is the source's.
        let held: Vec<usize> = (0..got.outlines.len())
            .filter(|&g| got.outlines[g] != 0)
            .collect();
        for &g in &held {
            assert_eq!(
                got.outlines[g], want.outlines[g],
                "{key}: glyph {g} outline"
            );
            assert_eq!(
                got.programs[g], want.programs[g],
                "{key}: glyph {g} program"
            );
        }
        // Caveat bold is PowerPoint's addition: the deck sets no bold Caveat.
        if key == "Caveat Bold" {
            continue;
        }
        let sfnt = ttf_parser::Face::parse(&face.sfnt, 0).unwrap();
        for c in text.chars().filter(|c| !c.is_whitespace()) {
            let g = sfnt
                .glyph_index(c)
                .unwrap_or_else(|| panic!("{key}: no glyph for {c:?}"));
            assert!(
                held.contains(&(g.0 as usize)),
                "{key}: {c:?} is not in the subset"
            );
        }
    }
}

#[test]
fn an_xor_obfuscated_face_decodes_like_the_plain_one() {
    let bytes = parts("fonts-full").into_values().next().unwrap();
    let plain = pptx_fonts::decode(&bytes).unwrap();
    // Set TTEMBED_XORENCRYPTDATA and XOR the font data, as the header says.
    let mut obf = bytes.clone();
    let flags = u32::from_le_bytes(obf[12..16].try_into().unwrap()) | 0x1000_0000;
    obf[12..16].copy_from_slice(&flags.to_le_bytes());
    let data_size = u32::from_le_bytes(obf[4..8].try_into().unwrap()) as usize;
    let start = obf.len() - data_size;
    for b in &mut obf[start..] {
        *b ^= 0x50;
    }
    let face = pptx_fonts::decode(&obf).unwrap();
    assert!(face.header.as_ref().unwrap().xor_obfuscated());
    assert_eq!(face.sfnt, plain.sfnt);
}

#[test]
fn a_bare_opentype_part_is_used_as_it_is() {
    let face = pptx_fonts::decode(&parts("fonts-full").into_values().next().unwrap()).unwrap();
    let bare = pptx_fonts::decode(&face.sfnt).unwrap();
    assert!(bare.header.is_none());
    assert_eq!(bare.sfnt, face.sfnt);
    assert_eq!(bare.permissions.fs_type, 0);
    assert_eq!(pptx_fonts::permissions(&face.sfnt).unwrap().fs_type, 0);
}

#[test]
fn the_limits_bound_what_a_decode_allocates() {
    let bytes = parts("fonts-full").into_values().next().unwrap();
    let small = pptx_fonts::Limits {
        max_font_bytes: 20_000,
    };
    assert_eq!(
        pptx_fonts::decode_with(&bytes, &small).unwrap_err(),
        pptx_fonts::Error::TooLarge(20_000)
    );
}

/// Hostile parts: every prefix of a real one, and thousands of corrupted
/// copies (flipped bits, overwritten bytes and fields across the header and
/// all three compressed blocks). The decoder answers each with a face or an
/// error, never a panic, and within the limits.
#[test]
fn corrupted_parts_fail_cleanly() {
    let decks = parts("fonts");
    let bytes = decks.values().min_by_key(|b| b.len()).unwrap().clone();
    let limits = pptx_fonts::Limits {
        max_font_bytes: 4 << 20,
    };
    let mut x = 0x2545_F491_4F6C_DD1Du64;
    let mut next = move || {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        x
    };
    let (mut ok, mut failed) = (0, 0);
    let mut tally = |r: Result<pptx_fonts::EmbeddedFace, pptx_fonts::Error>| match r {
        Ok(f) => {
            assert!(f.sfnt.len() <= limits.max_font_bytes);
            ok += 1
        }
        Err(_) => failed += 1,
    };
    for cut in (0..bytes.len()).step_by(97) {
        tally(pptx_fonts::decode_with(&bytes[..cut], &limits));
    }
    for round in 0..1500 {
        let mut m = bytes.clone();
        for _ in 0..1 + round % 4 {
            let at = (next() as usize) % m.len();
            match next() % 3 {
                0 => m[at] ^= 1 << (next() % 8),
                1 => m[at] = next() as u8,
                _ => {
                    // A size or offset field: header words, MTX offsets.
                    let at = at.min(m.len() - 4);
                    m[at..at + 4].copy_from_slice(&(next() as u32).to_le_bytes());
                }
            }
        }
        tally(pptx_fonts::decode_with(&m, &limits));
    }
    assert!(failed > 0 && ok > 0, "ok {ok}, failed {failed}");
}

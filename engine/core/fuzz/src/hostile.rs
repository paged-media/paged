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

//! Hostile seeds: the inputs the parsers' limit tests build (zip bombs and
//! lying zip headers, canvases past a container's limit, nesting past a
//! depth limit, counts that multiply), as files a fuzzer can start from.
//!
//! `seeds/` holds them beside the real files; `tests/smoke.rs` checks that
//! the committed files are what this module builds, and its ignored
//! `write_hostile_seeds` test writes them again.

use crate::zip_of;

/// One seed: the target it belongs to, its file name, its bytes.
pub type Seed = (&'static str, String, Vec<u8>);

type Named = (&'static str, &'static str, Vec<u8>);

const IDML_MIMETYPE: &[u8] = b"application/vnd.adobe.indesign-idml-package";
const MIB: usize = 1 << 20;

fn u32_at(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

/// Rewrite the uncompressed size the headers of entry `name` declare (local
/// header and central directory), leaving the data alone.
fn declare_size(package: &mut [u8], name: &str, size: u32) {
    let mut i = 0;
    while i + 46 <= package.len() {
        let (size_at, len_at, name_at) = match u32_at(package, i) {
            0x0403_4b50 => (i + 22, i + 26, i + 30),
            0x0201_4b50 => (i + 24, i + 28, i + 46),
            _ => {
                i += 1;
                continue;
            }
        };
        let len = u16::from_le_bytes([package[len_at], package[len_at + 1]]) as usize;
        if package.get(name_at..name_at + len) == Some(name.as_bytes()) {
            package[size_at..size_at + 4].copy_from_slice(&size.to_le_bytes());
        }
        i += 4;
    }
}

fn idml_package(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut all: Vec<(&str, &[u8])> = vec![
        ("mimetype", IDML_MIMETYPE),
        ("designmap.xml", b"<Document/>"),
    ];
    all.extend_from_slice(entries);
    zip_of(&all)
}

fn idml() -> Vec<Named> {
    let zeros = vec![0u8; 8 * MIB];
    let bomb = idml_package(&[("Stories/bomb.xml", &zeros)]);
    let mut declared_small = bomb.clone();
    declare_size(&mut declared_small, "Stories/bomb.xml", 10);
    let mut declared_huge = idml_package(&[("Stories/bomb.xml", b"<Story/>")]);
    declare_size(&mut declared_huge, "Stories/bomb.xml", 0xFFFF_FF00);
    let sound = idml_package(&[("Stories/a.xml", &b"<Story>some text</Story>".repeat(64))]);
    let truncated = sound[..sound.len() * 2 / 3].to_vec();
    let t = "idml_import";
    vec![
        (t, "hostile-bomb.idml", bomb),
        (t, "hostile-bomb-declared-small.idml", declared_small),
        (t, "hostile-bomb-declared-huge.idml", declared_huge),
        (t, "hostile-truncated.idml", truncated),
        (
            t,
            "hostile-no-zip.bin",
            b"<?xml version=\"1.0\"?><Document/>".to_vec(),
        ),
        (t, "hostile-empty-designmap.idml", sound),
    ]
}

/// One seed of a `*_parts` target for every replaceable part of its sound
/// package: the part's index, then the part as it is.
fn parts(target: &'static str, base: &[u8]) -> Vec<Seed> {
    let entries = crate::entries_of(base);
    crate::replaceable(&entries)
        .iter()
        .enumerate()
        .map(|(pick, &i)| {
            let (name, part) = &entries[i];
            let stem: String = name
                .chars()
                .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
                .collect();
            let mut bytes = vec![pick as u8];
            bytes.extend_from_slice(part);
            (
                target,
                format!("part-{pick:02}-{}.bin", stem.trim_matches('-')),
                bytes,
            )
        })
        .collect()
}

fn nest(open: &str, close: &str, n: usize) -> Vec<u8> {
    format!("{}{}", open.repeat(n), close.repeat(n)).into_bytes()
}

fn paged() -> Vec<Named> {
    let model = |pgm: &[u8]| {
        zip_of(&[
            ("mimetype", IDML_MIMETYPE),
            ("designmap.xml", b"<Document/>"),
            (paged_store::DOCUMENT_PGM_PATH, pgm),
        ])
    };
    let newer = br#"{"format_version":4000000000,"model":{}}"#;
    let missing_blob = br#"{"format_version":4,"model":{"images":[{"blob":"0000.png"}]}}"#;
    vec![
        (
            "paged_model",
            "hostile-nested-arrays.bin",
            nest("[", "]", 10_000),
        ),
        (
            "paged_model",
            "hostile-nested-objects.bin",
            nest("{\"a\":", "}", 5_000),
        ),
        ("paged_model", "hostile-newer-version.bin", newer.to_vec()),
        (
            "paged_model",
            "hostile-empty-model.bin",
            br#"{"format_version":4,"model":{}}"#.to_vec(),
        ),
        (
            "paged_model",
            "hostile-missing-blob.bin",
            missing_blob.to_vec(),
        ),
        (
            "paged_container",
            "hostile-model-not-json.paged",
            model(b"not json"),
        ),
        ("paged_container", "hostile-model-newer.paged", model(newer)),
        (
            "paged_container",
            "hostile-model-nested.paged",
            model(&nest("[", "]", 10_000)),
        ),
        (
            "paged_container",
            "hostile-model-bomb.paged",
            model(&vec![b' '; 8 * MIB]),
        ),
    ]
}

/// Minimal PSD bytes: the header, three empty sections, the composite.
fn psd_bytes(
    version: u16,
    channels: u16,
    width: u32,
    height: u32,
    depth: u16,
    mode: u16,
    compression: u16,
    payload: &[u8],
) -> Vec<u8> {
    let mut b = Vec::new();
    b.extend_from_slice(b"8BPS");
    b.extend_from_slice(&version.to_be_bytes());
    b.extend_from_slice(&[0u8; 6]);
    b.extend_from_slice(&channels.to_be_bytes());
    b.extend_from_slice(&height.to_be_bytes());
    b.extend_from_slice(&width.to_be_bytes());
    b.extend_from_slice(&depth.to_be_bytes());
    b.extend_from_slice(&mode.to_be_bytes());
    b.extend_from_slice(&0u32.to_be_bytes());
    b.extend_from_slice(&0u32.to_be_bytes());
    if version == 2 {
        b.extend_from_slice(&0u64.to_be_bytes());
    } else {
        b.extend_from_slice(&0u32.to_be_bytes());
    }
    b.extend_from_slice(&compression.to_be_bytes());
    b.extend_from_slice(payload);
    b
}

fn psd() -> Vec<Named> {
    // 10,000 x 10,000 RGB (300 MB of planes) whose every packed row claims
    // one byte.
    let rows = 10_000usize * 3;
    let mut short_rle = Vec::with_capacity(rows * 3);
    for _ in 0..rows {
        short_rle.extend_from_slice(&1u16.to_be_bytes());
    }
    short_rle.extend(std::iter::repeat_n(0u8, rows));
    let t = "psd";
    vec![
        (
            t,
            "hostile-canvas-past-limit.psd",
            psd_bytes(1, 3, 30_001, 1, 8, 3, 0, &[]),
        ),
        (
            t,
            "hostile-canvas-u32-max.psd",
            psd_bytes(1, 3, u32::MAX, u32::MAX, 8, 3, 0, &[]),
        ),
        (
            t,
            "hostile-raw-composite-missing.psd",
            psd_bytes(1, 3, 30_000, 30_000, 8, 3, 0, &[]),
        ),
        (
            t,
            "hostile-rle-composite-short.psd",
            psd_bytes(1, 3, 10_000, 10_000, 8, 3, 1, &short_rle),
        ),
        (
            t,
            "hostile-psb-canvas.psb",
            psd_bytes(2, 4, 300_000, 300_000, 16, 4, 1, &[0u8; 64]),
        ),
        (
            t,
            "hostile-channels.psd",
            psd_bytes(1, 56, 64, 64, 32, 9, 0, &[0u8; 64]),
        ),
        (
            t,
            "tiny-rgb-raw.psd",
            psd_bytes(1, 3, 2, 2, 8, 3, 0, &[7u8; 12]),
        ),
    ]
}

fn postscript() -> Vec<Named> {
    let eps = |body: &str| {
        format!("%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 100 100\n{body}\n%%EOF\n").into_bytes()
    };
    let t = "postscript";
    vec![
        (t, "hostile-loop.eps", eps("{ } loop")),
        (t, "hostile-recursion.eps", eps("/f { f } def f")),
        (t, "hostile-array.eps", eps("2147483647 array")),
        (t, "hostile-dict.eps", eps("2147483647 dict")),
        (t, "hostile-string.eps", eps("2147483647 string")),
        (t, "hostile-stack.eps", eps("{ 0 } loop")),
        (t, "hostile-doubling.eps", eps("[ 0 ] { dup aload pop ] } loop")),
        (t, "hostile-path.eps", eps("0 0 moveto { 1 1 rlineto } loop")),
        (t, "hostile-nested-procs.eps", {
            let mut body = "{".repeat(5_000);
            body.push_str(&"}".repeat(5_000));
            eps(&body)
        }),
        (
            t,
            "square.eps",
            eps("newpath 10 10 moveto 90 10 lineto 90 90 lineto 10 90 lineto closepath\n0.2 0.4 0.6 setrgbcolor fill\n1 0 0 setrgbcolor 4 setlinewidth 10 10 80 80 rectstroke"),
        ),
    ]
}

fn ooxml() -> Vec<Named> {
    let bomb = zip_of(&[
        ("[Content_Types].xml", b"<Types/>"),
        ("word/document.xml", &vec![0u8; 8 * MIB]),
    ]);
    let mut declared_huge = zip_of(&[
        ("[Content_Types].xml", b"<Types/>"),
        ("word/document.xml", b"<w:document/>"),
    ]);
    declare_size(&mut declared_huge, "word/document.xml", 0xFFFF_FF00);
    let attributes = {
        let mut s = String::from("<a");
        for i in 0..2_000 {
            s.push_str(&format!(" a{i}=\"{i}\""));
        }
        s.push_str("/>");
        s.into_bytes()
    };
    let entities = b"<?xml version=\"1.0\"?><!DOCTYPE a [<!ENTITY a \"aaaaaaaaaa\"><!ENTITY b \"&a;&a;&a;&a;&a;&a;&a;&a;\"><!ENTITY c \"&b;&b;&b;&b;&b;&b;&b;&b;\"><!ENTITY d \"&c;&c;&c;&c;&c;&c;&c;&c;\">]><a>&d;&d;&d;&d;</a>";
    vec![
        ("ooxml_opc", "hostile-bomb.zip", bomb),
        ("ooxml_opc", "hostile-declared-huge.zip", declared_huge),
        (
            "ooxml_opc",
            "hostile-cfb.bin",
            b"\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1\0\0\0\0".to_vec(),
        ),
        (
            "ooxml_opc",
            "hostile-rtf.bin",
            b"{\\rtf1\\ansi hello}".to_vec(),
        ),
        (
            "ooxml_xml",
            "hostile-nested-unclosed.bin",
            "<a>".repeat(20_000).into_bytes(),
        ),
        (
            "ooxml_xml",
            "hostile-nested-257.bin",
            nest("<a>", "</a>", 257),
        ),
        ("ooxml_xml", "nested-256.bin", nest("<a>", "</a>", 256)),
        ("ooxml_xml", "hostile-attributes.bin", attributes),
        ("ooxml_xml", "hostile-entities.bin", entities.to_vec()),
    ]
}

fn data_expr() -> Vec<Named> {
    // Far past the parser's depth limit, and small enough to mutate.
    let n = 10_000;
    let t = "data_expr";
    let text = |s: String| s.into_bytes();
    vec![
        (
            t,
            "hostile-parens.txt",
            text(format!("{}1{}", "(".repeat(n), ")".repeat(n))),
        ),
        (t, "hostile-parens-open.txt", text("(".repeat(n))),
        (t, "hostile-unary.txt", text(format!("{}1", "-".repeat(n)))),
        (
            t,
            "hostile-calls.txt",
            text(format!("{}1{}", "ABS(".repeat(n), ")".repeat(n))),
        ),
        (
            t,
            "hostile-sum-chain.txt",
            text(format!("1{}", "+1".repeat(n))),
        ),
        (
            t,
            "hostile-concat-chain.txt",
            text(format!("1{}", "&1".repeat(n))),
        ),
        (
            t,
            "hostile-rept.txt",
            text("REPT(\"ab\", 1000000000000000000)".into()),
        ),
        (
            t,
            "hostile-rept-product.txt",
            text("REPT(\"ab\", 1000000000000000000*1000000000000000000)".into()),
        ),
        (
            t,
            "hostile-rept-nested.txt",
            text("LEN(REPT(REPT(\"ab\", 16383), 16383))".into()),
        ),
        (t, "sum-chain-99.txt", text(format!("1{}", "+1".repeat(99)))),
        (
            t,
            "fields.txt",
            text(
                "IF(in_stock, UPPER(name) & \": \" & ROUND(price * qty * (1 + rate), 2), \"-\")"
                    .into(),
            ),
        ),
        (
            t,
            "dates.txt",
            text("TEXT(date, \"yyyy-mm-dd\") & \" \" & YEAR(TODAY())".into()),
        ),
    ]
}

fn dxf() -> Vec<Named> {
    let mut s = String::from("0\nSECTION\n2\nBLOCKS\n");
    let block = |name: &str, body: &str| {
        format!("0\nBLOCK\n8\n0\n2\n{name}\n70\n0\n10\n0\n20\n0\n30\n0\n3\n{name}\n{body}0\nENDBLK\n8\n0\n")
    };
    let array = |name: &str| {
        format!(
            "0\nINSERT\n8\n0\n2\n{name}\n10\n0\n20\n0\n30\n0\n70\n100\n71\n100\n44\n2.0\n45\n2.0\n"
        )
    };
    s.push_str(&block(
        "B0",
        "0\nLINE\n8\n0\n10\n0\n20\n0\n30\n0\n11\n1\n21\n0\n31\n0\n",
    ));
    for level in 1..8 {
        s.push_str(&block(
            &format!("B{level}"),
            &array(&format!("B{}", level - 1)),
        ));
    }
    s.push_str("0\nENDSEC\n0\nSECTION\n2\nENTITIES\n");
    let entities_at = s.len();
    s.push_str(&array("B7"));
    s.push_str("0\nENDSEC\n0\nEOF\n");

    // A block that inserts itself.
    let own = format!(
        "0\nSECTION\n2\nBLOCKS\n{}0\nENDSEC\n0\nSECTION\n2\nENTITIES\n{}0\nENDSEC\n0\nEOF\n",
        block("LOOP", "0\nINSERT\n8\n0\n2\nLOOP\n10\n1\n20\n1\n30\n0\n"),
        "0\nINSERT\n8\n0\n2\nLOOP\n10\n0\n20\n0\n30\n0\n"
    );
    let plain = format!(
        "{}0\nLINE\n8\n0\n10\n0\n20\n0\n30\n0\n11\n10\n21\n5\n31\n0\n0\nCIRCLE\n8\n0\n10\n5\n20\n5\n30\n0\n40\n2.5\n0\nARC\n8\n0\n10\n0\n20\n0\n30\n0\n40\n3\n50\n0\n51\n90\n0\nLWPOLYLINE\n8\n0\n90\n3\n70\n1\n10\n0\n20\n0\n10\n4\n20\n0\n10\n4\n20\n3\n0\nTEXT\n8\n0\n10\n1\n20\n1\n30\n0\n40\n2\n1\nhello\n0\nENDSEC\n0\nEOF\n",
        &s[..entities_at]
    );
    let t = "dxf";
    vec![
        (t, "hostile-nested-arrays.dxf", s.into_bytes()),
        (t, "hostile-self-insert.dxf", own.into_bytes()),
        (t, "entities.dxf", plain.into_bytes()),
    ]
}

fn svg() -> Vec<Named> {
    let doc = |body: &str| {
        format!("<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" width=\"100\" height=\"100\">{body}</svg>").into_bytes()
    };
    let groups = {
        let mut s = "<g>".repeat(5_000);
        s.push_str("<rect width=\"1\" height=\"1\"/>");
        s.push_str(&"</g>".repeat(5_000));
        doc(&s)
    };
    let uses = {
        let mut s = String::from("<defs><g id=\"u0\"><rect width=\"1\" height=\"1\"/></g>");
        for i in 1..40 {
            s.push_str(&format!(
                "<g id=\"u{i}\"><use xlink:href=\"#u{}\"/><use xlink:href=\"#u{}\"/></g>",
                i - 1,
                i - 1
            ));
        }
        s.push_str("</defs><use xlink:href=\"#u39\"/>");
        doc(&s)
    };
    let entities = b"<?xml version=\"1.0\"?><!DOCTYPE svg [<!ENTITY a \"aaaaaaaaaa\"><!ENTITY b \"&a;&a;&a;&a;&a;&a;&a;&a;\"><!ENTITY c \"&b;&b;&b;&b;&b;&b;&b;&b;\"><!ENTITY d \"&c;&c;&c;&c;&c;&c;&c;&c;\">]><svg xmlns=\"http://www.w3.org/2000/svg\"><text>&d;&d;&d;&d;</text></svg>";
    let t = "svg_import";
    vec![
        (t, "hostile-nested-groups.bin", groups),
        (t, "hostile-use-doubling.bin", uses),
        (t, "hostile-entities.bin", entities.to_vec()),
        (t, "hostile-self-use.bin", doc("<g id=\"a\"><use xlink:href=\"#a\"/></g><use xlink:href=\"#a\"/>")),
        (t, "hostile-self-pattern.bin", doc("<defs><pattern id=\"p\" width=\"1e-9\" height=\"1e-9\" patternUnits=\"userSpaceOnUse\"><rect width=\"1\" height=\"1\" fill=\"url(#p)\"/></pattern></defs><rect width=\"1e9\" height=\"1e9\" fill=\"url(#p)\"/>")),
        (t, "hostile-filter-region.bin", doc("<defs><filter id=\"f\" x=\"-1e9\" y=\"-1e9\" width=\"1e12\" height=\"1e12\" filterUnits=\"userSpaceOnUse\"><feGaussianBlur stdDeviation=\"1e9\"/></filter></defs><rect width=\"10\" height=\"10\" filter=\"url(#f)\"/>")),
        (t, "hostile-numbers.bin", doc("<path d=\"M1e308 1e308L-1e308 NaN A1e-320 0 1e99 1 1 inf 0z\" stroke-width=\"1e38\" stroke-dasharray=\"1e-45 0\" transform=\"matrix(1e38 0 0 1e38 1e38 1e38)\"/>")),
    ]
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = !0u32;
    for &b in bytes {
        crc ^= b as u32;
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0xEDB8_8320 & (!(crc & 1)).wrapping_add(1));
        }
    }
    !crc
}

fn png_chunk(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
    let mut out = (body.len() as u32).to_be_bytes().to_vec();
    let mut tagged = kind.to_vec();
    tagged.extend_from_slice(body);
    out.extend_from_slice(&tagged);
    out.extend_from_slice(&crc32(&tagged).to_be_bytes());
    out
}

/// A PNG whose header names `width` x `height` RGBA over a few bytes of
/// image data.
fn png(width: u32, height: u32) -> Vec<u8> {
    let mut out = b"\x89PNG\r\n\x1a\n".to_vec();
    let mut ihdr = width.to_be_bytes().to_vec();
    ihdr.extend_from_slice(&height.to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
    out.extend(png_chunk(b"IHDR", &ihdr));
    // zlib: one stored block of a filter byte and one transparent pixel.
    out.extend(png_chunk(
        b"IDAT",
        &[
            0x78, 0x01, 0x01, 0x05, 0x00, 0xFA, 0xFF, 0, 0, 0, 0, 0, 0x00, 0x05, 0x00, 0x01,
        ],
    ));
    out.extend(png_chunk(b"IEND", &[]));
    out
}

/// A little-endian TIFF of one strip whose tags name `width` x `height`.
fn tiff(width: u32, height: u32) -> Vec<u8> {
    let mut out = b"II\x2a\0\x08\0\0\0".to_vec();
    let tags: [(u16, u16, u32); 8] = [
        (256, 4, width),
        (257, 4, height),
        (258, 3, 8),
        (259, 3, 1),
        (262, 3, 1),
        (273, 4, 8),
        (278, 4, height),
        (279, 4, 8),
    ];
    out.extend_from_slice(&(tags.len() as u16).to_le_bytes());
    for (tag, kind, value) in tags {
        out.extend_from_slice(&tag.to_le_bytes());
        out.extend_from_slice(&kind.to_le_bytes());
        out.extend_from_slice(&1u32.to_le_bytes());
        out.extend_from_slice(&value.to_le_bytes());
    }
    out.extend_from_slice(&0u32.to_le_bytes());
    out
}

fn raster() -> Vec<Named> {
    let bmp = {
        let mut b = b"BM".to_vec();
        b.extend_from_slice(&[0; 8]);
        b.extend_from_slice(&54u32.to_le_bytes());
        b.extend_from_slice(&40u32.to_le_bytes());
        b.extend_from_slice(&0x7FFF_FFFFu32.to_le_bytes());
        b.extend_from_slice(&0x7FFF_FFFFu32.to_le_bytes());
        b.extend_from_slice(&[1, 0, 32, 0]);
        b.extend_from_slice(&[0; 24]);
        b
    };
    let gif = b"GIF89a\xff\xff\xff\xff\x80\0\0\0\0\0\xff\xff\xff,\0\0\0\0\xff\xff\xff\xff\0\x02\x02D\x01\0;".to_vec();
    let t = "raster";
    vec![
        (t, "hostile-dimensions.png", png(60_000, 60_000)),
        (
            t,
            "hostile-dimensions-max.png",
            png(0x7FFF_FFFF, 0x7FFF_FFFF),
        ),
        (t, "tiny.png", png(1, 1)),
        (t, "hostile-dimensions.tif", tiff(0x7FFF_FFFF, 0x7FFF_FFFF)),
        (t, "hostile-strip.tif", tiff(60_000, 60_000)),
        (t, "hostile-dimensions.bmp", bmp),
        (t, "hostile-dimensions.gif", gif),
        (
            t,
            "hostile-canvas.psd",
            psd_bytes(1, 3, 30_000, 30_000, 8, 3, 1, &[0u8; 64]),
        ),
    ]
}

fn pdf() -> Vec<Named> {
    let file = |objects: &str| {
        format!("%PDF-1.7\n{objects}trailer\n<< /Root 1 0 R /Size 8 >>\n%%EOF\n").into_bytes()
    };
    let page = |content: &str| {
        file(&format!(
            "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>\nendobj\n4 0 obj\n<< /Length {} >>\nstream\n{content}\nendstream\nendobj\n",
            content.len()
        ))
    };
    let t = "pdf_import";
    vec![
        (
            t,
            "hostile-page-tree-loop.pdf",
            file("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [2 0 R 2 0 R] /Count 2000000000 >>\nendobj\n"),
        ),
        (t, "hostile-nested-arrays.pdf", page(&format!("{}{} pop", "[".repeat(10_000), "]".repeat(10_000)))),
        (t, "hostile-nested-q.pdf", page(&"q ".repeat(10_000))),
        (t, "hostile-numbers.pdf", page("1e38 0 0 1e38 1e38 1e38 cm 0 0 m 99999999999999999999 1 l -1e38 1e38 1e38 -1e38 re 1e38 w [1e-38 0] 0 d S")),
        (
            t,
            "hostile-mediabox.pdf",
            file("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1e38 -1e38] /Rotate 45 >>\nendobj\n"),
        ),
        (t, "hostile-stream-length.pdf", file("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>\nendobj\n4 0 obj\n<< /Length 4294967295 /Filter /FlateDecode >>\nstream\nx\nendstream\nendobj\n")),
        (t, "page.pdf", page("0.2 0.4 0.6 rg 10 10 80 80 re f 1 0 0 RG 4 w 20 20 m 180 180 l S")),
    ]
}

/// Every hostile seed, and the per-part seeds of the `*_parts` targets.
pub fn seeds() -> Vec<Seed> {
    let named = [
        idml(),
        paged(),
        psd(),
        postscript(),
        ooxml(),
        data_expr(),
        dxf(),
        svg(),
        raster(),
        pdf(),
    ];
    let mut all: Vec<Seed> = named
        .into_iter()
        .flatten()
        .map(|(target, name, bytes)| (target, name.to_string(), bytes))
        .collect();
    all.extend(parts("idml_parts", crate::IDML_BASE));
    all.extend(parts("docx_parts", crate::DOCX_BASE));
    all.extend(parts("pptx_parts", crate::PPTX_BASE));
    all
}

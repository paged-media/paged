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

//! A frame of CJK text sets its first baseline where InDesign 20.0.1 does
//! (`tools/indesign-export/cjk-first-baseline-probe`: 30 pt, the first
//! baseline's distance below the frame's top).
//!
//! * Ascent (the default) is not the face's `hhea` ascender for a CJK
//!   face: a static one takes the top of its `d`, a variable one (Noto
//!   Sans JP) one em below the top of its ideographic character face.
//! * A Latin face's Ascent is its `OS/2` typographic ascender, not its
//!   `hhea` one, where the two differ (Roboto 2, Lato).
//! * Em Box Height is one em above the `BASE` table's ideographic baseline,
//!   or, with no `BASE`, one em centred on the face's 永.
//!
//! Noto Sans JP is in the corpus. Arial Unicode MS and AppleMyungjo, two
//! static CJK faces without a `BASE` table, ship with macOS: their cases
//! run where those files are (macOS, CI's macOS job) and are skipped
//! elsewhere.

use std::io::Write;
use std::path::PathBuf;

use paged_compose::DisplayCommand;
use paged_renderer::{pipeline, BytesResolver, PipelineOptions};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

/// The first baseline (pt below the frame's top) of a frame holding
/// `text` in `family` at 30 pt, its first baseline offset `offset` (an
/// IDML `FirstBaselineOffset`, `None` for the default).
fn first_baseline(family: &str, font: &[u8], text: &str, offset: Option<&str>) -> f32 {
    let pref = offset
        .map(|o| format!(r#"<TextFramePreference FirstBaselineOffset="{o}"/>"#))
        .unwrap_or_default();
    let mut zip = ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    zip.start_file("mimetype", stored).unwrap();
    zip.write_all(b"application/vnd.adobe.indesign-idml-package")
        .unwrap();
    let mut put = |path: &str, body: &str| {
        zip.start_file(path, deflated).unwrap();
        zip.write_all(body.as_bytes()).unwrap();
    };
    put(
        "designmap.xml",
        r#"<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="20.0">
<idPkg:Spread src="Spreads/Spread_sp1.xml"/>
<idPkg:Story src="Stories/Story_s1.xml"/>
</Document>"#,
    );
    put(
        "Spreads/Spread_sp1.xml",
        &format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Spread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="20.0">
<Spread Self="sp1">
<Page Self="p1" GeometricBounds="0 0 841.89 595.276"/>
<TextFrame Self="tf1" ParentStory="s1" GeometricBounds="30 40 85 440">{pref}</TextFrame>
</Spread>
</idPkg:Spread>"#
        ),
    );
    put(
        "Stories/Story_s1.xml",
        &format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Story xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="20.0"><Story Self="s1"><ParagraphStyleRange><CharacterStyleRange AppliedFont="{family}" FontStyle="Regular" PointSize="30"><Content>{text}</Content></CharacterStyleRange></ParagraphStyleRange></Story></idPkg:Story>"#
        ),
    );
    let idml = zip.finish().unwrap().into_inner();
    let mut resolver = BytesResolver::new();
    resolver.add_font(family, None, font.to_vec());
    let opts = PipelineOptions {
        assets: Some(&resolver),
        ..PipelineOptions::default()
    };
    let doc = idml_import::import_idml_doc(&idml).unwrap();
    let built = pipeline::build_document(&doc, &opts).unwrap();
    built.pages[0]
        .list
        .commands
        .iter()
        .find_map(|c| match c {
            DisplayCommand::FillPath { transform, .. } => {
                let [a, b, c2, d, _, ty] = transform.0;
                (b.abs() < 1e-5 && c2.abs() < 1e-5 && a > 0.0 && d < 0.0).then_some(ty - 30.0)
            }
            _ => None,
        })
        .expect("a glyph")
}

/// The face's two first baselines, Ascent and Em Box Height, against
/// InDesign's, to 0.02 pt.
fn assert_as_indesign(family: &str, font: &[u8], text: &str, ascent: f32, em_box: f32) {
    for (offset, want) in [(None, ascent), (Some("EmboxHeight"), em_box)] {
        let got = first_baseline(family, font, text, offset);
        assert!(
            (got - want).abs() < 0.02,
            "{family} {offset:?}: first baseline {got} pt, InDesign {want} pt"
        );
    }
}

#[test]
fn a_variable_cjk_face_sets_its_first_baseline_as_indesign_does() {
    // Noto Sans JP: hhea 1.16 em, but InDesign 24.81 pt (0.827 em, its
    // BASE icft) and its em box 26.4 pt (one em above ideo -120).
    let font = std::fs::read(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../corpus/fonts/NotoSansJP-VF.ttf"),
    )
    .unwrap();
    assert_as_indesign("Noto Sans JP", &font, "漢字かなAx", 24.81, 26.4);
}

#[test]
fn a_static_cjk_face_takes_its_ascent_from_its_d_and_its_em_box_from_its_ideograph() {
    // InDesign: Arial Unicode MS 21.475 pt (its d, 0.716 em; hhea 1.069)
    // and 26.594 pt (an em centred on its 永); AppleMyungjo 21.93 and
    // 25.355 pt.
    for (family, file, ascent, em_box) in [
        ("Arial Unicode MS", "Arial Unicode.ttf", 21.475, 26.594),
        ("AppleMyungjo", "AppleMyungjo.ttf", 21.93, 25.355),
    ] {
        let Ok(font) = std::fs::read(format!("/System/Library/Fonts/Supplemental/{file}")) else {
            eprintln!("skipped: no {file} on this machine");
            continue;
        };
        assert_as_indesign(family, &font, "漢字かなAx", ascent, em_box);
    }
}

#[test]
fn a_latin_face_whose_tables_agree_keeps_that_ascent() {
    // Open Sans: its ascender (hhea and OS/2 both say 2189), 32.065 pt; its
    // em box centred on half its cap height, 25.708 pt.
    let font = std::fs::read(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../corpus/fonts/OpenSans.ttf"),
    )
    .unwrap();
    assert_as_indesign("Open Sans", &font, "Hxg", 32.065, 25.708);
}

/// `font` with its `OS/2` typographic ascender and descender set to
/// `ascender` / `descender` (font units), `hhea` left as it is.
fn with_typo_metrics(font: &[u8], ascender: i16, descender: i16) -> Vec<u8> {
    let mut out = font.to_vec();
    let tables = u16::from_be_bytes([font[4], font[5]]) as usize;
    for i in 0..tables {
        let rec = 12 + 16 * i;
        if &font[rec..rec + 4] == b"OS/2" {
            let off = u32::from_be_bytes(font[rec + 8..rec + 12].try_into().unwrap()) as usize;
            out[off + 68..off + 70].copy_from_slice(&ascender.to_be_bytes());
            out[off + 70..off + 72].copy_from_slice(&descender.to_be_bytes());
            return out;
        }
    }
    panic!("no OS/2 table");
}

#[test]
fn a_latin_face_takes_its_ascent_from_os2_not_hhea() {
    // InDesign 20.0.1, 30 pt, Ascent: Roboto 2.000980 (hhea 1900/-500, typo
    // 1536/-512 of 2048) 22.5 pt, ascent 22.5 and descent 7.5 reported;
    // Lato 1.104 (hhea 1974/-426, typo 1610/-390 of 2000) 24.15 pt. Both
    // are the typo values; the hhea ones would be 27.83 and 29.61 pt. The
    // corpus Roboto states 2146 in both tables, so stamp the old typo
    // values into it and leave hhea at 2146 (31.44 pt).
    let roboto = std::fs::read(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../corpus/fonts/Roboto-Regular.ttf"),
    )
    .unwrap();
    let font = with_typo_metrics(&roboto, 1536, -512);
    let got = first_baseline("Roboto", &font, "Hxg", None);
    assert!(
        (got - 22.5).abs() < 0.02,
        "first baseline {got} pt, InDesign 22.5 pt"
    );
}

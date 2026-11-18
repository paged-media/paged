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

//! The editor's business card sets "NORTHWIND PRINT" in Inter at 12 pt,
//! and Inter's I is a single rectangle. A list built as the editor builds
//! it carries no glyph-run table, so the text emitter marks its outlines as
//! glyphs itself, and the rasterizer leaves them out of stroke adjustment:
//! both I's come out with the stem the font gives them. Before, the CPU
//! lane rounded each I's sides to whole device pixels, and the GPU lane's
//! page-space scene to whole points (`paged-gpu`'s `glyph_stems` test).

use std::io::Write;
use std::path::PathBuf;

use paged_compose::{Color, DisplayCommand, PathSegment};
use paged_renderer::{pipeline, BytesResolver, PipelineOptions};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

fn inter() -> Vec<u8> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../corpus/fonts/Inter.ttf");
    std::fs::read(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

/// The card (252 × 144 pt) with its headline frame, as the editor's
/// template builds it.
fn card_idml() -> Vec<u8> {
    let mut zip = ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    let mut file = |name: &str, body: &str, opts| {
        zip.start_file(name, opts).unwrap();
        zip.write_all(body.as_bytes()).unwrap();
    };
    file(
        "mimetype",
        "application/vnd.adobe.indesign-idml-package",
        stored,
    );
    file(
        "designmap.xml",
        r#"<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <idPkg:Spread src="Spreads/Spread_sp1.xml"/>
  <idPkg:Story src="Stories/Story_u10.xml"/>
</Document>"#,
        deflated,
    );
    file(
        "Spreads/Spread_sp1.xml",
        r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Spread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <Spread Self="sp1">
    <Page Self="p1" GeometricBounds="0 0 144 252"/>
    <TextFrame Self="headline" ParentStory="u10" GeometricBounds="12 24 26 180" StrokeWeight="0"/>
  </Spread>
</idPkg:Spread>"#,
        deflated,
    );
    file(
        "Stories/Story_u10.xml",
        r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Story xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <Story Self="u10">
    <ParagraphStyleRange>
      <CharacterStyleRange AppliedFont="Inter" PointSize="12">
        <Content>NORTHWIND PRINT</Content>
      </CharacterStyleRange>
    </ParagraphStyleRange>
  </Story>
</idPkg:Story>"#,
        deflated,
    );
    zip.finish().unwrap().into_inner()
}

/// Inter's I (font units): x 180 .. 370, y 0 .. 1490.
fn is_inter_i(segments: &[PathSegment]) -> bool {
    matches!(
        segments,
        [
            PathSegment::MoveTo { x: 180.0, y: 0.0 },
            PathSegment::LineTo { x: 370.0, y: 0.0 },
            PathSegment::LineTo {
                x: 370.0,
                y: 1490.0
            },
            PathSegment::LineTo {
                x: 180.0,
                y: 1490.0
            },
            PathSegment::Close,
        ]
    )
}

#[test]
fn both_is_of_the_cards_headline_keep_their_stem() {
    let document = idml_import::import_idml_doc(&card_idml()).unwrap();
    let mut resolver = BytesResolver::new();
    resolver.add_font("Inter", None, inter());
    // The editor's build: no glyph-run table.
    let opts = PipelineOptions {
        assets: Some(&resolver),
        ..PipelineOptions::default()
    };
    assert!(!opts.collect_glyph_runs);
    // The editor's still: 335 % on a 2× screen.
    let px_per_pt = 3.35 * 2.0;
    let (built, images) =
        pipeline::render_document(&document, &opts, 72.0 * px_per_pt, Color::WHITE).unwrap();
    let list = &built.pages[0].list;
    assert!(list.glyph_runs.is_none());

    // The headline's fourteen glyphs are filled from glyph outlines, the
    // I's among them.
    let glyphs: Vec<_> = list
        .commands
        .iter()
        .filter_map(|c| match c {
            DisplayCommand::FillPath {
                path_id, transform, ..
            } if list.paths.is_glyph(*path_id) => Some((*path_id, *transform)),
            _ => None,
        })
        .collect();
    assert_eq!(glyphs.len(), 14, "NORTHWIND PRINT, its space unfilled");

    // The two I's, measured: the coverage summed along the row through
    // the middle of each stem is its width in device pixels.
    let is: Vec<_> = glyphs
        .iter()
        .filter(|(id, _)| is_inter_i(&list.paths.get(*id).unwrap().segments))
        .map(|(_, t)| t.0)
        .collect();
    assert_eq!(is.len(), 2, "NORTHWIND's I and PRINT's");
    let img = &images[0];
    let widths: Vec<f32> = is
        .iter()
        .map(|[a, _, _, d, e, f]| {
            let left = (e + a * 180.0) * px_per_pt;
            let right = (e + a * 370.0) * px_per_pt;
            let row = ((f + d * 745.0) * px_per_pt) as u32;
            (left.floor() as u32 - 3..right.ceil() as u32 + 3)
                .map(|x| (255.0 - img.get_pixel(x, row).0[0] as f32) / 255.0)
                .sum()
        })
        .collect();
    let stem = 190.0 * 12.0 / 2048.0 * px_per_pt;
    for (w, word) in widths.iter().zip(["NORTHWIND", "PRINT"]) {
        assert!(
            (w - stem).abs() < 0.1,
            "{word}'s I is {w:.3} px wide, Inter's stem {stem:.3} px ({widths:?})"
        );
    }
}

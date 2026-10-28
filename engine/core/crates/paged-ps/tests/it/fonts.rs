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

//! Text: a Type 1 font built here (eexec, charstrings, Subrs), a Type 3
//! font, a Type 42 font, the show family, and the substitute face for a
//! font the program does not define.

use std::sync::Arc;

use crate::{bbox, eps, eps_bytes, fills, near, run};
use paged_ps::type1_build::{encode, encrypt, CsItem::*, CHARSTRING_KEY, EEXEC_KEY};
use paged_ps::{Element, Face, FontProvider, Options};

const INTER: &[u8] = include_bytes!("../../../../corpus/fonts/Inter.ttf");

/// An encrypted charstring with its four lead bytes.
fn cs(items: &[paged_ps::type1_build::CsItem]) -> Vec<u8> {
    let mut plain = vec![1, 2, 3, 4];
    plain.extend(encode(items));
    encrypt(&plain, CHARSTRING_KEY)
}

fn rd(name: &str, data: &[u8]) -> Vec<u8> {
    let mut v = format!("{name} {} RD ", data.len()).into_bytes();
    v.extend_from_slice(data);
    v
}

/// A Type 1 font: A is a 400 × 700 box at x 100 with width 600 (its
/// closepath in Subr 0), B a curved shape of width 500.
fn type1_font(hex: bool) -> Vec<u8> {
    let a = cs(&[
        N(0),
        N(600),
        Op(13),
        N(100),
        N(0),
        Op(21),
        N(400),
        Op(6),
        N(700),
        Op(7),
        N(-400),
        Op(6),
        N(0),
        Op(10),
        Op(14),
    ]);
    let b = cs(&[
        N(0),
        N(500),
        Op(13),
        N(50),
        N(0),
        Op(21),
        N(100),
        N(300),
        N(200),
        N(300),
        N(100),
        N(-600),
        Op(8),
        Op(9),
        Op(14),
    ]);
    let notdef = cs(&[N(0), N(250), Op(13), Op(14)]);
    let subr = cs(&[Op(9), Op(11)]);
    let mut private = b"dup /Private 8 dict dup begin
/RD{string currentfile exch readstring pop}executeonly def
/ND{noaccess def}executeonly def
/NP{noaccess put}executeonly def
/lenIV 4 def
/Subrs 1 array
"
    .to_vec();
    private.extend(rd("dup 0", &subr));
    private.extend_from_slice(b" NP\nND\n2 index /CharStrings 3 dict dup begin\n");
    for (n, g) in [("/.notdef", &notdef), ("/A", &a), ("/B", &b)] {
        private.extend(rd(n, g));
        private.extend_from_slice(b" ND\n");
    }
    private.extend_from_slice(b"end\nend\nreadonly put\nnoaccess put\ndup /FontName get exch definefont pop\nmark currentfile closefile\n");
    let mut plain = vec![9, 8, 7, 6];
    plain.extend(private);
    let enc = encrypt(&plain, EEXEC_KEY);
    let mut font = b"%!PS-AdobeFont-1.0: TestFont 001
12 dict begin
/FontName /TestFont def
/FontType 1 def
/PaintType 0 def
/FontMatrix [0.001 0 0 0.001 0 0] readonly def
/FontBBox {0 0 1000 1000} readonly def
/Encoding 256 array 0 1 255 {1 index exch /.notdef put} for dup 65 /A put dup 66 /B put readonly def
currentdict end
currentfile eexec
"
    .to_vec();
    if hex {
        for line in enc.chunks(32) {
            font.extend(
                line.iter()
                    .map(|v| format!("{v:02x}"))
                    .collect::<String>()
                    .into_bytes(),
            );
            font.push(b'\n');
        }
    } else {
        font.extend(enc);
    }
    font.push(b'\n');
    for _ in 0..8 {
        font.extend_from_slice(&[b'0'; 64]);
        font.push(b'\n');
    }
    font.extend_from_slice(b"cleartomark\n");
    font
}

#[test]
fn a_type1_font_built_here_draws_its_outlines__feat__images_graphics_eps_postscript() {
    for hex in [true, false] {
        let mut body = type1_font(hex);
        body.extend_from_slice(
            b"/TestFont findfont 10 scalefont setfont 1 0 0 setrgbcolor 10 20 moveto (AB) show\n",
        );
        body.extend_from_slice(b"/TestFont findfont 10 scalefont setfont (AB) stringwidth 50 50 moveto rlineto stroke\n");
        let art = paged_ps::interpret(&eps_bytes(&body), &Options::default()).unwrap();
        let f = fills(&art);
        assert_eq!(f.len(), 2, "hex {hex}");
        let Element::Fill { path, paint, .. } = f[0] else {
            unreachable!()
        };
        assert!(
            near(bbox(path), [11.0, 20.0, 15.0, 27.0], 1e-9),
            "{:?}",
            bbox(path)
        );
        assert_eq!(paint.color, paged_ps::Color::Rgb([1.0, 0.0, 0.0]));
        // B starts after A's advance (6).
        let Element::Fill { path, .. } = f[1] else {
            unreachable!()
        };
        assert!((bbox(path)[0] - 16.5).abs() < 1e-9);
        // stringwidth: (600 + 500) / 1000 * 10.
        let Some(Element::Stroke { path, .. }) = art
            .elements
            .iter()
            .find(|e| matches!(e, Element::Stroke { .. }))
        else {
            panic!()
        };
        assert!(near(bbox(path), [50.0, 50.0, 61.0, 50.0], 1e-9));
    }
}

const TYPE3: &str = "8 dict begin /FontType 3 def /FontMatrix [0.001 0 0 0.001 0 0] def /FontBBox [0 0 1000 1000] def
  /Encoding 256 array def 0 1 255 {Encoding exch /.notdef put} for Encoding 65 /square put Encoding 66 /bar put
  /BuildChar { 1000 0 0 0 1000 1000 setcachedevice exch pop 66 eq { 0 0 100 1000 } { 0 0 1000 1000 } ifelse
               0 1 0 setrgbcolor rectfill } def
  currentdict end /T3 exch definefont pop
  /T3 findfont 12 scalefont setfont ";

#[test]
fn a_type3_font_runs_its_buildchar_per_glyph() {
    let art = run(&format!("{TYPE3} 0 0 moveto (AAB) show"));
    let f = fills(&art);
    assert_eq!(f.len(), 3);
    let b: Vec<[f64; 4]> = f
        .iter()
        .map(|e| match e {
            Element::Fill { path, .. } => bbox(path),
            _ => unreachable!(),
        })
        .collect();
    assert!(near(b[0], [0.0, 0.0, 12.0, 12.0], 1e-9));
    assert!(near(b[1], [12.0, 0.0, 24.0, 12.0], 1e-9));
    assert!(near(b[2], [24.0, 0.0, 25.2, 12.0], 1e-9));
    // After setcachedevice the glyph's colour operators are ignored.
    assert!(f.iter().all(
        |e| matches!(e, Element::Fill { paint, .. } if paint.color == paged_ps::Color::Gray(0.0))
    ));

    let glyph = "8 dict begin /FontType 3 def /FontMatrix [1 0 0 1 0 0] def /FontBBox [0 0 1 1] def
      /Encoding StandardEncoding def /BuildGlyph { exch pop /A eq { 1 0 setcharwidth 0 0 1 1 rectfill } { 2 0 setcharwidth } ifelse } def
      currentdict end /G exch definefont pop /G findfont 10 scalefont setfont 0 0 moveto (AzA) show";
    let f = fills(&run(glyph)).len();
    assert_eq!(f, 2);
}

#[test]
fn the_show_family_places_glyphs() {
    let pos = |body: &str| -> Vec<f64> {
        fills(&run(&format!("{TYPE3} 0 0 moveto {body}")))
            .iter()
            .map(|e| match e {
                Element::Fill { path, .. } => bbox(path)[0],
                _ => unreachable!(),
            })
            .collect()
    };
    assert_eq!(pos("1 0 (AA) ashow"), [0.0, 13.0]);
    assert_eq!(pos("5 0 65 (AAB) widthshow"), [0.0, 17.0, 34.0]);
    assert_eq!(pos("(AA) [20 0] xshow"), [0.0, 20.0]);
    assert_eq!(pos("{pop pop 3 0 rmoveto} (AA) kshow"), [0.0, 15.0]);
    assert_eq!(pos("{pop pop pop} (AA) cshow"), Vec::<f64>::new());
    assert_eq!(pos("/square glyphshow"), [0.0]);
    let w = crate::run(&format!(
        "{TYPE3} (AB) stringwidth 1 index 0 moveto 10 10 rlineto pop pop stroke"
    ));
    let Some(Element::Stroke { path, .. }) = w
        .elements
        .iter()
        .find(|e| matches!(e, Element::Stroke { .. }))
    else {
        panic!()
    };
    assert!(near(bbox(path), [24.0, 0.0, 34.0, 10.0], 1e-9));
}

struct Inter;
impl FontProvider for Inter {
    fn face(&self, _name: &str) -> Option<Face> {
        Some(Face {
            data: Arc::from(INTER),
            index: 0,
            name: "Inter".into(),
        })
    }
}

#[test]
fn a_font_that_is_not_embedded_is_drawn_in_the_substitute_and_reported() {
    let body = "/Helvetica-Bold findfont 20 scalefont setfont 10 10 moveto (H) show";
    let art = paged_ps::interpret(
        &eps(body),
        &Options {
            fonts: Some(&Inter),
            ..Options::default()
        },
    )
    .unwrap();
    assert_eq!(
        art.report.substituted_fonts,
        [("Helvetica-Bold".to_string(), Some("Inter".to_string()))]
    );
    let f = fills(&art);
    assert_eq!(f.len(), 1);
    let Element::Fill { path, .. } = f[0] else {
        unreachable!()
    };
    let b = bbox(path);
    // An H about 0.7 em tall at 20 pt from the baseline at 10.
    assert!(
        b[1] > 9.0 && b[1] < 11.0 && b[3] > 20.0 && b[3] < 30.0,
        "{b:?}"
    );

    // A reencoded copy keeps its face.
    let reencode = "/Helvetica findfont dup length dict begin {1 index /FID ne {def} {pop pop} ifelse} forall
                    /Encoding ISOLatin1Encoding def currentdict end /Helvetica-L1 exch definefont pop
                    /Helvetica-L1 findfont 10 scalefont setfont 0 0 moveto (\\351) show";
    let art = paged_ps::interpret(
        &eps(reencode),
        &Options {
            fonts: Some(&Inter),
            ..Options::default()
        },
    )
    .unwrap();
    assert_eq!(fills(&art).len(), 1, "é from the substitute");

    // No face at all: nothing drawn, reported with none.
    let art = paged_ps::interpret(&eps(body), &Options::default()).unwrap();
    assert!(fills(&art).is_empty());
    assert_eq!(art.report.substituted_fonts[0].1, None);
}

#[test]
fn a_type42_font_draws_from_its_sfnts() {
    let face = ttf_parser::Face::parse(INTER, 0).unwrap();
    let gid = face.glyph_index('A').unwrap().0;
    let adv = face.glyph_hor_advance(ttf_parser::GlyphId(gid)).unwrap() as f64
        / face.units_per_em() as f64;
    let hex: String = INTER.iter().map(|b| format!("{b:02x}")).collect();
    let body = format!(
        "10 dict begin /FontName /T42 def /FontType 42 def /FontMatrix [1 0 0 1 0 0] def /FontBBox [0 0 1 1] def
         /Encoding StandardEncoding def /PaintType 0 def
         /CharStrings << /.notdef 0 /A {gid} >> def /sfnts [<{hex}>] def
         currentdict end /T42 exch definefont pop
         /T42 findfont 10 scalefont setfont 0 0 moveto (A) show (A) stringwidth pop 0 moveto 0 5 rlineto stroke"
    );
    let art = run(&body);
    assert_eq!(fills(&art).len(), 1);
    let Some(Element::Stroke { path, .. }) = art
        .elements
        .iter()
        .find(|e| matches!(e, Element::Stroke { .. }))
    else {
        panic!()
    };
    assert!((bbox(path)[0] - adv * 10.0).abs() < 1e-6);
}

#[test]
fn charpath_appends_outlines_for_a_clip_or_a_stroke() {
    let mut body = type1_font(true);
    body.extend_from_slice(b"/TestFont findfont 100 scalefont setfont newpath 0 0 moveto (A) false charpath clip 0 0 100 100 rectfill\n");
    let art = paged_ps::interpret(&eps_bytes(&body), &Options::default()).unwrap();
    let Element::PushClip { path, .. } = &art.elements[0] else {
        panic!("{:?}", art.elements)
    };
    assert!(near(bbox(path), [10.0, 0.0, 50.0, 70.0], 1e-9));
}

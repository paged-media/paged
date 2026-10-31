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

//! Paths, painting, clipping, colour spaces, shadings, forms, patterns
//! and DSC.

use crate::{bbox, eps, fills, near, run};
use paged_ps::{Color, Element, FillRule, GradientKind, LineCap, Options};

#[test]
fn shapes_fill_stroke_and_the_fill_rule__feat__images_graphics_eps_postscript() {
    let art = run("1 0 0 setrgbcolor 10 10 30 20 rectfill
         newpath 0 0 moveto 50 0 lineto 50 50 lineto closepath 0 setgray eofill
         0 0 1 setrgbcolor 3 setlinewidth 1 setlinecap [4 2] 0 setdash
         newpath 10 90 moveto 90 90 lineto stroke");
    let f = fills(&art);
    assert_eq!(f.len(), 2);
    let Element::Fill { path, rule, paint } = f[0] else {
        unreachable!()
    };
    assert_eq!(*rule, FillRule::NonZero);
    assert_eq!(paint.color, Color::Rgb([1.0, 0.0, 0.0]));
    assert!(near(bbox(path), [10.0, 10.0, 40.0, 30.0], 1e-9));
    assert!(matches!(
        f[1],
        Element::Fill {
            rule: FillRule::EvenOdd,
            ..
        }
    ));
    let stroke = art.elements.iter().find_map(|e| match e {
        Element::Stroke { style, paint, .. } => Some((style, paint)),
        _ => None,
    });
    let (style, paint) = stroke.unwrap();
    assert_eq!(
        (style.width, style.cap, style.dash.clone()),
        (3.0, LineCap::Round, vec![4.0, 2.0])
    );
    assert_eq!(paint.color, Color::Rgb([0.0, 0.0, 1.0]));
}

#[test]
fn the_ctm_places_paths_and_scales_the_pen() {
    let art = run("gsave 50 50 translate 2 2 scale 0 0 10 10 rectfill grestore
                   gsave 2 1 scale 1 setlinewidth newpath 0 0 moveto 10 0 lineto stroke grestore");
    let Element::Fill { path, .. } = fills(&art)[0] else {
        unreachable!()
    };
    assert!(near(bbox(path), [50.0, 50.0, 70.0, 70.0], 1e-9));
    // A stroke is kept in its user space with the CTM beside it.
    let Some(Element::Stroke {
        path,
        transform,
        style,
        ..
    }) = art
        .elements
        .iter()
        .find(|e| matches!(e, Element::Stroke { .. }))
    else {
        panic!()
    };
    assert!(near(bbox(path), [0.0, 0.0, 10.0, 0.0], 1e-9));
    assert_eq!(transform.as_coeffs()[0], 2.0);
    assert_eq!(style.width, 1.0);
}

#[test]
fn arcs_are_circles() {
    let art = run("newpath 50 50 20 0 360 arc fill
                   newpath 10 10 moveto 50 10 90 10 10 arct 90 90 lineto stroke
                   newpath 50 50 10 90 0 arcn 0 0 lineto fill");
    let Element::Fill { path, .. } = fills(&art)[0] else {
        unreachable!()
    };
    assert!(near(bbox(path), [30.0, 30.0, 70.0, 70.0], 0.01));
    assert_eq!(fills(&art).len(), 2);
}

#[test]
fn clipping_is_pushed_once_and_popped_by_grestore() {
    let art = run(
        "gsave newpath 0 0 50 50 rectclip 0 0 100 100 rectfill 10 10 5 5 rectfill grestore
                   gsave 0 0 1 1 rectclip grestore
                   20 20 5 5 rectfill",
    );
    let kinds: Vec<&str> = art
        .elements
        .iter()
        .map(|e| match e {
            Element::PushClip { .. } => "push",
            Element::PopClip => "pop",
            Element::Fill { .. } => "fill",
            _ => "other",
        })
        .collect();
    // The clip that paints nothing is never written.
    assert_eq!(kinds, ["push", "fill", "fill", "pop", "fill"]);
    let art =
        run("newpath 0 0 moveto 100 0 lineto 100 100 lineto closepath eoclip 0 0 100 100 rectfill");
    assert!(matches!(
        art.elements[0],
        Element::PushClip {
            rule: FillRule::EvenOdd,
            ..
        }
    ));
    assert!(matches!(art.elements.last(), Some(Element::PopClip)));
}

#[test]
fn separation_indexed_and_devicen_colours_go_to_their_alternate() {
    let art = run("[/Separation /Gold /DeviceCMYK {dup 0.2 mul exch 0 exch 0}] setcolorspace
                   0.5 setcolor 0 0 10 10 rectfill
                   [/Separation /None /DeviceGray {pop 0}] setcolorspace 1 setcolor 0 0 10 10 rectfill
                   [/Indexed /DeviceRGB 1 <ff0000 00ff00>] setcolorspace 1 setcolor 0 0 10 10 rectfill
                   [/DeviceN [/A /B] /DeviceGray {add 2 div}] setcolorspace 1 0 setcolor 0 0 10 10 rectfill
                   [/ICCBased << /N 4 >>] setcolorspace 0 0 0 1 setcolor 0 0 10 10 rectfill
                   0.5 0 0 setrgbcolor currentgray 0 0 0.5 0.5 sethsbcolor currentrgbcolor pop pop pop pop");
    let paints: Vec<_> = fills(&art)
        .iter()
        .map(|e| match e {
            Element::Fill { paint, .. } => paint.clone(),
            _ => unreachable!(),
        })
        .collect();
    assert_eq!(paints.len(), 4, "the /None separation paints nothing");
    assert_eq!(paints[0].color, Color::Cmyk([0.1, 0.0, 0.5, 0.0]));
    assert_eq!(paints[0].separation.as_deref(), Some("Gold"));
    assert_eq!(paints[1].color, Color::Rgb([0.0, 1.0, 0.0]));
    assert_eq!(paints[2].color, Color::Gray(0.5));
    assert_eq!(paints[3].color, Color::Cmyk([0.0, 0.0, 0.0, 1.0]));
}

#[test]
fn shadings_become_gradients_or_sampled_images() {
    let axial = "<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 0 100 0]
                    /Function << /FunctionType 2 /Domain [0 1] /C0 [1 0 0] /C1 [0 0 1] /N 1 >> >> shfill";
    let art = run(axial);
    // Unextended: a band clip around the gradient.
    assert!(matches!(art.elements[0], Element::PushClip { .. }));
    let Element::Gradient(g) = &art.elements[1] else {
        panic!("{:?}", art.elements)
    };
    assert!(matches!(g.kind, GradientKind::Axial { x1, .. } if x1 == 100.0));
    assert_eq!(g.stops.first().unwrap().1, Color::Rgb([1.0, 0.0, 0.0]));
    assert_eq!(g.stops.last().unwrap().1, Color::Rgb([0.0, 0.0, 1.0]));
    let mid = g.stops[g.stops.len() / 2].1;
    assert_eq!(mid, Color::Rgb([0.5, 0.0, 0.5]));

    let radial = "<< /ShadingType 3 /ColorSpace /DeviceGray /Coords [50 50 0 50 50 40] /Extend [true true]
                     /Function << /FunctionType 3 /Domain [0 1] /Bounds [0.5] /Encode [0 1 0 1]
                       /Functions [<< /FunctionType 2 /Domain [0 1] /C0 [0] /C1 [1] /N 1 >>
                                   << /FunctionType 0 /Domain [0 1] /Range [0 1] /Size [2] /BitsPerSample 8 /DataSource <ff00> >>] >> >> shfill";
    let art = run(radial);
    let Element::Gradient(g) = &art.elements[0] else {
        panic!("{:?}", art.elements)
    };
    assert!(matches!(g.kind, GradientKind::Radial { r1, .. } if r1 == 40.0));

    let offset = "<< /ShadingType 3 /ColorSpace /DeviceGray /Coords [30 30 5 60 60 30]
                     /Function << /FunctionType 2 /Domain [0 1] /C0 [0] /C1 [1] /N 1 >> >> shfill";
    let art = run(offset);
    assert!(art
        .elements
        .iter()
        .any(|e| matches!(e, Element::Image(i) if i.alpha.is_some())));

    let function_based =
        "<< /ShadingType 1 /ColorSpace /DeviceRGB /Domain [0 1 0 1] /Matrix [50 0 0 50 0 0]
                     /Function {pop 0 0} >> shfill";
    let art = run(function_based);
    let Some(Element::Image(img)) = art.elements.iter().find(|e| matches!(e, Element::Image(_)))
    else {
        panic!()
    };
    assert_eq!((img.width, img.height), (50, 50));

    let mesh = run("<< /ShadingType 4 /ColorSpace /DeviceGray >> shfill");
    assert!(mesh.elements.is_empty());
    assert!(mesh
        .report
        .unsupported
        .iter()
        .any(|u| u == "shading type 4"));
}

#[test]
fn shading_and_tiling_patterns_fill_through_a_clip() {
    let art = run("<< /PatternType 2 /Shading << /ShadingType 2 /ColorSpace /DeviceGray /Coords [0 0 10 0] /Extend [true true]
                    /Function << /FunctionType 2 /Domain [0 1] /C0 [0] /C1 [1] /N 1 >> >> >> matrix makepattern setpattern
                   0 0 50 50 rectfill");
    assert!(matches!(art.elements[0], Element::PushClip { .. }));
    assert!(art
        .elements
        .iter()
        .any(|e| matches!(e, Element::Gradient(_))));

    let art = run(
        "<< /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 10 10] /XStep 10 /YStep 10
                    /PaintProc { pop 0 0 5 5 rectfill } >> matrix makepattern setpattern
                   0 0 30 20 rectfill",
    );
    let cells = fills(&art).len();
    assert!((6..=20).contains(&cells), "{cells} cells for a 3 x 2 area");

    // Uncoloured: the PaintProc's own colours are ignored, the
    // setpattern colour paints.
    let art = run(
        "<< /PatternType 1 /PaintType 2 /TilingType 1 /BBox [0 0 10 10] /XStep 10 /YStep 10
                    /PaintProc { pop 1 0 0 setrgbcolor 0 0 5 5 rectfill } >> matrix makepattern
                   [/Pattern /DeviceGray] setcolorspace 0.25 exch setcolor 0 0 10 10 rectfill",
    );
    assert!(fills(&art)
        .iter()
        .all(|e| matches!(e, Element::Fill { paint, .. } if paint.color == Color::Gray(0.25))));
}

#[test]
fn forms_strokepath_and_path_queries() {
    let art = run("<< /FormType 1 /BBox [0 0 10 10] /Matrix [1 0 0 1 20 20] /PaintProc { pop 0 0 50 50 rectfill } >> execform");
    assert!(matches!(art.elements[0], Element::PushClip { .. }));
    let Element::Fill { path, .. } = fills(&art)[0] else {
        unreachable!()
    };
    assert!(
        near(bbox(path), [20.0, 20.0, 70.0, 70.0], 1e-9),
        "{:?}",
        bbox(path)
    );

    let art = run("4 setlinewidth newpath 10 50 moveto 90 50 lineto strokepath fill");
    let Element::Fill { path, .. } = fills(&art)[0] else {
        unreachable!()
    };
    assert!(near(bbox(path), [10.0, 48.0, 90.0, 52.0], 0.05));

    let art = run("newpath 10 20 moveto 30 40 lineto pathbbox 4 { pop } repeat
                   newpath 0 0 moveto 10 0 lineto 10 10 lineto reversepath fill");
    assert_eq!(fills(&art).len(), 1);
}

#[test]
fn dsc_boxes_and_the_dos_binary_form() {
    let hires = b"%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 11 21\n%%HiResBoundingBox: 0.5 0.25 10.5 20.75\n%%EndComments\n0 0 1 1 rectfill\n";
    let art = paged_ps::interpret(hires, &Options::default()).unwrap();
    assert_eq!(art.bbox, [0.5, 0.25, 10.5, 20.75]);
    assert!(!art.report.bbox_from_content);

    let none = b"%!PS-Adobe-3.0\n5 6 10 10 rectfill\n";
    let art = paged_ps::interpret(none, &Options::default()).unwrap();
    assert_eq!(art.bbox, [5.0, 6.0, 15.0, 16.0]);
    assert!(art.report.bbox_from_content);

    let ps = eps("0 0 10 10 rectfill");
    let mut dos = paged_ps::dsc::DOS_MAGIC.to_vec();
    dos.extend_from_slice(&30u32.to_le_bytes());
    dos.extend_from_slice(&(ps.len() as u32).to_le_bytes());
    dos.extend_from_slice(&[0; 18]);
    dos.extend_from_slice(&ps);
    dos.extend_from_slice(b"TIFF preview bytes would follow");
    let art = paged_ps::interpret(&dos, &Options::default()).unwrap();
    assert_eq!(fills(&art).len(), 1);
    assert_eq!(
        paged_ps::dsc(&dos).unwrap().bbox,
        Some([0.0, 0.0, 100.0, 100.0])
    );

    // Binary data inside %%BeginBinary is read by the program, not the
    // comment reader.
    let section: &[u8] =
        b"currentfile 4 string readstring \xff\x00%%\npop pop\n%%BoundingBox: 9 9 9 9\n";
    let mut bin = format!(
        "%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: (atend)\n%%EndComments\n%%BeginBinary: {}\n",
        section.len()
    )
    .into_bytes();
    bin.extend_from_slice(section);
    bin.extend_from_slice(b"%%EndBinary\n0 0 5 5 rectfill\n%%Trailer\n%%BoundingBox: 0 0 5 5\n");
    let art = paged_ps::interpret(&bin, &Options::default()).unwrap();
    assert_eq!(art.bbox, [0.0, 0.0, 5.0, 5.0]);
    assert_eq!(fills(&art).len(), 1);
}

#[test]
fn an_uncaught_error_is_named_and_a_caught_one_is_not() {
    let r = paged_ps::interpret(&eps("1 2 nosuchop"), &Options::default());
    assert_eq!(
        r.unwrap_err(),
        paged_ps::Error::PostScript {
            error: "undefined".into(),
            command: "nosuchop".into()
        }
    );
    let r = paged_ps::interpret(&eps("1 (x) add"), &Options::default());
    assert!(
        matches!(r, Err(paged_ps::Error::PostScript { ref error, ref command }) if error == "typecheck" && command == "add")
    );
    let art = run("{ nosuchop } stopped pop 0 0 1 1 rectfill showpage");
    assert_eq!(fills(&art).len(), 1);
    assert_eq!(
        paged_ps::interpret(b"GIF89a", &Options::default()).unwrap_err(),
        paged_ps::Error::NotPostScript
    );
}

#[test]
fn a_typical_procset_with_bind_load_and_save_runs() {
    // The shape of an Illustrator/Freehand-style prolog: a dictionary of
    // bound abbreviations, a save around the page, showpage at the end.
    let art = run("/md 20 dict def md begin
                   /m {moveto} bind def /l {lineto} bind def /c {curveto} bind def /h {closepath} bind def
                   /f {fill} bind def /k {setcmykcolor} bind def
                   end
                   /pagesave save def md begin
                   0 0 0 1 k 10 10 m 90 10 l 90 90 l 50 95 10 90 10 90 c h f
                   end pagesave restore showpage");
    let Element::Fill { paint, .. } = fills(&art)[0] else {
        unreachable!()
    };
    assert_eq!(paint.color, Color::Cmyk([0.0, 0.0, 0.0, 1.0]));
}

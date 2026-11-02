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

//! Engine ADR 1045 (amendment 2026-11-02) — an anchored picture takes a
//! crop. The lowering of Word's `a:srcRect` places the picture with
//! `insertAnchoredFrame` and then sets `imageContentTransform` on the
//! frame, exactly as slide's pictures place theirs on a free rectangle.
//! The proof is the display list: the part of the picture the frame
//! shows, found by taking the frame's clip back through the picture's
//! placement, is the middle half for `l = r = 25%`, and is the same for
//! the anchored frame and for a free rectangle with the same placement.

use std::io::{Cursor, Write};

use base64::Engine as _;
use paged_canvas::{
    channel::{ByteBuf, Mutation},
    CanvasModel, CanvasOptions, PageId,
};
use paged_compose::DisplayCommand;
use paged_mutate::{PropertyPath, Value};
use paged_wire::ElementId;

/// The picture's natural size in pixels.
const PX_W: f32 = 100.0;
const PX_H: f32 = 40.0;
/// The cropped picture's size on the page (`wp:extent`), in points.
const W: f32 = 60.0;
const H: f32 = 24.0;

fn png() -> Vec<u8> {
    let img = image::RgbaImage::from_fn(PX_W as u32, PX_H as u32, |x, _| {
        image::Rgba([(x * 2) as u8, 40, 200, 255])
    });
    let mut out = Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageFormat::Png)
        .expect("encode png");
    out.into_inner()
}

fn data_uri() -> String {
    format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(png())
    )
}

fn idml() -> Vec<u8> {
    let mut buf = Vec::new();
    {
        let mut zip = zip::ZipWriter::new(Cursor::new(&mut buf));
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        let mut put = |name: &str, body: &[u8]| {
            zip.start_file(name, opts).unwrap();
            zip.write_all(body).unwrap();
        };
        put("mimetype", b"application/vnd.adobe.indesign-idml-package");
        put(
            "designmap.xml",
            br#"<?xml version="1.0" encoding="UTF-8"?>
<Document DOMVersion="13.1" Self="d1">
<idPkg:Graphic src="Resources/Graphic.xml" xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"/>
<idPkg:Spread src="Spreads/Spread_s1.xml" xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"/>
<idPkg:Story src="Stories/Story_st1.xml" xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"/>
</Document>"#,
        );
        put(
            "Resources/Graphic.xml",
            br#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Graphic xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <Color Self="Color/Black" Model="Process" Space="CMYK" ColorValue="0 0 0 100" Name="Black"/>
</idPkg:Graphic>"#,
        );
        put(
            "Spreads/Spread_s1.xml",
            br#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Spread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="13.1">
<Spread Self="s1" PageCount="1">
<Page Self="p1" Name="1" GeometricBounds="0 0 792 612" ItemTransform="1 0 0 1 0 0"/>
<TextFrame Self="tf1" ParentStory="st1" GeometricBounds="72 72 600 540" ItemTransform="1 0 0 1 0 0"/>
</Spread></idPkg:Spread>"#,
        );
        put(
            "Stories/Story_st1.xml",
            br#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Story xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="13.1">
<Story Self="st1"><ParagraphStyleRange><CharacterStyleRange>
<Content>Hello world</Content>
</CharacterStyleRange></ParagraphStyleRange></Story></idPkg:Story>"#,
        );
        zip.finish().unwrap();
    }
    buf
}

fn load() -> CanvasModel {
    CanvasModel::load(
        "anchored-crop",
        &idml(),
        CanvasOptions {
            fonts: vec![include_bytes!("../../../../corpus/fonts/Inter.ttf").to_vec()],
            ..CanvasOptions::default()
        },
    )
    .expect("load")
}

/// What a crop of `l`, `t`, `r`, `b` (fractions of the picture) is as
/// the picture's placement in a frame of `W` x `H` points: the picture
/// is shown at `W / (1 - l - r)` by `H / (1 - t - b)` with its top left
/// corner `l` and `t` of that outside the frame (the mapping slide's
/// pictures use).
fn crop_placement(l: f32, t: f32, r: f32, b: f32) -> [f32; 6] {
    let disp_w = W / (1.0 - l - r);
    let disp_h = H / (1.0 - t - b);
    [
        disp_w / PX_W,
        0.0,
        0.0,
        disp_h / PX_H,
        -l * disp_w,
        -t * disp_h,
    ]
}

/// The part of the picture the first drawn picture shows, as fractions
/// of its width and height `(x0, y0, x1, y1)`: the clip in force, taken
/// back through the picture's placement on the page.
fn visible(m: &CanvasModel) -> (f32, f32, f32, f32) {
    let page = PageId(m.pages()[0].self_id.clone());
    let list = m.display_list_for_page(&page).expect("display list");
    let at = list
        .commands
        .iter()
        .position(|c| matches!(c, DisplayCommand::Image { .. }))
        .expect("a picture is drawn");
    let DisplayCommand::Image { transform: img, .. } = &list.commands[at] else {
        unreachable!()
    };
    let clip = list.commands[..at]
        .iter()
        .rev()
        .find_map(|c| match c {
            DisplayCommand::PushClip { transform, .. } => Some(transform.0),
            _ => None,
        })
        .expect("the frame clips its picture");
    // Both are axis-aligned: x' = a x + e, y' = d y + f.
    let (ia, id, ie, if_) = (img.0[0], img.0[3], img.0[4], img.0[5]);
    let (ca, cd, ce, cf) = (clip[0], clip[3], clip[4], clip[5]);
    (
        (ce - ie) / ia,
        (cf - if_) / id,
        (ce + ca - ie) / ia,
        (cf + cd - if_) / id,
    )
}

fn close(got: (f32, f32, f32, f32), want: (f32, f32, f32, f32)) {
    let eq = |a: f32, b: f32| (a - b).abs() < 1e-3;
    assert!(
        eq(got.0, want.0) && eq(got.1, want.1) && eq(got.2, want.2) && eq(got.3, want.3),
        "visible region {got:?}, expected {want:?}"
    );
}

fn anchored(m: &mut CanvasModel, crop: Option<[f32; 6]>) -> ElementId {
    let mut ops = vec![
        Mutation::InsertAnchoredFrame {
            paragraph: None,
            story_id: "st1".into(),
            offset: 0,
            width: W,
            height: H,
            image_uri: Some(data_uri()),
            kind: None,
            layout: None,
            cell: None,
        },
        Mutation::BindCreated {
            handle: "pic".into(),
        },
    ];
    if let Some(t) = crop {
        ops.push(Mutation::SetElementProperty {
            element_id: ElementId::Rectangle("$h:pic".into()),
            path: PropertyPath::ImageContentTransform,
            value: Value::Transform(Some(t)),
        });
    }
    m.apply_mutation(&Mutation::Batch { ops }).expect("batch");
    let id = m.scene().stories[0].story.paragraphs[0].anchored_frames[0]
        .self_id
        .clone()
        .expect("the frame has an id");
    ElementId::Rectangle(id)
}

fn free(m: &mut CanvasModel, crop: [f32; 6]) {
    // A free rectangle's inner coordinates are the page's: its box starts
    // at (100, 100), so the placement does too. (An anchored frame's box
    // starts at (0, 0); the renderer moves it with the frame.)
    let crop = [
        crop[0],
        crop[1],
        crop[2],
        crop[3],
        crop[4] + 100.0,
        crop[5] + 100.0,
    ];
    let page_id = PageId(m.pages()[0].self_id.clone());
    let id = m
        .apply_mutation(&Mutation::InsertFrame {
            page_id,
            bounds: (100.0, 100.0, 100.0 + H, 100.0 + W),
        })
        .expect("insert")
        .created_id
        .expect("created");
    m.apply_mutation(&Mutation::ReplaceImageBytes {
        element_id: id.raw_id().to_string(),
        bytes: Some(ByteBuf(png())),
    })
    .expect("image");
    m.apply_mutation(&Mutation::SetElementProperty {
        element_id: id,
        path: PropertyPath::ImageContentTransform,
        value: Value::Transform(Some(crop)),
    })
    .expect("placement");
}

#[test]
fn an_anchored_picture_shows_the_middle_half_for_a_25_percent_crop_each_side() {
    let t = crop_placement(0.25, 0.0, 0.25, 0.0);
    let mut m = load();
    anchored(&mut m, Some(t));
    close(visible(&m), (0.25, 0.0, 0.75, 1.0));
    // The frame keeps what was written, in its own box.
    assert_eq!(
        m.scene().stories[0].story.paragraphs[0].anchored_frames[0].image_item_transform,
        Some(t)
    );
}

#[test]
fn an_anchored_crop_places_as_a_free_frames_does() {
    for (l, t, r, b, want) in [
        (0.25, 0.0, 0.25, 0.0, (0.25, 0.0, 0.75, 1.0)),
        (0.0, 0.25, 0.0, 0.25, (0.0, 0.25, 1.0, 0.75)),
        (0.1, 0.2, 0.3, 0.1, (0.1, 0.2, 0.7, 0.9)),
        (0.5, 0.0, 0.0, 0.0, (0.5, 0.0, 1.0, 1.0)),
    ] {
        let t = crop_placement(l, t, r, b);
        let mut a = load();
        anchored(&mut a, Some(t));
        let mut f = load();
        free(&mut f, t);
        close(visible(&a), want);
        close(visible(&f), want);
    }
}

#[test]
fn a_crop_undoes_to_the_uncropped_picture() {
    let mut m = load();
    let h0 = m.current_state_hash();
    anchored(&mut m, None);
    // Uncropped: the picture is fitted whole (the frame shows all of it).
    let t = crop_placement(0.25, 0.0, 0.25, 0.0);
    let id = ElementId::Rectangle(
        m.scene().stories[0].story.paragraphs[0].anchored_frames[0]
            .self_id
            .clone()
            .unwrap(),
    );
    let h1 = m.current_state_hash();
    m.apply_mutation(&Mutation::SetElementProperty {
        element_id: id.clone(),
        path: PropertyPath::ImageContentTransform,
        value: Value::Transform(Some(t)),
    })
    .expect("placement");
    close(visible(&m), (0.25, 0.0, 0.75, 1.0));
    m.undo().expect("undo");
    assert_eq!(m.current_state_hash(), h1);
    m.undo().expect("undo");
    assert_eq!(m.current_state_hash(), h0);
}

#[test]
fn a_text_frame_has_no_picture_to_place() {
    let mut m = load();
    m.apply_mutation(&Mutation::Batch {
        ops: vec![
            Mutation::InsertAnchoredFrame {
                paragraph: None,
                story_id: "st1".into(),
                offset: 0,
                width: W,
                height: H,
                image_uri: None,
                kind: None,
                layout: None,
                cell: None,
            },
            Mutation::BindCreated {
                handle: "box".into(),
            },
        ],
    })
    .expect("batch");
    let r = m.apply_mutation(&Mutation::SetElementProperty {
        element_id: ElementId::Rectangle("$h:box".into()),
        path: PropertyPath::ImageContentTransform,
        value: Value::Transform(Some([1.0, 0.0, 0.0, 1.0, 0.0, 0.0])),
    });
    assert!(r.is_err(), "a frame with no picture refuses a placement");
}

#[test]
fn the_story_read_lists_a_picture_with_its_placement() {
    let t = crop_placement(0.25, 0.0, 0.25, 0.0);
    let mut m = load();
    let id = anchored(&mut m, Some(t));
    let content = m.story_content("st1").expect("the story reads");
    let pictures = &content.paragraphs[0].pictures;
    assert_eq!(pictures.len(), 1);
    assert_eq!(pictures[0].frame_id, id.raw_id());
    assert_eq!(pictures[0].offset, 0);
    assert_eq!(pictures[0].placement, Some(t));
    // A paragraph with no picture lists none (and the key is left out).
    let mut plain = load();
    let content = plain.story_content("st1").expect("the story reads");
    assert!(content.paragraphs[0].pictures.is_empty());
    // A picture that fills its frame has no placement; a placement written
    // later is the one the read gives back.
    let id = anchored(&mut plain, None);
    let read = plain.story_content("st1").unwrap().paragraphs[0].pictures[0].clone();
    assert_eq!(read.placement, None);
    plain
        .apply_mutation(&Mutation::SetElementProperty {
            element_id: id,
            path: PropertyPath::ImageContentTransform,
            value: Value::Transform(Some(t)),
        })
        .expect("placement");
    assert_eq!(
        plain.story_content("st1").unwrap().paragraphs[0].pictures[0].placement,
        Some(t)
    );
}

#[test]
fn an_anchored_picture_frame_lists_its_image_placement() {
    let t = crop_placement(0.1, 0.2, 0.3, 0.1);
    let mut m = load();
    let id = anchored(&mut m, Some(t));
    let props = m.element_properties(&id).expect("the frame answers");
    let entry = props
        .entries
        .iter()
        .find(|e| e.path == PropertyPath::ImageContentTransform)
        .expect("a picture frame lists imageContentTransform");
    assert_eq!(entry.value, Some(Value::Transform(Some(t))));
}

#[test]
fn an_anchored_text_frame_lists_no_image_placement() {
    let mut m = load();
    m.apply_mutation(&Mutation::Batch {
        ops: vec![Mutation::InsertAnchoredFrame {
            paragraph: None,
            story_id: "st1".into(),
            offset: 0,
            width: W,
            height: H,
            image_uri: None,
            kind: None,
            layout: None,
            cell: None,
        }],
    })
    .expect("batch");
    let id = ElementId::Rectangle(
        m.scene().stories[0].story.paragraphs[0].anchored_frames[0]
            .self_id
            .clone()
            .unwrap(),
    );
    let props = m.element_properties(&id).expect("the frame answers");
    assert!(props
        .entries
        .iter()
        .all(|e| e.path != PropertyPath::ImageContentTransform));
}

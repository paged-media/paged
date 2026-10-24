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

//! Engine ADR 1010 — clip groups and groups pasted into a frame, through
//! the full pipeline. Both start from the paged-gen `paste-into` fixture
//! (a rounded container at x ∈ [140, 440], y ∈ [200, 500] holding a
//! black rectangle that protrudes past its left edge and over its
//! rounded corner, a black oval, and a text frame whose story runs far
//! below it), rebuilt in the model:
//!
//! * as a CLIP GROUP — the three children and the container in one
//!   group, the container top-most: the children clip to its outline
//!   exactly as they did pasted in, and the container's own paint (a
//!   black fill here, and its stroke) is not drawn;
//! * as a GROUP PASTED INTO the container — the three children grouped,
//!   the group the container's one child: clipped the same, glyphs
//!   included.

use paged_compose::{Color, DisplayCommand};
use paged_model::{FrameRef, Group};
use paged_renderer::{pipeline, BytesResolver, PipelineOptions};

fn read_font(name: &str) -> Vec<u8> {
    let p = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../corpus/fonts")
        .join(name);
    std::fs::read(&p).unwrap_or_else(|e| panic!("read font fixture {}: {e}", p.display()))
}

fn pasted_in() -> paged_scene::Document {
    let bytes =
        paged_gen::write_idml(&paged_gen::samples::paste_into::build()).expect("write_idml");
    idml_import::import_idml_doc(&bytes).expect("Document::open")
}

/// The container's id and its three children, taken out of the side map.
fn take_children(doc: &mut paged_scene::Document) -> (String, FrameRef, Vec<FrameRef>) {
    let spread = &mut doc.spreads[0].spread;
    let (host, children) = spread
        .nested_children
        .drain()
        .next()
        .expect("the fixture pastes into one container");
    assert_eq!(children.len(), 3);
    let host_ref = FrameRef::Rectangle(
        spread
            .rectangles
            .iter()
            .position(|r| r.self_id.as_deref() == Some(host.as_str()))
            .expect("host rectangle"),
    );
    (host, host_ref, children)
}

fn group(id: &str, members: Vec<FrameRef>, clip: bool) -> Group {
    Group {
        self_id: Some(id.to_string()),
        members,
        clip,
        ..Group::default()
    }
}

/// The fixture as a clip group: the children, then the container on top.
fn clip_group() -> paged_scene::Document {
    let mut doc = pasted_in();
    let (_, host_ref, mut members) = take_children(&mut doc);
    let spread = &mut doc.spreads[0].spread;
    // A visible paint on the clipping path, to show it is not drawn.
    let FrameRef::Rectangle(hi) = host_ref else {
        unreachable!()
    };
    spread.rectangles[hi].fill_color = Some("Color/Black".into());
    members.push(host_ref);
    spread.groups.push(group("clipG", members, true));
    let gi = spread.groups.len() - 1;
    let slot = spread
        .frames_in_order
        .iter()
        .position(|r| *r == host_ref)
        .expect("host is top-level");
    spread.frames_in_order[slot] = FrameRef::Group(gi);
    doc
}

/// The fixture with its children grouped and the group pasted in.
fn pasted_group() -> paged_scene::Document {
    let mut doc = pasted_in();
    let (host, _, members) = take_children(&mut doc);
    let spread = &mut doc.spreads[0].spread;
    spread.groups.push(group("pastedG", members, false));
    let gi = spread.groups.len() - 1;
    spread
        .nested_children
        .insert(host, vec![FrameRef::Group(gi)]);
    doc
}

fn render(doc: &paged_scene::Document) -> image::RgbaImage {
    let mut resolver = BytesResolver::new();
    resolver.add_font("Open Sans", None, read_font("OpenSans.ttf"));
    let opts = PipelineOptions {
        assets: Some(&resolver),
        ..PipelineOptions::default()
    };
    let (_built, images) =
        pipeline::render_document(doc, &opts, 72.0, Color::WHITE).expect("render");
    images.into_iter().next().expect("one page")
}

fn clip_brackets(doc: &paged_scene::Document) -> usize {
    let mut resolver = BytesResolver::new();
    resolver.add_font("Open Sans", None, read_font("OpenSans.ttf"));
    let opts = PipelineOptions {
        assets: Some(&resolver),
        ..PipelineOptions::default()
    };
    let built = pipeline::build_document(doc, &opts).expect("build");
    let cmds = &built.pages[0].list.commands;
    let pushes = cmds
        .iter()
        .filter(|c| matches!(c, DisplayCommand::PushClip { .. }))
        .count();
    let pops = cmds
        .iter()
        .filter(|c| matches!(c, DisplayCommand::PopClip(_)))
        .count();
    assert_eq!(pushes, pops, "clip brackets balance");
    pushes
}

fn is_dark(p: [u8; 4]) -> bool {
    p[0] < 100 && p[1] < 100 && p[2] < 100
}

fn is_light(p: [u8; 4]) -> bool {
    p[0] > 200 && p[1] > 200 && p[2] > 200
}

/// The paste-into suite's probes: the children paint inside the outline,
/// clip at its straight edge and its rounded corner, and the nested
/// story's glyphs never escape below it.
fn assert_clipped_like_paste_into(img: &image::RgbaImage) {
    let px = |x: u32, y: u32| img.get_pixel(x, y).0;
    assert!(
        is_dark(px(300, 300)),
        "child rect inside: {:?}",
        px(300, 300)
    );
    assert!(
        is_light(px(120, 300)),
        "left protrusion clips: {:?}",
        px(120, 300)
    );
    assert!(
        is_light(px(146, 206)),
        "rounded corner clips: {:?}",
        px(146, 206)
    );
    assert!(
        is_dark(px(210, 270)),
        "inside the corner curve: {:?}",
        px(210, 270)
    );
    assert!(is_dark(px(390, 420)), "child oval: {:?}", px(390, 420));
    let glyph_inside = (370..490)
        .step_by(2)
        .any(|y| (175..310).step_by(2).any(|x| is_dark(px(x, y))));
    assert!(glyph_inside, "the nested story shapes glyphs inside");
    for y in (515..640).step_by(3) {
        for x in (170..350).step_by(3) {
            assert!(is_light(px(x, y)), "glyph escaped the clip at ({x}, {y})");
        }
    }
}

#[test]
#[allow(non_snake_case)]
fn a_clip_group_clips_its_members_to_the_top_most_outline__feat__frames_paths_clip_groups() {
    let doc = clip_group();
    // Body bracket + the story pass's glyph bracket.
    assert!(clip_brackets(&doc) >= 2);
    let img = render(&doc);
    assert_clipped_like_paste_into(&img);
    // The clipping path paints nothing: its black fill does not show
    // where no member lies, and neither does its 2 pt black stroke.
    let px = |x: u32, y: u32| img.get_pixel(x, y).0;
    assert!(
        is_light(px(420, 300)),
        "the clip path's fill is not drawn: {:?}",
        px(420, 300)
    );
    assert!(is_light(px(440, 300)), "nor its stroke: {:?}", px(440, 300));
}

#[test]
#[allow(non_snake_case)]
fn a_group_pasted_into_a_frame_clips_to_it__feat__frames_paths_clip_groups() {
    let doc = pasted_group();
    assert!(clip_brackets(&doc) >= 2);
    let img = render(&doc);
    assert_clipped_like_paste_into(&img);
    // The container still paints its own stroke (InDesign's paste-into).
    let px = |x: u32, y: u32| img.get_pixel(x, y).0;
    assert!(
        is_dark(px(440, 300)),
        "container stroke: {:?}",
        px(440, 300)
    );
}

/// A clip group whose top-most member cannot clip (here, after the
/// container is moved below the others) paints as a plain group:
/// everything, unclipped, the former clip path included.
#[test]
#[allow(non_snake_case)]
fn a_clip_flag_without_a_closed_top_most_outline_is_inert__feat__frames_paths_clip_groups() {
    let mut doc = clip_group();
    let spread = &mut doc.spreads[0].spread;
    let g = spread.groups.last_mut().expect("clip group");
    let host = g.members.pop().expect("host");
    g.members.insert(0, host);
    assert!(g.clip_member().is_none(), "a text frame is now on top");
    let img = render(&doc);
    let px = |x: u32, y: u32| img.get_pixel(x, y).0;
    assert!(is_dark(px(120, 300)), "unclipped: {:?}", px(120, 300));
}

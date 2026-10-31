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

//! The parameters of the live vector effects (engine ADR 1042): entries
//! of an item's ordered effect stack (ADR 1008) that change the item's
//! GEOMETRY before anything paints it, the way Illustrator's Distort &
//! Transform, Path, Pathfinder, Stylize and Convert to Shape effects do.
//!
//! The model holds only the parameters; the geometry is computed by
//! `paged-vector-fx` in the build pipeline, from the item's source path
//! and the stack, and cached by hash. Editing keeps working on the source
//! path. Every parameter has a default, so an entry written with only its
//! `kind` is complete.

use serde::{Deserialize, Serialize};

fn yes() -> bool {
    true
}

/// The vector effect kinds, by their serialised names.
pub const VECTOR_KINDS: [&str; 15] = [
    "roughen",
    "zigZag",
    "puckerBloat",
    "twist",
    "tweak",
    "transformCopies",
    "freeDistort",
    "warp",
    "envelope",
    "offsetPath",
    "outlinePath",
    "roundCorners",
    "scribble",
    "convertToShape",
    "pathfinder",
];

/// Illustrator's Roughen: the outline is cut into short pieces and every
/// new point is moved a random distance up to `size`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoughenParams {
    /// The largest move: in pt, or a percentage of the bounding box's
    /// diagonal when `relative`.
    #[serde(default = "RoughenParams::default_size")]
    pub size: f32,
    #[serde(default)]
    pub relative: bool,
    /// New points per inch of outline.
    #[serde(default = "RoughenParams::default_detail")]
    pub detail_per_inch: f32,
    /// Smooth points (curves through them) instead of corners.
    #[serde(default)]
    pub smooth: bool,
    /// The random sequence. One seed draws the same outline every time.
    #[serde(default)]
    pub seed: u32,
}
impl RoughenParams {
    fn default_size() -> f32 {
        5.0
    }
    fn default_detail() -> f32 {
        10.0
    }
}
impl Default for RoughenParams {
    fn default() -> Self {
        Self {
            size: Self::default_size(),
            relative: false,
            detail_per_inch: Self::default_detail(),
            smooth: false,
            seed: 0,
        }
    }
}

/// Illustrator's Zig Zag: `ridges` new points per segment, every point
/// of the result moved `size` to alternating sides.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ZigZagParams {
    /// In pt, or a percentage of the bounding box's diagonal when
    /// `relative`.
    #[serde(default = "ZigZagParams::default_size")]
    pub size: f32,
    #[serde(default)]
    pub relative: bool,
    #[serde(default = "ZigZagParams::default_ridges")]
    pub ridges: u32,
    /// Smooth (waves) instead of corner (zig zag) points.
    #[serde(default)]
    pub smooth: bool,
}
impl ZigZagParams {
    fn default_size() -> f32 {
        10.0
    }
    fn default_ridges() -> u32 {
        4
    }
}
impl Default for ZigZagParams {
    fn default() -> Self {
        Self {
            size: Self::default_size(),
            relative: false,
            ridges: Self::default_ridges(),
            smooth: false,
        }
    }
}

/// Illustrator's Pucker & Bloat: positive bloats (anchors toward the
/// centre, handles away from it), negative puckers.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PuckerBloatParams {
    /// −200..=200.
    #[serde(default)]
    pub amount_pct: f32,
}

/// Illustrator's Twist: the outline turns about the bounding box's
/// centre, the most at the centre and not at all at the farthest point.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TwistParams {
    /// Degrees; positive turns clockwise on the page.
    #[serde(default)]
    pub angle_deg: f32,
}

/// Illustrator's Tweak: anchors and handles moved at random.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TweakParams {
    /// Largest horizontal move: pt, or a percentage of the box's width
    /// when `relative`.
    #[serde(default = "TweakParams::default_amount")]
    pub horizontal: f32,
    /// Largest vertical move: pt, or a percentage of the box's height.
    #[serde(default = "TweakParams::default_amount")]
    pub vertical: f32,
    #[serde(default)]
    pub relative: bool,
    #[serde(default = "yes")]
    pub anchors: bool,
    #[serde(default = "yes")]
    pub in_handles: bool,
    #[serde(default = "yes")]
    pub out_handles: bool,
    #[serde(default)]
    pub seed: u32,
}
impl TweakParams {
    fn default_amount() -> f32 {
        5.0
    }
}
impl Default for TweakParams {
    fn default() -> Self {
        Self {
            horizontal: Self::default_amount(),
            vertical: Self::default_amount(),
            relative: false,
            anchors: true,
            in_handles: true,
            out_handles: true,
            seed: 0,
        }
    }
}

/// Where a transform pivots, on the bounding box.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BoxPoint {
    TopLeft,
    Top,
    TopRight,
    Left,
    #[default]
    Center,
    Right,
    BottomLeft,
    Bottom,
    BottomRight,
}

/// Illustrator's Transform effect: the source and `copies` transformed
/// copies, each copy the previous one transformed again.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransformCopiesParams {
    #[serde(default = "TransformCopiesParams::hundred")]
    pub scale_h_pct: f32,
    #[serde(default = "TransformCopiesParams::hundred")]
    pub scale_v_pct: f32,
    /// pt, right.
    #[serde(default)]
    pub move_h: f32,
    /// pt, down the page.
    #[serde(default)]
    pub move_v: f32,
    /// Degrees, counter-clockwise on the page (Illustrator's sense).
    #[serde(default)]
    pub rotate_deg: f32,
    #[serde(default)]
    pub reflect_x: bool,
    #[serde(default)]
    pub reflect_y: bool,
    #[serde(default)]
    pub copies: u32,
    #[serde(default)]
    pub origin: BoxPoint,
}
impl TransformCopiesParams {
    fn hundred() -> f32 {
        100.0
    }
}
impl Default for TransformCopiesParams {
    fn default() -> Self {
        Self {
            scale_h_pct: 100.0,
            scale_v_pct: 100.0,
            move_h: 0.0,
            move_v: 0.0,
            rotate_deg: 0.0,
            reflect_x: false,
            reflect_y: false,
            copies: 0,
            origin: BoxPoint::Center,
        }
    }
}

/// Illustrator's Free Distort: the bounding box's corners moved. Each
/// corner is given in the box's unit square (0,0 its top left, 1,1 its
/// bottom right), so the effect follows the item when it is resized.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FreeDistortParams {
    /// Top left, top right, bottom right, bottom left.
    #[serde(default = "FreeDistortParams::identity")]
    pub corners: [[f32; 2]; 4],
}
impl FreeDistortParams {
    pub fn identity() -> [[f32; 2]; 4] {
        [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]]
    }
}
impl Default for FreeDistortParams {
    fn default() -> Self {
        Self {
            corners: Self::identity(),
        }
    }
}

/// Illustrator's Envelope Distort (Make with Mesh, Make with Top Object,
/// and a warp envelope reset with a mesh): the bounding box bent through a
/// mesh of `rows` × `columns` bicubic Bézier patches. `mesh` is the
/// patches' control net — `3 · rows + 1` rows of `3 · columns + 1`
/// points, row-major, top to bottom — each point in the box's unit square
/// (0,0 its top left, 1,1 its bottom right) like Free Distort's corners,
/// so the envelope follows the item when it is moved or resized. Neighbour
/// patches share their edge points. An empty net is the flat one: the
/// item as drawn.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvelopeParams {
    #[serde(default = "EnvelopeParams::one")]
    pub rows: u32,
    #[serde(default = "EnvelopeParams::one")]
    pub columns: u32,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mesh: Vec<[f32; 2]>,
}
impl EnvelopeParams {
    /// Illustrator's limit on either side of an envelope mesh.
    pub const MAX_CELLS: u32 = 50;
    fn one() -> u32 {
        1
    }
    /// The number of control points a `rows` × `columns` net holds.
    pub fn net_len(rows: u32, columns: u32) -> usize {
        (3 * rows as usize + 1) * (3 * columns as usize + 1)
    }
    /// The flat net of a `rows` × `columns` mesh: every point where it
    /// lies in the unit square.
    pub fn flat(rows: u32, columns: u32) -> Vec<[f32; 2]> {
        let (nr, nc) = (3 * rows as usize, 3 * columns as usize);
        let mut out = Vec::with_capacity((nr + 1) * (nc + 1));
        for i in 0..=nr {
            for j in 0..=nc {
                out.push([j as f32 / nc as f32, i as f32 / nr as f32]);
            }
        }
        out
    }
    /// The net, the flat one when none is stored.
    pub fn net(&self) -> Vec<[f32; 2]> {
        if self.mesh.len() == Self::net_len(self.rows, self.columns) {
            self.mesh.clone()
        } else {
            Self::flat(self.rows, self.columns)
        }
    }
}
impl Default for EnvelopeParams {
    fn default() -> Self {
        Self {
            rows: 1,
            columns: 1,
            mesh: Vec::new(),
        }
    }
}

/// Illustrator's fifteen warp styles (Effect › Warp, Envelope › Make
/// with Warp).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WarpStyle {
    #[default]
    Arc,
    ArcLower,
    ArcUpper,
    Arch,
    Bulge,
    ShellLower,
    ShellUpper,
    Flag,
    Wave,
    Fish,
    Rise,
    Fisheye,
    Inflate,
    Squeeze,
    Twist,
}

impl WarpStyle {
    pub const ALL: [WarpStyle; 15] = [
        WarpStyle::Arc,
        WarpStyle::ArcLower,
        WarpStyle::ArcUpper,
        WarpStyle::Arch,
        WarpStyle::Bulge,
        WarpStyle::ShellLower,
        WarpStyle::ShellUpper,
        WarpStyle::Flag,
        WarpStyle::Wave,
        WarpStyle::Fish,
        WarpStyle::Rise,
        WarpStyle::Fisheye,
        WarpStyle::Inflate,
        WarpStyle::Squeeze,
        WarpStyle::Twist,
    ];
}

/// Illustrator's Warp.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WarpParams {
    #[serde(default)]
    pub style: WarpStyle,
    /// The bend runs along the horizontal axis (Illustrator's default),
    /// else the vertical.
    #[serde(default = "yes")]
    pub horizontal: bool,
    /// −100..=100.
    #[serde(default = "WarpParams::default_bend")]
    pub bend_pct: f32,
    /// −100..=100: a horizontal perspective.
    #[serde(default)]
    pub distort_h_pct: f32,
    /// −100..=100: a vertical perspective.
    #[serde(default)]
    pub distort_v_pct: f32,
}
impl WarpParams {
    fn default_bend() -> f32 {
        50.0
    }
}
impl Default for WarpParams {
    fn default() -> Self {
        Self {
            style: WarpStyle::Arc,
            horizontal: true,
            bend_pct: Self::default_bend(),
            distort_h_pct: 0.0,
            distort_v_pct: 0.0,
        }
    }
}

/// How an offset or an outline joins its corners.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PathJoin {
    #[default]
    Miter,
    Round,
    Bevel,
}

/// Illustrator's Offset Path effect.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OffsetPathParams {
    /// pt; positive grows the shape.
    #[serde(default = "OffsetPathParams::default_offset")]
    pub offset: f32,
    #[serde(default)]
    pub join: PathJoin,
    #[serde(default = "OffsetPathParams::default_miter")]
    pub miter_limit: f32,
}
impl OffsetPathParams {
    fn default_offset() -> f32 {
        10.0
    }
    fn default_miter() -> f32 {
        4.0
    }
}
impl Default for OffsetPathParams {
    fn default() -> Self {
        Self {
            offset: Self::default_offset(),
            join: PathJoin::Miter,
            miter_limit: Self::default_miter(),
        }
    }
}

/// Illustrator's Outline Stroke effect: the item's stroke becomes the
/// filled outline it paints (with the item's weight, cap, join and miter
/// limit), painted in the stroke's colour. No parameters.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlinePathParams {}

/// Illustrator's Round Corners effect.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoundCornersParams {
    /// pt.
    #[serde(default = "RoundCornersParams::default_radius")]
    pub radius: f32,
}
impl RoundCornersParams {
    fn default_radius() -> f32 {
        10.0
    }
}
impl Default for RoundCornersParams {
    fn default() -> Self {
        Self {
            radius: Self::default_radius(),
        }
    }
}

/// Illustrator's Scribble: the fill is drawn as a back-and-forth line.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScribbleParams {
    /// The lines' direction, degrees counter-clockwise from +x.
    #[serde(default = "ScribbleParams::default_angle")]
    pub angle_deg: f32,
    /// How far the turns reach past (+) or stop short of (−) the
    /// outline, pt.
    #[serde(default)]
    pub path_overlap: f32,
    #[serde(default)]
    pub path_overlap_variation: f32,
    /// The line's width, pt.
    #[serde(default = "ScribbleParams::default_width")]
    pub stroke_width: f32,
    /// 0..=100: how round the turns are.
    #[serde(default = "ScribbleParams::default_curviness")]
    pub curviness_pct: f32,
    #[serde(default)]
    pub curviness_variation_pct: f32,
    /// Distance between neighbouring lines, pt.
    #[serde(default = "ScribbleParams::default_spacing")]
    pub spacing: f32,
    #[serde(default)]
    pub spacing_variation: f32,
    #[serde(default)]
    pub seed: u32,
}
impl ScribbleParams {
    fn default_angle() -> f32 {
        30.0
    }
    fn default_width() -> f32 {
        3.0
    }
    fn default_curviness() -> f32 {
        5.0
    }
    fn default_spacing() -> f32 {
        5.0
    }
}
impl Default for ScribbleParams {
    fn default() -> Self {
        Self {
            angle_deg: Self::default_angle(),
            path_overlap: 0.0,
            path_overlap_variation: 0.0,
            stroke_width: Self::default_width(),
            curviness_pct: Self::default_curviness(),
            curviness_variation_pct: 0.0,
            spacing: Self::default_spacing(),
            spacing_variation: 0.0,
            seed: 0,
        }
    }
}

/// The shape Convert to Shape draws.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ShapeKind {
    #[default]
    Rectangle,
    RoundedRectangle,
    Ellipse,
}

/// Illustrator's Convert to Shape effect: the item drawn as a rectangle,
/// rounded rectangle or ellipse about its bounding box's centre.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertToShapeParams {
    #[serde(default)]
    pub shape: ShapeKind,
    /// The size is the box's plus `extra_width` / `extra_height`; else
    /// `width` × `height`.
    #[serde(default = "yes")]
    pub relative: bool,
    #[serde(default)]
    pub extra_width: f32,
    #[serde(default)]
    pub extra_height: f32,
    #[serde(default = "ConvertToShapeParams::default_size")]
    pub width: f32,
    #[serde(default = "ConvertToShapeParams::default_size")]
    pub height: f32,
    /// The rounded rectangle's corner radius, pt.
    #[serde(default = "ConvertToShapeParams::default_radius")]
    pub corner_radius: f32,
}
impl ConvertToShapeParams {
    fn default_size() -> f32 {
        36.0
    }
    fn default_radius() -> f32 {
        9.0
    }
}
impl Default for ConvertToShapeParams {
    fn default() -> Self {
        Self {
            shape: ShapeKind::Rectangle,
            relative: true,
            extra_width: 0.0,
            extra_height: 0.0,
            width: Self::default_size(),
            height: Self::default_size(),
            corner_radius: Self::default_radius(),
        }
    }
}

/// The Pathfinder shape modes, as an effect on a group.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PathfinderOp {
    /// Unite.
    #[default]
    Add,
    /// Minus Front: the backmost member minus the others.
    Subtract,
    Intersect,
    Exclude,
}

/// Illustrator's Effect › Pathfinder on a group (a compound shape): the
/// members are combined into one outline, painted as the frontmost
/// member (the backmost for Minus Front).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathfinderParams {
    #[serde(default)]
    pub op: PathfinderOp,
}

/// The IDML side of the live vector effects (engine ADR 1042).
///
/// IDML has no live vector effect, so the writer BAKES them: an item is
/// written as the item its effected outline describes, an oval as a
/// polygon, a group with a Pathfinder effect as one polygon in the
/// group's place. What the bake replaced rides the written item's label
/// under [`SOURCE_KEY`] (InDesign keeps labels and does not draw them;
/// a group's outline is a polygon member of the group, which stays):
/// the source item (or the group and its members) and a fingerprint of
/// the baked outline. The reader's [`lift`] puts the source back when
/// the outline it reads is still the one written; an outline InDesign
/// changed meanwhile stays, and the item's vector entries are dropped
/// (the edit wins).
///
/// This half carries no geometry kernel (the reader must not reach one):
/// the bake is `paged-vector-fx`'s, run by the writer.
pub mod label {
    use serde::{Deserialize, Serialize};

    use crate::effect_stack::EffectEntry;
    use crate::{
        FrameRef, GraphicLine, Group, Oval, PathAnchor, Polygon, Rectangle, Spread, TextFrame,
    };

    /// The label key.
    pub const SOURCE_KEY: &str = "paged:vectorSource";

    /// What a baked item replaced.
    #[derive(Debug, Clone, Serialize, Deserialize)]
    #[serde(tag = "kind", rename_all = "camelCase")]
    pub enum Source {
        Rectangle {
            item: Box<Rectangle>,
            fingerprint: String,
        },
        Polygon {
            item: Box<Polygon>,
            fingerprint: String,
        },
        TextFrame {
            item: Box<TextFrame>,
            fingerprint: String,
        },
        /// An oval, written as a polygon.
        Oval {
            item: Box<Oval>,
            fingerprint: String,
        },
        /// A group with a Pathfinder effect, written as one polygon; its
        /// members back first.
        Group {
            group: Box<Group>,
            members: Vec<Member>,
            fingerprint: String,
        },
    }

    /// One member of a baked group.
    #[derive(Debug, Clone, Serialize, Deserialize)]
    #[serde(tag = "kind", rename_all = "camelCase")]
    pub enum Member {
        Rectangle { item: Box<Rectangle> },
        Oval { item: Box<Oval> },
        Polygon { item: Box<Polygon> },
        TextFrame { item: Box<TextFrame> },
        GraphicLine { item: Box<GraphicLine> },
    }

    /// The fingerprint of an outline: its anchor count and its anchors'
    /// box, to 0.01 pt. What survives InDesign's round trip unchanged
    /// when nobody edits the path (InDesign rewrites coordinates in its
    /// own number format, never moves them).
    pub fn fingerprint(anchors: &[PathAnchor]) -> String {
        let mut b = [
            f32::INFINITY,
            f32::INFINITY,
            f32::NEG_INFINITY,
            f32::NEG_INFINITY,
        ];
        for a in anchors {
            for p in [a.anchor, a.left, a.right] {
                b[0] = b[0].min(p.0);
                b[1] = b[1].min(p.1);
                b[2] = b[2].max(p.0);
                b[3] = b[3].max(p.1);
            }
        }
        if anchors.is_empty() {
            return "0".to_string();
        }
        let r = |v: f32| (v * 100.0).round() as i64;
        format!(
            "{}:{}:{}:{}:{}",
            anchors.len(),
            r(b[0]),
            r(b[1]),
            r(b[2]),
            r(b[3])
        )
    }

    fn same_kind(a: &FrameRef, b: &FrameRef) -> bool {
        std::mem::discriminant(a) == std::mem::discriminant(b)
    }

    fn index(r: &FrameRef) -> usize {
        match *r {
            FrameRef::TextFrame(i)
            | FrameRef::Rectangle(i)
            | FrameRef::Oval(i)
            | FrameRef::GraphicLine(i)
            | FrameRef::Polygon(i)
            | FrameRef::Group(i)
            | FrameRef::Instance(i) => i,
        }
    }

    fn with_index(r: &FrameRef, i: usize) -> FrameRef {
        match r {
            FrameRef::TextFrame(_) => FrameRef::TextFrame(i),
            FrameRef::Rectangle(_) => FrameRef::Rectangle(i),
            FrameRef::Oval(_) => FrameRef::Oval(i),
            FrameRef::GraphicLine(_) => FrameRef::GraphicLine(i),
            FrameRef::Polygon(_) => FrameRef::Polygon(i),
            FrameRef::Group(_) => FrameRef::Group(i),
            FrameRef::Instance(_) => FrameRef::Instance(i),
        }
    }

    /// Every list of the spread that names page items.
    fn for_each_list(spread: &mut Spread, mut f: impl FnMut(&mut Vec<FrameRef>)) {
        f(&mut spread.frames_in_order);
        for g in spread.groups.iter_mut() {
            f(&mut g.members);
        }
        for v in spread.nested_children.values_mut() {
            f(v);
        }
    }

    /// Put `to` wherever a list names `from`.
    pub fn replace_ref(spread: &mut Spread, from: FrameRef, to: FrameRef) {
        for_each_list(spread, |l| {
            for r in l.iter_mut() {
                if *r == from {
                    *r = to;
                }
            }
        });
    }

    /// Take the item `r` out of its kind's list and out of every list
    /// that names it; later items of the kind step down.
    pub fn remove_item(spread: &mut Spread, r: FrameRef) {
        let i = index(&r);
        match r {
            FrameRef::TextFrame(_) if i < spread.text_frames.len() => {
                spread.text_frames.remove(i);
            }
            FrameRef::Rectangle(_) if i < spread.rectangles.len() => {
                spread.rectangles.remove(i);
            }
            FrameRef::Oval(_) if i < spread.ovals.len() => {
                spread.ovals.remove(i);
            }
            FrameRef::GraphicLine(_) if i < spread.graphic_lines.len() => {
                spread.graphic_lines.remove(i);
            }
            FrameRef::Polygon(_) if i < spread.polygons.len() => {
                spread.polygons.remove(i);
            }
            FrameRef::Group(_) if i < spread.groups.len() => {
                spread.groups.remove(i);
            }
            FrameRef::Instance(_) if i < spread.instances.len() => {
                spread.instances.remove(i);
            }
            _ => return,
        }
        for_each_list(spread, |l| {
            l.retain(|x| *x != r);
            for x in l.iter_mut() {
                if same_kind(x, &r) && index(x) > i {
                    *x = with_index(x, index(x) - 1);
                }
            }
        });
    }

    fn push_label(spread: &mut Spread, id: &str, value: String) {
        let entries = spread.labels.entry(id.to_string()).or_default();
        entries.retain(|(k, _)| k != SOURCE_KEY);
        entries.push((SOURCE_KEY.to_string(), value));
    }

    /// Record `source` on the written item `id`.
    pub fn stamp(spread: &mut Spread, id: &str, source: &Source) {
        if let Ok(v) = serde_json::to_string(source) {
            push_label(spread, id, v);
        }
    }

    fn take(spread: &mut Spread, id: &Option<String>) -> Option<Source> {
        let entries = spread.labels.get_mut(id.as_deref()?)?;
        let at = entries.iter().position(|(k, _)| k == SOURCE_KEY)?;
        let v = entries.remove(at).1;
        serde_json::from_str(&v).ok()
    }

    fn strip_vector(stack: &mut Vec<EffectEntry>) {
        stack.retain(|e| !e.effect.is_vector());
        if crate::effect_stack::is_canonical(stack) {
            stack.clear();
        }
    }

    fn member_ref(spread: &mut Spread, m: Member) -> FrameRef {
        match m {
            Member::Rectangle { item } => {
                spread.rectangles.push(*item);
                FrameRef::Rectangle(spread.rectangles.len() - 1)
            }
            Member::Oval { item } => {
                spread.ovals.push(*item);
                FrameRef::Oval(spread.ovals.len() - 1)
            }
            Member::Polygon { item } => {
                spread.polygons.push(*item);
                FrameRef::Polygon(spread.polygons.len() - 1)
            }
            Member::TextFrame { item } => {
                spread.text_frames.push(*item);
                FrameRef::TextFrame(spread.text_frames.len() - 1)
            }
            Member::GraphicLine { item } => {
                spread.graphic_lines.push(*item);
                FrameRef::GraphicLine(spread.graphic_lines.len() - 1)
            }
        }
    }

    /// Restore every baked item on `spread` whose outline is still the
    /// one written (see the module doc). Returns how many came back.
    pub fn lift(spread: &mut Spread) -> usize {
        if !spread
            .labels
            .values()
            .any(|v| v.iter().any(|(k, _)| k == SOURCE_KEY))
        {
            return 0;
        }
        let mut restored = 0;
        // In-place kinds first: no list moves.
        for i in 0..spread.rectangles.len() {
            let id = spread.rectangles[i].self_id.clone();
            if let Some(Source::Rectangle {
                item,
                fingerprint: fp,
            }) = take(spread, &id)
            {
                let cur = &mut spread.rectangles[i];
                if fingerprint(&cur.anchors) == fp {
                    let bytes = cur.image_bytes.take();
                    *cur = *item;
                    cur.image_bytes = bytes;
                    restored += 1;
                } else {
                    strip_vector(&mut cur.effect_stack);
                }
            }
        }
        for i in 0..spread.text_frames.len() {
            let id = spread.text_frames[i].self_id.clone();
            if let Some(Source::TextFrame {
                item,
                fingerprint: fp,
            }) = take(spread, &id)
            {
                let cur = &mut spread.text_frames[i];
                if fingerprint(&cur.anchors) == fp {
                    *cur = *item;
                    restored += 1;
                } else {
                    strip_vector(&mut cur.effect_stack);
                }
            }
        }
        // Polygons: in place, or the oval / group they stand for.
        let mut i = 0;
        while i < spread.polygons.len() {
            let id = spread.polygons[i].self_id.clone();
            let Some(source) = take(spread, &id) else {
                i += 1;
                continue;
            };
            let matches =
                |fp: &str, spread: &Spread| fingerprint(&spread.polygons[i].anchors) == fp;
            match source {
                Source::Polygon { item, fingerprint } => {
                    if matches(&fingerprint, spread) {
                        let cur = &mut spread.polygons[i];
                        let bytes = cur.image_bytes.take();
                        *cur = *item;
                        cur.image_bytes = bytes;
                        restored += 1;
                    } else {
                        strip_vector(&mut spread.polygons[i].effect_stack);
                    }
                    i += 1;
                }
                Source::Oval { item, fingerprint } if matches(&fingerprint, spread) => {
                    let mut oval = *item;
                    oval.image_bytes = spread.polygons[i].image_bytes.take();
                    spread.ovals.push(oval);
                    let to = FrameRef::Oval(spread.ovals.len() - 1);
                    replace_ref(spread, FrameRef::Polygon(i), to);
                    move_labels(spread, &id, &to_id(spread, to));
                    // The polygon is no longer named; take it out.
                    spread.polygons.remove(i);
                    step_down(spread, FrameRef::Polygon(i));
                    restored += 1;
                }
                Source::Group {
                    group,
                    members,
                    fingerprint,
                } if matches(&fingerprint, spread) => {
                    let refs: Vec<FrameRef> =
                        members.into_iter().map(|m| member_ref(spread, m)).collect();
                    let mut g = *group;
                    g.members = refs;
                    // The writer kept the group, the outline its one
                    // member; else the group comes back in its place.
                    let host = spread.groups.iter().position(|h| {
                        h.self_id == g.self_id && h.members == [FrameRef::Polygon(i)]
                    });
                    match host {
                        Some(h) => spread.groups[h] = g,
                        None => {
                            spread.groups.push(g);
                            let to = FrameRef::Group(spread.groups.len() - 1);
                            replace_ref(spread, FrameRef::Polygon(i), to);
                            move_labels(spread, &id, &to_id(spread, to));
                        }
                    }
                    spread.polygons.remove(i);
                    step_down(spread, FrameRef::Polygon(i));
                    restored += 1;
                }
                // InDesign changed the outline: the polygon stays, as
                // drawn, without the effects that made it.
                _ => {
                    strip_vector(&mut spread.polygons[i].effect_stack);
                    i += 1;
                }
            }
        }
        spread.labels.retain(|_, v| !v.is_empty());
        restored
    }

    fn to_id(spread: &Spread, r: FrameRef) -> Option<String> {
        match r {
            FrameRef::Oval(i) => spread.ovals.get(i)?.self_id.clone(),
            FrameRef::Group(i) => spread.groups.get(i)?.self_id.clone(),
            _ => None,
        }
    }

    /// The written polygon's other labels belong to the item it stands
    /// for.
    fn move_labels(spread: &mut Spread, from: &Option<String>, to: &Option<String>) {
        let (Some(from), Some(to)) = (from, to) else {
            return;
        };
        if from == to {
            return;
        }
        if let Some(rest) = spread.labels.remove(from) {
            spread.labels.entry(to.clone()).or_default().extend(rest);
        }
    }

    /// Later items of `removed`'s kind step down by one in every list.
    fn step_down(spread: &mut Spread, removed: FrameRef) {
        let i = index(&removed);
        for_each_list(spread, |l| {
            l.retain(|x| *x != removed);
            for x in l.iter_mut() {
                if same_kind(x, &removed) && index(x) > i {
                    *x = with_index(x, index(x) - 1);
                }
            }
        });
    }
}

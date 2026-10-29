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
pub const VECTOR_KINDS: [&str; 14] = [
    "roughen",
    "zigZag",
    "puckerBloat",
    "twist",
    "tweak",
    "transformCopies",
    "freeDistort",
    "warp",
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

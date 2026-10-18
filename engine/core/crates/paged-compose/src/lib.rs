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

//! Display-list compositor.
//!
//! Walks the laid-out scene graph and emits a structured command
//! buffer: paths, fills, clips, blend state, effects. The display
//! list is the handoff format to the GPU rasterizer and is versioned
//! so it can also be used as a stable intermediate representation for
//! tooling.

pub mod dash_fit;
pub mod display_list;
pub mod extent;
pub mod glyph;
pub mod mask;
pub mod perf;
pub mod pixel_layer;
pub mod primitives;
pub mod scene_layer;
pub mod stroke_marks;
pub mod text;

pub use display_list::{
    BevelDirection, BevelEmboss, BevelStyle, BevelTechnique, BlendMode, CellKey, Color,
    DashPattern, DecodedImage, DirectionalFeather, DisplayCommand, DisplayList, DropShadow,
    Feather, FeatherCornerType, GlyphCacheKey, GlyphRunEntry, GlyphRunTable, GradientFeather,
    GradientFeatherKind, GradientFeatherStop, GradientId, GradientStop, ImageId, InnerGlow,
    InnerShadow, LayerEffect, LineCap, LineJoin, LinearGradient, LinkRegion, LinkRegionTable,
    LinkTarget, OuterGlow, Paint, PathBuffer, PathData, PathId, PathSegment, RadialGradient, Rect,
    Satin, SoftMaskType, SpotInk, SpotInkId, Stroke, StrokeMarks, StructKey, SweepGradient,
    Transform,
};
pub use extent::{
    fit_transparency_group_bounds, transparency_group_overflow, GroupFit, GROUP_AA_PAD_PT,
};
pub use glyph::{GlyphOutliner, TtfOutliner, UnitSquareOutliner};
pub use pixel_layer::{PixelLayer, PixelTile};
pub use primitives::{
    emit_drop_shadow_rect, emit_drop_shadow_rect_transformed, emit_ellipse,
    emit_ellipse_transformed, emit_ellipse_transformed_blend, emit_image_at, emit_line, emit_rect,
    emit_rect_transformed, emit_rect_transformed_blend, emit_stroke_ellipse,
    emit_stroke_ellipse_transformed, emit_stroke_rect, emit_stroke_rect_transformed, unit_ellipse,
    UNIT_ELLIPSE_KEY, UNIT_RECT_KEY,
};
pub use scene_layer::{
    emit_scene_layer, scene_paint_to_color, SceneBlendMode, SceneGradient, SceneGradientStop,
    SceneItem, SceneLayer, ScenePaint, ScenePathSeg, SceneTextItem,
};
pub use text::FontRef;
pub use text::{
    emit_glyph_slice, emit_glyph_slice_blend, emit_glyph_slice_stroke, emit_paragraph,
    emit_paragraph_blend,
};

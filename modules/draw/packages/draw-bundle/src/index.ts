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

// @paged-media/draw-bundle — the paged.draw plugin bundle.

import { defineBundle } from "@paged-media/plugin-sdk";
import type { PluginManifest } from "@paged-media/plugin-api";

import { activate } from "./activate";
import manifestJson from "../manifest.json";

export const drawBundle = defineBundle({
  manifest: manifestJson as PluginManifest,
  activate,
});

export { activate };
// The plan→Mutation translation, exported for the conformance replay
// harness (so it replays the EXACT mutation the live tool emits — no
// second copy to drift from).
export { mutationFor, type AnchorEditMode } from "./handlers/anchors";
// W3.1 — the v1 declarative stroke panel (closes B-01) + its binding
// driver, exported for the conformance spec.
export {
  strokePanel,
  installStrokePanelBindings,
  STROKE_PANEL_ID,
  BIND_HAS_SELECTION,
  BIND_DASH_CONTROLS_VISIBLE,
} from "./panels/stroke-panel";
// W3.2 — the vectorGraphic edit context (closes B-02), exported for the
// conformance spec.
export {
  vectorGraphicEditContext,
  VECTOR_GRAPHIC_CONTEXT,
} from "./edit-context";
// B-12 — the stroke DASH presets + their mutation builder, exported for
// the conformance spec (so it asserts the EXACT mutation a command
// emits — no second copy to drift from).
export {
  DASH_PRESETS,
  DASH_COMMAND_IDS,
  DASH_COMMAND_CATEGORY,
  dashMutationFor,
  applyDashPreset,
  contributeDashCommands,
  type DashPreset,
} from "./commands/dash";
// Phase 2d — Group selection / Ungroup (B-04 consumers; clipping masks
// honestly omitted — not wire-representable, see commands/group.ts),
// exported for the conformance spec.
export {
  GROUP_COMMAND_ID,
  UNGROUP_COMMAND_ID,
  GROUP_COMMAND_IDS,
  GROUP_COMMAND_CATEGORY,
  groupMutationFor,
  ungroupMutationFor,
  applyGroupSelection,
  applyUngroup,
  contributeGroupCommands,
} from "./commands/group";
// Phase 2d — the v1 declarative FILL panel (B-03 consumer) + its
// binding driver, exported for the conformance spec.
export {
  fillPanel,
  installFillPanelBindings,
  FILL_PANEL_ID,
  BIND_GRADIENT_CONTROLS_VISIBLE,
} from "./panels/fill-panel";
// Phase 2d — the gradient-fill preset commands + their mutation
// builder, exported for the conformance spec (so it asserts the EXACT
// mutations a command emits — no second copy to drift from).
export {
  FILL_GRADIENT_PRESETS,
  FILL_GRADIENT_COMMAND_IDS,
  FILL_COMMAND_CATEGORY,
  mintFillGradientIds,
  fillGradientMutationsFor,
  applyFillGradientPreset,
  contributeFillGradientCommands,
  type FillGradientPreset,
} from "./commands/fill-gradient";
// Phase 4c — the pro toolset, exported for the conformance specs (the
// same no-second-copy rule for every builder).
export {
  PRO_TOOL_IDS,
  DRAW_TOOL_IDS,
  BRUSH_TOOL_IDS,
  WAVE2_TOOL_IDS,
} from "./tools";
export { insertPathMutationFor } from "./handlers/insert-path";
// Brush tools v0 — the sweep handler factories, the exact
// outlineStrokeVariable wire builder and the fixed nib profiles,
// exported for the conformance specs (the no-second-copy rule).
export {
  createPaintbrushHandler,
  createBlobBrushHandler,
  createEraserBrushHandler,
  outlineStrokeVariableMutationFor,
  PAINTBRUSH_NIB,
  ERASER_NIB,
  FALLBACK_FILL_REF,
} from "./handlers/brush";
export { createCurvatureHandler } from "./handlers/curvature";
export { createPencilHandler } from "./handlers/pencil";
export {
  createMeasureHandler,
  nearestPathPointOnPage,
  measureReadoutLabel,
  measureTextPreview,
  BIND_MEASURE_READOUT,
  OVERLAY_TEXT_FEATURE,
  type ToolPreviewTextMirror,
} from "./handlers/measure";
export {
  createGradientAnnotatorHandler,
  gradientAxisMutationFor,
} from "./handlers/gradient-annotator";
export {
  PATH_OPS_COMMAND_IDS,
  PATH_OPS_COMMAND_CATEGORY,
  OUTLINE_STROKE_COMMAND_ID,
  OFFSET_PATH_COMMAND_ID,
  SIMPLIFY_PATH_COMMAND_ID,
  DEFAULT_OUTLINE_WIDTH_PT,
  DEFAULT_OFFSET_DELTA_PT,
  DEFAULT_SIMPLIFY_TOLERANCE_PT,
  DEFAULT_MITER_LIMIT,
  outlineStrokeMutationFor,
  offsetPathMutationFor,
  simplifyPathMutationFor,
  outlineParamsOf,
  applyOutlineStroke,
  applyOffsetPath,
  applySimplifyPath,
  contributePathOpsCommands,
  type OutlineStrokeParams,
  type OffsetPathParams,
  type StrokeCapToken,
  type StrokeJoinToken,
} from "./commands/path-ops";
// Phase 4c + the v56 TRUE JOIN — the endpoint planners (the coincide
// fallback), the real `closePath`/`joinPaths` wire builders and the
// engine-op probe that chooses between them, exported for the
// conformance spec (the no-second-copy rule).
export {
  JOIN_AVERAGE_COMMAND_IDS,
  JOIN_AVERAGE_COMMAND_CATEGORY,
  JOIN_COMMAND_ID,
  CLOSE_PATH_COMMAND_ID,
  AVERAGE_COMMAND_ID,
  planJoinEndpoints,
  planAverageEndpoints,
  pathPointSetMutationFor,
  endpointMovesMutationFor,
  closePathMutationFor,
  joinPathsMutationFor,
  parseOpVocabulary,
  engineOpVocabulary,
  supportsPathWeld,
  applyJoin,
  applyClosePath,
  contributeJoinAverageCommands,
  type EndpointMove,
} from "./commands/join-average";
export {
  PATHFINDER_PRESETS,
  PATHFINDER_COMMAND_IDS,
  PATHFINDER_COMMAND_CATEGORY,
  pathfinderMutationFor,
  applyPathfinder,
  contributePathfinderCommands,
  type PathfinderPreset,
} from "./commands/pathfinder";
// B-22 (engine v57) — the REGION Pathfinder row (Divide / Trim / Merge
// / Crop / Outline / Minus back) + the shared v57 wire builders and the
// refusal reader, exported for the conformance spec (no second copy to
// drift from).
export {
  PATHFINDER_REGION_PRESETS,
  PATHFINDER_REGION_COMMAND_IDS,
  PATHFINDER_REGION_COMMAND_CATEGORY,
  BIND_PATHFINDER_STATUS,
  pathfinderRegionMutationFor,
  pathfinderFacesMutationFor,
  paintOrderLeaves,
  orderTopToBottom,
  selectionTopToBottom,
  regionRefusalReason,
  applyPathfinderRegion,
  contributePathfinderRegionCommands,
  type PathfinderRegionPreset,
  type PathfinderRegionVerb,
} from "./commands/pathfinder-region";
// Phase 9 (Tier B) → B-22 — Shape Builder gesture tool, now REGION
// level: the gesture→pathfinderFaces builder, the element-lane fallback
// builder, the raw→page face mapping and the host handler factory,
// exported for the conformance specs (the no-second-copy rule).
export {
  createShapeBuilderHandler,
  shapeBuilderMutationFor,
  shapeBuilderFacesMutationFor,
  faceToPageSpace,
  pathfinderKindFor,
  type PlanarFaceWire,
  type PlanarRegionsWire,
} from "./handlers/shape-builder";
// Phase 9 (Tier B) — Live Corners: the per-corner wire-shape builders +
// the metadata "live" marker, exported for the conformance spec.
export {
  LIVE_CORNER_PRESETS,
  LIVE_CORNER_COMMAND_IDS,
  LIVE_CORNERS_COMMAND_CATEGORY,
  DEFAULT_CORNER_RADIUS_PT,
  supportsLiveCorners,
  cornerStyleMutationFor,
  cornerRadiiMutationFor,
  withLiveCornerMarker,
  applyLiveCornerPreset,
  contributeLiveCornerCommands,
  type LiveCornerPreset,
  type CornerStyleToken,
} from "./commands/live-corners";
// Phase 9 (Tier B) — Appearance model: the stack model + bake builders +
// envelope round-trip helpers, exported for the conformance spec.
export {
  APPEARANCE_COMMAND_IDS,
  APPEARANCE_COMMAND_CATEGORY,
  APPEARANCE_ADD_FILL_COMMAND_ID,
  APPEARANCE_ADD_STROKE_COMMAND_ID,
  APPEARANCE_CLEAR_COMMAND_ID,
  APPEARANCE_REMOVE_LAYER_COMMAND_ID,
  APPEARANCE_MOVE_LAYER_COMMAND_ID,
  appearanceOf,
  withAppearance,
  bakeAppearanceMutations,
  commitAppearance,
  removeAppearanceLayer,
  moveAppearanceLayer,
  applyAppearanceEdit,
  applyAppearanceCommand,
  contributeAppearanceCommands,
  type AppearanceStack,
  type AppearanceKind,
  type AppearanceLayerKind,
  type FillLayer,
  type StrokeLayer,
} from "./commands/appearance";
// B-24 CLOSED — the GROUP BAKE: the metadata stack lowered onto real
// stacked page items (one derived path per paint, sharing the source
// geometry, wrapped in a group with the source frame as the carrier) and
// its exact inverse. Builders exported so the conformance spec asserts
// the EXACT wire shapes (the no-second-copy rule).
export {
  APPEARANCE_BAKE_COMMAND_ID,
  APPEARANCE_RELEASE_COMMAND_ID,
  APPEARANCE_BAKE_COMMAND_IDS,
  DRAW_METADATA_KEY,
  appearanceBakeOf,
  appearanceLayerOf,
  withAppearanceBake,
  appearanceBakeLayers,
  bakeGeometryOf,
  bakeInsertBatchFor,
  bakeLayerPaintFor,
  bakePaintBatchFor,
  releaseBatchFor,
  groupChildren,
  resolveAppearanceCarrier,
  bakeAppearance,
  releaseAppearance,
  rebakeAppearance,
  contributeAppearanceBakeCommands,
  type AppearanceBakeRecord,
  type AppearanceLayerMarker,
  type BakeGeometry,
  type BakeLayer,
  type BakeRefusal,
} from "./commands/appearance-bake";
// The APPEARANCE panel (React, the Layers-panel idiom) — the view over
// that stack, with the one-fill/one-stroke engine limit stated inline.
export {
  makeAppearancePanel,
  appearanceRowLabel,
  APPEARANCE_PANEL_ID,
  APPEARANCE_BAKE_NOTE,
} from "./panels/appearance-panel";
// Phase 9 (Tier B) — Select-same: the pure matcher + tree flattener,
// exported for the conformance spec.
export {
  SELECT_SAME_COMMAND_IDS,
  SELECT_SAME_COMMAND_CATEGORY,
  SELECT_SAME_FILL_COMMAND_ID,
  SELECT_SAME_STROKE_COMMAND_ID,
  SELECT_SAME_STROKE_WEIGHT_COMMAND_ID,
  pathForCriterion,
  valueForCriterion,
  leafIdsOf,
  selectSameMatches,
  contributeSelectSameCommands,
  type SelectSameCriterion,
} from "./commands/select-same";
// Phase 4c — the Line ends (arrowheads) panel section's binding +
// curated vocabulary, exported for the conformance spec.
export {
  BIND_ARROWHEAD_CONTROLS_VISIBLE,
  ARROWHEAD_OPTIONS,
} from "./panels/stroke-panel";
// Phase 8 — SVG interchange (K-2): the importer/exporter registration +
// the pure planning helpers (insert/style mutation builders), exported
// for the conformance specs (the no-second-copy rule).
export {
  contributeSvgIo,
  importSvg,
  exportSvg,
  shapesFromSvgBytes,
  insertPathMutationsForShape,
  styleDefaultsForShape,
  resolveTargetPage,
  SVG_IMPORTER_ID,
  SVG_EXPORTER_ID,
  SVG_MIME,
  type ShapeDefaults,
} from "./io/svg";
// Wave 2 — Eyedropper: the sample/apply pure halves + the module
// sample state, exported for the conformance spec (the no-second-copy
// rule).
export {
  createEyedropperHandler,
  sampledStyleFrom,
  applyStyleMutationFor,
  getEyedropperSample,
  clearEyedropperSample,
  type SampledStyle,
  type StyleApplyTarget,
} from "./handlers/eyedropper";
// Wave 2 — Width tool v0: the handler factory + the v0 profile
// constants (the widths bake through the brush module's exact
// outlineStrokeVariable builder above).
export {
  createWidthHandler,
  WIDTH_FALLOFF_ANCHORS,
  WIDTH_GAIN,
  WIDTH_MAX_PT,
} from "./handlers/width";
// Wave 2 — Lasso select: the handler factory + the pure centers-inside
// matcher, exported for the conformance spec.
export {
  createLassoSelectHandler,
  lassoMatches,
  itemCenterOnPage,
} from "./handlers/lasso";
// Wave 2 — the parametric insert-shape commands (v0 fixed defaults) +
// their exact-wire builders, exported for the conformance spec.
export {
  INSERT_SHAPE_COMMAND_IDS,
  INSERT_SHAPE_COMMAND_CATEGORY,
  INSERT_ARC_COMMAND_ID,
  INSERT_SPIRAL_COMMAND_ID,
  INSERT_RECT_GRID_COMMAND_ID,
  INSERT_POLAR_GRID_COMMAND_ID,
  INSERT_SHAPE_DEFAULTS,
  arcDefaultTable,
  spiralDefaultTable,
  rectGridDefaultTables,
  polarGridDefaultTables,
  insertTablesMutationFor,
  contributeInsertShapeCommands,
} from "./commands/insert-shapes";
// Wave 2 — Blend v0: the structure gate + the exact batch builder,
// exported for the conformance spec.
export {
  BLEND_COMMAND_ID,
  BLEND_COMMAND_CATEGORY,
  BLEND_STEPS,
  blendSourceFrom,
  blendStructureMatches,
  blendGeometryBatchFor,
  blendFillBatchFor,
  applyBlendSelected,
  contributeBlendCommand,
  type BlendSource,
  type BlendFillPlan,
} from "./commands/blend";
// Wave 2 — group-selection cycling: the pure tree-parentage resolver,
// exported for the conformance spec.
export {
  SELECT_PARENT_GROUP_COMMAND_ID,
  SELECT_PARENT_GROUP_COMMAND_CATEGORY,
  parentGroupOf,
  applySelectParentGroup,
  contributeSelectParentGroupCommand,
} from "./commands/select-parent-group";

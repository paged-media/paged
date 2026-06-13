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
export { PRO_TOOL_IDS, DRAW_TOOL_IDS } from "./tools";
export { insertPathMutationFor } from "./handlers/insert-path";
export { createCurvatureHandler } from "./handlers/curvature";
export { createPencilHandler } from "./handlers/pencil";
export {
  createMeasureHandler,
  nearestPathPointOnPage,
  BIND_MEASURE_READOUT,
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
export {
  JOIN_AVERAGE_COMMAND_IDS,
  JOIN_AVERAGE_COMMAND_CATEGORY,
  JOIN_COMMAND_ID,
  AVERAGE_COMMAND_ID,
  planJoinEndpoints,
  planAverageEndpoints,
  pathPointSetMutationFor,
  endpointMovesMutationFor,
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
// Phase 9 (Tier B) — Shape Builder gesture tool: the gesture→pathfinder
// plan builder + the host handler factory, exported for the conformance
// specs (the no-second-copy rule).
export {
  createShapeBuilderHandler,
  shapeBuilderMutationFor,
  pathfinderKindFor,
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
  appearanceOf,
  withAppearance,
  bakeAppearanceMutations,
  commitAppearance,
  contributeAppearanceCommands,
  type AppearanceStack,
  type FillLayer,
  type StrokeLayer,
} from "./commands/appearance";
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
  SVG_IMPORTER_ID,
  SVG_EXPORTER_ID,
  SVG_MIME,
  type ShapeDefaults,
} from "./io/svg";

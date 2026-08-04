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
  LIVE_PAINT_TOOL_IDS,
  TEXT_ON_PATH_TOOL_IDS,
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
// Illustrator Phase 2 — COMPOUND PATHS (Make / Release). The wire
// builders, the page-space contour reader and the appliers, exported
// for the conformance spec (the no-second-copy rule).
export {
  COMPOUND_PATH_COMMAND_IDS,
  COMPOUND_PATH_COMMAND_CATEGORY,
  MAKE_COMPOUND_PATH_COMMAND_ID,
  RELEASE_COMPOUND_PATH_COMMAND_ID,
  framePathMutationFor,
  makeCompoundBatchFor,
  releaseInsertBatchFor,
  releasePaintBatchFor,
  compoundSourceOf,
  compoundPaintOf,
  contourCountOf,
  tableInInnerSpace,
  applyMakeCompoundPath,
  applyReleaseCompoundPath,
  contributeCompoundPathCommands,
  type CompoundSource,
  type CompoundPaint,
} from "./commands/compound-path";
// Illustrator Phase 2 — PATTERN EDITING v1: a RE-EDITABLE tile FIELD,
// and deliberately NOT a pattern swatch (there is no pattern paint type
// in IDML, in the engine's Graphic model or on the wire — RFI C-31; see
// commands/pattern.ts). Real parameters (grid / brick / hex, size,
// spacing incl. negative overlap, overlap ORDER, copies, dimming), an
// artboard-aware tile count that closes v0's off-page residual, and a
// recipe in a `.paged` container part so a field can be re-planned,
// released or un-baked. Pure model + the exact wire builders exported
// for the conformance spec (the no-second-copy rule).
export {
  PATTERN_COMMAND_IDS,
  PATTERN_COMMAND_CATEGORY,
  MAKE_PATTERN_COMMAND_ID,
  EDIT_PATTERN_COMMAND_ID,
  SELECT_PATTERN_TILES_COMMAND_ID,
  DELETE_PATTERN_TILES_COMMAND_ID,
  RELEASE_PATTERN_COMMAND_ID,
  PATTERN_PART,
  PATTERN_LIBRARY_VERSION,
  PATTERN_FEATURE,
  PATTERN_LEGACY_FIELD,
  PATTERN_MAX_TILES,
  PATTERN_DEFAULTS,
  PATTERN_COLUMNS,
  PATTERN_ROWS,
  PATTERN_SPACING_PT,
  HEX_ROW_FACTOR,
  PATTERN_SWATCH_NOTE,
  patternParamsFrom,
  patternStepFor,
  orderPatternTiles,
  patternTilesFor,
  fitTilesToPage,
  patternCopiesFor,
  offsetTable,
  parsePatternLibrary,
  serializePatternLibrary,
  mintPatternId,
  findPatternField,
  upsertPatternField,
  removePatternFieldFrom,
  patternSourceOf,
  patternTileOf,
  withPatternKey,
  patternInsertBatchFor,
  bindPatternCopies,
  patternFinishBatchFor,
  patternReleaseBatchFor,
  patternDeleteBatchFor,
  readPatternLibrary,
  writePatternLibrary,
  patternPageRect,
  selectionBoundsOf,
  selectionTileSize,
  patternLinks,
  patternGroupOf,
  resolvePatternField,
  patternPlanFor,
  applyMakePattern,
  applyEditPattern,
  applySelectPatternTiles,
  applyDeletePatternTiles,
  applyReleasePattern,
  contributePatternCommands,
  type PatternLayout,
  type PatternOverlapOrder,
  type PatternParams,
  type PatternField,
  type PatternLibrary,
  type PatternSourceRef,
  type PatternTileRef,
  type PatternBounds,
  type PatternPageRect,
  type PatternTile,
  type PatternSource,
  type PatternPlan,
  type PatternCopy,
  type PatternCopyBinding,
} from "./commands/pattern";
// …and its PANEL — the editing MODE the catalog row asks for (the only
// half of that row this engine can carry). The note it renders is the
// hard boundary, pinned by conformance.
export {
  makePatternPanel,
  patternRowLabel,
  PATTERN_PANEL_ID,
  PATTERN_PANEL_NOTE,
} from "./panels/pattern-panel";
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
// B-22 — the shared PLANAR ARRANGEMENT seam (the escape-hatch read, the
// once-per-gesture cache, the refusal reporter, the engine's own caps),
// which Shape Builder and Live Paint both ride. Exported for the
// conformance specs so they drive the SAME door the tools do.
export {
  readPlanarRegions,
  reportPlanarRefusal,
  planarInputKey,
  createRegionCache,
  MAX_PLANAR_INPUTS,
  MAX_PLANAR_FACES,
  type RegionCache,
  type RegionCacheHooks,
} from "./handlers/planar-regions";
// Illustrator Phase 2 (the last unbuilt row) — LIVE PAINT v0:
// REGENERABLE, NOT LIVE. The engine has no LivePaintGroup node and no
// persistent face/edge ids — only a per-call planar query whose ids
// index into the ORDERED member list — so a group here is a recipe in a
// document container part and a painted face is real inserted artwork.
// Gap tolerance and edge stroking are NOT built and commands/live-paint.ts
// says exactly why. Pure model + the exact wire builders exported for the
// conformance spec (the no-second-copy rule).
export {
  LIVE_PAINT_COMMAND_IDS,
  LIVE_PAINT_COMMAND_CATEGORY,
  LIVE_PAINT_PART,
  LIVE_PAINT_LIBRARY_VERSION,
  LIVE_PAINT_FEATURE,
  LIVE_PAINT_KINDS,
  LIVE_PAINT_DEFAULT_FILL,
  BIND_LIVE_PAINT_FACE,
  MAKE_LIVE_PAINT_GROUP_COMMAND_ID,
  FILL_LIVE_PAINT_FACE_COMMAND_ID,
  REGENERATE_LIVE_PAINT_COMMAND_ID,
  SELECT_LIVE_PAINT_FACES_COMMAND_ID,
  DELETE_LIVE_PAINT_FACE_COMMAND_ID,
  RELEASE_LIVE_PAINT_COMMAND_ID,
  parseLivePaintLibrary,
  serializeLivePaintLibrary,
  mintLivePaintId,
  findLivePaintGroup,
  upsertLivePaintGroup,
  removeLivePaintGroupFrom,
  withLivePaintFace,
  withoutLivePaintFace,
  livePaintMemberOf,
  livePaintFillOf,
  withLivePaintKey,
  faceTableOf,
  livePaintContourCounts,
  bindLivePaintFaces,
  livePaintInsertBatchFor,
  livePaintFinishBatchFor,
  livePaintMemberBatchFor,
  livePaintReleaseBatchFor,
  livePaintDeleteBatchFor,
  readLivePaintLibrary,
  writeLivePaintLibrary,
  livePaintInputs,
  livePaintLinks,
  selectedLivePaintGroup,
  resolveLivePaintGroup,
  livePaintArrangement,
  livePaintFaceAt,
  emitLivePaintFills,
  fillLivePaintFaces,
  applyMakeLivePaintGroup,
  applyFillLivePaintFace,
  applyRegenerateLivePaint,
  applySelectLivePaintFaces,
  applyDeleteLivePaintFace,
  applyReleaseLivePaint,
  contributeLivePaintCommands,
  type LivePaintFaceRecord,
  type LivePaintRecipe,
  type LivePaintLibrary,
  type LivePaintMemberRef,
  type LivePaintFillRef,
  type LivePaintFacePlan,
  type LivePaintFillPlan,
  type LivePaintFaceBinding,
} from "./commands/live-paint";
// LIVE PAINT v0 — the two gesture tools (one handler factory, two
// commits) and the module-level bucket swatch the panel drives.
export {
  createLivePaintHandler,
  createLivePaintBucketHandler,
  createLivePaintSelectHandler,
  getLivePaintFill,
  setLivePaintFill,
  type LivePaintToolMode,
} from "./handlers/live-paint";
// The LIVE PAINT panel (React, the Layers / Appearance / Graphic Styles
// / Symbols idiom) — the recipe list, the per-face rows that make
// "select individual faces" reachable without a pointer, and the honest
// note stating regenerable-not-live, no gaps, no edges, the caps.
export {
  makeLivePaintPanel,
  livePaintRowLabel,
  LIVE_PAINT_PANEL_ID,
  LIVE_PAINT_NOTE,
} from "./panels/live-paint-panel";
// PROTOCOL 58 — the ONE place the v58 wire skew lives (the four C-28 /
// C-29 ops, their capability probes and their refusal reader). The
// typed contract for all four is committed in plugin-sdk `f00d6dd`;
// this repo installs the published 0.2.25-canary.0, so the cast stays
// until the canary bumps — and then deleting it is the whole change.
export {
  PATH_TYPE_ALIGNMENTS,
  FLIP_PATH_EFFECTS,
  applyOpacityMaskMutationFor,
  releaseOpacityMaskMutationFor,
  attachTextToPathMutationFor,
  detachTextFromPathMutationFor,
  v58RefusalReason,
  supportsOpacityMask,
  supportsTextOnPath,
  type OpacityMaskMode,
  type PathTypeAlignment,
  type FlipPathEffect,
  type TextPathSpec,
} from "./commands/v58-wire";
// Illustrator Phase 2 (the Transparency panel row) — OPACITY MASKS
// (C-28). EXPORT-ONLY today: honoured by the CPU rasterizer and by PDF
// export, NOT by the Vello/WebGPU backend the canvas draws through.
// `OPACITY_MASK_CANVAS_NOTE` is the pinned wording; the command title
// carries it too.
export {
  OPACITY_MASK_COMMAND_IDS,
  OPACITY_MASK_COMMAND_CATEGORY,
  MAKE_OPACITY_MASK_COMMAND_ID,
  RELEASE_OPACITY_MASK_COMMAND_ID,
  BIND_OPACITY_MASK_STATUS,
  OPACITY_MASK_CANVAS_NOTE,
  OPACITY_MASK_KINDS,
  DEFAULT_OPACITY_MASK_MODE,
  opacityMaskOf,
  withOpacityMaskKey,
  opacityMaskApplyBatchFor,
  opacityMaskReleaseBatchFor,
  resolveMaskTarget,
  opacityMaskLinks,
  applyMakeOpacityMask,
  applyReleaseOpacityMask,
  contributeOpacityMaskCommands,
  type OpacityMaskRef,
} from "./commands/opacity-mask";
// Illustrator/InDesign Phase 2 — TYPE ON A PATH (C-29): flow an
// EXISTING story along an EXISTING path. Every knob offered is one the
// renderer honours; `PathEffect` is deliberately absent.
export {
  TEXT_ON_PATH_COMMAND_IDS,
  TEXT_ON_PATH_COMMAND_CATEGORY,
  ATTACH_TEXT_TO_PATH_COMMAND_ID,
  DETACH_TEXT_FROM_PATH_COMMAND_ID,
  BIND_TEXT_ON_PATH_STATUS,
  BIND_TEXT_ON_PATH_STORY,
  TEXT_ON_PATH_KINDS,
  NO_FREE_STORY_NOTE,
  pathTypeAlignmentOf,
  flipPathEffectOf,
  textPathSpecOf,
  textOnPathOf,
  withTextOnPathKey,
  textOnPathAttachBatchFor,
  textOnPathDetachBatchFor,
  documentStories,
  textOnPathLinks,
  freeStories,
  resolvePathHost,
  resolveAttachStory,
  getTextOnPathStory,
  setTextOnPathStory,
  applyAttachTextToPath,
  applyDetachTextFromPath,
  contributeTextOnPathCommands,
  type TextOnPathRef,
  type StorySummaryLike,
} from "./commands/text-on-path";
// TYPE ON A PATH — the click tool (plain click attaches, alt+click
// detaches) and the pure host-kind refusal reader it pre-explains with.
export {
  createTypeOnPathHandler,
  pathHostRefusal,
  TYPE_ON_PATH_LABEL,
} from "./handlers/text-on-path";
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
  stampDrawMetadata,
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
// Illustrator Phase 2 — GRAPHIC STYLES: a named, LINKED complete
// appearance. The library is a `.paged` CONTAINER part (document-
// resident, so it travels with the file); the link is a reference on the
// element's own metadata envelope, and a direct appearance edit marks
// the element OVERRIDDEN without breaking it. Pure model + the exact
// wire builder exported for the conformance spec (the no-second-copy
// rule).
export {
  GRAPHIC_STYLES_COMMAND_IDS,
  GRAPHIC_STYLES_COMMAND_CATEGORY,
  GRAPHIC_STYLES_PART,
  GRAPHIC_STYLES_LIBRARY_VERSION,
  GRAPHIC_STYLES_FEATURE,
  GRAPHIC_STYLE_BASE_PATHS,
  EMPTY_GRAPHIC_STYLE_BASE,
  SAVE_GRAPHIC_STYLE_COMMAND_ID,
  APPLY_GRAPHIC_STYLE_COMMAND_ID,
  REDEFINE_GRAPHIC_STYLE_COMMAND_ID,
  BREAK_GRAPHIC_STYLE_LINK_COMMAND_ID,
  RENAME_GRAPHIC_STYLE_COMMAND_ID,
  DELETE_GRAPHIC_STYLE_COMMAND_ID,
  graphicStyleBaseOf,
  graphicStyleAppearanceOf,
  parseGraphicStyleLibrary,
  serializeGraphicStyleLibrary,
  mintGraphicStyleId,
  findGraphicStyle,
  upsertGraphicStyle,
  renameGraphicStyleIn,
  removeGraphicStyleFrom,
  projectGraphicAppearance,
  canonicalGraphicAppearance,
  graphicAppearanceDigest,
  graphicStyleRefOf,
  withGraphicStyleRef,
  graphicStyleOverridden,
  graphicStyleRefusalOf,
  graphicStyleBaseMutations,
  applyGraphicStyleBatchFor,
  readGraphicStyleLibrary,
  writeGraphicStyleLibrary,
  readGraphicAppearance,
  graphicStyleLinks,
  linkGraphicStyle,
  applySaveGraphicStyle,
  applyGraphicStyleToSelection,
  applyRedefineGraphicStyle,
  applyBreakGraphicStyleLink,
  applyRenameGraphicStyle,
  applyDeleteGraphicStyle,
  contributeGraphicStyleCommands,
  type GraphicStyle,
  type GraphicStyleAppearance,
  type GraphicStyleBase,
  type GraphicStyleLibrary,
  type GraphicStyleRef,
  type GraphicStyleRefusal,
  type GraphicAppearanceRead,
} from "./commands/graphic-styles";
// The GRAPHIC STYLES panel (React, the Layers/Appearance idiom) — the
// view over the library + the selection's link, with the not-undoable
// library and the unbuilt catalog verbs stated inline.
export {
  makeGraphicStylesPanel,
  graphicStyleRowLabel,
  GRAPHIC_STYLES_PANEL_ID,
  GRAPHIC_STYLES_NOTE,
} from "./panels/graphic-styles-panel";
// Illustrator Phase 2 (§16.1) — SYMBOLS v0: a named DEFINITION in a
// document-resident container part + INSTANCES re-emitted from it and
// stamped with a link. The engine has no symbol primitive and no
// element-duplicate op, so an instance is re-emitted geometry + flat
// paint — see commands/symbols.ts for the persistence shape, the
// measured undo counts and everything v0 deliberately does NOT build
// (the eight symbol-SET tools, nine-slice, 3D mapping). Pure model +
// the exact wire builders exported for the conformance spec (the
// no-second-copy rule).
export {
  SYMBOLS_COMMAND_IDS,
  SYMBOLS_COMMAND_CATEGORY,
  SYMBOLS_PART,
  SYMBOLS_LIBRARY_VERSION,
  SYMBOLS_FEATURE,
  SYMBOL_REGISTRATIONS,
  DEFAULT_SYMBOL_REGISTRATION,
  DEFINE_SYMBOL_COMMAND_ID,
  PLACE_SYMBOL_COMMAND_ID,
  REDEFINE_SYMBOL_COMMAND_ID,
  BREAK_SYMBOL_LINK_COMMAND_ID,
  RESET_SYMBOL_TRANSFORM_COMMAND_ID,
  RENAME_SYMBOL_COMMAND_ID,
  DELETE_SYMBOL_COMMAND_ID,
  parseAnchorTable,
  parseSymbolPaint,
  parseSymbolLibrary,
  serializeSymbolLibrary,
  mintSymbolId,
  mintSymbolInstanceId,
  findSymbol,
  upsertSymbol,
  renameSymbolIn,
  removeSymbolFrom,
  symbolBoundsOf,
  registrationPointOf,
  symbolDefinitionFrom,
  symbolInstanceOf,
  withSymbolInstance,
  symbolPlacePlanFor,
  symbolContourCounts,
  bindSymbolPieces,
  symbolInsertBatchFor,
  symbolFinishBatchFor,
  symbolUnlinkBatchFor,
  readSymbolLibrary,
  writeSymbolLibrary,
  symbolInstances,
  expandToLeaves,
  selectedSymbolInstances,
  liveInstanceOrigin,
  captureSymbolSources,
  emitSymbolInstance,
  applyDefineSymbol,
  applyPlaceSymbolInstance,
  applyRedefineSymbol,
  applyResetSymbolTransform,
  applyBreakSymbolLink,
  applyRenameSymbol,
  applyDeleteSymbol,
  contributeSymbolCommands,
  type SymbolRegistration,
  type SymbolPiece,
  type SymbolDefinition,
  type SymbolLibrary,
  type SymbolInstanceRef,
  type SymbolInstance,
  type SymbolPlacePlan,
  type SymbolPieceBinding,
  type SymbolReplacement,
} from "./commands/symbols";
// The SYMBOLS panel (React, the Layers / Appearance / Graphic Styles
// idiom) — the view over the library + whether the selection is an
// instance, with the not-undoable library and the unbuilt P2 symbol-set
// tools stated inline.
export {
  makeSymbolsPanel,
  symbolRowLabel,
  SYMBOLS_PANEL_ID,
  SYMBOLS_NOTE,
} from "./panels/symbols-panel";
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
// Illustrator Phase 2 (last row) — IMAGE TRACE v0: the wasm engine
// facade, the platform decoder, the pure plan + the exact wire builders.
// Exported for the conformance spec (the no-second-copy rule) — which
// boots the REAL artifact in Node and drives the REAL engine with a plan
// built from a REAL trace.
export {
  bootTraceEngine,
  wrapTraceEngine,
  traceBudget,
  DEFAULT_TRACE_PIXELS,
  TRACE_DEFAULTS,
  TRACE_ENGINE_NOT_BUILT,
  type TraceEngine,
  type TraceLimits,
  type TraceOptions,
  type TraceAnchor,
  type TraceContour,
  type TraceRegion,
  type TraceResult,
} from "./trace-engine";
export {
  decodeRasterBytes,
  decodeScaleFor,
  decodeSizeFor,
  rasterDecoderAvailable,
  RASTER_DECODER_UNAVAILABLE,
  type DecodedRaster,
} from "./io/raster-decode";
export {
  IMAGE_TRACE_COMMAND_ID,
  IMAGE_TRACE_COMMAND_IDS,
  IMAGE_TRACE_COMMAND_CATEGORY,
  IMAGE_TRACE_COMMAND_TITLE,
  TRACE_SLOW_PIXELS,
  imageTraceOf,
  withImageTrace,
  pixelToPageAffine,
  regionTableFor,
  tracePlanFor,
  traceOptionsFrom,
  traceSwatchMutationFor,
  traceInsertBatchFor,
  bindTraceRegions,
  traceFinishBatchFor,
  applyImageTrace,
  applyImageTracePlan,
  contributeImageTraceCommand,
  type ImageTraceRecord,
  type TracePlan,
  type TracePlanRegion,
  type TraceRegionBinding,
} from "./commands/image-trace";
// Wave 2 — group-selection cycling: the pure tree-parentage resolver,
// exported for the conformance spec.
export {
  SELECT_PARENT_GROUP_COMMAND_ID,
  SELECT_PARENT_GROUP_COMMAND_CATEGORY,
  parentGroupOf,
  applySelectParentGroup,
  contributeSelectParentGroupCommand,
} from "./commands/select-parent-group";

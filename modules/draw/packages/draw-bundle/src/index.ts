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
// W3.2 — the vectorGraphic edit context (closes B-02), exported for the
// conformance spec.
export {
  vectorGraphicEditContext,
  VECTOR_GRAPHIC_CONTEXT,
} from "./edit-context";
// The B-04 GROUP wire shapes, composed by Pattern / Symbols / Image
// Trace and exported for the conformance spec. The user-facing Group /
// Ungroup COMMANDS are the host's now (`paged.object.*`) — see
// commands/group.ts.
export {
  clipGroupMutationFor,
  groupMutationFor,
  ungroupMutationFor,
} from "./commands/group";
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
  REPEAT_TOOL_IDS,
  CUT_TOOL_IDS,
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
  nibFromOptions,
  eraserNibFromOptions,
} from "./handlers/brush";
// TOOL OPTIONS — the per-tool definitions (the contract's spec plus the
// defaults it has no room for), the one structural probe for the host's
// undeclared tool-settings store, and the live reader the handlers use.
export {
  TOOL_OPTIONS,
  PAINTBRUSH_OPTIONS,
  BLOB_BRUSH_OPTIONS,
  ERASER_OPTIONS,
  WIDTH_OPTIONS,
  LASSO_OPTIONS,
  defineToolOptions,
  toolOptionsSpecOf,
  toolSettingsDoorOf,
  createToolOptionsReader,
  type ToolOptionsDef,
  type ToolOptionsReader,
  type ToolSettingsDoor,
  type OptionDef,
  type NumberOption,
  type SelectOption,
} from "./tool-options";
export { createCurvatureHandler } from "./handlers/curvature";
// THE RAW WIRE — the one guarded seam over the `host.editor.client.send`
// hatch (the facade gaps it covers are named in the module).
export {
  hasRawWire,
  rawRead,
  rawGradientDetail,
  type RawRequest,
  type GradientDetailWire,
  type GradientStopWire,
} from "./raw-wire";
// THE KNIFE — the freehand cut over the engine's planar arrangement: the
// probe/withdraw/cut flow, its pure halves (the pieces read off the
// faces, the one cut batch) and the gesture handler.
export {
  applyKnife,
  faceTable,
  knifeBatchFor,
  knifeCandidates,
  knifePieceHandle,
  knifePiecesFrom,
  knifeStripBatchFor,
  knifeStripHandle,
  knifeTargetOf,
  KNIFE_MIN_PIECE_AREA_PT2,
  KNIFE_SNAP_TOLERANCE_PT,
  KNIFE_STRIP_WIDTH_PT,
  type KnifePlan,
  type KnifeResult,
  type KnifeSkip,
  type KnifeTarget,
} from "./commands/knife";
export { createKnifeHandler, type KnifeHandlerOptions } from "./handlers/knife";
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
  type PathOpPayload,
  type PathOpsLastUsed,
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
// Reverse path direction — the per-contour reversal over vector-geometry's
// `reverseContour` and its one-batch framePath write, exported for the
// conformance spec (the no-second-copy rule).
export {
  REVERSE_PATH_COMMAND_ID,
  REVERSE_PATH_COMMAND_IDS,
  REVERSE_PATH_COMMAND_CATEGORY,
  reverseTable,
  tableOf as reversePathTableOf,
  reversePathBatchFor,
  applyReversePath,
  contributeReversePathCommands,
} from "./commands/reverse-path";
// Create outlines (protocol 66, RFI C-69) — the batch builder and its
// swatch rule, exported for the conformance spec.
export {
  CREATE_OUTLINES_COMMAND_ID,
  CREATE_OUTLINES_COMMAND_IDS,
  applyCreateOutlines,
  createOutlinesBatchFor,
  outlineSwatchFor,
  outlineTableOf,
  contributeCreateOutlinesCommands,
} from "./commands/create-outlines";
// Object ▸ Rasterize (extensions ADR 338) — the batch, the parameters and
// what a selection removes, exported for the conformance spec.
export {
  RASTERIZE_COMMAND_ID,
  RASTERIZE_DEFAULTS,
  applyRasterize,
  contributeRasterizeCommand,
  pngDataUri,
  rasterizeBatchFor,
  rasterizeParamsFrom,
  removalOf,
  type RasterizeParams,
} from "./commands/rasterize";
export { rawTextOutlines, type TextOutlinesWire } from "./raw-wire";
export { pathfinderMutationFor } from "./commands/pathfinder";
// B-22 (engine v57) — the shared region-Pathfinder wire builders (the
// commands are the host's) and the
// refusal reader, exported for the conformance spec (no second copy to
// drift from).
export {
  BIND_PATHFINDER_STATUS,
  pathfinderRegionMutationFor,
  pathfinderFacesMutationFor,
  paintOrderLeaves,
  orderTopToBottom,
  backmostIndexOf,
  selectionTopToBottom,
  regionRefusalReason,
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
  backmostContourOf,
  makeCompoundTableByPaintOrder,
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
  SAVE_PATTERN_SWATCH_COMMAND_ID,
  PATTERN_PART,
  PATTERN_LIBRARY_VERSION,
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
  applySavePatternSwatch,
  patternSwatchSpecFor,
  patternSwatchIdFor,
  contributePatternCommands,
  type PatternSwatchSpec,
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
// …and its PANEL — pattern editing mode: the copies preview the tile,
// Save swatch / Done write the engine pattern swatch (WP6.9, engine ADR
// 1041). The note it renders is pinned by conformance.
export {
  makePatternPanel,
  patternRowLabel,
  PATTERN_PANEL_ID,
  PATTERN_PANEL_NOTE,
} from "./panels/pattern-panel";
// Illustrator Phase 3 (§12.4) — REPEATS: radial / grid / mirror repeat
// objects with instance counts, spacing, clipping and EXPAND/RELEASE.
// The catalog's sibling of pattern, not the same thing: a pattern is a
// swatch-shaped FILL, a repeat is an object TRANSFORM. The first feature
// in this repo that builds in ONE undo step (C-15 `bindCreated` is in
// the contract as of plugin-sdk `bc52766`), clipped or not (a clip group,
// engine ADR 1010). Pure model + the exact wire builders
// exported for the conformance spec (the no-second-copy rule).
export {
  REPEAT_COMMAND_IDS,
  REPEAT_COMMAND_CATEGORY,
  MAKE_RADIAL_REPEAT_COMMAND_ID,
  MAKE_GRID_REPEAT_COMMAND_ID,
  MAKE_MIRROR_REPEAT_COMMAND_ID,
  UPDATE_REPEAT_COMMAND_ID,
  SELECT_REPEAT_INSTANCES_COMMAND_ID,
  EXPAND_REPEAT_COMMAND_ID,
  RELEASE_REPEAT_COMMAND_ID,
  REPEAT_PART,
  REPEAT_LIBRARY_VERSION,
  REPEAT_MAX_INSTANCES,
  REPEAT_DEFAULTS,
  REPEAT_KINDS,
  REPEAT_CLIP_HANDLE,
  REPEAT_LIVE_NOTE,
  REPEAT_CLIP_NOTE,
  repeatParamsFrom,
  repeatPlacementsFor,
  radialCenterOfDraft,
  mirrorDefaultOffset,
  repeatCopiesFor,
  repeatHandle,
  handleRef,
  parseRepeatLibrary,
  serializeRepeatLibrary,
  mintRepeatId,
  findRepeatRecord,
  upsertRepeatRecord,
  removeRepeatRecordFrom,
  repeatSourceOf,
  repeatInstanceOf,
  repeatClipOf,
  withRepeatKey,
  repeatBatchFor,
  repeatExpandBatchFor,
  repeatReleaseBatchFor,
  readRepeatLibrary,
  writeRepeatLibrary,
  repeatPageRect,
  repeatBoundsOf,
  repeatLinks,
  repeatGroupOf,
  resolveRepeat,
  repeatGenerationOf,
  repeatPlanFor,
  applyMakeRepeat,
  applyUpdateRepeat,
  applySelectRepeatInstances,
  applyExpandRepeat,
  applyReleaseRepeat,
  contributeRepeatCommands,
  type RepeatParams,
  type RepeatRecord,
  type RepeatLibrary,
  type RepeatSourceRef,
  type RepeatInstanceRef,
  type RepeatClipRef,
  type RepeatKey,
  type RepeatPageRect,
  type RepeatSource,
  type RepeatPlan,
  type RepeatCopy,
  type RepeatGeneration,
  type RepeatBuild,
} from "./commands/repeat";
// …and its PANEL + its on-canvas widget. The panel's note is where the
// two honesty facts reach the user (what "live" means; what clipping
// costs); the handler is where they hold.
export {
  makeRepeatPanel,
  repeatRowLabel,
  REPEAT_PANEL_ID,
  REPEAT_PANEL_NOTE,
} from "./panels/repeat-panel";
export { createRepeatHandler } from "./handlers/repeat";
// C-15 batch handles — `bindCreated` (what collapses a two-batch flow
// into one undo step) — and the B-18 `pasteInto` / `releaseFrom` nesting
// pair addressed through them.
export {
  batchMutationFor,
  bindCreatedMutationFor,
  handleElementId,
  pasteIntoMutationFor,
  releaseFromMutationFor,
  HANDLE_PREFIX,
} from "./commands/batch-handles";
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
// The C-29 type-on-a-path ops: their builders (exported for the
// conformance specs) and the engine's refusal reader.
export {
  PATH_TYPE_ALIGNMENTS,
  FLIP_PATH_EFFECTS,
  attachTextToPathMutationFor,
  detachTextFromPathMutationFor,
  type PathTypeAlignment,
  type FlipPathEffect,
  type TextPathSpec,
} from "./commands/text-on-path";
export { maskOrPathRefusalReason } from "./commands/refusal";
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
  supportsLiveCorners,
  cornerStyleMutationFor,
  type CornerStyleToken,
} from "./commands/live-corners";
// Phase 9 (Tier B) — Appearance model: the stack model + bake builders +
// envelope round-trip helpers, exported for the conformance spec.
export {
  appearanceOf,
  withAppearance,
  bakeAppearanceMutations,
  commitAppearance,
  type AppearanceStack,
  type AppearanceLayerKind,
  type FillLayer,
  type StrokeLayer,
} from "./commands/appearance";
// paged.draw's in-batch metadata stamp, and the READ side of draw ADR
// 354's legacy group bakes (the bake itself is gone: native appearance).
export { DRAW_METADATA_KEY, stampDrawMetadata } from "./commands/draw-metadata";
export {
  appearanceBakeOf,
  appearanceLayerOf,
  withAppearanceBake,
  bakedLayersOf,
  releaseBatchFor,
  releaseBakedWithStack,
  groupChildren,
  resolveAppearanceCarrier,
  type AppearanceBakeRecord,
  type AppearanceLayerMarker,
} from "./commands/appearance-legacy";
// Engine ADR 1043 — the metadata stack's migration to the engine's native
// appearance (the switch of the commands and panel is plan WP6.3).
export {
  nativeAppearanceOf,
  migrateAppearanceMutations,
  type NativePaintLayer,
  APPEARANCE_KINDS,
  layersOfValue,
  readNativeAppearance,
  explicitLayers,
  appearanceMutation,
} from "./commands/appearance-native";
export {
  graphicStyleFileOf,
  parseGraphicStyleFile,
  importStylesInto,
  mergeGraphicStyles,
  importGraphicStyles,
  exportGraphicStyles,
  mergeGraphicStylesIn,
  IMPORT_GRAPHIC_STYLES_COMMAND_ID,
  EXPORT_GRAPHIC_STYLES_COMMAND_ID,
  MERGE_GRAPHIC_STYLES_COMMAND_ID,
  GRAPHIC_STYLE_LIBRARY_COMMAND_IDS,
} from "./commands/graphic-styles-native";
export {
  migrateAppearanceStacks,
  installAppearanceMigration,
  type AppearanceMigration,
} from "./commands/appearance-migrate";
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
// SYMBOLS — the commands (on the engine's symbols, engine ADR 1039) and
// the v0 library model a document made before them carries, with the
// wire builders its migration emits (commands/symbols.ts).
export {
  SYMBOLS_COMMAND_IDS,
  SYMBOLS_COMMAND_CATEGORY,
  SYMBOLS_PART,
  SYMBOLS_LIBRARY_VERSION,
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
  registrationPointOf,
  symbolInstanceOf,
  symbolPlacePlanFor,
  symbolContourCounts,
  symbolFinishBatchFor,
  readSymbolLibrary,
  writeSymbolLibrary,
  symbolInstances,
  applyDefineSymbol,
  applyPlaceSymbolInstance,
  applyRedefineSymbol,
  applyResetSymbolTransform,
  applyBreakSymbolLink,
  applyRenameSymbol,
  applyDeleteSymbol,
  applyReplaceSymbol,
  applySymbolOptions,
  REPLACE_SYMBOL_COMMAND_ID,
  SYMBOL_OPTIONS_COMMAND_ID,
  BIND_SYMBOL_OPTIONS_FOCUS,
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
// idiom) — the view over the document's symbols + the instances the
// selection holds.
export {
  makeSymbolsPanel,
  symbolRowLabel,
  SYMBOLS_PANEL_ID,
  SYMBOLS_NOTE,
} from "./panels/symbols-panel";
// WP6.8 (draw ADR 365) — live symbols on the engine node: the Symbolism
// tools' document lane, the instance reads, Replace Symbol, Symbol
// Options, and the migration of a v0 library onto engine symbols.
export {
  symbolismScope,
  symbolismBatchFor,
  writeSymbolism,
  symbolBox,
  type SymbolismScope,
} from "./commands/symbolism";
export {
  readEngineSymbols,
  readInstanceStates,
  engineInstanceIds,
  chooseSymbol,
  currentSymbol,
  engineReplaceSymbol,
  engineSymbolOptions,
  type EngineSymbol,
  type InstanceState,
} from "./commands/symbols-engine";
export { createSymbolismHandler } from "./handlers/symbolism";
export { createNineSliceHandler } from "./handlers/nine-slice";
// Phase 9 (Tier B) — Select-same: the pure matcher + tree flattener,
// exported for the conformance spec.
export {
  SELECT_SAME_COMMAND_IDS,
  SELECT_SAME_COMMAND_CATEGORY,
  SELECT_SAME_FILL_COMMAND_ID,
  SELECT_SAME_STROKE_COMMAND_ID,
  SELECT_SAME_STROKE_WEIGHT_COMMAND_ID,
  SELECT_SAME_OPACITY_COMMAND_ID,
  SELECT_SAME_BLEND_MODE_COMMAND_ID,
  SELECT_SAME_APPEARANCE_COMMAND_ID,
  SELECT_SAME_GRAPHIC_STYLE_COMMAND_ID,
  SELECT_SAME_SYMBOL_COMMAND_ID,
  SELECT_SAME_SHAPE_KIND_COMMAND_ID,
  pathForCriterion,
  valueForCriterion,
  leafIdsOf,
  selectSameMatches,
  applySelectSameStrokeWeight,
  strokeWeightToleranceOf,
  STROKE_WEIGHT_EPSILON,
  MAX_STROKE_WEIGHT_TOLERANCE,
  contributeSelectSameCommands,
  type PaintCriterion,
  type SelectSameCriterion,
} from "./commands/select-same";
// WP6.1 — Global Edit: select by geometry (vector-geometry's `sameShape`).
export {
  GLOBAL_EDIT_COMMAND_ID,
  GLOBAL_EDIT_COMMAND_IDS,
  MAX_GLOBAL_EDIT_TOLERANCE,
  applyGlobalEdit,
  contributeGlobalEditCommand,
  globalEditMatches,
  globalEditOptionsOf,
  type GlobalEditOptions,
} from "./commands/global-edit";
// Interchange (draw ADR 364): SVG, DXF, Illustrator and EPS through the
// engine's SVG doors and paged.pdf's placement — registration and the
// import/export functions, exported for the conformance specs.
export {
  contributeSvgIo,
  importSvg,
  importSvgFile,
  exportSvg,
  SVG_IMPORTER_ID,
  SVG_EXPORTER_ID,
  SVG_MIME,
  MAX_SVG_BYTES,
  type SvgFileImport,
} from "./io/svg";
export {
  contributeDxfIo,
  importDxf,
  exportDxf,
  DXF_IMPORTER_ID,
  DXF_EXPORTER_ID,
} from "./io/dxf";
export {
  contributeVectorFileImporters,
  importAi,
  importEps,
  epsBoundingBox,
  epsPlacementFor,
  AI_IMPORTER_ID,
  EPS_IMPORTER_ID,
  PDF_PLACE_VECTORS,
} from "./io/vector-files";
export {
  bootInterchange,
  type InterchangeEngine,
  type InterchangeReport,
  type DxfImport,
  type DxfExport,
} from "./interchange-wasm";
export { insertPathMutationsForShape, resolveTargetPage } from "./target-page";
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
  lassoIntersections,
  lassoTouchesOutline,
  outlineOfPath,
  outlineOfBounds,
  readLassoOutlines,
  type LassoMode,
  type LassoOutline,
} from "./handlers/lasso";
// Wave 2 — the parametric insert-shape commands (the v0 defaults, the
// typed payload each now takes, the count ceilings) + their exact-wire
// builders, exported for the conformance spec.
export {
  INSERT_SHAPE_COMMAND_IDS,
  INSERT_SHAPE_COMMAND_CATEGORY,
  INSERT_ARC_COMMAND_ID,
  INSERT_SPIRAL_COMMAND_ID,
  INSERT_RECT_GRID_COMMAND_ID,
  INSERT_POLAR_GRID_COMMAND_ID,
  INSERT_SHAPE_DEFAULTS,
  INSERT_SHAPE_LIMITS,
  ARC_PARAM_DEFAULTS,
  SPIRAL_PARAM_DEFAULTS,
  RECT_GRID_PARAM_DEFAULTS,
  POLAR_GRID_PARAM_DEFAULTS,
  arcDefaultTable,
  spiralDefaultTable,
  rectGridDefaultTables,
  polarGridDefaultTables,
  arcParamsFrom,
  spiralParamsFrom,
  rectGridParamsFrom,
  polarGridParamsFrom,
  arcTablesFor,
  spiralTablesFor,
  rectGridTablesFor,
  polarGridTablesFor,
  applyInsertArc,
  applyInsertSpiral,
  applyInsertRectGrid,
  applyInsertPolarGrid,
  insertTablesMutationFor,
  contributeInsertShapeCommands,
  type ArcParams,
  type SpiralParams,
  type RectGridParams,
  type PolarGridParams,
  type InsertShapePayload,
  type InsertShapeLastUsed,
} from "./commands/insert-shapes";
// PATH OPTIONS — the parameters behind the menu's "…": the per-section
// values + defaults, the last-used store, the seven commands that RAISE
// the panel at a section, and the panel itself. Exported for the render
// spec (the no-second-copy rule).
export {
  PATH_OPTIONS_PANEL_ID,
  PATH_OPTIONS_COMMAND_IDS,
  PATH_OPTIONS_COMMANDS,
  PATH_OPTIONS_COMMAND_CATEGORY,
  PATH_OPTIONS_DEFAULTS,
  PATH_OPTIONS_STORAGE_KEY,
  PATH_OPTION_SECTIONS,
  PATH_OPTION_SECTION_TITLES,
  BIND_PATH_OPTIONS_FOCUS,
  OPEN_PANEL_FEATURE,
  FROM_ELEMENT,
  OFFSET_JOIN_NOTE,
  SELECTION_SECTIONS,
  sanitizePathOptions,
  lastUsedPathOptions,
  lastUsedPayload,
  hasLastUsed,
  rememberPathOptions,
  applyPathOptions,
  offsetPayloadOf,
  simplifyPayloadOf,
  outlineStrokePayloadOf,
  pathOptionsFocusOf,
  showPathOptions,
  openPathOptions,
  contributePathOptionsCommands,
  type PathOptions,
  type PathOptionSection,
  type PathOptionsFocus,
  type OffsetOptions,
  type SimplifyOptions,
  type OutlineStrokeOptions,
  type SelectSameWeightOptions,
} from "./commands/path-options";
export {
  makePathOptionsPanel,
  ownStrokeLabel,
  SIMPLIFY_PREVIEW_ENGINE_NOTE,
  PATH_OPTIONS_PANEL_NOTE,
  SELECT_SAME_TOLERANCE_NOTE,
  WIDTH_PROFILE_SECTION_NOTE,
  RASTERIZE_SECTION_NOTE,
} from "./panels/path-options-panel";
// Illustrator Phase 3 (§16.2) — BLENDS v1: the three SPACING MODES
// (Smooth Color derives its count from the colour distance, Specified
// Steps is a count, Specified Distance divides the SPINE's arc length),
// the spine and its two reverses, easing with independent colour
// acceleration, and expand/release. The SECOND consumer of C-15's
// `bindCreated`, so every verb is ONE undo step. Pure model + the exact
// wire builders exported for the conformance spec (the no-second-copy
// rule). `blendSourceFrom` / `blendStructureMatches` are v0's and are
// unchanged.
export {
  BLEND_COMMAND_IDS,
  BLEND_COMMAND_ID,
  UPDATE_BLEND_COMMAND_ID,
  REPLACE_BLEND_SPINE_COMMAND_ID,
  REVERSE_BLEND_SPINE_COMMAND_ID,
  REVERSE_BLEND_ORDER_COMMAND_ID,
  SELECT_BLEND_OBJECTS_COMMAND_ID,
  EXPAND_BLEND_COMMAND_ID,
  RELEASE_BLEND_COMMAND_ID,
  BLEND_COMMAND_CATEGORY,
  BLEND_STEPS,
  BLEND_MAX_STEPS,
  BLEND_PART,
  BLEND_LIBRARY_VERSION,
  BLEND_DEFAULTS,
  BLEND_SPACINGS,
  BLEND_ORIENTATIONS,
  BLEND_LIVE_NOTE,
  BLEND_SPINE_NOTE,
  blendSourceFrom,
  blendStructureMatches,
  blendSourceBounds,
  blendSourceCenter,
  blendParamsFrom,
  smoothColorSteps,
  blendStepCountFor,
  defaultSpineFor,
  blendStepsFor,
  blendStepBounds,
  blendHandle,
  resetBlendSwatchSeq,
  parseBlendLibrary,
  serializeBlendLibrary,
  mintBlendId,
  findBlendRecord,
  upsertBlendRecord,
  removeBlendRecordFrom,
  blendKeyOf,
  blendStepOf,
  blendSpineOf,
  withBlendKey,
  blendBatchFor,
  blendExpandBatchFor,
  blendReleaseBatchFor,
  readBlendLibrary,
  writeBlendLibrary,
  blendKeyOfElement,
  blendLinks,
  blendGroupOf,
  resolveBlend,
  blendGenerationOf,
  blendPlanFor,
  applyMakeBlend,
  applyUpdateBlend,
  applyReplaceBlendSpine,
  applyReverseBlendSpine,
  applyReverseBlendOrder,
  applySelectBlendObjects,
  applyExpandBlend,
  applyReleaseBlend,
  contributeBlendCommands,
  blendKeysOfSelection,
  blendGroupLeaves,
  blendRampsOf,
  flatKeysOf,
  type BlendGradient,
  type BlendSource,
  type BlendSpacing,
  type BlendOrientation,
  type BlendParams,
  type BlendRecord,
  type BlendLibrary,
  type BlendKeyRef,
  type BlendStepRef,
  type BlendSpineRef,
  type BlendKeyName,
  type BlendStepCount,
  type BlendKey,
  type BlendStep,
  type BlendPlan,
  type BlendGeneration,
  type BlendBuild,
} from "./commands/blend";
// …and its PANEL. The panel is where the catalog's "live preview" is put
// in front of the user as exactly what it is — a preview of the PLAN.
export {
  makeBlendPanel,
  blendRowLabel,
  BLEND_PANEL_ID,
  BLEND_PANEL_NOTE,
} from "./panels/blend-panel";
// Illustrator Phase 3 (§16.3) — OBJECTS ON A PATH: the one arranging row
// in this bundle that CREATES NOTHING. It writes one `frameTransform`
// per object, so the objects on the path ARE the ones you selected —
// their ids survive, text is not refused, and Release restores each
// object's remembered home transform exactly. Shares §16.2's arc-length
// placement kernel and nothing above it.
export {
  OBJECTS_ON_PATH_COMMAND_IDS,
  OBJECTS_ON_PATH_COMMAND_CATEGORY,
  MAKE_OBJECTS_ON_PATH_COMMAND_ID,
  UPDATE_OBJECTS_ON_PATH_COMMAND_ID,
  SELECT_OBJECTS_ON_PATH_COMMAND_ID,
  EXPAND_OBJECTS_ON_PATH_COMMAND_ID,
  RELEASE_OBJECTS_ON_PATH_COMMAND_ID,
  OBJECTS_ON_PATH_PART,
  OBJECTS_ON_PATH_LIBRARY_VERSION,
  OBJECTS_ON_PATH_MAX,
  OBJECTS_ON_PATH_DEFAULTS,
  OBJECTS_ON_PATH_NOTE,
  ON_PATH_DISTRIBUTIONS,
  ON_PATH_PIVOTS,
  affineFrom,
  objectsOnPathParamsFrom,
  orderedIndices,
  onPathHullOf,
  placeObjectsOnPath,
  parseObjectsOnPathLibrary,
  serializeObjectsOnPathLibrary,
  mintObjectsOnPathId,
  findObjectsOnPathRecord,
  upsertObjectsOnPathRecord,
  removeObjectsOnPathRecordFrom,
  onPathObjectOf,
  onPathSpineOf,
  withOnPathKey,
  frameTransformMutationFor,
  objectsOnPathBatchFor,
  objectsOnPathReleaseBatchFor,
  objectsOnPathExpandBatchFor,
  readObjectsOnPathLibrary,
  writeObjectsOnPathLibrary,
  readOnPathObject,
  readOnPathSpine,
  objectsOnPathLinks,
  resolveObjectsOnPath,
  objectsOnPathPlanFor,
  applyMakeObjectsOnPath,
  applyUpdateObjectsOnPath,
  applySelectObjectsOnPath,
  applyExpandObjectsOnPath,
  applyReleaseObjectsOnPath,
  contributeObjectsOnPathCommands,
  type OnPathDistribute,
  type OnPathPivot,
  type ObjectsOnPathParams,
  type OnPathObjectRecord,
  type ObjectsOnPathRecord,
  type ObjectsOnPathLibrary,
  type OnPathObjectRef,
  type OnPathSpineRef,
  type OnPathKey,
  type OnPathObject,
  type OnPathPlacement,
  type ObjectsOnPathPlan,
} from "./commands/objects-on-path";
export {
  makeObjectsOnPathPanel,
  objectsOnPathRowLabel,
  OBJECTS_ON_PATH_PANEL_ID,
  OBJECTS_ON_PATH_PANEL_NOTE,
} from "./panels/objects-on-path-panel";
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
  tracedRegionOf,
  withImageTrace,
  pixelToPageAffine,
  imagePlacementOf,
  visibleRasterRect,
  cropRaster,
  regionTableFor,
  tracePlanFor,
  traceOptionsFrom,
  traceSwatchMutationFor,
  traceInsertBatchFor,
  traceContourHandle,
  traceHandleBindings,
  bindTraceRegions,
  traceFinishBatchFor,
  traceBatchFor,
  applyImageTrace,
  applyImageTracePlan,
  applyRetraceImage,
  retraceSourceOf,
  traceGenerationOf,
  strokeTableFor,
  tracePresetFrom,
  contributeImageTraceCommand,
  RETRACE_IMAGE_COMMAND_ID,
  IMAGE_TRACE_OPTIONS_COMMAND_ID,
  IMAGE_TRACE_PANEL_ID,
  type TraceGeneration,
  type ImageTraceRecord,
  type ImagePlacement,
  type LinkRow,
  type TracedRegionMarker,
  type TracePlan,
  type TracePlanRegion,
  type TraceRegionBinding,
} from "./commands/image-trace";
// WP6.6 — Image Trace PRESETS (Illustrator's names → the kernel's
// options) and the LIVE re-trace on a link change.
export {
  TRACE_PRESET_IDS,
  TRACE_PRESET_NAMES,
  isTracePreset,
  tracePresetOptions,
  presetMatching,
  type TracePresetId,
} from "./commands/trace-presets";
export {
  contributeLiveRetrace,
  liveRetraceOf,
  linkPrintsOf,
  changedLinks,
  type LiveRetrace,
} from "./commands/image-trace-live";
export {
  makeImageTracePanel,
  IMAGE_TRACE_PANEL_NOTE,
} from "./panels/image-trace-panel";
// WP8.3 — TEXT TO VECTOR and GENERATIVE RECOLOR (the agent and ml doors).
export {
  TEXT_TO_VECTOR_COMMAND_ID,
  GENERATIVE_RECOLOR_COMMAND_ID,
  TEXT_TO_VECTOR_OPTIONS_COMMAND_ID,
  GENERATIVE_RECOLOR_OPTIONS_COMMAND_ID,
  GENERATIVE_COMMAND_IDS,
  GENERATIVE_PANEL_ID,
  AGENT_COMPLETE_COMMAND,
  applyTextToVector,
  applyGenerativeRecolor,
  textToVectorByAgent,
  textToVectorByImage,
  svgPromptFor,
  extractSvg,
  svgRefusal,
  recolorPromptFor,
  parseColorMap,
  type GenerativeOutcome,
  type GenerativeRecolorOutcome,
  type GenerativeRoute,
} from "./commands/generative";
export { makeGenerativePanel } from "./panels/generative-panel";
// WP6.5 — RECOLOR ARTWORK (the Color Guide is the host's).
export {
  RECOLOR_ARTWORK_COMMAND_ID,
  RECOLOR_ARTWORK_OPTIONS_COMMAND_ID,
  RECOLOR_COMMAND_IDS,
  RECOLOR_PANEL_ID,
  RECOLOR_DEFAULTS,
  RECOLOR_MODES,
  readArtworkColors,
  selectionLeaves,
  recolorRequestFrom,
  recolorTargetsFor,
  recolorBatchFor,
  recolorLibraryOf,
  requestHarmony,
  harmonyBaseOf,
  applyRecolorArtwork,
  contributeRecolorCommands,
  type ArtworkColor,
  type ArtworkRead,
  type PaintSlot,
  type RecolorTarget,
  type RecolorMode,
  type RecolorRequest,
  type RecolorMint,
  type RecolorPlan,
  type RecolorOutcome,
} from "./commands/recolor";
export { makeRecolorPanel, RECOLOR_PANEL_NOTE } from "./panels/recolor-panel";
// WP6.4 — brushes and width profiles as live stroke styles (engine ADR
// 1053, draw ADR 366).
export {
  APPLY_BRUSH_COMMAND_ID,
  APPLY_WIDTH_PROFILE_COMMAND_ID,
  BRUSH_COMMAND_IDS,
  BRUSH_LIBRARIES,
  BRUSH_LIBRARY_PART,
  BRUSH_OPTIONS_COMMAND_ID,
  BRUSH_TYPES,
  BRUSHES_COMMAND_ID,
  BRUSHES_PANEL_ID,
  BUILTIN_BRUSHES,
  DEFAULT_BRUSH_OPTIONS,
  NEW_BRUSH_COMMAND_ID,
  REMOVE_BRUSH_COMMAND_ID,
  applyBrush,
  applyWidthProfileStyle,
  brushArtOf,
  brushEntryFor,
  newBrushFromSelection,
  removeBrush,
  setBrushOptions,
  stackMutationFor,
  widthProfileEntryFor,
  withStrokeStyle,
  type BrushArt,
  type BrushDef,
  type BrushOptions,
  type BrushType,
} from "./commands/brushes";
export { makeBrushesPanel, BRUSHES_PANEL_NOTE } from "./panels/brushes-panel";
export { liveStrokeOpsFor } from "./handlers/brush";
// The pure tree-parentage resolver Appearance bake + Symbols read,
// exported for the conformance spec. "Select: Parent group" itself is
// the host's now (`paged.object.selectParentGroup`) — see
// commands/parentage.ts.
export { parentGroupOf } from "./commands/parentage";
export {
  CUT_COMMAND_IDS,
  KNIFE_COMMAND_ID,
  SCISSORS_AT_COMMAND_ID,
  SHAPE_BUILD_COMMAND_ID,
  contributeCutCommands,
  runKnife,
  runScissorsAt,
  runShapeBuild,
} from "./commands/cut-commands";
export {
  applyShapeBuild,
  type ShapeBuildOutcome,
} from "./handlers/shape-builder";
export {
  WIDTH_PROFILE_COMMAND_ID,
  WIDTH_PROFILE_COMMAND_IDS,
  WIDTH_PROFILE_MAX_STOPS,
  applyWidthProfile,
  contributeWidthProfileCommands,
  widthProfileOf,
} from "./commands/width-profile";
export {
  RECIPE_KINDS,
  RECIPE_UPDATE_COMMAND_IDS,
  UPDATE_LINKED_RECIPES_COMMAND_ID,
  allRecipes,
  applyUpdateLinkedRecipes,
  contributeRecipeUpdateCommands,
  recipesOfSources,
  recipesSourcedBy,
  updateRecipe,
  type RecipeKind,
  type RecipeRef,
} from "./commands/recipe-update";
export {
  RECIPE_AUTO_UPDATE_FEATURE,
  RECIPE_AUTO_UPDATE_KEY,
  RECIPE_SCRIPT_FEATURE,
  contributeRecipeAutoUpdate,
  onRecipeAutoUpdateChange,
  rebuildInStep,
  recipeAutoUpdateEnabled,
  recipeAutoUpdateOf,
  setRecipeAutoUpdate,
  type RecipeAutoUpdate,
  type StepRebuild,
} from "./commands/recipe-auto-update";
export {
  RecipeAutoUpdateToggle,
  RECIPE_AUTO_UPDATE_LABEL,
} from "./panels/recipe-auto-update-toggle";

// WP6.1 part 2 — Simplify's live preview and corner lane, Reflect about a
// point, the Join / Path Eraser / Reshape / Shaper / Star / Flare tools and
// their commands.
export { WAVE3_TOOL_IDS } from "./tools";
export {
  simplifyPreviewOf,
  showSimplifyPreview,
  clearSimplifyPreview,
  type SimplifyPreview,
  type SimplifyPreviewOptions,
} from "./commands/simplify-preview";
export {
  clampCornerAngle,
  DEFAULT_SIMPLIFY_CORNER_ANGLE_DEG,
} from "./commands/path-ops";
export {
  rewritePathOps,
  insertOpenPieceOps,
  readEditablePath,
} from "./commands/path-rewrite";
export {
  applyJoinScrub,
  applyPathErase,
  applyReshapeAt,
  applyReshapeTable,
  runJoinScrub,
  runPathErase,
  runReshapeAt,
  erasePieceHandle,
  JOIN_SCRUB_COMMAND_ID,
  PATH_ERASE_COMMAND_ID,
  RESHAPE_AT_COMMAND_ID,
  PATH_TOOL_COMMAND_IDS,
  DEFAULT_RESHAPE_RADIUS_PT,
  type JoinResult,
  type EraseResult,
} from "./commands/path-tools";
export {
  applyInsertFlare,
  flareBatchFor,
  flareHandle,
  flareParamsFrom,
  FLARE_PARAM_DEFAULTS,
  FLARE_PAPER,
  FLARE_RAY_OPACITY,
  FLARE_RING_OPACITY,
  INSERT_FLARE_COMMAND_ID,
  STAR_FLARE_COMMAND_IDS,
  type FlareParams,
} from "./commands/star-flare";
export {
  applyShaperStroke,
  runShaperStroke,
  SHAPER_STROKE_COMMAND_ID,
  type ShaperResult,
} from "./commands/shaper";
export { createReshapeHandler, tablePreview } from "./handlers/reshape";
export {
  createJoinHandler,
  createPathEraserHandler,
  createShaperHandler,
  JOIN_TOLERANCE_PX,
  PATH_ERASER_WIDTH_PX,
} from "./handlers/scrub-tools";
export {
  createFlareHandler,
  flareParamsOfGesture,
} from "./handlers/star-flare";
export { RESHAPE_OPTIONS } from "./tool-options";

// WP6.7 — the distortion tools: the Liquify family, Puppet Warp, the
// Perspective Grid and Perspective Selection; their commands, the grid
// store and its overlay layer.
export {
  DISTORTION_TOOL_IDS,
  ENVELOPE_TOOL_IDS,
  LIQUIFY_TOOL_IDS,
  SYMBOLISM_TOOL_IDS,
} from "./tools";
export {
  distortTargetsOn,
  readDistortTargets,
  writeDistorted,
  rewriteFromPage,
  tableThrough,
  type DistortTarget,
} from "./commands/distort-shared";
export {
  applyLiquifyStroke,
  liquifyOptionsFrom,
  runLiquifyStroke,
  LIQUIFY_STROKE_COMMAND_ID,
  LIQUIFY_COMMAND_IDS,
  type LiquifyResult,
} from "./commands/liquify";
export {
  applyPuppetWarp,
  runPuppetWarp,
  PUPPET_WARP_COMMAND_ID,
  PUPPET_WARP_TOOL_COMMAND_ID,
  PUPPET_WARP_TOOL_ID,
  PUPPET_COMMAND_IDS,
} from "./commands/puppet-warp";
export {
  makeWithWarp,
  makeWithMesh,
  makeWithTopObject,
  expandEnvelope,
  expandAppearance,
  expandEnvelopeOps,
  envelopeIndexOf,
  meshEntry,
  objectStackMutation,
  readObjectStack,
  readEnvelopeTargets,
  DEFAULT_WARP,
  DEFAULT_MESH,
  ENVELOPE_COMMAND_IDS,
  ENVELOPE_WARP_COMMAND_ID,
  ENVELOPE_MESH_COMMAND_ID,
  ENVELOPE_TOP_OBJECT_COMMAND_ID,
  ENVELOPE_EDIT_CONTENTS_COMMAND_ID,
  ENVELOPE_EXPAND_COMMAND_ID,
  ENVELOPE_MESH_TOOL_COMMAND_ID,
  ENVELOPE_MESH_TOOL_ID,
  EXPAND_APPEARANCE_COMMAND_ID,
  type EnvelopeTarget,
  type StackEntry,
} from "./commands/envelope";
export {
  gridFor,
  saveGrid,
  readPerspectiveLibrary,
  writePerspectiveLibrary,
  parsePerspectiveLibrary,
  serializePerspectiveLibrary,
  perspectiveGridShapes,
  renderPerspectiveLayer,
  installPerspectiveLayer,
  perspectiveLinkOf,
  withPerspectiveLink,
  readPerspectiveLink,
  writeOnPlane,
  insertOnPlane,
  runAttachToPerspective,
  runReleaseFromPerspective,
  runMoveOnPerspective,
  runDrawOnPerspective,
  PERSPECTIVE_COMMAND,
  PERSPECTIVE_COMMAND_IDS,
  PERSPECTIVE_PART,
  PERSPECTIVE_LAYER_ID,
  type PerspectiveLibrary,
  type PerspectiveLink,
} from "./commands/perspective";
export {
  createLiquifyHandler,
  liquifyOptionsOf,
  LIQUIFY_DWELL_MS,
} from "./handlers/liquify";
export { createPuppetWarpHandler } from "./handlers/puppet-warp";
export {
  createEnvelopeMeshHandler,
  readMeshSessions,
  pickControl,
  meshWrite,
  refineAt,
  unitToPage,
  pageToUnit,
  type MeshSession,
} from "./handlers/envelope-mesh";
export {
  createPerspectiveGridHandler,
  createPerspectiveSelectHandler,
  widgetCells,
  widgetShapes,
} from "./handlers/perspective";
export {
  polyShape,
  ellipseShape,
  squareShape,
  tableShapes,
} from "./handlers/preview-shapes";
export {
  LIQUIFY_OPTIONS,
  SYMBOLISM_OPTIONS,
  SYMBOL_SPRAYER_OPTIONS,
  WARP_OPTIONS,
  TWIRL_OPTIONS,
  PUCKER_OPTIONS,
  BLOAT_OPTIONS,
  SCALLOP_OPTIONS,
  CRYSTALLIZE_OPTIONS,
  WRINKLE_OPTIONS,
  PUPPET_WARP_OPTIONS,
  PERSPECTIVE_SELECT_OPTIONS,
} from "./tool-options";
export {
  migrateSymbolLibrary,
  installSymbolMigration,
  fitInstanceTransform,
  type SymbolMigration,
} from "./commands/symbols-migrate";

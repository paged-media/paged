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

// @paged-media/sheet-host-model — PURE translation layer: the engine's
// LoweredContent IR (computed in Rust, sheet-lower) → host Mutation[].
// Zero host imports, zero spreadsheet semantics (CLAUDE.md hard rule:
// all Excel-like operations live in the Rust crates).

export {
  type Align,
  type DataBarRect,
  type LoweredCell,
  type LoweredColumn,
  type LoweredRow,
  type LoweredContent,
  type LoweredStyle,
  type BorderLine,
  type BorderLines,
  type FillGradient,
  type FillPattern,
  type LoweredRun,
  type Merge,
  type Page,
  type Rule,
  type Rules,
  totalHeightPt,
  totalWidthPt,
  HEADING_INDEX,
} from "./lowered";

export {
  BINDING_KEY,
  BINDING_VERSION,
  cellOfA1,
  contentHash,
  makeBinding,
  parseBinding,
  rangeTopLeft,
  withView,
  type Binding,
  type BindingData,
  type BindingViewOptions,
  type FramePrint,
  type FrameSizing,
  type FrameView,
  type TableRecord,
} from "./binding";

export {
  defaultPlacement,
  DEFAULT_INSET_PT,
  ENGINE_DEFAULT_SIZE_PT,
  FIT_ALLOWANCE_PT,
  MAX_HEIGHT_PT,
  MAX_WIDTH_PT,
  tableFrameHeightPt,
  tableLeadInPt,
  tableRowHeightsPt,
  TABLE_LEAD_IN_LINE,
  type Bounds,
  type Placement,
  type TableFit,
} from "./placement";

export {
  cellTextSwatchOps,
  joinText,
  lowerToMutations,
  styleEmissions,
  styleProps,
  type BlockedFacet,
  type LowerPlacement,
  type LowerResult,
  type StyleEmission,
  type StyleProp,
} from "./lower-to-mutations";

export {
  CELL_EDGE_STROKE_PT,
  cellFillSwatchOps,
  columnOrder,
  pageTableMutations,
  tableCellOps,
  tableCellPositionOf,
  tableContentBatch,
  tableDecorOps,
  tableInsertOp,
  type PageTableOps,
  type TableDecor,
} from "./lower-to-table";

export {
  isCellStylePath,
  planCellStyleFromEntries,
  type CellStylePlan,
  type ReadEntry,
} from "./cell-style";

export {
  DEFAULT_GRID_SVG_OPTIONS,
  cellEditorRect,
  cellRect,
  fillOnce,
  colAt,
  colBand,
  colPos,
  rowAt,
  rowBand,
  rowPos,
  cssColorToScenePaint,
  FILL_HANDLE_PT,
  fillHandleRect,
  hitFillHandle,
  hitSelectionBorder,
  gridSceneToSceneLayer,
  gridSceneToSvg,
  hitCell,
  selectionRect,
  viewportHeightPt,
  viewportWidthPt,
  type GridCell,
  type GridCommentMarker,
  type FrameWindow,
  type FrameWindowSpec,
  type FramePageSpec,
  type TracksSpec,
  type GridDataBar,
  type GridFreeze,
  type GridMerge,
  type GridScene,
  type GridSelection,
  type GridSvgOptions,
  type GridViewport,
} from "./grid";

export {
  columnLetters,
  DEFAULT_HEADING_STYLE,
  paintGridScene,
  rowHeadingWidthPt,
  type HeadingStyle,
  type PaintContext,
  type PaintOptions,
  hiddenBoundaries,
} from "./grid-paint";

export {
  applyCompletion,
  arityHint,
  completionTokenAt,
  matchFunctions,
  type CompletionToken,
  type FunctionEntry,
} from "./completions";

// The WORKBOOK PALETTE — the document swatches paged.sheet mints, and
// the ONE implementation of their deterministic id convention. Consumed
// by the two lowering lanes AND by the ADR 023 Swatches binding provider,
// which is exactly why it is shared: a provider serving ids the lowering
// does not mint would hand the host swatch ids core cannot resolve.
export {
  distinctCellFillHexes,
  distinctCellStrokeHexes,
  distinctCellTextHexes,
  distinctChartHexes,
  distinctDataBarHexes,
  normalizePaletteHex,
  paletteEntry,
  paletteEntryToSpec,
  paletteEntryToSummary,
  paletteRgb255,
  paletteSwatchId,
  paletteSwatchName,
  swatchMintOps,
  workbookPalette,
  type KnownSwatchIds,
  type PaletteEntry,
  type PaletteFacet,
  type PaletteSources,
} from "./palette";

export {
  chartGeometryToMutations,
  estimateLabelMetrics,
  labelBox,
  labelJustification,
  labelAutoSizeOp,
  labelStyleOps,
  LABEL_FIT_ALLOWANCE_PT,
  LABEL_SLACK_PT,
  type ChartGeometry,
  type LabelMetrics,
  type ChartLowerResult,
  type ChartPlacement,
  type ChartPrimitive,
  type ChartTextLabel,
  type LinePrim,
  type PolygonPrim,
  type RectPrim,
  type TextAnchor,
  type TextPrim,
  type WedgePrim,
} from "./chart";

export {
  NO_FILL_SWATCH,
  offsetTableRows,
  REPLACE_FRACTION,
  tableRefreshOps,
  textOffsetLength,
  type TableRefreshOps,
} from "./table-refresh";

export {
  NO_CHARACTER_STYLE,
  cellCharacterStyleApplies,
  cellCharacterStyleId,
  cellCharacterStyleMints,
  cellCharacterStyles,
  cellsNeedingRestyle,
} from "./cell-character-styles";

// Wave 9 — horizontal cell alignment as paragraph styles on the native table.
export {
  ALIGN_PARAGRAPH_STYLES,
  NO_PARAGRAPH_STYLE,
  cellAlignApplies,
  cellAlignMap,
  cellAlignStyleMints,
  cellsNeedingRealign,
  needsAlignStyles,
} from "./cell-paragraph-align";

// W2.2 — cell rotation (cell styles) and diagonal borders (page lines).
export {
  cellRotationOps,
  needsRotationStyles,
  rotationCellStyleId,
  tableDiagonalOps,
  tableDiagonals,
  tableRotation,
  type DiagonalLine,
} from "./cell-orientation";

// Wave 9 — conditional-format data bars on the native placed table.
export { tableDataBarOps, tableDataBars } from "./table-databars";

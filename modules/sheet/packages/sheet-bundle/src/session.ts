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

// The workbook session — the bundle's workbook handle. It holds the
// booted engine + the active sheet/range/file name, exposes import +
// lower + dispose, and emits a change signal the panel subscribes to.
// Persistence (S-08 + the container part): the import writes the bytes,
// and every committed edit re-saves the workbook (debounced, flushed on
// dispose) — see `markEdited`. All spreadsheet work is the engine's; this is
// session bookkeeping + the host write path.

import type {
  BundleHost,
  DataProviderInfo,
  ElementId,
  PageId,
  ProviderRecordSet,
  SceneLayerSurface,
  TabularClipboard,
} from "@paged-media/plugin-api";
import { t } from "@paged-media/strings";
import {
  gridSceneToSceneLayer,
  hitCell,
  hitFillHandle,
  hitSelectionBorder,
  cellOfA1,
  contentHash,
  parseBinding,
  rangeTopLeft,
  workbookPalette,
  type ChartGeometry,
  type FunctionEntry,
  type GridCell,
  type GridScene,
  type GridSelection,
  type LoweredContent,
  type PaletteEntry,
} from "../../sheet-host-model/src";

import {
  bootEmptyEngine,
  bootEngine,
  ENGINE_NOT_BUILT,
  type CalcSettingsInfo,
  type CellEditRecord,
  type CellStylePatch,
  type DocSwatch,
  type EdgeStyle,
  type NameInfo,
  type SheetLayoutInfo,
  type ChartInfo,
  type FindMatch,
  type FindOptions,
  type Restyle,
  type RangeStats,
  type SheetEngine,
  type SheetInfo,
  type StructuralEditKind,
} from "./engine";
import {
  forgetShownContent,
  lowerPaginatedToChain,
  lowerSelectionToFrame,
  a1OfCell,
  pageContent,
  placementContent,
  placementForContent,
  pageBodyTracks,
  placementWindow,
  rangeFramePage,
  selectionBox,
  WINDOW_SLACK_PT,
  stampPlacedView,
  viewToContain,
  recallShownContent,
  refreshBands,
  refreshLoweredTable,
  rememberShownContent,
  replaceLoweredTable,
  storyOfFrame,
  tableUnderFrame,
  subscribeChainReflow,
  type ChainSubscription,
  type LoweredTableInfo,
} from "./lower";
import { NOTICES } from "./messages";
import { createDataTools, type DataToolsApi } from "./data-tools";
import type { EnterResult } from "./engine-w2";
import {
  chartPlacement,
  chartSizeOf,
  lowerChartToFrame,
  placedChartCopies,
  type PlacedChart,
  type PlacedChartCopy,
} from "./lower-chart";
import { readWorkbookPart, writeWorkbookPart } from "./workbook-part";
import {
  availableStyleIds,
  createDocStylesPlan,
  defaultDocStyleEntries,
  missingDocReferences,
  readDocumentStyleLists,
  type DocumentStyleLists,
  type MissingReference,
} from "./doc-styles";
import type {
  DocStyleMap,
  DocStyleTarget,
  NamedStyleUsage,
} from "./engine-docstyles";
import { readKnownSwatchIds } from "./swatch-mints";
import {
  csvBytes,
  type CsvExportOptions,
  type FormulaDisplay,
  type WorkbookKind,
} from "./engine-files";
import {
  advance,
  collapsed,
  extendTo,
  fillTarget,
  fullyVisible,
  gridKeyAction,
  modelOfRect,
  moveBy,
  rectOf,
  scrollToShow,
  type Cell,
  type GridKeyAction,
  type KeyLike,
  type SelectionModel,
} from "./grid-nav";
import {
  planCellStyleFromEntries,
  tableCellPositionOf,
  type ReadEntry,
} from "../../sheet-host-model/src";

/** How long a burst of committed edits settles before the placed tables,
 *  charts and paginated chains are refreshed ONCE (Wave 4). */
export const REFRESH_DEBOUNCE_MS = 300;

/** A session verb's outcome: done, or the reason it was not. */
export type SessionResult = { ok: true } | { ok: false; message: string };

/** Sheet ADR 524 — the workbook's document-style mapping as the panel
 *  shows it. */
export interface DocStylesInfo {
  enabled: boolean;
  entries: Record<string, DocStyleTarget>;
  usage: NamedStyleUsage[];
}

/** How a document paragraph / character style looks (ADR 524 grid parity). */
export interface DocStyleLook {
  family?: string;
  style?: string;
  sizePt?: number;
  /** `#rrggbb`, colour managed. */
  color?: string;
}

/** One journaled FORMAT change (Wave 9): its two directions against the
 *  engine, captured from the engine's own reads around the change. */
interface FormatStep {
  undo(engine: SheetEngine): void;
  redo(engine: SheetEngine): void;
  /** Undo this step AFTER the cell writes of its batch (a typed entry's
   *  format: the prior input is re-typed first, then the prior style is put
   *  back over whatever that re-typing implied). Default: before them. */
  undoAfterCells?: boolean;
}

/** S-08 persistence keys: the workbook bytes live in `host.blob` (binary),
 *  its display name in the KV `host.storage`. Per-plugin — the last
 *  imported workbook is the one restored on reload. */
const BLOB_KEY = "workbook";
const BLOB_NAME_KEY = "workbook.name";

/** How long after the last committed edit the workbook is re-saved to the
 *  container part + blob. One `saveXlsx` per burst of edits, not per
 *  keystroke-commit: the save re-emits the whole workbook. */
export const PERSIST_DEBOUNCE_MS = 750;

/** The nominal box the palette probe asks chart geometry for. A chart's
 *  COLOURS do not depend on its size — only the primitive coordinates do
 *  — so the palette read passes a fixed box rather than pretending to
 *  know a frame it is not rendering into. */
const PALETTE_PROBE_WPT = 400;
const PALETTE_PROBE_HPT = 300;

/** What a change signal carried (Wave 2) — so a listener that only cares
 *  about some cells can skip the rest. Anything not classified is
 *  `other`, which every listener must treat as "anything may have
 *  changed".
 *
 *  - `selection`: only the grid selection moved.
 *  - `cells`: only the VALUES / inputs of these cells changed (an edit,
 *    paste, sort, replace, undo/redo of those) — no style, sheet or
 *    workbook structure. `regions` bound every written cell. */
/** A one-line answer for the user ({@link WorkbookSession.notice}). */
export interface SessionNotice {
  text: string;
  tone: "ok" | "error";
  /** Bumps on every post, so the same text posted twice still re-shows. */
  seq: number;
}

export type SessionChange =
  | { kind: "selection" }
  /** The in-frame cell edit opened, changed, committed or was cancelled
   *  (the formula bar and the frame surface's editor follow it). */
  | { kind: "edit" }
  | { kind: "cells"; regions: readonly CellRegion[] }
  | { kind: "other" };

/** A rectangle of cells on one sheet (inclusive bounds). */
export interface CellRegion {
  sheet: number;
  firstRow: number;
  firstCol: number;
  lastRow: number;
  lastCol: number;
}

const OTHER_CHANGE: SessionChange = { kind: "other" };

/** The IDML styles un-styled story text falls back to: the basic
 *  paragraph style, else the root "no paragraph style". */
const BASIC_PARAGRAPH_STYLES = [
  "ParagraphStyle/$ID/NormalParagraphStyle",
  "ParagraphStyle/$ID/[No paragraph style]",
];

/** A style property entry's text (an unset entry reads as "" or null). */
function styleEntryText(v: unknown): string | null {
  const raw =
    v && typeof v === "object" && "value" in v
      ? (v as { value: unknown }).value
      : null;
  return raw === null || raw === undefined || raw === "" ? null : String(raw);
}

/** A style property entry's number, or null. */
function styleEntryNum(v: unknown): number | null {
  const t = styleEntryText(v);
  const n = t === null ? NaN : Number(t);
  return Number.isFinite(n) ? n : null;
}

/** The regions (one bounding box per sheet) covering `cells`. */
export function regionsOf(
  cells: readonly { sheet: number; row: number; col: number }[],
): CellRegion[] {
  const bySheet = new Map<number, CellRegion>();
  for (const { sheet, row, col } of cells) {
    const r = bySheet.get(sheet);
    if (!r) {
      bySheet.set(sheet, {
        sheet,
        firstRow: row,
        firstCol: col,
        lastRow: row,
        lastCol: col,
      });
      continue;
    }
    r.firstRow = Math.min(r.firstRow, row);
    r.firstCol = Math.min(r.firstCol, col);
    r.lastRow = Math.max(r.lastRow, row);
    r.lastCol = Math.max(r.lastCol, col);
  }
  return [...bySheet.values()];
}

/** Run `cb` at the next animation frame — or, with no
 *  `requestAnimationFrame` (a worker, the headless host), after the
 *  current microtask turn. A hidden tab never fires rAF, so a timeout
 *  races it: the work still lands, just not frame-aligned. */
function nextFrame(cb: () => void): void {
  const raf = (
    globalThis as { requestAnimationFrame?: (f: () => void) => unknown }
  ).requestAnimationFrame;
  if (typeof raf !== "function") {
    queueMicrotask(cb);
    return;
  }
  let ran = false;
  const once = () => {
    if (ran) return;
    ran = true;
    cb();
  };
  raf(once);
  setTimeout(once, 100);
}

/** A tiny synchronous event emitter (one channel: "did the session
 *  state change"). Avoids dragging a dependency for a single signal. */
class Emitter {
  private listeners = new Set<(change: SessionChange) => void>();
  /** Runs before the listeners on every emit (the session drops its read
   *  caches there, so no listener can read a stale answer). */
  constructor(private readonly beforeEmit?: () => void) {}
  on(listener: (change: SessionChange) => void): { dispose(): void } {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }
  emit(change: SessionChange = OTHER_CHANGE): void {
    // The cell-edit buffer is not engine state: no cached read goes stale.
    if (change.kind !== "edit") this.beforeEmit?.();
    for (const l of [...this.listeners]) l(change);
  }
  clear(): void {
    this.listeners.clear();
  }
}

/** What the object model (ADR 323, `src/object-model.ts`) needs from the
 *  session: the engine, the after-write bookkeeping, the version swap a
 *  document undo/redo or open drives, and the frames that host the
 *  workbook's label. */
/** Plan G4 — how `lowerSelection` places the range: as a window frame
 *  (`"window"`, the default: the range's own size in sheet tracks), a window
 *  with a box the caller fixes (`"fixed"`, `boxPt` required), or the earlier
 *  fixed range with text-measured widths (`"fit"`); the view's top-left cell
 *  and lock, the printed headings and gridlines; and whether it goes below
 *  the selected item instead of at it. */
export interface PlaceOptions {
  sizing?: "window" | "fit" | "fixed";
  boxPt?: { widthPt: number; heightPt: number };
  view?: { topLeft?: string; lock?: boolean };
  print?: { headings?: boolean; gridlines?: boolean };
  below?: boolean;
}

/** The gap (pt) between a print area's placed areas. */
const PLACE_GAP_PT = 12;

export interface ObjectBridge {
  engine(): SheetEngine | null;
  /** Bumps whenever the workbook is REPLACED (import, blank, CSV, dataset,
   *  document switch) — a version history belongs to one workbook. */
  epoch(): number;
  /** After an object-model write: caches dropped, the placements refreshed
   *  and the cache part re-saved (debounced), listeners told. */
  afterWrite(regions: readonly CellRegion[] | null): void;
  /** Swap in a stored version's bytes (document undo/redo, or the version
   *  the open document's label names). Placements are KEPT and NOT
   *  refreshed: the document's own history already restored the page. */
  loadVersion(bytes: Uint8Array, name: string): boolean;
  /** Rename the workbook (its display / file name). */
  setName(name: string): void;
  /** The text frames the workbook is placed in (sync; most recent last). */
  hostFrames(): string[];
  /** Re-read the document's sheet-bound frames when none are known. */
  discoverHostFrames(): Promise<string[]>;
  /** Plan G4 — stop tracking this session's placements of chart `index`
   *  (it is being deleted) and hand them over: the caller removes their
   *  page elements in its own write. */
  takeChartPlacements(index: number): PlacedChart[];
  /** Plan G4 — re-open the chart slots a stored version's bytes no longer
   *  carry (right after `loadVersion`, before its chart ops replay). */
  restoreChartSlots(slots: readonly number[]): void;
  /** Plan G4 — track again the placed charts the page carries (after a
   *  document undo or redo, or an open): copies an undo restored refresh
   *  with later edits. Returns how many were added. */
  rediscoverCharts(): Promise<number>;
}

/** The session's reactive state — a plain snapshot the panel renders. */
export interface SessionState {
  /** The booted engine, or null before the first successful import. */
  engine: SheetEngine | null;
  /** The imported workbook's file name (display only). */
  fileName: string | null;
  /** The active sheet's wasm id, or null. */
  activeSheet: number | null;
  /** The A1 range the panel will lower. */
  selectedRange: string | null;
  /** Set when boot failed (e.g. the artifact isn't built — S-10). */
  bootError: string | null;
  /** The sheets-mode grid selection rectangle (spec §8.1), or null. The
   *  grid panel sets it on click; [`gridScene`] overlays it on the scene so
   *  the SVG draws the selection chrome (the engine also gets told via
   *  `setGridSelection` so the JOINS-phase wasm can carry it natively). */
  gridSelection: GridSelection | null;
  /** S-15 — when the active workbook was sourced from a governed dataset
   *  (`sourceFromDataset`), the linked provider id + the revision the cells
   *  were seeded from, and whether the provider has since announced a newer
   *  revision (`stale`). Null when the workbook was hand-entered / imported
   *  from XLSX (the snapshot is committed content either way — §1.1 honesty:
   *  no auto-refetch; a refresh is an explicit re-source). */
  dataSource: {
    providerId: string;
    revision: string;
    stale: boolean;
    /** Re-pulled on every provider revision (the default since the
     *  object-model wave); false = the snapshot is kept and only marked
     *  stale. */
    live?: boolean;
  } | null;
  /** Wave 5 — bumps on every Cmd+F / "Find in sheet": the grid panel
   *  focuses its find field when it changes. */
  findRequest: number;
}

export interface WorkbookSession extends DataToolsApi {
  /** Read the current state snapshot. */
  state(): SessionState;
  /** Subscribe to state changes (the panel's render trigger). The
   *  listener receives what changed ({@link SessionChange}); `other`
   *  means anything may have. */
  onDidChange(listener: (change: SessionChange) => void): { dispose(): void };
  /** Import XLSX bytes under a display name: boots the engine on first
   *  use, loads the workbook, defaults the active sheet + range, and (when
   *  `host.blob` is wired) PERSISTS the bytes so they survive a reload
   *  (S-08). */
  /** Load `bytes` as the workbook; `false` when they are not one (the
   *  open workbook, if any, stays). */
  import(bytes: Uint8Array, name: string): Promise<boolean>;
  /** Restore the last persisted workbook from `host.blob` (S-08), if any.
   *  A cheap no-op (one blob read) when nothing was persisted or no blob
   *  store is wired — the engine boots ONLY when there are bytes to load.
   *  Returns whether a workbook was restored. */
  restore(): Promise<boolean>;
  /** A document opened (the host's `documentLoaded`): the workbook belongs
   *  to the document, so the one in memory is dropped and the new
   *  document's own is restored from its container part. The per-browser
   *  blob is lifted only into a document that has a sheet frame (a
   *  pre-container document); any other document starts with none.
   *  Returns whether a workbook was restored. */
  documentOpened(): Promise<boolean>;
  /** Make sure the open document's workbook is loaded (entering a sheet
   *  frame on a host that never announced the document): waits for a
   *  restore in flight, else restores. Whether a workbook is loaded. */
  ensureRestored(): Promise<boolean>;
  /** Set which sheet is active (and default its range to the used
   *  extent). */
  setActiveSheet(id: number): void;
  /** Set the A1 range the next lower will project. */
  setRange(range: string): void;
  /** Lower the active sheet's selected range to a new page frame
   *  (the two-phase flow in lower.ts). Returns the created frame id. */
  lowerSelection(opts?: PlaceOptions): Promise<string | null>;
  /** C-1 / S-02 — render the active sheet's grid INSIDE a frame as a live
   *  vector layer (`host.contribute.sceneLayer()`): gridlines + cell fills
   *  + cell values, clipped to the frame's content box by core. `frameId`
   *  targets a specific frame (e.g. the one a sheet edit-context entered
   *  on); omitted ⇒ the last-lowered frame. Returns false when there is no
   *  target frame, no scene channel (`supports("rendering.sceneLayer@1")`),
   *  or no engine. The layer is EPHEMERAL (re-submitted; not doc content). */
  showGridInFrame(frameId?: string): Promise<boolean>;
  /** K-1 — select the cell under a FRAME-CONTENT-space point (the editor
   *  inverted the frame transform before delivering it) and re-render the
   *  in-frame grid with the selection chrome. Pure `hitCell` against the
   *  last rendered grid — no engine round-trip for the hit. Returns false
   *  when no grid is shown or the point falls outside the windowed cells. */
  selectCellInFrame(contentX: number, contentY: number): boolean;
  /** K-1 — is an in-frame cell edit in progress? (Drives the edit context's
   *  `isDirty` so the shell routes Enter/Esc to the cell, not the context.) */
  isCellEditing(): boolean;
  /** K-1 — a printable key in-frame: begin a fresh replace-mode edit on the
   *  selected cell, or append to the open one. Re-renders with the buffer.
   *  Returns false when there's no selected cell / not a single char. */
  typeCellChar(ch: string): boolean;
  /** K-1 — Backspace in-frame: open from the cell's current value if not
   *  editing, then drop the last char. Returns false when no cell selected. */
  backspaceCellEdit(): boolean;
  /** K-1 — commit the in-frame cell edit (Enter): write the buffer via the
   *  engine + re-render. Returns whether an edit was committed. */
  commitCellEdit(): boolean;
  /** K-1 — abandon the in-frame cell edit (Esc): drop the buffer + re-render
   *  the committed value. */
  cancelCellEdit(): void;
  /** The open in-frame cell edit: its cell, its text and how it began
   *  (`"enter"`: typing replaced the value, arrows commit and move;
   *  `"edit"`: F2 or a click into the text, arrows move the caret). */
  /** Ctrl+X: copy the selection and empty it when its paste lands. */
  cutSelection(): void;
  /** Status-bar statistics of the selection (Sum, Average, Count), or null
   *  without a selection or an engine that cannot say. */
  selectionStats(): RangeStats | null;
  cellEditState(): {
    row: number;
    col: number;
    text: string;
    mode: "enter" | "edit";
  } | null;
  /** Open an edit on the active cell: with `text` it replaces the value
   *  (typing), with `null` it starts from the cell's input (F2). */
  beginCellEdit(text: string | null, mode: "enter" | "edit"): boolean;
  /** Replace the open edit's text (a text field owns the caret); opens an
   *  `"enter"` edit on the active cell when none is open. */
  setCellEditText(text: string): boolean;
  /** Clear the in-frame grid layer (the frame returns to its native
   *  lowered content). A window frame's view moves to where the grid was
   *  scrolled (unless locked) and the page shows it (ADR 510). */
  hideGridInFrame(): void;
  /** The view of a placed frame (default: the last entered one): its
   *  top-left cell and lock, or null for a frame that is not a window. */
  frameView(frameId?: string): { topLeft: string; lock: boolean } | null;
  /** Lock or unlock a window frame's view (default: the last entered
   *  frame). Locking pins the window to where the frame's view stands now,
   *  or — while the frame is entered — where the grid is scrolled; the
   *  binding records it with the next page write. False when no window
   *  frame is known. */
  setFrameViewLock(lock: boolean, frameId?: string): boolean;
  /** Show sheet `sheetId` in the entered frame (RagTime: the frame is a
   *  window onto a component): the grid moves to its A1, and a window
   *  frame's page shows that sheet when the frame is left. */
  setFrameSheet(sheetId: number): boolean;
  /** The bytes of a font face the document holds (`host.assets`), so the
   *  frame surface draws cell text in the faces the page uses. Null when
   *  the host serves none (no asset door, a family the document lacks). */
  documentFontFace(
    family: string,
    style?: string,
  ): Promise<{ bytes: Uint8Array; family: string; style?: string } | null>;
  /** A document swatch as a cell colour reference (sheet ADR 518): its
   *  colour model and the sRGB the document shows it as, the fallback an
   *  xlsx reader sees. Null when the document has no such swatch. */
  documentSwatchRef(id: string): Promise<DocSwatch | null>;
  /** How document swatches `ids` show on screen now (`#rrggbb`, colour
   *  managed), for the grid to draw referenced colours as the canvas does.
   *  Unknown ids are left out. */
  documentSwatchColors(ids: readonly string[]): Promise<Map<string, string>>;
  /** Bumps whenever the document's swatches may have changed (a swatch
   *  edit, an undo): the grid re-reads `documentSwatchColors`. */
  documentStyleRevision(): number;
  /** The document's paragraph styles and swatches (with their display
   *  colour) for the sheet bar's style menu and swatch pickers (P7). */
  documentStyleChoices(): Promise<{
    paragraphStyles: { id: string; name: string }[];
    swatches: { id: string; name: string; rgbHex: string }[];
  }>;
  /** Apply a document swatch to the selected cells' fill or text (null
   *  clears it) — one undo step. */
  applyDocumentSwatch(
    target: "fill" | "text",
    swatchId: string | null,
  ): Promise<SessionResult>;
  /** The face and size text takes on the page when a cell names none: the
   *  document's basic paragraph style (P7 — the grid draws un-styled cells
   *  in it, as the placed table prints them). Null when unreadable. */
  documentTextDefault(): Promise<{
    family: string;
    style: string | null;
    sizePt: number | null;
  } | null>;
  /** Sheet ADR 524 — how a mapped document style looks (resolved through
   *  `basedOn`): face, size and the colour the document shows. Unreadable
   *  ids are left out. Re-read when `documentStyleRevision` moves. */
  documentStyleLooks(
    ids: readonly { collection: "paragraph" | "character"; id: string }[],
  ): Promise<Map<string, DocStyleLook>>;
  /** Sheet ADR 524 — the workbook's "Use document styles" switch, its
   *  mapping table and the named styles the cells use. Null without a
   *  workbook (or an engine without the doors). */
  docStyles(): DocStylesInfo | null;
  /** The document's paragraph / character / cell styles and swatches, and
   *  what the workbook names that the document lacks. Null when unread. */
  documentStyleLists(): Promise<{
    lists: DocumentStyleLists;
    missing: MissingReference[];
  } | null>;
  /** Turn "Use document styles" on (pre-filling unmapped Excel styles whose
   *  name matches a document paragraph style, and Normal → the basic
   *  paragraph style) or off. One undo step. */
  setDocStylesEnabled(on: boolean): Promise<SessionResult>;
  /** Map one Excel named style (an empty target clears it). One undo
   *  step. */
  setDocStyleMapping(style: string, target: DocStyleTarget): SessionResult;
  /** For every Excel named style the cells use without an entry: create a
   *  document paragraph style with its face, size, weight and colour, and
   *  map it. Turns the switch on. */
  createDocStylesFromWorkbook(): Promise<SessionResult & { created?: number }>;
  /** Point every workbook reference to document style / swatch `from` at
   *  `to` (the cells and the mapping table). */
  remapDocReference(from: string, to: string): Promise<SessionResult>;
  /** Extensions ADR 334 — route the in-frame grid to a FRAME SURFACE
   *  instead of the scene layer: every grid state (window, selection, the
   *  open cell edit, the fill preview) goes to `sink`, windowed to
   *  `cellArea` (the frame's content box minus the surface's heading
   *  strips). Returns the detach. While attached no scene layer is
   *  submitted, and any already shown is cleared. */
  attachFrameSurface(
    sink: (scene: GridScene) => void,
    cellArea: { wPt: number; hPt: number },
  ): () => void;
  /** Enumerate the workbook's parsed charts (M2 charts track, spec §8.4).
   *  Empty when there is no engine / no charts. */
  listCharts(): ChartInfo[];
  /** ADR 023 — the WORKBOOK PALETTE: every colour this workbook makes
   *  paged.sheet mint as a DOCUMENT swatch (chart series + conditional-
   *  format data bars), at the deterministic ids the lowering uses.
   *
   *  This is what the host Swatches panel binds to while the `sheet`
   *  edit context is active. It is derived, never stored: the colours
   *  are decided in Rust (`sheet-chart`'s palette, `sheet-lower`'s
   *  data-bar rules) and `sheet-host-model/palette.ts` only projects
   *  them onto core's swatch vocabulary. Empty when no workbook is
   *  loaded, or when the workbook has no charts and no data bars. */
  workbookPalette(): PaletteEntry[];
  /** Lower a parsed chart to a paged.draw vector frame (spec §8.4 — the
   *  two-phase flow in lower-chart.ts). `chartIndex` indexes [`listCharts`].
   *  Returns false when there is no engine or the lower fails. */
  lowerChart(chartIndex: number): Promise<boolean>;
  /** The chart-kind tags the ENGINE accepts, in panel order (empty when no
   *  workbook is loaded). The panel renders this list rather than a hard-coded
   *  one, so the kind vocabulary has exactly one home: Rust. */
  chartKinds(): string[];
  /** AUTHOR a chart over the ACTIVE sheet's live data (editor-ui-coverage
   *  M — the model was import-only). `seriesIn` is the transpose control
   *  (`"columns"` default / `"rows"`). The chart is written into the xlsx
   *  on save (sheet ADR 519). */
  authorChart(
    values: string,
    categories: string,
    kind: string,
    title: string,
    seriesIn?: string,
  ): { ok: true; index: number } | { ok: false; message: string };
  /** Window the active sheet into a [`GridScene`] for the grid panel (spec
   *  §8.1). Delegates the windowing to `engine.getGridScene` (Rust) and
   *  overlays the session's current [`gridSelection`] onto the scene.
   *  Returns null when there is no engine / active sheet. */
  gridScene(
    firstRow: number,
    firstCol: number,
    wPt: number,
    hPt: number,
  ): GridScene | null;
  /** Record the grid selection rectangle (spec §8.1): forwards to the
   *  engine (`setGridSelection`) AND holds it in session state so the next
   *  `gridScene` paints it. Emits a change so the panel re-renders. */
  setGridSelection(
    anchorRow: number,
    anchorCol: number,
    rows: number,
    cols: number,
  ): void;
  /** Commit one cell edit (spec §8.1 panel edit contract): `engine.setCell`
   *  then refresh (emit). All spreadsheet semantics are the engine's; this
   *  only drives the write + signal. Returns false when there is no engine
   *  / active sheet or the write throws (never throws). */
  editCell(sheet: number, row: number, col: number, input: string): boolean;
  /** S-04 formula bar — the re-enterable INPUT text of `(row, col)` on the
   *  active sheet (`engine.getCellInput`: `"=…"` for a formula, the literal
   *  for a value, `""` for empty/OOB). The formula bar prefills with this so
   *  editing a formula cell shows its formula, not the computed display.
   *  Returns "" when there is no engine / active sheet (never throws). */
  cellInputAt(row: number, col: number): string;
  /** K-6 / S-14 — COPY the current grid selection to the system clipboard
   *  (`host.clipboard.write`). Reads the selected range's FORMATTED display
   *  strings from the engine (`getRangeValues` — all formatting in Rust) and
   *  writes BOTH a `tabular` grid AND a TSV `text` fallback. Returns the
   *  outcome: `ok:true` with the copied row/col counts, or `ok:false` with an
   *  honest reason (no selection / no engine / the clipboard door denied).
   *  Never throws. */
  copySelection(): Promise<
    { ok: true; rows: number; cols: number } | { ok: false; message: string }
  >;
  /** K-6 / S-14 — PASTE the system clipboard into the grid at the selection
   *  ANCHOR (`host.clipboard.read`). Prefers the rich `tabular` grid; falls
   *  back to parsing the `text` half as TSV. Each cell re-types through the
   *  journaled `editCell` lane as ONE grouped ADR-012 undo step (one Cmd-Z
   *  undoes the whole paste). Returns the outcome: `ok:true` with the pasted
   *  row/col counts, or `ok:false` with an honest reason (no selection / no
   *  engine / nothing on the clipboard). Never throws. */
  pasteAtSelection(
    options?: PasteOptions,
  ): Promise<
    { ok: true; rows: number; cols: number } | { ok: false; message: string }
  >;
  /** Paste special (Excel's Ctrl+Alt+V): whether its options card is open,
   *  and opening / closing it. The card's OK calls `pasteAtSelection` with
   *  the chosen options. */
  pasteSpecialOpen(): boolean;
  openPasteSpecial(): void;
  closePasteSpecial(): void;
  /** The last answer of copy or paste, for the grid panel to show. Copy and
   *  paste are reached from the panel buttons, the grid keys, the in-frame
   *  keys and the commands; a refusal from any of them is posted here, so
   *  the user sees it instead of only the log. Null until one is posted. */
  notice(): SessionNotice | null;
  /** Subscribe to {@link notice}. */
  onNotice(listener: (notice: SessionNotice) => void): { dispose(): void };
  /** S-04 formula bar — the engine's registry-generated function name table
   *  for the autocomplete (constitution §7: the completion names are the
   *  ENGINE's, never a TS list). Cached after the first call (the registry
   *  is build-time fixed). Empty when there is no engine (never throws). */
  functionList(): readonly FunctionEntry[];
  /** The workbook's sheets (`engine.listSheets`), memoised until the next
   *  change signal — the panels read it on every render. Empty when there
   *  is no engine (never throws). */
  sheets(): readonly SheetInfo[];
  /** ADR-012 Tier 1 — undo one step of the in-session journal. An OPEN
   *  cell-edit buffer unwinds first (= cancel, no Operation); then each
   *  call re-enters the previous INPUT of the latest committed cell edit.
   *  Returns false when exhausted (the shell does NOT fall through to the
   *  document stack mid-session). */
  undoCellEdit(): boolean;
  /** ADR-012 Tier 1 — re-apply the next journal entry (false when none). */
  redoCellEdit(): boolean;
  canUndoCellEdit(): boolean;
  canRedoCellEdit(): boolean;
  /** Drop the journal — the modal session boundary (call on exit; Tier 2's
   *  re-lowered batch owns the document grain from there). */
  clearCellEditJournal(): void;
  /** Sort the SELECTED RANGE's rows on the active sheet by `keyCol`
   *  (0-based, relative to the range) — thin glue over `engine.sortRange`
   *  (all sort semantics in Rust, sheet.edit.sort.*). The engine's per-cell
   *  input rewrites journal as ONE grouped ADR-012 step (one Cmd-Z undoes
   *  the whole sort). Returns the honest outcome: `ok: false` carries the
   *  engine's boundary message (e.g. "sort over a spilled region not
   *  supported") for the panel to show. Never throws. */
  sortRange(
    keyCol: number,
    ascending: boolean,
    hasHeader: boolean,
  ): { ok: true } | { ok: false; message: string };
  /** Find every cell matching `needle` — thin glue over `engine.findAll`
   *  (matching/collation decided in Rust, sheet.edit.find.*). `scope`
   *  "sheet" searches the active sheet; "workbook" all sheets. Returns []
   *  when there is no engine or the call fails (never throws). */
  findAll(
    needle: string,
    opts: FindOptions,
    scope: "sheet" | "workbook",
  ): FindMatch[];
  /** Replace every occurrence over the scope — thin glue over
   *  `engine.replaceAll` (input-text splice + re-entry decided in Rust,
   *  sheet.edit.replace.*). The per-cell rewrites journal as ONE grouped
   *  step. Returns the counts (skipped = parse-failed/spill cells the
   *  engine reported, untouched) or the honest error. Never throws. */
  replaceAll(
    needle: string,
    replacement: string,
    opts: FindOptions,
    scope: "sheet" | "workbook",
  ):
    | { occurrences: number; replacedCells: number; skipped: number }
    | { error: string };
  /** Jump to a cell (a find hit): activate its sheet if needed and select
   *  it in the grid (the panel + any in-frame grid re-render). */
  goToCell(sheet: number, row: number, col: number): void;
  /** S-04 — mint a NEW cell style named `name` from the selected cell's
   *  current appearance, over the last-lowered native table. Composes from
   *  existing platform doors (the RFI verdict): read the cell's properties
   *  (B-19 `elementProperties`), `createCellStyle` (selfId-minted — the
   *  null-createdId precedent), `setStyleProperty` to populate it, then
   *  ATTEMPT `setElementProperty{appliedCellStyle}` to apply it back.
   *
   *  The engine applies `appliedCellStyle` on a `tableCell` element (S-04,
   *  probe-verified; the old "wire-shape-only" note in wire.d.ts is stale).
   *  A host can still refuse the apply, so the outcome is reported as
   *  `applied` true/false rather than assumed.
   *
   *  Returns the outcome: the minted style id, the count of captured
   *  properties, and whether the apply-back took. `ok:false` carries the
   *  reason (no lowered table / no selection / mint rejected). Never throws. */
  newCellStyleFromSelection(name: string): Promise<
    | {
        ok: true;
        styleId: string;
        capturedCount: number;
        applied: boolean;
        applyMessage: string | null;
      }
    | { ok: false; message: string }
  >;
  /** ADR 023 — WHAT THE HOST'S CHARACTER/PARAGRAPH PANELS ARE ABOUT
   *  while the `sheet` context is active: the (sheet, A1 range) whose
   *  cell text formatting those panels should show.
   *
   *  Two cases, and the second is the one that makes the panels useful
   *  rather than empty:
   *
   *    · a CELL SELECTION exists → exactly those cells;
   *    · none yet → THE WHOLE RANGE THE ENTERED FRAME PROJECTS. This is
   *      not a fallback, it is the analogue of selecting a text frame
   *      with the selection tool: the panel is about the frame's whole
   *      content, and reports MIXED wherever that content disagrees.
   *
   *  Null when there is no workbook / active sheet / nothing lowered. */
  textSelectionRange(): { sheet: number; range: string } | null;
  /** Re-emit the loaded workbook as XLSX bytes for the exporter
   *  contribution (S-06). Preservation-first (`engine.saveXlsx` — the
   *  lazy-verbatim re-emit, §10.2). Returns the bytes + a suggested file
   *  name, or null when there is no workbook (nothing to export). */
  saveWorkbook(): { bytes: Uint8Array; fileName: string } | null;
  /** Sheet ADR 521 — the workbook as another package kind (`.xlsx` from a
   *  macro workbook leaves the VBA project out; the open workbook keeps
   *  it). Null when there is no workbook or the engine refuses. */
  saveWorkbookAs(
    kind: WorkbookKind,
  ): { bytes: Uint8Array; fileName: string } | null;
  /** Sheet ADR 521 — the active sheet (or `opts.range`) as CSV, UTF-8
   *  encoded, with a suggested `.csv` name. Null when there is no workbook
   *  / sheet or the engine refuses (the reason is logged). */
  exportCsv(
    opts?: CsvExportOptions,
  ): { bytes: Uint8Array; fileName: string } | null;
  /** Sheet ADR 521 — how formulas are shown and typed (R1C1, language);
   *  null when there is no workbook or the engine predates the door. */
  formulaDisplay(): FormulaDisplay | null;
  /** Change the formula display: `r1c1` is kept in the workbook (an edit),
   *  `lang` is a language tag for this session (`"de"`; no table →
   *  English). Whether the engine took it. */
  setFormulaDisplay(opts: { r1c1?: boolean; lang?: string }): boolean;
  /** S-15 — enumerate the governed datasets the platform offers in the
   *  `"dataset"` category (`host.dataProviders.discover`), schema + revision
   *  only, NO rows. The datasets panel lists these so the author can source
   *  a sheet from one. Returns [] when the `dataProviders` surface is absent
   *  or no shared registry is wired (`supports("dataProviders@1")` false) —
   *  the §2.1 graceful-absence posture (paged.data not installed ⇒ no
   *  sources). Never throws. */
  discoverDatasets(): readonly DataProviderInfo[];
  /** S-15 — source the active workbook from a governed dataset: pull the
   *  provider's resolved snapshot (`host.dataProviders.get`), boot a FRESH
   *  EMPTY workbook, and seed sheet 0 (row 0 = the schema field names; rows
   *  1.. = the column-major records). Sets `state.dataSource` to the linked
   *  `(providerId, revision)` and subscribes to `onDidChange` so a later
   *  revision marks the sheet stale (logged "re-source to refresh"; NO
   *  auto-refetch — §1.1 / the RFC). A no-op (logged) when the provider is
   *  gone, the surface is absent, or the engine cannot boot. */
  sourceFromDataset(
    providerId: string,
    opts?: { live?: boolean },
  ): Promise<void>;
  /** ADR 323 — the object model's door into the session
   *  (`src/object-model.ts`). Not a panel API. */
  objectBridge(): ObjectBridge;
  /** Write any committed-but-unsaved edits to the container part + blob
   *  NOW (cancelling the pending debounce) and resolve when every queued
   *  write has landed. Edits persist on their own after
   *  [`PERSIST_DEBOUNCE_MS`], on leaving the frame and on `dispose`; this is the explicit door
   *  for a host save. (The plugin contract has no pre-save hook yet —
   *  RFI: a host `onWillSave` would call this.) Never rejects. */
  flushPersist(): Promise<void>;
  /** Keep what the placed tables show in the document (`placements/`), so a
   *  later session can refresh a stale table in place instead of replacing
   *  it. The host's save hook and `dispose` do this; never rejects. */
  flushPlacementRecords(): Promise<void>;
  /** Tear down: flush unsaved edits (the bytes are taken synchronously,
   *  the write completes in the background), free the engine, drop
   *  listeners. */
  dispose(): void;

  // ── Wave 4 ──────────────────────────────────────────────────────────

  /** Paginate the active range across the threaded frames of the selected
   *  text frame (or, with none selected, the frame last placed into), live:
   *  a resize of a chain frame re-paginates (debounced) and REPLACES the
   *  tables; workbook edits refresh them too. `repeatHeaderRows` (Wave 6)
   *  repeats that many leading rows at the top of every frame. `frameId`
   *  names a frame of the chain instead (plan G4, the typed `place`). */
  paginateSelection(opts?: {
    repeatHeaderRows?: number;
    frameId?: string;
    /** Plan G4 — several ranges of the active sheet paginated in sequence
     *  (a print area of several areas) instead of the selected range. */
    areas?: readonly string[];
  }): Promise<SessionResult>;
  /** Bring every placed table, chart and paginated chain up to date with
   *  the workbook now (edits schedule this on their own, debounced). */
  refreshPlacements(): Promise<void>;
  /** Replace the workbook with a new blank one (one sheet, "Book1"). */
  newWorkbook(): Promise<void>;
  /** Import delimited text (CSV/TSV) as a one-sheet workbook. The host
   *  language types numbers and dates; `name`'s extension picks the
   *  delimiter (.tsv → tab), otherwise it is sniffed. */
  importCsv(text: string, name: string): Promise<void>;
  /** Sheet ADR 521 — import an OpenDocument spreadsheet (`.ods`, `.ots`) as
   *  a workbook (converted in Rust; saved as `.xlsx`). */
  importOds(bytes: Uint8Array, name: string): Promise<void>;
  /** Add a worksheet (empty name = next free `SheetN`) and make it active. */
  addSheet(name?: string): SessionResult;
  /** Rename a worksheet. */
  renameSheet(id: number, name: string): SessionResult;
  /** Delete a worksheet (references to it become #REF!). */
  deleteSheet(id: number): SessionResult;
  /** Insert/delete rows or columns at the grid selection (its rows / cols
   *  are the count). Clears the cell-edit journal (its addresses moved). */
  structuralEdit(kind: StructuralEditKind): SessionResult;
  /** The workbook's iteration settings (`<calcPr>`), or null. */
  calcSettings(): CalcSettingsInfo | null;
  /** Toggle iterative calculation (persisted into `<calcPr>`). */
  setIterative(on: boolean): SessionResult;
  /** The workbook content version (bumps on every committed edit) — the
   *  number placed frames' bindings carry. */
  contentVersion(): number;

  // ── Wave 6: formatting & layout ─────────────────────────────────────

  /** What the format verbs act on: the grid selection when there is one,
   *  else the panel's range (which may be a defined name or a table name),
   *  resolved by the engine to its sheet + bounds. */
  formatTarget(): FormatTarget | null;
  /** Apply a partial style to the format target. */
  setStyle(patch: CellStylePatch): SessionResult;
  /** Borders on the format target: `all` edges of every cell, the
   *  `outline` of the block, one side of the block, or `none` (every edge
   *  of every cell cleared). */
  setBorders(kind: BorderKind, edge: EdgeStyle): SessionResult;
  /** The full style of the format target's top-left cell. */
  styleAtTarget(): CellStylePatch | null;
  /** Merge the format target (top-left keeps its content). */
  mergeTarget(): SessionResult;
  /** Remove the merges the format target touches. */
  unmergeTarget(): SessionResult;
  /** Width (characters; `null` = default) of the target's columns. */
  setColumnWidth(width: number | null): SessionResult;
  /** Height (points; `null` = default) of the target's rows. */
  setRowHeight(height: number | null): SessionResult;
  /** Freeze the rows above / columns left of the grid selection's anchor
   *  (no selection: the first row); clears an existing freeze. */
  toggleFreeze(): SessionResult;
  /** Sizes, merges and frozen split of the active sheet. */
  layout(): SheetLayoutInfo | null;
  /** The workbook's defined names. */
  names(): NameInfo[];
  /** Define (or redefine) `name` → `refersTo` (default: the format
   *  target); `sheetScoped` makes it local to the active sheet. */
  defineName(
    name: string,
    refersTo?: string,
    sheetScoped?: boolean,
  ): SessionResult;
  /** Delete a defined name (`scope` as `names()` reports it). */
  deleteName(name: string, scope?: number | null): SessionResult;
  /** Place a defined name or a table into a frame (like Lower to frame);
   *  the placement keeps the NAME, so a redefinition moves it. */
  placeName(name: string): Promise<string | null>;

  // ── Wave 5 — editing fundamentals ───────────────────────────────────

  /** The active cell (where typing lands) — the selection's anchor, or
   *  where Tab/Enter walked inside it. Null with no selection. */
  activeCell(): { row: number; col: number } | null;
  /** Select one cell (a click). */
  selectCell(row: number, col: number): void;
  /** Extend the selection from its anchor to `(row, col)` (shift-click,
   *  drag). */
  extendSelection(row: number, col: number): void;
  /** A key on the grid (in-frame or the panel): navigation, editing,
   *  clipboard, fill, clear, find, undo. Whether the grid took it. */
  handleGridKey(e: KeyLike): boolean;
  /** K-1 pointer in FRAME-CONTENT coordinates: a press selects (shift
   *  extends) or grabs the fill handle; a move drags; a release ends the
   *  gesture (a fill-handle release fills). Whether the grid took it. */
  pointerDownInFrame(
    contentX: number,
    contentY: number,
    mods?: { shift?: boolean; copy?: boolean; add?: boolean },
  ): boolean;
  /** Every area of the selection: those Ctrl/Cmd-click added, then the
   *  current one. */
  selectionAreas(): GridSelection[];
  /** What a press at `(x, y)` would grab: the selection's border (move),
   *  the fill handle, or a cell — for the pointer's cursor. */
  grabAt(contentX: number, contentY: number): "move" | "fill" | "cell" | null;
  pointerMoveInFrame(contentX: number, contentY: number): boolean;
  pointerUpInFrame(contentX: number, contentY: number): boolean;
  /** Scroll the in-frame grid window by rows / columns (never above A1). */
  scrollInFrame(dRows: number, dCols: number): boolean;
  /** A wheel over the entered frame, in content points (x right, y down):
   *  scroll the in-frame grid by whole rows / columns, carrying the
   *  remainder to the next wheel. False (the host pans instead) when no
   *  grid is showing or the window is already at the edge it scrolls
   *  toward. */
  wheelInFrame(dxPt: number, dyPt: number): boolean;
  /** Whether the in-frame grid is showing (a sheet frame is entered). */
  isInFrameActive(): boolean;
  /** The fill handle: fill `target` (which extends the selection in one
   *  direction) as a series. One undo step; `target` becomes the selection. */
  fillSelectionTo(target: GridSelection, series?: boolean): SessionResult;
  /** Cmd+D / Cmd+R: fill down / right from the selection's first row /
   *  column (or the cell above / left of a single row / column). */
  fillDown(): SessionResult;
  fillRight(): SessionResult;
  /** Delete: clear every populated cell of the selection (one undo step). */
  clearSelection(): SessionResult;
  /** Select + reveal the next (or previous) match after the active cell on
   *  the active sheet; remembered for {@link findAgain}. Null when nothing
   *  matches. */
  findNext(
    needle: string,
    opts?: FindOptions,
    backwards?: boolean,
  ): FindMatch | null;
  /** Repeat the last {@link findNext}. */
  findAgain(backwards?: boolean): FindMatch | null;
  /** Ask the grid panel to show its find field (bumps `findRequest`). */
  requestFind(): void;
}

/** Which edges `setBorders` draws. */
export type BorderKind =
  "all" | "outline" | "top" | "bottom" | "left" | "right" | "none";

/** A resolved format target (0-based inclusive bounds). */
export interface FormatTarget {
  sheet: number;
  range: string;
  top: number;
  left: number;
  bottom: number;
  right: number;
}

/** S-15 — coerce one provider cell value to the string the engine's
 *  `setCell` ingests (it parses the input back to a typed value in Rust —
 *  §3: no spreadsheet semantics in TS, this is pure transport).
 *
 *  CONTRACT NOTE (forward-compatible): the data-provider RFC's
 *  `ProviderRecordSet.columns[c][r]` cell MAY arrive as a PLAIN JS value
 *  (`string | number | boolean | null`) OR as the data engine's TAGGED form
 *  `{ t: "text"|"number"|"bool"|"date"|"datetime"|"null"|…, v }`. The
 *  contract (`plugin-api`) does not yet standardize which — a follow-up
 *  should pin one encoding. We handle BOTH defensively: an object carrying
 *  a `t`/`v` tag uses its `v`; anything else is used directly. `null` /
 *  `undefined` (and a null tag's value) lower to "" (a blank cell). */
export function cellToString(value: unknown): string {
  // Tagged form `{ t, v }` from the data engine — unwrap to the value.
  if (
    typeof value === "object" &&
    value !== null &&
    "t" in value &&
    "v" in value
  ) {
    return cellToString((value as { v: unknown }).v);
  }
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return String(value);
}

/** Default the range to the whole used extent of a sheet (A1 to the
 *  bottom-right used cell). Pure A1 formatting — NOT spreadsheet
 *  semantics (the engine decided the extent; this only names it). */
export function usedRangeA1(rows: number, cols: number): string {
  if (rows <= 0 || cols <= 0) return "A1";
  return `A1:${columnLabel(cols - 1)}${rows}`;
}

/** 0-based column index → A1 column letters (0→A, 25→Z, 26→AA). A
 *  display helper, not a parser; the engine validates the real range. */
export function columnLabel(index: number): string {
  let n = index;
  let label = "";
  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return label;
}

/** K-6 — the A1 range string for a grid selection rectangle (anchor +
 *  span). Pure A1 formatting (NOT spreadsheet semantics — the engine reads
 *  + validates the range). A 1×1 selection yields a single-cell range. */
export function selectionRangeA1(
  anchorRow: number,
  anchorCol: number,
  rows: number,
  cols: number,
): string {
  const start = `${columnLabel(anchorCol)}${anchorRow + 1}`;
  if (rows <= 1 && cols <= 1) return start;
  const end = `${columnLabel(anchorCol + cols - 1)}${anchorRow + rows}`;
  return `${start}:${end}`;
}

/** Paste special's options (Excel's dialog). `"all"` and `"formulas"` both
 *  paste inputs (formulas re-addressed) — the clipboard carries no formats
 *  yet; `"values"` pastes what the cells show. `operation` combines a
 *  numeric source with the target (an empty target counts as 0, a target
 *  formula is wrapped); text sources leave the target alone. */
export interface PasteOptions {
  what?: "all" | "formulas" | "values";
  transpose?: boolean;
  skipBlanks?: boolean;
  operation?: "none" | "add" | "subtract" | "multiply" | "divide";
}

/** Combine a paste `src` input with the target's `dst` input (paste special
 *  operations). Null: leave the target as it is. */
export function combinePaste(
  dst: string,
  src: string,
  op: NonNullable<PasteOptions["operation"]>,
): string | null {
  if (op === "none") return src;
  const num = (t: string) => {
    const v = t.trim();
    if (v === "") return 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const s = num(src);
  if (s === null || src.startsWith("=")) return null;
  if (dst.startsWith("=")) {
    const sign = { add: "+", subtract: "-", multiply: "*", divide: "/" }[op];
    return `=(${dst.slice(1)})${sign}${s}`;
  }
  const d = num(dst);
  if (d === null) return null;
  const r =
    op === "add"
      ? d + s
      : op === "subtract"
        ? d - s
        : op === "multiply"
          ? d * s
          : s === 0
            ? null
            : d / s;
  if (r === null) return "#DIV/0!";
  return String(r);
}

/** K-6 — parse a TSV `text` clipboard half into a rectangular grid (the
 *  fallback when the platform offered no rich `tabular`). Tabs split cells,
 *  newlines split rows; CRLF tolerated; a single trailing newline dropped
 *  (so a copied range doesn't gain a blank row). Pure transport — never
 *  spreadsheet semantics. */
export function tsvToRows(text: string): string[][] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const body = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  if (body === "") return [];
  return body.split("\n").map((line) => line.split("\t"));
}

/** Session wiring the bundle supplies (all optional). */
export interface SessionOptions {
  /** Cmd+F on the grid: the host side opens the find UI (the grid panel). */
  onFindRequest?: () => void;
}

export function createWorkbookSession(
  host: BundleHost,
  options: SessionOptions = {},
): WorkbookSession {
  // Panel-facing engine READS, memoised until the next change signal
  // (every engine write is followed by one): a panel re-renders on every
  // keystroke in its own inputs, and each render used to re-window the
  // grid scene, re-list the sheets and re-read the selected cell's input
  // through the wasm boundary.
  const readCache = new Map<string, unknown>();

  // ── Sheet ADR 521 — the formula display dialect ─────────────────────
  //
  // The formula bar and the cell editor show and take formulas in the
  // display dialect (R1C1 when the workbook asks for it, function names in
  // the host language); every journal, clipboard and object-model read
  // stays canonical. The language follows the host's until set; each new
  // engine is told once.
  let formulaLang =
    (typeof navigator !== "undefined" && navigator.language) || "en";
  /** The dialect learned for one engine and workbook load: `canonical`
   *  (A1, English) needs no engine call to translate. */
  let dialectSeen: {
    engine: SheetEngine;
    epoch: number;
    canonical: boolean;
  } | null = null;
  const englishLang = (tag: string) => !/^de\b/i.test(tag);
  function dialectEngine(): SheetEngine | null {
    const e = state.engine;
    if (!e?.formulaToDisplay || !e.formulaFromDisplay || !e.formulaDisplay)
      return null;
    if (dialectSeen?.engine !== e || dialectSeen.epoch !== loadEpoch) {
      let canonical = true;
      try {
        const r1c1 = e.formulaDisplay().r1c1;
        // The engine starts in English; tell it only another language.
        if (!englishLang(formulaLang)) e.setFormulaDisplay?.(r1c1, formulaLang);
        canonical = !r1c1 && englishLang(formulaLang);
      } catch (err) {
        host.log.warn("formula display: engine refused the language", err);
      }
      dialectSeen = { engine: e, epoch: loadEpoch, canonical };
    }
    return e;
  }
  /** Canonical input → what the formula bar shows. */
  function toDisplay(row: number, col: number, input: string): string {
    const e = dialectEngine();
    if (!e || dialectSeen?.canonical || !input.startsWith("=")) return input;
    try {
      return e.formulaToDisplay!(row, col, input);
    } catch {
      return input;
    }
  }
  /** What the formula bar took → canonical input. */
  function fromDisplay(row: number, col: number, input: string): string {
    const e = dialectEngine();
    if (!e || dialectSeen?.canonical || !input.startsWith("=")) return input;
    try {
      return e.formulaFromDisplay!(row, col, input);
    } catch {
      return input;
    }
  }

  function cachedRead<T>(key: string, read: () => T): T {
    if (readCache.has(key)) return readCache.get(key) as T;
    const v = read();
    readCache.set(key, v);
    return v;
  }
  const emitter = new Emitter(() => readCache.clear());
  const state: SessionState = {
    engine: null,
    fileName: null,
    activeSheet: null,
    selectedRange: null,
    bootError: null,
    gridSelection: null,
    dataSource: null,
    findRequest: 0,
  };

  // S-15 — the live `onDidChange` subscription for the currently-linked
  // dataset (disposed + replaced on each `sourceFromDataset`, and on
  // `dispose`). Null when the workbook is not dataset-sourced.
  let dataSourceSub: { dispose(): void } | null = null;

  // C-1 / S-02 — the last frame this session lowered into (the target for
  // the in-frame grid) + the lazily-obtained scene-layer surface.
  let lastFrameId: string | null = null;

  // S-04 — the last NATIVE TABLE this session lowered (frame/story/table ids
  // + the sheet/range it projects). "New style from cell" addresses this
  // table's cells; null until a range is lowered to a native table.
  let lastLoweredTable: LoweredTableInfo | null = null;
  // ADR 023 — frameId → the table that frame projects. `lastLoweredTable`
  // answers "the most recent lowering", which is the right question for
  // S-04 and the WRONG one for a panel retargeting on the frame you just
  // entered: with two sheet frames on the page they disagree.
  const loweredTables = new Map<string, LoweredTableInfo>();
  // Wave 4 — the charts this session placed (their elements, so a refresh
  // can replace them) and the live paginated chains (storyId → handle).
  let placedCharts: PlacedChart[] = [];
  // Wave 6 — the repeated-header option a chain was paginated with.
  const chainHeaderRows = new Map<string, number>();
  const chains = new Map<
    string,
    {
      sub: ChainSubscription;
      sheet: number;
      range: string | readonly string[];
    }
  >();
  /** Plan G4 — a chart of this workbook was deleted (or its stored bytes
   *  came with deleted slots): every save then carries the slots the bytes
   *  no longer hold (`chartTombstones`). */
  let chartSlotsTracked = false;
  /** Re-open deleted chart slots in the engine right after a load. */
  function restoreChartSlots(slots: readonly number[]): void {
    if (slots.length === 0 || !state.engine) return;
    chartSlotsTracked = true;
    try {
      state.engine.restoreChartSlots?.([...slots]);
    } catch (err) {
      host.log.warn("deleted chart slots could not be restored", err);
    }
  }
  // The workbook content version: +1 per committed edit. Placed frames'
  // bindings carry the version they show (it was always 0 before).
  let revision = 0;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let refreshChain: Promise<void> = Promise.resolve();
  // S-04 — a per-session counter so minted cell-style ids are unique within
  // one session (paired with a timestamp so they are unique across sessions).
  let nextCellStyleSeq = 1;
  /** Where the in-frame grid starts for `frameId` (ADR 510): the bound
   *  sheet, made active, and the view's top-left cell. Falls back to the
   *  active sheet at A1 when the frame carries no binding, the binding names
   *  a sheet the workbook does not have, or the read fails. */
  const frameStart = async (
    frameId: string,
  ): Promise<{ row: number; col: number }> => {
    if (!state.engine || !host.document.getMetadata) return { row: 0, col: 0 };
    let binding: ReturnType<typeof parseBinding> = null;
    try {
      binding = parseBinding(
        await host.document.getMetadata({
          kind: "textFrame",
          id: frameId,
        } as ElementId),
      );
    } catch (err) {
      host.log.debug("showGridInFrame: binding read failed", err);
    }
    if (!binding) return { row: 0, col: 0 };
    const sheet = state.engine
      .listSheets()
      .find((x) => x.name === binding.data.sheet);
    if (!sheet) return { row: 0, col: 0 };
    if (state.activeSheet !== sheet.id) {
      state.activeSheet = sheet.id;
      state.gridSelection = null; // selection is sheet-relative
      defaultRangeForActive();
      emitter.emit();
    }
    return cellOfA1(binding.data.view.topLeft) ?? { row: 0, col: 0 };
  };

  let sceneSurface: SceneLayerSurface | null = null;
  // Ctrl+X: the cut range, cleared when its paste lands (Excel moves it).
  let cutPending: GridSelection | null = null;
  // Extensions ADR 334 — the mounted frame surface's sink and cell area;
  // while set, the grid goes there instead of the scene layer.
  let surfaceSink: ((scene: GridScene) => void) | null = null;
  let surfaceArea: { wPt: number; hPt: number } | null = null;
  const sceneChannel = (): SceneLayerSurface | null => {
    if (!host.supports("rendering.sceneLayer@1")) return null;
    if (!sceneSurface) sceneSurface = host.contribute.sceneLayer();
    return sceneSurface;
  };

  // K-1 — the LAST in-frame grid this session rendered: the window it was
  // computed with (so a re-render keeps the same viewport) + the resolved
  // scene (so a content-space pointer can `hitCell` against it without
  // re-querying the engine). Both null until `showGridInFrame` runs.
  let lastGridWindow: {
    firstRow: number;
    firstCol: number;
    wPt: number;
    hPt: number;
  } | null = null;
  let lastGridScene: GridScene | null = null;
  // The wheel's sub-step remainder in content points [x, y].
  let wheelCarry: [number, number] = [0, 0];

  // K-1 — the in-frame cell EDITOR buffer (a keystroke edit, no DOM
  // overlay): the cell being typed into + its in-progress text. The grid
  // re-renders with this text overlaid until commit (→ engine.setCell) or
  // cancel. `null` ⇒ not editing (the context is not "dirty").
  let cellEdit: { row: number; col: number; text: string } | null = null;
  // Wave 5 — how the open edit began: typing ("enter": arrows commit and
  // move, Excel's Enter mode) or F2 ("edit": arrows belong to the editor).
  let cellEditMode: "enter" | "edit" = "enter";

  // Wave 5 — the selection model behind `state.gridSelection` (anchor,
  // moving focus, active cell; see grid-nav.ts), the pointer gesture in
  // progress, the fill-handle drag's target (drawn in-frame), the last
  // copy's input snapshot (a paste of our own copy carries formulas) and
  // the last find.
  let selModel: SelectionModel | null = null;
  let drag:
    | { kind: "select" }
    | { kind: "fill"; source: GridSelection; target: GridSelection | null }
    | {
        kind: "move";
        source: GridSelection;
        anchor: { row: number; col: number };
        target: GridSelection | null;
        copy: boolean;
      }
    | null = null;

  /** Excel's auto-scroll: a drag past the cell area's edge scrolls the
   *  window one track toward it per move; answers the cell under the
   *  clamped point. */
  function autoScrollHit(
    contentX: number,
    contentY: number,
  ): { row: number; col: number } | null {
    if (!lastGridScene || !lastGridWindow) return null;
    const w = lastGridWindow.wPt;
    const h = lastGridWindow.hPt;
    const dRow = contentY > h ? 1 : contentY < 0 ? -1 : 0;
    const dCol = contentX > w ? 1 : contentX < 0 ? -1 : 0;
    if (dRow === 0 && dCol === 0) return null;
    const scene = lastGridScene;
    const vp = scene.viewport;
    const xs = vp.xOffsets;
    const ys = vp.yOffsets;
    const cx = Math.min(
      Math.max(contentX, 0.5),
      (xs[xs.length - 1] ?? 1) - 0.5,
    );
    const cy = Math.min(
      Math.max(contentY, 0.5),
      (ys[ys.length - 1] ?? 1) - 0.5,
    );
    const hit = hitCell(scene, cx, cy);
    if (!hit) return null;
    // The scene repaints asynchronously: place the cell by the window's
    // new origin, which the scroll moves at once.
    api.scrollInFrame(dRow, dCol);
    const win = lastGridWindow;
    return {
      row: Math.max(0, hit.row - vp.firstRow + win.firstRow),
      col: Math.max(0, hit.col - vp.firstCol + win.firstCol),
    };
  }

  /** Move (or, with `copy`, copy) the cells of `source` to `target` — one
   *  undo step. A move keeps its formulas as they are; a copy re-addresses
   *  them like a paste. The source cells the target does not cover are
   *  emptied on a move. (Cell formats stay where they are.) */
  function moveCells(
    source: GridSelection,
    target: GridSelection,
    copy: boolean,
  ): SessionResult {
    const engine = state.engine;
    const sheet = state.activeSheet;
    if (!engine || sheet === null || !engine.getRangeInputs)
      return { ok: false, message: "open a workbook first" };
    const range = selectionRangeA1(
      source.anchorRow,
      source.anchorCol,
      source.rows,
      source.cols,
    );
    let inputs = engine.getRangeInputs(sheet, range);
    const dRow = target.anchorRow - source.anchorRow;
    const dCol = target.anchorCol - source.anchorCol;
    if (copy && engine.shiftFormulas) {
      try {
        inputs = engine.shiftFormulas(sheet, inputs, dRow, dCol);
      } catch {
        return { ok: false, message: "the copy could not adjust its formulas" };
      }
    }
    const targets: CellEditRecord[] = [];
    inputs.forEach((row, r) =>
      row.forEach((next, c) =>
        targets.push({
          sheet,
          row: target.anchorRow + r,
          col: target.anchorCol + c,
          prevInput: "",
          nextInput: next,
        }),
      ),
    );
    if (!copy) {
      const inTarget = (r: number, c: number) =>
        r >= target.anchorRow &&
        r < target.anchorRow + target.rows &&
        c >= target.anchorCol &&
        c < target.anchorCol + target.cols;
      for (let r = source.anchorRow; r < source.anchorRow + source.rows; r++)
        for (let c = source.anchorCol; c < source.anchorCol + source.cols; c++)
          if (!inTarget(r, c))
            targets.push({
              sheet,
              row: r,
              col: c,
              prevInput: "",
              nextInput: "",
            });
    }
    const { written, journaled } = writeTargets(engine, targets, "moveCells");
    if (journaled) journalBatch(written);
    else markEdited();
    emitter.emit({ kind: "cells", regions: regionsOf(written) });
    applyModel(modelOfRect(target));
    void submitInFrameGrid();
    return { ok: true };
  }
  let fillPreview: GridSelection | null = null;
  let copySource: {
    sheet: number;
    rect: GridSelection;
    displays: string[][];
    inputs: string[][];
  } | null = null;
  let lastFind: { needle: string; opts: FindOptions } | null = null;
  // Whether the in-frame grid is showing (a sheet frame is entered).
  let inFrameActive = false;

  // S-04 formula bar — the engine's function name table, cached after the
  // first read (the registry is build-time fixed; one wasm call suffices for
  // the whole session). Null until first requested.
  let functionCache: readonly FunctionEntry[] | null = null;

  // ADR-012 Tier 1 — the in-session undo JOURNAL: one entry per COMMITTED
  // cell edit (Tier 0 already coalesced keystrokes into the commit).
  // `prev`/`next` are re-enterable INPUT texts (engine.getCellInput —
  // formula-safe; the display is NOT an inverse). Entries [0, cursor) are
  // undoable, [cursor, length) redoable; a fresh commit truncates the redo
  // tail (the linear-history rule). Cleared on workbook load/source (the
  // session boundary) and on modal exit (Tier 2 owns the document grain).
  // `batch` (additive): entries sharing a batch id were one BULK op (sort /
  // replace-all) — undo/redo unwind the whole batch as ONE step. Plain cell
  // edits carry no batch and unwind singly (unchanged behavior).
  //
  // Wave 9: a FORMAT change (style, borders, merge, sizes, freeze, names;
  // the formats a fill carries) is a journal entry too — `fmt` holds its
  // two directions, captured from the engine's own reads before the change
  // (style-id snapshots, the layout, the names). It shares a `batch` with
  // the cell rewrites it belongs to (a fill, a merge's cleared cells), so
  // one Cmd-Z undoes the whole operation.
  let editJournal: {
    sheet: number;
    row: number;
    col: number;
    prev: string;
    next: string;
    batch?: number;
    /** The workbook content version right after this entry committed —
     *  what a placed frame's binding carries once the edit is refreshed
     *  onto the page (the document-undo follower keys on it). */
    rev?: number;
    /** A format step (no cell input changes; `row`/`col` are its anchor). */
    fmt?: FormatStep;
  }[] = [];
  let journalCursor = 0;
  let nextJournalBatch = 1;
  // ADR-012 Tier 1 — while a sheet frame is entered, Cmd-Z stops at the
  // journal position the session began at (the modal boundary); the
  // entries before it belong to the document's history.
  let sessionFloor = 0;
  // Tier 2 — refreshes the session's edits would schedule are held while
  // the frame is entered (the in-frame grid covers it) and land as one
  // refresh on exit; `suppressRefresh` keeps a document-driven unwind from
  // writing the page the document just restored.
  let refreshDeferred = false;
  /** Excel's multi-area selection: the areas Ctrl/Cmd-click added before
   *  the current one (the current one is `state.gridSelection`). */
  let extraAreas: GridSelection[] = [];
  /** True while a Ctrl/Cmd-click is laying out a new area. */
  let addingArea = false;
  /** Paste special's options card is open (the sheet bar shows it). */
  let pasteSpecialCard = false;
  let suppressRefresh = false;

  /** Write one cell through the engine AND journal it (the shared Tier-1
   *  capture for `editCell` + the in-frame commit). Returns false when
   *  there is no engine or the write throws — nothing is journaled then. */
  function journaledSetCell(
    sheet: number,
    row: number,
    col: number,
    input: string,
  ): boolean {
    const engine = state.engine;
    if (!engine) return false;
    let written: { prev: string; restyled: readonly Restyle[] };
    try {
      written = writeOneCell(engine, sheet, row, col, input);
    } catch (err) {
      host.log.error("setCell failed", err);
      return false;
    }
    const { prev, restyled } = written;
    editJournal.length = journalCursor; // drop any redo tail
    if (restyled.length > 0) {
      // Typed entry: the value AND the format it implied (`45%` → `0%`) are
      // ONE step — one Cmd-Z puts back both the input and the style.
      const batch = nextJournalBatch++;
      editJournal.push({
        sheet,
        row,
        col,
        prev: "",
        next: "",
        batch,
        fmt: restyleStep(restyled),
      });
      editJournal.push({ sheet, row, col, prev, next: input, batch });
    } else {
      editJournal.push({ sheet, row, col, prev, next: input });
    }
    journalCursor = editJournal.length;
    markEdited();
    stampRev();
    return true;
  }

  /** A typed entry through the engine's validation (`enterCell`, sheet ADR
   *  517) and journaled like `journaledSetCell`: the prior input is read
   *  first, the format the text implied rides the same step. An engine
   *  without the door takes `journaledSetCell`. Null when the write failed
   *  (logged; nothing journaled). */
  function journaledEnterCell(
    sheet: number,
    row: number,
    col: number,
    input: string,
    confirmed: boolean,
  ): EnterResult | null {
    const engine = state.engine;
    if (!engine) return null;
    if (!engine.enterCell)
      return journaledSetCell(sheet, row, col, input)
        ? { applied: true }
        : null;
    let prev: string;
    let res: EnterResult;
    try {
      // Free when the formula bar just showed the cell (a memoised read).
      prev =
        cachedRead(`input:${sheet}:${row}:${col}`, () =>
          engine.getCellInput(sheet, row, col),
        ) ?? "";
      res = engine.enterCell(sheet, row, col, input, confirmed);
    } catch (err) {
      host.log.warn("enterCell refused", err);
      return null;
    }
    if (!res.applied) return res;
    const restyled = (res.result as { restyled?: readonly Restyle[] } | null)
      ?.restyled;
    editJournal.length = journalCursor; // drop any redo tail
    const batch = nextJournalBatch++;
    if (restyled && restyled.length > 0)
      editJournal.push({
        sheet,
        row,
        col,
        prev: "",
        next: "",
        batch,
        fmt: restyleStep(restyled),
      });
    editJournal.push({ sheet, row, col, prev, next: input, batch });
    journalCursor = editJournal.length;
    markEdited();
    stampRev();
    return res;
  }

  /** Write one cell and return its PRIOR input (the journal's inverse).
   *  The batch door is preferred: its slim `{changedCount, circular,
   *  prevInputs}` reply carries the prior input, so the write costs one
   *  engine call (no read first, no changed cell's display marshalled
   *  back). An engine without the door — or one that refuses the input as a
   *  batch, or whose reply predates `prevInputs` (then the prior is the
   *  memoised read the formula bar usually made a moment ago) — reads the
   *  prior and takes `setCell`. */
  function writeOneCell(
    engine: SheetEngine,
    sheet: number,
    row: number,
    col: number,
    input: string,
  ): { prev: string; restyled: readonly Restyle[] } {
    const readPrev = () =>
      cachedRead(`input:${sheet}:${row}:${col}`, () =>
        engine.getCellInput(sheet, row, col),
      );
    if (engine.setCells) {
      let res: ReturnType<NonNullable<SheetEngine["setCells"]>> | undefined;
      // An engine whose reply has no `prevInputs` must be read BEFORE the
      // write; we only learn that from a reply, so a memoised read (free
      // when the bar just showed the cell) is the safe fallback for it.
      try {
        res = engine.setCells([{ sheet, row, col, input }]);
      } catch {
        // fall through: setCell is the authority on a single input
      }
      if (res) {
        const restyled = res.restyled ?? [];
        const prev = res.prevInputs?.[0];
        if (prev !== undefined) return { prev, restyled };
        host.log.warn(
          "setCells reply has no prevInputs — the journal reads the new input",
        );
        return { prev: readPrev(), restyled };
      }
    }
    const prev = readPrev();
    const res = engine.setCell(sheet, row, col, input);
    return { prev, restyled: res?.restyled ?? [] };
  }

  /** The format step of a typed entry's restyle: each cell's style id
   *  before / after (one-cell `setStyleIds` writes). Undone after the cell
   *  writes, so the prior style wins over what re-typing the prior input
   *  implies. */
  function restyleStep(restyled: readonly Restyle[]): FormatStep {
    const put = (e: SheetEngine, which: "before" | "after") => {
      if (!e.setStyleIds) return;
      for (const r of restyled) {
        e.setStyleIds(r.sheet, selectionRangeA1(r.row, r.col, 1, 1), [
          r[which],
        ]);
      }
    };
    return {
      undo: (e) => put(e, "before"),
      redo: (e) => put(e, "after"),
      undoAfterCells: true,
    };
  }

  /** Stamp the content version on the entries a commit just pushed. */
  function stampRev(): void {
    for (
      let i = journalCursor - 1;
      i >= 0 && editJournal[i].rev === undefined;
      i--
    ) {
      editJournal[i].rev = revision;
    }
  }

  /** Un/re-apply ONE journal step (a batched group whole) through one
   *  batch write when the engine has the door. False when exhausted or the
   *  write fails. Emits + re-renders. */
  function stepJournal(dir: "undo" | "redo"): boolean {
    const engine = state.engine;
    if (!engine) return false;
    const undo = dir === "undo";
    if (undo ? journalCursor === 0 : journalCursor >= editJournal.length)
      return false;
    const first = undo ? journalCursor - 1 : journalCursor;
    const group = editJournal[first].batch;
    let last = first;
    if (group !== undefined) {
      while (
        undo
          ? last > 0 && editJournal[last - 1].batch === group
          : last + 1 < editJournal.length &&
            editJournal[last + 1].batch === group
      ) {
        last += undo ? -1 : 1;
      }
    }
    const entries = undo
      ? editJournal.slice(last, first + 1).reverse()
      : editJournal.slice(first, last + 1);
    // Format steps run in journal order (reversed for undo), before the
    // cell writes on undo (a merge's anchor must be unmerged before its
    // cleared cells get their inputs back) and after them on redo. A typed
    // entry's restyle (`undoAfterCells`) undoes after the writes too.
    const steps = entries.filter((e) => e.fmt);
    const runSteps = (late = false): boolean => {
      for (const e of steps) {
        if (undo && (e.fmt!.undoAfterCells ?? false) !== late) continue;
        try {
          if (undo) e.fmt!.undo(engine);
          else e.fmt!.redo(engine);
        } catch (err) {
          host.log.error(`${dir}: format step failed`, err);
          return false;
        }
      }
      return true;
    };
    if (undo && !runSteps()) return false;
    const cells = entries.filter((e) => !e.fmt);
    const writes = cells.map((e) => ({
      sheet: e.sheet,
      row: e.row,
      col: e.col,
      input: undo ? e.prev : e.next,
    }));
    let done = writes.length === 0;
    if (!done && engine.setCells && writes.length > 1) {
      try {
        engine.setCells(writes);
        done = true;
      } catch (err) {
        host.log.debug(`${dir}: batch write refused — per cell`, err);
      }
    }
    if (!done) {
      for (const w of writes) {
        try {
          writeOneCell(engine, w.sheet, w.row, w.col, w.input);
        } catch (err) {
          host.log.error(`${dir}: engine write failed`, err);
          return false;
        }
      }
    }
    if (!runSteps(true)) return false;
    journalCursor = undo ? last : last + 1;
    markEdited();
    emitter.emit(
      steps.length > 0
        ? undefined
        : { kind: "cells", regions: regionsOf(entries) },
    );
    void submitInFrameGrid();
    return true;
  }

  /** Journal a BULK op's per-cell rewrites (the engine's `edits` lane —
   *  prev/next already faithful inputs) as ONE grouped batch: a single
   *  undo/redo step for the whole sort / replace-all. No-op when the op
   *  changed nothing. */
  function journalBatch(
    edits: readonly CellEditRecord[],
    fmt?: FormatStep | null,
  ): void {
    if (edits.length === 0 && !fmt) return;
    editJournal.length = journalCursor; // drop any redo tail
    const batch = nextJournalBatch++;
    if (fmt)
      editJournal.push({
        sheet: 0,
        row: 0,
        col: 0,
        prev: "",
        next: "",
        batch,
        fmt,
      });
    for (const e of edits) {
      editJournal.push({
        sheet: e.sheet,
        row: e.row,
        col: e.col,
        prev: e.prevInput,
        next: e.nextInput,
        batch,
      });
    }
    journalCursor = editJournal.length;
    markEdited();
    stampRev();
  }

  /** Run a FORMAT change and journal it as ONE undo step (Wave 9): `capture`
   *  reads what the change will overwrite and returns the step's two
   *  directions (or null — the engine lacks the read; the change still runs,
   *  un-journaled, as before), `apply` makes the change and may return cell
   *  rewrites that belong to it (a merge's cleared cells) — journaled in the
   *  same step. */
  function journalFormat(
    capture: (engine: SheetEngine) => (() => FormatStep) | null,
    apply: (engine: SheetEngine) => readonly CellEditRecord[] | void,
  ): SessionResult {
    const engine = state.engine;
    if (!engine) return { ok: false, message: "no workbook open" };
    let seal: (() => FormatStep) | null;
    let edits: readonly CellEditRecord[] = [];
    try {
      seal = capture(engine);
      edits = apply(engine) ?? [];
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
    let step: FormatStep | null = null;
    try {
      step = seal ? seal() : null;
    } catch (err) {
      host.log.warn("format change applied but not journaled", err);
    }
    if (step) journalBatch(edits, step);
    else markEdited();
    emitter.emit();
    return { ok: true };
  }

  /** The style-id snapshot step over `sheet`/`range` (null when the engine
   *  lacks the door): read now, read again once the change ran (`seal`). */
  function styleSnapshot(
    engine: SheetEngine,
    sheet: number,
    range: string,
  ): (() => FormatStep) | null {
    if (!engine.getStyleIds || !engine.setStyleIds) return null;
    const before = engine.getStyleIds(sheet, range);
    return () => {
      const after = engine.getStyleIds!(sheet, range);
      return {
        undo: (e) => e.setStyleIds!(sheet, range, before),
        redo: (e) => e.setStyleIds!(sheet, range, after),
      };
    };
  }

  /** The step of a column-width / row-height change over `first..=last`:
   *  each index's explicit size before (absent = the default, `null`). */
  function sizeStep(
    engine: SheetEngine,
    sheet: number,
    axis: "col" | "row",
    first: number,
    last: number,
    size: number | null,
  ): (() => FormatStep) | null {
    const layout = engine.getLayout?.(sheet);
    if (!layout) return null;
    const had = new Map(axis === "col" ? layout.colWidths : layout.rowHeights);
    const set = (x: SheetEngine, a: number, b: number, v: number | null) =>
      axis === "col"
        ? x.setColWidth!(sheet, a, b, v)
        : x.setRowHeight!(sheet, a, b, v);
    return () => ({
      undo: (x) => {
        for (let i = first; i <= last; i++) set(x, i, i, had.get(i) ?? null);
      },
      redo: (x) => set(x, first, last, size),
    });
  }

  /** The step of a defined-name change: the name as it stood before (its
   *  target, or absent) comes back on undo; `redo` repeats the change. */
  function nameStep(
    engine: SheetEngine,
    sheet: number,
    name: string,
    scope: number | null,
    redo: () => void,
  ): (() => FormatStep) | null {
    if (!engine.listNames || !engine.defineName || !engine.deleteName)
      return null;
    const key = name.toLowerCase();
    const prior = engine
      .listNames()
      .find((n) => n.name.toLowerCase() === key && (n.scope ?? null) === scope);
    return () => ({
      undo: (x) => {
        if (prior) x.defineName!(sheet, prior.name, prior.refersTo, scope);
        else x.deleteName!(sheet, name, scope);
      },
      redo: () => redo(),
    });
  }

  // ── K-1 in-frame cell editor (shared by the public verbs and the key
  //    map). ────────────────────────────────────────────────────────────

  /** A printable key: begin a fresh (replace-mode) edit on the ACTIVE
   *  cell, or append to the open one. False when there is no selected
   *  cell / not a single char. */
  function typeChar(ch: string): boolean {
    if (ch.length !== 1) return false;
    if (!cellEdit) {
      const at = activeOf();
      if (!at || !data.mayEdit(at.row, at.col)) return false;
      cellEdit = { row: at.row, col: at.col, text: ch };
      cellEditMode = "enter";
    } else {
      cellEdit = { ...cellEdit, text: cellEdit.text + ch };
    }
    emitter.emit({ kind: "edit" });
    void submitInFrameGrid();
    return true;
  }

  /** Backspace in an edit: open from the cell's current value if not
   *  already open, then drop the last char. */
  function backspaceEdit(): boolean {
    if (!cellEdit) {
      const at = activeOf();
      if (!at) return false;
      cellEdit = {
        row: at.row,
        col: at.col,
        text: cellDisplay(at.row, at.col),
      };
      cellEditMode = "edit";
    }
    cellEdit = { ...cellEdit, text: cellEdit.text.slice(0, -1) };
    emitter.emit({ kind: "edit" });
    void submitInFrameGrid();
    return true;
  }

  /** F2: open an edit on the active cell with its re-enterable INPUT (the
   *  formula, not its display). */
  function openEdit(): boolean {
    if (cellEdit) return true;
    const at = activeOf();
    if (!at || !state.engine || state.activeSheet === null) return false;
    if (!data.mayEdit(at.row, at.col)) return false;
    let text = "";
    try {
      text = toDisplay(
        at.row,
        at.col,
        state.engine.getCellInput(state.activeSheet, at.row, at.col) ?? "",
      );
    } catch {
      text = cellDisplay(at.row, at.col);
    }
    cellEdit = { row: at.row, col: at.col, text };
    cellEditMode = "edit";
    emitter.emit({ kind: "edit" });
    void submitInFrameGrid();
    return true;
  }

  /** Enter: write the buffer through the engine, clear the edit, re-render.
   *  Whether an edit was committed. */
  function commitEdit(): boolean {
    if (!cellEdit) return false;
    const { row, col, text } = cellEdit;
    cellEdit = null;
    const sheet = state.activeSheet;
    if (state.engine && sheet !== null) {
      // Sheet ADR 517 — protection and validation decide; a held-back
      // entry waits on its alert (Retry / Yes / OK reopen or apply it).
      if (!data.enterTyped(sheet, row, col, fromDisplay(row, col, text))) {
        emitter.emit({ kind: "edit" });
        void submitInFrameGrid();
        return false;
      }
      emitter.emit({
        kind: "cells",
        regions: regionsOf([{ sheet, row, col }]),
      });
    } else {
      emitter.emit();
    }
    void submitInFrameGrid();
    return true;
  }

  /** Esc: drop the buffer and re-render the committed value. */
  function cancelEdit(): void {
    if (!cellEdit) return;
    cellEdit = null;
    emitter.emit({ kind: "edit" });
    void submitInFrameGrid();
  }

  // ── Wave 5 — the document's undo reaches the workbook ────────────────
  //
  // Sheet edits reach the page as refreshes: document mutations that
  // re-stamp each placed frame's binding with the workbook content version
  // they show. A host Cmd-Z OUTSIDE the modal session undoes those
  // mutations; when it takes a binding back to an older version, the
  // workbook follows — the journal unwinds to that version (redo: forward
  // again), without writing the page the document just restored.

  async function followDocumentHistory(): Promise<void> {
    if (!state.engine || loweredTables.size === 0 || !host.document.getMetadata)
      return;
    let target: number | null = null;
    let from: number | null = null;
    const moved: string[] = [];
    for (const [frameId, info] of loweredTables) {
      if (info.contentVersion === undefined) continue;
      let shown: number | undefined;
      try {
        const env = await host.document.getMetadata({
          kind: "textFrame",
          id: frameId,
        } as ElementId);
        shown = parseBinding(env)?.data.contentVersion;
      } catch (err) {
        host.log.debug("document-undo follower: binding read failed", err);
        continue;
      }
      if (shown === undefined || shown === info.contentVersion) continue;
      moved.push(frameId);
      target ??= shown;
      from ??= info.contentVersion;
    }
    if (target === null || from === null) return;
    suppressRefresh = true;
    try {
      if (target < from) {
        while (
          journalCursor > 0 &&
          (editJournal[journalCursor - 1].rev ?? 0) > target &&
          stepJournal("undo")
        );
      } else {
        while (
          journalCursor < editJournal.length &&
          (editJournal[journalCursor].rev ?? Infinity) <= target &&
          stepJournal("redo")
        );
      }
    } finally {
      suppressRefresh = false;
    }
    // The page now shows `target`; the next refresh diffs against what was
    // last written (rewriting a cell the document already restored is a
    // no-op), so the baseline content stays.
    for (const frameId of moved) {
      const info = loweredTables.get(frameId);
      if (!info) continue;
      const next = { ...info, contentVersion: target };
      loweredTables.set(frameId, next);
      if (lastLoweredTable?.frameId === frameId) lastLoweredTable = next;
    }
  }

  let historyChain: Promise<void> = Promise.resolve();
  const historySub = host.document.onDidChange((e) => {
    if (e.kind !== "undoApplied" && e.kind !== "redoApplied") return;
    historyChain = historyChain.then(followDocumentHistory).catch((err) => {
      host.log.warn("document-undo follower failed", err);
    });
  });

  // ── Wave 5 — selection model, bulk writes, fill, clear, find, keys ──

  /** The live selection model (rebuilt from `state.gridSelection` when
   *  something else — a sheet switch, a panel call — replaced it). */
  function currentModel(): SelectionModel | null {
    const sel = state.gridSelection;
    if (!sel) return null;
    if (selModel) {
      const r = rectOf(selModel);
      if (
        r.anchorRow === sel.anchorRow &&
        r.anchorCol === sel.anchorCol &&
        r.rows === sel.rows &&
        r.cols === sel.cols
      ) {
        return selModel;
      }
    }
    return modelOfRect(sel);
  }

  /** The active cell (where typing lands), or null with no selection. */
  function activeOf(): Cell | null {
    return currentModel()?.active ?? null;
  }

  /** Make `m` the selection: record it, scroll the in-frame grid so the
   *  active cell shows, re-render. */
  function applyModel(m: SelectionModel): void {
    if (!addingArea) extraAreas = [];
    const r = rectOf(m);
    applyGridSelection(r.anchorRow, r.anchorCol, r.rows, r.cols, m);
    revealInFrame(m.active);
    void submitInFrameGrid();
  }

  /** Move the in-frame window (as little as possible) so `cell` shows. */
  function revealInFrame(cell: Cell): void {
    if (!lastGridWindow || !lastGridScene) return;
    const vis = fullyVisible(
      lastGridScene,
      lastGridWindow.wPt,
      lastGridWindow.hPt,
    );
    const next = scrollToShow(lastGridWindow, vis, cell);
    if (
      next.firstRow !== lastGridWindow.firstRow ||
      next.firstCol !== lastGridWindow.firstCol
    ) {
      lastGridWindow = { ...lastGridWindow, ...next };
    }
  }

  /** Write `targets` (their `nextInput`): ONE write + ONE recalc through
   *  the batch door, whose reply carries every cell's PRIOR input — the
   *  journal's inverse, so nothing is read first. The door refuses the
   *  whole batch on any bad input; then the cells go one by one (prior read
   *  per cell), so a single bad cell is skipped, not the operation.
   *  Returns the written cells with their priors; `journaled: false` when
   *  an engine's reply predates `prevInputs` (written, priors unknown —
   *  journal nothing rather than an undo that restores the wrong text). */
  function writeTargets(
    engine: SheetEngine,
    targets: readonly CellEditRecord[],
    what: string,
  ): { written: CellEditRecord[]; journaled: boolean } {
    if (engine.setCells && targets.length > 0) {
      try {
        const res = engine.setCells(
          targets.map((t) => ({
            sheet: t.sheet,
            row: t.row,
            col: t.col,
            input: t.nextInput,
          })),
        );
        const prev = res.prevInputs;
        if (prev && prev.length === targets.length) {
          return {
            written: targets.map((t, i) => ({ ...t, prevInput: prev[i] })),
            journaled: true,
          };
        }
        host.log.warn(
          `${what}: setCells reply has no prevInputs — not journaled`,
        );
        return { written: [...targets], journaled: false };
      } catch (err) {
        host.log.debug(`${what}: batch write refused — per cell`, err);
      }
    }
    const written: CellEditRecord[] = [];
    for (const t of targets) {
      let prevInput: string;
      try {
        prevInput = engine.getCellInput(t.sheet, t.row, t.col);
        engine.setCell(t.sheet, t.row, t.col, t.nextInput);
      } catch (err) {
        host.log.warn(
          `${what}: setCell(${t.sheet},${t.row},${t.col}) failed`,
          err,
        );
        continue;
      }
      written.push({ ...t, prevInput });
    }
    return { written, journaled: true };
  }

  /** Fill `target` from the current selection through the engine
   *  (`series` = the fill handle; false = fill down / right). One undo
   *  step; the filled range becomes the selection. */
  function fillTo(
    source: GridSelection,
    target: GridSelection,
    series: boolean,
    select: GridSelection,
  ): SessionResult {
    const engine = state.engine;
    const sheet = state.activeSheet;
    if (!engine || sheet === null)
      return { ok: false, message: "no workbook / sheet" };
    if (!engine.fillRange) {
      return {
        ok: false,
        message: "engine wasm predates fill_range — rebuild it",
      };
    }
    if (cellEdit) commitEdit();
    let res;
    try {
      res = engine.fillRange(
        sheet,
        selectionRangeA1(
          source.anchorRow,
          source.anchorCol,
          source.rows,
          source.cols,
        ),
        selectionRangeA1(
          target.anchorRow,
          target.anchorCol,
          target.rows,
          target.cols,
        ),
        series,
      );
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
    // The formats the fill carried (the engine reports the style ids it
    // swapped) are part of the same step: one Cmd-Z undoes the whole fill.
    const swap = res.styles;
    const fmt: FormatStep | null =
      swap && engine.setStyleIds
        ? {
            undo: (e) => e.setStyleIds!(sheet, swap.range, swap.before),
            redo: (e) => e.setStyleIds!(sheet, swap.range, swap.after),
          }
        : null;
    journalBatch(res.edits, fmt);
    emitter.emit({ kind: "cells", regions: regionsOf(res.edits) });
    applyModel(modelOfRect(select));
    return { ok: true };
  }

  /** Cmd+D / Cmd+R: fill the selection from its first row / column (a
   *  one-row / one-column selection takes the cell above / to the left).
   *  A plain repeat — never a series. */
  function fillAlong(dir: "down" | "right"): SessionResult {
    const sel = state.gridSelection;
    if (!sel) return { ok: false, message: "select the cells to fill" };
    const down = dir === "down";
    const span = down ? sel.rows : sel.cols;
    let source: GridSelection;
    let target: GridSelection;
    if (span > 1) {
      source = down ? { ...sel, rows: 1 } : { ...sel, cols: 1 };
      target = sel;
    } else {
      if ((down ? sel.anchorRow : sel.anchorCol) === 0) {
        return {
          ok: false,
          message: `nothing ${down ? "above" : "to the left"} to fill from`,
        };
      }
      source = down
        ? { ...sel, anchorRow: sel.anchorRow - 1, rows: 1 }
        : { ...sel, anchorCol: sel.anchorCol - 1, cols: 1 };
      target = down ? { ...source, rows: 2 } : { ...source, cols: 2 };
    }
    return fillTo(source, target, false, sel);
  }

  /** Delete / Backspace on a selection: clear every populated cell in it
   *  as ONE undo step. */
  function clearSelection(): SessionResult {
    const engine = state.engine;
    const sheet = state.activeSheet;
    const sel = state.gridSelection;
    if (!engine || sheet === null)
      return { ok: false, message: "no workbook / sheet" };
    if (!sel) return { ok: false, message: "select the cells to clear" };
    // Every cell of the selection (every area of it) written "" in ONE
    // batch; the reply's priors say which held something (only those
    // journal).
    const targets: CellEditRecord[] = [];
    for (const area of [...extraAreas, sel])
      for (let r = 0; r < area.rows; r++) {
        for (let c = 0; c < area.cols; c++) {
          targets.push({
            sheet,
            row: area.anchorRow + r,
            col: area.anchorCol + c,
            prevInput: "",
            nextInput: "",
          });
        }
      }
    const { written, journaled } = writeTargets(
      engine,
      targets,
      "clearSelection",
    );
    const cleared = written.filter((t) => t.prevInput !== "");
    if (journaled) journalBatch(cleared);
    else markEdited();
    emitter.emit({ kind: "cells", regions: regionsOf(written) });
    void submitInFrameGrid();
    return { ok: true };
  }

  /** The next match of `needle` after the active cell (row-major, wrapping)
   *  on the active sheet — selected and scrolled into view. Null when
   *  nothing matches. Matching is the engine's (`findAll`). */
  function findNext(
    needle: string,
    opts: FindOptions,
    backwards: boolean,
  ): FindMatch | null {
    if (!needle || !state.engine || state.activeSheet === null) return null;
    lastFind = { needle, opts };
    let hits: FindMatch[];
    try {
      hits = state.engine.findAll(state.activeSheet, needle, opts);
    } catch (err) {
      host.log.warn("findNext failed", err);
      return null;
    }
    if (hits.length === 0) return null;
    const key = (h: { row: number; col: number }) => h.row * 16384 + h.col;
    const sorted = [...hits].sort((a, b) => key(a) - key(b));
    const at = activeOf();
    const here = at ? key(at) : backwards ? Number.MAX_SAFE_INTEGER : -1;
    const hit = backwards
      ? ([...sorted].reverse().find((h) => key(h) < here) ??
        sorted[sorted.length - 1])
      : (sorted.find((h) => key(h) > here) ?? sorted[0]);
    applyModel(collapsed({ row: hit.row, col: hit.col }));
    return hit;
  }

  /** Run one grid key action (see grid-nav `gridKeyAction`). Whether the
   *  key was the grid's. */
  function runGridAction(a: GridKeyAction): boolean {
    const m = currentModel();
    switch (a.kind) {
      case "move":
        if (!m) return false;
        applyModel(moveBy(m, a.dRow, a.dCol, a.extend));
        return true;
      case "advance":
        if (!m) return false;
        applyModel(advance(m, a.dir));
        return true;
      case "page": {
        if (!m) return false;
        const rows =
          lastGridScene && lastGridWindow
            ? fullyVisible(
                lastGridScene,
                lastGridWindow.wPt,
                lastGridWindow.hPt,
              ).rows
            : 20;
        if (lastGridWindow) {
          lastGridWindow = {
            ...lastGridWindow,
            firstRow: Math.max(0, lastGridWindow.firstRow + a.dir * rows),
          };
        }
        applyModel(moveBy(m, a.dir * rows, 0, a.extend));
        return true;
      }
      case "home":
        if (!m) return false;
        applyModel(
          collapsed(
            a.origin ? { row: 0, col: 0 } : { row: m.active.row, col: 0 },
          ),
        );
        return true;
      case "edit":
        return openEdit();
      case "type":
        return typeChar(a.ch);
      case "backspace":
        return backspaceEdit();
      case "commit":
        commitEdit();
        // A held-back entry stays where it is until its alert is answered.
        if (m && a.then && !data.api.entryAlert())
          applyModel(advance(m, a.then));
        return true;
      case "commitMove":
        commitEdit();
        if (m && !data.api.entryAlert())
          applyModel(moveBy(m, a.dRow, a.dCol, false));
        return true;
      case "toggleFilter": {
        const r = data.api.toggleAutofilter();
        if (!r.ok) host.log.warn(`filter: ${r.message}`);
        return true;
      }
      case "dropdown":
        return data.api.openCellDropdown();
      case "group": {
        const r = data.api.groupSelection(a.on);
        if (!r.ok) host.log.warn(`group: ${r.message}`);
        return true;
      }

      case "cancel":
        cancelEdit();
        return true;
      case "clear": {
        const r = clearSelection();
        if (!r.ok) host.log.warn(`clear: ${r.message}`);
        return true;
      }
      case "copy":
        void api.copySelection().then((r) => {
          if (!r.ok) host.log.warn(`copy: ${r.message}`);
        });
        return true;
      case "paste":
        void api.pasteAtSelection().then((r) => {
          if (!r.ok) host.log.warn(`paste: ${r.message}`);
        });
        return true;
      case "fill": {
        const r = fillAlong(a.dir);
        if (!r.ok) host.log.warn(`fill ${a.dir}: ${r.message}`);
        return true;
      }
      case "selectAll": {
        const info = api.sheets().find((x) => x.id === state.activeSheet);
        const rows = Math.max(1, info?.rows ?? 1);
        const cols = Math.max(1, info?.cols ?? 1);
        applyModel({
          anchor: { row: 0, col: 0 },
          focus: { row: rows - 1, col: cols - 1 },
          active: { row: 0, col: 0 },
        });
        return true;
      }
      case "find":
        state.findRequest += 1;
        emitter.emit();
        options.onFindRequest?.();
        return true;
      case "undo":
        return api.undoCellEdit();
      case "redo":
        return api.redoCellEdit();
      case "jump": {
        if (!m || !state.engine?.dataEdge || state.activeSheet === null)
          return false;
        const from = a.extend ? m.focus : m.active;
        let target: [number, number];
        try {
          target = state.engine.dataEdge(
            state.activeSheet,
            from.row,
            from.col,
            a.dRow,
            a.dCol,
          );
        } catch (err) {
          host.log.debug("jump: engine refused", err);
          return false;
        }
        const cell = { row: target[0], col: target[1] };
        applyModel(a.extend ? extendTo(m, cell) : collapsed(cell));
        return true;
      }
      case "lastCell": {
        const info = api.sheets().find((x) => x.id === state.activeSheet);
        if (!info) return false;
        applyModel(
          collapsed({
            row: Math.max(0, info.rows - 1),
            col: Math.max(0, info.cols - 1),
          }),
        );
        return true;
      }
      case "selectRow":
        if (!m) return false;
        applyModel({
          anchor: { row: m.active.row, col: 0 },
          focus: { row: m.active.row, col: 16_383 },
          active: m.active,
        });
        return true;
      case "selectColumn":
        if (!m) return false;
        applyModel({
          anchor: { row: 0, col: m.active.col },
          focus: { row: 1_048_575, col: m.active.col },
          active: m.active,
        });
        return true;
      case "insertNow": {
        // ISO text, which typed entry reads as a date / a time in every
        // locale; the cell stays in edit mode, as in Excel.
        const now = new Date(Date.now());
        const pad = (n: number) => String(n).padStart(2, "0");
        const text =
          a.what === "date"
            ? `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
            : `${pad(now.getHours())}:${pad(now.getMinutes())}`;
        if (cellEdit) return api.setCellEditText(cellEdit.text + text);
        return api.beginCellEdit(text, "enter");
      }
      case "commitFill": {
        if (!cellEdit) return false;
        const sel = state.gridSelection;
        const engine = state.engine;
        const sheet = state.activeSheet;
        if (
          !sel ||
          !engine ||
          sheet === null ||
          (sel.rows === 1 && sel.cols === 1)
        ) {
          commitEdit();
          return true;
        }
        const text = cellEdit.text;
        cellEdit = null;
        const targets: CellEditRecord[] = [];
        const rows = Math.min(sel.rows, 10_000);
        const cols = Math.min(sel.cols, 256);
        for (let r = 0; r < rows; r++)
          for (let c = 0; c < cols; c++)
            targets.push({
              sheet,
              row: sel.anchorRow + r,
              col: sel.anchorCol + c,
              prevInput: "",
              nextInput: text,
            });
        const { written, journaled } = writeTargets(
          engine,
          targets,
          "commitFill",
        );
        if (journaled) journalBatch(written);
        else markEdited();
        emitter.emit({ kind: "edit" });
        emitter.emit({ kind: "cells", regions: regionsOf(written) });
        void submitInFrameGrid();
        return true;
      }
      case "cut":
        cutPending = state.gridSelection ? { ...state.gridSelection } : null;
        void api.copySelection().then((r) => {
          if (!r.ok) {
            cutPending = null;
            host.log.warn(`cut: ${r.message}`);
          }
        });
        return true;
      case "toggleStyle": {
        const st = api.styleAtTarget();
        const r = api.setStyle({ [a.style]: !st?.[a.style] });
        if (!r.ok) host.log.warn(`${a.style}: ${r.message}`);
        return true;
      }
      case "formatCells":
        void host.shell?.openPanel?.("media.paged.sheet.panel.properties");
        return true;
      case "pasteSpecial":
        api.openPasteSpecial();
        return true;
      case "calculate": {
        try {
          state.engine?.calculateNow?.();
        } catch (err) {
          host.log.warn("calculate: engine refused", err);
        }
        emitter.emit();
        void submitInFrameGrid();
        return true;
      }
      case "pageAcross": {
        if (!m) return false;
        const cols =
          lastGridScene && lastGridWindow
            ? fullyVisible(
                lastGridScene,
                lastGridWindow.wPt,
                lastGridWindow.hPt,
              ).cols
            : 8;
        if (lastGridWindow) {
          lastGridWindow = {
            ...lastGridWindow,
            firstCol: Math.max(0, lastGridWindow.firstCol + a.dir * cols),
          };
        }
        applyModel(moveBy(m, 0, a.dir * cols, a.extend));
        return true;
      }
      case "none":
        return false;
    }
  }

  /** Record the grid selection (engine + session) so the next windowing
   *  paints it. Shared by the panel's `setGridSelection` door and K-1's
   *  in-frame click-to-select. Pure state + signal — never throws. */
  function applyGridSelection(
    anchorRow: number,
    anchorCol: number,
    rows: number,
    cols: number,
    model?: SelectionModel,
  ): void {
    state.gridSelection = { anchorRow, anchorCol, rows, cols };
    selModel = model ?? modelOfRect(state.gridSelection);
    if (state.engine && state.activeSheet !== null) {
      try {
        state.engine.setGridSelection(
          state.activeSheet,
          anchorRow,
          anchorCol,
          rows,
          cols,
        );
      } catch (err) {
        // The wasm side lands in JOINS — tolerate its absence; the
        // session-held selection still drives the overlay.
        host.log.debug("setGridSelection: engine not ready", err);
      }
    }
    emitter.emit({ kind: "selection" });
  }

  /** The in-frame grid as it is NOW, submitted once per animation frame
   *  (Wave 2). Every edit, keystroke and selection change asks for it;
   *  the asks inside one frame (one microtask turn where there is no
   *  `requestAnimationFrame`, e.g. a worker or the headless host) collapse
   *  into ONE window + submit of the final state — typing a burst of
   *  characters no longer submits the whole grid per character. The
   *  returned promise settles with that submit's outcome. Never throws. */
  let gridSubmitPending: Promise<boolean> | null = null;
  function submitInFrameGrid(): Promise<boolean> {
    if (gridSubmitPending) return gridSubmitPending;
    const pending = new Promise<boolean>((resolve) => {
      nextFrame(() => {
        // Asks arriving while this submit is in flight schedule the next.
        gridSubmitPending = null;
        void flushInFrameGrid().then(resolve);
      });
    });
    gridSubmitPending = pending;
    return pending;
  }

  /** Re-window + submit the in-frame grid for `lastGridWindow` (carrying
   *  the current selection and the open cell edit). Caches `lastGridScene`
   *  for the next hit-test. Returns false when there is no target frame /
   *  scene channel / window / engine. Never throws.
   *
   *  The scene contract (`SceneLayerSurface.submit`) replaces the frame's
   *  whole layer — there is no per-item patch — so a keystroke still
   *  re-sends the window; what it no longer does is re-window it: the
   *  engine scene is memoised until the next change signal, and the edit
   *  buffer is overlaid on a copy. */
  async function flushInFrameGrid(): Promise<boolean> {
    if (!lastFrameId || !lastGridWindow) return false;
    const surface = surfaceSink ? null : sceneChannel();
    if (!surface && !surfaceSink) return false;
    const base = computeGridScene(
      lastGridWindow.firstRow,
      lastGridWindow.firstCol,
      lastGridWindow.wPt,
      lastGridWindow.hPt,
    );
    if (!base) return false;
    // K-1 — overlay the in-progress cell-edit text on its cell (the engine
    // scene still shows the COMMITTED value; the buffer is uncommitted).
    const edited = cellEdit
      ? withCellText(base, cellEdit.row, cellEdit.col, cellEdit.text)
      : base;
    // Wave 5 — a fill-handle drag shows its target (a copy: the engine
    // window is memoised).
    const scene = fillPreview ? { ...edited, fillPreview } : edited;
    lastGridScene = scene;
    if (surfaceSink) {
      surfaceSink(scene);
      return true;
    }
    if (!surface) return false;
    try {
      await surface.submit(lastFrameId, gridSceneToSceneLayer(scene));
    } catch (err) {
      host.log.error("showGridInFrame: submit failed", err);
      return false;
    }
    return true;
  }

  /** `scene` with `(row, col)` rendering `text` — the uncommitted cell-edit
   *  buffer. A copy: `scene` is the memoised engine window. Replaces the
   *  cell if present in the window, else appends a left-aligned one so an
   *  edit on an empty cell still shows. */
  function withCellText(
    scene: GridScene,
    row: number,
    col: number,
    text: string,
  ): GridScene {
    let found = false;
    const cells = scene.cells.map((c) => {
      if (c.row !== row || c.col !== col) return c;
      found = true;
      return { ...c, text };
    });
    if (!found) {
      const cell: GridCell = { row, col, text, align: "left", styleKey: 0 };
      cells.push(cell);
    }
    return { ...scene, cells };
  }

  /** The display value of `(row, col)` on the active sheet, or "" — the
   *  seed when an edit OPENS on a populated cell (F2-style). Never throws. */
  function cellDisplay(row: number, col: number): string {
    if (!state.engine || state.activeSheet === null) return "";
    try {
      return state.engine.getCellDisplay(state.activeSheet, row, col) ?? "";
    } catch {
      return "";
    }
  }

  function defaultRangeForActive(): void {
    if (!state.engine || state.activeSheet === null) return;
    const sheet = state.engine
      .listSheets()
      .find((s) => s.id === state.activeSheet);
    if (sheet) state.selectedRange = usedRangeA1(sheet.rows, sheet.cols);
  }

  /** S-15 — seed sheet 0 of a fresh engine from a provider RecordSet: row 0
   *  = the schema field names (the header); rows 1.. = the column-major
   *  records (`columns[c][r-1]` → the cell at row r, col c). Every value
   *  goes in as a STRING via `cellToString` + `engine.setCell` — the engine
   *  re-types it in Rust (§3: no spreadsheet semantics in TS). Pure transport
   *  over the engine; tolerant of a per-cell write throwing (logs + skips).
   */
  function seedSheetFromRecords(
    engine: SheetEngine,
    records: ProviderRecordSet,
    clear?: { rows: number; cols: number },
  ): { rows: number; cols: number } {
    const fields = records.schema.fields;
    const extent = {
      rows: records.rowCount + 1,
      cols: Math.max(fields.length, records.columns.length),
    };
    // Header row (row 0) — the schema field names; body rows 1.. — column-
    // major: columns[c][r] is the cell value for data-row r, which lands
    // on sheet row r + 1.
    const inputs: { sheet: number; row: number; col: number; input: string }[] =
      [];
    for (let c = 0; c < fields.length; c++) {
      inputs.push({ sheet: 0, row: 0, col: c, input: fields[c].name });
    }
    for (let c = 0; c < records.columns.length; c++) {
      const col = records.columns[c];
      for (let r = 0; r < records.rowCount; r++) {
        inputs.push({
          sheet: 0,
          row: r + 1,
          col: c,
          input: cellToString(col[r]),
        });
      }
    }
    // A re-pull clears what the previous snapshot wrote beyond this one.
    if (clear) {
      for (let r = 0; r < clear.rows; r++) {
        for (let c = 0; c < clear.cols; c++) {
          if (r < extent.rows && c < extent.cols) continue;
          inputs.push({ sheet: 0, row: r, col: c, input: "" });
        }
      }
    }
    // ONE write + ONE recalc through the batch door when the engine has it;
    // per cell otherwise, or when the batch refuses an input (a bad cell is
    // then skipped alone).
    if (engine.setCells) {
      try {
        engine.setCells(inputs);
        return extent;
      } catch (err) {
        host.log.debug("sourceFromDataset: batch seed refused — per cell", err);
      }
    }
    for (const i of inputs) writeCell(engine, i.row, i.col, i.input);
    return extent;
  }

  /** The extent the linked dataset last wrote (a re-pull clears beyond). */
  let seededExtent: { rows: number; cols: number } | null = null;

  /** Live dataset (object-model wave): pull the provider's newest snapshot
   *  into the SAME workbook — sheet 0 rewritten in one batch write, cells
   *  the previous snapshot wrote beyond the new one cleared — and refresh
   *  what is placed. The workbook's formulas elsewhere keep working. */
  async function repullDataset(providerId: string): Promise<void> {
    const engine = state.engine;
    if (!engine || !host.dataProviders) return;
    let snapshot;
    try {
      snapshot = await host.dataProviders.get(providerId);
    } catch (err) {
      host.log.warn(`dataset "${providerId}": re-pull failed`, err);
      return;
    }
    if (
      !snapshot ||
      state.engine !== engine ||
      state.dataSource?.providerId !== providerId
    )
      return;
    const prev = seededExtent;
    seededExtent = seedSheetFromRecords(
      engine,
      snapshot.records,
      prev ?? undefined,
    );
    state.dataSource = {
      providerId,
      revision: snapshot.revision,
      stale: false,
      live: true,
    };
    const rows = Math.max(seededExtent.rows, prev?.rows ?? 0);
    const cols = Math.max(seededExtent.cols, prev?.cols ?? 0);
    markEdited();
    emitter.emit({
      kind: "cells",
      regions: [
        {
          sheet: 0,
          firstRow: 0,
          firstCol: 0,
          lastRow: Math.max(rows - 1, 0),
          lastCol: Math.max(cols - 1, 0),
        },
      ],
    });
  }

  /** Write one cell through the engine, tolerating a throw (an out-of-range
   *  or malformed input never aborts the whole seed — it logs + skips). */
  function writeCell(
    engine: SheetEngine,
    row: number,
    col: number,
    value: string,
  ): void {
    try {
      engine.setCell(0, row, col, value);
    } catch (err) {
      host.log.warn(`sourceFromDataset: setCell(0,${row},${col}) failed`, err);
    }
  }

  /** Window the active sheet into a GridScene + overlay the session
   *  selection. Shared by the `gridScene` door and `showGridInFrame`. */
  function computeGridScene(
    firstRow: number,
    firstCol: number,
    wPt: number,
    hPt: number,
  ): GridScene | null {
    const engine = state.engine;
    const sheet = state.activeSheet;
    if (!engine || sheet === null) return null;
    // Memoised until the next change signal (a selection change is one),
    // so callers must treat the scene as read-only.
    return cachedRead(
      `scene:${sheet}:${firstRow}:${firstCol}:${wPt}:${hPt}`,
      () => {
        let scene: GridScene;
        try {
          scene = engine.getGridScene(sheet, firstRow, firstCol, wPt, hPt, {
            includeGridlines: true,
          });
        } catch (err) {
          host.log.warn("gridScene: engine windowing failed", err);
          return null;
        }
        if (state.gridSelection) scene.selection = state.gridSelection;
        return scene;
      },
    );
  }

  /** S-08: persist the imported bytes + name (best-effort — never let a
   *  persist failure break an import). Per-plugin keyed: the LAST imported
   *  workbook is the one restored on reload.
   *
   *  Two homes, by design: the `.paged` container PART (the portable one —
   *  it travels WITH the document, the read PREFERENCE on restore) and the
   *  per-browser `host.blob` (a fast local cache + backward-compat for hosts
   *  with no container writer). */
  async function writeWorkbook(
    bytes: Uint8Array,
    name: string,
    chartSlots: readonly number[] | null = null,
  ): Promise<void> {
    try {
      await writeWorkbookPart(host, bytes, name, chartSlots);
    } catch (err) {
      host.log.warn("workbook container-part persist failed", err);
    }
    if (!host.supports("storage.blob@1")) return;
    try {
      await host.blob.write(BLOB_KEY, bytes);
      host.storage.set(BLOB_NAME_KEY, name);
    } catch (err) {
      host.log.warn("workbook persist failed (kept in memory)", err);
    }
  }

  // Edit persistence. Every committed engine write (cell edit, paste,
  // sort, replace, undo/redo, dataset seed) calls `markEdited`; after
  // PERSIST_DEBOUNCE_MS the workbook is re-saved (`engine.saveXlsx`, the
  // preservation-first re-emit) and written to both homes. Writes are
  // serialised on one chain so an older snapshot can never land after a
  // newer one. Until 2026-10-04 only the import wrote, so a reload lost
  // every edit since.
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  let persistDirty = false;
  let persistChain: Promise<void> = Promise.resolve();

  // The workbook belongs to the DOCUMENT. `docEpoch` counts document opens:
  // a write queued under one document never lands in the next one's
  // container (the host's parts door writes to whichever document is
  // open). `loadEpoch` also counts every workbook replacement (import,
  // blank, CSV, dataset, restore), so a restore that was overtaken while
  // it awaited does not clobber what replaced it.
  let docEpoch = 0;
  let loadEpoch = 0;

  function enqueueWrite(
    bytes: Uint8Array,
    name: string,
    chartSlots: readonly number[] | null = null,
  ): Promise<void> {
    const epoch = docEpoch;
    persistChain = persistChain.then(() =>
      epoch === docEpoch ? writeWorkbook(bytes, name, chartSlots) : undefined,
    );
    return persistChain;
  }

  function cancelPendingPersist(): void {
    if (persistTimer !== null) clearTimeout(persistTimer);
    persistTimer = null;
    persistDirty = false;
  }

  function markEdited(): void {
    readCache.clear();
    if (!state.engine) return;
    revision += 1;
    scheduleRefresh();
    schedulePersist();
  }

  /** Re-save the cache part (and blob) after the debounce. */
  function schedulePersist(): void {
    persistDirty = true;
    if (persistTimer !== null) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      void flushPersist();
    }, PERSIST_DEBOUNCE_MS);
  }

  /** Take the bytes NOW (synchronous — safe right before the engine is
   *  freed) and queue the write. */
  function flushPersist(): Promise<void> {
    if (!persistDirty || !state.engine) {
      cancelPendingPersist();
      return persistChain;
    }
    cancelPendingPersist();
    let bytes: Uint8Array;
    try {
      bytes = state.engine.saveXlsx();
    } catch (err) {
      // Keep the edit marked: the next edit or flush tries again.
      persistDirty = true;
      host.log.warn(
        "workbook persist: engine save failed (kept in memory)",
        err,
      );
      return persistChain;
    }
    // Plan G4 — the slots of the charts this save dropped ride with it
    // (asked only of a workbook a chart was deleted from).
    let chartSlots: number[] | null = null;
    if (chartSlotsTracked) {
      try {
        chartSlots = state.engine.chartTombstones?.() ?? null;
      } catch {
        // An engine without the door keeps no slots.
      }
    }
    return enqueueWrite(bytes, state.fileName ?? "workbook.xlsx", chartSlots);
  }

  // A .paged save takes the workbook part as it stands; an edit still in the
  // debounce window would miss it. Where the host announces saves
  // (`document.onWillSave@1`) the save waits for the pending write first.
  // Without it, the debounce, the flush on frame exit and the flush on
  // dispose remain.
  const willSaveSub = host.supports("document.onWillSave@1")
    ? host.document.onWillSave(() =>
        Promise.all([
          flushPersist().catch((err) =>
            host.log.warn("workbook persist before save failed", err),
          ),
          flushPlacementRecords().catch((err) =>
            host.log.warn("placement records before save failed", err),
          ),
        ]).then(() => undefined),
      )
    : null;

  // ── what the placed tables show, kept for a later session ──────────────
  //
  // `placements/<hash>.json` (lower.ts `rememberShownContent`) lets a
  // reopened document refresh a stale table in place. The records are
  // written when the document is about to be saved (and on dispose), not on
  // every placement or refresh: only what the tables show at save time is
  // ever read back.
  /** Hashes whose record the document holds (read back or written). */
  const keptRecords = new Set<string>();
  /** Hashes whose record this session wrote (it may drop them again). */
  const ownRecords = new Set<string>();

  /** Write the records of what the placed tables show now, and drop the
   *  ones this session wrote that no table shows any more. */
  async function flushPlacementRecords(
    shown: Map<string, LoweredContent> = shownContents(),
  ): Promise<void> {
    for (const [hash, content] of shown) {
      if (keptRecords.has(hash)) continue;
      await rememberShownContent(host, content);
      keptRecords.add(hash);
      ownRecords.add(hash);
    }
    for (const hash of [...ownRecords]) {
      if (shown.has(hash)) continue;
      await forgetShownContent(host, hash);
      ownRecords.delete(hash);
      keptRecords.delete(hash);
    }
  }

  /** What each placed table shows, by content hash. */
  function shownContents(): Map<string, LoweredContent> {
    const out = new Map<string, LoweredContent>();
    for (const info of loweredTables.values()) {
      if (info.content) out.set(contentHash(info.content), info.content);
    }
    return out;
  }

  // ── own writes vs the document changing under a placed table ───────────
  //
  // A placed table can be refreshed in place only while it still has the
  // body rows and columns this session last wrote, and the refresh writes
  // them below any header band the host added (`refreshBands`). That takes
  // a read, so it is done only for a table the document may have changed
  // since: one found again in a reopened document, or any table after a
  // document change this session did not make (the host applies
  // `insertHeaderRow`, an undo). A change event arrives with the write's
  // reply, before the awaiting code resumes, so `ownWrites` attributes a
  // session write's own events to it.
  let ownWrites = 0;
  const unverified = new Set<string>();
  /** Frames whose view moved (ADR 510 render on leave): refreshed even when
   *  no cell changed since they were written. */
  const viewMoved = new Set<string>();
  async function ownWrite<T>(write: () => Promise<T>): Promise<T> {
    ownWrites += 1;
    try {
      return await write();
    } finally {
      ownWrites -= 1;
    }
  }
  const foreignChangeSub = host.document.onDidChange((e) => {
    if (e.kind === "mutationApplied" && ownWrites > 0) return;
    // P7 — a swatch or style the cells reference may have changed: the
    // grid re-reads the document's colours (debounced with the rest).
    docStyleRevision += 1;
    scheduleStyleNotice();
    scheduleDocStyleSync();
    for (const frameId of loweredTables.keys()) unverified.add(frameId);
    // ADR 510 (P6) — a window frame's box is its window: a resize shows
    // what fits now. The engine names the resized frame's content box; a
    // gesture that resized without saying which (several frames, an older
    // engine) re-reads the window frames' geometry.
    if (e.reflow) {
      rewindow(e.reflow.frameId, {
        widthPt: e.reflow.contentBox[3] - e.reflow.contentBox[1],
        heightPt: e.reflow.contentBox[2] - e.reflow.contentBox[0],
      });
    } else if (e.kind === "gestureCommitted") {
      void rereadWindowBoxes();
    }
    // A link, an unlink or a resize of a chain frame changes the window.
    scheduleChainRead();
  });

  /** Give window frame `frameId` a new box; refresh when it changed. */
  function rewindow(
    frameId: string,
    boxPt: { widthPt: number; heightPt: number },
  ): void {
    const info = loweredTables.get(frameId);
    if (!info || info.sizing !== "window") return;
    if (boxPt.widthPt <= 0 || boxPt.heightPt <= 0) return;
    const old = info.boxPt;
    if (
      old &&
      Math.abs(old.widthPt - boxPt.widthPt) < 0.5 &&
      Math.abs(old.heightPt - boxPt.heightPt) < 0.5
    ) {
      return;
    }
    // The first resize of a placed frame starts from its fitted box, which
    // the window measured from its range did not use: still a new box.
    loweredTables.set(frameId, { ...info, boxPt });
    if (lastFrameId === frameId && lastGridWindow && !surfaceArea) {
      lastGridWindow = {
        ...lastGridWindow,
        wPt: boxPt.widthPt,
        hPt: boxPt.heightPt,
      };
    }
    viewMoved.add(frameId);
    scheduleRefresh();
  }

  /** Re-read every window frame's box (a gesture that did not name one). */
  async function rereadWindowBoxes(): Promise<void> {
    const ids = [...loweredTables]
      .filter(([, i]) => i.sizing === "window")
      .map(([id]) => id);
    if (ids.length === 0) return;
    let geom: Awaited<ReturnType<typeof host.document.elementGeometry>>;
    try {
      geom = await host.document.elementGeometry(
        ids.map((id) => ({ kind: "textFrame", id }) as ElementId),
      );
    } catch {
      return;
    }
    geom.forEach((g, i) => {
      const b = g?.bounds;
      const id = ids[i];
      // Only a frame whose box differs from the one it was RESIZED to: a
      // fitted placement's frame is taller than its range's window.
      if (!b || !id || !resizedBoxes.has(id)) {
        if (b && id) resizedBoxes.set(id, `${b[2] - b[0]}x${b[3] - b[1]}`);
        return;
      }
      const key = `${b[2] - b[0]}x${b[3] - b[1]}`;
      if (resizedBoxes.get(id) === key) return;
      resizedBoxes.set(id, key);
      rewindow(id, { widthPt: b[3] - b[1], heightPt: b[2] - b[0] });
    });
  }
  /** The last frame box seen per window frame (`rereadWindowBoxes`). */
  const resizedBoxes = new Map<string, string>();

  // ── Sheet ADR 524 — document styles for Excel named styles ────────────

  /** Tell the engine which document style ids exist, so a mapping naming
   *  one the document lost falls back to the workbook's look. `known`
   *  skips the read (`null` = unreadable: nothing changes); without it the
   *  document is read only while the mapping is on. */
  async function syncDocStyleAvailability(
    known?: DocumentStyleLists | null,
  ): Promise<void> {
    const engine = state.engine;
    if (!engine?.setDocumentStylesAvailable || !engine.docStyleMap) return;
    if (known === undefined) {
      try {
        if (!engine.docStyleMap().enabled) return;
      } catch {
        return;
      }
    }
    const lists =
      known === undefined ? await readDocumentStyleLists(host) : known;
    if (!lists || state.engine !== engine) return;
    let changed = false;
    try {
      changed = engine.setDocumentStylesAvailable(availableStyleIds(lists));
    } catch (err) {
      host.log.debug("document styles: availability not set", err);
      return;
    }
    if (changed) {
      readCache.clear();
      revision += 1;
      scheduleRefresh();
      emitter.emit();
    }
  }
  let docStyleSyncTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleDocStyleSync(): void {
    if (docStyleSyncTimer !== null) clearTimeout(docStyleSyncTimer);
    docStyleSyncTimer = setTimeout(() => {
      docStyleSyncTimer = null;
      void syncDocStyleAvailability();
    }, REFRESH_DEBOUNCE_MS);
  }

  /** Run a change of the document-style mapping as ONE undo step (the map
   *  before and after, put back whole). */
  function journalDocMap(apply: (e: SheetEngine) => void): SessionResult {
    return journalFormat(
      (e) => {
        if (!e.docStyleMap || !e.setDocStyleMap)
          throw new Error("engine wasm predates the document-style doors");
        const before = e.docStyleMap();
        return () => {
          const after = e.docStyleMap!();
          return {
            undo: (x) => x.setDocStyleMap!(before),
            redo: (x) => x.setDocStyleMap!(after),
          };
        };
      },
      (e) => {
        apply(e);
      },
    );
  }

  /** "Use document styles" on, its default mapping pre-filled. */
  async function enableDocStyles(): Promise<SessionResult> {
    const engine = state.engine;
    if (!engine) return { ok: false, message: "no workbook open" };
    const lists = await readDocumentStyleLists(host);
    if (state.engine !== engine)
      return { ok: false, message: "the workbook changed" };
    const r = journalDocMap((e) => {
      const map = e.docStyleMap!();
      const add =
        lists && e.namedStyleUsage
          ? defaultDocStyleEntries(e.namedStyleUsage(), lists, map)
          : {};
      e.setDocStyleMap!({
        enabled: true,
        entries: { ...map.entries, ...add },
      } satisfies DocStyleMap);
    });
    if (r.ok) await syncDocStyleAvailability(lists);
    return r;
  }

  /** A workbook made in paged takes the document's styles from the start
   *  (not an undo step of its own). */
  async function adoptWithDocStyles(): Promise<void> {
    if (!state.engine?.setDocStyleMap) return;
    const r = await enableDocStyles();
    if (r.ok) {
      editJournal = [];
      journalCursor = 0;
    }
  }

  /** P7 — the document style revision the grid follows. */
  let docStyleRevision = 0;
  let styleNoticeTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleStyleNotice(): void {
    if (!inFrameActive) return;
    if (styleNoticeTimer !== null) clearTimeout(styleNoticeTimer);
    styleNoticeTimer = setTimeout(() => {
      styleNoticeTimer = null;
      emitter.emit();
    }, REFRESH_DEBOUNCE_MS);
  }

  /** P6 — continuation frame → the chain's head (a window frame). */
  const chainHeadOf = new Map<string, string>();
  /** The continuation the in-frame grid was entered on: the chain head and
   *  the frame's place in the chain. */
  let enteredContinuation: { head: string; index: number } | null = null;
  let chainTimer: ReturnType<typeof setTimeout> | null = null;

  /** Re-read the thread of every window frame (debounced): a frame linked
   *  to more frames becomes a chain window, one unlinked goes back. */
  function scheduleChainRead(): void {
    if (![...loweredTables.values()].some((i) => i.sizing === "window")) return;
    if (chainTimer !== null) clearTimeout(chainTimer);
    chainTimer = setTimeout(() => {
      chainTimer = null;
      void rereadChains();
    }, REFRESH_DEBOUNCE_MS);
  }

  async function rereadChains(): Promise<void> {
    for (const [frameId, info] of [...loweredTables]) {
      if (info.sizing !== "window") continue;
      let links: Awaited<ReturnType<typeof host.document.frameChain>>;
      try {
        links = await host.document.frameChain(info.storyId);
      } catch {
        continue;
      }
      const order = links.map((l) => l.frameId);
      // Only the head frame owns the window.
      if (order.length > 0 && order[0] !== frameId) continue;
      const rest = order.slice(1);
      const before = info.chain?.frames ?? [];
      for (const f of before) if (!rest.includes(f)) chainHeadOf.delete(f);
      if (rest.length === 0) {
        if (info.chain) {
          const { chain: _gone, chainStarts: _starts, ...single } = info;
          loweredTables.set(frameId, single);
          viewMoved.add(frameId);
          scheduleRefresh();
        }
        continue;
      }
      let geom: Awaited<ReturnType<typeof host.document.elementGeometry>>;
      try {
        geom = await host.document.elementGeometry(
          order.map((id) => ({ kind: "textFrame", id }) as ElementId),
        );
      } catch {
        continue;
      }
      const boxes = geom.map((g) => ({
        widthPt: g ? g.bounds[3] - g.bounds[1] : 0,
        heightPt: g ? g.bounds[2] - g.bounds[0] : 0,
      }));
      const [headBox, ...moreBoxes] = boxes;
      if (!headBox) continue;
      for (const f of rest) chainHeadOf.set(f, frameId);
      const same =
        JSON.stringify(info.chain ?? null) ===
          JSON.stringify({ frames: rest, boxes: moreBoxes }) &&
        JSON.stringify(info.boxPt ?? null) === JSON.stringify(headBox);
      if (same) continue;
      loweredTables.set(frameId, {
        ...info,
        boxPt: headBox,
        chain: { frames: rest, boxes: moreBoxes },
      });
      viewMoved.add(frameId);
      scheduleRefresh();
    }
  }

  /** Wave 4 — after a burst of edits, refresh what this session placed. */
  function scheduleRefresh(): void {
    if (
      loweredTables.size === 0 &&
      placedCharts.length === 0 &&
      chains.size === 0
    ) {
      return;
    }
    if (suppressRefresh) return;
    if (inFrameActive) {
      refreshDeferred = true;
      return;
    }
    if (refreshTimer !== null) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void refreshPlacements();
    }, REFRESH_DEBOUNCE_MS);
  }

  /** The name of sheet `id` (bindings carry names), or null if it is gone. */
  function sheetNameOf(id: number): string | null {
    return state.engine?.listSheets().find((s) => s.id === id)?.name ?? null;
  }

  /** Refresh every placed table (in place), chart (replaced) and chain
   *  (re-paginated over its own tables). Serialised: a refresh requested
   *  while one runs queues behind it. Never rejects. */
  function refreshPlacements(): Promise<void> {
    refreshChain = refreshChain
      .then(async () => {
        const engine = state.engine;
        if (!engine) return;
        const version = revision;
        for (let [frameId, info] of [...loweredTables]) {
          const name = sheetNameOf(info.sheet);
          if (name === null) continue;
          let next: LoweredContent;
          let windowed: string | null = null;
          let starts: number[] | undefined;
          try {
            const win = placementWindow(engine, info);
            windowed = win?.range ?? null;
            starts = win?.chainStarts;
            next = win?.content ?? pageContent(engine, info.sheet, info.range);
          } catch (err) {
            host.log.warn(`refresh: could not lower ${info.range}`, err);
            continue;
          }
          const moved = viewMoved.delete(frameId);
          // A window frame's binding names the cells it shows now.
          if (windowed && windowed !== info.range) {
            info = { ...info, range: windowed };
            loweredTables.set(frameId, info);
          }
          if (starts) {
            info = { ...info, chainStarts: starts };
            loweredTables.set(frameId, info);
          }
          if (info.content) {
            if (!moved && info.contentVersion === version) continue;
            if (JSON.stringify(next) === JSON.stringify(info.content)) {
              // Same cells, new view (a lock): the binding alone records it.
              if (moved) {
                const placedInfo = info;
                await ownWrite(() => stampPlacedView(host, placedInfo, name));
              }
              continue;
            }
            // In place: only what changed is re-poured, and the table — its
            // id, its column widths, anything the host formatted, a header or
            // footer band the host added — stays. A table the document may
            // have changed since this session last wrote it is checked first
            // (one read), which also says where its rows sit now.
            const bands = unverified.has(frameId)
              ? await refreshBands(host, info, info.content)
              : { header: info.headerRows ?? 0, footer: 0 };
            // A scroll re-pours in place too, in ONE batch: a new table would
            // take two document steps (the table, then its cells), and one
            // Undo of the leave must put the page back whole.
            if (bands) {
              const banded = { ...info, headerRows: bands.header || undefined };
              const updated = await ownWrite(() =>
                refreshLoweredTable(host, banded, next, version, name),
              );
              loweredTables.set(frameId, updated);
              unverified.delete(frameId);
              if (lastLoweredTable?.frameId === frameId)
                lastLoweredTable = updated;
              continue;
            }
          }
          // Replaced whole, the one refresh that cannot write into rows that
          // are not the workbook's: the page's content is unknown (a table
          // placed before placement records were kept, or on a host without
          // container parts), or the host reshaped the table
          // (`refreshBands`).
          const replaced = await ownWrite(() =>
            replaceLoweredTable(host, engine, info, next, version, name),
          );
          loweredTables.delete(frameId);
          unverified.delete(frameId);
          if (replaced) loweredTables.set(replaced.frameId, replaced);
          if (lastLoweredTable?.frameId === frameId)
            lastLoweredTable = replaced;
          if (lastFrameId === frameId) lastFrameId = replaced?.frameId ?? null;
        }
        const charts: PlacedChart[] = [];
        for (const placed of placedCharts) {
          if (
            placed.contentVersion === version ||
            placed.elementIds.length === 0
          ) {
            charts.push(placed);
            continue;
          }
          let key: string;
          try {
            key = JSON.stringify(
              engine.getChartGeometry(
                placed.chartIndex,
                ...chartSizeOf(placed.bounds),
              ),
            );
          } catch {
            charts.push(placed);
            continue;
          }
          if (key === placed.geometryKey) {
            // The edit did not touch this chart's data: nothing to redraw.
            charts.push({ ...placed, contentVersion: version });
            continue;
          }
          let replaced: PlacedChart | null = null;
          await lowerChartToFrame(host, engine, placed.chartIndex, {
            placement: { pageId: placed.pageId, bounds: placed.bounds },
            contentVersion: version,
            replaces: placed,
            onLowered: (p) => {
              replaced = p;
            },
          });
          charts.push(replaced ?? { ...placed, elementIds: [] });
        }
        placedCharts = charts;
        for (const chain of chains.values()) {
          await chain.sub.refresh();
        }
      })
      .catch((err) => {
        host.log.warn("refresh of placed content failed", err);
      });
    return refreshChain;
  }

  /** Wave 9 — find the tables an EARLIER session placed, so they refresh
   *  like this session's own. Walks the scene tree for text frames carrying
   *  this plugin's binding with a table record (bindings written before the
   *  record existed are not found — there is no door that lists a story's
   *  tables). Where the host's geometry read names a frame's story (66), a
   *  record whose story disagrees (a duplicated frame) is skipped. A table
   *  whose recorded hash matches the workbook's lowering now gets that
   *  lowering as its baseline; one that does not has an unknown baseline and
   *  is replaced on the next refresh, which this schedules. The session's
   *  content version continues from the highest one found, so the document-
   *  undo follower never reads an older stamp as newer. Returns the count. */
  async function rediscoverPlacements(): Promise<number> {
    const engine = state.engine;
    if (!engine) return 0;
    let roots: Awaited<ReturnType<BundleHost["document"]["tree"]>>;
    try {
      roots = await host.document.tree();
    } catch (err) {
      host.log.debug("rediscover: scene tree read failed", err);
      return 0;
    }
    const frames: string[] = [];
    const walk = (nodes: typeof roots) => {
      for (const n of nodes) {
        if (n.id?.kind === "textFrame" && typeof n.id.id === "string")
          frames.push(n.id.id);
        if (n.children) walk(n.children);
      }
    };
    walk(roots);
    const sheets = engine.listSheets();
    let found = 0;
    let stale = false;
    for (const frameId of frames) {
      if (loweredTables.has(frameId)) continue;
      let binding: ReturnType<typeof parseBinding>;
      try {
        binding = parseBinding(
          await host.document.getMetadata({
            kind: "textFrame",
            id: frameId,
          } as ElementId),
        );
      } catch {
        continue;
      }
      const rec = binding?.data.table;
      if (!binding || !rec) continue;
      const sheet = sheets.find((x) => x.name === binding.data.sheet);
      if (!sheet) continue;
      let ids: { storyId: string; tableId: string } | null;
      if (rec.storyId !== undefined && rec.tableId !== undefined) {
        ids = { storyId: rec.storyId, tableId: rec.tableId };
        const story = await storyOfFrame(host, frameId);
        if (story !== null && story !== ids.storyId) continue;
      } else {
        // Placed in one batch (66): the binding could not name the ids —
        // read them off the page (the frame's own table, so a duplicated
        // frame finds its copy).
        ids = await tableUnderFrame(host, frameId, rec.widths);
        if (!ids) continue;
      }
      const d = binding.data;
      // A window frame lowers the window that fits its box: read the box.
      let boxPt: { widthPt: number; heightPt: number } | undefined;
      if (d.sizing === "window") {
        try {
          const g = await host.document.elementGeometry([
            { kind: "textFrame", id: frameId } as ElementId,
          ]);
          const b = g[0]?.bounds;
          if (b) boxPt = { widthPt: b[3] - b[1], heightPt: b[2] - b[0] };
        } catch {
          // No box: the frame lowers its recorded range until entered.
        }
      }
      const placed = {
        sheet: sheet.id,
        range: d.range,
        view: d.view,
        print: d.print,
        sizing: d.sizing,
        ...(boxPt ? { boxPt } : {}),
      };
      let now: LoweredContent;
      try {
        now = placementContent(engine, placed);
      } catch {
        continue;
      }
      const current = contentHash(now) === rec.hash;
      if (!current) stale = true;
      // What the page shows: the workbook's lowering when it is current,
      // else the content kept when it was placed — so the refresh diffs in
      // place rather than replacing the table.
      const kept = await recallShownContent(host, rec.hash);
      if (kept) keptRecords.add(rec.hash);
      const shown = current ? now : (kept ?? undefined);
      // The document may have changed this table since it was written.
      unverified.add(frameId);
      loweredTables.set(frameId, {
        frameId,
        storyId: ids.storyId,
        tableId: ids.tableId,
        ...placed,
        content: shown,
        columnWidths: rec.widths,
        contentVersion: binding.data.contentVersion,
      });
      revision = Math.max(revision, binding.data.contentVersion);
      lastFrameId ??= frameId;
      found += 1;
    }
    if (stale) {
      revision += 1;
      scheduleRefresh();
    }
    found += await rediscoverCharts();
    return found;
  }

  /** Plan G4 — track the placed charts the page carries and this session
   *  does not: a reopened document's, and the copies an undo brought back
   *  (a deleteChart undone restores the art, which the delete had taken out
   *  of the tracking). Each copy is found on the scene tree by its binding
   *  (`chart:<n>`, `placedChartCopies`) and tracked at the box its binding
   *  recorded — a chart placed before the box was recorded at the extent of
   *  its elements — with the geometry it shows now, so the next edit that
   *  changes the chart redraws it. A copy of a chart the workbook no longer
   *  has is left alone. Tracked charts whose art is gone from the page (an
   *  undone placement) are dropped. Returns how many were added. */
  async function rediscoverCharts(): Promise<number> {
    const engine = state.engine;
    if (!engine) return 0;
    const copies = await placedChartCopies(host);
    // Art that left the page is no longer tracked (only when the tree was
    // read: an unreadable tree finds no copies and changes nothing).
    if (copies.length > 0 || placedCharts.length > 0) {
      const tree = await host.document.tree().catch(() => null);
      if (tree) {
        const ids = new Set<string>();
        const walk = (nodes: typeof tree) => {
          for (const n of nodes) {
            if (n.id) ids.add(String(n.id.id));
            if (n.children) walk(n.children);
          }
        };
        walk(tree);
        placedCharts = placedCharts.filter(
          (p) =>
            p.elementIds.length === 0 ||
            p.elementIds.some((id) => ids.has(String(id.id))),
        );
      }
    }
    const known = new Set(
      placedCharts.flatMap((p) => [
        ...(p.groupId ? [p.groupId] : []),
        ...p.elementIds.map((id) => String(id.id)),
      ]),
    );
    const live = new Set(engine.listCharts().map((c) => c.index));
    let added = 0;
    for (const copy of copies) {
      if (!live.has(copy.chartIndex)) continue;
      const ids = copy.elementIds.map((id) => String(id.id));
      if (
        (copy.groupId && known.has(copy.groupId)) ||
        ids.some((id) => known.has(id))
      )
        continue;
      const at = await chartCopyBox(copy);
      if (!at) continue;
      let geometryKey: string;
      try {
        geometryKey = JSON.stringify(
          engine.getChartGeometry(copy.chartIndex, ...chartSizeOf(at.bounds)),
        );
      } catch {
        continue;
      }
      placedCharts.push({
        chartIndex: copy.chartIndex,
        pageId: at.pageId,
        bounds: at.bounds,
        elementIds: copy.elementIds,
        groupId: copy.groupId ?? null,
        contentVersion: revision,
        geometryKey,
      });
      for (const id of ids) known.add(id);
      added += 1;
    }
    return added;
  }

  /** Where a found chart copy stands: its page (from its elements'
   *  geometry) and its recorded box, else the page-space extent of its
   *  elements. Null when no element has a page. */
  async function chartCopyBox(copy: PlacedChartCopy): Promise<{
    pageId: PageId;
    bounds: [number, number, number, number];
  } | null> {
    let geom: Awaited<ReturnType<typeof host.document.elementGeometry>>;
    try {
      geom = await host.document.elementGeometry(copy.elementIds);
    } catch {
      return null;
    }
    const pageId = geom.find((g) => g?.pageId)?.pageId;
    if (!pageId) return null;
    if (copy.box) return { pageId, bounds: copy.box };
    let top = Infinity;
    let left = Infinity;
    let bottom = -Infinity;
    let right = -Infinity;
    for (const g of geom) {
      if (!g?.bounds) continue;
      const [t, l, b, r] = g.bounds;
      const [a, bb, c, d, tx, ty] = g.itemTransform ?? [1, 0, 0, 1, 0, 0];
      for (const [x, y] of [
        [l, t],
        [r, t],
        [r, b],
        [l, b],
      ] as const) {
        const px = a * x + c * y + tx;
        const py = bb * x + d * y + ty;
        top = Math.min(top, py);
        bottom = Math.max(bottom, py);
        left = Math.min(left, px);
        right = Math.max(right, px);
      }
    }
    return Number.isFinite(top)
      ? { pageId, bounds: [top, left, bottom, right] }
      : null;
  }

  /** The placements belong to the workbook they were lowered from: a new
   *  workbook (import, blank, CSV, dataset) forgets them. */
  function forgetPlacements(): void {
    if (refreshTimer !== null) clearTimeout(refreshTimer);
    refreshTimer = null;
    lastLoweredTable = null;
    loweredTables.clear();
    placedCharts = [];
    for (const c of chains.values()) c.sub.dispose();
    chains.clear();
  }

  /** Make `engine` the session's workbook (a blank or CSV one): the old
   *  one is freed, placements and journal forgotten, persisted as an edit. */
  /** The workbook's file name without its spreadsheet extension. */
  function baseName(): string {
    return (state.fileName ?? "workbook").replace(
      /\.(xlsx|xlsm|xltx|xltm)$/i,
      "",
    );
  }

  function adoptWorkbook(engine: SheetEngine, name: string): void {
    if (state.engine && state.engine !== engine) {
      try {
        state.engine.dispose();
      } catch (err) {
        host.log.warn("prior engine dispose failed", err);
      }
    }
    cancelPendingPersist();
    forgetPlacements();
    loadEpoch += 1;
    state.engine = engine;
    dialectEngine(); // learn the formula display while loading
    state.fileName = name;
    state.gridSelection = null;
    state.dataSource = null;
    editJournal = [];
    journalCursor = 0;
    const sheets = engine.listSheets();
    state.activeSheet = sheets.length > 0 ? sheets[0].id : null;
    defaultRangeForActive();
    markEdited();
    emitter.emit();
  }

  /** Run a workbook-structure verb; a throw becomes `{ok:false}`. */
  /** Wave 6 — the cells the format verbs act on (see `formatTarget`). */
  function formatTarget(): FormatTarget | null {
    const e = state.engine;
    const sheet = state.activeSheet;
    if (!e || sheet === null) return null;
    const sel = state.gridSelection;
    const text = sel
      ? selectionRangeA1(sel.anchorRow, sel.anchorCol, sel.rows, sel.cols)
      : state.selectedRange;
    if (!text) return null;
    if (!e.resolveRange) return null;
    // Memoised until the next change: the panel reads it on every render.
    return cachedRead(`target:${sheet}:${text}`, () => {
      try {
        return e.resolveRange!(sheet, text) as FormatTarget;
      } catch {
        return null;
      }
    });
  }

  function structureVerb(fn: (engine: SheetEngine) => void): SessionResult {
    if (!state.engine) return { ok: false, message: "no workbook open" };
    try {
      fn(state.engine);
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
    markEdited();
    emitter.emit();
    return { ok: true };
  }

  /** Boot (if needed) + load bytes into the engine + default sheet/range.
   *  Shared by import (persist) and restore (no re-persist). Returns true
   *  on a successful load. */
  async function loadWorkbook(
    bytes: Uint8Array,
    name: string,
    persist: boolean,
    epoch?: number,
    /** Plan G4 — deleted chart slots stored with the bytes. */
    chartSlots: readonly number[] = [],
  ): Promise<boolean> {
    try {
      if (!state.engine) {
        const booted = await bootEngine();
        // A restore overtaken while the engine booted (another document
        // opened, or a workbook was imported) loads nothing.
        if (epoch !== undefined && epoch !== loadEpoch) {
          booted.dispose();
          return false;
        }
        if (state.engine) booted.dispose();
        else state.engine = booted;
      }
      if (epoch !== undefined && epoch !== loadEpoch) return false;
      state.bootError = null;
    } catch (err) {
      // Boot failure (the artifact isn't built — S-10). Surface it; the
      // panel renders the honest "not built" state.
      state.engine = null;
      state.bootError = err instanceof Error ? err.message : ENGINE_NOT_BUILT;
      host.log.warn("sheet engine boot failed", err);
      emitter.emit();
      return false;
    }
    // The engine replaces its workbook only on a successful load, so a
    // failed one leaves the open workbook (if any) as it was; the session
    // keeps pointing at it rather than at nothing (SHT-1).
    const before = {
      fileName: state.fileName,
      activeSheet: state.activeSheet,
      selectedRange: state.selectedRange,
    };
    try {
      state.engine.loadXlsx(bytes);
      // Plan G4 — the charts a save dropped keep their slots, so every
      // other chart is at the index the page's bindings name.
      chartSlotsTracked = false;
      if (chartSlots.length > 0) restoreChartSlots(chartSlots);
      // CELL("filename") reads the workbook's name (sheet ADR 516).
      state.engine.setDocumentName?.(name);
      loadEpoch += 1;
      dialectEngine(); // learn the formula display while loading
      state.fileName = name;
      state.gridSelection = null;
      forgetPlacements(); // the prior placements belonged to the old workbook
      editJournal = [];
      journalCursor = 0;
      const sheets = state.engine.listSheets();
      state.activeSheet = sheets.length > 0 ? sheets[0].id : null;
      defaultRangeForActive();
    } catch (err) {
      host.log.error("workbook load failed", err);
      state.fileName = before.fileName;
      state.activeSheet = before.activeSheet;
      state.selectedRange = before.selectedRange;
      emitter.emit();
      return false;
    }
    // A newly loaded workbook replaces the old one: unsaved edits to the
    // old one are moot (and must not overwrite the import below).
    cancelPendingPersist();
    if (persist) await enqueueWrite(bytes, name);
    // ADR 524 — a mapping naming a style this document lacks falls back.
    await syncDocStyleAvailability();
    emitter.emit();
    return true;
  }

  /** The restore in flight (if any) — `ensureRestored` waits for it
   *  rather than racing it with a second read. */
  let restoring: Promise<boolean> = Promise.resolve(false);
  function track(p: Promise<boolean>): Promise<boolean> {
    restoring = p.catch(() => false);
    return p;
  }

  /** Whether the open document holds a frame bound to this plugin — the
   *  test for lifting the per-browser blob into it (a pre-container
   *  document). A document with no sheet frame gets no workbook from
   *  another document's cache. */
  async function documentHasSheetFrame(): Promise<boolean> {
    let roots: Awaited<ReturnType<BundleHost["document"]["tree"]>>;
    try {
      roots = await host.document.tree();
    } catch {
      return false;
    }
    const frames: string[] = [];
    const walk = (nodes: typeof roots) => {
      for (const n of nodes) {
        if (n.id?.kind === "textFrame" && typeof n.id.id === "string")
          frames.push(n.id.id);
        if (n.children) walk(n.children);
      }
    };
    walk(roots);
    for (const id of frames) {
      try {
        const meta = await host.document.getMetadata({
          kind: "textFrame",
          id,
        } as ElementId);
        if (parseBinding(meta)) return true;
      } catch {
        /* unreadable metadata is not a binding */
      }
    }
    return false;
  }

  /** Restore the open document's workbook: its `.paged` container part
   *  first (it travels WITH the document), else the per-browser blob —
   *  `"always"` (the boot restore, S-08) or `"ifBound"` (a document open:
   *  only into a document that has a sheet frame). Overtaken (another
   *  document opened, a workbook imported) ⇒ loads nothing. */
  async function restoreWorkbook(
    blobFallback: "always" | "ifBound",
  ): Promise<boolean> {
    const epoch = loadEpoch;
    let fromPart: Awaited<ReturnType<typeof readWorkbookPart>> = null;
    try {
      fromPart = await readWorkbookPart(host);
    } catch (err) {
      host.log.warn("workbook container-part restore failed", err);
    }
    if (epoch !== loadEpoch) return false;
    if (fromPart) {
      const ok = await loadWorkbook(
        fromPart.bytes,
        fromPart.name,
        false,
        epoch,
        fromPart.chartSlots,
      );
      if (ok)
        await rediscoverPlacements().catch((err) =>
          host.log.warn("rediscover failed", err),
        );
      return ok;
    }

    // Fall back to the per-browser blob (S-08 — pre-migration documents, or
    // a host with no container writer).
    if (!host.supports("storage.blob@1")) return false;
    let bytes: Uint8Array | null;
    try {
      bytes = await host.blob.read(BLOB_KEY);
    } catch (err) {
      host.log.warn("workbook restore read failed", err);
      return false;
    }
    if (!bytes) return false; // nothing persisted — no engine boot
    if (blobFallback === "ifBound" && !(await documentHasSheetFrame()))
      return false;
    if (epoch !== loadEpoch) return false;
    const name = host.storage.get<string>(BLOB_NAME_KEY) ?? "workbook.xlsx";
    const ok = await loadWorkbook(bytes, name, false, epoch);
    if (ok)
      await rediscoverPlacements().catch((err) =>
        host.log.warn("rediscover failed", err),
      );
    // One-time migration: lift the per-browser blob into the container so the
    // workbook now travels with the document on the next save.
    if (ok) {
      try {
        await writeWorkbookPart(host, bytes, name);
      } catch (err) {
        host.log.warn("workbook container-part migration failed", err);
      }
    }
    return ok;
  }

  /** Forget the workbook entirely (its document closed): engine, sheet,
   *  selection, placements, journal, dataset link, the in-frame grid. */
  function unloadWorkbook(): void {
    cancelPendingPersist();
    forgetPlacements();
    try {
      dataSourceSub?.dispose();
    } catch (err) {
      host.log.warn("dataset subscription dispose failed", err);
    }
    dataSourceSub = null;
    if (inFrameActive && lastFrameId) void sceneSurface?.clear(lastFrameId);
    inFrameActive = false;
    cellEdit = null;
    drag = null;
    fillPreview = null;
    refreshDeferred = false;
    lastFrameId = null;
    lastGridWindow = null;
    lastGridScene = null;
    wheelCarry = [0, 0];
    editJournal = [];
    journalCursor = 0;
    readCache.clear();
    revision += 1;
    if (state.engine) {
      try {
        state.engine.dispose();
      } catch (err) {
        host.log.warn("engine dispose failed", err);
      }
    }
    state.engine = null;
    state.fileName = null;
    state.activeSheet = null;
    state.selectedRange = null;
    state.gridSelection = null;
    state.dataSource = null;
    emitter.emit();
  }

  // ADR 323 — the object model's door (src/object-model.ts).
  const bridge: ObjectBridge = {
    engine: () => state.engine,
    epoch: () => loadEpoch,
    restoreChartSlots(slots) {
      restoreChartSlots(slots);
    },
    takeChartPlacements(index) {
      // A chart is being deleted: its slot rides every later save.
      chartSlotsTracked = true;
      const taken = placedCharts.filter((p) => p.chartIndex === index);
      placedCharts = placedCharts.filter((p) => p.chartIndex !== index);
      return taken;
    },
    rediscoverCharts: () =>
      rediscoverCharts().catch((err) => {
        host.log.warn("chart rediscovery failed", err);
        return 0;
      }),
    afterWrite(regions) {
      markEdited();
      emitter.emit(
        regions && regions.length > 0
          ? { kind: "cells", regions }
          : OTHER_CHANGE,
      );
    },
    loadVersion(bytes, name) {
      const engine = state.engine;
      if (!engine) return false;
      try {
        engine.loadXlsx(bytes);
      } catch (err) {
        host.log.error(
          "object model: stored workbook version failed to load",
          err,
        );
        return false;
      }
      state.fileName = name;
      readCache.clear();
      dialectSeen = null; // the load reset the engine's formula language
      dialectEngine();
      revision += 1;
      editJournal = [];
      journalCursor = 0;
      const sheets = engine.listSheets();
      if (!sheets.some((x) => x.id === state.activeSheet)) {
        state.activeSheet = sheets.length > 0 ? sheets[0].id : null;
        state.gridSelection = null;
        defaultRangeForActive();
      }
      schedulePersist(); // the cache part follows; the page already did
      emitter.emit();
      return true;
    },
    setName(name) {
      state.fileName = name;
      schedulePersist();
      emitter.emit();
    },
    hostFrames() {
      const ids = [...loweredTables.keys()];
      if (lastFrameId && !ids.includes(lastFrameId)) ids.push(lastFrameId);
      return ids;
    },
    async discoverHostFrames() {
      if (loweredTables.size === 0 && state.engine) {
        await rediscoverPlacements().catch((err) =>
          host.log.warn("rediscover failed", err),
        );
      }
      return bridge.hostFrames();
    },
  };

  // Sheet ADR 517 — validation, filter, sort, outline, protection and Goal
  // Seek in the grid (src/data-tools.ts).
  const data = createDataTools({
    host,
    engine: () => state.engine,
    sheet: () => state.activeSheet,
    selection: () => {
      if (state.gridSelection) return state.gridSelection;
      const at = activeOf();
      return at
        ? { anchorRow: at.row, anchorCol: at.col, rows: 1, cols: 1 }
        : null;
    },
    active: () => activeOf(),
    revision: () => revision,
    extent: () => {
      const info = api.sheets().find((x) => x.id === state.activeSheet);
      return info ? { rows: info.rows, cols: info.cols } : null;
    },
    enter: journaledEnterCell,
    reopenEdit: (row, col, text) => {
      applyModel(collapsed({ row, col }));
      cellEdit = { row, col, text };
      cellEditMode = "edit";
      emitter.emit({ kind: "edit" });
      void submitInFrameGrid();
    },
    journal: (edits, step) => journalBatch(edits, step),
    edited: () => {
      markEdited();
      emitter.emit();
      void submitInFrameGrid();
    },
    repaint: () => {
      emitter.emit();
      void submitInFrameGrid();
    },
    changedUi: () => emitter.emit(),
  });

  const api: WorkbookSession = {
    ...data.api,
    objectBridge: () => bridge,
    state: () => state,
    onDidChange: (l) => emitter.on(l),

    async import(bytes, name) {
      return loadWorkbook(bytes, name, true);
    },

    restore() {
      return track(restoreWorkbook("always"));
    },

    documentOpened() {
      // A different document is open: the workbook in memory belonged to
      // the one that closed. Drop it (and anything still queued to persist
      // it) before reading this document's own part.
      docEpoch += 1;
      loadEpoch += 1;
      unloadWorkbook();
      return track(restoreWorkbook("ifBound"));
    },

    async ensureRestored() {
      if (state.engine && state.activeSheet !== null) return true;
      await restoring;
      if (state.engine && state.activeSheet !== null) return true;
      return track(restoreWorkbook("ifBound"));
    },

    setActiveSheet(id) {
      state.activeSheet = id;
      // Selection is sheet-relative — clear it on a sheet switch.
      state.gridSelection = null;
      defaultRangeForActive();
      emitter.emit();
    },

    setRange(range) {
      state.selectedRange = range;
      emitter.emit();
    },

    async lowerSelection(opts: PlaceOptions = {}) {
      if (!state.engine || state.activeSheet === null || !state.selectedRange) {
        host.log.warn("lowerSelection: no workbook / sheet / range");
        return null;
      }
      const engine = state.engine;
      const sheet = state.activeSheet;
      const range = state.selectedRange;
      const kind = opts.sizing ?? "window";
      const print = {
        headings: opts.print?.headings ?? false,
        gridlines: opts.print?.gridlines ?? false,
      };
      const topLeft = opts.view?.topLeft ?? rangeTopLeft(range);
      // Wave 4 — land at the current selection, not a fixed page inset.
      let placement;
      let content: LoweredContent;
      let shown = range;
      let boxPt = kind === "fixed" ? opts.boxPt : undefined;
      try {
        if (kind === "fit") {
          // The earlier behaviour: a fixed range, text-measured widths.
          content = pageContent(engine, sheet, range);
        } else {
          // ADR 510 — a window frame shows the range's own tracks lowered as
          // a frame page: the lowering every later refresh makes, so the
          // first edit re-pours one cell, not the table.
          const own = rangeFramePage(engine, sheet, range, print);
          if (kind === "window" && topLeft === rangeTopLeft(range)) {
            content = own;
          } else {
            // Plan G4 — a window that starts elsewhere, or a fixed box: the
            // window of the sheet that fits the box from the view's cell.
            const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
            boxPt ??= {
              widthPt: sum(own.cols.map((c) => c.widthPt)) + WINDOW_SLACK_PT,
              heightPt: sum(own.rows.map((r) => r.heightPt)) + WINDOW_SLACK_PT,
            };
            const win = placementWindow(engine, {
              sheet,
              range,
              view: { topLeft, lock: false },
              print,
              sizing: "window",
              boxPt,
            });
            if (!win) throw new Error("engine wasm predates get_frame_page");
            content = win.content;
            shown = win.range ?? range;
          }
        }
        placement = await placementForContent(host, content);
        // Plan G4 — the next area of a print area goes under the last one.
        const under = opts.below ? await selectionBox(host) : null;
        if (placement && under) {
          const [t, l, b, r] = placement.bounds;
          const top = under.bottom + PLACE_GAP_PT;
          placement = {
            pageId: under.pageId,
            bounds: [top, under.left, top + (b - t), under.left + (r - l)] as [
              number,
              number,
              number,
              number,
            ],
          };
        }
        if (placement && kind === "fixed" && boxPt) {
          const [t, l] = placement.bounds;
          placement = {
            ...placement,
            bounds: [t, l, t + boxPt.heightPt, l + boxPt.widthPt] as [
              number,
              number,
              number,
              number,
            ],
          };
        }
      } catch (err) {
        host.log.warn("lowerSelection: could not lower the range", err);
        return null;
      }
      const id = await ownWrite(() =>
        lowerSelectionToFrame(host, engine, sheet, shown, {
          placement: placement ?? undefined,
          // The placement's height is the workbook's rows; the lowering
          // sizes it to the table the engine lays out — unless the caller
          // fixed the box.
          fitHeight: kind !== "fixed",
          contentVersion: revision,
          content,
          // ADR 510 — the frame is a window onto the sheet (plan G4: with
          // the caller's view, print options and box).
          sizing: kind === "fit" ? "fit" : "window",
          view: { topLeft, lock: opts.view?.lock ?? false },
          print,
          ...(boxPt ? { boxPt } : {}),
          // S-04 — record the resolved native table so "new style from cell"
          // can address its cells.
          onLowered: (info) => {
            lastLoweredTable = info;
            loweredTables.set(info.frameId, info);
          },
        }),
      );
      if (id) lastFrameId = id; // remember the in-frame grid target (S-02)
      return id;
    },

    async showGridInFrame(frameId?: string) {
      const target = frameId ?? lastFrameId;
      if (!target) {
        host.log.warn("showGridInFrame: no target frame — lower a range first");
        return false;
      }
      const prevFrame = lastFrameId;
      lastFrameId = target; // the in-frame grid + hide now track this frame
      const surface = sceneChannel();
      if (
        !surface &&
        !surfaceSink &&
        !host.supports("editContext.frameSurface@1")
      ) {
        host.log.warn(
          "showGridInFrame: no scene channel (supports('rendering.sceneLayer@1') is false)",
        );
        return false;
      }
      if (!state.engine || state.activeSheet === null) {
        host.log.warn("showGridInFrame: no workbook / sheet");
        return false;
      }
      // ADR 510 — the frame decides what the grid shows: its bound sheet
      // (made the active sheet while it is edited) and its view's top-left
      // cell. A frame without a binding keeps the active sheet at A1.
      // P6 — a continuation frame of a window chain shows the chain's
      // window from the rows it holds; its head's binding names the sheet.
      const head = chainHeadOf.get(target);
      const headInfo = head ? loweredTables.get(head) : undefined;
      const index =
        head && headInfo?.chain ? headInfo.chain.frames.indexOf(target) + 1 : 0;
      enteredContinuation =
        head && headInfo && index > 0 ? { head, index } : null;
      let start = await frameStart(enteredContinuation && head ? head : target);
      if (enteredContinuation && headInfo) {
        const row = headInfo.chainStarts?.[index];
        if (row !== undefined) start = { row, col: start.col };
      }
      // Size the grid window to the frame's content box (core clips to it).
      let wPt = 480;
      let hPt = 640;
      try {
        const geom = await host.document.elementGeometry([
          { kind: "textFrame", id: lastFrameId } as never,
        ]);
        const bounds = geom[0]?.bounds;
        if (bounds) {
          const [top, left, bottom, right] = bounds;
          wPt = Math.max(right - left, 0);
          hPt = Math.max(bottom - top, 0);
        }
      } catch (err) {
        host.log.debug("showGridInFrame: frame geometry read failed", err);
      }
      // The page lowers the window that fits this box (ADR 510).
      const placedInfo = lastFrameId
        ? loweredTables.get(lastFrameId)
        : undefined;
      if (
        placedInfo &&
        !placedInfo.boxPt &&
        lastFrameId &&
        wPt > 0 &&
        hPt > 0
      ) {
        loweredTables.set(lastFrameId, {
          ...placedInfo,
          boxPt: { widthPt: wPt, heightPt: hPt },
        });
      }
      // Wave 5 — keep the window's scroll when re-showing the same frame.
      const keep =
        lastGridWindow && prevFrame === target ? lastGridWindow : null;
      lastGridWindow = {
        firstRow: keep?.firstRow ?? start.row,
        firstCol: keep?.firstCol ?? start.col,
        // A mounted frame surface windows to its cell area (its headings
        // take part of the content box).
        wPt: surfaceArea?.wPt ?? wPt,
        hPt: surfaceArea?.hPt ?? hPt,
      };
      if (!inFrameActive) sessionFloor = journalCursor; // the modal boundary
      inFrameActive = true;
      // Excel always has an active cell: entered without one (the keyboard,
      // a frame entered for the first time), the grid starts on its view's
      // top-left cell so the keys work at once.
      if (!state.gridSelection) {
        applyGridSelection(
          lastGridWindow.firstRow,
          lastGridWindow.firstCol,
          1,
          1,
        );
        emitter.emit();
      }
      const ok = await submitInFrameGrid();
      if (!ok) host.log.warn("showGridInFrame: grid windowing failed");
      return ok;
    },

    selectCellInFrame(contentX: number, contentY: number) {
      // K-1 — the editor delivers a pointer in FRAME-CONTENT coordinates
      // (it inverted the frame's ItemTransform + content offset, §8.5).
      // Hit-test it against the last rendered grid, select that cell, and
      // re-render in-frame so the selection chrome shows. No engine round-
      // trip for the hit (pure geometry off `lastGridScene`). A click ALSO
      // cancels any in-progress edit on another cell (Excel behavior).
      if (!lastGridScene) return false;
      const hit = hitCell(lastGridScene, contentX, contentY);
      if (!hit) return false;
      cellEdit = null;
      applyGridSelection(hit.row, hit.col, 1, 1);
      void submitInFrameGrid();
      return true;
    },

    isCellEditing() {
      return cellEdit !== null;
    },

    typeCellChar(ch: string) {
      return typeChar(ch);
    },

    backspaceCellEdit() {
      return backspaceEdit();
    },

    commitCellEdit() {
      return commitEdit();
    },

    cancelCellEdit() {
      cancelEdit();
    },

    cutSelection() {
      runGridAction({ kind: "cut" });
    },

    selectionStats() {
      const t = formatTarget();
      if (!t || !state.engine?.rangeStats) return null;
      try {
        return state.engine.rangeStats(t.sheet, t.range);
      } catch (err) {
        host.log.debug("selectionStats: engine refused", err);
        return null;
      }
    },

    cellEditState() {
      return cellEdit ? { ...cellEdit, mode: cellEditMode } : null;
    },

    beginCellEdit(text, mode) {
      if (text === null) {
        const ok = openEdit();
        if (ok) cellEditMode = mode;
        return ok;
      }
      const at = activeOf();
      if (!at || !data.mayEdit(at.row, at.col)) return false;
      cellEdit = { row: at.row, col: at.col, text };
      cellEditMode = mode;
      emitter.emit({ kind: "edit" });
      void submitInFrameGrid();
      return true;
    },

    setCellEditText(text) {
      if (!cellEdit) return api.beginCellEdit(text, "enter");
      if (cellEdit.text === text) return true;
      cellEdit = { ...cellEdit, text };
      emitter.emit({ kind: "edit" });
      void submitInFrameGrid();
      return true;
    },

    attachFrameSurface(sink, cellArea) {
      surfaceSink = sink;
      surfaceArea = {
        wPt: Math.max(cellArea.wPt, 0),
        hPt: Math.max(cellArea.hPt, 0),
      };
      // A scene layer shown before the surface mounted would sit under it.
      if (lastFrameId) void sceneSurface?.clear(lastFrameId);
      if (lastGridWindow) {
        lastGridWindow = { ...lastGridWindow, ...surfaceArea };
        void submitInFrameGrid();
      }
      return () => {
        if (surfaceSink === sink) {
          surfaceSink = null;
          surfaceArea = null;
        }
      };
    },

    hideGridInFrame() {
      cellEdit = null;
      data.reset();
      drag = null;
      fillPreview = null;
      inFrameActive = false;
      if (lastFrameId) void sceneSurface?.clear(lastFrameId);
      // ADR 510 — leaving the frame moves its view to where the user
      // scrolled (a locked view snaps back), and the page shows it.
      let viewChanged = false;
      // P6 — leaving a continuation scrolls the chain: the head's view moves
      // by as many rows as this frame's grid moved from where it started.
      const cont = enteredContinuation;
      enteredContinuation = null;
      const headInfo = cont ? loweredTables.get(cont.head) : undefined;
      if (cont && headInfo?.view && !headInfo.view.lock && lastGridWindow) {
        const head = cellOfA1(headInfo.view.topLeft) ?? { row: 0, col: 0 };
        const startedAt = headInfo.chainStarts?.[cont.index] ?? head.row;
        const row = Math.max(
          0,
          head.row + (lastGridWindow.firstRow - startedAt),
        );
        const topLeft = a1OfCell(row, lastGridWindow.firstCol);
        if (topLeft !== headInfo.view.topLeft) {
          loweredTables.set(cont.head, {
            ...headInfo,
            view: { ...headInfo.view, topLeft },
          });
          viewMoved.add(cont.head);
          viewChanged = true;
        }
      }
      const placedInfo =
        !cont && lastFrameId ? loweredTables.get(lastFrameId) : undefined;
      if (
        lastFrameId &&
        placedInfo?.sizing === "window" &&
        placedInfo.view &&
        !placedInfo.view.lock &&
        lastGridWindow
      ) {
        // What the grid showed stays on the page; the page window moves
        // only as far as that needs (ADR 510).
        // The grid's body tracks from the window's CURRENT origin (a scroll
        // moves it at once; the painted scene can lag a frame), sized by
        // the last scene's body counts.
        const vp = lastGridScene?.viewport;
        const bodyRows = vp ? vp.rows - (vp.frozenRows ?? 0) : 0;
        const bodyCols = vp ? vp.cols - (vp.frozenCols ?? 0) : 0;
        const win = lastGridWindow;
        const gridRows = Array.from(
          { length: Math.max(0, bodyRows) },
          (_, i) => win.firstRow + i,
        );
        const gridCols = Array.from(
          { length: Math.max(0, bodyCols) },
          (_, i) => win.firstCol + i,
        );
        const at = cellOfA1(placedInfo.view.topLeft);
        const next =
          placedInfo.content && at && vp
            ? viewToContain(at, pageBodyTracks(placedInfo.content), {
                rows: gridRows,
                cols: gridCols,
              })
            : { row: lastGridWindow.firstRow, col: lastGridWindow.firstCol };
        const topLeft = a1OfCell(next.row, next.col);
        if (topLeft !== placedInfo.view.topLeft) {
          loweredTables.set(lastFrameId, {
            ...placedInfo,
            view: { ...placedInfo.view, topLeft },
          });
          viewMoved.add(lastFrameId);
          viewChanged = true;
        }
      }
      // Tier 2 — the session's edits reach the page as ONE refresh now.
      if (
        refreshDeferred ||
        viewChanged ||
        (lastFrameId !== null && viewMoved.has(lastFrameId))
      ) {
        refreshDeferred = false;
        void refreshPlacements();
      }
      // …and the workbook part with them, not a debounce later: the host
      // has no will-save hook, so a save right after Esc otherwise ships
      // the pre-edit workbook beside the post-edit page.
      void flushPersist().catch((err) =>
        host.log.warn("workbook persist on exit failed", err),
      );
    },

    async documentSwatchColors(ids) {
      const out = new Map<string, string>();
      if (ids.length === 0 || !host.supports("document.swatchDisplay@1"))
        return out;
      try {
        for (const shown of await host.document.swatchDisplay(ids))
          out.set(shown.id, shown.rgbHex);
      } catch (err) {
        host.log.debug("documentSwatchColors: read failed", err);
      }
      return out;
    },

    async documentStyleChoices() {
      const out = {
        paragraphStyles: [] as { id: string; name: string }[],
        swatches: [] as { id: string; name: string; rgbHex: string }[],
      };
      // Interface names (`$ID/…`) read as the user sees them.
      const shown = (name: string) => name.replace(/^\$ID\//, "");
      try {
        const ps = await host.document.collection<{
          selfId: string;
          name: string;
        }>("paragraphStyles");
        out.paragraphStyles = ps
          .filter((p) => !p.selfId.endsWith("[No paragraph style]"))
          .map((p) => ({ id: p.selfId, name: shown(p.name) }));
      } catch (err) {
        host.log.debug("documentStyleChoices: paragraph styles", err);
      }
      try {
        const sw = await host.document.collection<{
          selfId: string;
          name: string;
          kind: string;
        }>("swatches");
        const usable = sw.filter(
          (x) =>
            !/\/(None|Registration)$/.test(x.selfId) &&
            !x.selfId.startsWith("Gradient/"),
        );
        const colors = await api.documentSwatchColors(
          usable.map((x) => x.selfId),
        );
        out.swatches = usable
          .filter((x) => colors.has(x.selfId))
          .map((x) => ({
            id: x.selfId,
            name: shown(x.name),
            rgbHex: colors.get(x.selfId)!,
          }));
      } catch (err) {
        host.log.debug("documentStyleChoices: swatches", err);
      }
      return out;
    },

    async applyDocumentSwatch(target, swatchId) {
      if (swatchId === null) {
        return api.setStyle(
          target === "fill"
            ? { fill: "", fillSwatch: null }
            : { fontColor: "", fontSwatch: null },
        );
      }
      const ref = await api.documentSwatchRef(swatchId);
      if (!ref)
        return {
          ok: false as const,
          message: `no swatch "${swatchId}" in the document`,
        };
      return api.setStyle(
        target === "fill" ? { fillSwatch: ref } : { fontSwatch: ref },
      );
    },

    documentStyleRevision() {
      return docStyleRevision;
    },

    async documentSwatchRef(id) {
      if (!host.supports("document.swatchDisplay@1")) return null;
      try {
        const [shown] = await host.document.swatchDisplay([id]);
        if (!shown) return null;
        const m = shown.model.toLowerCase();
        const model: DocSwatch["model"] = m.includes("spot")
          ? "spot"
          : m.includes("lab")
            ? "lab"
            : shown.cmyk
              ? "cmyk"
              : "rgb";
        return {
          id,
          model,
          fallbackRgb: `#${shown.rgbHex.replace(/^#/, "").toUpperCase()}`,
        };
      } catch (err) {
        host.log.debug(`documentSwatchRef: ${id} unreadable`, err);
        return null;
      }
    },

    async documentTextDefault() {
      if (!host.supports("document.styleProperties@1")) return null;
      try {
        let props: Awaited<ReturnType<typeof host.document.styleProperties>> =
          null;
        for (const id of BASIC_PARAGRAPH_STYLES) {
          props = await host.document.styleProperties("paragraph", id);
          if (props) break;
        }
        if (!props) return null;
        const entries = props.entries;
        const entry = (path: string) =>
          entries.find((e) => e.path === path)?.value ?? null;
        // An unset entry reads as "" (text) or null (length): absent.
        const text = (v: unknown) => {
          const raw =
            v && typeof v === "object" && "value" in v
              ? (v as { value: unknown }).value
              : null;
          return raw === null || raw === undefined || raw === ""
            ? null
            : String(raw);
        };
        const num = (v: unknown) => {
          const t = text(v);
          const n = t === null ? NaN : Number(t);
          return Number.isFinite(n) ? n : null;
        };
        const family = text(entry("characterFontFamily"));
        if (!family) return null;
        return {
          family,
          style: text(entry("characterFontStyle")),
          sizePt: num(entry("characterFontSize")),
        };
      } catch (err) {
        host.log.debug("documentTextDefault: style read failed", err);
        return null;
      }
    },

    async documentStyleLooks(ids) {
      const out = new Map<string, DocStyleLook>();
      if (!host.supports("document.styleProperties@1")) return out;
      const colorOf = new Map<string, string>();
      for (const { collection, id } of ids) {
        try {
          const props = await host.document.styleProperties(collection, id);
          if (!props) continue;
          const entry = (path: string) =>
            props.entries.find((e) => e.path === path)?.value ?? null;
          const look: DocStyleLook = {};
          const family = styleEntryText(entry("characterFontFamily"));
          const style = styleEntryText(entry("characterFontStyle"));
          const size = styleEntryNum(entry("characterFontSize"));
          if (family) look.family = family;
          if (style) look.style = style;
          if (size !== null) look.sizePt = size;
          const swatch = styleEntryText(entry("characterFillColor"));
          if (swatch) colorOf.set(id, swatch);
          out.set(id, look);
        } catch (err) {
          host.log.debug(`documentStyleLooks: ${id} unreadable`, err);
        }
      }
      if (colorOf.size > 0 && host.supports("document.swatchDisplay@1")) {
        try {
          const shown = new Map(
            (
              await host.document.swatchDisplay([...new Set(colorOf.values())])
            ).map((x) => [x.id, x.rgbHex] as const),
          );
          for (const [id, sw] of colorOf) {
            const hex = shown.get(sw);
            const look = out.get(id);
            if (hex && look) look.color = hex.startsWith("#") ? hex : `#${hex}`;
          }
        } catch (err) {
          host.log.debug("documentStyleLooks: swatch read failed", err);
        }
      }
      return out;
    },

    docStyles() {
      const e = state.engine;
      if (!e?.docStyleMap || !e.namedStyleUsage) return null;
      const hit = readCache.get("docStyles") as DocStylesInfo | undefined;
      if (hit) return hit;
      try {
        const map = e.docStyleMap();
        const info: DocStylesInfo = {
          enabled: map.enabled,
          entries: map.entries,
          usage: e.namedStyleUsage(),
        };
        readCache.set("docStyles", info);
        return info;
      } catch (err) {
        host.log.debug("docStyles: engine read failed", err);
        return null;
      }
    },

    async documentStyleLists() {
      const lists = await readDocumentStyleLists(host);
      if (!lists) return null;
      const e = state.engine;
      let missing: MissingReference[] = [];
      try {
        if (e?.docReferences)
          missing = missingDocReferences(e.docReferences(), lists);
      } catch (err) {
        host.log.debug("documentStyleLists: references unreadable", err);
      }
      await syncDocStyleAvailability(lists);
      return { lists, missing };
    },

    async setDocStylesEnabled(on) {
      if (on) return enableDocStyles();
      return journalDocMap((e) => {
        if (!e.setDocStylesEnabled)
          throw new Error("engine wasm predates set_doc_styles_enabled");
        e.setDocStylesEnabled(false);
      });
    },

    setDocStyleMapping(style, target) {
      const r = journalDocMap((e) => {
        if (!e.setDocStyleMapping)
          throw new Error("engine wasm predates set_doc_style_mapping");
        e.setDocStyleMapping(style, target);
      });
      if (r.ok) scheduleDocStyleSync();
      return r;
    },

    async createDocStylesFromWorkbook() {
      const engine = state.engine;
      if (!engine?.docStyleMap || !engine.namedStyleUsage)
        return { ok: false as const, message: "no workbook open" };
      const [lists, swatches] = await Promise.all([
        readDocumentStyleLists(host),
        readKnownSwatchIds(host),
      ]);
      if (!lists)
        return {
          ok: false as const,
          message: "the document's styles could not be read",
        };
      if (state.engine !== engine)
        return { ok: false as const, message: "the workbook changed" };
      const plan = createDocStylesPlan(
        engine.namedStyleUsage(),
        engine.docStyleMap(),
        lists,
        swatches,
      );
      const created = plan.ops.filter(
        (op) => op.op === "createParagraphStyle",
      ).length;
      if (plan.ops.length > 0) {
        const res = await ownWrite(() =>
          host.document.mutate({ op: "batch", args: { ops: plan.ops } }),
        );
        if (!res.applied)
          return {
            ok: false as const,
            message: "the document refused the new styles",
          };
        docStyleRevision += 1;
      }
      if (state.engine !== engine)
        return { ok: false as const, message: "the workbook changed" };
      const r = journalDocMap((e) => {
        const map = e.docStyleMap!();
        e.setDocStyleMap!({
          enabled: true,
          entries: { ...map.entries, ...plan.entries },
        });
      });
      await syncDocStyleAvailability(await readDocumentStyleLists(host));
      return r.ok ? { ok: true as const, created } : r;
    },

    async remapDocReference(from, to) {
      const engine = state.engine;
      if (!engine?.remapDocReference)
        return { ok: false as const, message: "no workbook open" };
      const lists = await readDocumentStyleLists(host);
      let model: string | null = null;
      if (lists?.swatches.includes(to)) {
        const ref = await api.documentSwatchRef(to);
        model = ref?.model ?? null;
      }
      if (state.engine !== engine)
        return { ok: false as const, message: "the workbook changed" };
      try {
        engine.remapDocReference(from, to, model);
      } catch (err) {
        return {
          ok: false as const,
          message: err instanceof Error ? err.message : String(err),
        };
      }
      markEdited();
      await syncDocStyleAvailability(lists);
      emitter.emit();
      return { ok: true as const };
    },

    async documentFontFace(family, style) {
      if (!host.supports("assets.fonts@1")) return null;
      try {
        const face = await host.assets.getFontFace(family, style);
        return face
          ? {
              bytes: face.bytes,
              family: face.family,
              ...(face.style ? { style: face.style } : {}),
            }
          : null;
      } catch (err) {
        host.log.debug(`documentFontFace: ${family} unavailable`, err);
        return null;
      }
    },

    setFrameSheet(sheetId) {
      const engine = state.engine;
      if (!engine || !engine.listSheets().some((x) => x.id === sheetId))
        return false;
      if (state.activeSheet === sheetId) return true;
      api.setActiveSheet(sheetId);
      const id = lastFrameId;
      const info = id ? loweredTables.get(id) : undefined;
      if (id && info?.sizing === "window" && info.view) {
        loweredTables.set(id, {
          ...info,
          sheet: sheetId,
          view: { ...info.view, topLeft: "A1" },
          // A sheet switch rewrites every cell: no in-place diff.
          content: undefined,
        });
        viewMoved.add(id);
      }
      if (lastGridWindow)
        lastGridWindow = { ...lastGridWindow, firstRow: 0, firstCol: 0 };
      if (inFrameActive) void submitInFrameGrid();
      else if (id && viewMoved.has(id)) void refreshPlacements();
      return true;
    },

    frameView(frameId) {
      const id = frameId ?? lastFrameId;
      const info = id ? loweredTables.get(id) : undefined;
      if (!info || info.sizing !== "window" || !info.view) return null;
      return { ...info.view };
    },

    setFrameViewLock(lock, frameId) {
      const id = frameId ?? lastFrameId;
      const info = id ? loweredTables.get(id) : undefined;
      if (!id || !info || info.sizing !== "window" || !info.view) return false;
      const topLeft =
        inFrameActive && id === lastFrameId && lastGridWindow
          ? a1OfCell(lastGridWindow.firstRow, lastGridWindow.firstCol)
          : info.view.topLeft;
      if (info.view.lock === lock && info.view.topLeft === topLeft) return true;
      loweredTables.set(id, { ...info, view: { topLeft, lock } });
      viewMoved.add(id);
      // While entered, the page is written on leaving; otherwise now.
      if (!inFrameActive) void refreshPlacements();
      emitter.emit();
      return true;
    },

    listCharts() {
      if (!state.engine) return [];
      try {
        return state.engine.listCharts();
      } catch (err) {
        host.log.warn("listCharts: engine call failed", err);
        return [];
      }
    },

    workbookPalette() {
      const engine = state.engine;
      if (!engine) return [];
      // CHART colours. The geometry is size-parameterised, but a
      // chart's PALETTE is not — the size only moves the primitives —
      // so a fixed nominal box is used rather than a real frame's,
      // which the palette read has no business knowing about.
      const charts: ChartGeometry[] = [];
      try {
        for (const info of engine.listCharts()) {
          charts.push(
            engine.getChartGeometry(
              info.index,
              PALETTE_PROBE_WPT,
              PALETTE_PROBE_HPT,
            ),
          );
        }
      } catch (err) {
        host.log.warn("workbookPalette: chart geometry read failed", err);
      }
      // DATA-BAR colours, from the currently selected region — the one
      // the user is looking at, and the one a lower would emit swatches
      // for. A conditional-format rule outside the selection has no
      // lowered rect, so it has no swatch to show.
      const regions: LoweredContent[] = [];
      if (state.activeSheet !== null && state.selectedRange) {
        try {
          regions.push(
            engine.getRangeLowered(state.activeSheet, state.selectedRange),
          );
        } catch (err) {
          host.log.warn("workbookPalette: region lower failed", err);
        }
      }
      return workbookPalette({ charts, regions });
    },

    chartKinds() {
      const engine = state.engine;
      if (!engine) return [];
      return cachedRead("chartKinds", () => {
        try {
          return engine.chartKinds() ?? [];
        } catch (err) {
          host.log.warn("chartKinds: engine call failed", err);
          return [];
        }
      });
    },

    authorChart(values, categories, kind, title, seriesIn) {
      if (!state.engine || state.activeSheet === null) {
        return { ok: false as const, message: "no workbook loaded" };
      }
      try {
        const index = state.engine.addChart(
          state.activeSheet,
          values,
          categories,
          kind,
          title,
          seriesIn ?? "columns",
        );
        emitter.emit();
        return { ok: true as const, index };
      } catch (err) {
        return {
          ok: false as const,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },

    async lowerChart(chartIndex) {
      if (!state.engine) {
        host.log.warn("lowerChart: no workbook");
        return false;
      }
      // Beside what is selected — never on top of it (the film's chart
      // landed over the table placed a moment before) — and on the page,
      // inside its margins.
      const placement = await chartPlacement(host);
      return lowerChartToFrame(host, state.engine, chartIndex, {
        placement: placement ?? undefined,
        contentVersion: revision,
        onLowered: (placed) => {
          placedCharts.push(placed);
        },
      });
    },

    gridScene(firstRow, firstCol, wPt, hPt) {
      return computeGridScene(firstRow, firstCol, wPt, hPt);
    },

    setGridSelection(anchorRow, anchorCol, rows, cols) {
      applyGridSelection(anchorRow, anchorCol, rows, cols);
    },

    editCell(sheet, row, col, input) {
      if (!state.engine || state.activeSheet === null) {
        host.log.warn("editCell: no workbook / sheet");
        return false;
      }
      if (!journaledSetCell(sheet, row, col, fromDisplay(row, col, input)))
        return false;
      // The dirty cut recomputed in Rust; refresh the panel (it re-requests
      // the windowed scene on the next render).
      emitter.emit({
        kind: "cells",
        regions: regionsOf([{ sheet, row, col }]),
      });
      return true;
    },

    cellInputAt(row, col) {
      // S-04 formula bar — re-enterable input (engine.getCellInput), so the
      // bar shows a cell's FORMULA, not its computed display. Never throws.
      const engine = state.engine;
      const sheet = state.activeSheet;
      if (!engine || sheet === null) return "";
      const input = cachedRead(`input:${sheet}:${row}:${col}`, () => {
        try {
          return engine.getCellInput(sheet, row, col) ?? "";
        } catch (err) {
          host.log.warn("cellInputAt: engine read failed", err);
          return "";
        }
      });
      // The cache keeps the canonical input (the journal reads it too).
      return toDisplay(row, col, input);
    },

    async copySelection() {
      // K-6 / S-14 — read the selected range's FORMATTED display strings from
      // the engine (all formatting in Rust) and write a tabular payload (+ a
      // TSV text fallback) to the system clipboard. Thin glue (§3): the engine
      // owns the values, the host owns the clipboard.
      if (!state.engine || state.activeSheet === null) {
        return { ok: false as const, message: "open a workbook first" };
      }
      const sel = state.gridSelection;
      if (!sel) {
        return { ok: false as const, message: "select a range to copy" };
      }
      // Excel: a copy takes one range, not several separate areas.
      if (extraAreas.length > 0) {
        return {
          ok: false as const,
          message: "this can't be done with several separate areas selected",
        };
      }
      const range = selectionRangeA1(
        sel.anchorRow,
        sel.anchorCol,
        sel.rows,
        sel.cols,
      );
      let grid: string[][];
      try {
        grid = state.engine.getRangeValues(state.activeSheet, range);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        host.log.warn("copySelection: range read failed", err);
        return { ok: false as const, message };
      }
      if (grid.length === 0) {
        return { ok: false as const, message: "the selection is empty" };
      }
      // Wave 5 — snapshot the INPUTS too: pasting our own copy carries
      // formulas (re-addressed), Excel's in-app copy. Other apps get values.
      copySource = null;
      if (state.engine.getRangeInputs) {
        try {
          copySource = {
            sheet: state.activeSheet,
            rect: { ...sel },
            displays: grid,
            inputs: state.engine.getRangeInputs(state.activeSheet, range),
          };
        } catch (err) {
          host.log.debug(
            "copySelection: input snapshot failed (values only)",
            err,
          );
        }
      }
      const tabular: TabularClipboard = { rows: grid };
      const text = grid.map((r) => r.join("\t")).join("\n");
      try {
        await host.clipboard.write({ text, tabular });
      } catch (err) {
        // The SDK door already swallows a platform refusal; a throw here would
        // be a gate/contract error — report it honestly, never crash the grid.
        const message = err instanceof Error ? err.message : String(err);
        host.log.warn("copySelection: clipboard write failed", err);
        return { ok: false as const, message };
      }
      return {
        ok: true as const,
        rows: grid.length,
        cols: grid[0]?.length ?? 0,
      };
    },

    pasteSpecialOpen() {
      return pasteSpecialCard;
    },
    openPasteSpecial() {
      if (pasteSpecialCard) return;
      pasteSpecialCard = true;
      emitter.emit();
    },
    closePasteSpecial() {
      if (!pasteSpecialCard) return;
      pasteSpecialCard = false;
      emitter.emit();
    },

    async pasteAtSelection(options: PasteOptions = {}) {
      pasteSpecialCard = false;
      // K-6 / S-14 — read the clipboard, land its grid at the selection anchor
      // through the JOURNALED editCell lane as ONE grouped undo step. Prefers
      // the rich tabular half; falls back to TSV. Thin glue (§3): the engine
      // re-types each cell's string in Rust; this only routes + journals.
      if (!state.engine || state.activeSheet === null) {
        return { ok: false as const, message: "open a workbook first" };
      }
      const sel = state.gridSelection;
      if (!sel) {
        return { ok: false as const, message: "select a cell to paste at" };
      }
      let payload;
      try {
        payload = await host.clipboard.read();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        host.log.warn("pasteAtSelection: clipboard read failed", err);
        return { ok: false as const, message };
      }
      if (!payload) {
        return { ok: false as const, message: "the clipboard is empty" };
      }
      // Prefer the rich grid; fall back to parsing the TSV text half.
      const grid =
        payload.tabular?.rows ??
        (payload.text !== undefined ? tsvToRows(payload.text) : []);
      if (grid.length === 0) {
        return {
          ok: false as const,
          message: "nothing tabular on the clipboard",
        };
      }
      // Our own copy still on the clipboard (same cells, same displays) →
      // paste its INPUTS, formulas re-addressed by the engine for the paste
      // offset. Anything else is text the engine re-types per cell.
      const sheet = state.activeSheet;
      const engine = state.engine;
      const own =
        copySource &&
        engine.shiftFormulas &&
        JSON.stringify(copySource.displays) === JSON.stringify(grid)
          ? copySource
          : null;
      const what = options.what ?? "all";
      const op = options.operation ?? "none";
      const useInputs = own !== null && what !== "values";
      const transpose = (g: string[][]) => {
        const w = Math.max(...g.map((r) => r.length));
        return Array.from({ length: w }, (_, c) => g.map((r) => r[c] ?? ""));
      };
      const raw = useInputs
        ? own.inputs
        : what === "values" && own
          ? own.displays
          : grid;
      const block = options.transpose ? transpose(raw) : raw;
      const bRows = block.length;
      const bCols = Math.max(...block.map((r) => r.length));
      // A selection that is a whole multiple of the block tiles it (copy one
      // cell, select a column, paste — Excel).
      const tile =
        sel.rows % bRows === 0 &&
        sel.cols % bCols === 0 &&
        (sel.rows > bRows || sel.cols > bCols);
      const area: GridSelection = tile
        ? { ...sel }
        : {
            anchorRow: sel.anchorRow,
            anchorCol: sel.anchorCol,
            rows: bRows,
            cols: bCols,
          };
      const targets: CellEditRecord[] = [];
      for (let tr = 0; tr < area.rows; tr += bRows) {
        for (let tc = 0; tc < area.cols; tc += bCols) {
          const top = area.anchorRow + tr;
          const left = area.anchorCol + tc;
          let rows = block;
          if (useInputs && !options.transpose) {
            try {
              rows = engine.shiftFormulas!(
                sheet,
                own.inputs,
                top - own.rect.anchorRow,
                left - own.rect.anchorCol,
              );
            } catch (err) {
              host.log.warn("pasteAtSelection: formula adjust failed", err);
              return {
                ok: false as const,
                message: "the paste could not adjust its formulas",
              };
            }
          } else if (useInputs) {
            // Transposed: each source cell moves by its own offset, so each
            // formula is re-addressed alone.
            try {
              rows = block.map((row, r) =>
                row.map((input, c) => {
                  if (!input.startsWith("=")) return input;
                  // Block cell (r, c) came from source cell (c, r).
                  const dRow = top + r - (own.rect.anchorRow + c);
                  const dCol = left + c - (own.rect.anchorCol + r);
                  return (
                    engine.shiftFormulas!(
                      sheet,
                      [[input]],
                      dRow,
                      dCol,
                    )[0]?.[0] ?? input
                  );
                }),
              );
            } catch (err) {
              host.log.warn("pasteAtSelection: formula adjust failed", err);
              return {
                ok: false as const,
                message: "the paste could not adjust its formulas",
              };
            }
          }
          rows.forEach((row, r) =>
            row.forEach((next, c) => {
              if (options.skipBlanks && next === "") return;
              let input: string | null = next;
              if (op !== "none") {
                const dst = engine.getCellInput(sheet, top + r, left + c);
                input = combinePaste(dst, next, op);
                if (input === null) return;
              }
              targets.push({
                sheet,
                row: top + r,
                col: left + c,
                prevInput: "",
                nextInput: input,
              });
            }),
          );
        }
      }
      const { written: edits, journaled } = writeTargets(
        engine,
        targets,
        "pasteAtSelection",
      );
      if (edits.length === 0) {
        return { ok: false as const, message: "the paste wrote no cells" };
      }
      // A cut moves: the source cells outside the paste are emptied in the
      // same undo step.
      if (cutPending) {
        const src = cutPending;
        cutPending = null;
        const inPaste = (r: number, c: number) =>
          r >= area.anchorRow &&
          r < area.anchorRow + area.rows &&
          c >= area.anchorCol &&
          c < area.anchorCol + area.cols;
        const clears: CellEditRecord[] = [];
        for (let r = src.anchorRow; r < src.anchorRow + src.rows; r++)
          for (let c = src.anchorCol; c < src.anchorCol + src.cols; c++)
            if (!inPaste(r, c))
              clears.push({
                sheet,
                row: r,
                col: c,
                prevInput: "",
                nextInput: "",
              });
        if (clears.length > 0) {
          const cleared = writeTargets(engine, clears, "cut");
          edits.push(...cleared.written);
        }
      }
      if (journaled)
        journalBatch(edits); // one grouped Cmd-Z undoes the whole paste
      else markEdited();
      emitter.emit({ kind: "cells", regions: regionsOf(edits) });
      // The pasted cells become the selection (Excel).
      if (area.rows > 1 || area.cols > 1) applyModel(modelOfRect(area));
      void submitInFrameGrid();
      return {
        ok: true as const,
        rows: area.rows,
        cols: area.cols,
      };
    },

    sheets() {
      const engine = state.engine;
      if (!engine) return [];
      return cachedRead("sheets", () => {
        try {
          return engine.listSheets();
        } catch (err) {
          host.log.warn("sheets: engine read failed", err);
          return [];
        }
      });
    },

    functionList() {
      // S-04 formula bar — the engine's registry function table (constitution
      // §7), cached for the session. Never throws (empty on failure / no
      // engine).
      if (functionCache) return functionCache;
      if (!state.engine) return [];
      try {
        functionCache = state.engine.listFunctions();
        return functionCache;
      } catch (err) {
        host.log.warn("functionList: engine read failed", err);
        return [];
      }
    },

    undoCellEdit() {
      // An open buffer unwinds first — Cmd-Z mid-typing = cancel the
      // in-flight edit (no Operation was committed for it).
      if (cellEdit !== null) {
        cellEdit = null;
        emitter.emit({ kind: "cells", regions: [] }); // only the buffer went
        void submitInFrameGrid();
        return true;
      }
      // A batched group (sort / replace-all / paste / fill / clear) unwinds
      // WHOLE — one undo step, one batch write. In an entered frame the
      // session's start is the floor (ADR-012: the modal boundary).
      if (inFrameActive && journalCursor <= sessionFloor) return false;
      return stepJournal("undo");
    },

    redoCellEdit() {
      if (cellEdit !== null) return false;
      return stepJournal("redo");
    },

    canUndoCellEdit() {
      return (
        cellEdit !== null || journalCursor > (inFrameActive ? sessionFloor : 0)
      );
    },

    canRedoCellEdit() {
      return cellEdit === null && journalCursor < editJournal.length;
    },

    clearCellEditJournal() {
      editJournal = [];
      journalCursor = 0;
    },

    sortRange(keyCol, ascending, hasHeader) {
      // Thin glue (§3): the engine owns ALL sort semantics — stable order,
      // typed ranks, blanks-last, the formula-refusal boundary. This only
      // routes the selected range in and journals the result.
      if (!state.engine || state.activeSheet === null || !state.selectedRange) {
        return { ok: false, message: "no workbook / sheet / range" };
      }
      try {
        const res = state.engine.sortRange(
          state.activeSheet,
          state.selectedRange,
          keyCol,
          ascending,
          hasHeader,
        );
        journalBatch(res.edits); // one grouped ADR-012 undo step
        emitter.emit({ kind: "cells", regions: regionsOf(res.edits) });
        void submitInFrameGrid();
        return { ok: true };
      } catch (err) {
        // The honest boundary (e.g. "sort over a spilled region not
        // supported") — surfaced verbatim for the panel.
        const message = err instanceof Error ? err.message : String(err);
        host.log.warn("sortRange refused", err);
        return { ok: false, message };
      }
    },

    findAll(needle, opts, scope) {
      if (!state.engine) return [];
      const sheet =
        scope === "workbook" ? undefined : (state.activeSheet ?? undefined);
      if (scope === "sheet" && sheet === undefined) return [];
      try {
        return state.engine.findAll(sheet, needle, opts);
      } catch (err) {
        host.log.warn("findAll failed", err);
        return [];
      }
    },

    replaceAll(needle, replacement, opts, scope) {
      if (!state.engine) return { error: "no workbook" };
      const sheet =
        scope === "workbook" ? undefined : (state.activeSheet ?? undefined);
      if (scope === "sheet" && sheet === undefined) {
        return { error: "no active sheet" };
      }
      try {
        const res = state.engine.replaceAll(sheet, needle, replacement, opts);
        journalBatch(res.edits); // one grouped ADR-012 undo step
        emitter.emit({ kind: "cells", regions: regionsOf(res.edits) });
        void submitInFrameGrid();
        return {
          occurrences: res.occurrences,
          replacedCells: res.edits.length,
          skipped: res.skipped.length,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        host.log.warn("replaceAll failed", err);
        return { error: message };
      }
    },

    goToCell(sheet, row, col) {
      // A find hit: land on its sheet (range defaults like setActiveSheet)
      // and select the cell; applyGridSelection emits + re-renders.
      if (state.activeSheet !== sheet) {
        state.activeSheet = sheet;
        defaultRangeForActive();
      }
      applyModel(collapsed({ row, col }));
    },

    async newCellStyleFromSelection(name: string) {
      // S-04 — thin glue (§3): the engine owns the lowering/appearance, the
      // platform owns style minting + the cell-property read. This routes
      // the selected cell's model coords → the lowered table cell, reads its
      // properties, and mints/populates/attempts-to-apply a cell style.
      if (!lastLoweredTable) {
        return {
          ok: false as const,
          message: "place a range on the page first, then pick a cell in it",
        };
      }
      const sel = state.gridSelection;
      if (!sel || state.engine === null || state.activeSheet === null) {
        return { ok: false as const, message: "select a cell first" };
      }
      // The lowered table belongs to ONE (sheet, range). A style-from-cell
      // only makes sense over that table's own sheet.
      if (state.activeSheet !== lastLoweredTable.sheet) {
        return {
          ok: false as const,
          message:
            "the selected cell is on a different sheet than the placed table",
        };
      }

      // Map the selection anchor (MODEL coords) → the lowered table cell
      // (row/col POSITION) via the engine's lowered IR for the bound range —
      // the SAME mapping the table pour uses (tableCellPositionOf). When the
      // selection is outside the lowered range, fall back to the table's
      // first cell (the honest derivable subset — explicit in the UI wording).
      let content;
      try {
        content = state.engine.getRangeLowered(
          lastLoweredTable.sheet,
          lastLoweredTable.range,
          { includeGridRules: true },
        );
      } catch (err) {
        host.log.warn("newCellStyleFromSelection: lower read failed", err);
        return {
          ok: false as const,
          message: "could not read the placed range",
        };
      }
      const pos = tableCellPositionOf(content, sel.anchorRow, sel.anchorCol) ??
        // Outside the lowered range → first cell of the table (documented
        // residual: the per-cell mapping is exact for in-range cells; this
        // keeps the affordance honest rather than guessing).
        { row: 0, col: 0 };
      const fromFirstCell =
        tableCellPositionOf(content, sel.anchorRow, sel.anchorCol) === null;

      const cellEid: ElementId = {
        kind: "tableCell",
        id: {
          story_id: lastLoweredTable.storyId,
          table_id: lastLoweredTable.tableId,
          // Below a header band the host added, if any.
          row: pos.row + (lastLoweredTable.headerRows ?? 0),
          col: pos.col,
        },
      };

      // Read the cell's current properties (B-19). The engine may return a
      // thin entry set for a table cell (the Table NodeId surface is still
      // landing) — we carry whatever cell-appearance entries it gives.
      let entries: ReadEntry[] = [];
      try {
        const props = await host.document.elementProperties(cellEid);
        entries = (props?.entries ?? []) as ReadEntry[];
      } catch (err) {
        host.log.warn(
          "newCellStyleFromSelection: elementProperties failed",
          err,
        );
      }

      // Mint + populate the style (these DO land). The id is ours (selfId) —
      // createCellStyle may return createdId:null for collection creates.
      const styleId = `pgsheet.cellstyle.${Date.now().toString(36)}.${(nextCellStyleSeq++).toString(
        36,
      )}`;
      const plan = planCellStyleFromEntries(styleId, name, entries);

      try {
        const created = await host.document.mutate(plan.createOp);
        if (!created.applied) {
          host.log.warn(
            "newCellStyleFromSelection: createCellStyle rejected",
            created,
          );
          return {
            ok: false as const,
            message: "the host rejected createCellStyle",
          };
        }
        for (const op of plan.propertyOps) {
          const r = await host.document.mutate(op);
          if (!r.applied) {
            host.log.warn(
              "newCellStyleFromSelection: setStyleProperty rejected",
              r,
            );
          }
        }
      } catch (err) {
        host.log.error("newCellStyleFromSelection: mint/populate threw", err);
        return { ok: false as const, message: "minting the cell style failed" };
      }

      // The APPLY-BACK. The engine applies appliedCellStyle on a tableCell;
      // a host that refuses it is reported, never faked.
      let applied = false;
      let applyMessage: string | null = null;
      try {
        const r = await host.document.mutate(plan.applyOp(cellEid));
        applied = r.applied;
        if (!r.applied) {
          applyMessage =
            "style created but not applied to the cell — the host refused " +
            "appliedCellStyle";
          host.log.info(`newCellStyleFromSelection: ${applyMessage}`);
        }
      } catch (err) {
        applyMessage = "style created but applying it threw (appliedCellStyle)";
        host.log.info("newCellStyleFromSelection: apply-back threw", err);
      }

      emitter.emit();
      return {
        ok: true as const,
        styleId,
        capturedCount: plan.capturedPaths.length,
        applied,
        applyMessage:
          applyMessage ??
          (fromFirstCell ? "captured from the table's first cell" : null),
      };
    },

    discoverDatasets() {
      // S-15 — only ask the registry when a real one is wired
      // (`supports("dataProviders@1")`) AND the surface exists; both guard
      // the §2.1 graceful-absence posture (paged.data absent ⇒ no sources).
      // The host's gate also requires our `consume` capability; we declared
      // it, so discover is permitted.
      if (!host.supports("dataProviders@1") || !host.dataProviders) return [];
      try {
        return host.dataProviders.discover("dataset");
      } catch (err) {
        host.log.warn("discoverDatasets: discover failed", err);
        return [];
      }
    },

    async sourceFromDataset(providerId: string, opts?: { live?: boolean }) {
      const live = opts?.live ?? true;
      // S-15 — honest defer when no registry is wired (graceful absence,
      // like the existing honest-missing patterns). No surface ⇒ nothing
      // to source.
      if (!host.supports("dataProviders@1") || !host.dataProviders) {
        host.log.warn(
          `sourceFromDataset("${providerId}"): no data-provider registry ` +
            "wired (supports('dataProviders@1') is false) — install/enable " +
            "paged.data to source a sheet from a governed dataset",
        );
        return;
      }

      // Pull the resolved snapshot (the rows). The consumer NEVER fetches —
      // it receives an already-resolved RecordSet the platform hands it
      // (§1.1: paged.data owns the network + the §11 consent).
      let snapshot;
      try {
        snapshot = await host.dataProviders.get(providerId);
      } catch (err) {
        host.log.error(`sourceFromDataset("${providerId}"): get failed`, err);
        return;
      }
      if (!snapshot) {
        host.log.warn(
          `sourceFromDataset("${providerId}"): provider no longer exists`,
        );
        return;
      }

      // Boot a FRESH, EMPTY workbook (sheet 0 = "Sheet1") — a dataset-sourced
      // sheet replaces the workbook, it does not merge into the imported one.
      let engine: SheetEngine;
      try {
        engine = await bootEmptyEngine();
        state.bootError = null;
      } catch (err) {
        state.bootError = err instanceof Error ? err.message : ENGINE_NOT_BUILT;
        host.log.warn("sourceFromDataset: engine boot failed", err);
        emitter.emit();
        return;
      }

      // Tear down any prior workbook engine (we're replacing it).
      try {
        state.engine?.dispose();
      } catch (err) {
        host.log.warn("sourceFromDataset: prior engine dispose failed", err);
      }

      seededExtent = seedSheetFromRecords(engine, snapshot.records);

      cancelPendingPersist(); // the prior workbook is replaced
      loadEpoch += 1; // a new workbook: its version history starts here
      forgetPlacements();
      state.engine = engine;
      dialectEngine(); // learn the formula display while loading
      state.activeSheet = 0;
      state.fileName = providerId;
      state.gridSelection = null;
      defaultRangeForActive();

      // Remember the linked (providerId, revision); the seeded values are
      // committed content (they travel with the document) — §1.1 honesty:
      // we do NOT auto-refetch. A later revision only MARKS the sheet stale;
      // re-sourcing is an explicit author action.
      state.dataSource = {
        providerId,
        revision: snapshot.revision,
        stale: false,
        live,
      };

      // Replace the prior dataset subscription with one for this provider.
      dataSourceSub?.dispose();
      dataSourceSub = host.dataProviders.onDidChange(providerId, (revision) => {
        if (state.dataSource?.providerId !== providerId) return;
        if (revision === state.dataSource.revision) return;
        if (state.dataSource.live) {
          // Live (the object-model wave): re-pull now.
          void repullDataset(providerId);
          return;
        }
        state.dataSource = { ...state.dataSource, stale: true };
        host.log.info(
          `dataset "${providerId}" updated (revision ${revision}) — ` +
            "re-source to refresh (no auto-refetch, §1.1)",
        );
        emitter.emit();
      });

      // The seeded workbook is document content: persist it like an edit.
      markEdited();
      emitter.emit();
    },

    textSelectionRange() {
      if (!state.engine || state.activeSheet === null) return null;
      const sel = state.gridSelection;
      if (sel) {
        return {
          sheet: state.activeSheet,
          range: selectionRangeA1(
            sel.anchorRow,
            sel.anchorCol,
            sel.rows,
            sel.cols,
          ),
        };
      }
      // No cell picked yet — the panels are about the ENTERED frame's
      // whole projected range. Keyed on the frame the in-frame grid is
      // showing, not on "the last thing lowered": with two sheet frames
      // on the page, the last-lowered one is the WRONG answer for the
      // one you double-clicked.
      const entered = lastFrameId ? loweredTables.get(lastFrameId) : null;
      if (entered) return { sheet: entered.sheet, range: entered.range };
      if (state.selectedRange)
        return { sheet: state.activeSheet, range: state.selectedRange };
      return null;
    },

    saveWorkbook() {
      if (!state.engine) {
        host.log.warn("saveWorkbook: no workbook");
        return null;
      }
      try {
        const bytes = state.engine.saveXlsx();
        const kind = state.engine.workbookKind?.() ?? "xlsx";
        return { bytes, fileName: `${baseName()}.${kind}` };
      } catch (err) {
        host.log.error("saveWorkbook: engine save failed", err);
        return null;
      }
    },

    saveWorkbookAs(kind) {
      const e = state.engine;
      if (!e) return null;
      try {
        const bytes = e.saveAs ? e.saveAs(kind) : e.saveXlsx();
        return { bytes, fileName: `${baseName()}.${kind}` };
      } catch (err) {
        host.log.error(`saveWorkbookAs(${kind}) failed`, err);
        return null;
      }
    },

    exportCsv(opts) {
      const e = state.engine;
      const sheet = state.activeSheet;
      if (!e?.exportCsv || sheet === null) return null;
      try {
        const text = e.exportCsv(sheet, opts);
        const sheetName =
          e.listSheets().find((s) => s.id === sheet)?.name ?? "Sheet1";
        const many = e.listSheets().length > 1;
        const name = many ? `${baseName()} - ${sheetName}` : baseName();
        return { bytes: csvBytes(text), fileName: `${name}.csv` };
      } catch (err) {
        host.log.error("exportCsv failed", err);
        return null;
      }
    },

    formulaDisplay() {
      const e = dialectEngine();
      if (!e?.formulaDisplay) return null;
      try {
        return e.formulaDisplay();
      } catch {
        return null;
      }
    },

    setFormulaDisplay(opts) {
      if (opts.lang !== undefined) formulaLang = opts.lang;
      const e = dialectEngine();
      if (!e?.setFormulaDisplay || !e.formulaDisplay) return false;
      try {
        const before = e.formulaDisplay().r1c1;
        const r1c1 = opts.r1c1 ?? before;
        e.setFormulaDisplay(r1c1, formulaLang);
        dialectSeen = null; // learn it again
        // The reference style lives in the workbook: an edit to save.
        if (r1c1 !== before) markEdited();
        emitter.emit();
        return true;
      } catch (err) {
        host.log.warn("setFormulaDisplay failed", err);
        return false;
      }
    },

    flushPlacementRecords() {
      return flushPlacementRecords().catch((err) => {
        host.log.warn("placement records failed", err);
      });
    },

    flushPersist() {
      return flushPersist().catch((err) => {
        host.log.warn("workbook persist failed", err);
      });
    },

    async paginateSelection(opts) {
      const engine = state.engine;
      if (!engine || state.activeSheet === null || !state.selectedRange) {
        return { ok: false as const, message: "no workbook / sheet / range" };
      }
      const selected = host.selection
        .get()
        .find((id) => id.kind === "textFrame");
      const frameId =
        opts?.frameId ?? (selected ? (selected.id as string) : lastFrameId);
      if (!frameId) {
        return {
          ok: false as const,
          message: "select a text frame of the chain to paginate into",
        };
      }
      const storyId = await storyOfFrame(host, frameId);
      if (!storyId) {
        return {
          ok: false as const,
          message: "the selected frame has no story",
        };
      }
      const sheet = state.activeSheet;
      const range: string | readonly string[] =
        opts?.areas && opts.areas.length > 0
          ? [...opts.areas]
          : state.selectedRange;
      // Re-paginating the same chain replaces the old placement's handle
      // (its tables are refreshed by the new pass, not duplicated).
      const prior = chains.get(storyId);
      const from = prior?.sub.current() ?? null;
      prior?.sub.dispose();
      const repeatedHeaderRows =
        opts?.repeatHeaderRows ?? chainHeaderRows.get(storyId) ?? 0;
      chainHeaderRows.set(storyId, repeatedHeaderRows);
      const first = from
        ? null
        : await lowerPaginatedToChain(host, engine, sheet, range, storyId, {
            repeatedHeaderRows,
          });
      if (!from && !first) {
        return { ok: false as const, message: "the frame threads no chain" };
      }
      const sub = subscribeChainReflow(host, engine, sheet, range, storyId, {
        from: from ?? first,
        repeatedHeaderRows,
      });
      chains.set(storyId, { sub, sheet, range });
      if (from) await sub.refresh();
      return { ok: true as const };
    },

    refreshPlacements() {
      return refreshPlacements();
    },

    async newWorkbook() {
      let engine: SheetEngine;
      try {
        engine = await bootEmptyEngine();
        state.bootError = null;
      } catch (err) {
        state.bootError = err instanceof Error ? err.message : ENGINE_NOT_BUILT;
        host.log.warn("newWorkbook: engine boot failed", err);
        emitter.emit();
        return;
      }
      adoptWorkbook(engine, "Book1.xlsx");
      await adoptWithDocStyles();
    },

    async importOds(bytes, name) {
      let engine: SheetEngine;
      try {
        engine = await bootEmptyEngine();
        state.bootError = null;
      } catch (err) {
        state.bootError = err instanceof Error ? err.message : ENGINE_NOT_BUILT;
        host.log.warn("importOds: engine boot failed", err);
        emitter.emit();
        return;
      }
      const base = name.replace(/\.[^.]*$/, "");
      try {
        if (!engine.loadOds) throw new Error("engine wasm predates load_ods");
        engine.loadOds(bytes);
      } catch (err) {
        host.log.error("OpenDocument import failed", err);
        engine.dispose();
        return;
      }
      adoptWorkbook(engine, `${base}.xlsx`);
    },

    async importCsv(text, name) {
      let engine: SheetEngine;
      try {
        engine = await bootEmptyEngine();
        state.bootError = null;
      } catch (err) {
        state.bootError = err instanceof Error ? err.message : ENGINE_NOT_BUILT;
        host.log.warn("importCsv: engine boot failed", err);
        emitter.emit();
        return;
      }
      const base = name.replace(/\.[^.]*$/, "");
      const delimiter = /\.tsv$/i.test(name) ? "\t" : "";
      const locale =
        (typeof navigator !== "undefined" && navigator.language) || "en-US";
      try {
        if (!engine.loadCsv) throw new Error("engine wasm predates load_csv");
        engine.loadCsv(text, delimiter, locale, base);
      } catch (err) {
        host.log.error("CSV import failed", err);
        engine.dispose();
        return;
      }
      adoptWorkbook(engine, `${base}.xlsx`);
      await adoptWithDocStyles();
    },

    addSheet(name) {
      let id = -1;
      const r = structureVerb((e) => {
        if (!e.addSheet) throw new Error("engine wasm predates add_sheet");
        id = e.addSheet(name ?? "");
      });
      if (r.ok) {
        state.activeSheet = id;
        state.gridSelection = null;
        defaultRangeForActive();
        emitter.emit();
      }
      return r;
    },

    renameSheet(id, name) {
      return structureVerb((e) => {
        if (!e.renameSheet)
          throw new Error("engine wasm predates rename_sheet");
        e.renameSheet(id, name);
      });
    },

    deleteSheet(id) {
      const r = structureVerb((e) => {
        if (!e.deleteSheet)
          throw new Error("engine wasm predates delete_sheet");
        e.deleteSheet(id);
      });
      if (r.ok) {
        // Sheet ids shifted; the journal and placements on that sheet are moot.
        editJournal = [];
        journalCursor = 0;
        for (const [k, info] of [...loweredTables]) {
          if (info.sheet === id) loweredTables.delete(k);
          else if (info.sheet > id)
            loweredTables.set(k, { ...info, sheet: info.sheet - 1 });
        }
        state.activeSheet = 0;
        state.gridSelection = null;
        defaultRangeForActive();
        emitter.emit();
      }
      return r;
    },

    structuralEdit(kind) {
      const sel = state.gridSelection;
      if (state.activeSheet === null) {
        return { ok: false as const, message: "no sheet" };
      }
      if (!sel) {
        return {
          ok: false as const,
          message: "select the rows or columns first",
        };
      }
      const rows = kind === "insertRows" || kind === "deleteRows";
      const at = rows ? sel.anchorRow : sel.anchorCol;
      const n = Math.max(1, rows ? sel.rows : sel.cols);
      const sheet = state.activeSheet;
      const r = structureVerb((e) => {
        if (!e.structuralEdit)
          throw new Error("engine wasm predates structural_edit");
        e.structuralEdit(sheet, kind, at, n);
      });
      if (r.ok) {
        // The undo journal addresses cells by position — they moved.
        editJournal = [];
        journalCursor = 0;
        defaultRangeForActive();
        emitter.emit();
      }
      return r;
    },

    calcSettings() {
      const engine = state.engine;
      if (!engine) return null;
      return cachedRead("calcSettings", () => {
        try {
          return engine.calcSettings?.() ?? null;
        } catch {
          return null;
        }
      });
    },

    setIterative(on) {
      return structureVerb((e) => {
        const cur = e.calcSettings?.();
        if (!e.setIterative || !cur)
          throw new Error("engine wasm predates set_iterative");
        e.setIterative(on, cur.maxIter, cur.maxChange);
      });
    },

    contentVersion() {
      return revision;
    },

    // ── Wave 6 ───────────────────────────────────────────────────────

    formatTarget() {
      return formatTarget();
    },

    setStyle(patch) {
      const t = formatTarget();
      if (!t)
        return {
          ok: false as const,
          message: "select cells or enter a range first",
        };
      if (extraAreas.length > 0) {
        // Every area in one undo step.
        const ranges = [...extraAreas, state.gridSelection!].map((a) =>
          selectionRangeA1(a.anchorRow, a.anchorCol, a.rows, a.cols),
        );
        return journalFormat(
          (e) => {
            const seals = ranges.map((r) => styleSnapshot(e, t.sheet, r));
            if (seals.some((x) => x === null)) return null;
            return () => {
              const steps = seals.map((x) => x!());
              return {
                undo: (x) => steps.forEach((st) => st.undo(x)),
                redo: (x) => steps.forEach((st) => st.redo(x)),
              };
            };
          },
          (e) => {
            if (!e.setStyle) throw new Error("engine wasm predates set_style");
            for (const r of ranges) e.setStyle(t.sheet, r, patch);
          },
        );
      }
      return journalFormat(
        (e) => styleSnapshot(e, t.sheet, t.range),
        (e) => {
          if (!e.setStyle) throw new Error("engine wasm predates set_style");
          e.setStyle(t.sheet, t.range, patch);
        },
      );
    },

    setBorders(kind, edge) {
      const t = formatTarget();
      if (!t)
        return {
          ok: false as const,
          message: "select cells or enter a range first",
        };
      // Pure A1 naming of the block's strips; every border rule is Rust's.
      const a1 = (r0: number, c0: number, r1: number, c1: number) =>
        `${columnLabel(c0)}${r0 + 1}:${columnLabel(c1)}${r1 + 1}`;
      const none: EdgeStyle = { style: "none" };
      const calls: [string, CellStylePatch][] = [];
      const whole = a1(t.top, t.left, t.bottom, t.right);
      const top = a1(t.top, t.left, t.top, t.right);
      const bottom = a1(t.bottom, t.left, t.bottom, t.right);
      const left = a1(t.top, t.left, t.bottom, t.left);
      const right = a1(t.top, t.right, t.bottom, t.right);
      switch (kind) {
        case "all":
          calls.push([
            whole,
            {
              borderTop: edge,
              borderBottom: edge,
              borderLeft: edge,
              borderRight: edge,
            },
          ]);
          break;
        case "none":
          calls.push([
            whole,
            {
              borderTop: none,
              borderBottom: none,
              borderLeft: none,
              borderRight: none,
            },
          ]);
          break;
        case "outline":
          calls.push(
            [top, { borderTop: edge }],
            [bottom, { borderBottom: edge }],
          );
          calls.push(
            [left, { borderLeft: edge }],
            [right, { borderRight: edge }],
          );
          break;
        case "top":
          calls.push([top, { borderTop: edge }]);
          break;
        case "bottom":
          calls.push([bottom, { borderBottom: edge }]);
          break;
        case "left":
          calls.push([left, { borderLeft: edge }]);
          break;
        case "right":
          calls.push([right, { borderRight: edge }]);
          break;
      }
      return journalFormat(
        (e) => styleSnapshot(e, t.sheet, whole),
        (e) => {
          if (!e.setStyle) throw new Error("engine wasm predates set_style");
          for (const [range, patch] of calls) e.setStyle(t.sheet, range, patch);
        },
      );
    },

    styleAtTarget() {
      const t = formatTarget();
      const e = state.engine;
      if (!t || !e?.getStyle) return null;
      return cachedRead(`style:${t.sheet}:${t.top}:${t.left}`, () => {
        try {
          return e.getStyle!(t.sheet, t.top, t.left);
        } catch {
          return null;
        }
      });
    },

    mergeTarget() {
      const t = formatTarget();
      if (!t)
        return {
          ok: false as const,
          message: "select cells or enter a range first",
        };
      return journalFormat(
        (e) => {
          const before = e.getLayout?.(t.sheet).merges ?? null;
          if (!before || !e.unmerge) return null;
          return () => {
            // Merges the new one absorbed come back on undo; the cleared
            // cells come back as the step's cell entries.
            const after = new Set(e.getLayout!(t.sheet).merges);
            const absorbed = before.filter((m) => !after.has(m));
            return {
              undo: (x) => {
                x.unmerge!(t.sheet, t.range);
                for (const m of absorbed) x.merge!(t.sheet, m);
              },
              redo: (x) => {
                x.merge!(t.sheet, t.range);
              },
            };
          };
        },
        (e) => {
          if (!e.merge) throw new Error("engine wasm predates merge");
          return (
            (e.merge(t.sheet, t.range) as { edits?: CellEditRecord[] }).edits ??
            []
          );
        },
      );
    },

    unmergeTarget() {
      const t = formatTarget();
      if (!t)
        return {
          ok: false as const,
          message: "select cells or enter a range first",
        };
      let removed = 0;
      const r = journalFormat(
        (e) => {
          const before = e.getLayout?.(t.sheet).merges ?? null;
          if (!before || !e.merge) return null;
          return () => {
            const after = new Set(e.getLayout!(t.sheet).merges);
            const gone = before.filter((m) => !after.has(m));
            return {
              undo: (x) => {
                for (const m of gone) x.merge!(t.sheet, m);
              },
              redo: (x) => {
                x.unmerge!(t.sheet, t.range);
              },
            };
          };
        },
        (e) => {
          if (!e.unmerge) throw new Error("engine wasm predates unmerge");
          removed = e.unmerge(t.sheet, t.range);
        },
      );
      if (r.ok && removed === 0)
        return { ok: false as const, message: "no merge there" };
      return r;
    },

    setColumnWidth(width) {
      const t = formatTarget();
      if (!t)
        return {
          ok: false as const,
          message: "select cells or enter a range first",
        };
      return journalFormat(
        (e) => sizeStep(e, t.sheet, "col", t.left, t.right, width),
        (e) => {
          if (!e.setColWidth)
            throw new Error("engine wasm predates set_col_width");
          e.setColWidth(t.sheet, t.left, t.right, width);
        },
      );
    },

    setRowHeight(height) {
      const t = formatTarget();
      if (!t)
        return {
          ok: false as const,
          message: "select cells or enter a range first",
        };
      return journalFormat(
        (e) => sizeStep(e, t.sheet, "row", t.top, t.bottom, height),
        (e) => {
          if (!e.setRowHeight)
            throw new Error("engine wasm predates set_row_height");
          e.setRowHeight(t.sheet, t.top, t.bottom, height);
        },
      );
    },

    toggleFreeze() {
      const sheet = state.activeSheet;
      if (sheet === null) return { ok: false as const, message: "no sheet" };
      const cur = this.layout();
      const frozen = !!cur && (cur.freezeRows > 0 || cur.freezeCols > 0);
      const sel = state.gridSelection;
      const rows = frozen ? 0 : sel ? sel.anchorRow : 1;
      const cols = frozen ? 0 : sel ? sel.anchorCol : 0;
      if (!frozen && rows === 0 && cols === 0) {
        return {
          ok: false as const,
          message: "select the cell below / right of the split",
        };
      }
      return journalFormat(
        () => {
          if (!cur) return null;
          return () => ({
            undo: (x) => x.setFreeze!(sheet, cur.freezeRows, cur.freezeCols),
            redo: (x) => x.setFreeze!(sheet, rows, cols),
          });
        },
        (e) => {
          if (!e.setFreeze) throw new Error("engine wasm predates set_freeze");
          e.setFreeze(sheet, rows, cols);
        },
      );
    },

    layout() {
      const e = state.engine;
      const sheet = state.activeSheet;
      if (!e?.getLayout || sheet === null) return null;
      return cachedRead(`layout:${sheet}`, () => {
        try {
          return e.getLayout!(sheet);
        } catch {
          return null;
        }
      });
    },

    names() {
      const e = state.engine;
      if (!e?.listNames) return [];
      return cachedRead("names", () => {
        try {
          return e.listNames!();
        } catch {
          return [];
        }
      });
    },

    defineName(name, refersTo, sheetScoped) {
      const sheet = state.activeSheet;
      if (sheet === null) return { ok: false as const, message: "no sheet" };
      const target = refersTo?.trim() || formatTarget()?.range;
      if (!target)
        return {
          ok: false as const,
          message: "select cells or enter a range first",
        };
      const scope = sheetScoped ? sheet : null;
      return journalFormat(
        (e) =>
          nameStep(e, sheet, name.trim(), scope, () => {
            e.defineName!(sheet, name.trim(), target, scope);
          }),
        (e) => {
          if (!e.defineName)
            throw new Error("engine wasm predates define_name");
          e.defineName(sheet, name.trim(), target, scope);
        },
      );
    },

    deleteName(name, scope) {
      const sheet = state.activeSheet ?? 0;
      return journalFormat(
        (e) =>
          nameStep(e, sheet, name, scope ?? null, () => {
            e.deleteName!(sheet, name, scope ?? null);
          }),
        (e) => {
          if (!e.deleteName)
            throw new Error("engine wasm predates delete_name");
          e.deleteName(sheet, name, scope ?? null);
        },
      );
    },

    async placeName(name) {
      const e = state.engine;
      if (!e?.resolveRange || state.activeSheet === null) return null;
      let resolved: { sheet: number };
      try {
        resolved = e.resolveRange(state.activeSheet, name);
      } catch (err) {
        host.log.warn("placeName: not a name or table", err);
        return null;
      }
      state.activeSheet = resolved.sheet;
      state.selectedRange = name;
      emitter.emit();
      return this.lowerSelection();
    },

    // ── Wave 5 ──────────────────────────────────────────────────────────

    activeCell() {
      const a = activeOf();
      return a ? { ...a } : null;
    },

    selectCell(row, col) {
      applyModel(collapsed({ row, col }));
    },

    extendSelection(row, col) {
      const m = currentModel();
      applyModel(m ? extendTo(m, { row, col }) : collapsed({ row, col }));
    },

    handleGridKey(e) {
      return runGridAction(gridKeyAction(e, cellEdit ? cellEditMode : null));
    },

    pointerDownInFrame(contentX, contentY, mods) {
      if (!lastGridScene) return false;
      const sel = state.gridSelection;
      if (sel && hitFillHandle(lastGridScene, contentX, contentY)) {
        if (cellEdit) commitEdit();
        drag = { kind: "fill", source: sel, target: null };
        return true;
      }
      // Excel — a press on the selection's border grabs it to move.
      if (sel && hitSelectionBorder(lastGridScene, contentX, contentY)) {
        const at = hitCell(lastGridScene, contentX, contentY);
        if (at) {
          if (cellEdit) commitEdit();
          drag = {
            kind: "move",
            source: sel,
            anchor: at,
            target: null,
            copy: !!mods?.copy,
          };
          return true;
        }
      }
      const hit = hitCell(lastGridScene, contentX, contentY);
      if (!hit) return false;
      // A click elsewhere COMMITS the open edit (Excel).
      if (cellEdit) commitEdit();
      const m = currentModel();
      // Ctrl/Cmd-click adds an area (Excel's multi-area selection).
      if (mods?.add && sel) {
        extraAreas = [...extraAreas, sel];
        addingArea = true;
        applyModel(collapsed(hit));
        drag = { kind: "select" };
        return true;
      }
      addingArea = false;
      applyModel(mods?.shift && m ? extendTo(m, hit) : collapsed(hit));
      drag = { kind: "select" };
      return true;
    },

    selectionAreas() {
      const sel = state.gridSelection;
      return sel ? [...extraAreas, sel] : [...extraAreas];
    },

    grabAt(contentX, contentY) {
      if (!lastGridScene) return null;
      if (state.gridSelection) {
        if (hitFillHandle(lastGridScene, contentX, contentY)) return "fill";
        if (hitSelectionBorder(lastGridScene, contentX, contentY))
          return "move";
      }
      return hitCell(lastGridScene, contentX, contentY) ? "cell" : null;
    },

    pointerMoveInFrame(contentX, contentY) {
      if (!drag || !lastGridScene) return false;
      const hit =
        autoScrollHit(contentX, contentY) ??
        hitCell(lastGridScene, contentX, contentY);
      if (!hit) return false;
      if (drag.kind === "move") {
        const d = drag;
        const target: GridSelection = {
          ...d.source,
          anchorRow: Math.max(0, d.source.anchorRow + hit.row - d.anchor.row),
          anchorCol: Math.max(0, d.source.anchorCol + hit.col - d.anchor.col),
        };
        drag = { ...d, target };
        fillPreview = target;
        void submitInFrameGrid();
        return true;
      }
      if (drag.kind === "select") {
        const m = currentModel();
        if (!m || (m.focus.row === hit.row && m.focus.col === hit.col))
          return true;
        applyModel(extendTo(m, hit));
        return true;
      }
      const target = fillTarget(drag.source, hit);
      drag = { ...drag, target };
      fillPreview = target;
      void submitInFrameGrid();
      return true;
    },

    pointerUpInFrame() {
      const d = drag;
      drag = null;
      // The added area is laid out; the next selection change starts over.
      addingArea = false;
      if (!d) return false;
      if (d.kind === "move") {
        fillPreview = null;
        const t = d.target;
        if (
          t &&
          (t.anchorRow !== d.source.anchorRow ||
            t.anchorCol !== d.source.anchorCol)
        ) {
          const r = moveCells(d.source, t, d.copy);
          if (!r.ok) host.log.warn(`move: ${r.message}`);
        } else {
          void submitInFrameGrid();
        }
        return true;
      }
      if (d.kind === "fill") {
        fillPreview = null;
        if (d.target) {
          const r = fillTo(d.source, d.target, true, d.target);
          if (!r.ok) host.log.warn(`fill: ${r.message}`);
        } else {
          void submitInFrameGrid();
        }
      }
      return true;
    },

    scrollInFrame(dRows, dCols) {
      if (!lastGridWindow) return false;
      const firstRow = Math.max(0, lastGridWindow.firstRow + dRows);
      const firstCol = Math.max(0, lastGridWindow.firstCol + dCols);
      if (
        firstRow === lastGridWindow.firstRow &&
        firstCol === lastGridWindow.firstCol
      ) {
        return false;
      }
      lastGridWindow = { ...lastGridWindow, firstRow, firstCol };
      void submitInFrameGrid();
      return true;
    },

    wheelInFrame(dxPt, dyPt) {
      if (!inFrameActive || !lastGridWindow || !lastGridScene) return false;
      const vp = lastGridScene.viewport;
      // One step = the first visible row's height / column's width.
      const rowH = vp.rows > 0 ? vp.yOffsets[1] - vp.yOffsets[0] : 0;
      const colW = vp.cols > 0 ? vp.xOffsets[1] - vp.xOffsets[0] : 0;
      const atTop = lastGridWindow.firstRow === 0;
      const atLeft = lastGridWindow.firstCol === 0;
      // Toward an edge the window is already at: decline (the canvas pans).
      if (
        (dyPt === 0 || (dyPt < 0 && atTop)) &&
        (dxPt === 0 || (dxPt < 0 && atLeft))
      ) {
        wheelCarry = [0, 0];
        return false;
      }
      wheelCarry = [wheelCarry[0] + dxPt, wheelCarry[1] + dyPt];
      const dRows = rowH > 0 ? Math.trunc(wheelCarry[1] / rowH) : 0;
      const dCols = colW > 0 ? Math.trunc(wheelCarry[0] / colW) : 0;
      wheelCarry = [wheelCarry[0] - dCols * colW, wheelCarry[1] - dRows * rowH];
      if (dRows !== 0 || dCols !== 0) api.scrollInFrame(dRows, dCols);
      // A partial step is still the grid's wheel: the canvas stays put.
      return true;
    },

    isInFrameActive() {
      return inFrameActive;
    },

    fillSelectionTo(target, series = true) {
      const sel = state.gridSelection;
      if (!sel) return { ok: false, message: "select the cells to fill from" };
      return fillTo(sel, target, series, target);
    },

    fillDown() {
      return fillAlong("down");
    },

    fillRight() {
      return fillAlong("right");
    },

    clearSelection() {
      return clearSelection();
    },

    findNext(needle, opts, backwards = false) {
      return findNext(
        needle,
        opts ?? { matchCase: false, entireCell: false, inFormulas: false },
        backwards,
      );
    },

    findAgain(backwards = false) {
      if (!lastFind) return null;
      return findNext(lastFind.needle, lastFind.opts, backwards);
    },

    requestFind() {
      state.findRequest += 1;
      emitter.emit();
    },

    dispose() {
      historySub.dispose();
      foreignChangeSub.dispose();
      if (chainTimer !== null) clearTimeout(chainTimer);
      if (styleNoticeTimer !== null) clearTimeout(styleNoticeTimer);
      willSaveSub?.dispose();
      // What the placed tables show, kept for a later session (taken before
      // the placements are forgotten; written in the background).
      void flushPlacementRecords(shownContents()).catch((err) => {
        host.log.warn("placement records on dispose failed", err);
      });
      forgetPlacements();
      // Flush unsaved edits BEFORE the engine is freed: the bytes are
      // taken synchronously here; the write finishes in the background.
      void flushPersist().catch((err) => {
        host.log.warn("workbook persist on dispose failed", err);
      });
      // S-15 — drop the dataset revision subscription.
      try {
        dataSourceSub?.dispose();
      } catch (err) {
        host.log.warn("dataset subscription dispose failed", err);
      }
      dataSourceSub = null;
      // Disposing the scene-layer surface clears any in-frame grid it
      // submitted (the surface tracks + clears on dispose).
      try {
        sceneSurface?.dispose();
      } catch (err) {
        host.log.warn("scene-layer surface dispose failed", err);
      }
      sceneSurface = null;
      try {
        state.engine?.dispose();
      } catch (err) {
        host.log.warn("engine dispose failed", err);
      }
      state.engine = null;
      emitter.clear();
      noticeListeners.clear();
    },
    notice() {
      return lastNotice;
    },
    onNotice(listener) {
      noticeListeners.add(listener);
      return { dispose: () => void noticeListeners.delete(listener) };
    },
  };

  // Copy and paste keep their {ok} answers for the callers; the wrapper
  // also posts each answer as the grid notice (internal callers go through
  // `api`, so the keys and the commands post too).
  let lastNotice: SessionNotice | null = null;
  const noticeListeners = new Set<(n: SessionNotice) => void>();
  const postNotice = (text: string, tone: SessionNotice["tone"]) => {
    lastNotice = { text, tone, seq: (lastNotice?.seq ?? 0) + 1 };
    for (const l of [...noticeListeners]) l(lastNotice);
  };
  const copyImpl = api.copySelection;
  const pasteImpl = api.pasteAtSelection;
  api.copySelection = async () => {
    const r = await copyImpl.call(api);
    if (r.ok)
      postNotice(
        t(NOTICES.copied, {
          rows: r.rows,
          cols: r.cols,
          cells: r.rows * r.cols,
        }),
        "ok",
      );
    else postNotice(t(NOTICES.cantCopy, { reason: r.message }), "error");
    return r;
  };
  api.pasteAtSelection = async (options?: PasteOptions) => {
    const r = await pasteImpl.call(api, options);
    if (r.ok)
      postNotice(
        t(NOTICES.pasted, {
          rows: r.rows,
          cols: r.cols,
          cells: r.rows * r.cols,
        }),
        "ok",
      );
    else postNotice(t(NOTICES.cantPaste, { reason: r.message }), "error");
    return r;
  };
  return api;
}

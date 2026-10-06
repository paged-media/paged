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

// Parametric shape INSERT commands (wave 2) — Arc / Spiral /
// Rectangular grid / Polar grid, lowered through the SAME
// `insertPath` lane every authoring tool uses (draw-geometry
// generators → one insertPath per contour, ONE `batch` = one undo
// step).
//
// PARAMETERS. v0 inserted one FIXED geometry per command and ignored
// its payload — "no parameter UI yet". There is one now (the Path
// Options panel, `panels/path-options-panel.tsx`), so each command
// takes the generator's REAL parameters as its payload:
//
//   insertArc        { cx, cy, rx, ry, startAngleDeg, sweepDeg, closed }
//   insertSpiral     { cx, cy, r0, decay, turns, segmentsPerTurn }
//   insertRectGrid   { x, y, width, height, rows, cols }
//   insertPolarGrid  { cx, cy, r, rings, radials }
//
// Lengths are pt in page space; ANGLES ARE DEGREES (from +x toward +y,
// y down — what a person types; the generators take radians and the
// conversion happens here, once). Every key is optional and falls back
// to the v0 value, so a payload-free call inserts exactly what v0
// inserted. A value the generator cannot draw (a non-positive radius, a
// zero sweep) yields an empty table and the command is a logged no-op —
// never a throw. Counts are clamped to `INSERT_SHAPE_LIMITS`: a typo of
// 10000 rows is a 20 002-op batch, not data.
//
// A grid inserts its lines as INDEPENDENT sibling paths (no group —
// `createGroup` needs the created ids, which a single batch does not
// return per-op; grouping is a follow-up, not faked).
//
// The inserted paths take the document's CREATION DEFAULTS for
// fill/stroke (the same behavior as pen/pencil commits) — no
// defaults juggling needed here because no per-shape style is
// requested.

import type { BundleHost, Disposable, Mutation } from "@paged-media/plugin-api";
import {
  arcPath,
  spiralPath,
  rectGridPaths,
  polarGridPaths,
  type AnchorTable,
} from "@paged-media/draw-geometry";

import { insertPathMutationsForShape, resolveTargetPage } from "../io/svg";

import { registerCommand } from "../command-registry";
export const INSERT_SHAPE_COMMAND_CATEGORY = "Insert";

export const INSERT_ARC_COMMAND_ID = "media.paged.draw.command.insertArc";
export const INSERT_SPIRAL_COMMAND_ID = "media.paged.draw.command.insertSpiral";
export const INSERT_RECT_GRID_COMMAND_ID =
  "media.paged.draw.command.insertRectGrid";
export const INSERT_POLAR_GRID_COMMAND_ID =
  "media.paged.draw.command.insertPolarGrid";

/** The contributed command ids, in registration order. */
export const INSERT_SHAPE_COMMAND_IDS = [
  INSERT_ARC_COMMAND_ID,
  INSERT_SPIRAL_COMMAND_ID,
  INSERT_RECT_GRID_COMMAND_ID,
  INSERT_POLAR_GRID_COMMAND_ID,
];

/** The v0 fixed parameters, in the GENERATORS' units (radians). Still
 *  what a payload-free command inserts; exported so the conformance
 *  spec derives the expected geometry from the same numbers. */
export const INSERT_SHAPE_DEFAULTS = {
  /** A 270° open arc of radius 100 pt centered at (200, 200). */
  arc: { cx: 200, cy: 200, rx: 100, ry: 100, startAngle: 0, sweep: 1.5 * Math.PI },
  /** Three inward turns from 100 pt, 20% decay per turn, 8 seg/turn. */
  spiral: { cx: 200, cy: 200, r0: 100, decay: 0.8, turns: 3, segmentsPerTurn: 8 },
  /** A 4×4-cell grid in [100,100]..[300,300] → 5 + 5 = 10 lines. */
  rectGrid: { bounds: [100, 100, 300, 300] as [number, number, number, number], rows: 4, cols: 4 },
  /** 3 rings + 6 radials of radius 100 pt at (200, 200) → 9 paths. */
  polarGrid: { cx: 200, cy: 200, r: 100, rings: 3, radials: 6 },
} as const;

// --------------------------------------------------------- parameters
// The PAYLOAD shapes (the units a person types), their defaults — the
// v0 geometry above, restated in those units — and the count ceilings.

export interface ArcParams {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  /** Degrees from +x toward +y (y down). */
  startAngleDeg: number;
  /** Signed degrees; |sweep| is clamped to a full turn by the generator. */
  sweepDeg: number;
  /** Close the contour with the straight CHORD back to the start. */
  closed: boolean;
}

export interface SpiralParams {
  cx: number;
  cy: number;
  /** Starting radius, pt. */
  r0: number;
  /** Radius multiplier per full turn (`< 1` winds inward). */
  decay: number;
  turns: number;
  segmentsPerTurn: number;
}

export interface RectGridParams {
  /** Left edge, pt. */
  x: number;
  /** Top edge, pt. */
  y: number;
  width: number;
  height: number;
  /** CELL counts — `rows + 1` horizontal and `cols + 1` vertical lines. */
  rows: number;
  cols: number;
}

export interface PolarGridParams {
  cx: number;
  cy: number;
  /** Outermost ring's radius, pt. */
  r: number;
  /** Concentric circles (0 omits them). */
  rings: number;
  /** Spokes from the centre to the rim (0 omits them). */
  radials: number;
}

export const ARC_PARAM_DEFAULTS: ArcParams = {
  cx: 200,
  cy: 200,
  rx: 100,
  ry: 100,
  startAngleDeg: 0,
  sweepDeg: 270,
  closed: false,
};

export const SPIRAL_PARAM_DEFAULTS: SpiralParams = {
  cx: 200,
  cy: 200,
  r0: 100,
  decay: 0.8,
  turns: 3,
  segmentsPerTurn: 8,
};

export const RECT_GRID_PARAM_DEFAULTS: RectGridParams = {
  x: 100,
  y: 100,
  width: 200,
  height: 200,
  rows: 4,
  cols: 4,
};

export const POLAR_GRID_PARAM_DEFAULTS: PolarGridParams = {
  cx: 200,
  cy: 200,
  r: 100,
  rings: 3,
  radials: 6,
};

/** Count ceilings. A grid is one insertPath PER LINE in one batch, and a
 *  spiral one anchor per segment — so a count is bounded, and a typed
 *  one above the ceiling is clamped to it rather than sent. */
export const INSERT_SHAPE_LIMITS = {
  /** rows / cols / rings / radials. */
  maxCount: 200,
  maxTurns: 50,
  maxSegmentsPerTurn: 64,
} as const;

/** A command payload: the keys above, each optional. */
export type InsertShapePayload = Record<string, unknown> | undefined;
type Payload = InsertShapePayload;

const num = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

const bool = (v: unknown, fallback: boolean): boolean =>
  typeof v === "boolean" ? v : fallback;

/** A whole count in `min..max` (a fractional one is floored, as the
 *  generators floor it). */
const count = (v: unknown, fallback: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.floor(num(v, fallback))));

const DEG = Math.PI / 180;

/** The arc a payload describes — each absent or non-finite key is the
 *  default's. Pure; exported for the panel and the conformance spec. */
export function arcParamsFrom(payload?: Payload): ArcParams {
  const d = ARC_PARAM_DEFAULTS;
  return {
    cx: num(payload?.cx, d.cx),
    cy: num(payload?.cy, d.cy),
    rx: num(payload?.rx, d.rx),
    ry: num(payload?.ry, d.ry),
    startAngleDeg: num(payload?.startAngleDeg, d.startAngleDeg),
    sweepDeg: num(payload?.sweepDeg, d.sweepDeg),
    closed: bool(payload?.closed, d.closed),
  };
}

export function spiralParamsFrom(payload?: Payload): SpiralParams {
  const d = SPIRAL_PARAM_DEFAULTS;
  return {
    cx: num(payload?.cx, d.cx),
    cy: num(payload?.cy, d.cy),
    r0: num(payload?.r0, d.r0),
    decay: num(payload?.decay, d.decay),
    turns: Math.min(INSERT_SHAPE_LIMITS.maxTurns, num(payload?.turns, d.turns)),
    segmentsPerTurn: count(
      payload?.segmentsPerTurn,
      d.segmentsPerTurn,
      2,
      INSERT_SHAPE_LIMITS.maxSegmentsPerTurn,
    ),
  };
}

export function rectGridParamsFrom(payload?: Payload): RectGridParams {
  const d = RECT_GRID_PARAM_DEFAULTS;
  return {
    x: num(payload?.x, d.x),
    y: num(payload?.y, d.y),
    width: num(payload?.width, d.width),
    height: num(payload?.height, d.height),
    rows: count(payload?.rows, d.rows, 1, INSERT_SHAPE_LIMITS.maxCount),
    cols: count(payload?.cols, d.cols, 1, INSERT_SHAPE_LIMITS.maxCount),
  };
}

export function polarGridParamsFrom(payload?: Payload): PolarGridParams {
  const d = POLAR_GRID_PARAM_DEFAULTS;
  return {
    cx: num(payload?.cx, d.cx),
    cy: num(payload?.cy, d.cy),
    r: num(payload?.r, d.r),
    rings: count(payload?.rings, d.rings, 0, INSERT_SHAPE_LIMITS.maxCount),
    radials: count(payload?.radials, d.radials, 0, INSERT_SHAPE_LIMITS.maxCount),
  };
}

// ----------------------------------------------------------- geometry
// Exported so the conformance spec asserts the EXACT tables the live
// commands lower (no second copy to drift from).

export function arcDefaultTable(): AnchorTable {
  const p = INSERT_SHAPE_DEFAULTS.arc;
  return arcPath(p.cx, p.cy, p.rx, p.ry, p.startAngle, p.sweep);
}

export function spiralDefaultTable(): AnchorTable {
  const p = INSERT_SHAPE_DEFAULTS.spiral;
  return spiralPath(p.cx, p.cy, p.r0, p.decay, p.turns, p.segmentsPerTurn);
}

export function rectGridDefaultTables(): AnchorTable[] {
  const p = INSERT_SHAPE_DEFAULTS.rectGrid;
  return rectGridPaths(p.bounds, p.rows, p.cols);
}

export function polarGridDefaultTables(): AnchorTable[] {
  const p = INSERT_SHAPE_DEFAULTS.polarGrid;
  return polarGridPaths(p.cx, p.cy, p.r, p.rings, p.radials);
}

/** The table(s) a payload asks for. NO payload is the v0 table computed
 *  from the v0 numbers — not the defaults round-tripped through degrees,
 *  which is the same arc to the last bit only by luck. */
export function arcTablesFor(payload?: Payload): AnchorTable[] {
  if (payload === undefined) return [arcDefaultTable()];
  const p = arcParamsFrom(payload);
  return [
    arcPath(
      p.cx,
      p.cy,
      p.rx,
      p.ry,
      p.startAngleDeg * DEG,
      p.sweepDeg * DEG,
      p.closed,
    ),
  ];
}

export function spiralTablesFor(payload?: Payload): AnchorTable[] {
  if (payload === undefined) return [spiralDefaultTable()];
  const p = spiralParamsFrom(payload);
  return [spiralPath(p.cx, p.cy, p.r0, p.decay, p.turns, p.segmentsPerTurn)];
}

export function rectGridTablesFor(payload?: Payload): AnchorTable[] {
  if (payload === undefined) return rectGridDefaultTables();
  const p = rectGridParamsFrom(payload);
  // `rectGridPaths` takes `[top, left, bottom, right]`.
  return rectGridPaths(
    [p.y, p.x, p.y + p.height, p.x + p.width],
    p.rows,
    p.cols,
  );
}

export function polarGridTablesFor(payload?: Payload): AnchorTable[] {
  if (payload === undefined) return polarGridDefaultTables();
  const p = polarGridParamsFrom(payload);
  return polarGridPaths(p.cx, p.cy, p.r, p.rings, p.radials);
}

/** ONE `batch` inserting every contour of every table (grids = one
 *  insertPath per line, batched — one undo step). Null when the tables
 *  are empty. */
export function insertTablesMutationFor(
  pageId: string,
  tables: readonly AnchorTable[],
): Mutation | null {
  const ops: Mutation[] = [];
  for (const table of tables) {
    ops.push(...insertPathMutationsForShape(pageId, table));
  }
  if (ops.length === 0) return null;
  return { op: "batch", args: { ops } };
}

// ----------------------------------------------------------- appliers

/** Insert `tables` on the target page as ONE batch. Answers whether the
 *  engine applied it (false for no page, degenerate geometry, or a
 *  refusal — each logged). */
async function applyInsertShape(
  host: BundleHost,
  commandId: string,
  tables: readonly AnchorTable[],
): Promise<boolean> {
  const pageId = await resolveTargetPage(host);
  if (!pageId) {
    host.log.debug(`${commandId}: no target page — no-op`);
    return false;
  }
  const mutation = insertTablesMutationFor(pageId, tables);
  if (!mutation) {
    host.log.debug(`${commandId}: degenerate geometry — no-op`);
    return false;
  }
  const outcome = await host.document.mutate(mutation);
  if (!outcome.applied) {
    host.log.warn(
      `${commandId} rejected by engine: ${JSON.stringify(outcome.error)}`,
    );
  }
  return outcome.applied;
}

/** Insert an arc. Payload `{ cx?, cy?, rx?, ry?, startAngleDeg?,
 *  sweepDeg?, closed? }`; none = the v0 arc. */
export function applyInsertArc(host: BundleHost, payload?: Payload): Promise<boolean> {
  return applyInsertShape(host, INSERT_ARC_COMMAND_ID, arcTablesFor(payload));
}

/** Insert a spiral. Payload `{ cx?, cy?, r0?, decay?, turns?,
 *  segmentsPerTurn? }`. */
export function applyInsertSpiral(host: BundleHost, payload?: Payload): Promise<boolean> {
  return applyInsertShape(host, INSERT_SPIRAL_COMMAND_ID, spiralTablesFor(payload));
}

/** Insert a rectangular grid. Payload `{ x?, y?, width?, height?,
 *  rows?, cols? }`. */
export function applyInsertRectGrid(host: BundleHost, payload?: Payload): Promise<boolean> {
  return applyInsertShape(
    host,
    INSERT_RECT_GRID_COMMAND_ID,
    rectGridTablesFor(payload),
  );
}

/** Insert a polar grid. Payload `{ cx?, cy?, r?, rings?, radials? }`. */
export function applyInsertPolarGrid(host: BundleHost, payload?: Payload): Promise<boolean> {
  return applyInsertShape(
    host,
    INSERT_POLAR_GRID_COMMAND_ID,
    polarGridTablesFor(payload),
  );
}

/** Where a command's parameters come from when it is run with NO
 *  payload — the values last applied from the Path Options panel
 *  (`commands/path-options.ts`). Absent, or answering `undefined`, a
 *  payload-free run inserts the v0 geometry. */
export interface InsertShapeLastUsed {
  arc?(): Payload;
  spiral?(): Payload;
  rectGrid?(): Payload;
  polarGrid?(): Payload;
}

/** Register the four insert-shape commands (the dash-command pattern);
 *  a payload rides through to the applier, and a payload-free run takes
 *  `lastUsed` when there is one. */
export function contributeInsertShapeCommands(
  host: BundleHost,
  lastUsed: InsertShapeLastUsed = {},
): Disposable {
  const disposers = [
    registerCommand(host, {
      id: INSERT_ARC_COMMAND_ID,
      title: "Insert: Arc (last used values)",
      category: INSERT_SHAPE_COMMAND_CATEGORY,
      handler: (_paged, payload) =>
        applyInsertArc(host, (payload as Payload) ?? lastUsed.arc?.()),
    }),
    registerCommand(host, {
      id: INSERT_SPIRAL_COMMAND_ID,
      title: "Insert: Spiral (last used values)",
      category: INSERT_SHAPE_COMMAND_CATEGORY,
      handler: (_paged, payload) =>
        applyInsertSpiral(host, (payload as Payload) ?? lastUsed.spiral?.()),
    }),
    registerCommand(host, {
      id: INSERT_RECT_GRID_COMMAND_ID,
      title: "Insert: Rectangular grid (last used values)",
      category: INSERT_SHAPE_COMMAND_CATEGORY,
      handler: (_paged, payload) =>
        applyInsertRectGrid(host, (payload as Payload) ?? lastUsed.rectGrid?.()),
    }),
    registerCommand(host, {
      id: INSERT_POLAR_GRID_COMMAND_ID,
      title: "Insert: Polar grid (last used values)",
      category: INSERT_SHAPE_COMMAND_CATEGORY,
      handler: (_paged, payload) =>
        applyInsertPolarGrid(host, (payload as Payload) ?? lastUsed.polarGrid?.()),
    }),
  ];
  return {
    dispose() {
      for (const d of disposers) d.dispose();
    },
  };
}

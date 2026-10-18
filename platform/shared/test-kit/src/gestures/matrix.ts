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

// The GESTURE MATRIX: every registered tool × modifier set × zoom ×
// target type, with the expected outcome of each cell in a committed
// table (the editor's `tests/e2e/gesture-matrix.json`).
//
// The table is written compactly — per tool, rows that may use `*` for
// the modifiers or the target and list the zooms they hold at — and
// EXPANDED here into cells. A tool the table lists as `unspecified`, a
// tool it does not list at all, and a cell no row covers are all
// `unspecified` cells: they are counted, so the coverage of the matrix
// is visible (`matrixCoverage`), and the registry check fails when a
// registered tool is missing from the table or the table names a tool
// that is no longer registered.
//
// A row with `known: "<finding id>"` is a cell the product gets wrong
// today; its test is an expected failure that flips when the finding is
// fixed.

export const MATRIX_MODIFIERS = [
  "none",
  "shift",
  "alt",
  "shift+alt",
  "cmd",
] as const;
export const MATRIX_ZOOMS = [0.25, 1, 4] as const;
export const MATRIX_TARGETS = [
  "empty",
  "frame",
  "group",
  "rotated",
  "locked",
  "master",
] as const;

export type MatrixModifier = (typeof MATRIX_MODIFIERS)[number];
export type MatrixZoom = (typeof MATRIX_ZOOMS)[number];
export type MatrixTarget = (typeof MATRIX_TARGETS)[number];

/** What a cell's gesture does to the document. */
export type MatrixOutcome =
  /** A new element of `kind` appears; `shape` says how the drag box
   *  maps to its bounds (`box`, `square`, `from-centre`,
   *  `square-from-centre`, `segment`, `45deg`, `path`). */
  | {
      creates: "rectangle" | "oval" | "polygon" | "graphicLine" | "textFrame";
      shape: string;
    }
  /** The target follows the drag (`axis`: Shift's constraint). */
  | { moves: "target" | "child"; constraint?: "axis" }
  /** A copy of the target lands where the drag ended. */
  | { duplicates: "target"; constraint?: "axis" }
  /** The target turns (`snap`: degrees it snaps to). */
  | { rotates: "target"; snap?: number }
  /** The target scales (`uniform`: aspect kept). */
  | { scales: "target"; uniform?: boolean }
  /** The document does not change (a marquee, a refused or empty gesture). */
  | { unchanged: "marquee" | "refused" | "no-target" };

/** How the cell's gesture is performed. */
export type MatrixGesture =
  /** Press on the target point and drag by the matrix's screen vector. */
  | "drag"
  /** Select the target first, then drag from beside it (transform tools). */
  | "select-then-drag"
  /** Click three points around the target, then Enter (the Pen). */
  | "pen-path";

export interface MatrixRow {
  mods: MatrixModifier | "*";
  target: MatrixTarget | "*";
  /** The zooms the row holds at (default: every zoom). */
  zooms?: readonly MatrixZoom[];
  expect: MatrixOutcome;
  /** The finding this cell regresses on: an expected failure today. */
  known?: string;
  note?: string;
}

export interface MatrixTool {
  tool: string;
  gesture?: MatrixGesture;
  /** Why the tool has no rows yet (all its cells are unspecified). */
  unspecified?: string;
  rows?: readonly MatrixRow[];
}

export interface GestureMatrix {
  version: 1;
  /** The drag every cell performs, in SCREEN px (so a cell exercises the
   *  same hand movement at every zoom — INV-6). */
  dragPx: readonly [number, number];
  tools: readonly MatrixTool[];
}

export interface MatrixCell {
  tool: string;
  gesture: MatrixGesture;
  mods: MatrixModifier;
  zoom: MatrixZoom;
  target: MatrixTarget;
  /** `null` = unspecified. */
  expect: MatrixOutcome | null;
  known?: string;
  note?: string;
}

/** A stable id for a cell, for test titles and reports. */
export const cellId = (
  c: Pick<MatrixCell, "tool" | "mods" | "zoom" | "target">,
) => `${c.tool} ${c.mods} @${c.zoom * 100}% on ${c.target}`;

/** The row that covers a cell: an exact modifier + target match beats a
 *  wildcard on one axis, which beats a double wildcard. */
function rowFor(
  rows: readonly MatrixRow[],
  mods: MatrixModifier,
  zoom: MatrixZoom,
  target: MatrixTarget,
) {
  let best: { row: MatrixRow; score: number } | null = null;
  for (const row of rows) {
    if (row.mods !== "*" && row.mods !== mods) continue;
    if (row.target !== "*" && row.target !== target) continue;
    if (row.zooms && !row.zooms.includes(zoom)) continue;
    const score = (row.mods === "*" ? 0 : 2) + (row.target === "*" ? 0 : 1);
    if (!best || score > best.score) best = { row, score };
  }
  return best?.row ?? null;
}

/** Check the table's shape; throws on the first problem. */
export function validateMatrix(m: GestureMatrix): GestureMatrix {
  if (m.version !== 1) throw new Error("gesture matrix: version must be 1");
  const seen = new Set<string>();
  for (const t of m.tools) {
    if (seen.has(t.tool))
      throw new Error(`gesture matrix: ${t.tool} is listed twice`);
    seen.add(t.tool);
    if (t.unspecified !== undefined && t.rows?.length) {
      throw new Error(
        `gesture matrix: ${t.tool} has rows and is marked unspecified`,
      );
    }
    if (t.unspecified === undefined && !t.rows?.length) {
      throw new Error(
        `gesture matrix: ${t.tool} has no rows; mark it unspecified with a reason`,
      );
    }
    for (const r of t.rows ?? []) {
      if (r.mods !== "*" && !MATRIX_MODIFIERS.includes(r.mods))
        throw new Error(`gesture matrix: ${t.tool}: modifier ${r.mods}`);
      if (r.target !== "*" && !MATRIX_TARGETS.includes(r.target))
        throw new Error(`gesture matrix: ${t.tool}: target ${r.target}`);
      for (const z of r.zooms ?? []) {
        if (!MATRIX_ZOOMS.includes(z))
          throw new Error(`gesture matrix: ${t.tool}: zoom ${z}`);
      }
    }
  }
  return m;
}

/** Every cell of the matrix for `toolIds` (default: the table's tools). */
export function expandMatrix(
  m: GestureMatrix,
  toolIds?: readonly string[],
): MatrixCell[] {
  const byTool = new Map(m.tools.map((t) => [t.tool, t]));
  const out: MatrixCell[] = [];
  for (const tool of toolIds ?? m.tools.map((t) => t.tool)) {
    const t = byTool.get(tool);
    for (const mods of MATRIX_MODIFIERS) {
      for (const zoom of MATRIX_ZOOMS) {
        for (const target of MATRIX_TARGETS) {
          const row = t?.rows ? rowFor(t.rows, mods, zoom, target) : null;
          out.push({
            tool,
            gesture: t?.gesture ?? "drag",
            mods,
            zoom,
            target,
            expect: row?.expect ?? null,
            ...(row?.known ? { known: row.known } : {}),
            ...(row?.note ? { note: row.note } : {}),
          });
        }
      }
    }
  }
  return out;
}

export interface MatrixCoverage {
  tools: number;
  cells: number;
  specified: number;
  unspecified: number;
  /** Specified cells expected to fail today (a finding). */
  knownFailing: number;
  /** Registered tools the table does not list. */
  missingTools: string[];
  /** Tools the table lists that are not registered. */
  staleTools: string[];
  perTool: Array<{ tool: string; specified: number; cells: number }>;
}

/** The coverage of the matrix against the registered tools. */
export function matrixCoverage(
  m: GestureMatrix,
  registered: readonly string[],
): MatrixCoverage {
  const listed = new Set(m.tools.map((t) => t.tool));
  const reg = new Set(registered);
  const cells = expandMatrix(m, registered);
  const perTool = registered.map((tool) => {
    const mine = cells.filter((c) => c.tool === tool);
    return {
      tool,
      cells: mine.length,
      specified: mine.filter((c) => c.expect).length,
    };
  });
  const specified = cells.filter((c) => c.expect).length;
  return {
    tools: registered.length,
    cells: cells.length,
    specified,
    unspecified: cells.length - specified,
    knownFailing: cells.filter((c) => c.expect && c.known).length,
    missingTools: registered.filter((t) => !listed.has(t)),
    staleTools: [...listed].filter((t) => !reg.has(t)),
    perTool,
  };
}

/** The modifier names a cell holds, for the gesture DSL. */
export function matrixModifierKeys(
  mods: MatrixModifier,
): Array<"shift" | "alt" | "cmd"> {
  if (mods === "none") return [];
  return mods.split("+") as Array<"shift" | "alt" | "cmd">;
}

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
// v0 SCOPE (documented, deliberate): each command inserts a FIXED
// default geometry near the page origin — commands, not drag tools,
// and no parameter UI yet (the payload lane exists on
// `host.contribute.command` when a host wants to drive parameters;
// v0 ignores it to stay honest about what's built). A grid inserts
// its lines as INDEPENDENT sibling paths (no group — `createGroup`
// needs the created ids, which a single batch does not return
// per-op; grouping is a follow-up, not faked).
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

/** The v0 fixed parameters (near the page origin; see the header's
 *  scope note). Exported so the conformance spec derives the expected
 *  geometry from the same numbers. */
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

// -------------------------------------------------- default geometry
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

// ------------------------------------------------------------ applier

async function applyInsertShape(
  host: BundleHost,
  commandId: string,
  tables: readonly AnchorTable[],
): Promise<void> {
  const pageId = await resolveTargetPage(host);
  if (!pageId) {
    host.log.debug(`${commandId}: no target page — no-op`);
    return;
  }
  const mutation = insertTablesMutationFor(pageId, tables);
  if (!mutation) {
    host.log.debug(`${commandId}: degenerate geometry — no-op`);
    return;
  }
  const outcome = await host.document.mutate(mutation);
  if (!outcome.applied) {
    host.log.warn(
      `${commandId} rejected by engine: ${JSON.stringify(outcome.error)}`,
    );
  }
}

/** Register the four insert-shape commands (the dash-command pattern). */
export function contributeInsertShapeCommands(host: BundleHost): Disposable {
  const disposers = [
    host.contribute.command({
      id: INSERT_ARC_COMMAND_ID,
      title: "Insert: Arc",
      category: INSERT_SHAPE_COMMAND_CATEGORY,
      handler: () => applyInsertShape(host, INSERT_ARC_COMMAND_ID, [arcDefaultTable()]),
    }),
    host.contribute.command({
      id: INSERT_SPIRAL_COMMAND_ID,
      title: "Insert: Spiral",
      category: INSERT_SHAPE_COMMAND_CATEGORY,
      handler: () =>
        applyInsertShape(host, INSERT_SPIRAL_COMMAND_ID, [spiralDefaultTable()]),
    }),
    host.contribute.command({
      id: INSERT_RECT_GRID_COMMAND_ID,
      title: "Insert: Rectangular grid",
      category: INSERT_SHAPE_COMMAND_CATEGORY,
      handler: () =>
        applyInsertShape(host, INSERT_RECT_GRID_COMMAND_ID, rectGridDefaultTables()),
    }),
    host.contribute.command({
      id: INSERT_POLAR_GRID_COMMAND_ID,
      title: "Insert: Polar grid",
      category: INSERT_SHAPE_COMMAND_CATEGORY,
      handler: () =>
        applyInsertShape(host, INSERT_POLAR_GRID_COMMAND_ID, polarGridDefaultTables()),
    }),
  ];
  return {
    dispose() {
      for (const d of disposers) d.dispose();
    },
  };
}

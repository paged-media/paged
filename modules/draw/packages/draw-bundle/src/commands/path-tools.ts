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

// THE JOIN TOOL, THE PATH ERASER and THE RESHAPE TOOL — what each
// gesture does to the document, and the three as typed commands with the
// gesture given as data (`cut-commands.ts`'s pattern), so a script and
// the CLI reach them and the specs drive exactly the tool's code. Each is
// ONE batch: one undo step.
//
// JOIN (`joinScrub { page, path, tolerance }`). draw-geometry
// `planJoinScrub` decides what the scrub asked for; the ENGINE joins:
//   · one path's two ends → `closePath`;
//   · a gap between two paths → the first is extended by a straight
//     segment to the second's end (`framePath`), so the pair is exactly
//     coincident, then `joinPaths` welds them there and removes the
//     second;
//   · a crossing → both trimmed at the crossing (`framePath`), then the
//     same weld.
//   `joinPaths` concatenates the two paths' OWN coordinates, so two paths
//   with different transforms are refused by name rather than joined
//   wrong. Candidates are open single-contour paths — the selection, or
//   with nothing selected every path the scrub's box touches.
//
// PATH ERASER (`pathErase { page, path, width }`). draw-geometry
// `planPathErase` finds the covered stretches; the first piece left is
// written ONTO the path (a closed one is opened first with `pathOpenAt`,
// because `framePath` cannot change the open flag), every further piece
// is inserted open and painted like it, and a path erased whole is
// deleted. Inserts first, deletes last (CLAUDE.md "batch-ORDERING").
// Compound paths are skipped: which contour a piece belongs to is not a
// question this tool answers.
//
// RESHAPE (`reshapeAt { point, to, radius }`). The one selected path's
// anchor at `point` — added there first when `point` is on a segment —
// moves to `to`, its contour following by the falloff
// (draw-tools `ReshapeMachine`); the table is written with one
// `framePath`.

import type {
  BundleHost,
  Disposable,
  ElementId,
  Mutation,
  PathAnchorsResult,
} from "@paged-media/plugin-api";
import {
  affineScale,
  inverseApplyAffine,
  planJoinScrub,
  planPathErase,
  tableBounds,
  type Affine,
  type AnchorTable,
  type AnchorTriple,
  type Vec2,
} from "@paged-media/draw-geometry";
import { ReshapeMachine } from "@paged-media/draw-tools";

import { batchMutationFor } from "./batch-handles";
import { compoundPaintOf } from "./compound-path";
import { closePathMutationFor, joinPathsMutationFor } from "./join-average";
import { knifeCandidates } from "./knife";
import {
  anchorsToPage,
  insertOpenPieceOps,
  openTable,
  readEditablePath,
  rewritePathOps,
  tableOfRead,
} from "./path-rewrite";
import { registerCommand } from "../command-registry";
import { defineMessages } from "@paged-media/strings";

const M = defineMessages("draw.pathTools", {
  join: "Join the paths a scrub crosses",
  erase: "Erase along a path",
  reshape: "Reshape the selected path at a point",
});

const C = "media.paged.draw.command";
export const JOIN_SCRUB_COMMAND_ID = `${C}.joinScrub`;
export const PATH_ERASE_COMMAND_ID = `${C}.pathErase`;
export const RESHAPE_AT_COMMAND_ID = `${C}.reshapeAt`;
export const PATH_TOOL_COMMAND_IDS = [
  JOIN_SCRUB_COMMAND_ID,
  PATH_ERASE_COMMAND_ID,
  RESHAPE_AT_COMMAND_ID,
] as const;

/** The handle the eraser names its `k`-th inserted piece by. */
export const erasePieceHandle = (i: number, k: number): string =>
  `erase-${i}-${k}`;

type Pt = [number, number];

const toInner = (m: Affine | null, pts: readonly Vec2[]): Pt[] | null => {
  const out: Pt[] = [];
  for (const p of pts) {
    const q = inverseApplyAffine(m, p[0], p[1]);
    if (!q) return null;
    out.push([q[0], q[1]]);
  }
  return out;
};

/** The box of `pts` grown by `r`, as two points (what
 *  `knifeCandidates` takes). */
const grownBox = (pts: readonly Vec2[], r: number): Pt[] => {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [
    [Math.min(...xs) - r, Math.min(...ys) - r],
    [Math.max(...xs) + r, Math.max(...ys) + r],
  ];
};

const sameMatrix = (a: Affine | null, b: Affine | null): boolean => {
  const x = a ?? [1, 0, 0, 1, 0, 0];
  const y = b ?? [1, 0, 0, 1, 0, 0];
  return x.every((v, i) => Math.abs(v - y[i]!) < 1e-6);
};

const isOneOpenContour = (r: PathAnchorsResult): boolean =>
  r.subpathStarts.length <= 1 && (r.subpathOpen?.[0] ?? false);

const boundsOp = (id: ElementId, table: AnchorTable): Mutation[] => {
  const box = tableBounds(table);
  return box
    ? [
        {
          op: "setElementProperty",
          args: {
            elementId: id,
            path: "frameBounds",
            value: { type: "bounds", value: box },
          },
        },
      ]
    : [];
};

// ----------------------------------------------------------------- join

export type JoinResult =
  | { applied: true; kind: "close" | "gap" | "crossing"; kept: ElementId; removed: ElementId | null }
  | { applied: false; reason: string };

/** Join what the scrub `scrubPage` (page pt on `pageId`) crosses. */
export async function applyJoinScrub(
  host: BundleHost,
  pageId: string,
  scrubPage: readonly Vec2[],
  tolerancePt: number,
): Promise<JoinResult> {
  const no = (reason: string): JoinResult => ({ applied: false, reason });
  if (scrubPage.length === 0) return no("a scrub is at least one point");
  const reads: (PathAnchorsResult & { id: ElementId })[] = [];
  for (const id of await knifeCandidates(host, pageId, grownBox(scrubPage, tolerancePt))) {
    const read = await readEditablePath(host, id);
    if (read && read.pageId === pageId && isOneOpenContour(read)) reads.push(read);
  }
  if (reads.length === 0) return no("the scrub is over no open path");
  const matrices = reads.map((r) => tableOfRead(r).matrix);
  const plan = planJoinScrub(
    reads.map((r, i) => ({ anchors: anchorsToPage(r.anchors, matrices[i]!) })),
    scrubPage,
    tolerancePt,
  );
  if (!plan) return no("the scrub crosses no gap between endpoints and no crossing");
  if (plan.kind === "close") {
    const id = reads[plan.path]!.id;
    const outcome = await host.document.mutate(closePathMutationFor(id, 0));
    return outcome.applied
      ? { applied: true, kind: "close", kept: id, removed: null }
      : no(`the engine refused the close: ${JSON.stringify(outcome.error)}`);
  }
  const a = reads[plan.a]!;
  const b = reads[plan.b]!;
  const ma = matrices[plan.a]!;
  const mb = matrices[plan.b]!;
  if (!sameMatrix(ma, mb))
    return no(
      "the two paths have different transforms, and the engine joins their own coordinates — reset one's transform first",
    );
  const inner = (anchors: readonly AnchorTriple[]): AnchorTriple[] | null => {
    const out: AnchorTriple[] = [];
    for (const x of anchors) {
      const [p, l, r] = [x.anchor, x.left, x.right].map((q) =>
        inverseApplyAffine(ma, q[0], q[1]),
      );
      if (!p || !l || !r) return null;
      out.push({ anchor: [p[0], p[1]], left: [l[0], l[1]], right: [r[0], r[1]] });
    }
    return out;
  };
  const ops: Mutation[] = [];
  const aInner = inner(plan.aAnchors);
  if (!aInner) return no("the path's transform cannot be inverted");
  ops.push(...(rewritePathOps(a.id, openTable(aInner)) as Mutation[]));
  let bInner: AnchorTriple[] = b.anchors.map((x) => ({
    anchor: [x.anchor[0], x.anchor[1]],
    left: [x.left[0], x.left[1]],
    right: [x.right[0], x.right[1]],
  }));
  if (plan.kind === "crossing") {
    const t = inner(plan.bAnchors);
    if (!t) return no("the path's transform cannot be inverted");
    bInner = t;
    ops.push(...(rewritePathOps(b.id, openTable(bInner)) as Mutation[]));
  }
  ops.push(joinPathsMutationFor(a.id, b.id));
  // The welded path's box: both halves (joinPaths writes the anchors only).
  ops.push(
    ...boundsOp(a.id, { anchors: [...aInner, ...bInner], subpathStarts: [0] }),
  );
  const outcome = await host.document.mutate(batchMutationFor(ops));
  return outcome.applied
    ? { applied: true, kind: plan.kind, kept: a.id, removed: b.id }
    : no(`the engine refused the join: ${JSON.stringify(outcome.error)}`);
}

// ---------------------------------------------------------------- erase

export interface EraseResult {
  /** The paths the drag shortened, split or removed. */
  erased: ElementId[];
  /** Pieces inserted (beyond each path's own). */
  inserted: number;
  /** Paths removed whole. */
  removed: ElementId[];
}

/** Erase along `brushPage` (page pt on `pageId`) a band `widthPt` wide. */
export async function applyPathErase(
  host: BundleHost,
  pageId: string,
  brushPage: readonly Vec2[],
  widthPt: number,
): Promise<EraseResult> {
  const result: EraseResult = { erased: [], inserted: 0, removed: [] };
  if (brushPage.length === 0) return result;
  const radius = Math.max(0.01, widthPt / 2);
  const inserts: Mutation[] = [];
  const rewrites: Mutation[] = [];
  const deletes: Mutation[] = [];
  let i = 0;
  for (const id of await knifeCandidates(host, pageId, grownBox(brushPage, radius))) {
    const read = await readEditablePath(host, id);
    if (!read || read.pageId !== pageId) continue;
    if (read.subpathStarts.length > 1) {
      host.log.debug(`path eraser: ${String(id.id)} is a compound path — skipped`);
      continue;
    }
    const { matrix } = tableOfRead(read);
    const brush = toInner(matrix, brushPage);
    if (!brush) continue;
    const closed = !(read.subpathOpen?.[0] ?? false);
    const plan = planPathErase(read.anchors, closed, brush, radius / affineScale(matrix));
    if (!plan) continue;
    result.erased.push(id);
    if (plan.pieces.length === 0) {
      deletes.push({ op: "deleteFrame", args: { frameId: String(id.id) } });
      result.removed.push(id);
      continue;
    }
    const paint = await compoundPaintOf(host, id);
    plan.pieces.slice(1).forEach((piece, k) => {
      inserts.push(
        ...(insertOpenPieceOps(
          pageId,
          anchorsToPage(piece, matrix),
          erasePieceHandle(i, k + 1),
          paint,
        ) as Mutation[]),
      );
      result.inserted++;
    });
    if (closed) rewrites.push({ op: "pathOpenAt", args: { elementId: id, index: 0 } });
    rewrites.push(...(rewritePathOps(id, openTable(plan.pieces[0]!)) as Mutation[]));
    i++;
  }
  const ops = [...inserts, ...rewrites, ...deletes];
  if (ops.length === 0) return result;
  const outcome = await host.document.mutate(batchMutationFor(ops));
  if (!outcome.applied) {
    host.log.warn(`path eraser: the engine refused: ${JSON.stringify(outcome.error)}`);
    return { erased: [], inserted: 0, removed: [] };
  }
  return result;
}

// -------------------------------------------------------------- reshape

/** Write a Reshape commit (`table`, inner space) onto `id`. */
export async function applyReshapeTable(
  host: BundleHost,
  id: ElementId,
  table: AnchorTable,
): Promise<boolean> {
  const outcome = await host.document.mutate(
    batchMutationFor(rewritePathOps(id, table) as Mutation[]),
  );
  if (!outcome.applied)
    host.log.warn(`reshape: the engine refused: ${JSON.stringify(outcome.error)}`);
  return outcome.applied;
}

/** The default falloff radius (pt) — the Reshape tool option's. */
export const DEFAULT_RESHAPE_RADIUS_PT = 72;

/** Reshape `id` from `point` to `to` (page pt) through the tool's own
 *  machine. False when `point` is on no anchor or segment of it. */
export async function applyReshapeAt(
  host: BundleHost,
  id: ElementId,
  point: Vec2,
  to: Vec2,
  radiusPt: number,
  tolerancePt: number,
): Promise<boolean> {
  const read = await readEditablePath(host, id);
  if (!read) return false;
  const { table, matrix } = tableOfRead(read);
  const pts = toInner(matrix, [point, to]);
  if (!pts) return false;
  const k = affineScale(matrix);
  const machine = new ReshapeMachine({
    table,
    tolerance: tolerancePt / k,
    radius: radiusPt / k,
  });
  machine.handle({ type: "down", point: pts[0]! });
  const snap = machine.handle({ type: "up", point: pts[1]! });
  if (!snap.commit) return false;
  return applyReshapeTable(host, id, snap.commit);
}

// ------------------------------------------------------------- commands

const pointsOf = (v: unknown): Pt[] =>
  Array.isArray(v)
    ? v.filter(
        (p): p is Pt =>
          Array.isArray(p) &&
          p.length === 2 &&
          p.every((n) => typeof n === "number" && Number.isFinite(n)),
      )
    : [];

const payloadOf = (p: unknown): Record<string, unknown> =>
  p && typeof p === "object" ? (p as Record<string, unknown>) : {};

const positive = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;

const failed = (why: string): never => {
  throw new Error(`failed: ${why}`);
};

async function pageOf(host: BundleHost, id: ElementId): Promise<string | null> {
  const read = await host.document.pathAnchors(id).catch(() => null);
  if (read?.pageId) return read.pageId;
  const [g] = await host.document.elementGeometry([id]).catch(() => []);
  return g?.pageId ?? null;
}

async function pageFrom(host: BundleHost, p: Record<string, unknown>): Promise<string> {
  let page = typeof p.page === "string" ? p.page : "";
  if (page === "") {
    const [first] = host.selection.get();
    page = (first && (await pageOf(host, first))) || "";
  }
  if (page === "") failed("name the page, or select the paths");
  return page;
}

export async function runJoinScrub(host: BundleHost, payload: unknown) {
  const p = payloadOf(payload);
  const path = pointsOf(p.path);
  if (path.length === 0) failed("a scrub is at least one point");
  const r = await applyJoinScrub(host, await pageFrom(host, p), path, positive(p.tolerance, 4));
  if (!r.applied) failed(r.reason);
  return r.applied ? { kind: r.kind } : null;
}

export async function runPathErase(host: BundleHost, payload: unknown) {
  const p = payloadOf(payload);
  const path = pointsOf(p.path);
  if (path.length === 0) failed("an erase is at least one point");
  const r = await applyPathErase(host, await pageFrom(host, p), path, positive(p.width, 4));
  if (r.erased.length === 0) failed("the drag passes over no path");
  return { erased: r.erased.length, inserted: r.inserted, removed: r.removed.length };
}

export async function runReshapeAt(host: BundleHost, payload: unknown) {
  const p = payloadOf(payload);
  const [point, to] = pointsOf([p.point, p.to]);
  if (!point || !to) failed("a reshape needs a point and where it goes");
  const selection = host.selection.get();
  if (selection.length !== 1) failed("select the one path to reshape");
  const ok = await applyReshapeAt(
    host,
    selection[0]!,
    point!,
    to!,
    positive(p.radius, DEFAULT_RESHAPE_RADIUS_PT),
    positive(p.tolerance, 2),
  );
  if (!ok) failed("the point is on no anchor or segment of the selected path");
  return null;
}

const fromPalette =
  <T>(host: BundleHost, id: string, run: (payload: unknown) => Promise<T>) =>
  async (_paged: unknown, payload: unknown): Promise<T | null> => {
    if (payload !== undefined) return run(payload);
    try {
      return await run(payload);
    } catch (e) {
      host.log.info(`${id}: ${String(e)}`);
      return null;
    }
  };

export function contributePathToolCommands(host: BundleHost): Disposable {
  const disposers = [
    registerCommand(host, {
      id: JOIN_SCRUB_COMMAND_ID,
      title: M.join,
      category: "Path",
      handler: fromPalette(host, JOIN_SCRUB_COMMAND_ID, (p) => runJoinScrub(host, p)),
    }),
    registerCommand(host, {
      id: PATH_ERASE_COMMAND_ID,
      title: M.erase,
      category: "Path",
      handler: fromPalette(host, PATH_ERASE_COMMAND_ID, (p) => runPathErase(host, p)),
    }),
    registerCommand(host, {
      id: RESHAPE_AT_COMMAND_ID,
      title: M.reshape,
      category: "Path",
      handler: fromPalette(host, RESHAPE_AT_COMMAND_ID, (p) => runReshapeAt(host, p)),
    }),
  ];
  return {
    dispose() {
      for (const d of disposers) d.dispose();
    },
  };
}

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

// THE DISTORTION TOOLS' document lane — what Liquify, Puppet Warp and
// the Perspective tools read and write, in one place so the three write
// the same shape:
//
//   · READ: each target path's anchor table (inner space) and transform,
//     and the same table in PAGE space — every kernel runs in page pt;
//   · WRITE: every changed target as `framePath` + `frameBounds` (the
//     WP6.1 rewrite, `path-rewrite.ts`), the page result mapped back to
//     inner space through the inverse transform (an affine map is exact
//     on Béziers), ALL IN ONE BATCH — one gesture is one undo step,
//     however many paths it bent.

import type {
  BundleHost,
  ElementId,
  Mutation,
  MutationInput,
} from "@paged-media/plugin-api";
import {
  invertAffine,
  type Affine,
  type AnchorTable,
} from "@paged-media/draw-geometry";

import { leafIdsOf } from "../link-index";
import { batchMutationFor } from "./batch-handles";
import {
  anchorsToPage,
  EDITABLE_PATH_KINDS,
  readEditablePath,
  rewritePathOps,
  tableOfRead,
} from "./path-rewrite";

/** One path a distortion acts on. */
export interface DistortTarget {
  id: ElementId;
  pageId: string;
  /** Inner space, as `pathAnchors` reported it. */
  table: AnchorTable;
  matrix: Affine | null;
  /** The same table in page space. */
  page: AnchorTable;
}

/** `table` with its anchors mapped by `m` (null = identity). */
export function tableThrough(
  table: AnchorTable,
  m: Affine | null,
): AnchorTable {
  return { ...table, anchors: anchorsToPage(table.anchors, m) };
}

/** Read `ids` that are editable paths (others are skipped). */
export async function readDistortTargets(
  host: BundleHost,
  ids: readonly ElementId[],
): Promise<DistortTarget[]> {
  const out: DistortTarget[] = [];
  for (const id of ids) {
    const read = await readEditablePath(host, id);
    if (!read) continue;
    const { table, matrix } = tableOfRead(read);
    out.push({
      id,
      pageId: read.pageId ?? "",
      table,
      matrix,
      page: tableThrough(table, matrix),
    });
  }
  return out;
}

/** The selection's editable paths on `pageId`; with nothing selected,
 *  every editable path on the page (Illustrator's liquify tools distort
 *  whatever is under the brush when nothing is selected). */
export async function distortTargetsOn(
  host: BundleHost,
  pageId: string,
  options: { allWhenNoneSelected: boolean },
): Promise<DistortTarget[]> {
  const sel = host.selection
    .get()
    .filter((i) => EDITABLE_PATH_KINDS.has(i.kind));
  let ids: ElementId[] = sel;
  if (ids.length === 0 && options.allWhenNoneSelected) {
    const roots = await host.document.tree().catch(() => []);
    ids = leafIdsOf(roots).filter((i) => EDITABLE_PATH_KINDS.has(i.kind));
  }
  return (await readDistortTargets(host, ids)).filter(
    (t) => t.pageId === pageId,
  );
}

/** The ops that write `page` (page space) onto `target`. Null when its
 *  transform cannot be inverted. */
export function rewriteFromPage(
  target: Pick<DistortTarget, "id" | "matrix">,
  page: AnchorTable,
): MutationInput[] | null {
  const inv = target.matrix ? invertAffine(target.matrix) : null;
  if (target.matrix && !inv) return null;
  return rewritePathOps(target.id, tableThrough(page, inv));
}

/** Write every `{ target, page }` in ONE batch. False (and a warning)
 *  when the engine refused it or there was nothing to write. */
export async function writeDistorted(
  host: BundleHost,
  label: string,
  edits: readonly {
    target: Pick<DistortTarget, "id" | "matrix">;
    page: AnchorTable;
  }[],
  extra: readonly MutationInput[] = [],
): Promise<boolean> {
  const ops: MutationInput[] = [];
  for (const e of edits) {
    const o = rewriteFromPage(e.target, e.page);
    if (o) ops.push(...o);
  }
  ops.push(...extra);
  if (ops.length === 0) return false;
  const outcome = await host.document.mutate(
    batchMutationFor(ops as Mutation[]),
  );
  if (!outcome.applied)
    host.log.warn(
      `${label}: the engine refused: ${JSON.stringify(outcome.error)}`,
    );
  return outcome.applied;
}

// ------------------------------------------------- payload helpers

export type Pt = [number, number];

export const payloadOf = (p: unknown): Record<string, unknown> =>
  p && typeof p === "object" ? (p as Record<string, unknown>) : {};

export const pointOf = (v: unknown): Pt | null =>
  Array.isArray(v) &&
  v.length === 2 &&
  typeof v[0] === "number" &&
  typeof v[1] === "number" &&
  Number.isFinite(v[0]) &&
  Number.isFinite(v[1])
    ? [v[0], v[1]]
    : null;

export const pointsOf = (v: unknown): Pt[] =>
  Array.isArray(v) ? v.map(pointOf).filter((p): p is Pt => p !== null) : [];

export const numberOr = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

export const failed = (why: string): never => {
  throw new Error(`failed: ${why}`);
};

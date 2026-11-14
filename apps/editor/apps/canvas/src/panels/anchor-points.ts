/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
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

// The point-level controls' arithmetic (the UX strategy's §7.1; paged.draw
// ADR 370): what the inspector shows for the anchors Direct Selection has
// selected, and the ONE batch each of its edits sends.
//
// The path-edit view hands the inspector page-local points; the engine
// stores the path in its own inner space behind an item transform
// (`pathAnchors`' `itemTransform`, inner → page). A position typed in the
// inspector is a page-local point; the edit moves each selected anchor —
// its two handles with it — by the page delta taken back through the
// transform's inverse, so a rotated or scaled path moves exactly as the
// fields say.

import {
  applyAffine,
  invertAffine,
  isCornerAnchor,
  type Affine,
  type AnchorTriple,
} from "@paged-media/vector-geometry";

/** One anchor as the engine or the view gives it. */
export interface PointTriple {
  anchor: readonly [number, number];
  left: readonly [number, number];
  right: readonly [number, number];
}

/** The engine's point ops (the path-edit batch's leaves). */
export type PointOp =
  | {
      op: "pathPointSet";
      index: number;
      role: "anchor" | "left" | "right";
      position: [number, number];
    }
  | { op: "pathPointCurveType"; index: number; smooth: boolean }
  | { op: "pathPointRemove"; index: number };

/** What the inspector shows for the selection: where it is (one anchor's
 *  point, or the selected anchors' bounds), and whether they are corners,
 *  smooth points or both. */
export interface PointSummary {
  count: number;
  /** Left / top of the selected anchors, page-local pt (one anchor: its
   *  point). */
  x: number;
  y: number;
  width: number;
  height: number;
  kind: "corner" | "smooth" | "mixed";
}

export function summarizePoints(
  anchors: readonly PointTriple[],
  selected: readonly number[],
): PointSummary | null {
  const picked = selected
    .map((i) => anchors[i])
    .filter((a): a is PointTriple => a !== undefined);
  if (picked.length === 0) return null;
  const xs = picked.map((a) => a.anchor[0]);
  const ys = picked.map((a) => a.anchor[1]);
  const corners = picked.filter((a) => isCornerAnchor(a as AnchorTriple));
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {
    count: picked.length,
    x,
    y,
    width: Math.max(...xs) - x,
    height: Math.max(...ys) - y,
    kind:
      corners.length === picked.length
        ? "corner"
        : corners.length === 0
          ? "smooth"
          : "mixed",
  };
}

/** A page-local delta in the path's inner space (the linear part of the
 *  inverse transform). */
function innerDelta(
  transform: Affine | null | undefined,
  dx: number,
  dy: number,
): [number, number] {
  const inv = transform ? invertAffine(transform) : null;
  if (!inv) return [dx, dy];
  const [x, y] = applyAffine([inv[0], inv[1], inv[2], inv[3], 0, 0], dx, dy);
  return [x, y];
}

const add = (
  p: readonly [number, number],
  d: readonly [number, number],
): [number, number] => [p[0] + d[0], p[1] + d[1]];

/** The ops moving anchor `index` of the INNER `table` by an inner delta,
 *  its handles with it. */
function moveOne(
  table: readonly PointTriple[],
  index: number,
  d: readonly [number, number],
): PointOp[] {
  const a = table[index];
  if (!a) return [];
  return [
    { op: "pathPointSet", index, role: "anchor", position: add(a.anchor, d) },
    { op: "pathPointSet", index, role: "left", position: add(a.left, d) },
    { op: "pathPointSet", index, role: "right", position: add(a.right, d) },
  ];
}

/** Move the selected anchors by a page-local delta (one batch). */
export function moveAnchorsOps(
  inner: readonly PointTriple[],
  transform: Affine | null | undefined,
  selected: readonly number[],
  dx: number,
  dy: number,
): PointOp[] {
  if (dx === 0 && dy === 0) return [];
  const d = innerDelta(transform, dx, dy);
  return selected.flatMap((i) => moveOne(inner, i, d));
}

/** Line the selected anchors up on one page-local line through their
 *  average: `"horizontal"` gives them one y, `"vertical"` one x
 *  (Illustrator's Average). Each anchor moves with its handles. */
export function alignAnchorsOps(
  inner: readonly PointTriple[],
  transform: Affine | null | undefined,
  page: readonly PointTriple[],
  selected: readonly number[],
  axis: "horizontal" | "vertical",
): PointOp[] {
  const picked = selected.filter((i) => page[i] && inner[i]);
  if (picked.length < 2) return [];
  const k = axis === "horizontal" ? 1 : 0;
  const mean =
    picked.reduce((sum, i) => sum + page[i]!.anchor[k], 0) / picked.length;
  return picked.flatMap((i) => {
    const off = mean - page[i]!.anchor[k];
    if (Math.abs(off) < 1e-9) return [];
    const d =
      axis === "horizontal"
        ? innerDelta(transform, 0, off)
        : innerDelta(transform, off, 0);
    return moveOne(inner, i, d);
  });
}

/** Make the selected anchors corners or smooth points. */
export function curveTypeOps(
  selected: readonly number[],
  smooth: boolean,
): PointOp[] {
  return selected.map((index) => ({
    op: "pathPointCurveType",
    index,
    smooth,
  }));
}

/** Remove the selected anchors, highest index first (each removal shifts
 *  the indices after it). */
export function removeAnchorsOps(selected: readonly number[]): PointOp[] {
  return [...selected]
    .sort((a, b) => b - a)
    .map((index) => ({ op: "pathPointRemove", index }));
}

/** A page-local point back in the path's inner space (for tests and for a
 *  caller that has a point rather than a delta). */
export function toInner(
  transform: Affine | null | undefined,
  p: readonly [number, number],
): [number, number] {
  const inv = transform ? invertAffine(transform) : null;
  if (!inv) return [p[0], p[1]];
  const [x, y] = applyAffine(inv, p[0], p[1]);
  return [x, y];
}

/** The ops as ONE batch mutation on `elementId`: one undo step. */
export function pointBatch(
  elementId: unknown,
  ops: readonly PointOp[],
): { op: "batch"; args: { ops: Array<{ op: string; args: unknown }> } } {
  return {
    op: "batch",
    args: {
      ops: ops.map(({ op, ...rest }) => ({ op, args: { elementId, ...rest } })),
    },
  };
}

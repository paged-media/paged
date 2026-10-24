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

// RESHAPE — the Reshape tool's falloff move. One anchor is dragged by
// `delta`; every other anchor OF THE SAME CONTOUR moves by a fraction of
// it that falls off with its distance ALONG THE PATH from the dragged one
// (not across the page: two arms of a U that nearly touch are far apart
// along the path and must not drag each other). The fraction is a cosine
// bell, 1 at the dragged anchor and 0 at `radius`, so the neighbouring
// segments stretch smoothly instead of kinking. An anchor's handles move
// with it, so each segment keeps its own shape in the anchor's frame.
//
// The distance along the path is the polyline through the ANCHORS (each
// segment's chord), which is what "how far away is that anchor" means to
// a user, and cheap enough to recompute on every pointer move. On a
// closed contour it is the shorter way round.

import type { AnchorTable, AnchorTriple, Vec2 } from "./types";

/** The cosine bell: 1 at 0, 0 at and past `radius`. */
export function reshapeWeight(distance: number, radius: number): number {
  if (radius <= 0) return distance === 0 ? 1 : 0;
  if (distance >= radius) return 0;
  return 0.5 * (1 + Math.cos((Math.PI * distance) / radius));
}

/** The contour `[from, to)` that holds flat anchor `index`, and whether
 *  it is closed. */
function contourOf(
  table: AnchorTable,
  index: number,
): { from: number; to: number; closed: boolean } | null {
  const n = table.anchors.length;
  const starts = table.subpathStarts.length > 0 ? table.subpathStarts : [0];
  for (let s = 0; s < starts.length; s++) {
    const from = starts[s]!;
    const to = s + 1 < starts.length ? starts[s + 1]! : n;
    if (index >= from && index < to)
      return { from, to, closed: !(table.subpathOpen?.[s] ?? false) };
  }
  return null;
}

/** Each anchor's distance along the path from flat anchor `index` (its
 *  contour's anchors only; others are Infinity). */
export function pathDistancesFrom(table: AnchorTable, index: number): number[] {
  const out = table.anchors.map(() => Infinity);
  const c = contourOf(table, index);
  if (!c) return out;
  const pts = table.anchors.slice(c.from, c.to).map((a) => a.anchor);
  const m = pts.length;
  const cum = [0];
  for (let i = 1; i < m; i++)
    cum.push(
      cum[i - 1]! +
        Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]),
    );
  const closing = c.closed
    ? Math.hypot(pts[0]![0] - pts[m - 1]![0], pts[0]![1] - pts[m - 1]![1])
    : 0;
  const perimeter = cum[m - 1]! + closing;
  const k = index - c.from;
  for (let i = 0; i < m; i++) {
    const direct = Math.abs(cum[i]! - cum[k]!);
    out[c.from + i] = c.closed ? Math.min(direct, perimeter - direct) : direct;
  }
  return out;
}

const shift = (p: Vec2, dx: number, dy: number): [number, number] => [
  p[0] + dx,
  p[1] + dy,
];

/**
 * The table with flat anchor `index` moved by `delta` and its contour's
 * other anchors by `delta · reshapeWeight(distance, radius)`. Every other
 * contour is returned untouched. Pure.
 */
export function reshapeTable(
  table: AnchorTable,
  index: number,
  delta: Vec2,
  radius: number,
): AnchorTable {
  const dist = pathDistancesFrom(table, index);
  const anchors: AnchorTriple[] = table.anchors.map((a, i) => {
    const w = i === index ? 1 : reshapeWeight(dist[i]!, radius);
    const dx = delta[0] * w;
    const dy = delta[1] * w;
    return {
      anchor: shift(a.anchor, dx, dy),
      left: shift(a.left, dx, dy),
      right: shift(a.right, dx, dy),
    };
  });
  return {
    anchors,
    subpathStarts: [...table.subpathStarts],
    ...(table.subpathOpen ? { subpathOpen: [...table.subpathOpen] } : {}),
  };
}

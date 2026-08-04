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

// COMPOUND PATHS — the contour algebra behind Illustrator's
// Object ▸ Compound Path ▸ Make / Release. Pure, zero-dep: tables in,
// tables out; the host wiring lives in draw-bundle.
//
// WHY WINDING IS THE WHOLE PROBLEM. "Make compound path" is not just
// "concatenate the anchors". The engine fills every path with the
// NON-ZERO rule — `paged-compose`'s display list says so in as many
// words ("Paths are filled with `FillRule::NonZero`, matching IDML's
// path-geometry convention") and `paged-export-pdf` emits `f`, never
// `f*`. Under non-zero a contour inside another cuts a HOLE only when
// it is wound OPPOSITE to its container; wound the SAME way it paints a
// solid island and the ring silently becomes a disc. So the contours
// must be re-oriented by NESTING DEPTH before they are handed to the
// engine — `orientForNonZeroHoles` is that step, and it is the
// difference between a doughnut and a coin.
//
// Illustrator states the same rule from the other side ("even-odd"
// fill): even-odd and depth-alternating non-zero describe the SAME
// region for any set of non-self-intersecting contours, which is what a
// compound path is. Crossing contours are outside that guarantee and
// are named as such on `contourDepths`.

import { flattenAnchorRun } from "./bezier";
import { pointInAnchorPath } from "./polygon";
import type { AnchorTable, AnchorTriple } from "./types";

/** `[from, to)` anchor ranges, one per contour. An empty
 *  `subpathStarts` means the single-contour case (the wire's
 *  convention); empty/degenerate ranges are dropped. */
export function contourRanges(
  anchorCount: number,
  subpathStarts: readonly number[] = [],
): [number, number][] {
  if (anchorCount <= 0) return [];
  const starts = subpathStarts.length > 0 ? [...subpathStarts] : [0];
  const ranges: [number, number][] = [];
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i];
    const to = i + 1 < starts.length ? starts[i + 1] : anchorCount;
    if (to > from && from >= 0 && to <= anchorCount) ranges.push([from, to]);
  }
  return ranges;
}

/** Shoelace signed area of ONE contour, flattened as a CLOSED ring
 *  (a compound path's contours are fill boundaries — see
 *  `mergeCompound`'s note on openness). Sign = winding direction;
 *  magnitude is the enclosed area. Under 2 anchors ⇒ 0. */
export function contourSignedArea(
  anchors: readonly AnchorTriple[],
  options?: { samplesPerSegment?: number },
): number {
  if (anchors.length < 2) return 0;
  const ring = flattenAnchorRun(anchors, {
    close: true,
    samplesPerSegment: options?.samplesPerSegment,
  });
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return sum / 2;
}

/**
 * Reverse ONE contour's traversal direction — the winding flip a hole
 * needs. Each anchor's Bezier handles swap (`left` ⇄ `right`), because
 * the handle that was outgoing becomes incoming.
 *
 * A CLOSED contour keeps its FIRST anchor first and reverses the rest
 * (`a0, a_{n-1}, …, a1`), so the start point — and therefore every
 * downstream flat index the caller may have cached — stays put. An OPEN
 * contour reverses outright (its endpoints genuinely swap).
 */
export function reverseContour(
  anchors: readonly AnchorTriple[],
  options?: { closed?: boolean },
): AnchorTriple[] {
  const swap = (a: AnchorTriple): AnchorTriple => ({
    anchor: [a.anchor[0], a.anchor[1]],
    left: [a.right[0], a.right[1]],
    right: [a.left[0], a.left[1]],
  });
  if (anchors.length === 0) return [];
  if (options?.closed === false) return [...anchors].reverse().map(swap);
  return [anchors[0], ...anchors.slice(1).reverse()].map(swap);
}

/**
 * NESTING DEPTH per contour: how many OTHER contours of the same table
 * contain it. Depth 0 = an outer boundary, 1 = a hole, 2 = an island
 * inside a hole, and so on.
 *
 * Containment is tested with the contour's own first anchor — for
 * contours that do not CROSS each other (the only case a compound path
 * is defined for) a single point decides the whole contour. Crossing
 * contours get an answer, but not a meaningful one; the caller owns
 * that choice.
 */
export function contourDepths(table: AnchorTable): number[] {
  const ranges = contourRanges(table.anchors.length, table.subpathStarts);
  return ranges.map(([from], i) => {
    const probe = table.anchors[from].anchor;
    let depth = 0;
    for (let j = 0; j < ranges.length; j++) {
      if (j === i) continue;
      const [jf, jt] = ranges[j];
      if (jt - jf < 3) continue;
      if (pointInAnchorPath(probe, table.anchors.slice(jf, jt))) depth++;
    }
    return depth;
  });
}

/**
 * Re-orient a table's contours so the engine's NON-ZERO fill paints the
 * even-odd region: every even-depth (outer) contour winds like the
 * FIRST contour, every odd-depth (hole) contour winds against it.
 *
 * Contour 0 is the anchor of the convention and is never flipped — the
 * survivor of a "make compound path" keeps its own authored direction,
 * so a caller that cached its anchor order does not get a surprise.
 * Degenerate contours (zero area) are left alone.
 */
export function orientForNonZeroHoles(table: AnchorTable): AnchorTable {
  const ranges = contourRanges(table.anchors.length, table.subpathStarts);
  if (ranges.length < 2) return table;
  const depths = contourDepths(table);
  const areas = ranges.map(([from, to]) =>
    contourSignedArea(table.anchors.slice(from, to)),
  );
  const base = Math.sign(areas[0]) || 1;
  const anchors: AnchorTriple[] = [];
  const subpathStarts: number[] = [];
  const subpathOpen: boolean[] = [];
  ranges.forEach(([from, to], i) => {
    subpathStarts.push(anchors.length);
    subpathOpen.push(table.subpathOpen?.[i] ?? false);
    const contour = table.anchors.slice(from, to);
    const want = depths[i] % 2 === 0 ? base : -base;
    const have = Math.sign(areas[i]);
    anchors.push(...(have !== 0 && have !== want ? reverseContour(contour) : contour));
  });
  return { anchors, subpathStarts, subpathOpen };
}

/**
 * Concatenate several tables' contours into ONE table — the anchor-side
 * half of "make compound path". Each input contributes ALL of its
 * contours (merging a compound path into another one is legal), and the
 * inputs must already share a coordinate space.
 *
 * OPENNESS: the flags ride along here, but the engine's whole-path
 * write door (`framePath`) cannot carry them — see draw-bundle's
 * `commands/compound-path.ts`, which states what that means for an open
 * source. A compound path is a FILL object; its contours are closed
 * boundaries.
 */
export function mergeCompound(tables: readonly AnchorTable[]): AnchorTable {
  const anchors: AnchorTriple[] = [];
  const subpathStarts: number[] = [];
  const subpathOpen: boolean[] = [];
  for (const table of tables) {
    const ranges = contourRanges(table.anchors.length, table.subpathStarts);
    ranges.forEach(([from, to], i) => {
      subpathStarts.push(anchors.length);
      subpathOpen.push(table.subpathOpen?.[i] ?? false);
      anchors.push(...table.anchors.slice(from, to));
    });
  }
  return { anchors, subpathStarts, subpathOpen };
}

/** `mergeCompound` + `orientForNonZeroHoles` — the whole pure half of
 *  "make compound path", in the order that matters (orientation is
 *  resolved over the MERGED table, because nesting is a relation
 *  BETWEEN the former elements). */
export function makeCompoundTable(
  tables: readonly AnchorTable[],
): AnchorTable {
  return orientForNonZeroHoles(mergeCompound(tables));
}

/** Split a table into ONE table per contour — the pure half of
 *  "release compound path". Windings are left exactly as they are: a
 *  released hole keeps the direction it was given, which is what makes
 *  make→release→make stable. */
export function splitCompound(table: AnchorTable): AnchorTable[] {
  return contourRanges(table.anchors.length, table.subpathStarts).map(
    ([from, to], i) => ({
      anchors: table.anchors.slice(from, to),
      subpathStarts: [0],
      subpathOpen: [table.subpathOpen?.[i] ?? false],
    }),
  );
}

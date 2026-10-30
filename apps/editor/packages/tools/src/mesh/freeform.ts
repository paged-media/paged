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

// The freeform-gradient edits of the Gradient tool's freeform modes
// (engine ADR 1040): colour points anywhere on the frame, and lines
// through some of them. Pure: every edit returns a new spec, committed as
// one whole-value `frameFillMesh` write.

import {
  cloneColor,
  type FreeformPointSpec,
  type MeshColorSpec,
  type MeshFillSpec,
  type Vec2,
} from "./types";

export type FreeformSpec = Extract<MeshFillSpec, { kind: "freeform" }>;

export function emptyFreeform(): FreeformSpec {
  return { kind: "freeform", points: [], lines: [] };
}

function clonePoint(p: FreeformPointSpec): FreeformPointSpec {
  const out: FreeformPointSpec = {
    point: [p.point[0], p.point[1]],
    color: cloneColor(p.color),
  };
  if (p.spreadPct !== undefined) out.spreadPct = p.spreadPct;
  return out;
}

export function cloneFreeform(spec: FreeformSpec): FreeformSpec {
  return {
    kind: "freeform",
    points: spec.points.map(clonePoint),
    lines: spec.lines.map((l) => [...l]),
  };
}

/** A point at `at` coloured `color` with `spreadPct` (0 = none). Returns
 *  the new spec and the new point's index. */
export function addFreeformPoint(
  spec: FreeformSpec,
  at: Vec2,
  color: MeshColorSpec,
  spreadPct: number,
): { spec: FreeformSpec; index: number } {
  const next = cloneFreeform(spec);
  const p: FreeformPointSpec = {
    point: [at[0], at[1]],
    color: cloneColor(color),
  };
  const spread = Math.min(100, Math.max(0, spreadPct));
  if (spread > 0) p.spreadPct = spread;
  next.points.push(p);
  return { spec: next, index: next.points.length - 1 };
}

export function moveFreeformPoint(
  spec: FreeformSpec,
  index: number,
  to: Vec2,
): FreeformSpec {
  const next = cloneFreeform(spec);
  const p = next.points[index];
  if (p) p.point = [to[0], to[1]];
  return next;
}

export function recolorFreeformPoints(
  spec: FreeformSpec,
  indices: readonly number[],
  color: MeshColorSpec,
): FreeformSpec {
  const next = cloneFreeform(spec);
  for (const i of indices) {
    const p = next.points[i];
    if (p) p.color = cloneColor(color);
  }
  return next;
}

/** Remove a point: every line loses it (and the later indices shift
 *  down), a line left with fewer than two points goes. */
export function removeFreeformPoint(
  spec: FreeformSpec,
  index: number,
): FreeformSpec {
  const next = cloneFreeform(spec);
  if (index < 0 || index >= next.points.length) return next;
  next.points.splice(index, 1);
  next.lines = next.lines
    .map((line) =>
      line.filter((i) => i !== index).map((i) => (i > index ? i - 1 : i)),
    )
    .filter((line) => line.length >= 2);
  return next;
}

/**
 * Extend the line being drawn with point `index`. `line` is the index of
 * that line in `lines`, or null when no line is open: the first point of
 * a line is only remembered (`pending`), the second opens the line. A
 * point is not joined to itself twice in a row.
 */
export function extendLine(
  spec: FreeformSpec,
  line: number | null,
  pending: number | null,
  index: number,
): { spec: FreeformSpec; line: number | null; pending: number | null } {
  if (line !== null && spec.lines[line]) {
    const current = spec.lines[line]!;
    if (current[current.length - 1] === index) return { spec, line, pending };
    const next = cloneFreeform(spec);
    next.lines[line]!.push(index);
    return { spec: next, line, pending: null };
  }
  if (pending === null || pending === index)
    return { spec, line: null, pending: index };
  const next = cloneFreeform(spec);
  next.lines.push([pending, index]);
  return { spec: next, line: next.lines.length - 1, pending: null };
}

/** The uniform Catmull-Rom curve through `points` as a polyline — the
 *  curve the engine runs a line's colour along. */
export function catmullRom(points: readonly Vec2[], segments = 12): Vec2[] {
  if (points.length < 2) return points.map((p) => [p[0], p[1]]);
  const out: Vec2[] = [];
  const at = (i: number) =>
    points[Math.min(points.length - 1, Math.max(0, i))]!;
  for (let k = 0; k < points.length - 1; k++) {
    const p0 = at(k - 1);
    const p1 = at(k);
    const p2 = at(k + 1);
    const p3 = at(k + 2);
    for (let s = 0; s < segments; s++) {
      const t = s / segments;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) =>
        0.5 *
        (2 * b +
          (-a + c) * t +
          (2 * a - 5 * b + 4 * c - d) * t2 +
          (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  const last = points[points.length - 1]!;
  out.push([last[0], last[1]]);
  return out;
}

/** Distinct colours for the points after a freeform gradient's first:
 *  the first takes the frame's fill, each later one the next entry here,
 *  so a new point is visible at once and the Color panel recolours it. */
export const FREEFORM_PALETTE: readonly MeshColorSpec[] = [
  { space: "RGB", value: [230, 57, 70] },
  { space: "RGB", value: [252, 191, 73] },
  { space: "RGB", value: [42, 157, 143] },
  { space: "RGB", value: [69, 123, 157] },
  { space: "RGB", value: [131, 56, 236] },
  { space: "RGB", value: [255, 255, 255] },
];

/** The colour a new point at position `count` (0-based) takes. */
export function freeformColorFor(
  count: number,
  fill: MeshColorSpec,
): MeshColorSpec {
  if (count === 0) return cloneColor(fill);
  return cloneColor(FREEFORM_PALETTE[(count - 1) % FREEFORM_PALETTE.length]!);
}

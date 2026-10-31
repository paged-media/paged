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

// THE TRANSFORM BOX — the geometry behind the host's Free Transform tool
// and the `host.transformBox@1` door (extensions ADR 339, editor ADR 295).
// Pure functions over plain numbers: no host, no DOM, no engine. The
// editor's Free Transform tool and the SDK's transform-box session both
// run on it, so a bundle's box (an image layer in the raster context) and
// the host's box (page items) hit, drag and constrain identically.
//
// Spaces. A box is a QUAD, four corners in one 2-D space (page-local pt
// for the host; whatever space a bundle names), in the order NW, NE, SE,
// SW. Before any distortion it is a parallelogram (a rectangle at an
// angle); Free Distort and Perspective make it a general quad.
//
// Matrices. `Matrix3` is a 3×3 projective matrix, ROW-MAJOR, acting on
// column vectors: (x, y) ↦ ((m0·x + m1·y + m2) / w, (m3·x + m4·y + m5) / w)
// with w = m6·x + m7·y + m8. An affine one has the last row [0, 0, 1].
//
// Box-local coordinates. Every drag is measured in the box's own unit
// square — (0,0) at NW, (1,1) at SE — through the homography from the
// unit square onto the box at drag start. On a parallelogram that map is
// affine, so a scale or shear in it is the familiar one along the box's
// own axes (a turned box keeps its angle); on a distorted box it scales
// within the perspective, as Photoshop does.

import type {
  ProjectiveMatrix,
  TransformBoxMode,
  TransformBoxOperation,
  TransformQuad,
} from "@paged-media/plugin-api";

/** A point. */
export type Point = [number, number];

/** A box: NW, NE, SE, SW (the contract's `TransformQuad`). */
export type Quad = TransformQuad;

/** A 3×3 projective matrix, row-major (the contract's
 *  `ProjectiveMatrix`; see the module note). */
export type Matrix3 = ProjectiveMatrix;

/** The eight handles of a box, compass-named like the engine's
 *  `ResizeHandle`. */
export type BoxHandle =
  | "northWest"
  | "north"
  | "northEast"
  | "east"
  | "southEast"
  | "south"
  | "southWest"
  | "west";

/** What a press on the box landed on. */
export type BoxHit =
  | { kind: "handle"; handle: BoxHandle }
  | { kind: "rotate"; corner: BoxHandle }
  | { kind: "reference" }
  | { kind: "inside" }
  | { kind: "outside" };

/** The box's mode — Illustrator's touch widget. `freeTransform` reads
 *  the modifiers (Cmd = distort / shear, Cmd+Alt+Shift = perspective);
 *  `constrain` keeps scale proportional; `freeDistort` and `perspective`
 *  make a corner drag that, without modifiers. */
export type BoxMode = TransformBoxMode;

/** What one drag does. */
export type BoxOperation = TransformBoxOperation;

/** Modifier keys as the canvas reports them. */
export interface BoxModifiers {
  shift: boolean;
  alt: boolean;
  cmd: boolean;
  ctrl?: boolean;
}

export const BOX_HANDLES: readonly BoxHandle[] = [
  "northWest",
  "north",
  "northEast",
  "east",
  "southEast",
  "south",
  "southWest",
  "west",
];

const CORNER_INDEX: Partial<Record<BoxHandle, number>> = {
  northWest: 0,
  northEast: 1,
  southEast: 2,
  southWest: 3,
};

/** True for the four corner handles. */
export function isCorner(h: BoxHandle): boolean {
  return CORNER_INDEX[h] !== undefined;
}

/** Each handle's place in the unit square (box-local). */
export const HANDLE_UV: Readonly<Record<BoxHandle, Point>> = {
  northWest: [0, 0],
  north: [0.5, 0],
  northEast: [1, 0],
  east: [1, 0.5],
  southEast: [1, 1],
  south: [0.5, 1],
  southWest: [0, 1],
  west: [0, 0.5],
};

/** The handle across the box from `h`. */
export const OPPOSITE: Readonly<Record<BoxHandle, BoxHandle>> = {
  northWest: "southEast",
  north: "south",
  northEast: "southWest",
  east: "west",
  southEast: "northWest",
  south: "north",
  southWest: "northEast",
  west: "east",
};

/** A CSS cursor for each handle, for a box that is not turned. */
export const HANDLE_CURSOR: Readonly<Record<BoxHandle, string>> = {
  northWest: "nwse-resize",
  north: "ns-resize",
  northEast: "nesw-resize",
  east: "ew-resize",
  southEast: "nwse-resize",
  south: "ns-resize",
  southWest: "nesw-resize",
  west: "ew-resize",
};

/** Hit metrics, screen px (the host's selection handles use the same). */
export const HANDLE_HIT_PX = 6;
export const ROTATE_ZONE_PX = 28;
export const REFERENCE_HIT_PX = 6;

// ───────────────────────────── matrices ─────────────────────────────

export function identity3(): Matrix3 {
  return [1, 0, 0, 0, 1, 0, 0, 0, 1];
}

/** `a · b` (apply `b` first). */
export function multiply3(a: Matrix3, b: Matrix3): Matrix3 {
  const out = new Array(9).fill(0) as Matrix3;
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += a[r * 3 + k]! * b[k * 3 + c]!;
      out[r * 3 + c] = s;
    }
  return out;
}

/** The inverse, or null for a singular matrix. */
export function invert3(m: Matrix3): Matrix3 | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const inv = 1 / det;
  return [
    A * inv,
    -(b * i - c * h) * inv,
    (b * f - c * e) * inv,
    B * inv,
    (a * i - c * g) * inv,
    -(a * f - c * d) * inv,
    C * inv,
    -(a * h - b * g) * inv,
    (a * e - b * d) * inv,
  ];
}

/** Map a point through a projective matrix. */
export function applyMatrix3(m: Matrix3, p: Point): Point {
  const w = m[6] * p[0] + m[7] * p[1] + m[8];
  const iw = Math.abs(w) < 1e-12 ? 0 : 1 / w;
  return [
    (m[0] * p[0] + m[1] * p[1] + m[2]) * iw,
    (m[3] * p[0] + m[4] * p[1] + m[5]) * iw,
  ];
}

/** An IDML/engine affine `[a, b, c, d, tx, ty]` (x' = a·x + c·y + tx). */
export function affineToMatrix3(t: readonly number[]): Matrix3 {
  const [a, b, c, d, tx, ty] = t as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  return [a, c, tx, b, d, ty, 0, 0, 1];
}

/** The affine part of `m` as `[a, b, c, d, tx, ty]`, or null when `m` is
 *  projective (its last row is not [0, 0, 1] up to scale). */
export function matrix3ToAffine(
  m: Matrix3,
): [number, number, number, number, number, number] | null {
  const w = m[8];
  if (Math.abs(w) < 1e-12) return null;
  if (Math.abs(m[6] / w) > 1e-9 || Math.abs(m[7] / w) > 1e-9) return null;
  return [m[0] / w, m[3] / w, m[1] / w, m[4] / w, m[2] / w, m[5] / w];
}

/** True when `m` is affine (no perspective row). */
export function isAffine3(m: Matrix3): boolean {
  return matrix3ToAffine(m) !== null;
}

/**
 * The homography taking `src`'s four corners onto `dst`'s, or null when
 * either quad is degenerate (three corners on one line). The standard
 * direct linear solve with m8 = 1: eight equations, Gaussian elimination
 * with partial pivoting.
 */
export function homographyFromQuads(src: Quad, dst: Quad): Matrix3 | null {
  const A: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i]!;
    const [u, v] = dst[i]!;
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  const n = 8;
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++)
      if (Math.abs(A[r]![col]!) > Math.abs(A[piv]![col]!)) piv = r;
    if (Math.abs(A[piv]![col]!) < 1e-10) return null;
    [A[col], A[piv]] = [A[piv]!, A[col]!];
    const row = A[col]!;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = A[r]![col]! / row[col]!;
      if (f === 0) continue;
      for (let c = col; c <= n; c++) A[r]![c]! -= f * row[c]!;
    }
  }
  const h = A.map((r, i) => r[n]! / r[i]!);
  const m = [...h, 1] as Matrix3;
  return m.every(Number.isFinite) ? m : null;
}

const UNIT: Quad = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

/** The homography from the unit square onto `q`. */
export function unitToQuad(q: Quad): Matrix3 | null {
  return homographyFromQuads(UNIT, q);
}

/** A quad's corners mapped through `m`. */
export function mapQuad(m: Matrix3, q: Quad): Quad {
  return q.map((p) => applyMatrix3(m, p)) as Quad;
}

/** The axis-aligned rectangle `[left, top, right, bottom]` as a quad. */
export function rectQuad(
  left: number,
  top: number,
  right: number,
  bottom: number,
): Quad {
  return [
    [left, top],
    [right, top],
    [right, bottom],
    [left, bottom],
  ];
}

/** Bilinear interpolation over `q` at box-local `(s, t)` — Illustrator's
 *  Free Distort map (straight lines through the box stay straight only
 *  along its two axes). */
export function bilinearPoint(q: Quad, s: number, t: number): Point {
  const [p0, p1, p2, p3] = q;
  const top: Point = [p0[0] + (p1[0] - p0[0]) * s, p0[1] + (p1[1] - p0[1]) * s];
  const bot: Point = [p3[0] + (p2[0] - p3[0]) * s, p3[1] + (p2[1] - p3[1]) * s];
  return [top[0] + (bot[0] - top[0]) * t, top[1] + (bot[1] - top[1]) * t];
}

/** A point map from `from` (a parallelogram — the undistorted box) onto
 *  `to`: `"bilinear"` (Free Distort) or `"projective"` (Perspective and
 *  everything affine). Null when `from` is degenerate. */
export function quadMap(
  from: Quad,
  to: Quad,
  kind: "bilinear" | "projective",
): ((p: Point) => Point) | null {
  if (kind === "projective") {
    const h = homographyFromQuads(from, to);
    return h ? (p) => applyMatrix3(h, p) : null;
  }
  const local = unitToQuad(from);
  const inv = local ? invert3(local) : null;
  if (!inv) return null;
  return (p) => {
    const [s, t] = applyMatrix3(inv, p);
    return bilinearPoint(to, s, t);
  };
}

// ───────────────────────────── the box ──────────────────────────────

/** Where handle `h` sits on `q` (corners exactly; sides at the edge's
 *  midpoint). */
export function handlePoint(q: Quad, h: BoxHandle): Point {
  const ci = CORNER_INDEX[h];
  if (ci !== undefined) return q[ci]!;
  const mid = (a: Point, b: Point): Point => [
    (a[0] + b[0]) / 2,
    (a[1] + b[1]) / 2,
  ];
  switch (h) {
    case "north":
      return mid(q[0], q[1]);
    case "east":
      return mid(q[1], q[2]);
    case "south":
      return mid(q[2], q[3]);
    default:
      return mid(q[3], q[0]);
  }
}

/** The box's centre (the intersection of its diagonals' midpoints'
 *  mean — the centroid of the corners). */
export function quadCentre(q: Quad): Point {
  return [
    (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4,
    (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4,
  ];
}

/** Is `p` inside the (convex or not) quad? Even-odd ray cast. */
export function pointInQuad(q: Quad, p: Point): boolean {
  let inside = false;
  for (let i = 0, j = 3; i < 4; j = i++) {
    const [xi, yi] = q[i]!;
    const [xj, yj] = q[j]!;
    if (yi > p[1] !== yj > p[1]) {
      const x = ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi;
      if (p[0] < x) inside = !inside;
    }
  }
  return inside;
}

/** The handle's cursor, turned with the box: the compass cursor nearest
 *  the handle's outward direction. */
export function handleCursor(q: Quad, h: BoxHandle): string {
  const c = quadCentre(q);
  const p = handlePoint(q, h);
  const deg = (Math.atan2(p[1] - c[1], p[0] - c[0]) * 180) / Math.PI;
  // 0° = east; the four resize cursors repeat every 180°.
  const a = ((deg % 180) + 180) % 180;
  if (a < 22.5 || a >= 157.5) return "ew-resize";
  if (a < 67.5) return "nwse-resize";
  if (a < 112.5) return "ns-resize";
  return "nesw-resize";
}

/**
 * What a press at `p` lands on. `unitsPerPx` converts the screen-px
 * metrics into the box's space (1 / camera scale for page pt). Order is
 * the host chrome's: the reference point, then the handles (on the box's
 * corners and edge midpoints), then the rotate zone just OUTSIDE a corner,
 * then inside the box (move), else outside.
 */
export function hitTestBox(
  q: Quad,
  p: Point,
  unitsPerPx: number,
  reference?: Point | null,
): BoxHit {
  const d = (a: Point) => Math.hypot(a[0] - p[0], a[1] - p[1]);
  if (reference && d(reference) <= REFERENCE_HIT_PX * unitsPerPx)
    return { kind: "reference" };
  const hr = HANDLE_HIT_PX * unitsPerPx;
  let best: BoxHandle | null = null;
  let bestD = Infinity;
  for (const h of BOX_HANDLES) {
    const hp = handlePoint(q, h);
    const dx = Math.abs(hp[0] - p[0]);
    const dy = Math.abs(hp[1] - p[1]);
    if (dx <= hr && dy <= hr && Math.hypot(dx, dy) < bestD) {
      best = h;
      bestD = Math.hypot(dx, dy);
    }
  }
  if (best) return { kind: "handle", handle: best };
  const inside = pointInQuad(q, p);
  if (!inside) {
    const rz = ROTATE_ZONE_PX * unitsPerPx;
    for (const h of [
      "northWest",
      "northEast",
      "southEast",
      "southWest",
    ] as const) {
      if (d(handlePoint(q, h)) <= rz) return { kind: "rotate", corner: h };
    }
    return { kind: "outside" };
  }
  return { kind: "inside" };
}

/** Which operation a press on `hit` starts, under `mode` and the press's
 *  modifiers. `null` for a press that starts nothing (outside the box). */
export function operationFor(
  hit: BoxHit,
  mode: BoxMode,
  m: BoxModifiers,
): BoxOperation | null {
  switch (hit.kind) {
    case "reference":
      return "reference";
    case "inside":
      return "move";
    case "rotate":
      return "rotate";
    case "outside":
      return null;
    case "handle": {
      const corner = isCorner(hit.handle);
      if (mode === "perspective") return corner ? "perspective" : "scale";
      // Free Distort: a corner moves alone, a side moves its edge.
      if (mode === "freeDistort") return "distort";
      if (m.cmd) {
        if (!corner) return "shear";
        return m.alt && m.shift ? "perspective" : "distort";
      }
      return "scale";
    }
  }
}

const snap15 = (rad: number) => {
  const step = Math.PI / 12;
  return Math.round(rad / step) * step;
};

/** The state one drag starts from. */
export interface BoxDragStart {
  /** The box when the drag began. */
  quad: Quad;
  /** The press, in the box's space. */
  start: Point;
  /** What was hit. */
  hit: BoxHit;
  /** The operation (`operationFor`). */
  op: BoxOperation;
  /** The reference point (rotation pivot); the centre when absent. */
  reference?: Point | null;
}

/** The result of one drag step. */
export interface BoxDragResult {
  quad: Quad;
  /** Box-to-box map for this drag: `start quad → quad`. Null when the
   *  drag made the box degenerate (the caller keeps the last good one). */
  matrix: Matrix3 | null;
  /** The reference point after the step (moves with a move; is the
   *  dragged point for a `reference` drag). */
  reference: Point;
  /** The numbers the step stands for, for a readout. */
  readout: {
    dx?: number;
    dy?: number;
    sx?: number;
    sy?: number;
    angle?: number;
    shear?: number;
  };
}

/**
 * One drag step: the box after dragging from `s.start` to `now` with
 * `m` held (live — a modifier pressed mid-drag applies at once).
 * `mode === "constrain"` holds Shift for a scale.
 */
export function dragBox(
  s: BoxDragStart,
  now: Point,
  m: BoxModifiers,
  mode: BoxMode = "freeTransform",
): BoxDragResult {
  const q = s.quad;
  const ref = s.reference ?? quadCentre(q);
  const delta: Point = [now[0] - s.start[0], now[1] - s.start[1]];
  const done = (
    quad: Quad,
    reference: Point,
    readout: BoxDragResult["readout"],
  ): BoxDragResult => ({
    quad,
    matrix: homographyFromQuads(q, quad),
    reference,
    readout,
  });
  switch (s.op) {
    case "reference":
      return { quad: q, matrix: identity3(), reference: now, readout: {} };
    case "move": {
      let [dx, dy] = delta;
      if (m.shift) {
        if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      const quad = q.map(([x, y]) => [x + dx, y + dy]) as Quad;
      return done(quad, [ref[0] + dx, ref[1] + dy], { dx, dy });
    }
    case "rotate": {
      let theta =
        Math.atan2(now[1] - ref[1], now[0] - ref[0]) -
        Math.atan2(s.start[1] - ref[1], s.start[0] - ref[0]);
      if (m.shift) theta = snap15(theta);
      const c = Math.cos(theta);
      const sn = Math.sin(theta);
      const quad = q.map(([x, y]) => [
        ref[0] + c * (x - ref[0]) - sn * (y - ref[1]),
        ref[1] + sn * (x - ref[0]) + c * (y - ref[1]),
      ]) as Quad;
      return done(quad, ref, { angle: (theta * 180) / Math.PI });
    }
    case "scale":
    case "shear": {
      if (s.hit.kind !== "handle") return done(q, ref, {});
      const h = s.hit.handle;
      const toWorld = unitToQuad(q);
      const toLocal = toWorld ? invert3(toWorld) : null;
      if (!toWorld || !toLocal) return done(q, ref, {});
      const g = HANDLE_UV[h];
      const pivot: Point = m.alt ? [0.5, 0.5] : HANDLE_UV[OPPOSITE[h]];
      // The grabbed handle, moved with the pointer, in box-local space.
      const hp = handlePoint(q, h);
      const cur = applyMatrix3(toLocal, [hp[0] + delta[0], hp[1] + delta[1]]);
      if (s.op === "scale") {
        const ratio = (axis: 0 | 1) => {
          const held = g[axis] - pivot[axis];
          return Math.abs(held) < 1e-9
            ? null
            : (cur[axis] - pivot[axis]) / held;
        };
        let sx = ratio(0);
        let sy = ratio(1);
        const proportional = m.shift !== (mode === "constrain");
        if (proportional) {
          if (sx === null) sx = sy;
          else if (sy === null) sy = sx;
          else {
            const dom = Math.abs(sx - 1) >= Math.abs(sy - 1) ? sx : sy;
            sx = dom;
            sy = dom;
          }
        }
        const fx = sx ?? 1;
        const fy = sy ?? 1;
        const local = UNIT.map(([u, v]) => [
          pivot[0] + fx * (u - pivot[0]),
          pivot[1] + fy * (v - pivot[1]),
        ]) as Quad;
        return done(
          mapQuad(toWorld, local),
          mapRef(toWorld, toLocal, ref, (u, v) => [
            pivot[0] + fx * (u - pivot[0]),
            pivot[1] + fy * (v - pivot[1]),
          ]),
          { sx: fx, sy: fy },
        );
      }
      // Shear: a north/south handle slants along the box's u axis, an
      // east/west one along v; the opposite side holds (the centre line
      // with Alt).
      const alongU = h === "north" || h === "south";
      const lever = alongU ? g[1] - pivot[1] : g[0] - pivot[0];
      if (Math.abs(lever) < 1e-9) return done(q, ref, {});
      let k = alongU ? (cur[0] - g[0]) / lever : (cur[1] - g[1]) / lever;
      if (m.shift) {
        // Snap the slant angle in the box's own (world-measured) axes.
        const len = (a: Point, b: Point) =>
          Math.hypot(b[0] - a[0], b[1] - a[1]);
        const w = len(q[0], q[1]) || 1;
        const hgt = len(q[0], q[3]) || 1;
        const worldK = alongU ? (k * w) / hgt : (k * hgt) / w;
        const snapped = Math.tan(snap15(Math.atan(worldK)));
        k = alongU ? (snapped * hgt) / w : (snapped * w) / hgt;
      }
      const f = (u: number, v: number): Point =>
        alongU ? [u + k * (v - pivot[1]), v] : [u, v + k * (u - pivot[0])];
      const local = UNIT.map(([u, v]) => f(u, v)) as Quad;
      return done(mapQuad(toWorld, local), mapRef(toWorld, toLocal, ref, f), {
        shear: k,
      });
    }
    case "distort": {
      if (s.hit.kind !== "handle") return done(q, ref, {});
      const h = s.hit.handle;
      let [dx, dy] = delta;
      if (m.shift) {
        if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      const quad = q.map((p) => [p[0], p[1]] as Point) as Quad;
      const ci = CORNER_INDEX[h];
      if (ci !== undefined) {
        quad[ci] = [q[ci]![0] + dx, q[ci]![1] + dy];
      } else {
        // A side moves its edge (both of its corners).
        const [a, b] = SIDE_CORNERS[h]!;
        quad[a] = [q[a]![0] + dx, q[a]![1] + dy];
        quad[b] = [q[b]![0] + dx, q[b]![1] + dy];
      }
      return done(quad, quadCentre(quad), { dx, dy });
    }
    case "perspective": {
      if (s.hit.kind !== "handle") return done(q, ref, {});
      const ci = CORNER_INDEX[s.hit.handle];
      if (ci === undefined) return done(q, ref, {});
      const [dx, dy] = delta;
      const quad = q.map((p) => [p[0], p[1]] as Point) as Quad;
      // The dominant axis picks the edge the corner slides along; its
      // partner on that edge slides the other way, so the box stays
      // symmetric about its axis — a perspective, not a skew.
      if (Math.abs(dx) >= Math.abs(dy)) {
        const partner = H_PARTNER[ci]!;
        quad[ci] = [q[ci]![0] + dx, q[ci]![1]];
        quad[partner] = [q[partner]![0] - dx, q[partner]![1]];
      } else {
        const partner = V_PARTNER[ci]!;
        quad[ci] = [q[ci]![0], q[ci]![1] + dy];
        quad[partner] = [q[partner]![0], q[partner]![1] - dy];
      }
      return done(quad, quadCentre(quad), { dx, dy });
    }
  }
}

/** The reference point carried through a local-space map. */
function mapRef(
  toWorld: Matrix3,
  toLocal: Matrix3,
  ref: Point,
  f: (u: number, v: number) => Point,
): Point {
  const [u, v] = applyMatrix3(toLocal, ref);
  return applyMatrix3(toWorld, f(u, v));
}

/** A side handle's two corners. */
const SIDE_CORNERS: Partial<Record<BoxHandle, [number, number]>> = {
  north: [0, 1],
  east: [1, 2],
  south: [2, 3],
  west: [3, 0],
};
/** The corner sharing a corner's horizontal edge (NW↔NE, SW↔SE). */
const H_PARTNER = [1, 0, 3, 2];
/** The corner sharing a corner's vertical edge (NW↔SW, NE↔SE). */
const V_PARTNER = [3, 2, 1, 0];

/** Is the quad usable — convex, non-degenerate, corners in a consistent
 *  turning order? A drag that would fold the box is refused by keeping
 *  the last good quad. */
export function isUsableQuad(q: Quad): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i]!;
    const b = q[(i + 1) % 4]!;
    const c = q[(i + 2) % 4]!;
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) < 1e-9) return false;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

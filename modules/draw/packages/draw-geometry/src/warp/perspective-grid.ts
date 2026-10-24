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

// THE PERSPECTIVE GRID — Illustrator's one-, two- and three-point grids as
// data, and the homography of each of their three planes.
//
// THE MODEL. A grid lives on one page (page pt, y down):
//
//   · the HORIZON is the line y = `horizonY`; the left / right (2-, 3-
//     point) or the single centre (1-point) VANISHING POINT sits on it at
//     x = `vpLeft` / `vpRight` / `vpCenter`;
//   · the ORIGIN is the ground-level point where the planes meet (the
//     station point's foot — Illustrator's ground-level widget). Dragging
//     it moves the whole grid;
//   · a 3-point grid adds the VERTICAL vanishing point straight above or
//     below the origin at y = `vpVertical`;
//   · each plane has two AXES from the origin. An axis is either FINITE —
//     it runs to a vanishing point, and a plane distance s lands at
//     O + (VP − O)·s/(s + D), D = |VP − O|, so one plane pt is one page pt
//     AT the origin and the axis foreshortens toward its VP — or INFINITE
//     (parallel to the picture plane): O + s·dir.
//
//   2-point / 3-point: LEFT plane = (toward vpLeft, up); RIGHT plane =
//   (toward vpRight, up); FLOOR = (toward vpRight, toward vpLeft). "Up" is
//   the page's −y in 2-point and the run toward the vertical VP in 3-point.
//   1-point: LEFT = the FRONTAL plane (right, up — no foreshortening),
//   from the origin rightward; RIGHT = the side wall, standing on the
//   frontal plane's right edge and running toward the VP (up); FLOOR =
//   (right, toward the VP) from the origin.
//
// THE PLANE MAP. A point (u, v) of a plane is the intersection of the
// line from its u-axis point toward the v-axis's vanishing point with the
// line from its v-axis point toward the u-axis's — which IS a homography,
// because both axes are parametrised projectively (a Möbius map of the
// line). `planeHomography` solves it from four such points. Its domain is
// the OBJECT frame of the plane: (x right, y down) as an object is drawn
// on the page, with the left plane mirrored so an object's right side
// faces the origin (Illustrator's convention: artwork attached to the
// left plane is not drawn mirror-imaged).
//
// Pure, deterministic, no host types — the perspective-grid half of the
// future `paged-warp` crate.

import type { AnchorTable, AnchorTriple, Vec2, Vec2Mut } from "../types";
import {
  applyHomography,
  homographyFromQuads,
  invertHomography,
  mapTableProjective,
  type Homography,
} from "./homography";

export type GridKind = 1 | 2 | 3;
export type PlaneId = "left" | "right" | "floor";
export const PLANE_IDS: readonly PlaneId[] = ["left", "right", "floor"];

export interface PerspectiveGrid {
  kind: GridKind;
  horizonY: number;
  origin: Vec2Mut;
  /** 2-/3-point: the left and right vanishing points' x on the horizon. */
  vpLeft: number;
  vpRight: number;
  /** 1-point: the vanishing point's x on the horizon. */
  vpCenter: number;
  /** 3-point: the vertical vanishing point's y (above or below). */
  vpVertical: number;
  /** pt — one grid cell, on the plane at the origin. */
  cell: number;
  /** How far each plane extends, in cells: the left/right planes' run
   *  along the ground, their height, and the floor's two runs. */
  extentLeft: number;
  extentRight: number;
  extentHeight: number;
  visible: boolean;
  locked: boolean;
  activePlane: PlaneId | "none";
}

/** Illustrator-like default grids for a `w` × `h` pt page. */
export function defaultGrid(
  kind: GridKind,
  w: number,
  h: number,
): PerspectiveGrid {
  const base: PerspectiveGrid = {
    kind,
    horizonY: h * 0.45,
    origin: [w * 0.5, h * 0.72],
    vpLeft: -w * 0.35,
    vpRight: w * 1.35,
    vpCenter: w * 0.5,
    vpVertical: h * 2.6,
    cell: 24,
    extentLeft: 10,
    extentRight: 10,
    extentHeight: 8,
    visible: true,
    locked: false,
    activePlane: "left",
  };
  if (kind === 1) {
    base.origin = [w * 0.2, h * 0.72];
    base.extentLeft = 12;
  }
  return base;
}

type Axis = { vp: Vec2Mut } | { dir: Vec2Mut };

const UP: Vec2Mut = [0, -1];
const RIGHT: Vec2Mut = [1, 0];

/** The two axes of a plane (u, then v). */
export function planeAxes(g: PerspectiveGrid, plane: PlaneId): [Axis, Axis] {
  const h = g.horizonY;
  const up: Axis =
    g.kind === 3 ? { vp: [g.origin[0], g.vpVertical] } : { dir: UP };
  if (g.kind === 1) {
    const vp: Axis = { vp: [g.vpCenter, h] };
    if (plane === "left") return [{ dir: RIGHT }, { dir: UP }];
    if (plane === "right") return [vp, { dir: UP }];
    return [{ dir: RIGHT }, vp];
  }
  const left: Axis = { vp: [g.vpLeft, h] };
  const right: Axis = { vp: [g.vpRight, h] };
  if (plane === "left") return [left, up];
  if (plane === "right") return [right, up];
  return [right, left];
}

/** Where a plane's axes start: the grid origin, except the 1-point side
 *  wall, which stands on the frontal plane's right edge. */
export function planeOrigin(g: PerspectiveGrid, plane: PlaneId): Vec2Mut {
  if (g.kind === 1 && plane === "right")
    return [g.origin[0] + g.extentLeft * g.cell, g.origin[1]];
  return [g.origin[0], g.origin[1]];
}

/** The point at plane distance `s` along `axis` from `o`. */
export function axisPoint(o: Vec2, axis: Axis, s: number): Vec2Mut {
  if ("dir" in axis) return [o[0] + axis.dir[0] * s, o[1] + axis.dir[1] * s];
  const dx = axis.vp[0] - o[0];
  const dy = axis.vp[1] - o[1];
  const d = Math.hypot(dx, dy);
  if (d < 1e-9) return [o[0], o[1]];
  // s → ∞ approaches the VP; s → −d would be the line at infinity.
  const k = s / (s + d);
  return [o[0] + dx * k, o[1] + dy * k];
}

/** The line through `p` toward the axis's vanishing direction. */
const lineToward = (p: Vec2, axis: Axis): [Vec2, Vec2] =>
  "dir" in axis ? [p, [p[0] + axis.dir[0], p[1] + axis.dir[1]]] : [p, axis.vp];

function intersect(a: [Vec2, Vec2], b: [Vec2, Vec2]): Vec2Mut | null {
  const [p, p2] = a;
  const [q, q2] = b;
  const r: Vec2 = [p2[0] - p[0], p2[1] - p[1]];
  const s: Vec2 = [q2[0] - q[0], q2[1] - q[1]];
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-12) return null;
  const t = ((q[0] - p[0]) * s[1] - (q[1] - p[1]) * s[0]) / den;
  return [p[0] + r[0] * t, p[1] + r[1] * t];
}

/** The plane point (u, v) on the page, by construction (the homography's
 *  reference; `planeHomography` agrees with it everywhere). */
export function planePointByConstruction(
  g: PerspectiveGrid,
  plane: PlaneId,
  u: number,
  v: number,
): Vec2Mut | null {
  const [au, av] = planeAxes(g, plane);
  const o = planeOrigin(g, plane);
  const A = axisPoint(o, au, u);
  const B = axisPoint(o, av, v);
  if ("dir" in au && "dir" in av)
    return [
      o[0] + au.dir[0] * u + av.dir[0] * v,
      o[1] + au.dir[1] * u + av.dir[1] * v,
    ];
  return intersect(lineToward(A, av), lineToward(B, au));
}

/** Does the plane's object frame run mirrored (u = −x)? Only the 2-/3-
 *  point LEFT plane, whose u axis runs AWAY from the origin to the left. */
const mirrored = (g: PerspectiveGrid, plane: PlaneId): boolean =>
  plane === "left" && g.kind !== 1;

/** The object-frame flip of a plane: object (x right, y down) → plane
 *  (u, v). */
const objectToUv = (g: PerspectiveGrid, plane: PlaneId, p: Vec2): Vec2Mut =>
  mirrored(g, plane) ? [-p[0], -p[1]] : [p[0], -p[1]];

/**
 * The homography from the plane's OBJECT frame (x right, y down, pt; the
 * origin at the grid origin) to the page. Null for a degenerate grid
 * (a vanishing point on the origin).
 */
export function planeHomography(
  g: PerspectiveGrid,
  plane: PlaneId,
): Homography | null {
  const S = Math.max(g.cell, 1) * 4;
  const objs: [Vec2, Vec2, Vec2, Vec2] = [
    [0, 0],
    [S, 0],
    [S, -S],
    [0, -S],
  ];
  // Object frame → (u, v): the left plane runs mirrored.
  const pts = objs.map((o) => {
    const [u, v] = objectToUv(g, plane, o);
    return planePointByConstruction(g, plane, u, v);
  });
  if (pts.some((p) => !p)) return null;
  return homographyFromQuads(objs, pts as unknown as [Vec2, Vec2, Vec2, Vec2]);
}

/** A page point on the plane, in the plane's object frame. */
export function pageToPlane(
  g: PerspectiveGrid,
  plane: PlaneId,
  p: Vec2,
): Vec2Mut | null {
  const h = planeHomography(g, plane);
  const inv = h ? invertHomography(h) : null;
  return inv ? applyHomography(inv, p) : null;
}

/** An object-frame point of the plane, on the page. */
export function planeToPage(
  g: PerspectiveGrid,
  plane: PlaneId,
  p: Vec2,
): Vec2Mut | null {
  const h = planeHomography(g, plane);
  return h ? applyHomography(h, p) : null;
}

/** The plane's extent in its object frame: [x0, y0, x1, y1]. */
export function planeExtent(
  g: PerspectiveGrid,
  plane: PlaneId,
): [number, number, number, number] {
  const c = g.cell;
  if (plane === "left") {
    // 2-/3-point: u runs 0..extentLeft toward the left VP, mirrored in x;
    // 1-point: the frontal plane runs rightward.
    return mirrored(g, plane)
      ? [-g.extentLeft * c, -g.extentHeight * c, 0, 0]
      : [0, -g.extentHeight * c, g.extentLeft * c, 0];
  }
  if (plane === "right") return [0, -g.extentHeight * c, g.extentRight * c, 0];
  return [0, -g.extentLeft * c, g.extentRight * c, 0];
}

/** The plane's quad on the page (object-frame corners in order
 *  (x0,y1) (x1,y1) (x1,y0) (x0,y0)). */
export function planeQuad(
  g: PerspectiveGrid,
  plane: PlaneId,
): Vec2Mut[] | null {
  const [x0, y0, x1, y1] = planeExtent(g, plane);
  const h = planeHomography(g, plane);
  if (!h) return null;
  const out = (
    [
      [x0, y1],
      [x1, y1],
      [x1, y0],
      [x0, y0],
    ] as Vec2[]
  ).map((p) => applyHomography(h, p));
  return out.some((p) => !p) ? null : (out as Vec2Mut[]);
}

/** The grid lines of a plane, page space, each a two-point segment. */
export function planeGridLines(
  g: PerspectiveGrid,
  plane: PlaneId,
): Vec2Mut[][] {
  const h = planeHomography(g, plane);
  if (!h) return [];
  const [x0, y0, x1, y1] = planeExtent(g, plane);
  const c = g.cell;
  const out: Vec2Mut[][] = [];
  const seg = (a: Vec2, b: Vec2) => {
    const p = applyHomography(h, a);
    const q = applyHomography(h, b);
    if (p && q) out.push([p, q]);
  };
  for (let x = x0; x <= x1 + 1e-9; x += c) seg([x, y0], [x, y1]);
  for (let y = y0; y <= y1 + 1e-9; y += c) seg([x0, y], [x1, y]);
  return out;
}

/** Is page point `p` on `plane` (inside its extent)? */
export function onPlane(g: PerspectiveGrid, plane: PlaneId, p: Vec2): boolean {
  const q = pageToPlane(g, plane, p);
  if (!q) return false;
  const [x0, y0, x1, y1] = planeExtent(g, plane);
  return (
    q[0] >= x0 - 1e-6 &&
    q[0] <= x1 + 1e-6 &&
    q[1] >= y0 - 1e-6 &&
    q[1] <= y1 + 1e-6
  );
}

// ------------------------------------------------------------- widgets

export type GridHandleId =
  | "horizon"
  | "origin"
  | "vpLeft"
  | "vpRight"
  | "vpCenter"
  | "vpVertical"
  | "extentLeft"
  | "extentRight"
  | "extentHeight"
  | "cell";

export interface GridHandle {
  id: GridHandleId;
  point: Vec2Mut;
}

/** The grid's on-canvas handles (page space) for its kind. */
export function gridHandles(g: PerspectiveGrid): GridHandle[] {
  const out: GridHandle[] = [];
  const h = g.horizonY;
  out.push({ id: "origin", point: [g.origin[0], g.origin[1]] });
  if (g.kind === 1) {
    out.push({ id: "vpCenter", point: [g.vpCenter, h] });
    // The horizon handle sits on the horizon, beside the VP.
    out.push({ id: "horizon", point: [g.origin[0], h] });
  } else {
    out.push({ id: "vpLeft", point: [g.vpLeft, h] });
    out.push({ id: "vpRight", point: [g.vpRight, h] });
    out.push({ id: "horizon", point: [g.origin[0], h] });
    if (g.kind === 3)
      out.push({ id: "vpVertical", point: [g.origin[0], g.vpVertical] });
  }
  const at = (plane: PlaneId, p: Vec2) => planeToPage(g, plane, p);
  const c = g.cell;
  const l = at(
    "left",
    g.kind === 1 ? [g.extentLeft * c, 0] : [-g.extentLeft * c, 0],
  );
  if (l) out.push({ id: "extentLeft", point: l });
  const r = at("right", [g.extentRight * c, 0]);
  if (r) out.push({ id: "extentRight", point: r });
  const t = at("right", [0, -g.extentHeight * c]);
  if (t) out.push({ id: "extentHeight", point: t });
  const cellHandle = at("right", [c, -c]);
  if (cellHandle) out.push({ id: "cell", point: cellHandle });
  return out;
}

/** The handle nearest `p` within `tolerance`, or null. */
export function gridHandleAt(
  g: PerspectiveGrid,
  p: Vec2,
  tolerance: number,
): GridHandleId | null {
  let best: GridHandleId | null = null;
  let bestD = tolerance;
  for (const h of gridHandles(g)) {
    const d = Math.hypot(h.point[0] - p[0], h.point[1] - p[1]);
    if (d <= bestD) {
      bestD = d;
      best = h.id;
    }
  }
  return best;
}

const MIN_VP_GAP = 4;

/**
 * The grid with handle `id` dragged to page point `to` (pure). The origin
 * moves the whole grid; the horizon moves vertically (its vanishing
 * points with it); each vanishing point slides along the horizon (the
 * vertical one along the origin's vertical) and never onto the origin;
 * the extent handles set the planes' sizes in whole cells; the cell
 * handle sets the cell size.
 */
export function moveGridHandle(
  g: PerspectiveGrid,
  id: GridHandleId,
  to: Vec2,
): PerspectiveGrid {
  const n: PerspectiveGrid = { ...g, origin: [g.origin[0], g.origin[1]] };
  switch (id) {
    case "origin": {
      const dx = to[0] - g.origin[0];
      const dy = to[1] - g.origin[1];
      n.origin = [to[0], to[1]];
      n.horizonY = g.horizonY + dy;
      n.vpLeft = g.vpLeft + dx;
      n.vpRight = g.vpRight + dx;
      n.vpCenter = g.vpCenter + dx;
      n.vpVertical = g.vpVertical + dy;
      return n;
    }
    case "horizon":
      // The horizon stays off the origin's ground point.
      n.horizonY =
        Math.abs(to[1] - g.origin[1]) < MIN_VP_GAP ? g.horizonY : to[1];
      return n;
    case "vpLeft":
      n.vpLeft = Math.min(to[0], g.origin[0] - MIN_VP_GAP);
      return n;
    case "vpRight":
      n.vpRight = Math.max(to[0], g.origin[0] + MIN_VP_GAP);
      return n;
    case "vpCenter":
      n.vpCenter = to[0];
      return n;
    case "vpVertical":
      n.vpVertical =
        Math.abs(to[1] - g.origin[1]) < MIN_VP_GAP ? g.vpVertical : to[1];
      return n;
    case "extentLeft": {
      const q = pageToPlane(g, "left", to);
      if (q) {
        const cells = g.kind === 1 ? q[0] / g.cell : -q[0] / g.cell;
        n.extentLeft = Math.max(1, Math.round(cells));
      }
      return n;
    }
    case "extentRight": {
      const q = pageToPlane(g, "right", to);
      if (q) n.extentRight = Math.max(1, Math.round(q[0] / g.cell));
      return n;
    }
    case "extentHeight": {
      const q = pageToPlane(g, "right", to);
      if (q) n.extentHeight = Math.max(1, Math.round(-q[1] / g.cell));
      return n;
    }
    case "cell": {
      const q = pageToPlane(g, "right", to);
      if (q) n.cell = Math.max(2, Math.min(500, (q[0] - q[1]) / 2));
      return n;
    }
  }
}

// ------------------------------------------------- drawing on a plane

const corner = (p: Vec2Mut): AnchorTriple => ({
  anchor: p,
  left: [p[0], p[1]],
  right: [p[0], p[1]],
});

/** A rectangle [x0,y0]-[x1,y1] in a plane's object frame (flat). */
export function flatRect(a: Vec2, b: Vec2): AnchorTable {
  const x0 = Math.min(a[0], b[0]);
  const x1 = Math.max(a[0], b[0]);
  const y0 = Math.min(a[1], b[1]);
  const y1 = Math.max(a[1], b[1]);
  return {
    anchors: [
      corner([x0, y0]),
      corner([x1, y0]),
      corner([x1, y1]),
      corner([x0, y1]),
    ],
    subpathStarts: [0],
    subpathOpen: [false],
  };
}

/** The ellipse inscribed in [a, b] (four cubic quarter arcs; κ =
 *  0.5523), flat. */
export function flatEllipse(a: Vec2, b: Vec2): AnchorTable {
  const cx = (a[0] + b[0]) / 2;
  const cy = (a[1] + b[1]) / 2;
  const rx = Math.abs(b[0] - a[0]) / 2;
  const ry = Math.abs(b[1] - a[1]) / 2;
  const k = 0.5522847498307936;
  const pt = (x: number, y: number): Vec2Mut => [x, y];
  return {
    anchors: [
      {
        anchor: pt(cx, cy - ry),
        left: pt(cx - k * rx, cy - ry),
        right: pt(cx + k * rx, cy - ry),
      },
      {
        anchor: pt(cx + rx, cy),
        left: pt(cx + rx, cy - k * ry),
        right: pt(cx + rx, cy + k * ry),
      },
      {
        anchor: pt(cx, cy + ry),
        left: pt(cx + k * rx, cy + ry),
        right: pt(cx - k * rx, cy + ry),
      },
      {
        anchor: pt(cx - rx, cy),
        left: pt(cx - rx, cy + k * ry),
        right: pt(cx - rx, cy - k * ry),
      },
    ],
    subpathStarts: [0],
    subpathOpen: [false],
  };
}

/** Translate a flat table (pure). */
export function translateTable(t: AnchorTable, d: Vec2): AnchorTable {
  const m = (p: Vec2): Vec2Mut => [p[0] + d[0], p[1] + d[1]];
  return {
    anchors: t.anchors.map((a) => ({
      anchor: m(a.anchor),
      left: m(a.left),
      right: m(a.right),
    })),
    subpathStarts: [...t.subpathStarts],
    ...(t.subpathOpen ? { subpathOpen: [...t.subpathOpen] } : {}),
  };
}

/** A flat (object-frame) table projected onto the plane, page space;
 *  curves subdivided to `tolerance` pt. */
export function projectOntoPlane(
  g: PerspectiveGrid,
  plane: PlaneId,
  flat: AnchorTable,
  tolerance = 0.1,
): AnchorTable | null {
  const h = planeHomography(g, plane);
  return h ? mapTableProjective(flat, h, tolerance) : null;
}

/**
 * ATTACH: page-space artwork `table` put onto `plane` so its point
 * `grab` lands at the page point `drop` — its geometry, measured in page
 * pt from `grab`, becomes the plane's object-frame geometry from the
 * plane point under `drop`. Answers the flat table (object frame) and its
 * projection; null when `drop` is not on the plane's map.
 */
export function attachToPlane(
  g: PerspectiveGrid,
  plane: PlaneId,
  table: AnchorTable,
  grab: Vec2,
  drop: Vec2,
  tolerance = 0.1,
): { flat: AnchorTable; page: AnchorTable } | null {
  const at = pageToPlane(g, plane, drop);
  if (!at) return null;
  const flat = translateTable(table, [at[0] - grab[0], at[1] - grab[1]]);
  const page = projectOntoPlane(g, plane, flat, tolerance);
  return page ? { flat, page } : null;
}

/** MOVE ALONG THE PLANE: the flat table moved by the plane-space delta
 *  between two page points, and its projection. */
export function moveOnPlane(
  g: PerspectiveGrid,
  plane: PlaneId,
  flat: AnchorTable,
  from: Vec2,
  to: Vec2,
  tolerance = 0.1,
): { flat: AnchorTable; page: AnchorTable } | null {
  const a = pageToPlane(g, plane, from);
  const b = pageToPlane(g, plane, to);
  if (!a || !b) return null;
  const moved = translateTable(flat, [b[0] - a[0], b[1] - a[1]]);
  const page = projectOntoPlane(g, plane, moved, tolerance);
  return page ? { flat: moved, page } : null;
}

/** Validate / repair a grid read from storage (tolerant). Null when the
 *  value is not a grid. */
export function parseGrid(v: unknown): PerspectiveGrid | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const num = (x: unknown, d: number) =>
    typeof x === "number" && Number.isFinite(x) ? x : d;
  const kind = o.kind === 1 || o.kind === 2 || o.kind === 3 ? o.kind : null;
  if (!kind) return null;
  const origin =
    Array.isArray(o.origin) && o.origin.length === 2 ? o.origin : null;
  if (!origin) return null;
  const d = defaultGrid(kind, 612, 792);
  const plane =
    o.activePlane === "left" ||
    o.activePlane === "right" ||
    o.activePlane === "floor" ||
    o.activePlane === "none"
      ? o.activePlane
      : d.activePlane;
  return {
    kind,
    horizonY: num(o.horizonY, d.horizonY),
    origin: [num(origin[0], d.origin[0]), num(origin[1], d.origin[1])],
    vpLeft: num(o.vpLeft, d.vpLeft),
    vpRight: num(o.vpRight, d.vpRight),
    vpCenter: num(o.vpCenter, d.vpCenter),
    vpVertical: num(o.vpVertical, d.vpVertical),
    cell: Math.max(2, num(o.cell, d.cell)),
    extentLeft: Math.max(1, num(o.extentLeft, d.extentLeft)),
    extentRight: Math.max(1, num(o.extentRight, d.extentRight)),
    extentHeight: Math.max(1, num(o.extentHeight, d.extentHeight)),
    visible: o.visible !== false,
    locked: o.locked === true,
    activePlane: plane,
  };
}

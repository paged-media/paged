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

// THE LIQUIFY FAMILY — Illustrator's seven brush distortions (Warp,
// Twirl, Pucker, Bloat, Scallop, Crystallize, Wrinkle) as pure functions
// over anchor tables. No host, no engine: page pt in, page pt out, so the
// same functions port one-for-one to the `paged-warp` crate the master
// plan names (one API that maps points for vectors and samples backward
// for pixels — these are the forward, point-mapping half).
//
// THE BRUSH is an ellipse: `width` × `height` pt, rotated by `angleDeg`,
// centred on the pointer. A point's WEIGHT is a smooth bump of its
// normalised elliptical distance r (0 at the centre, 1 on the rim):
// `(1 − r²)²` inside, 0 outside — C¹ at the rim, so a drag never kinks a
// path where the brush leaves it. `strength` (Illustrator's Intensity,
// or the pen's pressure when "use pressure" is on) scales every kernel.
//
// ONE STEP is one pointer sample (or one dwell tick while the pointer
// rests: Illustrator keeps twirling / puckering as long as the button is
// held). A step:
//   1. DENSIFIES the segments the brush reaches — de Casteljau halving,
//      so the curve does not move — until each is at most `spacing` long
//      (`liquifySpacing`: the brush's smaller radius over `detail`, so
//      Illustrator's Detail 1–10 is literally "how many anchors per brush
//      radius"). Anchors are only ever ADDED where the brush is, so a long
//      drag stays bounded by the path's length over the spacing;
//   2. DISPLACES the control points under the brush through the kernel's
//      field (`liquifyDisplace`). The four smooth kernels (warp, twirl,
//      pucker, bloat) are fields: every control point — anchor and both
//      handles — goes through the same map, which for a field that is
//      locally affine at the densified scale reproduces the deformed
//      curve. The three DETAIL kernels (scallop, crystallize, wrinkle)
//      are not fields: they add structure at the anchors, so Illustrator's
//      "Brush affects anchor points / in-tangent / out-tangent handles"
//      choose which of the three control points they move.
//   3. marks every anchor it moved or minted as TOUCHED.
//
// AT THE END OF A DRAG `liquifyRefit` re-fits each maximal run of touched
// anchors with the Simplify fit (`simplifyContour`, Schneider) at the
// `simplify` tolerance, keeping the untouched anchors on either side
// verbatim (their outer handles included), so the part of a path the
// brush never reached is byte-identical afterwards.
//
// DETERMINISM. The detail kernels' "random" is a hash of the anchor's
// STABLE id and the kernel's seed. An original anchor's id is its index;
// a minted anchor's is a hash of where it was minted (quantised to 1/64
// pt). So the same table, brush and seed give the same result on every
// run and every platform — which is what lets a spec pin a crystallize
// and a Rust port reproduce it — and an anchor keeps its id while the
// drag moves it, so its peak or valley does not flicker step to step.

import type { AnchorTable, AnchorTriple, Vec2, Vec2Mut } from "../types";
import { splitSegmentDeCasteljau } from "../bezier";
import { simplifyContour } from "../simplify-fit";

export type LiquifyKind =
  "warp" | "twirl" | "pucker" | "bloat" | "scallop" | "crystallize" | "wrinkle";

export const LIQUIFY_KINDS: readonly LiquifyKind[] = [
  "warp",
  "twirl",
  "pucker",
  "bloat",
  "scallop",
  "crystallize",
  "wrinkle",
];

/** The brush: an ellipse on the page. */
export interface LiquifyBrush {
  center: Vec2;
  /** pt — the ellipse's full width and height (Illustrator's dialog). */
  width: number;
  height: number;
  /** Degrees, counter-clockwise on screen (y down: the brush's x axis
   *  turned by −angle in page coordinates, as Illustrator draws it). */
  angleDeg: number;
  /** 0..1 — Intensity, or pressure when "use pressure" is on. */
  strength: number;
}

/** Per-kernel parameters (Illustrator's tool-specific options). */
export interface LiquifyParams {
  kind: LiquifyKind;
  /** Warp: the pointer's motion since the last step (pt). */
  delta?: Vec2;
  /** Twirl: degrees per step at full strength (−180..180; positive is
   *  counter-clockwise on screen, Illustrator's sign). */
  twirlRate?: number;
  /** Scallop / Crystallize / Wrinkle: 0..15 — how busy the added detail
   *  is (more complexity, shorter wavelength). */
  complexity?: number;
  /** Wrinkle: 0..100 % horizontal and vertical displacement. */
  horizontal?: number;
  vertical?: number;
  /** Scallop / Crystallize / Wrinkle: which control points move. */
  affectAnchors?: boolean;
  affectIn?: boolean;
  affectOut?: boolean;
  /** Detail kernels' hash seed (default 0). */
  seed?: number;
}

/** A table plus, per anchor, whether a step has moved or minted it and
 *  a STABLE id — the detail kernels key their noise on it, so a spike
 *  stays a spike across the steps of one drag while its anchor moves. */
export interface LiquifyState {
  table: AnchorTable;
  touched: readonly boolean[];
  ids: readonly number[];
}

const DEG = Math.PI / 180;

/** Fraction of the radius pucker / bloat move a point per full-strength
 *  step at the centre; scallop / crystallize likewise. */
export const LIQUIFY_RATE = 0.08;

/** The brush's smaller semi-axis (pt). */
export const brushRadius = (b: LiquifyBrush): number =>
  Math.max(1e-6, Math.min(b.width, b.height) / 2);

/** The densification spacing (pt) for a `detail` of 1..10. */
export function liquifySpacing(b: LiquifyBrush, detail: number): number {
  const d = Math.max(1, Math.min(10, detail));
  return brushRadius(b) / (d + 1);
}

/** The normalised elliptical distance of `p` from the brush centre (0 at
 *  the centre, 1 on the rim). */
export function brushDistance(b: LiquifyBrush, p: Vec2): number {
  const a = -b.angleDeg * DEG;
  const dx = p[0] - b.center[0];
  const dy = p[1] - b.center[1];
  const c = Math.cos(a);
  const s = Math.sin(a);
  const u = c * dx + s * dy;
  const v = -s * dx + c * dy;
  const rx = Math.max(1e-6, b.width / 2);
  const ry = Math.max(1e-6, b.height / 2);
  return Math.hypot(u / rx, v / ry);
}

/** The falloff weight in [0, 1]: `(1 − r²)²` inside the brush. */
export function brushWeight(b: LiquifyBrush, p: Vec2): number {
  const r = brushDistance(b, p);
  if (r >= 1) return 0;
  const k = 1 - r * r;
  return k * k;
}

/** 32-bit integer hash → [−1, 1). Position-keyed, platform-stable. */
export function hashNoise(x: number, y: number, seed: number): number {
  let h =
    (Math.imul(Math.round(x * 64) | 0, 0x27d4eb2d) ^
      Math.imul(Math.round(y * 64) | 0, 0x165667b1) ^
      Math.imul(seed | 0, 0x9e3779b1)) >>>
    0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 0x80000000 - 1;
}

/**
 * The smooth kernels' field: where the point `p` goes in one step. Warp
 * drags by `delta`, Twirl turns about the centre, Pucker pulls toward
 * it, Bloat pushes away. The detail kernels are not fields and answer
 * `p` unchanged here (see `liquifyStep`). Pure.
 */
export function liquifyDisplace(
  b: LiquifyBrush,
  params: LiquifyParams,
  p: Vec2,
): Vec2Mut {
  const w = brushWeight(b, p) * Math.max(0, Math.min(1, b.strength));
  if (w === 0) return [p[0], p[1]];
  const cx = b.center[0];
  const cy = b.center[1];
  switch (params.kind) {
    case "warp": {
      const d = params.delta ?? [0, 0];
      return [p[0] + d[0] * w, p[1] + d[1] * w];
    }
    case "twirl": {
      // Positive rate = counter-clockwise ON SCREEN; y points down, so
      // that is a negative angle in page coordinates.
      const a = -(params.twirlRate ?? 40) * DEG * w;
      const c = Math.cos(a);
      const s = Math.sin(a);
      const dx = p[0] - cx;
      const dy = p[1] - cy;
      return [cx + c * dx - s * dy, cy + s * dx + c * dy];
    }
    case "pucker": {
      const k = 1 - LIQUIFY_RATE * w;
      return [cx + (p[0] - cx) * k, cy + (p[1] - cy) * k];
    }
    case "bloat": {
      const k = 1 + LIQUIFY_RATE * w;
      return [cx + (p[0] - cx) * k, cy + (p[1] - cy) * k];
    }
    default:
      return [p[0], p[1]];
  }
}

// ------------------------------------------------------------ densify

const copyTriple = (a: AnchorTriple): AnchorTriple => ({
  anchor: [a.anchor[0], a.anchor[1]],
  left: [a.left[0], a.left[1]],
  right: [a.right[0], a.right[1]],
});

const contours = (table: AnchorTable): Array<[number, number, boolean]> => {
  const n = table.anchors.length;
  const starts = table.subpathStarts.length > 0 ? table.subpathStarts : [0];
  return starts.map((from, i) => {
    const to = i + 1 < starts.length ? starts[i + 1]! : n;
    return [from, to, !(table.subpathOpen?.[i] ?? false)];
  });
};

/** The brush's axis-aligned box, grown by `margin`. */
function brushBox(
  b: LiquifyBrush,
  margin: number,
): [number, number, number, number] {
  const a = b.angleDeg * DEG;
  const rx = b.width / 2;
  const ry = b.height / 2;
  const hx = Math.hypot(rx * Math.cos(a), ry * Math.sin(a)) + margin;
  const hy = Math.hypot(rx * Math.sin(a), ry * Math.cos(a)) + margin;
  return [
    b.center[0] - hx,
    b.center[1] - hy,
    b.center[0] + hx,
    b.center[1] + hy,
  ];
}

const polygonLength = (p: readonly Vec2[]): number => {
  let l = 0;
  for (let i = 1; i < p.length; i++)
    l += Math.hypot(p[i]![0] - p[i - 1]![0], p[i]![1] - p[i - 1]![1]);
  return l;
};

const boxesMeet = (
  pts: readonly Vec2[],
  box: readonly [number, number, number, number],
): boolean => {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p[0]);
    y0 = Math.min(y0, p[1]);
    x1 = Math.max(x1, p[0]);
    y1 = Math.max(y1, p[1]);
  }
  return !(x1 < box[0] || x0 > box[2] || y1 < box[1] || y0 > box[3]);
};

/** Hard cap on anchors one contour may grow to (a pathological drag on a
 *  huge path stops subdividing rather than freezing the tab). */
export const LIQUIFY_MAX_ANCHORS = 20000;

/**
 * Subdivide every segment the brush (grown by one spacing) reaches until
 * its control polygon is at most `spacing` long. Exact: de Casteljau
 * halving moves no point of the curve. New anchors are marked touched.
 */
export function liquifyDensify(
  state: LiquifyState,
  b: LiquifyBrush,
  spacing: number,
): LiquifyState {
  const box = brushBox(b, spacing);
  const sp = Math.max(1e-3, spacing);
  const anchors: AnchorTriple[] = [];
  const touched: boolean[] = [];
  const ids: number[] = [];
  const starts: number[] = [];
  const open: boolean[] = [];
  for (const [from, to, closed] of contours(state.table)) {
    starts.push(anchors.length);
    open.push(!closed);
    const src = state.table.anchors.slice(from, to).map(copyTriple);
    const flags = state.touched.slice(from, to);
    const srcIds = state.ids.slice(from, to);
    const m = src.length;
    const segs = closed ? m : m - 1;
    // Output anchors for this contour, segment by segment: each segment's
    // start anchor (with its right handle possibly replaced) and every
    // minted anchor; a closed contour's first anchor gets its left handle
    // from the last segment.
    const out: AnchorTriple[] = src.length > 0 ? [src[0]!] : [];
    const outFlags: boolean[] = src.length > 0 ? [flags[0] ?? false] : [];
    const outIds: number[] = src.length > 0 ? [srcIds[0] ?? 0] : [];
    let budget = LIQUIFY_MAX_ANCHORS - m;
    for (let s = 0; s < segs; s++) {
      const a = out[out.length - 1]!;
      const endIndex = (s + 1) % m;
      const end =
        s + 1 < m ? src[s + 1]! : out[0]!; /* closing segment ends at 0 */
      const p: Vec2Mut[] = [
        [a.anchor[0], a.anchor[1]],
        [a.right[0], a.right[1]],
        [end.left[0], end.left[1]],
        [end.anchor[0], end.anchor[1]],
      ];
      // Halve recursively; collect the minted anchors in order.
      const minted: AnchorTriple[] = [];
      let lastRight: Vec2Mut = p[1]!;
      let endLeft: Vec2Mut = p[2]!;
      const stack: Vec2Mut[][] = [p];
      const pieces: Vec2Mut[][] = [];
      while (stack.length > 0) {
        const c = stack.pop()!;
        if (
          budget > 0 &&
          polygonLength(c) > sp &&
          boxesMeet(c, box) &&
          pieces.length + stack.length < 4096
        ) {
          const h = splitSegmentDeCasteljau(c[0]!, c[1]!, c[2]!, c[3]!, 0.5);
          budget--;
          // Push the SECOND half first so the first is processed next.
          stack.push([h.midAnchor, h.midRight, h.endLeft, c[3]!]);
          stack.push([c[0]!, h.startRight, h.midLeft, h.midAnchor]);
        } else pieces.push(c);
      }
      if (pieces.length > 1) {
        lastRight = pieces[0]![1]!;
        for (let k = 1; k < pieces.length; k++) {
          const q = pieces[k]!;
          minted.push({
            anchor: [q[0]![0], q[0]![1]],
            left: [pieces[k - 1]![2]![0], pieces[k - 1]![2]![1]],
            right: [q[1]![0], q[1]![1]],
          });
        }
        endLeft = pieces[pieces.length - 1]![2]!;
        a.right = lastRight;
      }
      for (const t of minted) {
        out.push(t);
        outFlags.push(true);
        outIds.push(mintId(t.anchor));
      }
      if (s + 1 < m) {
        const e = src[s + 1]!;
        e.left = endLeft;
        out.push(e);
        outFlags.push(flags[endIndex] ?? false);
        outIds.push(srcIds[endIndex] ?? 0);
      } else {
        out[0]!.left = endLeft;
      }
    }
    anchors.push(...out);
    touched.push(...outFlags);
    ids.push(...outIds);
  }
  return {
    table: {
      anchors,
      subpathStarts: starts,
      ...(state.table.subpathOpen ? { subpathOpen: open } : {}),
    },
    touched,
    ids,
  };
}

/** A minted anchor's id: a hash of where it was minted. */
const mintId = (p: Vec2): number =>
  Math.floor((hashNoise(p[0], p[1], 0x5eed) + 1) * 0x3fffffff) + 0x100000;

// ----------------------------------------------------------------- step

const sub = (a: Vec2, b: Vec2): Vec2Mut => [a[0] - b[0], a[1] - b[1]];
const add = (a: Vec2, b: Vec2): Vec2Mut => [a[0] + b[0], a[1] + b[1]];
const scale = (a: Vec2, k: number): Vec2Mut => [a[0] * k, a[1] * k];

/** The detail kernels' move of one anchor (and its handles). */
function detailMove(
  b: LiquifyBrush,
  params: LiquifyParams,
  a: AnchorTriple,
  id: number,
  outward: Vec2,
): AnchorTriple {
  const w = brushWeight(b, a.anchor) * Math.max(0, Math.min(1, b.strength));
  if (w === 0) return a;
  const seed = params.seed ?? 0;
  const complexity = Math.max(0, Math.min(15, params.complexity ?? 1));
  const r = brushRadius(b);
  const n = hashNoise(id, 0, seed);
  // The OUTWARD normal of the path at the anchor: spikes and scallops
  // grow out of / into the SHAPE, wherever on it the brush sits.
  const ru = outward;
  // Complexity: the fraction of anchors that are PEAKS (Illustrator's
  // "more complexity, more details"): 15 % at 0, rising to ~68 % at 15;
  // the rest are valleys.
  const peak = (n + 1) / 2 < 0.15 + 0.035 * complexity;
  const valley = !peak;
  let move: Vec2Mut;
  let handleMove: Vec2Mut;
  switch (params.kind) {
    case "scallop": {
      // Anchors are drawn toward the centre (the scallop's cusps); the
      // handles swing out, so each segment bulges into an arc.
      const k = LIQUIFY_RATE * w * r * (valley ? 0.25 : 1);
      move = scale(ru, -k);
      handleMove = scale(ru, k * 0.75);
      break;
    }
    case "crystallize": {
      // Peaks are pushed outward (spikes); valleys stay. The handles are
      // drawn toward their anchor, sharpening the spikes.
      const k = valley ? 0 : LIQUIFY_RATE * w * r * (0.5 + 0.5 * Math.abs(n));
      move = scale(ru, k);
      handleMove = [0, 0];
      break;
    }
    case "wrinkle": {
      const hx = (params.horizontal ?? 0) / 100;
      const vy = (params.vertical ?? 100) / 100;
      const n2 = hashNoise(id, 1, seed + 7);
      const k = LIQUIFY_RATE * w * r;
      move = [n * hx * k, n2 * vy * k];
      handleMove = [-n2 * hx * k * 0.5, n * vy * k * 0.5];
      break;
    }
    default:
      return a;
  }
  const anchorsToo = params.affectAnchors ?? true;
  const inToo = params.affectIn ?? true;
  const outToo = params.affectOut ?? true;
  const anchor: Vec2Mut = anchorsToo
    ? add(a.anchor, move)
    : [a.anchor[0], a.anchor[1]];
  const shift: Vec2 = anchorsToo ? move : [0, 0];
  let left: Vec2Mut = add(a.left, shift);
  let right: Vec2Mut = add(a.right, shift);
  if (params.kind === "crystallize") {
    const pull = 1 - Math.min(1, w);
    if (inToo) left = add(anchor, scale(sub(left, anchor), pull));
    if (outToo) right = add(anchor, scale(sub(right, anchor), pull));
  } else {
    if (inToo) left = add(left, handleMove);
    if (outToo) right = add(right, scale(handleMove, -1));
  }
  return {
    anchor,
    left,
    right,
  };
}

/** Each anchor's outward unit normal: perpendicular to the chord between
 *  its neighbours, on the outside of a closed contour (by its signed
 *  area) and away from the brush centre on an open one. */
function outwardNormals(table: AnchorTable, b: LiquifyBrush): Vec2Mut[] {
  const out: Vec2Mut[] = table.anchors.map(() => [0, -1]);
  for (const [from, to, closed] of contours(table)) {
    const m = to - from;
    if (m < 2) continue;
    let area = 0;
    for (let i = 0; i < m; i++) {
      const p = table.anchors[from + i]!.anchor;
      const q = table.anchors[from + ((i + 1) % m)]!.anchor;
      area += p[0] * q[1] - q[0] * p[1];
    }
    for (let i = 0; i < m; i++) {
      const prev =
        table.anchors[from + (closed ? (i - 1 + m) % m : Math.max(0, i - 1))]!
          .anchor;
      const next =
        table.anchors[from + (closed ? (i + 1) % m : Math.min(m - 1, i + 1))]!
          .anchor;
      const tx = next[0] - prev[0];
      const ty = next[1] - prev[1];
      const l = Math.hypot(tx, ty);
      if (l < 1e-12) continue;
      let n: Vec2Mut = [ty / l, -tx / l];
      const p = table.anchors[from + i]!.anchor;
      if (closed) {
        if (area < 0) n = [-n[0], -n[1]];
      } else if ((p[0] - b.center[0]) * n[0] + (p[1] - b.center[1]) * n[1] < 0)
        n = [-n[0], -n[1]];
      out[from + i] = n;
    }
  }
  return out;
}

/**
 * One liquify step: densify under the brush (`detail` 1..10), then move
 * the control points the kernel moves. Pure; answers a new state.
 */
export function liquifyStep(
  state: LiquifyState,
  b: LiquifyBrush,
  params: LiquifyParams,
  detail: number,
): LiquifyState {
  const dense = liquifyDensify(state, b, liquifySpacing(b, detail));
  const field =
    params.kind === "warp" ||
    params.kind === "twirl" ||
    params.kind === "pucker" ||
    params.kind === "bloat";
  const touched = [...dense.touched];
  const normals = field ? null : outwardNormals(dense.table, b);
  const anchors = dense.table.anchors.map((a, i) => {
    const hit =
      brushWeight(b, a.anchor) > 0 ||
      brushWeight(b, a.left) > 0 ||
      brushWeight(b, a.right) > 0;
    if (!hit) return a;
    touched[i] = true;
    if (field)
      return {
        anchor: liquifyDisplace(b, params, a.anchor),
        left: liquifyDisplace(b, params, a.left),
        right: liquifyDisplace(b, params, a.right),
      };
    return detailMove(b, params, a, dense.ids[i] ?? i, normals![i]!);
  });
  return { table: { ...dense.table, anchors }, touched, ids: dense.ids };
}

/** A fresh state: nothing touched yet. */
export function liquifyStart(table: AnchorTable): LiquifyState {
  return {
    table: {
      anchors: table.anchors.map(copyTriple),
      subpathStarts: [...table.subpathStarts],
      ...(table.subpathOpen ? { subpathOpen: [...table.subpathOpen] } : {}),
    },
    touched: table.anchors.map(() => false),
    ids: table.anchors.map((_, i) => i),
  };
}

/** Did any step change the table? */
export const liquifyChanged = (state: LiquifyState): boolean =>
  state.touched.some(Boolean);

/** Illustrator's Simplify (0.2..100) as a fit tolerance in pt. */
export const simplifyTolerance = (simplify: number): number =>
  0.02 * Math.max(0.2, Math.min(100, simplify));

/**
 * Re-fit each run of touched anchors at `tolerance` (pt), keeping every
 * untouched anchor — and the outer handles of the anchors bounding a run
 * — exactly as they were. Sharp corners (interior angle ≤
 * `cornerAngleDeg`) stay corners. Pure.
 */
export function liquifyRefit(
  state: LiquifyState,
  tolerance: number,
  cornerAngleDeg = 120,
): AnchorTable {
  const anchors: AnchorTriple[] = [];
  const starts: number[] = [];
  const open: boolean[] = [];
  for (const [from, to, closed] of contours(state.table)) {
    starts.push(anchors.length);
    open.push(!closed);
    const src = state.table.anchors.slice(from, to);
    const flags = state.touched.slice(from, to);
    const m = src.length;
    if (!flags.some(Boolean) || m < 3) {
      anchors.push(...src.map(copyTriple));
      continue;
    }
    // Rotate a closed contour so it starts at an untouched anchor (when
    // there is one); a fully touched closed contour is re-fitted whole.
    let rot = 0;
    if (closed) {
      const u = flags.findIndex((f) => !f);
      if (u < 0) {
        anchors.push(
          ...simplifyContour(src, true, {
            tolerance,
            cornerAngleDeg,
          }),
        );
        continue;
      }
      rot = u;
    }
    const ring = [...src.slice(rot), ...src.slice(0, rot)];
    const rflags = [...flags.slice(rot), ...flags.slice(0, rot)];
    const out: AnchorTriple[] = [];
    let i = 0;
    while (i < m) {
      if (!rflags[i] || (!closed && (i === 0 || i === m - 1))) {
        out.push(copyTriple(ring[i]!));
        i++;
        continue;
      }
      // A run of touched anchors [i, j); bounded by i-1 and j (or the
      // contour's wrap to 0 when closed).
      let j = i;
      while (j < m && rflags[j] && !(!closed && j === m - 1)) j++;
      const before = out[out.length - 1]!;
      const afterIndex = j < m ? j : 0;
      const after = ring[afterIndex]!;
      const run = [before, ...ring.slice(i, j), after].map(copyTriple);
      const fitted = simplifyContour(run, false, { tolerance, cornerAngleDeg });
      // The fit's ends ARE `before` and `after`: keep their OUTER handles.
      before.right = fitted[0]!.right;
      for (let k = 1; k < fitted.length - 1; k++) out.push(fitted[k]!);
      const lastLeft = fitted[fitted.length - 1]!.left;
      if (j < m) {
        const e = copyTriple(ring[j]!);
        e.left = lastLeft;
        out.push(e);
        i = j + 1;
      } else {
        out[0]!.left = lastLeft;
        i = j;
      }
    }
    // A closed contour comes back starting at its first untouched anchor
    // (the same closed curve; only where its anchor list begins moved).
    anchors.push(...out);
  }
  return {
    anchors,
    subpathStarts: starts,
    ...(state.table.subpathOpen ? { subpathOpen: open } : {}),
  };
}

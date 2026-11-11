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

// THE WARP KERNEL the distortion machines run on — Puppet Warp's mesh and
// solve, Liquify's step — as an INJECTED, synchronous interface. The one
// implementation is the engine's `paged-warp` crate (the same solve bends
// a raster layer's mesh in paged.image, and the same brush point maps
// drive its Liquify); paged.draw hands its wasm-backed kernel in
// (`draw-bundle/src/warp-kernel.ts`). This package loads no wasm itself.
//
// What stays here is what is not warp maths: the vocabulary, a fresh
// Liquify state, and the end-of-drag REFIT, which is curve fitting
// (vector-geometry's Simplify) over the runs a drag touched.

import {
  contourRanges,
  simplifyContour,
  type AnchorTable,
  type AnchorTriple,
  type Vec2,
  type Vec2Mut,
} from "@paged-media/vector-geometry";

// ------------------------------------------------------------ Liquify

export type LiquifyKind =
  "warp" | "twirl" | "pucker" | "bloat" | "scallop" | "crystallize" | "wrinkle";

/** In the order of `paged_warp::liquify::Kind`'s wire code. */
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
  /** pt — the ellipse's full width and height. */
  width: number;
  height: number;
  /** Degrees, counter-clockwise on screen. */
  angleDeg: number;
  /** 0..1 — Intensity, or pressure when "use pressure" is on. */
  strength: number;
}

/** Per-kernel parameters (Illustrator's tool-specific options). */
export interface LiquifyParams {
  kind: LiquifyKind;
  /** Warp: the pointer's motion since the last step (pt). */
  delta?: Vec2;
  /** Twirl: degrees per step at full strength (positive is
   *  counter-clockwise on screen). Default 40. */
  twirlRate?: number;
  /** Scallop / Crystallize / Wrinkle: 0..15. Default 1. */
  complexity?: number;
  /** Wrinkle: 0..100 %. Defaults 0 and 100. */
  horizontal?: number;
  vertical?: number;
  /** The detail kernels: which control points move. Default all. */
  affectAnchors?: boolean;
  affectIn?: boolean;
  affectOut?: boolean;
  /** The detail kernels' hash seed (default 0). */
  seed?: number;
}

/** A table plus, per anchor, whether a step moved or minted it and a
 *  STABLE id (the detail kernels key their noise on it). */
export interface LiquifyState {
  table: AnchorTable;
  touched: readonly boolean[];
  ids: readonly number[];
}

const copyTriple = (a: AnchorTriple): AnchorTriple => ({
  anchor: [a.anchor[0], a.anchor[1]],
  left: [a.left[0], a.left[1]],
  right: [a.right[0], a.right[1]],
});

/** A fresh state: nothing touched, each anchor its index as id. */
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
  const ranges = contourRanges(
    state.table.anchors.length,
    state.table.subpathStarts,
  );
  ranges.forEach(([from, to], ci) => {
    const closed = !(state.table.subpathOpen?.[ci] ?? false);
    starts.push(anchors.length);
    open.push(!closed);
    const src = state.table.anchors.slice(from, to);
    const flags = state.touched.slice(from, to);
    const m = src.length;
    if (!flags.some(Boolean) || m < 3) {
      anchors.push(...src.map(copyTriple));
      return;
    }
    // Rotate a closed contour so it starts at an untouched anchor (when
    // there is one); a fully touched closed contour is re-fitted whole.
    let rot = 0;
    if (closed) {
      const u = flags.findIndex((f) => !f);
      if (u < 0) {
        anchors.push(
          ...simplifyContour(src, true, { tolerance, cornerAngleDeg }),
        );
        return;
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
      // A run of touched anchors [i, j), bounded by i − 1 and j (or the
      // contour's wrap to 0 when closed).
      let j = i;
      while (j < m && rflags[j] && !(!closed && j === m - 1)) j++;
      const before = out[out.length - 1]!;
      const after = ring[j < m ? j : 0]!;
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
    anchors.push(...out);
  });
  return {
    anchors,
    subpathStarts: starts,
    ...(state.table.subpathOpen ? { subpathOpen: open } : {}),
  };
}

// --------------------------------------------------------- Puppet Warp

/** A triangle mesh (page pt). */
export interface PuppetMesh {
  vertices: Vec2Mut[];
  triangles: [number, number, number][];
}

/** Where a point sits in a mesh: its triangle (−1: no mesh) and its
 *  barycentric weights (extrapolated outside the mesh). */
export interface Located {
  triangle: number;
  weights: [number, number, number];
}

/** A pin on a mesh vertex: where it goes, and an optional turn (radians)
 *  about it. */
export interface PuppetPin {
  vertex: number;
  target: Vec2;
  angle: number | null;
}

/** How freely the mesh bends: `paged_warp::puppet::PuppetMode`. */
export type PuppetMode = "rigid" | "normal" | "distort";

// -------------------------------------------------------------- kernel

/** The kernel the machines call. Every call is synchronous. */
export interface WarpKernel {
  /** The constrained mesh of closed `rings` at about `spacing` pt per
   *  edge (coarsened until at most `maxVertices` fit), with `autoPins`
   *  automatic pins (vertex indices). */
  puppetMesh(
    rings: readonly (readonly Vec2[])[],
    spacing: number,
    maxVertices: number,
    autoPins: number,
  ): { mesh: PuppetMesh; autoPins: number[] };
  /** Where each point sits in `mesh`. */
  puppetLocate(mesh: PuppetMesh, points: readonly Vec2[]): Located[];
  /** Bend `mesh` by `pins`; answer the bent vertices and the `located`
   *  points mapped through them (null for one in no triangle). */
  puppetSolve(
    mesh: PuppetMesh,
    pins: readonly PuppetPin[],
    mode: PuppetMode,
    located: readonly Located[],
  ): { vertices: Vec2Mut[]; points: (Vec2Mut | null)[] };
  /** One Liquify step: densify under the brush (`detail` 1..10), then
   *  move the control points the kernel moves. */
  liquifyStep(
    state: LiquifyState,
    brush: LiquifyBrush,
    params: LiquifyParams,
    detail: number,
  ): LiquifyState;
}

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

// HOMOGRAPHIES — the projective maps of the plane that the perspective
// grid is made of (and that Free Distort, Perspective Crop and Vanishing
// Point will share once this moves to `paged-warp`).
//
// A homography is a 3 × 3 matrix up to scale, stored row-major with h33
// normalised to 1 where possible:
//
//     [x']   [h0 h1 h2] [x]
//     [y'] ~ [h3 h4 h5] [y]
//     [w']   [h6 h7 h8] [1]        x_out = x'/w', y_out = y'/w'.
//
// `homographyFromQuads` solves the 8 × 8 linear system of four point
// correspondences (Gaussian elimination with partial pivoting).
//
// CURVES. A projective map does not keep a cubic Bézier a cubic; mapping
// only its control points is exact for straight segments and wrong by a
// bulge for curves under strong foreshortening. `mapTableProjective`
// therefore SUBDIVIDES each curved segment (de Casteljau, exact) until
// mapping its control points stays within `tolerance` of the true image at
// the segment's midpoint, then maps the control points. Straight
// segments (both inner handles on their anchors) are mapped as they are,
// and stay straight — which is how a rectangle on the grid stays four
// anchors.

import {
  homographyFromQuads as sdkHomography,
  invert3,
  multiply3,
  type BoxQuad as Matrix3Quad,
  type Matrix3,
} from "@paged-media/plugin-sdk";

import type { AnchorTable, AnchorTriple, Vec2, Vec2Mut } from "../types";
import { evalCubic, splitSegmentDeCasteljau } from "../bezier";

export type Homography = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

export const IDENTITY_HOMOGRAPHY: Homography = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** Map one point. Null when it maps to infinity (w' = 0: the point is on
 *  the plane's vanishing line). */
export function applyHomography(h: Homography, p: Vec2): Vec2Mut | null {
  const w = h[6] * p[0] + h[7] * p[1] + h[8];
  if (Math.abs(w) < 1e-12) return null;
  return [
    (h[0] * p[0] + h[1] * p[1] + h[2]) / w,
    (h[3] * p[0] + h[4] * p[1] + h[5]) / w,
  ];
}

/** The homography taking `from[i]` to `to[i]` for four points. Null when
 *  three of either four are collinear. The solve is the extension SDK's
 *  (`transform-box`, the one implementation: the transform box, Perspective
 *  Crop and the perspective grid all fit through it). */
export const homographyFromQuads = (
  from: readonly [Vec2, Vec2, Vec2, Vec2],
  to: readonly [Vec2, Vec2, Vec2, Vec2],
): Homography | null => sdkHomography(asQuad(from), asQuad(to));

const asQuad = (q: readonly [Vec2, Vec2, Vec2, Vec2]): Matrix3Quad =>
  q.map((p) => [p[0], p[1]]) as unknown as Matrix3Quad;

/** `m` scaled so its last entry is 1 (when it is not 0). */
const normalised = (m: readonly number[]): Homography => {
  const s = Math.abs(m[8]!) > 1e-12 ? m[8]! : 1;
  return m.map((x) => x / s) as unknown as Homography;
};

/** The inverse map. Null when singular. */
export function invertHomography(h: Homography): Homography | null {
  const inv = invert3([...h] as Matrix3);
  return inv ? normalised(inv) : null;
}

/** `outer ∘ inner`. */
export function composeHomography(
  outer: Homography,
  inner: Homography,
): Homography {
  return normalised(multiply3([...outer] as Matrix3, [...inner] as Matrix3));
}

/** Is the segment a straight line — both inner handles on the chord
 *  (within 0.02 pt: the engine stores a straight edge as a cubic with its
 *  handles at the thirds, snapped to a 1/64 pt grid)? Collinear control
 *  points map to collinear control points, so such a segment needs no
 *  subdivision. */
const straight = (a: AnchorTriple, b: AnchorTriple): boolean => {
  const p = a.anchor;
  const q = b.anchor;
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  const l = Math.hypot(dx, dy);
  const off = (h: Vec2) =>
    l > 0
      ? Math.abs(dx * (h[1] - p[1]) - dy * (h[0] - p[0])) / l
      : Math.hypot(h[0] - p[0], h[1] - p[1]);
  return off(a.right) <= 0.02 && off(b.left) <= 0.02;
};

/**
 * Map an anchor table through `h`, subdividing curved segments until the
 * control-point image is within `tolerance` (pt, in the OUTPUT space) of
 * the true image at each piece's midpoint. Straight segments stay
 * straight and are not subdivided. Null when any point maps to infinity.
 */
export function mapTableProjective(
  table: AnchorTable,
  h: Homography,
  tolerance = 0.1,
): AnchorTable | null {
  const n = table.anchors.length;
  const starts = table.subpathStarts.length > 0 ? table.subpathStarts : [0];
  const out: AnchorTriple[] = [];
  const outStarts: number[] = [];
  const P = (p: Vec2): Vec2Mut | null => applyHomography(h, p);
  for (let s = 0; s < starts.length; s++) {
    const from = starts[s]!;
    const to = s + 1 < starts.length ? starts[s + 1]! : n;
    const closed = !(table.subpathOpen?.[s] ?? false);
    const src = table.anchors.slice(from, to);
    const m = src.length;
    outStarts.push(out.length);
    if (m === 0) continue;
    // Build the contour's cubic list in SOURCE space, subdivided.
    const cubics: Vec2Mut[][] = [];
    const segs = closed ? m : m - 1;
    for (let i = 0; i < segs; i++) {
      const a = src[i]!;
      const b = src[(i + 1) % m]!;
      const c: Vec2Mut[] = [
        [a.anchor[0], a.anchor[1]],
        [a.right[0], a.right[1]],
        [b.left[0], b.left[1]],
        [b.anchor[0], b.anchor[1]],
      ];
      if (straight(a, b)) {
        cubics.push(c);
        continue;
      }
      const stack = [c];
      const pieces: Vec2Mut[][] = [];
      while (stack.length > 0) {
        const q = stack.pop()!;
        const mid = evalCubic(q[0]!, q[1]!, q[2]!, q[3]!, 0.5);
        const qi = q.map(P);
        const mi = P(mid);
        if (qi.some((x) => !x) || !mi) return null;
        const approx = evalCubic(qi[0]!, qi[1]!, qi[2]!, qi[3]!, 0.5);
        const err = Math.hypot(approx[0] - mi[0], approx[1] - mi[1]);
        if (err > tolerance && pieces.length + stack.length < 256) {
          const sp = splitSegmentDeCasteljau(q[0]!, q[1]!, q[2]!, q[3]!, 0.5);
          stack.push([sp.midAnchor, sp.midRight, sp.endLeft, q[3]!]);
          stack.push([q[0]!, sp.startRight, sp.midLeft, sp.midAnchor]);
        } else pieces.push(q);
      }
      cubics.push(...pieces);
    }
    // Assemble mapped anchors.
    const mapped: AnchorTriple[] = [];
    const first = P(src[0]!.anchor);
    if (!first) return null;
    const leftOf0 = P(src[0]!.left);
    if (!leftOf0) return null;
    mapped.push({ anchor: first, left: leftOf0, right: first });
    for (let k = 0; k < cubics.length; k++) {
      const q = cubics[k]!.map(P);
      if (q.some((x) => !x)) return null;
      mapped[mapped.length - 1]!.right = q[1]!;
      const isLast = k === cubics.length - 1;
      if (isLast && closed) {
        mapped[0]!.left = q[2]!;
      } else {
        mapped.push({ anchor: q[3]!, left: q[2]!, right: q[3]! });
      }
    }
    if (!closed) {
      const lastSrc = src[m - 1]!;
      const r = P(lastSrc.right);
      if (!r) return null;
      mapped[mapped.length - 1]!.right = r;
    }
    if (cubics.length === 0) {
      // A one-anchor contour: its handles mapped as they are.
      const r = P(src[0]!.right);
      if (!r) return null;
      mapped[0]!.right = r;
    }
    out.push(...mapped);
  }
  return {
    anchors: out,
    subpathStarts: outStarts,
    ...(table.subpathOpen ? { subpathOpen: [...table.subpathOpen] } : {}),
  };
}

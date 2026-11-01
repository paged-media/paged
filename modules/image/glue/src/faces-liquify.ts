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

// FACE-AWARE LIQUIFY (WP8.2, image ADR 486): the Liquify workspace's faces
// mode. `ml.landmarks` finds faces when the dialog opens; each face is kept
// as five points (the two eyes, the nose tip, the two mouth corners) and
// its box, NORMALISED to the image like every other Liquify geometry. The
// sliders (eye size, nose, smile, face width, chin, forehead) turn into
// ordinary Liquify strokes at run time, so the preview, the proxy pass and
// the one undo step are the dialog's own. No landmark is ever stored in the
// document; the strokes are re-derived from the sliders and the faces.

import type { MlFace } from "@paged-media/plugin-api";

import type { LiquifyStroke } from "./warp-engine";

/** Numbers per face in the dialog's `faces` list: the box (x, y, w, h)
 *  then left eye, right eye, nose tip, left mouth corner, right mouth
 *  corner (x, y each); all as fractions of the image's sides. */
export const FACE_STRIDE = 14;

/** The face sliders, all -100…100 with 0 as no change. */
export const FACE_SLIDERS = [
  "faceEyes",
  "faceNose",
  "faceSmile",
  "faceWidth",
  "faceChin",
  "faceForehead",
] as const;
export type FaceSlider = (typeof FACE_SLIDERS)[number];

type Pt = readonly [number, number];

const mean = (pts: readonly Pt[]): Pt => [
  pts.reduce((a, p) => a + p[0], 0) / pts.length,
  pts.reduce((a, p) => a + p[1], 0) / pts.length,
];

/** The five canonical points of a face: eyes, nose tip, mouth corners.
 *  Five points are taken as given (left eye, right eye, nose, left mouth,
 *  right mouth); 68 points are read as the common 68-point layout. Any
 *  other count is not understood (null). */
export function canonicalPoints(face: MlFace): Pt[] | null {
  const p = face.points.map((q): Pt => [q.x, q.y]);
  if (p.length === 5) return p;
  if (p.length === 68)
    return [
      mean(p.slice(36, 42)),
      mean(p.slice(42, 48)),
      p[30]!,
      p[48]!,
      p[54]!,
    ];
  return null;
}

/** The dialog's flat `faces` list for the faces a model found, positions
 *  as fractions of a `w`×`h` image. Faces whose landmarks are not
 *  understood are left out. */
export function facesToList(
  faces: readonly MlFace[],
  w: number,
  h: number,
): number[] {
  const out: number[] = [];
  for (const f of faces) {
    const pts = canonicalPoints(f);
    if (!pts) continue;
    out.push(f.box.x / w, f.box.y / h, f.box.width / w, f.box.height / h);
    for (const q of pts) out.push(q[0] / w, q[1] / h);
  }
  return out;
}

/** How many faces a `faces` list holds. */
export const faceCount = (list: readonly number[]): number =>
  Math.floor(list.length / FACE_STRIDE);

const forward = (
  size: number,
  points: Array<[number, number]>,
): LiquifyStroke => ({
  tool: "forwardWarp",
  size: Math.max(2, size),
  pressure: 1,
  density: 0.5,
  rate: 0.8,
  points,
});

const radial = (
  tool: "bloat" | "pucker",
  size: number,
  amount: number,
  at: Pt,
): LiquifyStroke => ({
  tool,
  size: Math.max(2, size),
  pressure: Math.min(1, Math.abs(amount)),
  density: 0.5,
  rate: 0.8,
  points: [[at[0], at[1]]],
});

/** The Liquify strokes the sliders describe over `list` (image px of a
 *  `w`×`h` image). Positive values: bigger eyes, a larger nose, a
 *  broader smile, a wider face, a longer chin, a taller forehead;
 *  negative the other way. A slider at 0 makes no stroke. */
export function faceStrokes(
  list: readonly number[],
  values: Readonly<Record<FaceSlider, number>>,
  w: number,
  h: number,
): LiquifyStroke[] {
  const out: LiquifyStroke[] = [];
  const s = (k: FaceSlider) => Math.max(-1, Math.min(1, values[k] / 100));
  for (let i = 0; i + FACE_STRIDE <= list.length; i += FACE_STRIDE) {
    const f = list.slice(i, i + FACE_STRIDE);
    const bx = f[0]! * w;
    const by = f[1]! * h;
    const bw = f[2]! * w;
    const bh = f[3]! * h;
    const pt = (k: number): Pt => [f[4 + 2 * k]! * w, f[5 + 2 * k]! * h];
    const [le, re, nose, ml, mr] = [pt(0), pt(1), pt(2), pt(3), pt(4)] as [
      Pt,
      Pt,
      Pt,
      Pt,
      Pt,
    ];
    const eyeGap = Math.hypot(re[0] - le[0], re[1] - le[1]);
    const mouthW = Math.hypot(mr[0] - ml[0], mr[1] - ml[1]);
    const grow = (v: number) => (v >= 0 ? "bloat" : "pucker");

    const eyes = s("faceEyes");
    if (eyes !== 0)
      for (const e of [le, re])
        out.push(radial(grow(eyes), eyeGap * 0.55, eyes, e));

    const nz = s("faceNose");
    if (nz !== 0) out.push(radial(grow(nz), eyeGap * 0.6, nz, nose));

    const sm = s("faceSmile");
    if (sm !== 0) {
      const lift = mouthW * 0.3 * sm;
      const out_ = mouthW * 0.12 * Math.abs(sm);
      out.push(
        forward(mouthW * 0.6, [
          [ml[0], ml[1]],
          [ml[0] - out_, ml[1] - lift],
        ]),
        forward(mouthW * 0.6, [
          [mr[0], mr[1]],
          [mr[0] + out_, mr[1] - lift],
        ]),
      );
    }

    const fw = s("faceWidth");
    if (fw !== 0) {
      const y = (nose[1] + (ml[1] + mr[1]) / 2) / 2;
      const push = bw * 0.08 * fw;
      out.push(
        forward(bh * 0.5, [
          [bx + bw * 0.06, y],
          [bx + bw * 0.06 - push, y],
        ]),
        forward(bh * 0.5, [
          [bx + bw * 0.94, y],
          [bx + bw * 0.94 + push, y],
        ]),
      );
    }

    const chin = s("faceChin");
    if (chin !== 0) {
      const x = bx + bw / 2;
      out.push(
        forward(bw * 0.5, [
          [x, by + bh * 0.93],
          [x, by + bh * 0.93 + bh * 0.1 * chin],
        ]),
      );
    }

    const fh = s("faceForehead");
    if (fh !== 0) {
      const x = bx + bw / 2;
      out.push(
        forward(bw * 0.6, [
          [x, by + bh * 0.1],
          [x, by + bh * 0.1 - bh * 0.1 * fh],
        ]),
      );
    }
  }
  return out;
}

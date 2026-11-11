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

// COLOUR HARMONY — the pure half of Recolor Artwork and the Color Guide
// (Illustrator §18). No host and only the shared colour helpers: sRGB 0..255 in and out.
//
// THREE COLOUR SPACES, each for what it is good at:
//   · HSB (= HSV) is the WHEEL. A harmony rule is a set of hue angles, a
//     drag on the wheel is a hue rotation, saturation is the radius. It is
//     what Illustrator's wheel shows, so the handles land where a user
//     expects them.
//   · CIE L*a*b* (D65) is for DISTANCE. "Reduce to N colours" clusters in
//     Lab and "map to a library" picks the nearest swatch by ΔE76,
//     because two colours that look alike are near in Lab and can be far
//     apart in RGB.
//   · sRGB is what the document's display colours are (`swatchDisplay`).
//
// DETERMINISM. Every function here is a pure function of its inputs: the
// k-means is seeded by farthest-point selection from the heaviest colour
// (ties by input order) and runs a fixed number of iterations, so "reduce
// to 3" on the same selection gives the same three colours every time —
// a recolour preview the user accepts is exactly what applies.

import {
  deltaE,
  hsbToRgb,
  hueDelta,
  labToRgb,
  rgbToHsb,
  rgbToLab,
  wrapHue,
  type Lab,
} from "@paged-media/helpers";

import type { Rgb } from "./svg-color";

export {
  HARMONY_RULES,
  deltaE,
  harmonyOf,
  hsbToRgb,
  hueDelta,
  labToRgb,
  rgbToHsb,
  rgbToLab,
  rotateHues,
  sameRgb,
  wrapHue,
  type HarmonyRule,
  type Hsb,
  type Lab,
} from "@paged-media/helpers";

const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v));

/** Where a colour sits on the HSB wheel: angle = hue (0° at 3 o'clock,
 *  counter-clockwise in a y-up frame, so `y` is NEGATED for screen
 *  coordinates by the caller), radius = saturation. Unit disc. */
export function wheelPoint(c: Rgb): [number, number] {
  const hsb = rgbToHsb(c);
  const a = (hsb.h * Math.PI) / 180;
  return [Math.cos(a) * hsb.s, Math.sin(a) * hsb.s];
}

/** The colour at a unit-disc point of the wheel at `brightness`. */
export function wheelColor(x: number, y: number, brightness: number): Rgb {
  const s = clamp(Math.hypot(x, y), 0, 1);
  const h = wrapHue((Math.atan2(y, x) * 180) / Math.PI);
  return hsbToRgb({ h, s, b: brightness });
}

/** The hue rotation a drag on the wheel from `from` to `to` (unit-disc
 *  points, same frame as {@link wheelPoint}) asks for, -180..180. */
export function wheelDragDelta(
  from: readonly [number, number],
  to: readonly [number, number],
): number {
  const a = (Math.atan2(from[1], from[0]) * 180) / Math.PI;
  const b = (Math.atan2(to[1], to[0]) * 180) / Math.PI;
  return hueDelta(a, b);
}

// ------------------------------------------------- the Color Guide variations

/** The three variation rows of Illustrator's Color Guide. */
export type VariationKind = "tintsShades" | "warmCool" | "vividMuted";

export const VARIATION_KINDS: readonly VariationKind[] = [
  "tintsShades",
  "warmCool",
  "vividMuted",
];

const WARM_HUE = 30;
const COOL_HUE = 220;

/**
 * `steps` variations of `base` (an odd count puts `base` itself in the
 * middle), from the first pole to the second: SHADES → TINTS (toward
 * black, then toward white, in Lab lightness so the steps look even),
 * WARM → COOL (the hue pulled toward orange, then toward blue), VIVID →
 * MUTED (saturation up, then down).
 */
export function variationsOf(base: Rgb, kind: VariationKind, steps = 7): Rgb[] {
  const n = Math.max(1, Math.floor(steps));
  const mid = (n - 1) / 2;
  const out: Rgb[] = [];
  const lab = rgbToLab(base);
  const hsb = rgbToHsb(base);
  for (let i = 0; i < n; i++) {
    // -1 (first pole) .. 0 (base) .. 1 (second pole)
    const f = mid === 0 ? 0 : (i - mid) / mid;
    if (f === 0) {
      out.push([base[0], base[1], base[2]]);
      continue;
    }
    const amount = Math.abs(f) * 0.8;
    if (kind === "tintsShades") {
      const target = f < 0 ? 0 : 100;
      out.push(labToRgb({ ...lab, l: lab.l + (target - lab.l) * amount }));
    } else if (kind === "warmCool") {
      if (hsb.s === 0) {
        // A grey has no hue: warm/cool tint it slightly instead.
        out.push(
          hsbToRgb({
            h: f < 0 ? WARM_HUE : COOL_HUE,
            s: 0.25 * amount,
            b: hsb.b,
          }),
        );
        continue;
      }
      const pole = f < 0 ? WARM_HUE : COOL_HUE;
      out.push(
        hsbToRgb({ ...hsb, h: hsb.h + hueDelta(hsb.h, pole) * amount * 0.6 }),
      );
    } else {
      const s = f < 0 ? hsb.s + (1 - hsb.s) * amount : hsb.s * (1 - amount);
      out.push(hsbToRgb({ ...hsb, s }));
    }
  }
  return out;
}

// --------------------------------------------- reduce, map, recolour

/** One colour of the artwork and how much of it there is (how many
 *  paint slots use it — fills, strokes, stops, appearance layers). */
export interface WeightedColor {
  rgb: Rgb;
  weight: number;
}

/** A k-means result: one centre per cluster and each input's cluster. */
export interface LabClusters {
  centres: Lab[];
  assignment: number[];
}

/** Lloyd iterations — fixed, so the result never depends on a tolerance. */
const KMEANS_ITERATIONS = 24;

/**
 * Weighted k-means in Lab, DETERMINISTIC: seeded with the heaviest colour
 * (the first of equal weights), then repeatedly the colour farthest from
 * every seed so far; a fixed iteration count. `k` is capped by the number
 * of distinct colours, so asking for 6 of a 2-colour drawing answers 2.
 */
export function kMeansLab(
  colors: readonly WeightedColor[],
  k: number,
): LabClusters {
  const labs = colors.map((c) => rgbToLab(c.rgb));
  const weights = colors.map((c) => Math.max(0, c.weight) || 0);
  if (labs.length === 0 || k < 1) return { centres: [], assignment: [] };
  let first = 0;
  for (let i = 1; i < labs.length; i++)
    if (weights[i] > weights[first]) first = i;
  const centres: Lab[] = [{ ...labs[first] }];
  const nearestD = labs.map((l) => deltaE(l, centres[0]));
  while (centres.length < k) {
    let far = -1;
    for (let i = 0; i < labs.length; i++)
      if (far < 0 || nearestD[i] > nearestD[far]) far = i;
    if (far < 0 || nearestD[far] <= 1e-9) break;
    centres.push({ ...labs[far] });
    for (let i = 0; i < labs.length; i++)
      nearestD[i] = Math.min(nearestD[i], deltaE(labs[i], labs[far]));
  }
  const assign = (): number[] =>
    labs.map((l) => {
      let best = 0;
      for (let c = 1; c < centres.length; c++)
        if (deltaE(l, centres[c]) < deltaE(l, centres[best])) best = c;
      return best;
    });
  let assignment = assign();
  for (let it = 0; it < KMEANS_ITERATIONS; it++) {
    const sum = centres.map(() => ({ l: 0, a: 0, b: 0, w: 0 }));
    labs.forEach((l, i) => {
      const s = sum[assignment[i]];
      const w = weights[i] > 0 ? weights[i] : 1e-6;
      s.l += l.l * w;
      s.a += l.a * w;
      s.b += l.b * w;
      s.w += w;
    });
    sum.forEach((s, c) => {
      if (s.w > 0) centres[c] = { l: s.l / s.w, a: s.a / s.w, b: s.b / s.w };
    });
    const next = assign();
    if (next.every((v, i) => v === assignment[i])) break;
    assignment = next;
  }
  return { centres, assignment };
}

/**
 * REDUCE TO N COLOURS: cluster the artwork's colours in Lab and answer,
 * per input colour, the colour it becomes — the HEAVIEST member of its
 * cluster (an existing colour of the artwork, as Illustrator's reduction
 * keeps a "current" colour per row, never an averaged one that no object
 * used).
 */
export function reduceColors(
  colors: readonly WeightedColor[],
  n: number,
): Rgb[] {
  const { assignment, centres } = kMeansLab(colors, n);
  const pick: number[] = centres.map(() => -1);
  assignment.forEach((c, i) => {
    if (pick[c] < 0 || colors[i].weight > colors[pick[c]].weight) pick[c] = i;
  });
  return assignment.map((c) => {
    const rep = colors[pick[c]]?.rgb ?? colors[0].rgb;
    return [rep[0], rep[1], rep[2]];
  });
}

/** The index of the library colour nearest `c` (ΔE76); -1 for an empty
 *  library. */
export function nearestColorIndex(c: Rgb, library: readonly Rgb[]): number {
  const lab = rgbToLab(c);
  let best = -1;
  let bestD = Infinity;
  library.forEach((l, i) => {
    const d = deltaE(lab, rgbToLab(l));
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

/** Saturation or brightness under which a colour counts as NEUTRAL
 *  (black, white, a grey) — what "preserve neutrals" leaves alone. */
export const NEUTRAL_SATURATION = 0.08;

export const isNeutral = (c: Rgb): boolean => {
  const hsb = rgbToHsb(c);
  return hsb.s < NEUTRAL_SATURATION || hsb.b < NEUTRAL_SATURATION;
};

/**
 * RECOLOUR TO A HARMONY: assign the artwork's colours to the harmony's
 * colours and answer, per input colour, its new colour.
 *
 * The chromatic colours are clustered (Lab k-means, k = the harmony's
 * size) and the clusters ranked by weight; the heaviest takes the
 * harmony's first (base) colour, the next the second, and so on. Inside
 * a cluster every colour keeps its OFFSET from the cluster's heaviest
 * colour — hue, saturation and brightness — so a drawing's light and
 * dark variants of one colour stay light and dark variants of the new
 * one. Neutrals map to themselves unless `recolorNeutrals`.
 */
export function recolorToHarmony(
  colors: readonly WeightedColor[],
  harmony: readonly Rgb[],
  options: { recolorNeutrals?: boolean } = {},
): Rgb[] {
  const out: Rgb[] = colors.map((c) => [c.rgb[0], c.rgb[1], c.rgb[2]]);
  if (harmony.length === 0) return out;
  const chromatic = colors
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => options.recolorNeutrals || !isNeutral(c.rgb));
  if (chromatic.length === 0) return out;
  const { assignment, centres } = kMeansLab(
    chromatic.map(({ c }) => c),
    harmony.length,
  );
  const weight = centres.map(() => 0);
  const lead: number[] = centres.map(() => -1);
  assignment.forEach((cl, j) => {
    const w = chromatic[j].c.weight;
    weight[cl] += w;
    if (lead[cl] < 0 || w > chromatic[lead[cl]].c.weight) lead[cl] = j;
  });
  // Rank clusters by weight (ties: lower cluster index first).
  const rank = centres
    .map((_, cl) => cl)
    .sort((a, b) => weight[b] - weight[a] || a - b);
  const target = new Map<number, Rgb>();
  rank.forEach((cl, r) => target.set(cl, harmony[r % harmony.length]));
  assignment.forEach((cl, j) => {
    const own = rgbToHsb(chromatic[j].c.rgb);
    const ref = rgbToHsb(chromatic[lead[cl]].c.rgb);
    const to = rgbToHsb(target.get(cl)!);
    out[chromatic[j].i] = hsbToRgb({
      h: to.h + hueDelta(ref.h, own.h),
      s: clamp(to.s + (own.s - ref.s), 0, 1),
      b: clamp(to.b + (own.b - ref.b), 0, 1),
    });
  });
  return out;
}

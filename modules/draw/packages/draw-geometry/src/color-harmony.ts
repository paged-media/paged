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
// (Illustrator §18). Zero dependencies, no host: sRGB 0..255 in and out.
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

import type { Rgb } from "./svg-color";

/** Hue 0..360, saturation and brightness 0..1. */
export interface Hsb {
  h: number;
  s: number;
  b: number;
}

/** CIE L*a*b* (D65): L 0..100, a/b roughly -128..127. */
export interface Lab {
  l: number;
  a: number;
  b: number;
}

const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v));

const byte = (v: number): number => clamp(Math.round(v), 0, 255);

/** Wrap an angle into 0..360. */
export const wrapHue = (h: number): number => ((h % 360) + 360) % 360;

/** Signed shortest hue difference `to - from`, in -180..180. */
export function hueDelta(from: number, to: number): number {
  const d = wrapHue(to - from);
  return d > 180 ? d - 360 : d;
}

export function rgbToHsb(c: Rgb): Hsb {
  const r = c[0] / 255;
  const g = c[1] / 255;
  const b = c[2] / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  return { h: wrapHue(h), s: max === 0 ? 0 : d / max, b: max };
}

export function hsbToRgb(c: Hsb): Rgb {
  const h = wrapHue(c.h);
  const s = clamp(c.s, 0, 1);
  const v = clamp(c.b, 0, 1);
  const k = (n: number): number => (n + h / 60) % 6;
  const f = (n: number): number =>
    v - v * s * Math.max(0, Math.min(k(n), 4 - k(n), 1));
  return [byte(f(5) * 255), byte(f(3) * 255), byte(f(1) * 255)];
}

const toLinear = (v: number): number => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (v: number): number => {
  const c = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  return c * 255;
};

// D65 reference white.
const XN = 0.95047;
const YN = 1;
const ZN = 1.08883;
const EPS = 216 / 24389;
const KAPPA = 24389 / 27;

export function rgbToLab(c: Rgb): Lab {
  const r = toLinear(c[0]);
  const g = toLinear(c[1]);
  const b = toLinear(c[2]);
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / XN;
  const y = (0.2126729 * r + 0.7151522 * g + 0.072175 * b) / YN;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / ZN;
  const f = (t: number): number =>
    t > EPS ? Math.cbrt(t) : (KAPPA * t + 16) / 116;
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return { l: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

export function labToRgb(c: Lab): Rgb {
  const fy = (c.l + 16) / 116;
  const fx = fy + c.a / 500;
  const fz = fy - c.b / 200;
  const inv = (t: number): number =>
    t ** 3 > EPS ? t ** 3 : (116 * t - 16) / KAPPA;
  const x = inv(fx) * XN;
  const y = (c.l > KAPPA * EPS ? fy ** 3 : c.l / KAPPA) * YN;
  const z = inv(fz) * ZN;
  const r = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
  const g = -0.969266 * x + 1.8760108 * y + 0.041556 * z;
  const b = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;
  return [
    byte(fromLinear(clamp(r, 0, 1))),
    byte(fromLinear(clamp(g, 0, 1))),
    byte(fromLinear(clamp(b, 0, 1))),
  ];
}

/** CIE76 colour difference. */
export function deltaE(a: Lab, b: Lab): number {
  return Math.hypot(a.l - b.l, a.a - b.a, a.b - b.b);
}

export const sameRgb = (a: Rgb, b: Rgb): boolean =>
  a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

// ------------------------------------------------------------ harmony rules

/** Illustrator's Color Guide harmony rules (the ones a rule menu needs). */
export type HarmonyRule =
  | "complementary"
  | "analogous"
  | "triadic"
  | "splitComplementary"
  | "tetradic"
  | "monochromatic"
  | "shades"
  | "tints";

export const HARMONY_RULES: readonly HarmonyRule[] = [
  "complementary",
  "analogous",
  "triadic",
  "splitComplementary",
  "tetradic",
  "monochromatic",
  "shades",
  "tints",
];

/** The hue offsets of the rules that are hue sets (base first). */
const HUE_RULES: Partial<Record<HarmonyRule, readonly number[]>> = {
  complementary: [0, 180],
  analogous: [0, -30, 30],
  triadic: [0, 120, 240],
  splitComplementary: [0, 150, 210],
  tetradic: [0, 90, 180, 270],
};

/**
 * The harmony of `base` under `rule`, BASE FIRST. Hue rules keep the
 * base's saturation and brightness and move the hue; the three
 * one-hue rules vary brightness and saturation instead (monochromatic
 * both, shades toward black, tints toward white). A neutral base (no
 * saturation) has no hue to rotate: its hue rules answer greys at the
 * base's brightness, which is what the wheel shows for it.
 */
export function harmonyOf(base: Rgb, rule: HarmonyRule): Rgb[] {
  const hsb = rgbToHsb(base);
  const offsets = HUE_RULES[rule];
  if (offsets) {
    return offsets.map((d, i) =>
      i === 0
        ? [base[0], base[1], base[2]]
        : hsbToRgb({ ...hsb, h: hsb.h + d }),
    );
  }
  const out: Rgb[] = [[base[0], base[1], base[2]]];
  if (rule === "shades") {
    for (const f of [0.8, 0.6, 0.4, 0.2])
      out.push(hsbToRgb({ ...hsb, b: hsb.b * f }));
  } else if (rule === "tints") {
    for (const f of [0.75, 0.5, 0.3, 0.15]) {
      out.push(
        hsbToRgb({ h: hsb.h, s: hsb.s * f, b: hsb.b + (1 - hsb.b) * (1 - f) }),
      );
    }
  } else {
    // monochromatic: the same hue, at four other saturation/brightness pairs.
    const pairs: readonly [number, number][] = [
      [1, 0.7],
      [0.6, 1],
      [1, 0.45],
      [0.3, 1],
    ];
    for (const [fs, fb] of pairs) {
      out.push(
        hsbToRgb({ h: hsb.h, s: hsb.s * fs, b: clamp(hsb.b * fb, 0, 1) }),
      );
    }
  }
  return out;
}

/** Rotate every colour's hue by `deg` (a drag of the wheel's base handle
 *  turns the WHOLE harmony, so the relations between its colours hold).
 *  Saturation and brightness are kept; a neutral stays neutral. */
export function rotateHues(colors: readonly Rgb[], deg: number): Rgb[] {
  return colors.map((c) => {
    const hsb = rgbToHsb(c);
    if (hsb.s === 0 || deg === 0) return [c[0], c[1], c[2]];
    return hsbToRgb({ ...hsb, h: hsb.h + deg });
  });
}

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

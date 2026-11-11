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

// Naive colour conversions on 8-bit channels (0..255) and inks in percent
// (0..100, the IDML swatch convention). Device CMYK with no profile: good
// for a field's round trip and an interchange preview, never authoritative
// (the colour-managed path is the engine's).

/** `#rgb` / `#rrggbb` (the `#` optional) to RGB channels, or null. */
export function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const body = m[1].length === 3 ? m[1].replace(/./g, (ch) => ch + ch) : m[1];
  const n = Number.parseInt(body, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** One channel rounded and clamped to 0..255. NaN stays NaN: the caller's
 *  input was not a colour, and a guard upstream must say so. */
const channel = (v: number): number =>
  Math.max(0, Math.min(255, Math.round(v)));

/** RGB channels to a lower-case `#rrggbb`; a missing channel is 0. */
export function rgbToHex(rgb: readonly number[]): string {
  const h = (v: number | undefined) =>
    channel(v ?? 0)
      .toString(16)
      .padStart(2, "0");
  return `#${h(rgb[0])}${h(rgb[1])}${h(rgb[2])}`;
}

const percent = (v: number | undefined): number =>
  Math.min(100, Math.max(0, v ?? 0)) / 100;

/** Naive CMYK (0..100 each, clamped) to RGB channels. */
export function cmykToRgb(cmyk: readonly number[]): [number, number, number] {
  const [c, m, y, k] = [0, 1, 2, 3].map((i) => percent(cmyk[i]));
  return [
    Math.round(255 * (1 - c) * (1 - k)),
    Math.round(255 * (1 - m) * (1 - k)),
    Math.round(255 * (1 - y) * (1 - k)),
  ];
}

/** RGB channels to naive CMYK (0..100 each). */
export function rgbToCmyk(
  rgb: readonly number[],
): [number, number, number, number] {
  const r = (rgb[0] ?? 0) / 255;
  const g = (rgb[1] ?? 0) / 255;
  const b = (rgb[2] ?? 0) / 255;
  const k = 1 - Math.max(r, g, b);
  if (k >= 1) return [0, 0, 0, 100];
  const d = 1 - k;
  return [
    Math.round(((1 - r - k) / d) * 100),
    Math.round(((1 - g - k) / d) * 100),
    Math.round(((1 - b - k) / d) * 100),
    Math.round(k * 100),
  ];
}

/** sRGB-encoded `c` (0..1) in linear light (the sRGB EOTF). The Rust twin is
 *  `paged_color::math::srgb_to_linear` (f32); this one is f64. */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Linear light `c` as sRGB-encoded (the sRGB OETF, the inverse of
 *  {@link srgbToLinear}). Not clamped above 1. */
export function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
}

// ---------------------------------------------------------------- models
//
// HSB, HSL and CIE L*a*b* over sRGB, and the colour-theory harmonies: one
// implementation (PM-0017) for the host Color Wheel and its Color Guide,
// the colour fields, the Info panel and paged.draw's Recolor Artwork
// (`@paged-media/vector-geometry` re-exports these beside its k-means).
// HSB is the WHEEL (a harmony rule is a set of hue angles); Lab is for
// DISTANCE and for showing a colour's Lab numbers.

/** sRGB channels, 0..255. */
export type Rgb = readonly [number, number, number];

/** Hue 0..360, saturation and brightness 0..1. */
export interface Hsb {
  h: number;
  s: number;
  b: number;
}

/** CIE L*a*b*: L 0..100, a/b roughly -128..127 (D65 unless a function
 *  says otherwise). */
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

/** RGB (0..255) → HSL (H 0..360, S and L 0..1). */
export function rgbToHsl(c: Rgb): { h: number; s: number; l: number } {
  const r = c[0] / 255;
  const g = c[1] / 255;
  const b = c[2] / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: wrapHue(h * 60), s: d / (1 - Math.abs(2 * l - 1)), l };
}

const toLinear = (v: number): number => srgbToLinear(v / 255);
const fromLinear = (v: number): number => linearToSrgb(v) * 255;

/** A Lab reference white: D65 (sRGB's own, the distance space of Recolor
 *  Artwork and the Color Guide) or D50 (ICC's connection space and IDML's
 *  Lab, what the Info panel and the colour fields show). */
export type LabWhite = "D65" | "D50";

/** Per white: linear sRGB → XYZ (D50 is Bradford-adapted, the sRGB ICC
 *  profile's colorants), its inverse, and the white point. */
const LAB_SPACES: Record<
  LabWhite,
  { toXyz: readonly number[]; fromXyz: readonly number[]; white: Xyz }
> = {
  D65: {
    toXyz: [
      0.4124564, 0.3575761, 0.1804375, 0.2126729, 0.7151522, 0.072175,
      0.0193339, 0.119192, 0.9503041,
    ],
    fromXyz: [
      3.2404542, -1.5371385, -0.4985314, -0.969266, 1.8760108, 0.041556,
      0.0556434, -0.2040259, 1.0572252,
    ],
    white: [0.95047, 1, 1.08883],
  },
  D50: {
    toXyz: [
      0.4360747, 0.3850649, 0.1430804, 0.2225045, 0.7168786, 0.0606169,
      0.0139322, 0.0971045, 0.7141733,
    ],
    fromXyz: [
      3.1338561, -1.6168667, -0.4906146, -0.9787684, 1.9161415, 0.033454,
      0.0719453, -0.2289914, 1.4052427,
    ],
    white: [0.96422, 1, 0.82521],
  },
};
type Xyz = readonly [number, number, number];

const EPS = 216 / 24389;
const KAPPA_LAB = 24389 / 27;

/** sRGB (0..255) → CIE L*a*b* under `white` (D65 by default), unrounded. */
export function rgbToLab(c: Rgb, white: LabWhite = "D65"): Lab {
  const { toXyz: m, white: n } = LAB_SPACES[white];
  const r = toLinear(c[0]);
  const g = toLinear(c[1]);
  const b = toLinear(c[2]);
  const x = (m[0]! * r + m[1]! * g + m[2]! * b) / n[0];
  const y = (m[3]! * r + m[4]! * g + m[5]! * b) / n[1];
  const z = (m[6]! * r + m[7]! * g + m[8]! * b) / n[2];
  const f = (t: number): number =>
    t > EPS ? Math.cbrt(t) : (KAPPA_LAB * t + 16) / 116;
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return { l: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

/** CIE L*a*b* under `white` (D65 by default) → sRGB 0..255, clipped. */
export function labToRgb(c: Lab, white: LabWhite = "D65"): Rgb {
  const { fromXyz: m, white: n } = LAB_SPACES[white];
  const fy = (c.l + 16) / 116;
  const fx = fy + c.a / 500;
  const fz = fy - c.b / 200;
  const inv = (t: number): number =>
    t ** 3 > EPS ? t ** 3 : (116 * t - 16) / KAPPA_LAB;
  const x = inv(fx) * n[0];
  const y = (c.l > KAPPA_LAB * EPS ? fy ** 3 : c.l / KAPPA_LAB) * n[1];
  const z = inv(fz) * n[2];
  const r = m[0]! * x + m[1]! * y + m[2]! * z;
  const g = m[3]! * x + m[4]! * y + m[5]! * z;
  const b = m[6]! * x + m[7]! * y + m[8]! * z;
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

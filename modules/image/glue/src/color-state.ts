// Foreground / background colour — Photoshop's two-colour model.
//
// The foreground is what paint lays down (brush, pencil, fills that ask
// for one colour); the background is the second gradient stop. Before
// this the panel offered eight preset wells and nothing else: a user
// could not paint in the colour of the image they were retouching.
//
// Pure functions over straight RGBA in [0,1]; the session owns the
// state and wires it to the brush.

import { hexToRgb, rgbToHex } from "@paged-media/helpers";

import type { Rgba01 } from "./engine";

export interface ColorPair {
  fg: Rgba01;
  bg: Rgba01;
}

/** Photoshop's D: black foreground, white background. */
export const DEFAULT_COLORS: ColorPair = {
  fg: [0, 0, 0, 1],
  bg: [1, 1, 1, 1],
};

export function freshColors(): ColorPair {
  return { fg: [...DEFAULT_COLORS.fg], bg: [...DEFAULT_COLORS.bg] };
}

/** Photoshop's X. */
export function swapped(c: ColorPair): ColorPair {
  return { fg: [...c.bg], bg: [...c.fg] };
}

/** Sampling sizes the eyedropper offers (Photoshop's list): the point,
 *  then the average of an N×N window around it. */
export type SampleSize = 1 | 3 | 5 | 11 | 31 | 51 | 101;

export const SAMPLE_SIZES: readonly SampleSize[] = [1, 3, 5, 11, 31, 51, 101];

/** What the eyedropper reads: the active layer's own pixels, or the
 *  composite of every visible layer (what is on screen). */
export type SampleSource = "layer" | "all";

export interface EyedropperOptions {
  size: SampleSize;
  source: SampleSource;
}

export const DEFAULT_EYEDROPPER: EyedropperOptions = { size: 1, source: "all" };

/** Photoshop's limit on colour samplers. */
export const MAX_SAMPLERS = 4;

/** One fixed colour sampler: where it reads (image px) and what it reads
 *  now (null when the point is off the image or nothing is open). */
export interface ColorSamplerInfo {
  /** 1-based, as Photoshop numbers them; a removed number is reused. */
  id: number;
  at: [number, number];
  colour: Rgba01 | null;
}

/** Is `v` one of the offered sample sizes? */
export function isSampleSize(v: unknown): v is SampleSize {
  return (SAMPLE_SIZES as readonly unknown[]).includes(v);
}

/** The lowest sampler number not in use, or null when all four are. */
export function nextSamplerId(
  samplers: readonly ColorSamplerInfo[],
): number | null {
  for (let id = 1; id <= MAX_SAMPLERS; id++) {
    if (!samplers.some((s) => s.id === id)) return id;
  }
  return null;
}

/** The sampler whose pixel CENTRE lies within `radius` image px of `at`
 *  (the nearest one). */
export function samplerNear(
  samplers: readonly ColorSamplerInfo[],
  at: [number, number],
  radius: number,
): ColorSamplerInfo | null {
  let best: ColorSamplerInfo | null = null;
  let bestD = radius;
  for (const s of samplers) {
    const d = Math.hypot(s.at[0] + 0.5 - at[0], s.at[1] + 0.5 - at[1]);
    if (d <= bestD) {
      best = s;
      bestD = d;
    }
  }
  return best;
}

/** The window an N×N sample around image pixel `at` covers, clipped to a
 *  `w`×`h` image; null when `at` lies outside it. */
export function sampleWindow(
  at: [number, number],
  size: SampleSize,
  w: number,
  h: number,
): { x: number; y: number; w: number; h: number } | null {
  const px = Math.floor(at[0]);
  const py = Math.floor(at[1]);
  if (px < 0 || py < 0 || px >= w || py >= h) return null;
  const r = (size - 1) / 2;
  const x0 = Math.max(0, px - r);
  const y0 = Math.max(0, py - r);
  const x1 = Math.min(w, px + r + 1);
  const y1 = Math.min(h, py + r + 1);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * The average of a straight-RGBA8 window (as `engine.tile` returns it),
 * as straight RGBA in [0,1]. Colour is averaged PREMULTIPLIED, so a
 * transparent neighbour does not drag the sample toward black; alpha is
 * the plain mean. An empty window yields null.
 */
export function averageRgba8(px: Uint8Array): Rgba01 | null {
  const n = Math.floor(px.length / 4);
  if (n === 0) return null;
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  for (let i = 0; i < n * 4; i += 4) {
    const al = px[i + 3] / 255;
    r += (px[i] / 255) * al;
    g += (px[i + 1] / 255) * al;
    b += (px[i + 2] / 255) * al;
    a += al;
  }
  if (a === 0) return [0, 0, 0, 0];
  return [r / a, g / a, b / a, a / n];
}

/** `#rrggbb` for a colour (alpha dropped — the hex field is RGB). */
export function toHex(c: Rgba01): string {
  return rgbToHex([c[0] * 255, c[1] * 255, c[2] * 255]);
}

/** Parse `#rgb` / `#rrggbb` (opaque), or null. */
export function fromHex(s: string): Rgba01 | null {
  const rgb = hexToRgb(s);
  return rgb ? [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, 1] : null;
}

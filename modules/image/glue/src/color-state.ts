// Foreground / background colour — Photoshop's two-colour model.
//
// The foreground is what paint lays down (brush, pencil, fills that ask
// for one colour); the background is the second gradient stop. Before
// this the panel offered eight preset wells and nothing else: a user
// could not paint in the colour of the image they were retouching.
//
// Pure functions over straight RGBA in [0,1]; the session owns the
// state and wires it to the brush.

import { hexToRgb, rgbToHex, type SampleSize } from "@paged-media/helpers";

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

// The sample sizes and the window average are the host Eyedropper's too:
// one implementation in `@paged-media/helpers`.
export {
  SAMPLE_SIZES,
  averageRgba8,
  isSampleSize,
  sampleWindow,
  type SampleSize,
} from "@paged-media/helpers";
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

/** `#rrggbb` for a colour (alpha dropped — the hex field is RGB). */
export function toHex(c: Rgba01): string {
  return rgbToHex([c[0] * 255, c[1] * 255, c[2] * 255]);
}

/** Parse `#rgb` / `#rrggbb` (opaque), or null. */
export function fromHex(s: string): Rgba01 | null {
  const rgb = hexToRgb(s);
  return rgb ? [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, 1] : null;
}

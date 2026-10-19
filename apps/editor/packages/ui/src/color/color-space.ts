/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
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

// Concept 2 — channel metadata for the colour mixer. The canonical
// wire spaces are the SwatchSpec vocabulary (CMYK / RGB / LAB /
// Gray, IDML units); HSB is a UI-only affordance over RGB (see
// hsb.ts) and never crosses the wire.

import type { SwatchSpec } from "@paged-media/client";

/** The canonical (wire) mixer state. */
export interface MixerValue {
  space: "CMYK" | "RGB" | "LAB" | "Gray";
  /** Channels in IDML units (CMYK 0..100, RGB 0..255, Lab L 0..100
   *  a/b −128..127, Gray ink 0..100). */
  value: number[];
  /** Swatch-level tint, 0..100. 100 = solid. */
  tint: number;
}

export interface ChannelMeta {
  key: string;
  label: string;
  min: number;
  max: number;
  precision: number;
}

export const SPACE_CHANNELS: Record<MixerValue["space"], ChannelMeta[]> = {
  CMYK: [
    { key: "c", label: "C", min: 0, max: 100, precision: 0 },
    { key: "m", label: "M", min: 0, max: 100, precision: 0 },
    { key: "y", label: "Y", min: 0, max: 100, precision: 0 },
    { key: "k", label: "K", min: 0, max: 100, precision: 0 },
  ],
  RGB: [
    { key: "r", label: "R", min: 0, max: 255, precision: 0 },
    { key: "g", label: "G", min: 0, max: 255, precision: 0 },
    { key: "b", label: "B", min: 0, max: 255, precision: 0 },
  ],
  LAB: [
    { key: "l", label: "L", min: 0, max: 100, precision: 0 },
    { key: "a", label: "a", min: -128, max: 127, precision: 0 },
    { key: "b", label: "b", min: -128, max: 127, precision: 0 },
  ],
  Gray: [{ key: "k", label: "K", min: 0, max: 100, precision: 0 }],
};

/** A neutral default per space (the seed when editing from the
 *  mixed sentinel or switching spaces). */
export function defaultValue(space: MixerValue["space"]): number[] {
  switch (space) {
    case "CMYK":
      return [0, 0, 0, 100];
    case "RGB":
      return [128, 128, 128];
    case "LAB":
      return [50, 0, 0];
    case "Gray":
      return [100];
  }
}

/** Build the `createSwatch`/`editSwatch` spec from mixer state. */
export function valueToSwatchSpec(v: MixerValue, name?: string): SwatchSpec {
  return {
    selfId: null,
    name: name ?? null,
    space: v.space,
    value: [...v.value],
    model: "Process",
    alternateSpace: null,
    alternateValue: [],
    tint: v.tint < 100 ? v.tint : null,
    alpha: null,
  };
}

// hexToRgb / rgbToHex and the naive CMYK pair below are the shared ones
// (`@paged-media/helpers`): one implementation for the editor and the
// built-ins. `hexToRgb` also reads the `#rgb` shorthand.
export { cmykToRgb, hexToRgb, rgbToCmyk, rgbToHex } from "@paged-media/helpers";

// Panel-gallery pass — naive client-side conversions for the colour
// wheel's HEX · RGB · CMYK · HSL field round-trip. These are UI
// approximations (device CMYK, no profile); the CMM-accurate path
// stays `useColorCompute` / the engine's colorCompute and these
// never cross the wire as authoritative values.

/** RGB (0..255) → HSL (H 0..360, S/L 0..100). */
export function rgbToHsl(rgb: number[]): [number, number, number] {
  const r = (rgb[0] ?? 0) / 255;
  const g = (rgb[1] ?? 0) / 255;
  const b = (rgb[2] ?? 0) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [Math.round(h), Math.round(s * 100), Math.round(l * 100)];
}

/** WCAG relative luminance (0..1) — light-vs-dark label contrast
 *  on colour chips. */
export function luminance(rgb: number[]): number {
  const f = (v: number) => {
    const n = Math.min(255, Math.max(0, v)) / 255;
    return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
  };
  return (
    0.2126 * f(rgb[0] ?? 0) + 0.7152 * f(rgb[1] ?? 0) + 0.0722 * f(rgb[2] ?? 0)
  );
}

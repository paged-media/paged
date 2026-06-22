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

// CSS / SVG colour ⇄ RGB. Dependency-light: hex (`#rgb`, `#rrggbb`),
// `rgb()`/`rgba()` functional notation, and the 16 base CSS colour
// keywords (the common ones a hand-authored SVG uses). Anything else
// resolves to `null` (the caller decides the fallback — never a throw).
// The inverse formats an RGB triple as a `#rrggbb` string. Pure.

export type Rgb = readonly [number, number, number];

const NAMED: Record<string, Rgb> = {
  black: [0, 0, 0],
  silver: [192, 192, 192],
  gray: [128, 128, 128],
  grey: [128, 128, 128],
  white: [255, 255, 255],
  maroon: [128, 0, 0],
  red: [255, 0, 0],
  purple: [128, 0, 128],
  fuchsia: [255, 0, 255],
  magenta: [255, 0, 255],
  green: [0, 128, 0],
  lime: [0, 255, 0],
  olive: [128, 128, 0],
  yellow: [255, 255, 0],
  navy: [0, 0, 128],
  blue: [0, 0, 255],
  teal: [0, 128, 128],
  aqua: [0, 255, 255],
  cyan: [0, 255, 255],
  orange: [255, 165, 0],
};

const clamp255 = (n: number): number =>
  Math.max(0, Math.min(255, Math.round(n)));

/** Parse a CSS colour string to an RGB triple (0–255), or `null` for
 *  `none`/`transparent`/unrecognized input. */
export function parseCssColor(input: string): Rgb | null {
  const s = input.trim().toLowerCase();
  if (s === "" || s === "none" || s === "transparent") return null;

  if (s[0] === "#") {
    const hex = s.slice(1);
    if (hex.length === 3) {
      const r = parseInt(hex[0] + hex[0], 16);
      const g = parseInt(hex[1] + hex[1], 16);
      const b = parseInt(hex[2] + hex[2], 16);
      if ([r, g, b].every(Number.isFinite)) return [r, g, b];
      return null;
    }
    if (hex.length === 6) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      if ([r, g, b].every(Number.isFinite)) return [r, g, b];
      return null;
    }
    return null;
  }

  if (s.startsWith("rgb")) {
    const open = s.indexOf("(");
    const close = s.indexOf(")");
    if (open === -1 || close === -1) return null;
    const parts = s
      .slice(open + 1, close)
      .split(/[\s,/]+/)
      .filter((p) => p.length > 0);
    if (parts.length < 3) return null;
    const comp = (p: string): number => {
      if (p.endsWith("%")) return clamp255((parseFloat(p) / 100) * 255);
      return clamp255(parseFloat(p));
    };
    return [comp(parts[0]), comp(parts[1]), comp(parts[2])];
  }

  return NAMED[s] ?? null;
}

const hex2 = (n: number): string => clamp255(n).toString(16).padStart(2, "0");

/** Format an RGB triple as a lowercase `#rrggbb` string. */
export function rgbToHex(rgb: Rgb): string {
  return `#${hex2(rgb[0])}${hex2(rgb[1])}${hex2(rgb[2])}`;
}

/** Convert CMYK (0–100 each, the IDML/engine swatch convention) to an
 *  RGB triple via the naive subtractive model — good enough for an
 *  interchange round-trip preview, NOT colour-managed (that lives in the
 *  engine; the SVG lane is sRGB). */
export function cmykToRgb(
  c: number,
  m: number,
  y: number,
  k: number,
): Rgb {
  const cc = c / 100;
  const mm = m / 100;
  const yy = y / 100;
  const kk = k / 100;
  return [
    clamp255(255 * (1 - cc) * (1 - kk)),
    clamp255(255 * (1 - mm) * (1 - kk)),
    clamp255(255 * (1 - yy) * (1 - kk)),
  ];
}

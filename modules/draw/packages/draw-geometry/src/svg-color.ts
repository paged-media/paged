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
//
// "ANYTHING ELSE IS NULL" IS THE CONTRACT, AND IT IS ENFORCED BY
// VALIDATING, NOT BY CONVERTING. `parseInt` and `parseFloat` are
// PREFIX parsers — they read as much of a string as looks like a number
// and ignore the rest — so "convert, then check for NaN" accepts
// `#00000g` (parseInt stops at the `g`), `#-1-1-1` (it reads a sign) and
// would hand `rgb(a, b, c)` back as three NaNs. Every form below is
// therefore matched against its grammar FIRST and converted only once it
// has matched; what `parseCssColor` returns is `null` or three integers
// in 0..255, for any string at all.

export type Rgb = readonly [number, number, number];

// A lookup table keyed by UNTRUSTED text must not be a plain object
// literal: `table[key]` walks the prototype chain, so `"constructor"`
// answers the `Object` function and `"__proto__"` answers
// `Object.prototype`. A `Map` has no inherited keys.
const NAMED: ReadonlyMap<string, Rgb> = new Map<string, Rgb>([
  ["black", [0, 0, 0]],
  ["silver", [192, 192, 192]],
  ["gray", [128, 128, 128]],
  ["grey", [128, 128, 128]],
  ["white", [255, 255, 255]],
  ["maroon", [128, 0, 0]],
  ["red", [255, 0, 0]],
  ["purple", [128, 0, 128]],
  ["fuchsia", [255, 0, 255]],
  ["magenta", [255, 0, 255]],
  ["green", [0, 128, 0]],
  ["lime", [0, 255, 0]],
  ["olive", [128, 128, 0]],
  ["yellow", [255, 255, 0]],
  ["navy", [0, 0, 128]],
  ["blue", [0, 0, 255]],
  ["teal", [0, 128, 128]],
  ["aqua", [0, 255, 255]],
  ["cyan", [0, 255, 255]],
  ["orange", [255, 165, 0]],
]);

const clamp255 = (n: number): number =>
  Math.max(0, Math.min(255, Math.round(n)));

/** The whole of a hex colour's body: three or six hex digits, nothing
 *  else (the input is already lowercased). */
const HEX_BODY = /^(?:[0-9a-f]{3}|[0-9a-f]{6})$/;

/** `rgb(` / `rgba(` — exactly those two names. Whitespace before the
 *  parenthesis is tolerated (CSS does not allow it; this reader always
 *  has), a longer name is not: `rgbfoo(1, 2, 3)` is not a colour. */
const RGB_CALL = /^rgba?\s*\(([^)]*)\)/;

/** One `rgb()` component: a CSS number, optionally a percentage. */
const RGB_COMPONENT = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?%?$/;

/** Parse a CSS colour string to an RGB triple (0–255), or `null` for
 *  `none`/`transparent`/unrecognized input. */
export function parseCssColor(input: string): Rgb | null {
  const s = input.trim().toLowerCase();
  if (s === "" || s === "none" || s === "transparent") return null;

  if (s[0] === "#") {
    const hex = s.slice(1);
    if (!HEX_BODY.test(hex)) return null;
    if (hex.length === 3) {
      return [
        parseInt(hex[0] + hex[0], 16),
        parseInt(hex[1] + hex[1], 16),
        parseInt(hex[2] + hex[2], 16),
      ];
    }
    return [
      parseInt(hex.slice(0, 2), 16),
      parseInt(hex.slice(2, 4), 16),
      parseInt(hex.slice(4, 6), 16),
    ];
  }

  if (s.startsWith("rgb")) {
    const call = RGB_CALL.exec(s);
    if (call === null) return null;
    const parts = call[1].split(/[\s,/]+/).filter((p) => p.length > 0);
    if (parts.length < 3) return null;
    // Only the three colour components are read; a fourth (alpha) is
    // dropped unseen, as before.
    const rgb = parts.slice(0, 3);
    if (!rgb.every((p) => RGB_COMPONENT.test(p))) return null;
    const comp = (p: string): number => {
      if (p.endsWith("%")) return clamp255((parseFloat(p) / 100) * 255);
      return clamp255(parseFloat(p));
    };
    return [comp(rgb[0]), comp(rgb[1]), comp(rgb[2])];
  }

  return NAMED.get(s) ?? null;
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

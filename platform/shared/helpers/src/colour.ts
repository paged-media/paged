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

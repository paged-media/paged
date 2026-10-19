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

// Length units. Points are the document's unit (IDML's native one); a CSS
// pixel is 1/96 in, so 0.75 pt. (The editor's length inputs treat a canvas
// pixel as one point instead: that is their own table, built on this one.)

/** Points per one unit of each length unit a field accepts. `pc` and `p`
 *  are picas. The SDK's public `parseLength` (plugin-sdk object-schema) reads
 *  the same table; a test holds the two equal. */
export const PT_PER_UNIT: Readonly<Record<string, number>> = Object.freeze({
  pt: 1,
  px: 0.75,
  in: 72,
  mm: 72 / 25.4,
  cm: 72 / 2.54,
  pc: 12,
  p: 12,
});

/** CSS pixels per point (96 dpi): page points to a web frame's pixels. */
export const PX_PER_PT = 96 / 72;

/** Points per CSS pixel (96 dpi). */
export const PT_PER_PX = 72 / 96;

/** Parse a length with an optional unit (`"3mm"`, `"12"`, `"0.5in"`) into
 *  points; null when it is not one. A bare number is points. */
export function parseLength(text: string): number | null {
  const m = /^\s*(-?\d+(?:\.\d+)?|-?\.\d+)\s*([a-z]*)\s*$/i.exec(text);
  if (!m) return null;
  const factor = m[2] ? PT_PER_UNIT[m[2].toLowerCase()] : 1;
  return factor === undefined ? null : Number(m[1]) * factor;
}

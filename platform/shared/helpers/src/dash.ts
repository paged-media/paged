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

// STROKE DASH PRESETS — the alternating on/off runs (pt) the dash preset
// commands write, and the one wire op that writes a dash array. One
// implementation (PM-0017): the editor's `paged.stroke.dash*` commands and
// paged.draw's dash editor both build through it.

/** The preset runs. Solid clears the array; the others alternate on/off
 *  lengths in pt (Dashed 6/3, Dotted 1/3, Dash-dot 6/3/1/3). */
export const DASH_PRESET_LENGTHS = {
  solid: [] as readonly number[],
  dashed: [6, 3] as readonly number[],
  dotted: [1, 3] as readonly number[],
  dashDot: [6, 3, 1, 3] as readonly number[],
};

/** `setElementProperty{ frameStrokeDashArray }` for one element: a
 *  `lengths` value, empty = solid. */
export function dashArrayOp(elementId: unknown, lengths: readonly number[]) {
  return {
    op: "setElementProperty" as const,
    args: {
      elementId,
      path: "frameStrokeDashArray" as const,
      value: { type: "lengths" as const, value: [...lengths] },
    },
  };
}

// THE DASH EDITOR'S MODEL — up to three dash/gap pairs (Illustrator's six
// fields). The engine's array is any alternating run; the editor shows the
// first three pairs, and says how many it hides.

/** The most dash/gap pairs the editor offers. */
export const MAX_DASH_PAIRS = 3;

/** One dash and the gap after it, in pt. */
export interface DashPair {
  dash: number;
  gap: number;
}

/** The pairs of a dash array, or `null` for a solid stroke (empty, or every
 *  length 0). An ODD-length array repeats to even (the SVG/PDF dash rule),
 *  unreadable lengths are dropped, and `hiddenPairs` counts the pairs past
 *  the third, which an edit would rewrite away. Pure. */
export function dashPairsFromLengths(
  lengths: readonly number[] | null,
): { pairs: DashPair[]; hiddenPairs: number } | null {
  const values = (lengths ?? []).filter((n) => Number.isFinite(n) && n >= 0);
  if (values.length === 0 || values.every((n) => n === 0)) return null;
  const even = values.length % 2 === 1 ? [...values, ...values] : values;
  const pairs: DashPair[] = [];
  for (let i = 0; i < even.length; i += 2)
    pairs.push({ dash: even[i]!, gap: even[i + 1]! });
  return {
    pairs: pairs.slice(0, MAX_DASH_PAIRS),
    hiddenPairs: Math.max(0, pairs.length - MAX_DASH_PAIRS),
  };
}

/** The engine's array for `pairs`: the first pair and every later pair that
 *  is not 0 / 0, in order; `[]` (solid) when every length is 0. A negative
 *  or unreadable length is 0. Pure. */
export function dashLengthsFromPairs(pairs: readonly DashPair[]): number[] {
  const clean = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);
  const out: number[] = [];
  pairs.slice(0, MAX_DASH_PAIRS).forEach(({ dash, gap }, i) => {
    const d = clean(dash);
    const g = clean(gap);
    if (i === 0 || d > 0 || g > 0) out.push(d, g);
  });
  return out.every((n) => n === 0) ? [] : out;
}

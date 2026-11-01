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

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

// The image bundle's shared words: the engine's tokens (gradient kinds,
// tonal ranges, distortions) and the panel's colour names, as a user reads
// them. The English is the token itself where the panel always showed the
// token, so the English UI is unchanged; other locales name them properly.
// Each is read at render time through `t`, never at load.

import { defineMessages, t } from "@paged-media/strings";

const GRADIENT = defineMessages("image.gradientKind", {
  linear: "linear",
  radial: "radial",
  angular: "angular",
  reflected: "reflected",
  diamond: "diamond",
});

const TONE_RANGE = defineMessages("image.toneRange", {
  shadows: "shadows",
  midtones: "midtones",
  highlights: "highlights",
});

const HUE_SAT_RANGE = defineMessages("image.hueSatRange", {
  Reds: "Reds",
  Yellows: "Yellows",
  Greens: "Greens",
  Cyans: "Cyans",
  Blues: "Blues",
  Magentas: "Magentas",
});

const WARP = defineMessages("image.warpKind", {
  pinch: "pinch",
  spherize: "spherize",
  twirl: "twirl",
  wave: "wave",
});

/** The colour names of the panel's shortlists (gels, stops, brush wells). */
export const COLOR_NAMES = defineMessages("image.colorName", {
  warming85: "Warming (85)",
  warming81: "Warming (81)",
  cooling80: "Cooling (80)",
  cooling82: "Cooling (82)",
  sepia: "Sepia",
  red: "Red",
  green: "Green",
  blue: "Blue",
  black: "Black",
  white: "White",
  transparent: "Transparent",
  grey50: "50% grey",
  yellow: "Yellow",
  magenta: "Magenta",
  cyan: "Cyan",
});

function word(table: Readonly<Record<string, string>>, token: string): string {
  return Object.hasOwn(table, token) ? t(table[token]!) : token;
}

/** A gradient kind ("linear") in the editor's language. */
export const gradientKindLabel = (kind: string): string => word(GRADIENT, kind);
/** A tonal range ("midtones") in the editor's language. */
export const toneRangeLabel = (range: string): string =>
  word(TONE_RANGE, range);
/** A hue/saturation colour range ("Reds") in the editor's language. */
export const hueSatRangeLabel = (range: string): string =>
  word(HUE_SAT_RANGE, range);
/** A distortion ("twirl") in the editor's language. */
export const warpKindLabel = (kind: string): string => word(WARP, kind);

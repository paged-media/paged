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

// The words of the input primitives: the colour mixer and wheel, the
// bounds and length inputs (plan E10). Their German is `../locales/de.json`,
// registered by `./translations`.

import { defineMessages } from "@paged-media/strings";

export const COLOR = defineMessages("ui.color", {
  cyan: "Cyan",
  magenta: "Magenta",
  yellow: "Yellow",
  black: "Black",
  red: "Red",
  green: "Green",
  blue: "Blue",
  lightness: "Lightness",
  greenToRed: "a (green to red)",
  blueToYellow: "b (blue to yellow)",
  hue: "Hue",
  saturation: "Saturation",
  brightness: "Brightness",
  gray: "Gray",
  outOfGamut: "Out of gamut for the document's CMYK working space",
  naiveCmyk:
    "CMYK of an RGB colour by a simple conversion, not the document's colour settings",
  mixedSelection: "Mixed selection",
  tint: "Tint (%)",
  apply: "Apply",
  addToSwatches: "+ Add to Swatches",
  copyHexOrAdd: "Copy hex · double-click adds a swatch",
  copyHex: "Copy hex",
  copy: "Copy",
  harmony: "Harmony",
  noFill: "no fill",
  swatchReference: "swatch reference",
});

/** The colour harmonies, by their English name (`HarmonyName`). */
export const HARMONY = defineMessages("ui.harmony", {
  Complementary: "Complementary",
  Analogous: "Analogous",
  Triadic: "Triadic",
  SplitComp: "Split-Comp",
  Tetradic: "Tetradic",
  Monochromatic: "Monochromatic",
});

export const INPUT = defineMessages("ui.input", {
  top: "top",
  left: "left",
  bottom: "bottom",
  right: "right",
  topShort: "T",
  leftShort: "L",
  bottomShort: "B",
  rightShort: "R",
  unit: "unit",
  dragToAdjust: "Drag to adjust",
});

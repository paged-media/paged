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

// Concept 2 — HSB ↔ RGB, pure TS. HSB is a UI affordance over the
// RGB channels (there is no HSB ColorValue in the engine model);
// the HSB tab edits these and writes back RGB. Channels: H 0..360,
// S/B 0..100; RGB in IDML units 0..255.

// The conversion itself is `@paged-media/helpers`' (one HSB for the wheel,
// the mixer and the Color Guide); these are its 0..100 spellings.

import {
  hsbToRgb as hsbToRgbUnit,
  rgbToHsb as rgbToHsbUnit,
} from "@paged-media/helpers";

const ch = (rgb: readonly number[], i: number) => rgb[i] ?? 0;

export function rgbToHsb(rgb: readonly number[]): [number, number, number] {
  const { h, s, b } = rgbToHsbUnit([ch(rgb, 0), ch(rgb, 1), ch(rgb, 2)]);
  return [h, s * 100, b * 100];
}

export function hsbToRgb(hsb: readonly number[]): [number, number, number] {
  const [r, g, b] = hsbToRgbUnit({
    h: hsb[0] ?? 0,
    s: (hsb[1] ?? 0) / 100,
    b: (hsb[2] ?? 0) / 100,
  });
  return [r, g, b];
}

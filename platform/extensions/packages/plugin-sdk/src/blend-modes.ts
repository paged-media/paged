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

// Engine ADR 1034 — the 27 blend modes, read from the engine's catalog
// (`paged-blend`, through `paged-introspect`'s `blendModes`), in
// Photoshop's menu order. Menus and module schemas take their lists from
// here instead of keeping one.

import type { BlendModeInfo } from "@paged-media/plugin-api";

// Named import, so the bundler keeps only this key of the catalog.
import { blendModes } from "../../plugin-api/src/catalog.json";

/** Every blend mode, in Photoshop's menu order. */
export const BLEND_MODES: readonly BlendModeInfo[] = blendModes;

/** The model spellings (`frameBlendMode` values), in menu order. */
export const BLEND_MODE_NAMES: readonly string[] = BLEND_MODES.map(
  (m) => m.name,
);

/** The sixteen InDesign / PDF modes, in menu order. */
export const NATIVE_BLEND_MODE_NAMES: readonly string[] = BLEND_MODES.filter(
  (m) => m.native,
).map((m) => m.name);

/** The modes grouped as Photoshop's menu separates them. */
export function blendModeGroups(): BlendModeInfo[][] {
  const groups: BlendModeInfo[][] = [];
  for (const m of BLEND_MODES) (groups[m.group] ??= []).push(m);
  return groups;
}

/** A mode by its model spelling. */
export function blendModeByName(name: string): BlendModeInfo | undefined {
  return BLEND_MODES.find((m) => m.name === name);
}

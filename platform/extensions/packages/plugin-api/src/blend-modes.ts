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

/**
 * One blend mode as the engine publishes it (engine ADR 1034): the
 * catalog's `blendModes` rows, which plugin-sdk exports as `BLEND_MODES`.
 * The one list every menu and module schema reads — none keeps its own.
 */
export interface BlendModeInfo {
  /** The model spelling: the value of `frameBlendMode` and its kin. */
  name: string;
  /** The canonical snake_case id (paged.image's `compose.<id>`). */
  id: string;
  /** English display name (Photoshop's). */
  label: string;
  /** Photoshop's menu group, 0–5 (Normal · darken · lighten · contrast ·
   *  inversion · component). */
  group: number;
  /** One of the sixteen PDF / InDesign modes. `false` for Photoshop's
   *  eleven, which InDesign cannot store (IDML gets `idml`). */
  native: boolean;
  /** What an IDML export writes for it: itself, or the nearest native. */
  idml: string;
  /** The PDF `/BM` name, when PDF has one. */
  pdf?: string;
  /** The CSS `mix-blend-mode` keyword, when CSS has one. */
  css?: string;
  /** The PSD layer-record key. */
  psd: string;
  separable: boolean;
}

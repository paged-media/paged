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

// Anchor classification — the corner test the editor's path-edit
// overlay uses for its smooth/corner double-click toggle: an anchor
// is a corner iff BOTH handles coincide with it (IDML's zero-handle
// convention for sharp corners).

import { dist } from "./types";
import type { AnchorTriple } from "./types";

export function isCornerAnchor(a: AnchorTriple, eps = 1e-3): boolean {
  return dist(a.left, a.anchor) < eps && dist(a.right, a.anchor) < eps;
}

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

// The REFERENCE MODEL of how the engine applies the path-point ops —
// promoted into `src/apply-path-ops.ts` when `DirectSelectMachine.apply`
// needed it, and re-exported here so the specs keep their import site.
// There is ONE applier; the rules and their provenance are documented
// there. What stays here is test-only.

import {
  applyPathOps,
  modelOf,
  type ModelTable,
} from "../../src/apply-path-ops";

import type { AnchorTriple } from "@paged-media/draw-geometry";

export { applyPathOps, modelOf, type ModelTable };

/** The anchors of contour `index`, as the model holds them. */
export function contourOf(table: ModelTable, index: number): AnchorTriple[] {
  const starts = table.subpathStarts.length > 0 ? table.subpathStarts : [0];
  return table.anchors.slice(
    starts[index],
    starts[index + 1] ?? table.anchors.length,
  );
}

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

// The editor profile (docs/composable-editor.md §5): types, resolution,
// region edits and the shape check.

export * from "./types";
export { resolveProfile, baseProfile } from "./resolve";
export {
  applyRegionEdit,
  excludedBy,
  globMatches,
  itemId,
  matchIndices,
} from "./adjust";
export { validateProfile } from "./validate";
export { BUNDLES_ENTRY, filterByRegion } from "./region-filter";

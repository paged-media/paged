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

// What a region keeps of the entries a registry offers it. A region that
// keeps everything drops only what it excludes; a list keeps what it names,
// in its order, and the reserved entry `@bundles` keeps whatever the
// activated plugin bundles contribute to that region, where it stands. A
// solo preset lists its host menus and tools and then `@bundles`, so its
// plugin's own menu and tools stay; a template preset leaves it out.

import { excludedBy, globMatches } from "./adjust";
import type { ResolvedRegion } from "./types";

/** The list entry that stands for every bundle contribution. */
export const BUNDLES_ENTRY = "@bundles";

export function filterByRegion<T>(
  region: ResolvedRegion | null,
  entries: readonly T[],
  idOf: (entry: T) => string,
  fromBundle: (entry: T) => boolean,
): T[] {
  if (region === null) return [];
  if (region.kind === "all") {
    return entries.filter((e) => !excludedBy(region.exclude, idOf(e)));
  }
  const taken = new Set<number>();
  const out: T[] = [];
  const take = (pred: (e: T) => boolean) => {
    entries.forEach((e, i) => {
      if (!taken.has(i) && pred(e)) {
        taken.add(i);
        out.push(e);
      }
    });
  };
  for (const item of region.items) {
    if (typeof item !== "string") continue;
    if (item === BUNDLES_ENTRY) take(fromBundle);
    else take((e) => globMatches(item, idOf(e)));
  }
  return out;
}

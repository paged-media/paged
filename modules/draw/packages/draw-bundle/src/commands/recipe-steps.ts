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

// THE STEPS A RECIPE'S OWN COMMAND REBUILT IT IN. A recipe command that
// writes its own SOURCES while it rebuilds (Objects on a Path's Update
// moves the very objects the recipe is made from) commits a change the
// automatic update (`recipe-auto-update.ts`) would read as an edit of
// those sources, and it rebuilt the recipe once more, inside the same
// undo step — the same placements written twice. The command notes the
// step here; the automatic update takes that recipe's new fingerprint
// from the step and rebuilds only the OTHER recipes the step touched.
//
// Keyed by the step's `appliedSeq`; an entry is consumed by the change
// that carries its number, and every entry at or below a handled number
// is dropped (a step can never be reported again). No imports, so every
// command can note a step without a cycle through the update.

/** `appliedSeq` → the recipes (`kind/id`) their own command rebuilt in it. */
const rebuiltInStep = new Map<number, Set<string>>();

/** A recipe's own command rebuilt it in the undo step `appliedSeq` names. */
export function noteRecipeRebuilt(
  kind: string,
  id: string,
  appliedSeq: number | undefined,
): void {
  if (typeof appliedSeq !== "number") return;
  let keys = rebuiltInStep.get(appliedSeq);
  if (!keys) rebuiltInStep.set(appliedSeq, (keys = new Set()));
  keys.add(`${kind}/${id}`);
}

/** The recipes noted for `appliedSeq` (consumed), and every older note
 *  dropped. */
export function takeRecipesRebuiltIn(appliedSeq: number): Set<string> {
  const out = rebuiltInStep.get(appliedSeq) ?? new Set<string>();
  for (const seq of [...rebuiltInStep.keys()])
    if (seq <= appliedSeq) rebuiltInStep.delete(seq);
  return out;
}

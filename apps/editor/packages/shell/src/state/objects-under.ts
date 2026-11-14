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

// The objects under a point, topmost first, by the click's group rule (the
// interaction specification's `UXI-HIT-006`; editor ADR 235, amended by
// IC6): the object picker and the cycle command offer them. The default
// click keeps the topmost; only the user's explicit choice reaches the ones
// beneath.

import type { CanvasClient, ElementId, PageId } from "@paged-media/client";

/** The items under `point` (page-local pt on `pageId`), topmost first: the
 *  top-level items, or the members of the entered group. */
export async function objectsUnder(
  client: Pick<CanvasClient, "marqueeHits">,
  pageId: PageId,
  point: readonly [number, number],
  activeGroup: string | null,
): Promise<ElementId[]> {
  const r = 0.5;
  const [x, y] = point;
  return objectsOver(client, pageId, [y - r, x - r, y + r, x + r], activeGroup);
}

/** The items that overlap `box` (page-local `[top, left, bottom, right]`),
 *  topmost first, by the same rule: the stack the keyboard cycles through
 *  when no pointer says where (editor ADR "An accessible object tree",
 *  `UXI-A11Y-008`). */
export async function objectsOver(
  client: Pick<CanvasClient, "marqueeHits">,
  pageId: PageId,
  box: readonly [number, number, number, number],
  activeGroup: string | null,
): Promise<ElementId[]> {
  return client.marqueeHits(
    pageId,
    [...box] as [number, number, number, number],
    {
      mode: "intersect",
      scope: activeGroup
        ? { kind: "group", id: activeGroup }
        : { kind: "document" },
    },
  );
}

/** The item below `current` in `stack`, wrapping to the top; the topmost
 *  when `current` is not in it. */
export function nextBelow(
  stack: readonly ElementId[],
  current: readonly ElementId[],
): ElementId | null {
  if (stack.length === 0) return null;
  const key = (id: ElementId) =>
    `${id.kind}:${String((id as { id?: unknown }).id)}`;
  const selected = new Set(current.map(key));
  let at = -1;
  stack.forEach((id, i) => {
    if (selected.has(key(id))) at = i;
  });
  return stack[(at + 1) % stack.length] ?? null;
}

/** The item above `current` in `stack`, wrapping to the bottom; the
 *  bottommost when `current` is not in it (`nextBelow`'s mirror). */
export function nextAbove(
  stack: readonly ElementId[],
  current: readonly ElementId[],
): ElementId | null {
  if (stack.length === 0) return null;
  const key = (id: ElementId) =>
    `${id.kind}:${String((id as { id?: unknown }).id)}`;
  const selected = new Set(current.map(key));
  const at = stack.findIndex((id) => selected.has(key(id)));
  if (at < 0) return stack[stack.length - 1] ?? null;
  return stack[(at - 1 + stack.length) % stack.length] ?? null;
}

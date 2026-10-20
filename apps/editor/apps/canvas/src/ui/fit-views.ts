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

// What the fit and page commands look at (UX audit F-31 and F-16, editor
// ADR 257). Pure: rects in document space, a camera and a viewport in, a
// rect to fit out. The commands in `main.tsx` animate the camera to it.
//
//   Fit page       (Cmd+0)        the page at the viewport's centre
//   Fit spread     (Alt+Cmd+0)    every page of that page's spread
//   Fit selection  (Alt+Cmd+=)    the selection's box
//   Fit document   (Alt+Shift+Cmd+0)  every page
//   First / Previous / Next / Last page (Home, PageUp, PageDown, End)
//
// InDesign's chords, its View menu's names.

import type { Camera } from "@paged-media/client";
import type { PageRect } from "./layout";

/** The index of the page whose centre is nearest the viewport's centre:
 *  the "current" page of every relative command. -1 with no pages. */
export function pageAtViewportCentre(
  rects: ReadonlyArray<PageRect>,
  camera: Camera,
  viewport: readonly [number, number],
): number {
  if (rects.length === 0) return -1;
  const docX = (viewport[0] / 2 - camera.tx) / camera.scale;
  const docY = (viewport[1] / 2 - camera.ty) / camera.scale;
  let best = 0;
  let bestDistSq = Number.POSITIVE_INFINITY;
  rects.forEach((r, i) => {
    const dsq = (r.x + r.w / 2 - docX) ** 2 + (r.y + r.h / 2 - docY) ** 2;
    if (dsq < bestDistSq) {
      bestDistSq = dsq;
      best = i;
    }
  });
  return best;
}

/** The box around `rects`, or null for none. */
function union(rects: ReadonlyArray<PageRect>): PageRect | null {
  if (rects.length === 0) return null;
  const left = Math.min(...rects.map((r) => r.x));
  const top = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.w));
  const bottom = Math.max(...rects.map((r) => r.y + r.h));
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/** The pages of the spread page `index` belongs to, boxed. `spreadIds`
 *  is parallel to `rects` (a page's `spreadId`); a page whose spread is
 *  unknown is a spread of its own. */
export function spreadRect(
  rects: ReadonlyArray<PageRect>,
  spreadIds: ReadonlyArray<string | null | undefined>,
  index: number,
): PageRect | null {
  const page = rects[index];
  if (!page) return null;
  const spread = spreadIds[index];
  if (!spread) return page;
  return union(rects.filter((_, i) => spreadIds[i] === spread));
}

/** One selected item as `elementGeometry` reports it: page-local
 *  `[top, left, bottom, right]` through its item transform. */
export interface PlacedBox {
  pageId: string | null | undefined;
  bounds: readonly number[];
  itemTransform?: readonly number[] | null;
}

/** The selection's box in document space: each item's page box moved by
 *  its page's place in the layout. Items with no page (the pasteboard)
 *  are left out; null when nothing is left. */
export function selectionRect(
  rects: ReadonlyArray<PageRect>,
  pageIds: ReadonlyArray<string>,
  items: ReadonlyArray<PlacedBox>,
): PageRect | null {
  const boxes: PageRect[] = [];
  for (const item of items) {
    const page = item.pageId ? rects[pageIds.indexOf(item.pageId)] : undefined;
    if (!page || item.bounds.length < 4) continue;
    const [top, left, bottom, right] = item.bounds as [
      number,
      number,
      number,
      number,
    ];
    const [a, b, c, d, tx, ty] = item.itemTransform ?? [1, 0, 0, 1, 0, 0];
    const xs: number[] = [];
    const ys: number[] = [];
    for (const [x, y] of [
      [left, top],
      [right, top],
      [right, bottom],
      [left, bottom],
    ] as const) {
      xs.push(a! * x + c! * y + tx!);
      ys.push(b! * x + d! * y + ty!);
    }
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    boxes.push({
      x: page.x + minX,
      y: page.y + minY,
      w: Math.max(...xs) - minX,
      h: Math.max(...ys) - minY,
    });
  }
  return union(boxes);
}

/** Where a page key goes from page `current` of `count`: null when it
 *  stays (already there, or no pages). */
export function pageStep(
  key: "first" | "previous" | "next" | "last",
  current: number,
  count: number,
): number | null {
  if (count === 0) return null;
  const at = Math.max(0, current);
  const target =
    key === "first"
      ? 0
      : key === "last"
        ? count - 1
        : key === "previous"
          ? Math.max(0, at - 1)
          : Math.min(count - 1, at + 1);
  return target === current ? null : target;
}

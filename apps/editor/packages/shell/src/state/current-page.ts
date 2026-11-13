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

// The one current page (interaction contract UXI-CAM-015; editor ADR
// "Navigation history and one current page"). Every reader of "the page
// the user is on" asks here: the control bar's page readout and its
// arrows, the fit commands and the page keys, the insert verbs and the
// object verbs that act on "this page", the page a plugin reads as
// `activePage`, and the Navigator. Before, four places computed it four
// ways (nearest centre, containing-then-nearest, nearest edge), two of
// them ignoring a turned view, so the readout could name one page while
// Fit page fitted another.
//
// The rule, in order:
//   1. No pages: -1.
//   2. An unmeasured camera or viewport (scale not above zero, a
//      viewport of no size): page 0, the page a document opens on.
//   3. The point judged is the viewport's centre, mapped through the
//      camera into document points, the view's rotation included.
//   4. The page whose rectangle contains that point (edges included).
//      When several do (two pages touching at a spine, artboards that
//      overlap), the first in document order.
//   5. Else the page nearest to it (distance to the rectangle's edge,
//      not to its centre: a tall page beside a short one is judged by
//      where its paper is). On equal distances, the first in document
//      order.
//
// Pure and React-free, so a command, a test or a worker-side helper can
// call it with the camera it has (a tween's destination, say).

import { viewportToDoc, type Camera } from "@paged-media/client";

/** A page's rectangle in document points (the canvas layout's). */
export interface PageBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The document point the current page is judged by: the viewport's
 *  centre through the camera, rotation included. Null for an unmeasured
 *  camera or viewport. */
export function viewportCentreInDocument(
  camera: Camera,
  viewport: readonly [number, number],
): [number, number] | null {
  const [vw, vh] = viewport;
  if (!(camera.scale > 0) || !(vw > 0) || !(vh > 0)) return null;
  const [x, y] = viewportToDoc(camera, vw / 2, vh / 2);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return [x, y];
}

/** The page judged current at document point (`x`, `y`): rules 4 and 5. */
export function pageAtDocumentPoint(
  rects: ReadonlyArray<PageBox>,
  x: number,
  y: number,
): number {
  let nearest = -1;
  let nearestD = Infinity;
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i]!;
    const dx = Math.max(r.x - x, 0, x - (r.x + r.w));
    const dy = Math.max(r.y - y, 0, y - (r.y + r.h));
    const d = dx * dx + dy * dy;
    if (d === 0) return i;
    // Strictly nearer: on a tie the earlier page keeps it.
    if (d < nearestD) {
      nearestD = d;
      nearest = i;
    }
  }
  return nearest;
}

/** The index of the current page (the rule above), -1 with no pages. */
export function currentPageIndex(
  rects: ReadonlyArray<PageBox>,
  camera: Camera,
  viewport: readonly [number, number],
): number {
  if (rects.length === 0) return -1;
  const at = viewportCentreInDocument(camera, viewport);
  if (!at) return 0;
  return pageAtDocumentPoint(rects, at[0], at[1]);
}

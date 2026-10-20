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

// What the fit commands and the page keys look at (UX audit F-31, F-16;
// ADR 257): the page at the viewport's centre, its spread, the
// selection's box in document space, and where a page key goes.

import { describe, expect, test } from "bun:test";

import { covers } from "@paged-media/test-kit";
import { zoomCameraTo, ZOOM_MAX_SCALE } from "@paged-media/shell";

import {
  pageAtViewportCentre,
  pageStep,
  selectionRect,
  spreadRect,
} from "../../src/ui/fit-views";
import { layoutPages } from "../../src/ui/layout";

// Four Letter pages stacked with the layout's 24 pt gap.
const rects = layoutPages([
  [612, 792],
  [612, 792],
  [612, 792],
  [612, 792],
]);

describe("the fit views", () => {
  test("the current page is the one at the viewport's centre", () => {
    covers("command:paged.view.fitPage");
    // Camera at 1: the viewport's centre (500, 400) is on page 1.
    expect(
      pageAtViewportCentre(rects, { scale: 1, tx: 0, ty: 0 }, [1000, 800]),
    ).toBe(0);
    // Scrolled down by two pages and a bit: page 3.
    const ty = -(2 * (792 + 24));
    expect(
      pageAtViewportCentre(rects, { scale: 1, tx: 0, ty }, [1000, 800]),
    ).toBe(2);
    expect(
      pageAtViewportCentre([], { scale: 1, tx: 0, ty: 0 }, [1000, 800]),
    ).toBe(-1);
  });

  test("Fit spread boxes every page of the current page's spread", () => {
    covers("command:paged.view.fitSpread");
    const spreads = ["s1", "s2", "s2", "s3"];
    expect(spreadRect(rects, spreads, 1)).toEqual({
      x: 0,
      y: rects[1]!.y,
      w: 612,
      h: rects[2]!.y + 792 - rects[1]!.y,
    });
    // A single-page spread, or one the worker did not name, is the page.
    expect(spreadRect(rects, spreads, 0)).toEqual(rects[0]!);
    expect(spreadRect(rects, [null, null, null, null], 2)).toEqual(rects[2]!);
  });

  test("Fit selection boxes the items where their pages are", () => {
    covers("command:paged.view.fitSelection");
    const pageIds = ["p1", "p2", "p3", "p4"];
    const box = selectionRect(rects, pageIds, [
      // [top, left, bottom, right] on page 2, moved by its transform.
      {
        pageId: "p2",
        bounds: [0, 0, 100, 50],
        itemTransform: [1, 0, 0, 1, 72, 36],
      },
      { pageId: "p2", bounds: [200, 300, 250, 400], itemTransform: null },
      // A pasteboard item has no page and is left out.
      { pageId: null, bounds: [0, 0, 10, 10] },
    ]);
    expect(box).toEqual({
      x: 72,
      y: rects[1]!.y + 36,
      w: 400 - 72,
      h: 250 - 36,
    });
    expect(selectionRect(rects, pageIds, [])).toBeNull();
  });

  test("the page keys step from the current page and stop at the ends", () => {
    covers(
      "command:paged.view.firstPage",
      "command:paged.view.previousPage",
      "command:paged.view.nextPage",
      "command:paged.view.lastPage",
    );
    expect(pageStep("next", 1, 4)).toBe(2);
    expect(pageStep("previous", 1, 4)).toBe(0);
    expect(pageStep("first", 2, 4)).toBe(0);
    expect(pageStep("last", 0, 4)).toBe(3);
    // Already there: nothing to do.
    expect(pageStep("next", 3, 4)).toBeNull();
    expect(pageStep("first", 0, 4)).toBeNull();
    expect(pageStep("next", 0, 0)).toBeNull();
  });

  test("a zoom preset keeps the point at the viewport's centre, inside the range", () => {
    const cam = { scale: 1, tx: -100, ty: -50 };
    const next = zoomCameraTo(cam, 2, [800, 600]);
    // The document point under the centre (500, 350) stays under it.
    expect((400 - next.tx) / next.scale).toBeCloseTo(500);
    expect((300 - next.ty) / next.scale).toBeCloseTo(350);
    expect(zoomCameraTo(cam, 1000, [800, 600]).scale).toBe(ZOOM_MAX_SCALE);
  });
});

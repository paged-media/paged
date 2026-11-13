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

// Semantic zoom (UXI-CAM-017; editor ADR "Page lenses and semantic zoom"):
// the tiers, and the overlay rule that hides the handles in an overview
// and nothing else.

import { describe, expect, test } from "bun:test";

import { covers } from "@paged-media/test-kit";

import {
  DETAIL_MIN_SCALE,
  OVERVIEW_MAX_SCALE,
  zoomTier,
} from "../../src/state/semantic-zoom";
import { overlayShown } from "../../src/state/editing-aids";
import {
  CAPTION_ROOM_PX,
  captionPlace,
} from "../../src/overlays/page-decorations";
import { layoutPageRects } from "../../src/cockpit/canvas-frame/page-layout";

const allOn = () => true;

describe("semantic zoom", () => {
  test("three tiers by the camera's scale", () => {
    covers("setting:view.frameEdges");
    expect(zoomTier(0.05)).toBe("overview");
    expect(zoomTier(OVERVIEW_MAX_SCALE - 1e-6)).toBe("overview");
    expect(zoomTier(OVERVIEW_MAX_SCALE)).toBe("page");
    expect(zoomTier(1)).toBe("page");
    expect(zoomTier(DETAIL_MIN_SCALE)).toBe("detail");
    expect(zoomTier(40)).toBe("detail");
    // An unmeasured camera is a page view.
    expect(zoomTier(0)).toBe("page");
    expect(zoomTier(Number.NaN)).toBe("page");
  });

  test("an overview hides the handles, keeps the outline, the markers and the page names", () => {
    for (const id of [
      "paged.resize-handles",
      "paged.rotate-handle",
      "paged.threading-ports",
      "paged.live-shape-handles",
      "paged.content-grabber",
      "paged.path-edit",
    ]) {
      expect({ id, at: overlayShown(id, allOn, "normal", 0.08) }).toEqual({
        id,
        at: false,
      });
      expect(overlayShown(id, allOn, "normal", 1)).toBe(true);
      expect(overlayShown(id, allOn, "normal", 8)).toBe(true);
    }
    for (const id of [
      "paged.selection-chrome",
      "paged.overlay.oversetMarkers",
      "paged.page-decorations",
      "paged.marquee",
      "paged.caret",
    ])
      expect(overlayShown(id, allOn, "normal", 0.08)).toBe(true);
    // No scale given: no tier applies.
    expect(overlayShown("paged.resize-handles", allOn, "normal")).toBe(true);
  });
});

describe("page names (F-57)", () => {
  test("under the page while the gap below has room on screen, else beside it", () => {
    // Stacked Letter pages, 24 pt apart: room at 100 %, none at 10 %.
    const stack = layoutPageRects([
      [612, 792],
      [612, 792],
    ]);
    expect(captionPlace(stack, 0, 1)).toBe("below");
    expect(captionPlace(stack, 0, 0.1)).toBe("side");
    expect(24 * 0.1).toBeLessThan(CAPTION_ROOM_PX);
    // The last page has the pasteboard below it at any zoom.
    expect(captionPlace(stack, 1, 0.05)).toBe("below");
    // Pages side by side: nothing below either.
    const row = [
      { x: 0, y: 0, w: 612, h: 792 },
      { x: 700, y: 0, w: 612, h: 792 },
    ];
    expect(captionPlace(row, 0, 0.05)).toBe("below");
  });
});

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

import { describe, expect, it } from "bun:test";

import {
  clampScroll,
  contentBounds,
  contentExtent,
  currentPageAt,
  fitPage,
  scrollToPage,
  zoomAt,
  FIT_MARGIN,
  type Camera,
} from "../src/camera.js";
import { letterLayout } from "./fake-session.js";

const VIEWPORT = { width: 800, height: 600 };
const LIMITS = { min: 0.1, max: 8 };

describe("zoomAt", () => {
  it("keeps the doc point under the anchor fixed (invariance)", () => {
    const camera: Camera = { zoom: 1, x: 40, y: -120 };
    const anchor = { x: 333, y: 222 };
    const before = {
      x: (anchor.x - camera.x) / camera.zoom,
      y: (anchor.y - camera.y) / camera.zoom,
    };
    const next = zoomAt(camera, 2.5, LIMITS, VIEWPORT, anchor);
    expect(anchor.x - (camera.x + 0)).not.toBe(0); // anchor off-origin
    expect(before.x * next.zoom + next.x).toBeCloseTo(anchor.x, 6);
    expect(before.y * next.zoom + next.y).toBeCloseTo(anchor.y, 6);
  });

  it("defaults the anchor to the viewport centre", () => {
    const camera: Camera = { zoom: 1, x: 0, y: 0 };
    const next = zoomAt(camera, 2, LIMITS, VIEWPORT);
    const centre = { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 };
    const doc = { x: centre.x / 1, y: centre.y / 1 };
    expect(doc.x * next.zoom + next.x).toBeCloseTo(centre.x, 6);
    expect(doc.y * next.zoom + next.y).toBeCloseTo(centre.y, 6);
  });

  it("clamps to the zoom limits", () => {
    const camera: Camera = { zoom: 1, x: 0, y: 0 };
    expect(zoomAt(camera, 100, LIMITS, VIEWPORT).zoom).toBe(LIMITS.max);
    expect(zoomAt(camera, 0.0001, LIMITS, VIEWPORT).zoom).toBe(LIMITS.min);
  });
});

describe("fitPage", () => {
  it('"page" fits both dimensions with the margin', () => {
    const layout = letterLayout(1);
    const cam = fitPage(layout, 0, "page", VIEWPORT, LIMITS);
    const expected =
      Math.min(VIEWPORT.width / 612, VIEWPORT.height / 792) * FIT_MARGIN;
    expect(cam.zoom).toBeCloseTo(expected, 6);
    // Page is horizontally and vertically centred.
    expect(cam.x).toBeCloseTo((VIEWPORT.width - 612 * cam.zoom) / 2, 6);
    expect(cam.y).toBeCloseTo((VIEWPORT.height - 792 * cam.zoom) / 2, 6);
  });

  it('"width" fits the page width', () => {
    const layout = letterLayout(1);
    const cam = fitPage(layout, 0, "width", VIEWPORT, LIMITS);
    expect(cam.zoom).toBeCloseTo((VIEWPORT.width / 612) * FIT_MARGIN, 6);
    expect(cam.x).toBeCloseTo((VIEWPORT.width - 612 * cam.zoom) / 2, 6);
  });

  it("targets the page's continuous offset", () => {
    const layout = letterLayout(3);
    const cam = fitPage(layout, 2, "page", VIEWPORT, LIMITS);
    const page = layout.pages[2]!;
    // The page's centre lands on the viewport centre.
    const pageCentreDocY = page.yPt + page.heightPt / 2;
    expect(pageCentreDocY * cam.zoom + cam.y).toBeCloseTo(
      VIEWPORT.height / 2,
      4,
    );
  });
});

describe("clampScroll", () => {
  const layout = letterLayout(3);

  it("centres content smaller than the viewport", () => {
    const cam = clampScroll({ zoom: 0.5, x: -999, y: 50 }, layout, VIEWPORT);
    // 612 * 0.5 = 306 < 800 → centred horizontally.
    expect(cam.x).toBeCloseTo((800 - 306) / 2, 6);
  });

  it("clamps content larger than the viewport to the edges", () => {
    const { height } = contentExtent(layout);
    const big = { zoom: 2, x: 500, y: 500 };
    const cam = clampScroll(big, layout, VIEWPORT);
    expect(cam.x).toBe(0); // can't open a gap on the left
    expect(cam.y).toBe(0); // …or at the top
    const low = clampScroll(
      { zoom: 2, x: -99999, y: -99999 },
      layout,
      VIEWPORT,
    );
    expect(low.x).toBe(VIEWPORT.width - 612 * 2);
    expect(low.y).toBe(VIEWPORT.height - height * 2);
  });
});

describe("currentPageAt", () => {
  const layout = letterLayout(3);

  it("derives the page under the viewport centre", () => {
    const zoom = 0.5;
    // Page 1 spans yPt 816..1608; put its middle on the centre line.
    const target = 816 + 396;
    const camY = VIEWPORT.height / 2 - target * zoom;
    expect(currentPageAt({ zoom, x: 0, y: camY }, layout, VIEWPORT)).toBe(1);
  });

  it("falls back to the nearest band inside a gap", () => {
    const zoom = 1;
    const gapMiddle = 792 + 12; // inside the 24pt gap after page 0
    const camY = VIEWPORT.height / 2 - gapMiddle * zoom;
    const page = currentPageAt({ zoom, x: 0, y: camY }, layout, VIEWPORT);
    expect([0, 1]).toContain(page);
  });
});

describe("scrollToPage", () => {
  it("brings the page top into view and centres horizontally", () => {
    const layout = letterLayout(3);
    const cam = scrollToPage({ zoom: 1, x: 0, y: 0 }, layout, 2, VIEWPORT);
    const page = layout.pages[2]!;
    // Page top sits just below the viewport top (≤ gap of breathing room).
    const topCss = page.yPt * cam.zoom + cam.y;
    expect(topCss).toBeGreaterThanOrEqual(0);
    expect(topCss).toBeLessThanOrEqual(24);
    expect(cam.x).toBeCloseTo((VIEWPORT.width - 612 * cam.zoom) / 2, 6);
  });
});

describe("pages with an x origin", () => {
  // A spread whose left page sits left of the doc origin.
  const spread = {
    gapPt: 24,
    pages: [
      { index: 0, xPt: -612, yPt: 0, widthPt: 612, heightPt: 792 },
      { index: 1, xPt: 0, yPt: 0, widthPt: 612, heightPt: 792 },
    ],
  };

  it("contentBounds spans both pages of a spread", () => {
    expect(contentBounds(spread)).toEqual({
      x: -612,
      y: 0,
      width: 1224,
      height: 792,
    });
    expect(contentExtent(spread)).toEqual({ width: 1224, height: 792 });
    expect(contentBounds({ gapPt: 0, pages: [] })).toEqual({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    });
  });

  it("fitPage centres the page where it lies", () => {
    for (const index of [0, 1]) {
      const cam = fitPage(spread, index, "page", VIEWPORT, LIMITS);
      const page = spread.pages[index]!;
      const centre = cam.x + (page.xPt + page.widthPt / 2) * cam.zoom;
      expect(centre).toBeCloseTo(VIEWPORT.width / 2, 6);
    }
  });

  it("clampScroll centres a spread narrower than the viewport", () => {
    const cam = clampScroll({ zoom: 0.5, x: 0, y: 0 }, spread, VIEWPORT);
    // 1224 * 0.5 = 612 wide: its left edge (doc x -612) sits at 94.
    expect(cam.x + -612 * 0.5).toBeCloseTo((800 - 612) / 2, 6);
  });

  it("clampScroll lets a wide spread scroll to both edges", () => {
    const left = clampScroll({ zoom: 2, x: 99999, y: 0 }, spread, VIEWPORT);
    expect(left.x + -612 * 2).toBe(0);
    const right = clampScroll({ zoom: 2, x: -99999, y: 0 }, spread, VIEWPORT);
    expect(right.x + 612 * 2).toBe(VIEWPORT.width);
  });

  it("currentPageAt tells the pages of a spread apart", () => {
    const zoom = 1;
    const y = VIEWPORT.height / 2 - 396;
    const over = (docX: number): Camera => ({
      zoom,
      x: VIEWPORT.width / 2 - docX * zoom,
      y,
    });
    expect(currentPageAt(over(-300), spread, VIEWPORT)).toBe(0);
    expect(currentPageAt(over(300), spread, VIEWPORT)).toBe(1);
  });

  it("scrollToPage centres the page horizontally where it lies", () => {
    const cam = scrollToPage({ zoom: 1, x: 0, y: 0 }, spread, 0, VIEWPORT);
    expect(cam.x + (-612 + 306)).toBeCloseTo(VIEWPORT.width / 2, 6);
  });
});

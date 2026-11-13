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

// The one current page (UXI-CAM-015; editor ADR "Navigation history and
// one current page"): the rule every reader shares, its tie-breaking and
// the turned view.

import { describe, expect, test } from "bun:test";

import { covers } from "@paged-media/test-kit";

import {
  currentPageIndex,
  pageAtDocumentPoint,
  viewportCentreInDocument,
} from "../../src/state/current-page";
import { layoutPageRects } from "../../src/cockpit/canvas-frame/page-layout";

// Four Letter pages in the default stack (24 pt gaps).
const stack = layoutPageRects([
  [612, 792],
  [612, 792],
  [612, 792],
  [612, 792],
]);
const VIEW: [number, number] = [1000, 800];

/** The camera that puts document point (`x`, `y`) at the viewport's centre. */
const centredOn = (x: number, y: number, scale = 1, rotation = 0) => {
  const c = Math.cos(rotation);
  const s = Math.sin(rotation);
  return {
    scale,
    rotation,
    tx: VIEW[0] / 2 - scale * (c * x - s * y),
    ty: VIEW[1] / 2 - scale * (s * x + c * y),
  };
};

describe("the current page", () => {
  test("is the page containing the viewport's centre", () => {
    covers("command:paged.view.fitPage", "command:paged.view.nextPage");
    expect(currentPageIndex(stack, centredOn(306, 396), VIEW)).toBe(0);
    expect(currentPageIndex(stack, centredOn(306, 816 + 396), VIEW)).toBe(1);
    expect(currentPageIndex(stack, centredOn(10, 3 * 816 + 5), VIEW)).toBe(3);
  });

  test("off the pages, it is the nearest page by distance to its paper", () => {
    // In the gap under page 1: 4 pt from it, 20 from page 2.
    expect(currentPageIndex(stack, centredOn(306, 796), VIEW)).toBe(0);
    // 4 pt above page 2.
    expect(currentPageIndex(stack, centredOn(306, 812), VIEW)).toBe(1);
    // Far left on the pasteboard, level with page 3.
    expect(currentPageIndex(stack, centredOn(-2000, 2 * 816 + 300), VIEW)).toBe(
      2,
    );
  });

  test("ties go to the first page in document order", () => {
    // The middle of the gap: 12 pt from page 1 and from page 2.
    expect(currentPageIndex(stack, centredOn(306, 804), VIEW)).toBe(0);
    // Two pages side by side touching at the spine: the spine is on both.
    const spread = [
      { x: 0, y: 0, w: 612, h: 792 },
      { x: 612, y: 0, w: 612, h: 792 },
    ];
    expect(pageAtDocumentPoint(spread, 612, 400)).toBe(0);
    expect(pageAtDocumentPoint(spread, 612.01, 400)).toBe(1);
    // Overlapping artboards: the first that contains the point.
    const overlap = [
      { x: 0, y: 0, w: 500, h: 500 },
      { x: 100, y: 100, w: 500, h: 500 },
    ];
    expect(pageAtDocumentPoint(overlap, 200, 200)).toBe(0);
  });

  test("follows a turned view (Rotate View)", () => {
    // Pages side by side; the view turned a quarter. The centre on page 2
    // stays page 2 whatever the rotation: the inverse camera includes it.
    const row = [
      { x: 0, y: 0, w: 612, h: 792 },
      { x: 700, y: 0, w: 612, h: 792 },
    ];
    for (const r of [0, Math.PI / 2, Math.PI / 6, -Math.PI / 3]) {
      expect(currentPageIndex(row, centredOn(1000, 400, 0.5, r), VIEW)).toBe(1);
      expect(currentPageIndex(row, centredOn(300, 400, 0.5, r), VIEW)).toBe(0);
    }
    // A naive inverse (ignoring the turn) would read another point.
    const turned = centredOn(1000, 400, 0.5, Math.PI / 2);
    const naive = [
      (VIEW[0] / 2 - turned.tx) / turned.scale,
      (VIEW[1] / 2 - turned.ty) / turned.scale,
    ];
    expect(naive[0]).not.toBeCloseTo(1000, 0);
    expect(viewportCentreInDocument(turned, VIEW)![0]).toBeCloseTo(1000, 6);
  });

  test("without pages it is -1; before the camera is measured, page 0", () => {
    expect(currentPageIndex([], centredOn(0, 0), VIEW)).toBe(-1);
    expect(currentPageIndex(stack, { scale: 0, tx: 0, ty: 0 }, VIEW)).toBe(0);
    expect(currentPageIndex(stack, centredOn(306, 2000), [0, 0])).toBe(0);
  });
});

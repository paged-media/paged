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

// The image ↔ page transform every on-canvas image tool shares. The door's
// `bounds` are the frame's own coordinates; its `itemTransform` takes them
// to the page. On a verso the page starts a page width into its spread, so
// the two differ by that width: a fit read from `bounds` alone put every
// brush dab off the image.

import { describe, expect, it } from "bun:test";

import type { ElementGeometryItem } from "@paged-media/plugin-api";

import { fitInto, imageToPage, pageToImage } from "../src/frame-fit";

const item = (
  bounds: [number, number, number, number],
  itemTransform?: [number, number, number, number, number, number],
): ElementGeometryItem =>
  ({
    id: { kind: "rectangle", id: "u1" },
    pageId: "p1",
    bounds,
    ...(itemTransform ? { itemTransform } : {}),
  }) as unknown as ElementGeometryItem;

describe("fitInto", () => {
  it("maps a frame on a verso through its item transform", () => {
    // A 280 × 187 pt frame 60 pt from the left edge of a left-hand page
    // whose page origin sits 540 pt left of the spread's.
    const fit = fitInto(
      item([158, -480, 345, -200], [1, 0, 0, 1, 540, 0]),
      1600,
      1067,
    )!;
    expect(fit.originX).toBeCloseTo(60, 3);
    const [x] = pageToImage(fit, [200, 250]);
    expect(x).toBeGreaterThan(0);
    expect(x).toBeLessThan(1600);
    const back = imageToPage(fit, pageToImage(fit, [200, 250]));
    expect(back[0]).toBeCloseTo(200, 6);
    expect(back[1]).toBeCloseTo(250, 6);
  });

  it("reads page-local bounds as they are without a transform", () => {
    const fit = fitInto(item([158, 60, 345, 340]), 1600, 1067)!;
    expect(fit.originX).toBeCloseTo(60, 3);
    expect(fit.scale).toBeCloseTo(0.175, 3);
  });

  it("a scaled transform scales the box the image fits into", () => {
    const fit = fitInto(
      item([0, 0, 100, 100], [2, 0, 0, 2, 10, 20]),
      100,
      100,
    )!;
    expect(fit.originX).toBeCloseTo(10, 6);
    expect(fit.originY).toBeCloseTo(20, 6);
    expect(fit.scale).toBeCloseTo(2, 6);
  });
});

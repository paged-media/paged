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

// The precision magnifier's arithmetic (paged.draw ADR 370): the region it
// shows, where it sits, where a point lands in it.

import { describe, expect, test } from "bun:test";

import {
  MAGNIFIER_FACTOR,
  MAGNIFIER_KEY,
  MAGNIFIER_SIZE_PX,
  PRECISION_TOOL_IDS,
  magnifierPlacement,
  magnifierRegion,
  pointInLoupe,
} from "../../src/overlays/precision-magnifier-geometry";

describe("the precision magnifier's geometry", () => {
  test("the region is centred on the point and four times finer than the view", () => {
    // At 100 % (1 CSS px per pt) a 148 px loupe at 4× shows 37 pt.
    const r = magnifierRegion([200, 100], 1);
    expect(r.width).toBeCloseTo(MAGNIFIER_SIZE_PX / MAGNIFIER_FACTOR, 9);
    expect(r.x + r.width / 2).toBeCloseTo(200, 9);
    expect(r.y + r.height / 2).toBeCloseTo(100, 9);
    // Zoomed in twice, the loupe shows half as much page.
    expect(magnifierRegion([200, 100], 2).width).toBeCloseTo(r.width / 2, 9);
  });

  test("the loupe sits above and right of the pointer, flips near an edge, stays inside", () => {
    const host = { width: 800, height: 600 };
    expect(magnifierPlacement([300, 300], host)).toEqual({
      left: 300 + 28,
      top: 300 - 28 - MAGNIFIER_SIZE_PX,
    });
    // Near the right edge: to the left of the pointer.
    expect(magnifierPlacement([780, 300], host).left).toBe(
      780 - 28 - MAGNIFIER_SIZE_PX,
    );
    // Near the top: below the pointer.
    expect(magnifierPlacement([300, 40], host).top).toBe(40 + 28);
    // A host smaller than the loupe: pinned at its corner.
    expect(magnifierPlacement([10, 10], { width: 100, height: 100 })).toEqual({
      left: 0,
      top: 0,
    });
  });

  test("the pointer's point lands at the loupe's centre; the region's corners at its corners", () => {
    const r = magnifierRegion([50, 60], 1.5);
    const c = pointInLoupe([50, 60], r);
    expect(c[0]).toBeCloseTo(MAGNIFIER_SIZE_PX / 2, 9);
    expect(c[1]).toBeCloseTo(MAGNIFIER_SIZE_PX / 2, 9);
    expect(pointInLoupe([r.x, r.y], r)).toEqual([0, 0]);
    const far = pointInLoupe([r.x + r.width, r.y + r.height], r);
    expect(far[0]).toBeCloseTo(MAGNIFIER_SIZE_PX, 9);
    expect(far[1]).toBeCloseTo(MAGNIFIER_SIZE_PX, 9);
  });

  test("Control, and only the tools that place or drag anchors", () => {
    expect(MAGNIFIER_KEY).toBe("Control");
    expect(PRECISION_TOOL_IDS.has("paged.tool.pen")).toBe(true);
    expect(PRECISION_TOOL_IDS.has("paged.tool.directSelect")).toBe(true);
    expect(PRECISION_TOOL_IDS.has("paged.tool.select")).toBe(false);
  });
});

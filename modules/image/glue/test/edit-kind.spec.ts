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

// Image ADR 487 — what an edit changes (the layer kinds and the edit
// target), and the filter dialog's before/after split as pixels.

import { describe, expect, it } from "bun:test";

import { editKindOf, layerBadge } from "../src/edit-kind";
import { composeSplit, splitShapes } from "../src/filter-split";
import { pixelViewRect } from "../src/panels/sections/pixel-view";

describe("what an edit changes (image ADR 487)", () => {
  it("a pixel layer's edits are destructive; adjustment, smart, fill and type layers are not @feat:image.editor.layers", () => {
    expect(layerBadge({ kind: "pixels" }).destructive).toBe(true);
    for (const kind of ["adjustment", "smart", "fill", "type"] as const)
      expect(layerBadge({ kind }).destructive).toBe(false);
    expect(layerBadge({ kind: "smart" }).kind).toBe("smart");
  });

  it("the next edit: the mask when it is the target, else the active layer's kind @feat:image.editor.layers", () => {
    expect(editKindOf({ kind: "pixels" }, "pixels")).toBe("pixels");
    expect(editKindOf({ kind: "pixels" }, "mask")).toBe("mask");
    expect(editKindOf({ kind: "adjustment" }, "pixels")).toBe("adjustment");
    expect(editKindOf({ kind: "smart" }, "pixels")).toBe("adjustment");
    expect(editKindOf(null, "pixels")).toBe("pixels");
  });
});

describe("the before/after split (image ADR 487)", () => {
  const solid = (w: number, h: number, v: number) =>
    new Uint8Array(w * h * 4).fill(v);

  it("before left of the line, after from it on, every row", () => {
    const out = composeSplit(solid(4, 2, 10), solid(4, 2, 200), 4, 2, 0.5);
    const px = (x: number, y: number) => out[(y * 4 + x) * 4];
    expect([px(0, 0), px(1, 0), px(2, 0), px(3, 0)]).toEqual([
      10, 10, 200, 200,
    ]);
    expect([px(0, 1), px(3, 1)]).toEqual([10, 200]);
    // The ends: all after, all before.
    expect(composeSplit(solid(4, 1, 1), solid(4, 1, 2), 4, 1, 0)[0]).toBe(2);
    expect(composeSplit(solid(4, 1, 1), solid(4, 1, 2), 4, 1, 1)[12]).toBe(1);
  });

  it("the line crosses the frame at the split, the halves named beside it", () => {
    const shapes = splitShapes(
      { pageId: "p", originX: 100, originY: 50, scale: 0.5 },
      400,
      200,
      0.25,
      { before: "Before", after: "After" },
    );
    expect(shapes[0]).toEqual({
      pageId: "p",
      points: [
        [150, 50],
        [150, 150],
      ],
    });
    expect(shapes.slice(1).map((s) => s.text)).toEqual(["Before", "After"]);
  });
});

describe("the pixel view (image ADR 487)", () => {
  it("one image pixel to a device pixel at 100 %, clamped inside the image", () => {
    const r = pixelViewRect([500, 400], 1, 2, { width: 1000, height: 800 });
    expect(r.width).toBe(216 * 2);
    expect(r.height).toBe(132 * 2);
    expect(r.x + r.width / 2).toBe(500);
    // At 800 % an eighth as many pixels.
    expect(
      pixelViewRect([500, 400], 8, 2, { width: 1000, height: 800 }).width,
    ).toBe(54);
    // Near the corner: inside the image.
    const c = pixelViewRect([0, 0], 1, 1, { width: 1000, height: 800 });
    expect([c.x, c.y]).toEqual([0, 0]);
    // A small image: all of it.
    expect(pixelViewRect([5, 5], 1, 1, { width: 10, height: 10 })).toEqual({
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    });
  });
});

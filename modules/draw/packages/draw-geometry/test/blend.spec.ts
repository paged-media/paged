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

import { describe, expect, it } from "vitest";

import { interpolateAnchors, mixRgb, type AnchorTriple } from "../src";

const corner = (x: number, y: number): AnchorTriple => ({
  anchor: [x, y],
  left: [x, y],
  right: [x, y],
});

describe("interpolateAnchors", () => {
  it("lerps anchors AND handles componentwise", () => {
    const a: AnchorTriple[] = [
      { anchor: [0, 0], left: [-10, 0], right: [10, 0] },
      corner(100, 0),
    ];
    const b: AnchorTriple[] = [
      { anchor: [0, 100], left: [-20, 100], right: [20, 100] },
      corner(100, 200),
    ];
    const mid = interpolateAnchors(a, b, 0.5);
    expect(mid).toEqual([
      { anchor: [0, 50], left: [-15, 50], right: [15, 50] },
      { anchor: [100, 100], left: [100, 100], right: [100, 100] },
    ]);
  });

  it("t=0 reproduces a, t=1 reproduces b", () => {
    const a = [corner(1, 2), corner(3, 4)];
    const b = [corner(9, 8), corner(7, 6)];
    expect(interpolateAnchors(a, b, 0)).toEqual(a);
    expect(interpolateAnchors(a, b, 1)).toEqual(b);
  });

  it("mismatched anchor counts answer [] (the honest-diagnostic cue)", () => {
    expect(interpolateAnchors([corner(0, 0)], [corner(0, 0), corner(1, 1)], 0.5)).toEqual(
      [],
    );
  });
});

describe("mixRgb", () => {
  it("lerps componentwise, rounded", () => {
    expect(mixRgb([0, 0, 0], [255, 100, 10], 0.5)).toEqual([128, 50, 5]);
  });

  it("clamps t to 0..1", () => {
    expect(mixRgb([10, 10, 10], [20, 20, 20], -1)).toEqual([10, 10, 10]);
    expect(mixRgb([10, 10, 10], [20, 20, 20], 2)).toEqual([20, 20, 20]);
  });
});

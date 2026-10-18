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

import { isCornerAnchor } from "../src/classify";
import { constrainAngle } from "../src/constrain";
import {
  cornerAnchor,
  mirrorHandle,
  smoothAnchorFromDrag,
} from "../src/handles";
import { applyAffine, inverseApplyAffine } from "../src/affine";

describe("handles", () => {
  it("cornerAnchor collapses both handles onto the point", () => {
    const a = cornerAnchor([3, 4]);
    expect(a.left).toEqual([3, 4]);
    expect(a.right).toEqual([3, 4]);
    expect(isCornerAnchor(a)).toBe(true);
  });

  it("smoothAnchorFromDrag mirrors the incoming handle", () => {
    const a = smoothAnchorFromDrag([10, 10], [16, 12]);
    expect(a.right).toEqual([16, 12]);
    expect(a.left).toEqual([4, 8]);
    expect(isCornerAnchor(a)).toBe(false);
  });

  it("mirrorHandle reflects through the anchor", () => {
    expect(mirrorHandle([0, 0], [3, -2])).toEqual([-3, 2]);
  });
});

describe("constrainAngle", () => {
  it("snaps to 45 degrees preserving distance", () => {
    const p = constrainAngle([0, 0], [10, 1]);
    expect(p[1]).toBeCloseTo(0);
    expect(Math.hypot(p[0], p[1])).toBeCloseTo(Math.hypot(10, 1));
  });

  it("snaps a near-diagonal onto the diagonal", () => {
    const p = constrainAngle([0, 0], [10, 9]);
    expect(p[0]).toBeCloseTo(p[1]);
  });

  it("returns the origin-coincident point unchanged", () => {
    expect(constrainAngle([5, 5], [5, 5])).toEqual([5, 5]);
  });
});

describe("affine", () => {
  it("round-trips apply → inverse-apply", () => {
    const m = [0.8, 0.2, -0.3, 1.1, 12, -7] as const;
    const [x, y] = applyAffine(m, 3, 4);
    const inv = inverseApplyAffine(m, x, y);
    expect(inv).not.toBeNull();
    expect(inv![0]).toBeCloseTo(3, 10);
    expect(inv![1]).toBeCloseTo(4, 10);
  });

  it("null matrix is identity", () => {
    expect(applyAffine(null, 3, 4)).toEqual([3, 4]);
    expect(inverseApplyAffine(null, 3, 4)).toEqual([3, 4]);
  });

  it("singular matrix inverse returns null", () => {
    expect(inverseApplyAffine([0, 0, 0, 0, 1, 2] as const, 3, 4)).toBeNull();
  });
});

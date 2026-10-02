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

import {
  IDENTITY_AFFINE,
  affineScale,
  applyAffine,
  composeAffine,
  inverseApplyAffine,
  type Affine,
} from "../src";

// `[a, b, c, d, tx, ty]`: x' = a·x + c·y + tx, y' = b·x + d·y + ty — the
// IDML ItemTransform column pairs.
const TRANSLATE: Affine = [1, 0, 0, 1, 30, -20];
const SCALE: Affine = [2, 0, 0, 3, 0, 0];
/** A quarter turn that takes +x to +y — CLOCKWISE on a y-down page. */
const QUARTER: Affine = [0, 1, -1, 0, 0, 0];

describe("applyAffine", () => {
  it("passes a point through a null transform (an element with no itemTransform)", () => {
    expect(applyAffine(null, 7, -3)).toEqual([7, -3]);
  });

  it("translates", () => {
    expect(applyAffine(TRANSLATE, 1, 2)).toEqual([31, -18]);
  });

  it("scales each axis by its own factor", () => {
    expect(applyAffine(SCALE, 5, 7)).toEqual([10, 21]);
  });

  it("rotates +x onto +y and +y onto −x for a quarter turn", () => {
    expect(applyAffine(QUARTER, 1, 0)).toEqual([0, 1]);
    expect(applyAffine(QUARTER, 0, 1)).toEqual([-1, 0]);
  });

  it("reads b as the y-coefficient of x and c as the x-coefficient of y (not transposed)", () => {
    // A horizontal shear: x' = x + 2y. In column pairs that is c = 2.
    const shearX: Affine = [1, 0, 2, 1, 0, 0];
    expect(applyAffine(shearX, 0, 1)).toEqual([2, 1]);
    expect(applyAffine(shearX, 1, 0)).toEqual([1, 0]);
  });
});

describe("inverseApplyAffine", () => {
  it("passes a point through a null transform", () => {
    expect(inverseApplyAffine(null, 7, -3)).toEqual([7, -3]);
  });

  it("brings a page-space point back into the element's local frame", () => {
    expect(inverseApplyAffine(TRANSLATE, 31, -18)).toEqual([1, 2]);
    expect(inverseApplyAffine(SCALE, 10, 21)).toEqual([5, 7]);
    const back = inverseApplyAffine(QUARTER, 0, 1)!;
    expect(back[0]).toBeCloseTo(1);
    expect(back[1]).toBeCloseTo(0);
  });

  it("inverts a general transform (rotate + scale + translate)", () => {
    const m: Affine = [0, 2, -2, 0, 100, 50]; // quarter turn, ×2, moved
    const page = applyAffine(m, 3, 4); // (−8 + 100, 6 + 50)
    expect(page).toEqual([92, 56]);
    expect(inverseApplyAffine(m, page[0], page[1])).toEqual([3, 4]);
  });

  it("answers null for a singular matrix instead of dividing by zero", () => {
    expect(inverseApplyAffine([1, 2, 2, 4, 0, 0], 1, 1)).toBeNull(); // rank 1
    expect(inverseApplyAffine([0, 0, 0, 0, 5, 5], 1, 1)).toBeNull(); // rank 0
    expect(inverseApplyAffine([3, 0, 0, 0, 0, 0], 1, 1)).toBeNull(); // flattened in y
  });
});

describe("composeAffine", () => {
  it("applies the INNER transform first", () => {
    // scale-then-translate ≠ translate-then-scale.
    const scaleThenMove = composeAffine(TRANSLATE, SCALE);
    const moveThenScale = composeAffine(SCALE, TRANSLATE);
    expect(applyAffine(scaleThenMove, 1, 1)).toEqual([32, -17]);
    expect(applyAffine(moveThenScale, 1, 1)).toEqual([62, -57]);
  });

  it("has IDENTITY_AFFINE as its neutral element", () => {
    expect(IDENTITY_AFFINE).toEqual([1, 0, 0, 1, 0, 0]);
    expect(composeAffine(IDENTITY_AFFINE, TRANSLATE)).toEqual(TRANSLATE);
    expect(composeAffine(SCALE, IDENTITY_AFFINE)).toEqual(SCALE);
  });

  it("two quarter turns make a half turn", () => {
    const half = composeAffine(QUARTER, QUARTER);
    expect(applyAffine(half, 3, 4)).toEqual([-3, -4]);
  });

  it("a nested group's transform is parent ∘ child", () => {
    // The SVG reader's `g` flattening: child coordinates go through the
    // child's own transform, then the parent's.
    const parent: Affine = [1, 0, 0, 1, 10, 0];
    const child: Affine = [2, 0, 0, 2, 0, 0];
    expect(applyAffine(composeAffine(parent, child), 5, 5)).toEqual([20, 10]);
  });
});

describe("affineScale", () => {
  it("is 1 for no transform and for a pure translation", () => {
    expect(affineScale(null)).toBe(1);
    expect(affineScale(IDENTITY_AFFINE)).toBe(1);
    expect(affineScale(TRANSLATE)).toBe(1);
  });

  it("is the scale factor of a uniform scale, rotated or not", () => {
    expect(affineScale([4, 0, 0, 4, 0, 0])).toBe(4);
    expect(affineScale([0, 4, -4, 0, 9, 9])).toBe(4);
    expect(affineScale([-4, 0, 0, 4, 0, 0])).toBe(4); // a mirror still scales by 4
  });

  it("averages the two axes of a non-uniform scale", () => {
    expect(affineScale(SCALE)).toBe(2.5);
  });

  it("falls back to 1 when the linear part is zero (a pick tolerance must not collapse)", () => {
    expect(affineScale([0, 0, 0, 0, 12, 34])).toBe(1);
  });
});

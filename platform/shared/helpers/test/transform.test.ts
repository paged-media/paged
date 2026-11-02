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
  apply,
  compose,
  createTransformMemory,
  invert,
  linearChange,
  reflectMatrix,
  selectionCentre,
  transformBounds,
  transformMatrixOf,
  type Affine,
} from "../src/index.ts";

const near = (got: readonly number[], want: readonly number[]) => {
  expect(got).toHaveLength(want.length);
  got.forEach((v, i) => expect(v).toBeCloseTo(want[i]!, 9));
};

describe("reflectMatrix", () => {
  it("90 degrees is a vertical axis: left and right swap about x", () => {
    near(reflectMatrix(90, [150, 130]), [-1, 0, 0, 1, 300, 0]);
    near(apply(reflectMatrix(90, [150, 130]), 100, 40), [200, 40]);
  });

  it("0 degrees is a horizontal axis: top and bottom swap about y", () => {
    near(reflectMatrix(0, [150, 130]), [1, 0, 0, -1, 0, 260]);
    near(apply(reflectMatrix(0, [150, 130]), 100, 40), [100, 220]);
  });

  it("a diagonal axis swaps the coordinates, and a reflection is its own inverse", () => {
    const m = reflectMatrix(45, [0, 0]);
    near(apply(m, 3, 7), [7, 3]);
    near(compose(m, m), [1, 0, 0, 1, 0, 0]);
  });

  it("keeps every point of its axis where it is", () => {
    const m = reflectMatrix(30, [10, 20]);
    const a = (30 * Math.PI) / 180;
    near(apply(m, 10 + 5 * Math.cos(a), 20 + 5 * Math.sin(a)), [
      10 + 5 * Math.cos(a),
      20 + 5 * Math.sin(a),
    ]);
  });
});

describe("selectionCentre and transformBounds", () => {
  it("the centre of the union of the boxes", () => {
    expect(selectionCentre([])).toBeNull();
    expect(
      selectionCentre([
        [0, 0, 10, 10],
        [50, 90, 70, 110],
      ]),
    ).toEqual([55, 35]);
  });

  it("the hull of the four corners through a matrix", () => {
    const q: Affine = [0, 1, -1, 0, 0, 0];
    expect(transformBounds([0, 0, 10, 20], q)).toEqual([0, -10, 20, 0]);
    expect(transformBounds([1, 2, 3, 4], null)).toEqual([1, 2, 3, 4]);
  });

  it("invert undoes compose, and a singular matrix has none", () => {
    const m: Affine = [2, 1, -1, 3, 5, 7];
    near(compose(invert(m)!, m), [1, 0, 0, 1, 0, 0]);
    expect(invert([1, 2, 2, 4, 0, 0])).toBeNull();
  });
});

describe("a record, about a centre", () => {
  it("a reflect record is the reflection through the centre", () => {
    near(
      transformMatrixOf(
        { kind: "reflect", angleDeg: 90, copy: false },
        [150, 130],
      ),
      reflectMatrix(90, [150, 130]),
    );
  });

  it("a linear record fixes its centre and applies its linear part", () => {
    const m = transformMatrixOf(
      { kind: "linear", linear: [0, 1, -1, 0], copy: false },
      [10, 20],
    );
    near(apply(m, 10, 20), [10, 20]);
    // A quarter turn about (10, 20): (20, 20) is 10 right of the centre.
    near(apply(m, 20, 20), [10, 30]);
  });
});

describe("linearChange", () => {
  it("the 2x2 of after after-before-inverse, whatever the pivot", () => {
    const before: Affine = [1, 0, 0, 1, 40, 50];
    // A half turn about some other point, then the item's own move.
    const half: Affine = [-1, 0, 0, -1, 300, 200];
    const after = compose(half, before);
    expect(linearChange(before, after)).toEqual([-1, 0, 0, -1]);
  });

  it("no change, a singular start or an unreadable end give nothing", () => {
    expect(linearChange(null, null)).toBeNull();
    expect(linearChange([1, 0, 0, 1, 5, 5], [1, 0, 0, 1, 90, 5])).toBeNull();
    expect(linearChange([0, 0, 0, 0, 0, 0], [1, 0, 0, 1, 0, 0])).toBeNull();
  });

  it("a scale reads as the scale", () => {
    expect(linearChange(null, [2, 0, 0, 0.5, 7, 7])).toEqual([2, 0, 0, 0.5]);
  });
});

describe("the session's transform memory", () => {
  it("is empty, remembers by value and forgets", () => {
    const m = createTransformMemory();
    expect(m.last()).toBeNull();
    const r = { kind: "reflect" as const, angleDeg: 90, copy: false };
    m.remember(r);
    r.angleDeg = 0;
    expect(m.last()).toEqual({ kind: "reflect", angleDeg: 90, copy: false });
    const lin = {
      kind: "linear" as const,
      linear: [0, 1, -1, 0] as const,
      copy: false as const,
    };
    m.remember(lin);
    expect(m.last()).toEqual(lin);
    m.forget();
    expect(m.last()).toBeNull();
  });

  it("two sessions do not share it", () => {
    const a = createTransformMemory();
    const b = createTransformMemory();
    a.remember({ kind: "reflect", angleDeg: 0, copy: false });
    expect(b.last()).toBeNull();
  });
});

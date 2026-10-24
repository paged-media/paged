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

import { sameShape, shapeStructureKey, type AnchorTable } from "../src";

type P = [number, number];

/** A corner-only table from points, one contour unless `starts` says. */
const table = (
  points: P[],
  extra: { starts?: number[]; open?: boolean[] } = {},
): AnchorTable => ({
  anchors: points.map((p) => ({ anchor: p, left: p, right: p })),
  subpathStarts: extra.starts ?? [0],
  ...(extra.open ? { subpathOpen: extra.open } : {}),
});

const move = (pts: P[], dx: number, dy: number): P[] =>
  pts.map(([x, y]) => [x + dx, y + dy]);
const scale = (pts: P[], k: number): P[] => pts.map(([x, y]) => [x * k, y * k]);

const L: P[] = [
  [0, 0],
  [30, 0],
  [30, 10],
  [10, 10],
  [10, 40],
  [0, 40],
];

describe("sameShape — the Global Edit geometry test [plugin-draw.select-same]", () => {
  it("a moved copy is the same shape; position never matters", () => {
    expect(sameShape(table(L), table(move(L, 200, -75)))).toBe(true);
  });

  it("a scaled copy matches only with anySize", () => {
    const big = table(scale(L, 2.5));
    expect(sameShape(table(L), big)).toBe(false);
    expect(sameShape(table(L), big, { anySize: true })).toBe(true);
    expect(sameShape(big, table(L), { anySize: true })).toBe(true);
  });

  it("the tolerance is per point, inclusive, in pt", () => {
    const bent = L.map((p, i) => (i === 3 ? ([10.4, 10] as P) : p));
    expect(sameShape(table(L), table(bent))).toBe(false);
    expect(sameShape(table(L), table(bent), { tolerance: 0.4 })).toBe(true);
    expect(sameShape(table(L), table(bent), { tolerance: 0.39 })).toBe(false);
  });

  it("a different anchor count, contour split or open flag never matches", () => {
    expect(sameShape(table(L), table(L.slice(0, 5)))).toBe(false);
    expect(sameShape(table(L), table(L, { starts: [0, 3] }))).toBe(false);
    expect(
      sameShape(table(L, { open: [true] }), table(L, { open: [false] })),
    ).toBe(false);
    expect(shapeStructureKey(table(L, { starts: [0, 3] }))).toBe("3c,3c");
  });

  it("a closed contour that only starts at another anchor matches; an open one does not", () => {
    const rotated = [...L.slice(2), ...L.slice(0, 2)];
    expect(sameShape(table(L), table(move(rotated, 5, 5)))).toBe(true);
    expect(
      sameShape(table(L, { open: [true] }), table(rotated, { open: [true] })),
    ).toBe(false);
  });

  it("a mirrored or rotated copy is NOT the same shape", () => {
    const mirrored = L.map(([x, y]) => [-x, y] as P);
    const turned = L.map(([x, y]) => [-y, x] as P);
    expect(sameShape(table(L), table(mirrored))).toBe(false);
    expect(sameShape(table(L), table(turned))).toBe(false);
  });

  it("handles count: the same anchors with different curves differ", () => {
    const curved: AnchorTable = {
      anchors: L.map((p, i) =>
        i === 0
          ? { anchor: p, left: p, right: [p[0] + 5, p[1] + 5] as P }
          : { anchor: p, left: p, right: p },
      ),
      subpathStarts: [0],
    };
    expect(sameShape(table(L), curved)).toBe(false);
    expect(sameShape(curved, curved)).toBe(true);
  });

  it("an empty table is never a shape", () => {
    expect(sameShape(table([]), table([]))).toBe(false);
  });
});

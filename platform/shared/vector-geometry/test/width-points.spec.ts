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
  measureAnchorRun,
  nearestOnRun,
  normalizeWidthPoints,
  WIDTH_PROFILE_PRESETS,
  widthFactorAt,
  widthOutlinePolyline,
  withWidthPoint,
  withoutWidthPoint,
  type AnchorTriple,
} from "../src";

const corner = (x: number, y: number): AnchorTriple => ({
  anchor: [x, y],
  left: [x, y],
  right: [x, y],
});

describe("width points [plugin-draw.brushes-width]", () => {
  it("eases between points like the engine and holds past the ends", () => {
    const p = normalizeWidthPoints([
      [0.75, 3],
      [0.25, 1],
    ]);
    expect(p).toEqual([
      [0.25, 1],
      [0.75, 3],
    ]);
    expect(widthFactorAt(p, 0)).toBe(1);
    expect(widthFactorAt(p, 1)).toBe(3);
    expect(widthFactorAt(p, 0.5)).toBeCloseTo(2, 9);
    expect(widthFactorAt([], 0.3)).toBe(1);
  });

  it("normalises: clamps, drops what is not finite", () => {
    expect(
      normalizeWidthPoints([
        [2, 1],
        [-1, 500],
        [Number.NaN, 1],
      ]),
    ).toEqual([
      [0, 100],
      [1, 1],
    ]);
  });

  it("a dragged point moves a near one, else is added to a uniform start", () => {
    expect(withWidthPoint([], 0.5, 3)).toEqual([
      [0, 1],
      [0.5, 3],
      [1, 1],
    ]);
    expect(
      withWidthPoint(
        [
          [0, 1],
          [0.5, 3],
          [1, 1],
        ],
        0.51,
        2,
      ),
    ).toEqual([
      [0, 1],
      [0.5, 2],
      [1, 1],
    ]);
    expect(
      withoutWidthPoint(
        [
          [0, 1],
          [0.5, 3],
          [1, 1],
        ],
        0.49,
      ),
    ).toEqual([
      [0, 1],
      [1, 1],
    ]);
  });

  it("finds where a point is on a run", () => {
    const m = measureAnchorRun([corner(0, 0), corner(100, 0)]);
    const at = nearestOnRun(m, [25, 10])!;
    expect(at.u).toBeCloseTo(0.25, 6);
    expect(at.distance).toBeCloseTo(10, 6);
    // Left of a rightward run on a y-down page is up (−y).
    expect(at.normal[1]).toBeCloseTo(-1, 6);
  });

  it("previews the band as one closed polyline", () => {
    const line = widthOutlinePolyline(
      [corner(0, 0), corner(100, 0)],
      false,
      4,
      [
        [0, 0],
        [0.5, 2],
        [1, 0],
      ],
    );
    expect(line.length).toBeGreaterThan(4);
    expect(line[0]).toEqual(line[line.length - 1]!);
    const ys = line.map((p) => Math.abs(p[1]));
    expect(Math.max(...ys)).toBeCloseTo(4, 1);
  });

  it("the library starts with the uniform stroke and names every profile once", () => {
    expect(WIDTH_PROFILE_PRESETS[0]!.id).toBe("uniform");
    const ids = WIDTH_PROFILE_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of WIDTH_PROFILE_PRESETS)
      expect(normalizeWidthPoints(p.points)).toEqual(
        p.points.map(([t, w]) => [t, w]),
      );
  });
});

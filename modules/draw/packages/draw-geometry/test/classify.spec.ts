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
  cornerAnchor,
  isCornerAnchor,
  isSmoothAnchor,
  smoothAnchorFromDrag,
  type AnchorTriple,
} from "../src";

describe("isCornerAnchor — IDML's zero-handle corner convention", () => {
  it("a corner is an anchor with BOTH handles collapsed onto it", () => {
    expect(isCornerAnchor(cornerAnchor([10, 20]))).toBe(true);
    expect(
      isCornerAnchor({ anchor: [10, 20], left: [10, 20], right: [10, 20] }),
    ).toBe(true);
  });

  it("a smooth anchor (mirrored handles) is not a corner", () => {
    expect(isCornerAnchor(smoothAnchorFromDrag([10, 20], [15, 20]))).toBe(false);
  });

  it("ONE extended handle is enough to stop it being a corner", () => {
    // The half-smooth anchors a straight-into-curve join carries.
    const rightOnly: AnchorTriple = {
      anchor: [0, 0],
      left: [0, 0],
      right: [4, 0],
    };
    const leftOnly: AnchorTriple = {
      anchor: [0, 0],
      left: [-4, 0],
      right: [0, 0],
    };
    expect(isCornerAnchor(rightOnly)).toBe(false);
    expect(isCornerAnchor(leftOnly)).toBe(false);
  });

  it("a cusp (two independent, non-mirrored handles) is not a corner either", () => {
    expect(
      isCornerAnchor({ anchor: [0, 0], left: [-3, -3], right: [3, -3] }),
    ).toBe(false);
  });

  it("tolerates handles within the default 1e-3 pt of the anchor (round-trip noise)", () => {
    const noisy: AnchorTriple = {
      anchor: [100, 100],
      left: [100.0004, 100],
      right: [100, 99.9996],
    };
    expect(isCornerAnchor(noisy)).toBe(true);
    const drifted: AnchorTriple = {
      anchor: [100, 100],
      left: [100.002, 100],
      right: [100, 100],
    };
    expect(isCornerAnchor(drifted)).toBe(false);
  });

  it("measures the handle's DISTANCE, not each axis", () => {
    // 0.0008 on both axes is 0.00113 away — outside the 1e-3 disc.
    expect(
      isCornerAnchor({
        anchor: [0, 0],
        left: [0.0008, 0.0008],
        right: [0, 0],
      }),
    ).toBe(false);
  });

  it("takes the tolerance as an argument", () => {
    const a: AnchorTriple = { anchor: [0, 0], left: [0.5, 0], right: [0, 0] };
    expect(isCornerAnchor(a)).toBe(false);
    expect(isCornerAnchor(a, 1)).toBe(true);
    expect(isCornerAnchor(a, 0.25)).toBe(false);
  });

  // ------------------------------------------------------------------
  // DEFECT (classify.ts, isCornerAnchor) — with `eps = 0` NOTHING was a
  // corner, not even an anchor whose handles are bit-identical to it.
  // FIXED.
  //
  // The test was `dist(...) < eps`, strictly. The module's own definition
  // is "an anchor is a corner iff BOTH handles coincide with it", and
  // `eps = 0` is how a caller asks for exactly that; `0 < 0` is false.
  //
  //   isCornerAnchor(cornerAnchor([1, 1]), 0)
  //   EXPECTED: true (the handles coincide with the anchor).
  //   WAS:      false.
  //
  // Low severity: the one caller (draw-tools anchor-machine) uses the
  // 1e-3 default.
  //
  // THE FIX: the bound is inclusive (`<=`) — a handle AT MOST `eps` from
  // its anchor is collapsed. `isSmoothAnchor` reads "collapsed" with the
  // same `eps` and was moved to the same inclusive bound, so the two
  // tests cannot disagree about a handle exactly `eps` long.
  // ------------------------------------------------------------------
  it("FIXED DEFECT (boundary): an EXACT corner is a corner at zero tolerance", () => {
    expect(isCornerAnchor(cornerAnchor([1, 1]), 0)).toBe(true);
    // Zero tolerance means zero: the smallest handle there is stops it.
    expect(
      isCornerAnchor({ anchor: [1, 1], left: [1, 1], right: [1 + 2 ** -52, 1] }, 0),
    ).toBe(false);
  });

  it("FIXED DEFECT (boundary): a handle EXACTLY the tolerance long is collapsed — for both tests", () => {
    // 0.5 is exactly representable, so the distance IS the tolerance.
    const onTheLine: AnchorTriple = { anchor: [0, 0], left: [-0.5, 0], right: [0.5, 0] };
    expect(isCornerAnchor(onTheLine, 0.5)).toBe(true);
    // The same anchor, the same tolerance: collapsed handles are not the
    // two EXTENDED handles a smooth anchor needs. Before the bound was
    // made inclusive in both, this anchor was neither corner NOR
    // collapsed-for-smooth, i.e. "smooth" with handles the corner test's
    // neighbour called zero-length.
    expect(isSmoothAnchor(onTheLine, 0.5)).toBe(false);
    // A hair longer, and it is a real (smooth) handle pair again.
    const longer: AnchorTriple = { anchor: [0, 0], left: [-0.75, 0], right: [0.75, 0] };
    expect(isCornerAnchor(longer, 0.5)).toBe(false);
    expect(isSmoothAnchor(longer, 0.5)).toBe(true);
  });
});

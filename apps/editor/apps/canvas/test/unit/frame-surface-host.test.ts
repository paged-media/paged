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

// Editor ADR 281 — the frame surface's transform: a frame-content point
// lands on the host pixel the canvas paints it at (camera ∘ page origin ∘
// ItemTransform ∘ content-box origin), and the inverse maps it back, also
// for a rotated frame.

import { describe, expect, test } from "bun:test";

import {
  compose,
  contentToHostMatrix,
  invert,
} from "../../src/ui/frame-surface-math";

type Mat = [number, number, number, number, number, number];
const apply = (m: Mat, x: number, y: number): [number, number] => [
  m[0] * x + m[2] * y + m[4],
  m[1] * x + m[3] * y + m[5],
];

describe("frame surface transform", () => {
  test("an unrotated frame: camera scale and offsets, page origin, content box", () => {
    const m = contentToHostMatrix(
      { scale: 2, tx: 10, ty: 20 },
      { x: 100, y: 50 },
      { bounds: [30, 40, 130, 240], itemTransform: [1, 0, 0, 1, 5, 6] },
    );
    // content (0,0) = page (40+5, 30+6) = doc (145, 86) = host (300, 192)
    expect(apply(m, 0, 0)).toEqual([300, 192]);
    // one point of content is camera-scale pixels
    expect(apply(m, 1, 0)).toEqual([302, 192]);
  });

  test("a rotated frame round-trips through the inverse", () => {
    const c = Math.cos(Math.PI / 6);
    const s = Math.sin(Math.PI / 6);
    const m = contentToHostMatrix(
      { scale: 1.5, tx: -3, ty: 7 },
      { x: 12, y: 0 },
      { bounds: [0, 0, 50, 80], itemTransform: [c, s, -s, c, 20, 30] },
    );
    const inv = invert(m)!;
    const [hx, hy] = apply(m, 17, 9);
    const [x, y] = apply(inv, hx, hy);
    expect(x).toBeCloseTo(17, 9);
    expect(y).toBeCloseTo(9, 9);
    // pixels per point = camera scale for a rigid rotation
    expect(Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]))).toBeCloseTo(1.5, 9);
  });

  test("compose applies the right matrix first; a singular matrix has no inverse", () => {
    const t: Mat = [1, 0, 0, 1, 3, 4];
    const sc: Mat = [2, 0, 0, 2, 0, 0];
    expect(apply(compose(sc, t), 1, 1)).toEqual([8, 10]);
    expect(invert([0, 0, 0, 0, 1, 1])).toBeNull();
  });
});

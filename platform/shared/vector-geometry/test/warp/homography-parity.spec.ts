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

// The four-point homography has one TypeScript solve (the extension SDK's
// `transform-box`, which vector-geometry delegates to) and one Rust solve
// (`paged_warp::from_quads`). Both are held to the same numbers here and in
// `engine/core/crates/paged-warp/tests/ts_parity.rs`, so the editor's
// preview and the engine's warp cannot drift apart.

import { describe, expect, it } from "bun:test";

import { homographyFromQuads } from "../../src/index.ts";

const RECT = [
  [0, 0],
  [64, 0],
  [64, 48],
  [0, 48],
] as const;

const CASES: {
  to: readonly [number, number][];
  h: readonly number[];
}[] = [
  {
    to: [
      [3, 2],
      [70, -4],
      [58, 52],
      [-6, 44],
    ],
    h: [0.7734375, -0.1875, 3, -0.078125, 0.875, 2, -0.00390625, 0, 1],
  },
  {
    to: [
      [1, 1],
      [50, 5],
      [61, 47],
      [-3, 40],
    ],
    h: [
      0.7395933071620069, -0.06904283160985573, 1, 0.05989683071620069,
      0.6219599770202987, 1, -0.0005206338567598621, -0.004763500574492531, 1,
    ],
  },
];

describe("homography parity with paged-warp", () => {
  it("solves the pinned quads to paged_warp::from_quads' numbers", () => {
    for (const c of CASES) {
      const h = homographyFromQuads(
        RECT as unknown as Parameters<typeof homographyFromQuads>[0],
        c.to as unknown as Parameters<typeof homographyFromQuads>[1],
      )!;
      expect(h).not.toBeNull();
      h.forEach((v, i) => expect(Math.abs(v - c.h[i]!)).toBeLessThan(1e-12));
    }
  });
});

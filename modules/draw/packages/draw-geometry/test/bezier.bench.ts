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

// TRENDED, NOT GATED — see `bench-data.ts`.
//
// `closestTOnCubic` is the Add Anchor tool's "where on this segment did
// the click land": a 30-sample coarse search and one Newton step, per
// SEGMENT of the clicked path. One call is nothing; a click on a long
// path is one call per segment, so the row to read is the 1 000-segment
// one — a click on the perf workload's 1 000-anchor path.

import { bench, describe } from "vitest";

import { closestTOnCubic } from "../src/bezier";
import { cubicRun } from "./bench-data";

describe("closestTOnCubic", () => {
  const { cubics, clicks } = cubicRun(1000);
  const [start, startRight, endLeft, end] = cubics[500]!;
  const click = clicks[500]!;

  bench("one segment", () => {
    closestTOnCubic(start, startRight, endLeft, end, click);
  });

  bench("every segment of a 1 000-segment path", () => {
    for (let i = 0; i < cubics.length; i++) {
      const c = cubics[i]!;
      closestTOnCubic(c[0], c[1], c[2], c[3], clicks[i]!);
    }
  });
});

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
// `simplifyRdp` runs once per pencil / brush / eraser stroke, on
// pointer-up, over every sample the stroke kept. Tolerance 2 pt is the
// tools' own `SIMPLIFY_TOLERANCE_PX` at 100 % zoom.
//
// What to read: the 20 000 row against the 2 000 row. RDP is
// O(n log n) on a stroke that splits evenly and O(n²) on one that does
// not; ten times the samples for much more than ten times the time is
// the quadratic showing.

import { bench, describe } from "vitest";

import { simplifyRdp } from "../src/rdp";
import { freehandStroke, spiralStroke } from "./bench-data";

const TOLERANCE = 2;

describe("simplifyRdp", () => {
  const jittered2k = freehandStroke(2000);
  const jittered20k = freehandStroke(20000);
  const spiral2k = spiralStroke(2000);
  const spiral20k = spiralStroke(20000);

  bench("2 000 samples — jittered freehand", () => {
    simplifyRdp(jittered2k, TOLERANCE);
  });

  bench("20 000 samples — jittered freehand", () => {
    simplifyRdp(jittered20k, TOLERANCE);
  });

  bench("2 000 samples — spiral", () => {
    simplifyRdp(spiral2k, TOLERANCE);
  });

  bench("20 000 samples — spiral", () => {
    simplifyRdp(spiral20k, TOLERANCE);
  });
});

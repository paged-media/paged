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
// `contourDepths` decides which contours of a compound path are holes.
// It runs once per Make Compound Path and once per traced REGION of an
// Image Trace — and a traced region is where the contour counts get
// large: a speckled photograph traces to hundreds of nested islands.
//
// What to read: the 300 row against the 30 row. The pass tests every
// contour against every other (and slices the anchor table to do it),
// so ten times the contours is a hundred times the tests.

import { bench, describe } from "vitest";

import { contourDepths } from "../src/compound";
import { nestedContours } from "./bench-data";

describe("contourDepths — nested contours in one table", () => {
  const thirty = nestedContours(30);
  const threeHundred = nestedContours(300);

  bench("30 contours", () => {
    contourDepths(thirty);
  });

  bench("300 contours", () => {
    contourDepths(threeHundred);
  });
});

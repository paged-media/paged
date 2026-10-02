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
// `pointInAnchorPath` is what a region tool (Shape Builder, Live Paint)
// runs PER POINTER MOVE once its arrangement is cached: the pointer
// against each face outline until one contains it. 256 faces is the
// engine's cap, so one iteration below is the worst hover move there is
// — a pointer over NO face, which has to be tested against all of them.
//
// What to read: the curved row against the straight one. A straight
// edge costs one crossing test; a curved one is flattened to 12 samples
// first, on every call — nothing is kept between moves.

import { bench, describe } from "vitest";

import { pointInAnchorPath } from "../src/polygon";
import type { Vec2 } from "../src/types";
import { faceGrid, roundFace, squareFace } from "./bench-data";

/** Outside the whole grid: every face is tested, none matches. */
const NOWHERE: Vec2 = [5, 5];

describe("pointInAnchorPath — one hover move over 256 faces", () => {
  const straight = faceGrid((x, y) => squareFace(x, y, 28));
  const curved = faceGrid((x, y) => roundFace(x + 14, y + 14, 14));

  bench("256 straight-edged faces (4 anchors each)", () => {
    for (const face of straight) pointInAnchorPath(NOWHERE, face);
  });

  bench("256 curved faces (4 anchors each, every segment a cubic)", () => {
    for (const face of curved) pointInAnchorPath(NOWHERE, face);
  });
});

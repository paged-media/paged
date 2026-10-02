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
// "Which of these 256 outlines holds this point?" — 256 faces is the
// engine's cap, so one iteration below is the worst hover move there is:
// a pointer over NO face, which has to be tested against all of them.
//
// TWO FORMS OF THE SAME TEST, and the difference between them is what
// this file exists to show:
//
//   · `pointInAnchorPath` flattens the outline on every call. It is what
//     the region tools (Shape Builder, Live Paint) used to run PER
//     POINTER MOVE, and it is still the right form for one question.
//     Read the curved row against the straight one: a straight edge
//     costs one crossing test, a curved one is sampled 12 times first.
//   · `flattenAnchorPath` once, then `pointInFlatPath` per point, is
//     what they run now (`draw-tools/src/region-lookup.ts`). The curves
//     were paid for at install, and a point outside an outline's box
//     walks none of its edges — so curved and straight cost the same.
//
// The second pair of rows is over a point INSIDE the last face: every
// box but one rejects it, and one outline is walked.

import { bench, describe } from "vitest";

import {
  flattenAnchorPath,
  pointInAnchorPath,
  pointInFlatPath,
} from "../src/polygon";
import type { Vec2 } from "../src/types";
import { faceGrid, roundFace, squareFace } from "./bench-data";

/** Outside the whole grid: every face is tested, none matches. */
const NOWHERE: Vec2 = [5, 5];
/** The centre of the last face of the grid (row 15, column 15). */
const LAST_FACE: Vec2 = [20 + 15 * 30 + 14, 20 + 15 * 30 + 14];

const straight = faceGrid((x, y) => squareFace(x, y, 28));
const curved = faceGrid((x, y) => roundFace(x + 14, y + 14, 14));

describe("pointInAnchorPath — one hover move over 256 faces, flattening per call", () => {
  bench("256 straight-edged faces (4 anchors each)", () => {
    for (const face of straight) pointInAnchorPath(NOWHERE, face);
  });

  bench("256 curved faces (4 anchors each, every segment a cubic)", () => {
    for (const face of curved) pointInAnchorPath(NOWHERE, face);
  });
});

describe("pointInFlatPath — the same move over 256 faces flattened once", () => {
  const flatStraight = straight.map((face) => flattenAnchorPath(face));
  const flatCurved = curved.map((face) => flattenAnchorPath(face));

  bench("256 straight-edged faces, pointer over none", () => {
    for (const face of flatStraight) pointInFlatPath(NOWHERE, face);
  });

  bench("256 curved faces, pointer over none", () => {
    for (const face of flatCurved) pointInFlatPath(NOWHERE, face);
  });

  bench("256 straight-edged faces, pointer inside the last one", () => {
    for (const face of flatStraight) pointInFlatPath(LAST_FACE, face);
  });

  bench("256 curved faces, pointer inside the last one", () => {
    for (const face of flatCurved) pointInFlatPath(LAST_FACE, face);
  });
});

describe("flattenAnchorPath — what the one-time flatten costs", () => {
  bench("256 curved faces", () => {
    for (const face of curved) flattenAnchorPath(face);
  });
});

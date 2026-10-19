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

// The parity FIXTURE: one small document with one of each thing an
// operation can act on, built in code (no corpus). Every surface starts
// every case from these bytes (plus the case's setup), so a difference
// between two surfaces is a difference between the surfaces.

import {
  buildFixtureIdml,
  group,
  line,
  oval,
  polygon,
  rect,
  textFrame,
} from "@paged-media/test-kit";

/** Ids of the fixture's objects (page-local pt boxes in comments). */
export const P = {
  page: "pp1",
  page2: "pp2",
  spread: "pp1-spread",
  master: "um",
  /** A plain frame, 72–216 × 72–144. */
  frame: "ufr1",
  /** A frame overlapping `frame` (pathfinder, masks, clipping). */
  overlap: "ufr2",
  /** A frame apart from the rest. */
  apart: "ufr3",
  group: "ugrp",
  groupA: "ugA",
  groupB: "ugB",
  /** A closed four-anchor polygon. */
  quad: "upoly",
  /** An open three-anchor polygon. */
  open: "uopen",
  line: "uline",
  textFrame: "utf1",
  textFrame2: "utf2",
  story: "ust1",
  story2: "ust2",
  /** A story no frame shows (text on a path takes one). */
  looseStory: "ust3",
  frameOnPage2: "up2",
  masterItem: "umast",
} as const;

export const STORY_TEXT = ["Hello parity world.", "Second paragraph here."];

let bytes: Uint8Array | null = null;

/** The fixture's IDML bytes (built once; callers get a copy). */
export function parityFixture(): Uint8Array {
  bytes ??= buildFixtureIdml({
    name: "surface-parity",
    pages: [
      {
        id: P.page,
        items: [
          rect(P.frame, [72, 72, 144, 216]),
          rect(P.overlap, [108, 144, 180, 288]),
          rect(P.apart, [72, 420, 144, 540]),
          group(P.group, [
            rect(P.groupA, [400, 72, 460, 152]),
            oval(P.groupB, [400, 200, 460, 280]),
          ]),
          polygon(
            P.quad,
            [
              [300, 300],
              [400, 300],
              [400, 400],
              [300, 400],
            ],
            false,
            { fill: "Color/Gray" },
          ),
          polygon(
            P.open,
            [
              [72, 620],
              [144, 680],
              [216, 620],
            ],
            true,
          ),
          line(P.line, [72, 720], [216, 720]),
          textFrame(P.textFrame, [200, 72, 300, 300], P.story),
          textFrame(P.textFrame2, [200, 320, 300, 540], P.story2),
        ],
      },
      { id: P.page2, items: [rect(P.frameOnPage2, [72, 72, 144, 216])] },
    ],
    masterItems: [rect(P.masterItem, [740, 72, 770, 540])],
    stories: [
      { id: P.story, paragraphs: STORY_TEXT },
      { id: P.story2, paragraphs: ["Thread target."] },
      { id: P.looseStory, paragraphs: ["Text on a path."] },
    ],
  });
  return bytes.slice();
}

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

// PERF BUDGETS — work counted at the host doors (roadmap M1.4).
//
// THE RULES, and they are the whole point of this file:
//
//  1. A budget is a COUNT, never a duration. Wall-clock moved 45% on a
//     busy machine in core's campaign; a count does not move at all.
//  2. A budget is the MEASURED value. It is written down as found — the
//     bad ones included, with the number it should become beside it.
//  3. A budget is only ever LOWERED, in the same commit as the change
//     that earns it. If one of these fails upward, the change made the
//     tool do more work; raising the number is not the fix.
//  4. Every scenario says which expensive path it exercises. A stream
//     over an empty page measures nothing.
//
// The harness is `countingHost` (./counting-host.ts): a Proxy over the
// REAL headless host, so the engine still answers and a budget can sit
// beside a behaviour assertion on the same gesture.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ElementId } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import { createShapeBuilderHandler, drawBundle } from "../../src";
import { F4_OVERLAP } from "../fixtures/corpus";
import { openHost } from "../conformance/host";
import { countingHost, type WorkLog } from "./counting-host";
import {
  drive,
  linePoints,
  pointerAt,
  settle,
  type Pacing,
} from "./pointer-stream";

describe("perf budgets — work counted at the host doors", () => {
  // COVERS: the per-pointer-move path of a region tool over a two-input
  // arrangement (F4: two overlapping polygons, three faces). A hover,
  // because hovering is half of this tool and costs the same per move as
  // a drag.
  describe("Shape Builder — a 200-move hover across two overlapping shapes", () => {
    const A = { kind: "polygon", id: F4_OVERLAP.ids.polygon! } as ElementId;
    const B = { kind: "polygon", id: F4_OVERLAP.secondId } as ElementId;
    const MOVES = 200;
    let h: HeadlessHost;

    beforeAll(async () => {
      h = await openHost();
      await h.load(F4_OVERLAP.bytes());
      h.loadBundle(drawBundle);
    });
    afterAll(() => h?.dispose());

    const hover = async (pacing: Pacing): Promise<WorkLog> => {
      await h.host.selection.set([A, B]);
      const { host, work } = countingHost(h.host);
      const handler = createShapeBuilderHandler(host);
      handler.onActivate(undefined as never);
      await settle();
      work.reset();
      await drive(
        linePoints([120, 120], [380, 380], MOVES).map((p) =>
          pointerAt(F4_OVERLAP.pageId, p),
        ),
        (e) => handler.onPointerMove(e),
        pacing,
      );
      const counted = work.snapshot();
      handler.onDeactivate("switch" as never);
      return counted;
    };

    it("paced: the engine keeps up, and every move still costs a hit-test", async () => {
      const work = await hover("paced");
      expect(work.mutations).toEqual([]); // a hover writes nothing

      // One `hitTest` round trip per move, although the arrangement is
      // warm and the face under the pointer is resolved locally.
      // TARGET 0 while the region lane is warm.
      expect(work.count("document.hitTest")).toBe(200);
      // The arrangement is read twice, not once. TARGET 1.
      expect(work.count("document.planarRegions")).toBe(2);
      expect(work.count("document.pathAnchors")).toBe(2);
      // Two preview publishes per move (the machine's, then the
      // sweep's). TARGET <= 200, one per move.
      expect(work.previews()).toBe(402);
    });

    it("burst: moves outrun the engine, and every move re-asks for the arrangement", async () => {
      const work = await hover("burst");
      expect(work.mutations).toEqual([]);

      expect(work.count("document.hitTest")).toBe(200);
      // No in-flight guard on the cold-start query: 200 moves ask the
      // engine for the SAME planar arrangement 201 times. TARGET 1.
      expect(work.count("document.planarRegions")).toBe(201);
      expect(work.count("document.pathAnchors")).toBe(201);
      expect(work.previews()).toBe(601);
    });
  });
});

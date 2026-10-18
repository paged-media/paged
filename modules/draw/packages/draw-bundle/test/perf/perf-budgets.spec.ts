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

import type { ElementId, ToolPreviewShape } from "@paged-media/plugin-api";
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
  // arrangement. F4 is two overlapping squares, A = 100..300 and
  // B = 200..400, so the diagonal 120 → 380 crosses all three faces:
  // A-only, the overlap, B-only.
  describe("Shape Builder — 200 moves across two overlapping shapes", () => {
    const A = { kind: "polygon", id: F4_OVERLAP.ids.polygon! } as ElementId;
    const B = { kind: "polygon", id: F4_OVERLAP.secondId } as ElementId;
    const MOVES = 200;
    const FROM: [number, number] = [120, 120];
    const TO: [number, number] = [380, 380];
    let h: HeadlessHost;

    beforeAll(async () => {
      h = await openHost();
      await h.load(F4_OVERLAP.bytes());
      h.loadBundle(drawBundle);
    });
    afterAll(() => h?.dispose());

    const stream = () =>
      linePoints(FROM, TO, MOVES).map((p) => pointerAt(F4_OVERLAP.pageId, p));

    /** `PERF_SHOW=1` prints what was counted — how a budget is found
     *  before it is pinned, and how a failing one is read. */
    const show = (label: string, work: WorkLog): void => {
      if (process.env.PERF_SHOW) console.log(`[perf] ${label}:`, work.calls);
    };

    const hover = async (
      pacing: Pacing,
    ): Promise<{ work: WorkLog; highlight: ToolPreviewShape | null }> => {
      await h.host.selection.set([A, B]);
      const { host, work } = countingHost(h.host);
      const handler = createShapeBuilderHandler(host);
      handler.onActivate(undefined as never);
      await settle();
      work.reset();
      await drive(stream(), (e) => handler.onPointerMove(e), pacing);
      const counted = work.snapshot();
      const highlight = h.lastToolPreview();
      handler.onDeactivate("switch" as never);
      show(`shape builder hover, ${pacing}`, counted);
      return { work: counted, highlight };
    };

    const drag = async (
      selection: ElementId[],
      pacing: Pacing,
    ): Promise<WorkLog> => {
      await h.host.selection.set(selection);
      const { host, work } = countingHost(h.host);
      const handler = createShapeBuilderHandler(host);
      handler.onActivate(undefined as never);
      await settle();
      work.reset();
      handler.onPointerDown(pointerAt(F4_OVERLAP.pageId, FROM));
      await drive(stream(), (e) => handler.onPointerMove(e), pacing);
      handler.onPointerUp(pointerAt(F4_OVERLAP.pageId, TO));
      await settle();
      const counted = work.snapshot();
      handler.onDeactivate("switch" as never);
      show(`shape builder drag (${selection.length} selected), ${pacing}`, counted);
      return counted;
    };

    /** The hover ends at 380,380 — inside B only. Its highlight must be
     *  that face: an outline that stays inside B's box and reaches past
     *  A's (x or y beyond 300). A stale highlight — the overlap, or
     *  A-only — is what a coalescing bug would leave behind. */
    const expectBOnlyFace = (shape: ToolPreviewShape | null): void => {
      const anchors = (shape as { anchors?: { anchor: [number, number] }[] })
        ?.anchors;
      expect(anchors, "the hover ends over a face").toBeDefined();
      const xs = anchors!.map((a) => a.anchor[0]);
      const ys = anchors!.map((a) => a.anchor[1]);
      expect(Math.min(...xs)).toBeGreaterThanOrEqual(200 - 1e-6);
      expect(Math.min(...ys)).toBeGreaterThanOrEqual(200 - 1e-6);
      expect(Math.max(...xs)).toBeCloseTo(400, 6);
      expect(Math.max(...ys)).toBeCloseTo(400, 6);
    };

    // History of these two budgets (a budget only goes DOWN):
    //   as found   paced  200 hitTest, 2 planarRegions, 2 pathAnchors, 402 previews
    //              burst  200 hitTest, 201 planarRegions, 201 pathAnchors, 601 previews
    //   39f923d    both   0, 2, 2, 201
    //   now        both   0, 2, 1, 201
    // Two causes, both removed: a hit-test per move whose answer the
    // machine drops outside a drag, and a cold-start point query with no
    // in-flight guard, which asked for the same arrangement once per move.
    // The guard is newest-wins and drops stale answers — the face check
    // below is what proves it: a first cut of the guard left the face of
    // an OLD pointer position highlighted, and only that check saw it.
    //
    // The last pathAnchors went when the seam started reading the
    // frontmost input's transform ONCE per gesture scope: the enumeration
    // and the cold-start point query each read that input's anchor table
    // for the same matrix, and now share one read. (Its own budget, with
    // the stale-transform check, is in perf-budgets-region.spec.ts.)
    for (const pacing of ["paced", "burst"] as const) {
      it(`hover, ${pacing}: no round trip per move, and the right face is highlighted`, async () => {
        const { work, highlight } = await hover(pacing);
        expect(work.mutations).toEqual([]); // a hover writes nothing

        expect(work.count("document.hitTest")).toBe(0);
        // One full enumeration plus one cold-start point query for the
        // first sample. That is the designed floor on a cold cache.
        expect(work.count("document.planarRegions")).toBe(2);
        // The frontmost input's transform, once for both. Was 2.
        expect(work.count("document.pathAnchors")).toBe(1);
        // One publish per move, plus one when the arrangement lands.
        expect(work.previews()).toBe(201);

        expectBOnlyFace(highlight);
      });
    }

    it("drag with both shapes selected: the region lane commits once", async () => {
      const work = await drag([A, B], "paced");
      await h.host.document.undo();

      expect(work.mutations).toEqual([{ op: "pathfinderFaces", ops: 1 }]);
      // The element lane stays armed until the drag has collected its
      // first face — the press and the first move — and not after.
      // As found: 201, one per sample for the whole drag.
      expect(work.count("document.hitTest")).toBe(2);
      // The enumeration, plus a point query for each of the two samples
      // that arrive before it lands (a drag collects EVERY sample).
      expect(work.count("document.planarRegions")).toBe(3);
      // One transform read for all three. Was 3, one per query.
      expect(work.count("document.pathAnchors")).toBe(1);
    });

    it("drag with nothing selected: the element lane still hit-tests every move", async () => {
      const work = await drag([], "paced");
      await h.host.document.undo();

      expect(work.mutations).toEqual([{ op: "pathfinderBoolean", ops: 1 }]);
      // The element lane finds its operands by hit-testing: one on the
      // press and one per move. That is this lane's whole input, so it
      // stays — TARGET: one marquee-style query per drag instead.
      expect(work.count("document.hitTest")).toBe(201);
    });
  });
});

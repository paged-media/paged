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

// PERF BUDGETS — the pointer tools that READ the document as they move:
// the two region tools on the arrangements the small fixtures cannot
// reach, and the Measure tool on a long path. The rules are in
// `perf-budgets.spec.ts` and bind here too: a budget is a COUNT, it is
// the MEASURED value, it is only ever lowered, and every scenario says
// which expensive path it exercises.
//
// THE DOCUMENT is the gesture workload (`./workload.ts`), 518 leaves:
// 500 plain shapes, a 12-input arrangement of 133 faces (the largest the
// engine enumerates), a two-input pair of ~300 faces (past its 256-face
// cap), a 1 000-anchor comb and a 10 000-anchor spiral.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type {
  ElementId,
  MutationInput,
  ToolPreviewShape,
} from "@paged-media/plugin-api";
import { pointInAnchorPath, type AnchorTriple } from "@paged-media/draw-geometry";
import type { MeasureReadout } from "@paged-media/draw-tools";

import {
  BIND_LIVE_PAINT_FACE,
  BIND_MEASURE_READOUT,
  applyMakeLivePaintGroup,
  createLivePaintBucketHandler,
  createMeasureHandler,
  createShapeBuilderHandler,
  frameTransformMutationFor,
  nearestPathPointOnPage,
} from "../../src";
import {
  BUDGET_TIMEOUT_MS,
  countingHost,
  report,
  type WorkLog,
} from "./counting-host";
import {
  drive,
  linePoints,
  pointerAt,
  settle,
  type Pacing,
  type Pt,
} from "./pointer-stream";
import {
  ARRANGEMENT_INPUTS,
  COMB_BODY_POINT,
  FACE_CAP_ANCHORS,
  FACE_CAP_SWEEP,
  buildGestureWorkload,
  leafIds,
  restoreParts,
  snapshotParts,
  spiralEnd,
  undoMark,
  undoStepsSince,
  type Workload,
} from "./workload";

vi.setConfig({ testTimeout: BUDGET_TIMEOUT_MS });

describe("perf budgets — the tools that read as they move", () => {
  let w: Workload;

  beforeAll(async () => {
    w = await buildGestureWorkload();
    // Nothing was refused, so every count below is over the document
    // the workload describes — not over a shorter one. Five batches.
    expect(w.refusals).toEqual([]);
    expect(w.batches).toBe(5);
    expect(await leafIds(w.h)).toHaveLength(518);
  }, 120_000);
  afterAll(() => w?.h.dispose());

  // COVERS: the FACE-CAP lane of `handlers/planar-regions.ts`. Two
  // inputs that divide into ~300 faces: the engine refuses to enumerate
  // past 256, the cache can never warm, and the hover is left with the
  // point query.
  //
  // History (a budget only goes DOWN):
  //
  //                         pathAnchors   anchors read
  //   as found   paced          101          20 200
  //              burst            3             600
  //   now        either           1             200
  //
  // As found, every point query re-read the frontmost input's whole
  // anchor table to learn the one matrix that maps the pointer into the
  // arrangement's space. It is read once per gesture scope now, and
  // dropped with the cache.
  describe("Shape Builder — a 100-move hover over an arrangement past the 256-face cap", () => {
    const MOVES = 100;

    /** The highlight standing when a stream ended must be the face UNDER
     *  the pointer: an outline that contains the last point. A stale
     *  face (an old answer delivered late) or a face found through the
     *  wrong transform does not. */
    const expectFaceUnder = (highlight: ToolPreviewShape | null, point: Pt): void => {
      const anchors = (highlight as { anchors?: AnchorTriple[] } | null)?.anchors;
      expect(anchors, "the hover ends over a face").toBeDefined();
      expect(pointInAnchorPath(point, anchors!)).toBe(true);
    };

    const hover = async (
      pacing: Pacing,
    ): Promise<{ work: WorkLog; highlight: ToolPreviewShape | null }> => {
      await w.h.host.selection.set(w.faceCap);
      const { host, work } = countingHost(w.h.host);
      const handler = createShapeBuilderHandler(host);
      handler.onActivate(undefined as never);
      await settle();
      work.reset();
      await drive(
        linePoints(FACE_CAP_SWEEP[0], FACE_CAP_SWEEP[1], MOVES).map((p) =>
          pointerAt(w.pageId, p),
        ),
        (e) => handler.onPointerMove(e),
        pacing,
      );
      const counted = work.snapshot();
      const highlight = w.h.lastToolPreview();
      handler.onDeactivate("switch" as never);
      await w.h.host.selection.set([]);
      report(`shape builder face cap, ${pacing}`, counted);
      return { work: counted, highlight };
    };

    it("the scenario is what it says: the engine refuses the enumeration, in its own words", async () => {
      expect(w.faceCap).toHaveLength(2);
      const refused = await w.h.host.document.planarRegions(w.faceCap);
      expect(refused.found).toBe(false);
      expect(refused.reason).toBe(
        "planar arrangement resolved more than 256 faces; refine the selection",
      );
    });

    it("paced: the engine keeps up, so every move is a point query — and the transform is read once", async () => {
      const { work, highlight } = await hover("paced");
      expect(work.mutations).toEqual([]);
      expect(work.count("document.hitTest")).toBe(0);

      // One refused enumeration, then a point query per move: with no
      // face list to test against locally, that is what a hover over
      // this arrangement costs. The floor, short of an engine change.
      expect(work.count("document.planarRegions")).toBe(101);
      // As found: 101 — the frontmost input's anchor table, re-read for
      // every query, to learn a transform that cannot change mid-hover.
      expect(work.count("document.pathAnchors")).toBe(1);
      // As found: 101 × the comb's 200 anchors, for one matrix.
      expect(work.anchorsRead).toBe(FACE_CAP_ANCHORS);
      // The machine's publish, then the answer's. TARGET 100.
      expect(work.previews()).toBe(200);

      expectFaceUnder(highlight, FACE_CAP_SWEEP[1]);
    });

    it("burst: the newest-wins guard holds here too — three queries, not a hundred", async () => {
      const { work, highlight } = await hover("burst");
      expect(work.mutations).toEqual([]);
      expect(work.count("document.hitTest")).toBe(0);

      // The refused enumeration, the first sample, the last one. As
      // found on 01603ab, before the guard: 101.
      expect(work.count("document.planarRegions")).toBe(3);
      // As found: 3, one table read per query.
      expect(work.count("document.pathAnchors")).toBe(1);
      expect(work.anchorsRead).toBe(FACE_CAP_ANCHORS);
      expect(work.previews()).toBe(101);

      expectFaceUnder(highlight, FACE_CAP_SWEEP[1]);
    });

    // "Once per scope" is only safe if the scope ENDS when the matrix can
    // change. Every workload path sits at the identity, where a stale
    // transform and a fresh one are the same thing — so move both inputs
    // (one shift, so the arrangement itself is unchanged) while the tool
    // is active, and hover where they went. A cache that outlived the
    // edit maps the pointer through the OLD matrix and finds the face
    // under somewhere else.
    it("a document change ends the scope: the transform is read again, and the face is the one under the pointer", async () => {
      const SHIFT: Pt = [40, 30];
      const sweep = linePoints(FACE_CAP_SWEEP[0], FACE_CAP_SWEEP[1], 10);
      const shifted = sweep.map((p): Pt => [p[0] + SHIFT[0], p[1] + SHIFT[1]]);

      await w.h.host.selection.set(w.faceCap);
      const mark = await undoMark(w);
      const { host, work } = countingHost(w.h.host);
      const handler = createShapeBuilderHandler(host);
      handler.onActivate(undefined as never);
      await settle();
      work.reset();
      try {
        const over = (points: readonly Pt[]) =>
          drive(
            points.map((p) => pointerAt(w.pageId, p)),
            (e) => handler.onPointerMove(e),
            "paced",
          );

        await over(sweep);
        expect(work.count("document.pathAnchors")).toBe(1);
        expectFaceUnder(w.h.lastToolPreview(), sweep[sweep.length - 1]!);

        const moved = await w.h.host.document.mutate({
          op: "batch",
          args: {
            ops: w.faceCap.map((id) =>
              frameTransformMutationFor(id, [1, 0, 0, 1, SHIFT[0], SHIFT[1]]),
            ),
          },
        } as MutationInput);
        expect(moved.applied).toBe(true);
        await settle();

        await over(shifted);
        // The face first: it is what a stale matrix gets WRONG. (Checked
        // by breaking it — with `drop()` keeping the transform, this is
        // the line that fails.)
        expectFaceUnder(w.h.lastToolPreview(), shifted[shifted.length - 1]!);
        // Read again — once — for the new scope.
        expect(work.count("document.pathAnchors")).toBe(2);
      } finally {
        handler.onDeactivate("switch" as never);
        await w.h.host.selection.set([]);
        expect(await undoStepsSince(w, mark)).toBe(1);
      }
    });
  });

  // COVERS: `handlers/live-paint.ts` over the largest arrangement the
  // engine will enumerate — 12 inputs, 133 faces — and the bucket's
  // click, which is `fillLivePaintFaces`: a link walk of the whole
  // document, the arrangement derived again, a tree diff, two batches.
  describe("Live Paint bucket — a 200-move hover across a 12-input arrangement, and a click", () => {
    const MOVES = 200;

    beforeAll(async () => {
      await w.h.host.selection.set(w.arrangement);
      const group = await applyMakeLivePaintGroup(w.h.host, { name: "Perf" });
      expect(group?.inputs).toHaveLength(ARRANGEMENT_INPUTS);
      await w.h.host.selection.set([]);
    });

    /** A bucket with one member selected (the tool resolves its group
     *  from it), activated and settled. */
    const arm = async (): Promise<{
      handler: ReturnType<typeof createLivePaintBucketHandler>;
      work: WorkLog;
    }> => {
      await w.h.host.selection.set([w.arrangement[0]!]);
      const { host, work } = countingHost(w.h.host);
      const handler = createLivePaintBucketHandler(host);
      handler.onActivate(undefined as never);
      await settle();
      work.reset();
      return { handler, work };
    };

    /** A hover from the top-left corner, across the arrangement, to
     *  `to`. What it left standing — the overlay highlight and the
     *  hovered-face binding — is read before the teardown clears them. */
    const hover = async (
      pacing: Pacing,
      to: Pt = [280, 276],
      moves = MOVES,
    ): Promise<{
      work: WorkLog;
      highlight: ToolPreviewShape | null;
      hovered: unknown;
    }> => {
      const { handler, work } = await arm();
      await drive(
        linePoints([15, 11], to, moves).map((p) => pointerAt(w.pageId, p)),
        (e) => handler.onPointerMove(e),
        pacing,
      );
      const counted = work.snapshot();
      const highlight = w.h.lastToolPreview();
      const hovered = w.h.host.bindings.get(BIND_LIVE_PAINT_FACE);
      handler.onDeactivate("switch" as never);
      await w.h.host.selection.set([]);
      report(`live paint hover, ${pacing}`, counted);
      return { work: counted, highlight, hovered };
    };

    it("the arrangement is the largest the engine enumerates: 12 inputs, 133 faces", async () => {
      const all = await w.h.host.document.planarRegions(w.arrangement);
      expect(all.found).toBe(true);
      expect(all.complete).toBe(true);
      expect(all.faces).toHaveLength(133);
    });

    // SUSPICION CONFIRMED, AND ALREADY FIXED. Measured on 01603ab, where
    // this file was started, the burst asked for this 12-input
    // arrangement 201 times (and read the frontmost table 201 times,
    // published 401 previews). 39f923d gave the shared seam a
    // newest-wins guard for hovers; the same stream is now the cold-cache
    // floor at either pacing, so the two cases are pinned as one.
    //
    // pathAnchors since then: 2 → 1. The enumeration and the cold-start
    // point query each read the frontmost table for its transform; they
    // share one read now (`frontmostTransform` in planar-regions.ts).
    for (const pacing of ["paced", "burst"] as const) {
      it(`hover, ${pacing}: one enumeration, one cold-start point query, nothing per move`, async () => {
        const { work, highlight, hovered } = await hover(pacing);
        expect(work.mutations).toEqual([]);
        expect(work.count("document.hitTest")).toBe(0);
        expect(work.count("document.planarRegions")).toBe(2);
        expect(work.count("document.pathAnchors")).toBe(1);
        // One preview and one binding publish per move, plus the one the
        // arrangement landing adds. Fine as it is.
        expect(work.previews()).toBe(201);
        expect(work.count("bindings.publish")).toBe(201);

        // The stream ends OFF the arrangement, so nothing may be left
        // highlighted — a late answer for an earlier point would be.
        expect(highlight).toBeNull();
        expect(hovered).toBeNull();
      });

      it(`hover, ${pacing}, ending ON the arrangement: the face under the pointer is the one highlighted`, async () => {
        const END: Pt = [100, 100];
        const { work, highlight, hovered } = await hover(pacing, END, 40);
        expect(work.count("document.pathAnchors")).toBe(1);
        const anchors = (highlight as { anchors?: AnchorTriple[] } | null)?.anchors;
        expect(anchors, "the hover ends over a face").toBeDefined();
        expect(pointInAnchorPath(END, anchors!)).toBe(true);
        // …and it is the face the engine itself names at that point.
        const asked = await w.h.host.document.planarRegions(w.arrangement, END);
        expect(asked.faces).toHaveLength(1);
        expect(hovered).toBe(asked.faces[0]!.id);
      });
    }

    it("a click paints one face — and walks the whole document to do it", async () => {
      const parts = await snapshotParts(w.h);
      const mark = await undoMark(w);
      const { handler, work } = await arm();
      const at = pointerAt(w.pageId, [100, 100]);
      handler.onPointerDown(at);
      await settle();
      handler.onPointerUp(at);
      await settle();
      const counted = work.snapshot();
      handler.onDeactivate("switch" as never);
      const undoSteps = await undoStepsSince(w, mark);
      await restoreParts(w.h, parts);
      await w.h.host.selection.set([]);
      report("live paint click", counted, { undoSteps });

      // Insert, bind, fill, stroke, face link: ONE batch since the fill
      // lane names what it inserts (`livePaintBatchFor`). As found: TWO
      // batches (1, then 3) and 2 undo steps.
      expect(counted.mutations).toEqual([{ op: "batch", ops: 5 }]);
      expect(undoSteps).toBe(1);
      // LINK DISCOVERY: one metadata read for every leaf of the document
      // — 518 of them, 12 of which belong to this group — looking for a
      // stale fill of this face. There is none. TARGET 0: the recipe can
      // name its own fills.
      //
      // 517 since the walk moved to the shared link index
      // (`src/link-index.ts`): the member the tool resolved its group
      // from when it was ARMED is read once per document revision, and
      // the click's walk does not read it again. As found: 518. (A
      // second click on an unchanged document would read none — but a
      // click changes it.)
      expect(counted.count("document.getMetadata")).toBe(517);
      // The link walk's tree. What the batch created comes off the
      // engine's reply (`commands/minted.ts`). As found: 3 — one either
      // side of the insert on top. TARGET 0.
      expect(counted.count("document.tree")).toBe(1);
      // The press asks twice (point query + enumeration); the commit
      // then derives the same arrangement a third time. TARGET 2.
      expect(counted.count("document.planarRegions")).toBe(3);
    });
  });

  // COVERS: `handlers/measure.ts` — the origin snap goes through the raw
  // `editor.client.send` escape hatch, and needs the hit path's
  // transform to ask it.
  //
  // History (a budget only goes DOWN):
  //
  //                         pathAnchors   anchors read
  //   as found   spiral          1           10 000
  //              comb            1            1 000
  //   now        either          0                0
  //
  // As found, the snap read the hit path's WHOLE anchor table to learn
  // one matrix. The hit-test reply the handler has just received carries
  // that matrix, so the table is no longer read.
  describe("Measure — one 200-move drag that starts on a long path", () => {
    const MOVES = 200;
    const TO: Pt = [560, 700];
    /** The spiral's centre (`workload.ts`); a rotation about it keeps
     *  the spiral where it is on the page. */
    const SPIRAL_CENTRE: Pt = [105, 395];
    /** How far off the path the spiral measurements start, in pt. */
    const OFF_PATH = 1.5;
    /** `p`, moved `OFF_PATH` towards the spiral's centre. The spiral's
     *  end is the outermost point of its bounding box and the hit-test
     *  is a box test, so "beside the end" has to mean INSIDE it. */
    const inward = (p: Pt): Pt => {
      const dx = SPIRAL_CENTRE[0] - p[0];
      const dy = SPIRAL_CENTRE[1] - p[1];
      const d = Math.hypot(dx, dy);
      return [p[0] + (dx / d) * OFF_PATH, p[1] + (dy / d) * OFF_PATH];
    };

    const measure = async (
      scenario: string,
      from: Pt,
    ): Promise<{ work: WorkLog; readout: MeasureReadout }> => {
      await w.h.host.selection.set([]);
      const { host, work } = countingHost(w.h.host);
      const handler = createMeasureHandler(host);
      handler.onActivate(undefined as never);
      work.reset();
      handler.onPointerDown(pointerAt(w.pageId, from));
      await drive(
        linePoints(from, TO, MOVES).map((p) => pointerAt(w.pageId, p)),
        (e) => handler.onPointerMove(e),
        "burst",
      );
      handler.onPointerUp(pointerAt(w.pageId, TO));
      await settle();
      const counted = work.snapshot();
      // Read before the teardown deletes it.
      const readout = w.h.host.bindings.get(BIND_MEASURE_READOUT) as MeasureReadout;
      handler.onDeactivate("switch" as never);
      report(scenario, counted);
      return { work: counted, readout };
    };

    /** Where the snap SHOULD put the origin: the same request, asked the
     *  way it was before — with the transform read off the element's own
     *  anchor table rather than taken from the hit. The frozen readout
     *  must start exactly there. A transform taken from the wrong place
     *  (or composed differently) moves `from`, and only this sees it. */
    const snapByTable = async (
      element: ElementId,
      from: Pt,
    ): Promise<[number, number]> => {
      const snapped = await nearestPathPointOnPage(
        w.h.host,
        element,
        from,
        w.h.host.viewport.pxToPt(8),
      );
      expect(snapped, "the origin is within snap range of the path").not.toBeNull();
      return snapped!;
    };

    it("from the 10 000-anchor spiral", async () => {
      // Beside the path's end, not on it: near enough to snap, far
      // enough that a snapped origin is visibly not the raw one.
      const from = inward(spiralEnd());
      const { work, readout } = await measure("measure from spiral", from);
      expect(work.mutations).toEqual([]);

      // SUSPICION WRONG: the raw send is ONE per drag — the origin snap
      // on pointer-down — not one per move. Nothing to lower.
      expect(work.count("editor.client.send")).toBe(1);
      expect(work.count("editor.client.send:requestNearestPathPoint")).toBe(1);
      expect(work.count("document.hitTest")).toBe(1);
      // As found: 1 table read, 10 000 anchors, for a transform the
      // hit-test reply already carried.
      expect(work.count("document.pathAnchors")).toBe(0);
      expect(work.anchorsRead).toBe(0);
      // One preview and one readout publish per pointer event (the snap
      // landing adds one). Fine as it is.
      expect(work.previews()).toBe(203);
      expect(work.count("bindings.publish")).toBe(203);

      // The measurement starts ON the path, where the table-reading snap
      // puts it, and ends where the pointer lifted.
      const snapped = await snapByTable(w.spiral!, from);
      expect(readout.from).toEqual(snapped);
      expect(readout.from).not.toEqual(from);
      expect(readout.to).toEqual(TO);
    });

    it("from the 1 000-anchor comb: the same drag, and nothing read here either", async () => {
      const { work, readout } = await measure("measure from comb", COMB_BODY_POINT);
      expect(work.count("editor.client.send")).toBe(1);
      // As found: 1 read, 1 000 anchors — the read scaled with the path;
      // what the tool needs from it never did.
      expect(work.count("document.pathAnchors")).toBe(0);
      expect(work.anchorsRead).toBe(0);
      expect(readout.from).toEqual(await snapByTable(w.comb!, COMB_BODY_POINT));
    });

    // Every workload path sits at the identity, where a wrong transform
    // and no transform are the same thing. So: turn the spiral 20° about
    // its own centre and measure from where its end has MOVED to. The
    // snap must use the transform the hit reported.
    it("a ROTATED path: the snap uses the transform the hit-test reported", async () => {
      const mark = await undoMark(w);
      try {
        const [cx, cy] = SPIRAL_CENTRE;
        const a = (20 * Math.PI) / 180;
        const [cos, sin] = [Math.cos(a), Math.sin(a)];
        const turn: [number, number, number, number, number, number] = [
          cos,
          sin,
          -sin,
          cos,
          cx - (cos * cx - sin * cy),
          cy - (sin * cx + cos * cy),
        ];
        const turned = await w.h.host.document.mutate(
          frameTransformMutationFor(w.spiral!, turn),
        );
        expect(turned.applied).toBe(true);

        const end = spiralEnd();
        const moved: Pt = [
          turn[0] * end[0] + turn[2] * end[1] + turn[4],
          turn[1] * end[0] + turn[3] * end[1] + turn[5],
        ];
        // The end really is somewhere else now (≈ 29 pt away).
        expect(Math.hypot(moved[0] - end[0], moved[1] - end[1])).toBeGreaterThan(20);
        const from = inward(moved);

        const { work, readout } = await measure("measure from rotated spiral", from);
        expect(work.count("document.hitTest")).toBe(1);
        expect(work.count("document.pathAnchors")).toBe(0);
        expect(work.anchorsRead).toBe(0);

        const snapped = await snapByTable(w.spiral!, from);
        expect(readout.from).toEqual(snapped);
        // On the rotated path: within the offset of where its end went.
        expect(Math.hypot(snapped[0] - moved[0], snapped[1] - moved[1])).toBeLessThan(2 * OFF_PATH);
        expect(readout.from).not.toEqual(from);
      } finally {
        expect(await undoStepsSince(w, mark)).toBe(1);
      }
      expect(await leafIds(w.h)).toHaveLength(518);
    });
  });
});

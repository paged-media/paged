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

// PERF BUDGETS — the freehand tools (pencil, paintbrush, blob brush,
// eraser, lasso). The rules are in `perf-budgets.spec.ts` and bind here
// too: a budget is a COUNT, it is the MEASURED value, it is only ever
// lowered, and every scenario says which expensive path it exercises.
//
// What these tools cost is not the engine — a stroke in flight never
// reads the document. It is the OVERLAY, and that cost has two halves
// which are counted separately because only one of them is the
// handler's to remove:
//
//   · what the handler BUILDS to hand over (`built`, measured here) —
//     as found, every move re-mapped the whole sample array into a fresh
//     shape: S arrays and S²/2 points for a stroke of S samples;
//   · what CROSSES the door (`work.previewPoints`) — the length of every
//     shape published. The door holds one whole shape, so this stays
//     S²/2 however the handler builds it.
//
// The commit is the other half: how many mutations one lift issues, and
// how many undo steps it leaves behind — measured separately, because
// they turned out not to be the same number.
//
// THE DOCUMENT is the gesture workload (`./workload.ts`): 518 leaves.
// The in-flight budgets do not depend on it — and say so, by asserting
// zero reads — the lasso's release and the commits do.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type {
  BundleHost,
  ElementId,
  GestureHandler,
  ToolPreviewShape,
} from "@paged-media/plugin-api";

import {
  createBlobBrushHandler,
  createEraserBrushHandler,
  createLassoSelectHandler,
  createPaintbrushHandler,
  createPencilHandler,
} from "../../src";
import {
  BUDGET_TIMEOUT_MS,
  countingHost,
  report,
  type WorkLog,
} from "./counting-host";
import {
  drive,
  jitteredFreehand,
  linePoints,
  pointerAt,
  settle,
  spiralPoints,
  type FreehandSample,
  type Pacing,
  type Pt,
} from "./pointer-stream";
import {
  buildGestureWorkload,
  leafIds,
  undoMark,
  undoStepsSince,
  type Workload,
} from "./workload";

type MakeHandler = (host: BundleHost) => GestureHandler;

const SWEEP_TOOLS: Record<string, MakeHandler> = {
  pencil: createPencilHandler,
  paintbrush: createPaintbrushHandler,
  blobBrush: createBlobBrushHandler,
  eraser: createEraserBrushHandler,
};

const mouse = (points: readonly Pt[]): FreehandSample[] =>
  points.map((point) => ({ point, pressure: 0.5 }));

/** The stroke the preview budgets draw: a six-turn spiral filling the
 *  page. Its tightest gap is 0.75 pt at 2 000 samples — over the
 *  machines' 0.5 pt decimation floor, so EVERY sample is kept and the
 *  count is the clean S²/2. */
const spiral = (samples: number): FreehandSample[] =>
  mouse(spiralPoints([306, 396], { from: 40, to: 280 }, 6, samples));

/** The lasso's spiral: its floor is 3 px, so this one starts wider
 *  (tightest gap 3.02 pt at 2 000 samples). */
const lassoSpiral = (samples: number): FreehandSample[] =>
  mouse(spiralPoints([306, 396], { from: 120, to: 290 }, 8, samples));

/** A pen stroke: jittered, unevenly spaced, pressure on every sample. */
const penStroke = (samples: number): FreehandSample[] =>
  jitteredFreehand([40, 560], [570, 620], samples);

/** The samples a decimation floor KEEPS: the first, then every one at
 *  least `floor` from the last one kept. Written out here rather than
 *  asked of the machine — it is what the preview is checked AGAINST. */
const keptAbove = (samples: readonly FreehandSample[], floor: number): Pt[] => {
  const kept: Pt[] = [samples[0]!.point];
  for (const { point } of samples.slice(1)) {
    const last = kept[kept.length - 1]!;
    if (Math.hypot(point[0] - last[0], point[1] - last[1]) >= floor) {
      kept.push(point);
    }
  }
  return kept;
};

/** The sweep machines' decimation floor (`pencil-machine.ts`), in pt. */
const SWEEP_FLOOR_PT = 0.5;

/** How many of `penStroke(2000)`'s samples that floor keeps. */
const KEPT_OF_2000 = 1860;
/** 2 + 3 + … + KEPT_OF_2000: what its preview hands across the door. */
const PEN_2000_PREVIEW_POINTS = 1_730_729;

vi.setConfig({ testTimeout: BUDGET_TIMEOUT_MS });

describe("perf budgets — the freehand tools", () => {
  let w: Workload;

  beforeAll(async () => {
    w = await buildGestureWorkload();
    // Nothing was refused, so every count below is over the document
    // the workload describes — not over a shorter one.
    expect(w.refusals).toEqual([]);
    expect(await leafIds(w.h)).toHaveLength(518);
  }, 120_000);
  afterAll(() => w?.h.dispose());

  /** Pointer-down on the first sample, one move per remaining sample.
   *  `afterEach` runs after every delivered event, the pointer-down
   *  included. */
  const draw = async (
    handler: GestureHandler,
    samples: readonly FreehandSample[],
    pacing: Pacing,
    afterEach: () => void = () => {},
  ): Promise<void> => {
    const at = (s: FreehandSample) =>
      pointerAt(w.pageId, s.point, { pressure: s.pressure });
    handler.onPointerDown(at(samples[0]!));
    afterEach();
    await drive(
      samples.slice(1).map(at),
      (e) => {
        handler.onPointerMove(e);
        afterEach();
      },
      pacing,
    );
  };

  /** What the handler BUILT for the overlay over one stroke — the half
   *  of the preview cost `work.previewPoints` cannot see. That counter
   *  is what crosses the door (the length of every shape handed over);
   *  this one is what was allocated to hand over: a point counts once
   *  per ARRAY it was written into. A handler that re-maps the stroke
   *  per move builds S²/2 points in S arrays; one that appends builds S
   *  points in one.
   *
   *  Read off the harness after every event (`lastToolPreview` hands
   *  back the very object the handler published), so it sees the last
   *  publish of each event — and these handlers publish at most once. */
  interface Built {
    arrays: number;
    points: number;
  }
  const builtMeter = (): { built: Built; look: () => void } => {
    const seen = new Map<object, number>();
    const built: Built = { arrays: 0, points: 0 };
    return {
      built,
      look() {
        const shape = w.h.lastToolPreview() as
          | { points?: readonly unknown[]; anchors?: readonly unknown[] }
          | null;
        const list = shape?.points ?? shape?.anchors;
        if (!list) return;
        const had = seen.get(list);
        if (had === undefined) built.arrays += 1;
        if (list.length > (had ?? 0)) built.points += list.length - (had ?? 0);
        seen.set(list, list.length);
      },
    };
  };

  interface InFlight {
    work: WorkLog;
    built: Built;
    /** The preview standing when the last move had been delivered. */
    preview: ToolPreviewShape | null;
  }

  /** What a stroke costs WHILE IT IS IN FLIGHT: everything from the
   *  pointer-down to the last move. Cancelled, so nothing is committed
   *  and the document stays as built. */
  const inFlight = async (
    scenario: string,
    make: MakeHandler,
    samples: readonly FreehandSample[],
    pacing: Pacing = "burst",
  ): Promise<InFlight> => {
    await w.h.host.selection.set([]);
    const { host, work } = countingHost(w.h.host);
    const handler = make(host);
    handler.onActivate(undefined as never);
    work.reset();
    const meter = builtMeter();
    await draw(handler, samples, pacing, meter.look);
    const counted = work.snapshot();
    const preview = w.h.lastToolPreview();
    handler.onKey?.({ key: "Escape" } as KeyboardEvent);
    handler.onDeactivate("switch" as never);
    report(scenario, counted, { built: meter.built });
    return { work: counted, built: meter.built, preview };
  };

  /** What the LIFT costs: everything from pointer-up until the commit
   *  chain has landed, plus the undo steps it left — measured against
   *  the undo log, not inferred. The document is put back afterwards. */
  const lift = async (
    scenario: string,
    make: MakeHandler,
    samples: readonly FreehandSample[],
    selection: ElementId[],
  ): Promise<{ work: WorkLog; undoSteps: number }> => {
    await w.h.host.selection.set(selection);
    const mark = await undoMark(w);
    const { host, work } = countingHost(w.h.host);
    const handler = make(host);
    handler.onActivate(undefined as never);
    await draw(handler, samples, "burst");
    work.reset();
    const last = samples[samples.length - 1]!;
    handler.onPointerUp(pointerAt(w.pageId, last.point, { pressure: last.pressure }));
    await settle();
    const counted = work.snapshot();
    handler.onDeactivate("switch" as never);
    const undoSteps = await undoStepsSince(w, mark);
    report(scenario, counted, { undoSteps });
    return { work: counted, undoSteps };
  };

  // COVERS: `handlers/stroke-preview.ts`, which the preview `sync()` in
  // `handlers/pencil.ts` and `createSweepHandler` in `handlers/brush.ts`
  // both publish through.
  //
  // History (a budget only goes DOWN), identical for all four tools —
  // they share the loop:
  //
  //                      arrays built   points built   points across the door
  //   as found   500         499           125 249            125 249
  //             2 000      1 999         2 000 999          2 000 999
  //   now        500           1               500            125 249
  //             2 000          1             2 000          2 000 999
  //
  // As found, every move ran `snapshot.points.map(...)` over the WHOLE
  // stroke. Now a kept sample is copied once, into one array per stroke.
  //
  // The last column did NOT move and is pinned as it is: the overlay door
  // (`setToolPreview(shape)`) holds one whole shape, last write wins, so
  // each publish names the entire polyline. TARGET S — which needs a door
  // that can EXTEND a retained preview; no handler change reaches it.
  describe("pencil / paintbrush / blob brush / eraser — one array per stroke, each sample copied once", () => {
    /** The preview standing after the last move IS the stroke: every
     *  kept sample, in order. An append that skipped, repeated or
     *  reordered a sample — or a handler still showing an earlier
     *  stroke's array — fails here, whatever the counts say. */
    const expectWholeStroke = (preview: unknown, kept: readonly Pt[]): void => {
      expect(preview).toEqual({ pageId: w.pageId, points: kept });
    };

    it.each(Object.keys(SWEEP_TOOLS))("%s: 500 samples", async (tool) => {
      const stroke = spiral(500);
      const { work, built, preview } = await inFlight(`${tool} 500`, SWEEP_TOOLS[tool]!, stroke);
      // A stroke in flight touches the overlay and nothing else.
      expect(work.mutations).toEqual([]);
      expect(work.reads()).toBe(0);
      // One publish per pointer event, the pointer-down's empty one
      // included. Fine as it is.
      expect(work.previews()).toBe(500);
      expectWholeStroke(preview, stroke.map((s) => s.point));
      // As found: 499 arrays, 125 249 points.
      expect(built).toEqual({ arrays: 1, points: 500 });
      // 2 + 3 + … + 500: publish k names all k+1 samples. The door's
      // cost, not the handler's — see the history above. TARGET 500.
      expect(work.previewPoints).toBe(125_249);
    });

    it.each(Object.keys(SWEEP_TOOLS))("%s: 2 000 samples", async (tool) => {
      const stroke = spiral(2000);
      const { work, built, preview } = await inFlight(`${tool} 2000`, SWEEP_TOOLS[tool]!, stroke);
      expect(work.mutations).toEqual([]);
      expect(work.reads()).toBe(0);
      expect(work.previews()).toBe(2000);
      expectWholeStroke(preview, stroke.map((s) => s.point));
      // As found: 1 999 arrays, 2 000 999 points.
      expect(built).toEqual({ arrays: 1, points: 2000 });
      // 2 + 3 + … + 2 000. TARGET 2 000 (the door).
      expect(work.previewPoints).toBe(2_000_999);
    });

    it("pacing changes nothing: the handler is synchronous and waits on no reply", async () => {
      const stroke = spiral(500);
      const { work, built, preview } = await inFlight("pencil 500 paced", createPencilHandler, stroke, "paced");
      expect(work.previews()).toBe(500);
      expectWholeStroke(preview, stroke.map((s) => s.point));
      expect(built).toEqual({ arrays: 1, points: 500 });
      expect(work.previewPoints).toBe(125_249);
    });

    it("a jittered 2 000-sample pen stroke: a dropped sample publishes nothing", async () => {
      const stroke = penStroke(2000);
      const kept = keptAbove(stroke, SWEEP_FLOOR_PT);
      // The stream is what it says: jitter put samples closer together
      // than the floor, so the machine keeps fewer than it was sent.
      expect(kept).toHaveLength(KEPT_OF_2000);
      const { work, built, preview } = await inFlight("pencil pen 2000", createPencilHandler, stroke);
      // The preview is the KEPT samples — a dropped one never shows.
      expectWholeStroke(preview, kept);
      // One publish per kept sample. As found: 2 000 — the unchanged
      // stroke went out again for every sample the floor dropped.
      expect(work.previews()).toBe(KEPT_OF_2000);
      // As found: 1 999 arrays, 1 861 241 points.
      expect(built).toEqual({ arrays: 1, points: KEPT_OF_2000 });
      // 2 + 3 + … + K, K the kept count. As found 1 861 241. TARGET K
      // (the door).
      expect(work.previewPoints).toBe(PEN_2000_PREVIEW_POINTS);
      expect(PEN_2000_PREVIEW_POINTS).toBe((KEPT_OF_2000 * (KEPT_OF_2000 + 1)) / 2 - 1);
    });

    // The array handed to the overlay keeps growing while its stroke is
    // in flight. What that sharing must never do is reach PAST the
    // stroke: a second stroke appending to the first one's array would
    // draw both, and would rewrite a shape a host may still be holding.
    it.each(Object.keys(SWEEP_TOOLS))("%s: a second stroke gets its own array, and leaves the first one's alone", async (tool) => {
      await w.h.host.selection.set([]);
      const handler = SWEEP_TOOLS[tool]!(w.h.host);
      handler.onActivate(undefined as never);
      const first = spiral(50);
      const second = mouse(linePoints([40, 40], [140, 90], 30));

      await draw(handler, first, "burst");
      const firstShape = w.h.lastToolPreview() as { points: readonly Pt[] };
      handler.onKey?.({ key: "Escape" } as KeyboardEvent);
      expect(w.h.lastToolPreview()).toBeNull();

      await draw(handler, second, "burst");
      const secondShape = w.h.lastToolPreview() as { points: readonly Pt[] };
      handler.onKey?.({ key: "Escape" } as KeyboardEvent);
      handler.onDeactivate("switch" as never);

      expect(secondShape.points).toEqual(second.map((s) => s.point));
      expect(secondShape.points).not.toBe(firstShape.points);
      expect(firstShape.points).toEqual(first.map((s) => s.point));
    });
  });

  // COVERS: `preview()` in `handlers/lasso.ts` — the same stroke-long
  // outline, as cubic anchor triples — and its release: `commit()` reads
  // the scene tree and asks for the geometry of EVERY leaf.
  //
  // History of the in-flight budgets:
  //
  //                      arrays built   anchors built   anchors across the door
  //   as found   500         499           125 249            125 249
  //             2 000      1 999         2 000 999          2 000 999
  //   now        500           1               500            125 249
  //             2 000          1             2 000          2 000 999
  //
  // The door column is the sweep tools' story again and stays pinned.
  describe("lasso — the region preview and the release walk", () => {
    it.each([
      [500, 125_249],
      [2000, 2_000_999],
    ])("%i samples in flight", async (samples, previewPoints) => {
      const stroke = lassoSpiral(samples);
      const { work, built, preview } = await inFlight(`lasso ${samples}`, createLassoSelectHandler, stroke);
      expect(work.mutations).toEqual([]);
      expect(work.reads()).toBe(0);
      // No publish on pointer-down, one per move.
      expect(work.previews()).toBe(samples - 1);
      // The outline standing after the last move is the polygon the
      // release would test: every sample a corner, closed, dashed.
      expect(preview).toEqual({
        pageId: w.pageId,
        anchors: stroke.map(({ point }) => ({
          anchor: point,
          left: point,
          right: point,
        })),
        close: true,
        dashed: true,
      });
      // As found: `samples - 1` arrays, S²/2 anchors.
      expect(built).toEqual({ arrays: 1, points: samples });
      // TARGET `samples` — each point once (the door).
      expect(work.previewPoints).toBe(previewPoints);
      // The px→pt conversion is asked again on every move. TARGET 1 per
      // stroke.
      expect(work.count("viewport.pxToPt")).toBe(samples - 1);
    });

    it("the release: one tree read, one geometry call — carrying every leaf of the document", async () => {
      // A circle around most of the plain-shape grid.
      const { work } = await lift(
        "lasso release",
        createLassoSelectHandler,
        mouse(spiralPoints([454, 136], { from: 150, to: 150 }, 1, 200)),
        [],
      );
      expect(work.mutations).toEqual([]);
      expect(work.count("document.tree")).toBe(1);
      expect(work.count("document.elementGeometry")).toBe(1);
      // All 518 leaves, whatever the lasso enclosed. TARGET: the leaves
      // inside the lasso's bounding box — the engine already answers a
      // marquee query (`marqueeHits` on the wire), there is no facade.
      expect(work.geometryIdsAsked).toBe(518);
      expect(work.count("selection.set")).toBe(1);
    });
  });

  // COVERS: the commit chains — `sync()` in `handlers/pencil.ts` and
  // `insertSweptShape` / `commitBlobBrush` / `commitEraserBrush` in
  // `handlers/brush.ts`: awaited mutations in sequence, each a rebuild.
  //
  // SUSPICION CONFIRMED for the mutation count (4 + a read for one
  // paintbrush stroke) and WRONG for the undo steps: `brush.ts` says the
  // chain is "several undo steps", one per mutation, and it is not. The
  // two `setDocumentDefaults` never reach the undo log, so a paintbrush
  // stroke is TWO steps, not four. Still one more than a stroke should
  // be, and the eraser multiplies it by the selection.
  describe("the lift — mutations issued and undo steps left behind", () => {
    it("pencil, mouse: one insert, one step", async () => {
      const { work, undoSteps } = await lift("pencil lift mouse", createPencilHandler, spiral(500), []);
      expect(work.mutations.map((m) => m.op)).toEqual(["insertPath"]);
      expect(work.reads()).toBe(0);
      expect(undoSteps).toBe(1);
    });

    it("pencil, pen pressure: the insert, then a variable-width outline", async () => {
      const { work, undoSteps } = await lift("pencil lift pen", createPencilHandler, penStroke(2000), []);
      // TARGET 1 mutation and 1 undo step: a batch with `bindCreated`.
      expect(work.mutations.map((m) => m.op)).toEqual([
        "insertPath",
        "setElementProperty",
      ]);
      expect(undoSteps).toBe(2);
    });

    it("paintbrush: a read and four mutations for one stroke", async () => {
      const { work, undoSteps } = await lift("paintbrush lift", createPaintbrushHandler, spiral(500), []);
      // TARGET 1 mutation: the whole chain as one batch.
      expect(work.mutations.map((m) => m.op)).toEqual([
        "setDocumentDefaults",
        "insertPath",
        "setElementProperty",
        "setDocumentDefaults",
      ]);
      expect(work.count("document.meta")).toBe(1);
      // TARGET 1.
      expect(undoSteps).toBe(2);
    });

    it("blob brush onto a same-fill selection: the sweep, then a unite", async () => {
      const { work, undoSteps } = await lift(
        "blob lift",
        createBlobBrushHandler,
        mouse(linePoints([296, 20], [420, 60], 60)),
        [w.plain[0]!],
      );
      // TARGET 1 mutation.
      expect(work.mutations.map((m) => m.op)).toEqual([
        "setDocumentDefaults",
        "insertPath",
        "setElementProperty",
        "setDocumentDefaults",
        "pathfinderBoolean",
      ]);
      // One property read per selected element, to find the same-fill one.
      expect(work.count("document.elementProperties")).toBe(1);
      expect(work.count("document.meta")).toBe(1);
      // TARGET 1.
      expect(undoSteps).toBe(3);
    });

    it("eraser across 12 selected shapes: one sweep-and-subtract chain PER TARGET", async () => {
      const { work, undoSteps } = await lift(
        "eraser lift x12",
        createEraserBrushHandler,
        mouse(linePoints([10, 10], [270, 260], 60)),
        [...w.arrangement],
      );
      // Five mutations per selected element: defaults, insert, outline,
      // defaults, subtract. TARGET 1 — one batch for the gesture.
      expect(work.mutations).toHaveLength(60);
      expect(work.mutations.slice(0, 5).map((m) => m.op)).toEqual([
        "setDocumentDefaults",
        "insertPath",
        "outlineStroke",
        "setDocumentDefaults",
        "pathfinderBoolean",
      ]);
      // The creation defaults are re-read for every target. TARGET 1.
      expect(work.count("document.meta")).toBe(12);
      // One eraser stroke is THIRTY-SIX presses of undo. TARGET 1.
      expect(undoSteps).toBe(36);
    });
  });
});

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
// reads the document. It is the OVERLAY: each pointer move re-maps the
// whole sample array into a fresh preview shape, so a stroke of S
// samples hands the overlay S²/2 points. `work.previewPoints` is that
// number. The commit is the other half: how many mutations one lift
// issues, and how many undo steps it leaves behind — measured
// separately, because they turned out not to be the same number.
//
// THE DOCUMENT is the gesture workload (`./workload.ts`): 518 leaves.
// The in-flight budgets do not depend on it — and say so, by asserting
// zero reads — the lasso's release and the commits do.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type {
  BundleHost,
  ElementId,
  GestureHandler,
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

  /** Pointer-down on the first sample, one move per remaining sample. */
  const draw = async (
    handler: GestureHandler,
    samples: readonly FreehandSample[],
    pacing: Pacing,
  ): Promise<void> => {
    const at = (s: FreehandSample) =>
      pointerAt(w.pageId, s.point, { pressure: s.pressure });
    handler.onPointerDown(at(samples[0]!));
    await drive(samples.slice(1).map(at), (e) => handler.onPointerMove(e), pacing);
  };

  /** What a stroke costs WHILE IT IS IN FLIGHT: everything from the
   *  pointer-down to the last move. Cancelled, so nothing is committed
   *  and the document stays as built. */
  const inFlight = async (
    scenario: string,
    make: MakeHandler,
    samples: readonly FreehandSample[],
    pacing: Pacing = "burst",
  ): Promise<WorkLog> => {
    await w.h.host.selection.set([]);
    const { host, work } = countingHost(w.h.host);
    const handler = make(host);
    handler.onActivate(undefined as never);
    work.reset();
    await draw(handler, samples, pacing);
    const counted = work.snapshot();
    handler.onKey?.({ key: "Escape" } as KeyboardEvent);
    handler.onDeactivate("switch" as never);
    return report(scenario, counted);
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

  // COVERS: `sync()` in `handlers/pencil.ts` and `createSweepHandler` in
  // `handlers/brush.ts` — `snapshot.points.map(...)` over the WHOLE
  // stroke, into a fresh preview, on every pointer move.
  //
  // SUSPICION CONFIRMED, for all four tools and identically: they share
  // the loop. 500 samples hand the overlay 125 249 points, 2 000 hand it
  // 2 000 999 — four times the stroke, sixteen times the work.
  describe("pencil / paintbrush / blob brush / eraser — the preview re-sends the whole stroke per move", () => {
    it.each(Object.keys(SWEEP_TOOLS))("%s: 500 samples", async (tool) => {
      const work = await inFlight(`${tool} 500`, SWEEP_TOOLS[tool]!, spiral(500));
      // A stroke in flight touches the overlay and nothing else.
      expect(work.mutations).toEqual([]);
      expect(work.reads()).toBe(0);
      // One publish per pointer event, the pointer-down's empty one
      // included. Fine as it is.
      expect(work.previews()).toBe(500);
      // 2 + 3 + … + 500: move k re-sends all k+1 samples.
      // TARGET 500 — each sample crosses the overlay door once.
      expect(work.previewPoints).toBe(125_249);
    });

    it.each(Object.keys(SWEEP_TOOLS))("%s: 2 000 samples", async (tool) => {
      const work = await inFlight(`${tool} 2000`, SWEEP_TOOLS[tool]!, spiral(2000));
      expect(work.mutations).toEqual([]);
      expect(work.reads()).toBe(0);
      expect(work.previews()).toBe(2000);
      // 2 + 3 + … + 2 000. TARGET 2 000.
      expect(work.previewPoints).toBe(2_000_999);
    });

    it("pacing changes nothing: the handler is synchronous and waits on no reply", async () => {
      const work = await inFlight("pencil 500 paced", createPencilHandler, spiral(500), "paced");
      expect(work.previews()).toBe(500);
      expect(work.previewPoints).toBe(125_249);
    });

    it("a jittered 2 000-sample pen stroke: dropped samples are still re-published", async () => {
      const work = await inFlight("pencil pen 2000", createPencilHandler, penStroke(2000));
      // The 0.5 pt floor drops the samples jitter put too close together
      // — and the handler publishes the unchanged stroke again for every
      // one of them. TARGET: one publish per KEPT sample.
      expect(work.previews()).toBe(2000);
      // Under 2 000 999 only because fewer samples were kept; the growth
      // is the same. TARGET: the kept sample count.
      expect(work.previewPoints).toBe(1_861_241);
    });
  });

  // COVERS: `preview()` in `handlers/lasso.ts` — the same whole-array
  // re-map, as cubic anchor triples — and its release: `commit()` reads
  // the scene tree and asks for the geometry of EVERY leaf.
  //
  // SUSPICION CONFIRMED for the preview (the same quadratic), and the
  // release is one call but not a small one: it carries all 518 ids.
  describe("lasso — the region preview and the release walk", () => {
    it.each([
      [500, 125_249],
      [2000, 2_000_999],
    ])("%i samples in flight", async (samples, previewPoints) => {
      const work = await inFlight(`lasso ${samples}`, createLassoSelectHandler, lassoSpiral(samples));
      expect(work.mutations).toEqual([]);
      expect(work.reads()).toBe(0);
      // No publish on pointer-down, one per move.
      expect(work.previews()).toBe(samples - 1);
      // TARGET `samples` — each point once.
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

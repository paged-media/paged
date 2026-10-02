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

// PERF BUDGETS — the COMMANDS, over a busy document. The rules are in
// `perf-budgets.spec.ts` and bind here too: a budget is a COUNT, it is
// the MEASURED value, it is only ever lowered, and every scenario says
// which expensive path it exercises.
//
// THE DOCUMENT is the linked workload (`./workload.ts`): 1 403 leaves —
// 500 plain shapes, the fixture's 2, and 50 records each of blend,
// repeat, pattern, symbol instance, objects-on-path and live paint,
// every one built by the bundle's own command. A command here acts on
// ONE record of ONE feature, which owns one to five of those leaves.
//
// Two paths are measured, and both turn out to cost the DOCUMENT, not
// the record:
//
//  · LINK DISCOVERY. A feature finds its records by reading the plugin
//    metadata of every leaf in the document — one `getMetadata` round
//    trip each — and keeping the ones that carry its key. Six features,
//    six copies of the same loop (`blendLinks`, `repeatLinks`,
//    `patternLinks`, `livePaintLinks`, `objectsOnPathLinks`,
//    `symbolInstances`), each blind to the other five's leaves and to
//    the 500 that belong to nobody.
//  · "WHAT DID THIS BATCH CREATE". A batch outcome carries one
//    `createdId`, so a flow that inserts several paths reads the whole
//    scene tree before the batch and again after it, and diffs.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { BundleHost, ElementId } from "@paged-media/plugin-api";

import {
  applyEditPattern,
  applyFillLivePaintFace,
  applyImageTracePlan,
  applyMakeBlend,
  applyMakeCompoundPath,
  applyMakePattern,
  applyMakeRepeat,
  applyPlaceSymbolInstance,
  applyRedefineSymbol,
  applyRegenerateLivePaint,
  applyReleaseCompoundPath,
  applyResetSymbolTransform,
  applySelectBlendObjects,
  applySelectLivePaintFaces,
  applySelectObjectsOnPath,
  applySelectPatternTiles,
  applySelectRepeatInstances,
  applyUpdateBlend,
  applyUpdateObjectsOnPath,
  applyUpdateRepeat,
  bakeAppearance,
  bootTraceEngine,
  commitAppearance,
  pixelToPageAffine,
  selectSameMatches,
  symbolInstances,
  tracePlanFor,
  TRACE_DEFAULTS,
  type AppearanceStack,
} from "../../src";
import { F7_PLACED_IMAGE, ringPixels } from "../fixtures/corpus";
import {
  BUDGET_TIMEOUT_MS,
  countingHost,
  report,
  type WorkLog,
} from "./counting-host";
import {
  addPlainShapes,
  buildLinkedWorkload,
  cellOrigin,
  leafIds,
  openWorkload,
  restoreParts,
  snapshotParts,
  undoMark,
  undoStepsSince,
  type LinkedFeature,
  type Workload,
} from "./workload";

/** Which record of the fifty a budget acts on (the 25th). */
const NTH = 24;

/** Every leaf of the linked workload. Asserted, then used as a number:
 *  the budgets below that equal it are walks of the whole document. */
const LEAVES = 1403;

/** Run `command` against a counting host and report it. */
async function counted<T>(
  w: Workload,
  scenario: string,
  selection: ElementId[],
  command: (host: BundleHost) => Promise<T>,
): Promise<{ work: WorkLog; result: T }> {
  await w.h.host.selection.set(selection);
  const { host, work } = countingHost(w.h.host);
  const result = await command(host);
  const snapshot = work.snapshot();
  await w.h.host.selection.set([]);
  report(scenario, snapshot, {
    returned: Array.isArray(result) ? result.length : result,
  });
  return { work: snapshot, result };
}

/** The same for a command that WRITES: the undo steps it left are
 *  measured against the undo log, then the document and the recipe parts
 *  (which are not on the undo stack) are put back, so the next budget
 *  sees the document this file describes. `setup` runs first, uncounted,
 *  and is undone too. */
async function countedWrite<T>(
  w: Workload,
  scenario: string,
  selection: ElementId[],
  command: (host: BundleHost) => Promise<T>,
  setup?: () => Promise<void>,
): Promise<{ work: WorkLog; undoSteps: number; result: T }> {
  const parts = await snapshotParts(w.h);
  const outer = await undoMark(w);
  if (setup) await setup();
  await w.h.host.selection.set(selection);
  const mark = await undoMark(w);
  const { host, work } = countingHost(w.h.host);
  const result = await command(host);
  const snapshot = work.snapshot();
  const undoSteps = await undoStepsSince(w, mark);
  await undoStepsSince(w, outer);
  await restoreParts(w.h, parts);
  await w.h.host.selection.set([]);
  report(scenario, snapshot, {
    undoSteps,
    returned: Array.isArray(result) ? result.length : result,
  });
  return { work: snapshot, undoSteps, result };
}

vi.setConfig({ testTimeout: BUDGET_TIMEOUT_MS });

describe("perf budgets — commands over a busy document", () => {
  let w: Workload;

  beforeAll(async () => {
    w = await buildLinkedWorkload();
  }, 180_000);
  afterAll(() => w?.h.dispose());

  const recordOf = (feature: LinkedFeature): string =>
    w.linked[feature]!.records[NTH]!;
  const handleOf = (feature: LinkedFeature): ElementId =>
    w.linked[feature]!.handles[NTH]!;

  it("the workload built everything it was asked for — nothing was refused", async () => {
    expect(w.refusals).toEqual([]);
    for (const records of Object.values(w.linked)) {
      expect(records.records, records.feature).toHaveLength(50);
    }
    expect(await leafIds(w.h)).toHaveLength(LEAVES);
    // Seven authoring batches place 951 shapes and the fixture brings 2;
    // the other 450 leaves are what the bundle's commands made of them.
    expect(w.batches).toBe(7);
  });

  // COVERS: the six link walks — `blendLinks` (`commands/blend.ts`),
  // `repeatLinks` (`repeat.ts`), `patternLinks` (`pattern.ts`),
  // `objectsOnPathLinks` (`objects-on-path.ts`), `livePaintLinks`
  // (`live-paint.ts`) and `symbolInstances` (`symbols.ts`) — through the
  // one read-only verb each feature has, so nothing but the walk is
  // counted.
  //
  // SUSPICION CONFIRMED, exactly: one `getMetadata` per leaf of the
  // whole document, for every feature, whichever record is asked for.
  describe("link discovery — one metadata read per leaf of the document", () => {
    type Walked = Exclude<LinkedFeature, "symbols">;
    const SELECT: Record<
      Walked,
      (host: BundleHost, id?: string) => Promise<ElementId[]>
    > = {
      blend: (host, id) => applySelectBlendObjects(host, id ? { blendId: id } : {}),
      repeat: (host, id) =>
        applySelectRepeatInstances(host, id ? { repeatId: id } : {}),
      pattern: (host, id) =>
        applySelectPatternTiles(host, id ? { patternId: id } : {}),
      objectsOnPath: (host, id) =>
        applySelectObjectsOnPath(host, id ? { onPathId: id } : {}),
      livePaint: (host, id) =>
        applySelectLivePaintFaces(host, id ? { groupId: id } : {}),
    };

    // [feature, what the command selects — the leaves it was looking for]
    it.each<[Walked, number]>([
      ["blend", 2],
      ["repeat", 2],
      ["pattern", 2],
      ["objectsOnPath", 2],
      ["livePaint", 1],
    ])("%s, record named by id: 1 403 reads to find %i leaves", async (feature, found) => {
      const { work, result } = await counted(w, `${feature} select by id`, [], (host) =>
        SELECT[feature](host, recordOf(feature)),
      );
      expect(result).toHaveLength(found);
      expect(work.mutations).toEqual([]);
      expect(work.count("document.tree")).toBe(1);
      // Every leaf in the document: the 500 plain shapes, the 901 the six
      // features own between them, the fixture's 2 — for a record that
      // owns 5 at most. TARGET: the record's own leaves; the recipe part
      // already names them.
      expect(work.count("document.getMetadata")).toBe(LEAVES);
    });

    it.each<[Walked]>([
      ["blend"],
      ["repeat"],
      ["pattern"],
      ["objectsOnPath"],
      ["livePaint"],
    ])("%s, record resolved from the selection: one more read", async (feature) => {
      const { work, result } = await counted(
        w,
        `${feature} select from selection`,
        [handleOf(feature)],
        (host) => SELECT[feature](host),
      );
      expect(result.length).toBeGreaterThan(0);
      // The selected leaf's own link names the record (1 read) — and
      // then the whole document is walked anyway. TARGET as above.
      expect(work.count("document.getMetadata")).toBe(LEAVES + 1);
    });

    it.each<[Walked]>([["blend"], ["repeat"], ["pattern"], ["objectsOnPath"]])(
      "%s, nothing selected: the whole walk, to conclude the request is ambiguous",
      async (feature) => {
        const { work, result } = await counted(
          w,
          `${feature} select from nothing`,
          [],
          (host) => SELECT[feature](host),
        );
        // Fifty records and no selection: nothing resolves, nothing is
        // selected, the command is a no-op …
        expect(result).toEqual([]);
        // … after reading every leaf to count how many records there
        // are, which the recipe part it read first had already said.
        // TARGET 0.
        expect(work.count("document.getMetadata")).toBe(LEAVES);
      },
    );

    it("livePaint, nothing selected: the one feature that answers from its recipe alone", async () => {
      const { work, result } = await counted(w, "livePaint select from nothing", [], (host) =>
        SELECT.livePaint(host),
      );
      expect(result).toEqual([]);
      // The same no-op, for zero document reads. This is the target the
      // other four are held to.
      expect(work.reads()).toBe(0);
    });

    it("symbols: enumerating 50 instances reads every leaf", async () => {
      const { work, result } = await counted(w, "symbols instances", [], (host) =>
        symbolInstances(host, w.linked.symbols!.symbolId),
      );
      expect(result).toHaveLength(50);
      expect(work.count("document.tree")).toBe(1);
      // TARGET 50 — a read per instance, not per leaf. (An instance is
      // its own index: the symbol recipe holds definitions only.)
      expect(work.count("document.getMetadata")).toBe(LEAVES);
    });
  });

  // COVERS: `selectSameMatches` in `commands/select-same.ts` — the same
  // walk over a different door: one `elementProperties` per leaf.
  //
  // SUSPICION CONFIRMED.
  describe("Select Same — one property read per leaf of the document", () => {
    it("same fill, from one plain shape", async () => {
      const { work, result } = await counted(w, "select same fill", [], (host) =>
        selectSameMatches(host, w.plain[0]!, "fill"),
      );
      // The workload is painted with one swatch, so most of it matches.
      expect(result).toHaveLength(1253);
      expect(work.count("document.tree")).toBe(1);
      // The reference, then every leaf — each reply carrying the leaf's
      // whole property table, to compare one entry of it. TARGET 2: the
      // reference and one batched read (`elementGeometry` takes a list;
      // `elementProperties` does not).
      expect(work.count("document.elementProperties")).toBe(LEAVES + 1);
    });
  });

  // COVERS: the re-plan lanes — `applyUpdateBlend`, `applyUpdateRepeat`,
  // `applyEditPattern`, `applyUpdateObjectsOnPath`, `fillLivePaintFaces`,
  // `applyRegenerateLivePaint` — where the link walk and the tree diff
  // meet. Each acts on ONE record.
  describe("re-plan one record of fifty — the walks stack up", () => {
    it("blend, update: the document is walked twice and the tree read six times", async () => {
      const { work, undoSteps, result } = await countedWrite(w, "blend update", [], (host) =>
        applyUpdateBlend(host, { blendId: recordOf("blend"), steps: 4 }),
      );
      expect(result).toHaveLength(4);
      expect(work.mutations).toEqual([{ op: "batch", ops: 39 }]);
      expect(undoSteps).toBe(1);
      // `blendLinks` runs twice (once for the keys, once inside
      // `blendGenerationOf`). TARGET <= 7: the record's own 5 leaves and
      // the 4 new steps' — none of which need a read if the batch
      // outcome names them.
      expect(work.count("document.getMetadata")).toBe(2812);
      // Two link walks, two group lookups, the before/after diff.
      // TARGET 0.
      expect(work.count("document.tree")).toBe(6);
    });

    it("repeat, update: the same shape", async () => {
      const { work, undoSteps, result } = await countedWrite(w, "repeat update", [], (host) =>
        applyUpdateRepeat(host, { repeatId: recordOf("repeat"), columns: 4 }),
      );
      expect(result).toHaveLength(3);
      expect(work.mutations).toEqual([{ op: "batch", ops: 23 }]);
      expect(undoSteps).toBe(1);
      // TARGET <= 5.
      expect(work.count("document.getMetadata")).toBe(2810);
      // TARGET 0.
      expect(work.count("document.tree")).toBe(6);
      // The recipe part is read four times in one command. TARGET 1.
      expect(work.count("parts.read")).toBe(4);
    });

    it("pattern, re-plan: one walk — and still two batches", async () => {
      const { work, undoSteps, result } = await countedWrite(w, "pattern replan", [], (host) =>
        applyEditPattern(host, { patternId: recordOf("pattern"), columns: 4 }),
      );
      expect(result).toHaveLength(3);
      // Insert, then paint-link-group-and-delete. TARGET 1 batch, 1 undo
      // step — the `bindCreated` conversion CLAUDE.md lists as owed.
      expect(work.mutations).toEqual([
        { op: "batch", ops: 3 },
        { op: "batch", ops: 17 },
      ]);
      expect(undoSteps).toBe(2);
      // TARGET <= 4.
      expect(work.count("document.getMetadata")).toBe(LEAVES + 1);
      // TARGET 0.
      expect(work.count("document.tree")).toBe(5);
    });

    it("objects on a path, update: nothing is created, the document is walked anyway", async () => {
      const { work, undoSteps, result } = await countedWrite(
        w,
        "objects on path update",
        [],
        (host) =>
          applyUpdateObjectsOnPath(host, {
            onPathId: recordOf("objectsOnPath"),
            reverseOrder: true,
          }),
      );
      expect(result).toHaveLength(2);
      expect(work.mutations).toEqual([{ op: "batch", ops: 5 }]);
      expect(undoSteps).toBe(1);
      // The walk plus the three envelopes it re-reads for the batch.
      // TARGET 3 — the recipe names the path and both objects.
      expect(work.count("document.getMetadata")).toBe(LEAVES + 3);
      // No tree diff here: this feature creates nothing. The one read is
      // the link walk's. TARGET 0.
      expect(work.count("document.tree")).toBe(1);
    });

    it("live paint, fill a second face", async () => {
      const [x, y] = cellOrigin("livePaint", NTH);
      const { work, undoSteps, result } = await countedWrite(w, "live paint fill", [], (host) =>
        applyFillLivePaintFace(host, {
          groupId: recordOf("livePaint"),
          x: x + 3,
          y: y + 3,
        }),
      );
      expect(result).toHaveLength(1);
      // TARGET 1 batch, 1 undo step.
      expect(work.mutations).toEqual([
        { op: "batch", ops: 1 },
        { op: "batch", ops: 3 },
      ]);
      expect(undoSteps).toBe(2);
      // TARGET 0 — the recipe can name its fills.
      expect(work.count("document.getMetadata")).toBe(LEAVES);
      // TARGET 0.
      expect(work.count("document.tree")).toBe(3);
      // The point query, then the full arrangement for the same two
      // members. TARGET 1.
      expect(work.count("document.planarRegions")).toBe(2);
    });

    it("live paint, regenerate one group", async () => {
      const { work, undoSteps, result } = await countedWrite(w, "live paint regenerate", [], (host) =>
        applyRegenerateLivePaint(host, { groupId: recordOf("livePaint") }),
      );
      expect(result).toEqual({ rebuilt: 1, dropped: [] });
      // TARGET 1 batch, 1 undo step.
      expect(work.mutations).toEqual([
        { op: "batch", ops: 1 },
        { op: "batch", ops: 4 },
      ]);
      expect(undoSteps).toBe(2);
      // TARGET 0.
      expect(work.count("document.getMetadata")).toBe(LEAVES);
      expect(work.count("document.tree")).toBe(3);
    });
  });

  // COVERS: `commands/symbols.ts` — `symbolInstances`, `emitSymbolInstance`
  // and `rebuildInstance`, which redefine runs once PER INSTANCE.
  describe("symbols — place, reset, and a redefine that rebuilds every instance", () => {
    it("place one instance", async () => {
      const { work, undoSteps, result } = await countedWrite(w, "symbol place", [], (host) =>
        applyPlaceSymbolInstance(host, w.linked.symbols!.symbolId, {
          x: 100,
          y: 700,
          pageId: w.pageId,
        }),
      );
      expect(result).toHaveLength(1);
      // TARGET 1 batch, 1 undo step.
      expect(work.mutations).toEqual([
        { op: "batch", ops: 1 },
        { op: "batch", ops: 4 },
      ]);
      expect(undoSteps).toBe(2);
      // Every leaf is read to mint an instance id nobody else holds.
      // TARGET 0 — a counter in the recipe.
      expect(work.count("document.getMetadata")).toBe(LEAVES);
      // TARGET 0.
      expect(work.count("document.tree")).toBe(3);
    });

    it("reset one selected instance", async () => {
      const { work, undoSteps, result } = await countedWrite(
        w,
        "symbol reset",
        [handleOf("symbols")],
        (host) => applyResetSymbolTransform(host),
      );
      expect(result).toBe(1);
      expect(work.mutations).toEqual([
        { op: "batch", ops: 1 },
        { op: "batch", ops: 5 },
      ]);
      // TARGET 1.
      expect(undoSteps).toBe(2);
      // TARGET 1 — the selected leaf's own link.
      expect(work.count("document.getMetadata")).toBe(LEAVES);
      // TARGET 0.
      expect(work.count("document.tree")).toBe(5);
    });

    it("redefine: 50 instances are 100 mutations, 100 undo steps and 152 tree reads", async () => {
      const { work, undoSteps, result } = await countedWrite(
        w,
        "symbol redefine",
        [w.plain[0]!],
        (host) => applyRedefineSymbol(host, w.linked.symbols!.symbolId),
      );
      expect(result).not.toBeNull();
      // Two batches per instance, in a loop. TARGET 1 — every rebuild in
      // one batch.
      expect(work.mutations).toHaveLength(100);
      // ONE command, a HUNDRED presses of undo to take it back.
      // TARGET 1.
      expect(undoSteps).toBe(100);
      // Three whole-document tree reads per instance, plus two. A
      // rebuild reads the tree for its group, then diffs around its
      // insert. TARGET 1.
      expect(work.count("document.tree")).toBe(152);
      // The one thing redefine does once.
      expect(work.count("document.getMetadata")).toBe(LEAVES);
      expect(work.count("document.pathAnchors")).toBe(101);
      expect(work.count("document.elementGeometry")).toBe(50);
    });
  });

  // COVERS: the before/after `document.tree()` diff in `emitBlend`,
  // `emitRepeat`, `emitPatternField`, `bakeAppearance` and `releaseOne`
  // (`commands/compound-path.ts`) — MAKE on plain shapes, so there is no
  // link walk in the way and the tree reads are the diff's own.
  //
  // SUSPICION CONFIRMED, and the read it replaces already exists.
  describe("what did this batch create — the tree is read to find out", () => {
    it("THE TARGET IS REAL: the engine's reply already lists what a batch minted", async () => {
      // `MutationOutcome` keeps one `createdId`; the wire reply it is
      // built from carries `minted` — every element the batch created,
      // in order. The diff below exists because the facade drops it.
      const mark = await undoMark(w);
      const at = (x: number) => ({
        anchor: [x, 2] as [number, number],
        left: [x, 2] as [number, number],
        right: [x, 2] as [number, number],
      });
      const reply = (await w.h.host.editor.client.mutate({
        op: "batch",
        args: {
          ops: [
            { op: "insertPath", args: { pageId: w.pageId, anchors: [at(2), at(4), at(6)], open: true } },
            { op: "insertPath", args: { pageId: w.pageId, anchors: [at(8), at(10), at(12)], open: true } },
          ],
        },
      })) as { kind: string; payload: { minted?: { element: ElementId }[] } };
      expect(reply.kind).toBe("mutationApplied");
      expect(reply.payload.minted).toHaveLength(2);
      expect(await undoStepsSince(w, mark)).toBe(1);
    });

    it("blend: two reads for the diff, a third to find the group", async () => {
      const { work, undoSteps, result } = await countedWrite(
        w,
        "make blend",
        [w.plain[0]!, w.plain[2]!],
        (host) => applyMakeBlend(host, { steps: 3 }),
      );
      expect(result).toHaveLength(3);
      expect(work.mutations).toEqual([{ op: "batch", ops: 27 }]);
      expect(undoSteps).toBe(1);
      // Each one returns all 1 403 leaves. TARGET 0.
      expect(work.count("document.tree")).toBe(3);
      // The two keys, then the three steps the diff found.
      expect(work.count("document.getMetadata")).toBe(5);
    });

    it("repeat", async () => {
      const { work, undoSteps, result } = await countedWrite(w, "make repeat", [w.plain[0]!], (host) =>
        applyMakeRepeat(host, "grid", { columns: 3, rows: 1, spacing: [4, 4] }),
      );
      expect(result).toHaveLength(2);
      expect(work.mutations).toEqual([{ op: "batch", ops: 14 }]);
      expect(undoSteps).toBe(1);
      // TARGET 0.
      expect(work.count("document.tree")).toBe(3);
    });

    it("pattern", async () => {
      const { work, undoSteps, result } = await countedWrite(w, "make pattern", [w.plain[0]!], (host) =>
        applyMakePattern(host, { columns: 3, rows: 1, spacing: [4, 4] }),
      );
      expect(result).toHaveLength(2);
      // TARGET 1 batch, 1 undo step.
      expect(work.mutations).toEqual([
        { op: "batch", ops: 2 },
        { op: "batch", ops: 10 },
      ]);
      expect(undoSteps).toBe(2);
      // TARGET 0.
      expect(work.count("document.tree")).toBe(3);
    });

    it("appearance, bake a three-layer stack", async () => {
      const stack: AppearanceStack = {
        fills: [{ color: "Color/Black" }, { color: "Color/Paper" }],
        strokes: [{ color: "Color/Black", weight: 2 }],
      };
      const carrier = w.plain[0]!;
      const { work, undoSteps, result } = await countedWrite(
        w,
        "appearance bake",
        [carrier],
        (host) => bakeAppearance(host, carrier),
        // The stack is seeded uncounted: the bake is the budget, not the
        // panel edit that precedes it.
        async () => {
          await commitAppearance(
            w.h.host,
            carrier,
            stack,
            await w.h.host.document.getMetadata(carrier),
          );
        },
      );
      expect(result).toHaveLength(3);
      // TARGET 1 batch, 1 undo step.
      expect(work.mutations).toEqual([
        { op: "batch", ops: 3 },
        { op: "batch", ops: 14 },
      ]);
      expect(undoSteps).toBe(2);
      // The diff, and nothing else. TARGET 0.
      expect(work.count("document.tree")).toBe(2);
    });

    it("compound path, release", async () => {
      const pair = [w.plain[0]!, w.plain[1]!];
      const { work, undoSteps, result } = await countedWrite(
        w,
        "compound release",
        [pair[0]!],
        (host) => applyReleaseCompoundPath(host),
        async () => {
          await w.h.host.selection.set(pair);
          expect(await applyMakeCompoundPath(w.h.host)).toBe(2);
        },
      );
      expect(result).toHaveLength(1);
      // TARGET 1 batch, 1 undo step.
      expect(work.mutations).toEqual([
        { op: "batch", ops: 2 },
        { op: "batch", ops: 3 },
      ]);
      expect(undoSteps).toBe(2);
      // TARGET 0.
      expect(work.count("document.tree")).toBe(2);
    });
  });
});

// COVERS: `applyImageTracePlan` in `commands/image-trace.ts` — the same
// tree diff, behind the one flow that needs a placed image, so it runs
// on its own document: the F7 fixture (an inline PNG ring) under the
// same 500 plain shapes. The plan is a REAL trace of the fixture's own
// pixels by the committed tracer wasm.
describe("perf budgets — Image Trace over a busy document", () => {
  let w: Workload;

  beforeAll(async () => {
    w = await openWorkload(F7_PLACED_IMAGE);
    await addPlainShapes(w);
  }, 180_000);
  afterAll(() => w?.h.dispose());

  it("committing a traced ring: the tree is read twice to learn what two inserts created", async () => {
    expect(w.refusals).toEqual([]);
    expect(await leafIds(w.h)).toHaveLength(502);

    const engine = await bootTraceEngine();
    const size = F7_PLACED_IMAGE.pixels;
    const source = {
      kind: "rectangle",
      id: F7_PLACED_IMAGE.imageId,
    } as ElementId;
    const plan = tracePlanFor({
      pageId: F7_PLACED_IMAGE.pageId,
      source,
      sourceUri: F7_PLACED_IMAGE.uri,
      result: engine.trace(ringPixels(size), size, size, {
        mode: "bw",
        pathMode: "polygon",
      }),
      pixelToPage: pixelToPageAffine(F7_PLACED_IMAGE.bounds, null, size, size)!,
      scale: 1,
      sourcePixels: [size, size],
      options: TRACE_DEFAULTS,
    });

    const { work, undoSteps, result } = await countedWrite(w, "image trace commit", [], (host) =>
      applyImageTracePlan(host, plan),
    );
    // One region, two contours: a ring.
    expect(result).toHaveLength(1);
    // TARGET 1 batch, 1 undo step.
    expect(work.mutations.map((m) => m.op)).toEqual(["batch", "batch"]);
    expect(undoSteps).toBe(2);
    // TARGET 0 — see "THE TARGET IS REAL" above.
    expect(work.count("document.tree")).toBe(2);
    expect(work.count("document.getMetadata")).toBe(1);
  });
});

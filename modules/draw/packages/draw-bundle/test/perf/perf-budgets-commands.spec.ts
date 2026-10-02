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
//    trip each — and keeping the ones that carry its key. AS FOUND: six
//    features, six copies of the same loop (`blendLinks`, `repeatLinks`,
//    `patternLinks`, `livePaintLinks`, `objectsOnPathLinks`,
//    `symbolInstances`), each blind to the other five's leaves and to
//    the 500 that belong to nobody, and run again by every command.
//    NOW: one shared walk per document REVISION (`src/link-index.ts`),
//    so a command costs one walk at most and the next command on an
//    unchanged document costs none. The walk itself is still a read per
//    leaf — there is no bulk metadata door (RFI C-65) — which is why the
//    COLD budgets below still equal the leaf count.
//  · "WHAT DID THIS BATCH CREATE". A batch outcome carries one
//    `createdId`, so a flow that inserts several paths reads the whole
//    scene tree before the batch and again after it, and diffs.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type {
  BundleHost,
  ElementId,
  SceneTreeNode,
} from "@paged-media/plugin-api";

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
import { treeShapeOf } from "../conformance/one-batch";
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
 *  and is undone too.
 *
 *  A count is not the whole budget: a batch can apply and be the wrong
 *  edit. So the write also answers what it LEFT — the selection, and the
 *  nodes it added, as `kind` lists in tree order — and whether taking
 *  back exactly `undoSteps` steps `restored` the scene tree it started
 *  from, node for node. */
async function countedWrite<T>(
  w: Workload,
  scenario: string,
  selection: ElementId[],
  command: (host: BundleHost) => Promise<T>,
  setup?: () => Promise<void>,
): Promise<{
  work: WorkLog;
  undoSteps: number;
  result: T;
  /** What the command left selected. */
  selected: ElementId[];
  /** Node kinds the command added to the tree, in tree order. */
  added: string[];
  /** Did undoing `undoSteps` steps put the tree back exactly? */
  restored: boolean;
}> {
  const parts = await snapshotParts(w.h);
  const outer = await undoMark(w);
  if (setup) await setup();
  await w.h.host.selection.set(selection);
  const before = await w.h.host.document.tree();
  const mark = await undoMark(w);
  const { host, work } = countingHost(w.h.host);
  const result = await command(host);
  const snapshot = work.snapshot();
  const selected = [...w.h.host.selection.get()];
  const known = new Set(nodeIds(before));
  const added = nodesOf(await w.h.host.document.tree())
    .filter((id) => !known.has(String(id.id)))
    .map((id) => id.kind);
  const undoSteps = await undoStepsSince(w, mark);
  const restored =
    treeShapeOf(await w.h.host.document.tree()) === treeShapeOf(before);
  await undoStepsSince(w, outer);
  await restoreParts(w.h, parts);
  await w.h.host.selection.set([]);
  report(scenario, snapshot, {
    undoSteps,
    returned: Array.isArray(result) ? result.length : result,
  });
  return { work: snapshot, undoSteps, result, selected, added, restored };
}

/** Every node of a tree that carries an id, in tree order. */
function nodesOf(roots: readonly SceneTreeNode[]): ElementId[] {
  return roots.flatMap((node) => [
    ...(node.id ? [node.id] : []),
    ...nodesOf(node.children ?? []),
  ]);
}

const nodeIds = (roots: readonly SceneTreeNode[]): string[] =>
  nodesOf(roots).map((id) => String(id.id));

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
  type Walked = Exclude<LinkedFeature, "symbols">;
  /** The one read-only verb each walked feature has. */
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

  // Every scenario in this describe hands its command a FRESH view of
  // the host — a cold link index — so what it counts is what a walk
  // costs when nothing has read the document at this revision yet. What
  // a walk costs the NEXT command is in the describe after it.
  describe("link discovery — one metadata read per leaf of the document", () => {
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
    ])("%s, record resolved from the selection: the same walk, no extra read", async (feature) => {
      const { work, result } = await counted(
        w,
        `${feature} select from selection`,
        [handleOf(feature)],
        (host) => SELECT[feature](host),
      );
      expect(result.length).toBeGreaterThan(0);
      // As found: LEAVES + 1 — the selected leaf's own link names the
      // record (1 read), and then the whole document was walked anyway,
      // that leaf included. The link index reads each leaf ONCE per
      // revision, so the walk skips the one the resolve already read.
      // TARGET as above.
      expect(work.count("document.getMetadata")).toBe(LEAVES);
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

  // COVERS: the link index (`src/link-index.ts`) ACROSS commands — the
  // half no scenario above can show, because each of them hands its
  // command a fresh view of the host, and so a cold index. In the editor
  // there is ONE host for the bundle's life: a walk is paid once per
  // document REVISION, by whichever command or panel asks first.
  describe("one host, several commands — the walk is paid once per revision", () => {
    it("SIX features, ONE walk: whoever asks first pays, and the other five read nothing", async () => {
      const { host, work } = countingHost(w.h.host);

      // The first to ask — blend, here — walks the document.
      expect(await SELECT.blend(host, recordOf("blend"))).toHaveLength(2);
      expect(work.count("document.tree")).toBe(1);
      expect(work.count("document.getMetadata")).toBe(LEAVES);

      // The other five find their own leaves in what that walk read. As
      // found: five more walks, 7 015 more reads — each feature's loop
      // was blind to what the others had just read.
      work.reset();
      for (const [feature, found] of [
        ["repeat", 2],
        ["pattern", 2],
        ["objectsOnPath", 2],
        ["livePaint", 1],
      ] as const) {
        expect(await SELECT[feature](host, recordOf(feature)), feature).toHaveLength(
          found,
        );
      }
      expect(
        await symbolInstances(host, w.linked.symbols!.symbolId),
      ).toHaveLength(50);
      expect(work.count("document.tree")).toBe(0);
      expect(work.count("document.getMetadata")).toBe(0);
      // What is left is not a document read: the two features that
      // consult their recipe to answer (repeat for its clipped
      // instances, live paint for its group).
      expect(work.reads()).toBe(0);
      expect(work.count("parts.read")).toBe(2);
      report("five features on a warm index", work.snapshot());

      await w.h.host.selection.set([]);
    });

    it("blend: select, select another, update, select what the update built", async () => {
      const parts = await snapshotParts(w.h);
      const mark = await undoMark(w);
      const { host, work } = countingHost(w.h.host);
      const other = w.linked.blend!.records[NTH + 1]!;

      // COLD — the walk.
      expect(
        await applySelectBlendObjects(host, { blendId: recordOf("blend") }),
      ).toHaveLength(2);
      expect(work.count("document.tree")).toBe(1);
      expect(work.count("document.getMetadata")).toBe(LEAVES);

      // WARM — another record of the same, unchanged document: no engine
      // round trip at all. As found: another 1 403.
      work.reset();
      expect(await applySelectBlendObjects(host, { blendId: other })).toHaveLength(2);
      expect(work.reads()).toBe(0);

      // WARM — an update. What is left is the build's own: the two key
      // envelopes, the before/after tree diff, the 4 new steps' links
      // and the new group's lookup. As found: 2 812 and 6.
      work.reset();
      const steps = await applyUpdateBlend(host, { blendId: other, steps: 4 });
      expect(steps).toHaveLength(4);
      expect(work.count("document.getMetadata")).toBe(6);
      expect(work.count("document.tree")).toBe(3);
      report("blend update, warm index", work.snapshot());

      // THE UPDATE CHANGED THE DOCUMENT, so the next command walks
      // again — and what it finds is what the update built, not what
      // the index held before it.
      work.reset();
      const found = await applySelectBlendObjects(host, {
        blendId: other,
        which: "steps",
      });
      expect(found.map((e) => e.id).sort()).toEqual(steps.map((e) => e.id).sort());
      expect(work.count("document.tree")).toBe(1);
      expect(work.count("document.getMetadata")).toBe(
        (await leafIds(w.h)).length,
      );

      await undoStepsSince(w, mark);
      await restoreParts(w.h, parts);
      await w.h.host.selection.set([]);
      expect(await leafIds(w.h)).toHaveLength(LEAVES);
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
      // Every leaf once, in parallel — each reply carrying the leaf's
      // whole property table, to compare one entry of it. As found:
      // LEAVES + 1 — the reference was read on its own and then again
      // as one of the leaves. TARGET 2: the reference and one batched
      // read (`elementGeometry` takes a list; `elementProperties` does
      // not).
      expect(work.count("document.elementProperties")).toBe(LEAVES);
    });

    it("a reference with nothing to match on still costs ONE read, not a pass", async () => {
      // A group has no paint of its own. The pass over the document
      // must not be what finds that out.
      const group = (await w.h.host.document.tree())
        .flatMap(function groups(node): ElementId[] {
          const below = (node.children ?? []).flatMap(groups);
          return node.id?.kind === "group" ? [node.id, ...below] : below;
        })
        .at(0)!;
      expect(group).toBeDefined();
      const { work, result } = await counted(w, "select same, no paint", [], (host) =>
        selectSameMatches(host, group, "fill"),
      );
      expect(result).toEqual([]);
      expect(work.count("document.elementProperties")).toBe(1);
      expect(work.count("document.tree")).toBe(0);
    });

    it("the OTHER criteria on an unchanged document read nothing: one pass answers all three", async () => {
      const { host, work } = countingHost(w.h.host);
      const fill = await selectSameMatches(host, w.plain[0]!, "fill");
      expect(fill).toHaveLength(1253);
      expect(work.count("document.elementProperties")).toBe(LEAVES);

      // Stroke, then stroke weight, then fill again from another
      // reference. As found: 1 404 reads each.
      work.reset();
      const stroke = await selectSameMatches(host, w.plain[0]!, "stroke");
      const weight = await selectSameMatches(host, w.plain[0]!, "strokeWeight");
      const again = await selectSameMatches(host, w.plain[1]!, "fill");
      expect(work.reads()).toBe(0);
      report("select same, three more on a warm pass", work.snapshot());
      // The answers are the ones a cold pass gives.
      expect(again.map((e) => e.id).sort()).toEqual(fill.map((e) => e.id).sort());
      const cold = countingHost(w.h.host).host;
      expect(stroke.map((e) => e.id)).toEqual(
        (await selectSameMatches(cold, w.plain[0]!, "stroke")).map((e) => e.id),
      );
      expect(weight.map((e) => e.id)).toEqual(
        (await selectSameMatches(cold, w.plain[0]!, "strokeWeight")).map((e) => e.id),
      );

      // A change to the document, and the next one reads it again — and
      // sees the change.
      const mark = await undoMark(w);
      const changed = await w.h.host.document.mutate({
        op: "setElementProperty",
        args: {
          elementId: w.plain[1]!,
          path: "frameStrokeWeight",
          value: { type: "length", value: 7.5 },
        },
      });
      expect(changed.applied).toBe(true);
      work.reset();
      const heavy = await selectSameMatches(host, w.plain[1]!, "strokeWeight");
      expect(heavy.map((e) => e.id)).toEqual([w.plain[1]!.id]);
      expect(work.count("document.elementProperties")).toBe(LEAVES);
      await undoStepsSince(w, mark);
    });
  });

  // COVERS: the re-plan lanes — `applyUpdateBlend`, `applyUpdateRepeat`,
  // `applyEditPattern`, `applyUpdateObjectsOnPath`, `fillLivePaintFaces`,
  // `applyRegenerateLivePaint` — where the link walk and the tree diff
  // meet. Each acts on ONE record.
  describe("re-plan one record of fifty — the walks stack up", () => {
    it("blend, update: ONE walk, and the tree read four times", async () => {
      const { work, undoSteps, result } = await countedWrite(w, "blend update", [], (host) =>
        applyUpdateBlend(host, { blendId: recordOf("blend"), steps: 4 }),
      );
      expect(result).toHaveLength(4);
      expect(work.mutations).toEqual([{ op: "batch", ops: 39 }]);
      expect(undoSteps).toBe(1);
      // One walk (LEAVES), the two key envelopes the batch is built
      // from, and the 4 new steps the tree diff found. As found: 2 812 —
      // `blendLinks` ran twice (once for the keys, once inside
      // `blendGenerationOf`), each a walk of its own. TARGET <= 7: the
      // record's own 5 leaves and the 4 new steps' — none of which need
      // a read if the batch outcome names them.
      expect(work.count("document.getMetadata")).toBe(LEAVES + 6);
      // The index's one tree, the before/after diff, and the lookup of
      // the group the batch created. As found: 6 (two link walks and a
      // second group lookup on top). TARGET 0.
      expect(work.count("document.tree")).toBe(4);
    });

    it("repeat, update: the same shape", async () => {
      const { work, undoSteps, result } = await countedWrite(w, "repeat update", [], (host) =>
        applyUpdateRepeat(host, { repeatId: recordOf("repeat"), columns: 4 }),
      );
      expect(result).toHaveLength(3);
      expect(work.mutations).toEqual([{ op: "batch", ops: 23 }]);
      expect(undoSteps).toBe(1);
      // One walk, the source envelope the batch is built from, and the 3
      // new instances the tree diff found. As found: 2 810 — two walks.
      // TARGET <= 5.
      expect(work.count("document.getMetadata")).toBe(LEAVES + 4);
      // The index's one tree, the before/after diff, the new group's
      // lookup. As found: 6. TARGET 0.
      expect(work.count("document.tree")).toBe(4);
      // As found: 4 — the command, both `repeatLinks` and the
      // generation each read the recipe for themselves.
      expect(work.count("parts.read")).toBe(1);
    });

    it("pattern, re-plan: one walk, ONE batch, one undo step", async () => {
      const { work, undoSteps, result, selected, added, restored } =
        await countedWrite(w, "pattern replan", [], (host) =>
          applyEditPattern(host, { patternId: recordOf("pattern"), columns: 4 }),
        );
      expect(result).toHaveLength(3);
      // The three inserts with their names, the old group dissolved and
      // its two tiles deleted, then paint, links and the new group. As
      // found: TWO batches (3 inserts, then 17) and 2 undo steps — the
      // first of which left three unpainted paths on the page.
      expect(work.mutations).toEqual([{ op: "batch", ops: 23 }]);
      expect(undoSteps).toBe(1);
      // What it left: three tiles and one group, the group selected —
      // and one undo put the document back.
      expect(added.sort()).toEqual(["group", "polygon", "polygon", "polygon"]);
      expect(selected.map((s) => s.kind)).toEqual(["group"]);
      expect(restored).toBe(true);
      // The walk, and nothing after it: the source envelope the batch is
      // built from is one the walk read. As found: LEAVES + 1 — it was
      // read again after the first batch. TARGET <= 4.
      expect(work.count("document.getMetadata")).toBe(LEAVES);
      // The index's one tree, which also names the old group. As found:
      // 5, then 4 — the before/after diff and the new group's lookup on
      // top. What the batch created is read off the engine's reply now
      // (`commands/minted.ts`). TARGET 0.
      expect(work.count("document.tree")).toBe(1);
    });

    it("objects on a path, update: nothing is created, the document is walked ONCE", async () => {
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
      // The walk, and nothing after it: the batch is built from the
      // envelopes the walk read. As found: LEAVES + 3 — the path's and
      // both objects' were read a second time for the batch. TARGET 3 —
      // the recipe names the path and both objects.
      expect(work.count("document.getMetadata")).toBe(LEAVES);
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
      // The index's one tree and the before/after diff. As found: 5 —
      // expanding the selection, the walk and the instance's group
      // lookup each read the same tree for themselves. TARGET 0.
      expect(work.count("document.tree")).toBe(3);
    });

    it("redefine: 50 instances are 100 mutations, 100 undo steps and 150 tree reads", async () => {
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
      // Three whole-document tree reads per instance: a rebuild reads
      // the tree for its group, then diffs around its insert. As found:
      // 152 — the capture and the instance walk read it once each on
      // top; they and the FIRST rebuild's group lookup now share one
      // read (the same revision), so it is 3 × 50 exactly. TARGET 1.
      expect(work.count("document.tree")).toBe(150);
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

    it("pattern: ONE batch, and the tree is not read at all", async () => {
      const { work, undoSteps, result, selected, added, restored } =
        await countedWrite(w, "make pattern", [w.plain[0]!], (host) =>
          applyMakePattern(host, { columns: 3, rows: 1, spacing: [4, 4] }),
        );
      expect(result).toHaveLength(2);
      // 2 × (insert, bind, fill, stroke, weight, link), the source link,
      // the group. As found: TWO batches (2, then 10) and 2 undo steps.
      expect(work.mutations).toEqual([{ op: "batch", ops: 14 }]);
      expect(undoSteps).toBe(1);
      expect(added.sort()).toEqual(["group", "polygon", "polygon"]);
      expect(selected.map((s) => s.kind)).toEqual(["group"]);
      expect(restored).toBe(true);
      // As found: 3 — before, after, and a third to find the group.
      expect(work.count("document.tree")).toBe(0);
    });

    it("appearance, bake a three-layer stack", async () => {
      const stack: AppearanceStack = {
        fills: [{ color: "Color/Black" }, { color: "Color/Paper" }],
        strokes: [{ color: "Color/Black", weight: 2 }],
      };
      const carrier = w.plain[0]!;
      const { work, undoSteps, result, added, restored } = await countedWrite(
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
      // STILL two batches, and that is the floor the rules allow, not a
      // conversion left undone: the carrier's bake record names its
      // layers by element id inside its JSON metadata, and a `$h:`
      // handle in text is stored as written, never resolved (measured,
      // `test/conformance/minted.spec.ts`). The record can only be
      // written once a first mutation has answered with the ids.
      expect(work.mutations).toEqual([
        { op: "batch", ops: 3 },
        { op: "batch", ops: 14 },
      ]);
      expect(undoSteps).toBe(2);
      // Three layers and their group, and both steps restore it.
      expect(added.sort()).toEqual(["group", "polygon", "polygon", "polygon"]);
      expect(restored).toBe(true);
      // What batch 1 minted comes off the engine's reply. As found: 2,
      // the before/after diff.
      expect(work.count("document.tree")).toBe(0);
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

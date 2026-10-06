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

// THE "WHAT DID MY WRITE CREATE" SEAM (`src/commands/minted.ts`).
//
// Three things are pinned here, in this order, because every one-batch
// flow in the bundle stands on them:
//
//  1. WHAT THE ENGINE'S `minted` CONTAINS, op by op — measured against
//     the booted engine through the raw client, with nothing of ours in
//     between. A flow reads its created ids out of this list by ORDER.
//  2. THE THREE LANES of `mutateMinting` answer the SAME thing for the
//     same batch, and what each one costs in tree reads.
//  3. THE BATCH RULES a flow that builds, replaces and groups in ONE
//     batch has to keep — the two that were known, and the one that
//     decides how many rebuilds one batch may carry.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type {
  BundleHost,
  ElementId,
  Mutation,
  MutationInput,
} from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import { drawBundle, stampDrawMetadata } from "../../src";
import {
  bindMinted,
  mintLaneOf,
  mintedIds,
  mutateMinting,
  type Minting,
} from "../../src/commands/minted";
import {
  batchMutationFor,
  bindCreatedMutationFor,
  handleElementId,
} from "../../src/commands/v59-wire";
import { F4_OVERLAP } from "../fixtures/corpus";
import { countingHost, type WorkLog } from "../perf/counting-host";
import { openHost } from "./host";
import {
  refusingBindCreated,
  treeShape,
  undoMarkOn,
  undoStepsBackTo,
  withMintedOutcome,
  withoutHatch,
  withoutMintedOutcome,
  withoutMintedReplies,
} from "./one-batch";

const PAGE = F4_OVERLAP.pageId;
const A = { kind: "polygon", id: F4_OVERLAP.ids.polygon! } as ElementId;

const corner = (x: number, y: number) => ({
  anchor: [x, y] as [number, number],
  left: [x, y] as [number, number],
  right: [x, y] as [number, number],
});
/** A closed 20 pt square at `x, y`. */
const square = (x: number, y: number, size = 20): MutationInput => ({
  op: "insertPath",
  args: {
    pageId: PAGE,
    anchors: [
      corner(x, y),
      corner(x + size, y),
      corner(x + size, y + size),
      corner(x, y + size),
    ],
    open: false,
  },
});
const bind = bindCreatedMutationFor;
const ref = (handle: string): ElementId => handleElementId(handle);
const group = (...memberIds: ElementId[]): MutationInput => ({
  op: "createGroup",
  args: { memberIds },
});
const dissolve = (id: ElementId): MutationInput => ({
  op: "dissolveGroup",
  args: { groupId: String(id.id) },
});
const remove = (id: ElementId | string): MutationInput => ({
  op: "deleteFrame",
  args: { frameId: typeof id === "string" ? id : String(id.id) },
});
const fill = (elementId: ElementId, value: string | null): MutationInput => ({
  op: "setElementProperty",
  args: { elementId, path: "frameFillColor", value: { type: "colorRef", value } },
});

/** The raw reply to a mutation — the engine's own words. */
interface RawApplied {
  kind: string;
  payload: {
    appliedSeq?: number;
    createdId?: ElementId | null;
    minted?: { handle: string | null; element: ElementId; storyId: string | null }[];
    error?: unknown;
  };
}

describe("draw conformance — the minted seam (what did my write create)", () => {
  let h: HeadlessHost;

  beforeAll(async () => {
    h = await openHost();
    await h.load(F4_OVERLAP.bytes());
    h.loadBundle(drawBundle);
  });
  // A fresh document per test: the ids below are the engine's own, and
  // they are only readable as a sequence when nothing came before.
  beforeEach(async () => {
    await h.load(F4_OVERLAP.bytes());
  });
  afterAll(() => h?.dispose());

  const raw = async (mutation: MutationInput): Promise<RawApplied> =>
    (await h.host.editor.client.mutate(mutation as Mutation)) as unknown as RawApplied;
  const batch = (...ops: MutationInput[]): MutationInput => batchMutationFor(ops);
  /** `handle=kind:id` per minted element, `-` for an unnamed one. */
  const listed = (reply: RawApplied): string[] =>
    (reply.payload.minted ?? []).map(
      (m) => `${m.handle ?? "-"}=${m.element.kind}:${String(m.element.id)}`,
    );

  describe("what the engine's `minted` contains (measured, engine 0.70.0)", () => {
    it("a SINGLE mutation lists nothing — its one creation is `createdId`", async () => {
      const reply = await raw(square(10, 10));
      expect(reply.kind).toBe("mutationApplied");
      // The key is there even when the list is empty: that is how the
      // seam tells an engine that HAS the list from one that predates it.
      expect("minted" in reply.payload).toBe(true);
      expect(reply.payload.minted).toEqual([]);
      expect(reply.payload.createdId).toEqual({ kind: "polygon", id: "uc" });
    });

    it("a batch lists one entry per creating child, in the order it wrote them", async () => {
      const reply = await raw(batch(square(10, 10), square(40, 10), square(70, 10)));
      expect(listed(reply)).toEqual(["-=polygon:uc", "-=polygon:ud", "-=polygon:ue"]);
      // `createdId` is the LAST of them — what the seam cross-checks a
      // list against before believing it is this mutation's.
      expect(reply.payload.createdId).toEqual({ kind: "polygon", id: "ue" });
    });

    it("a `createGroup` IS listed, as a group, where the batch made it", async () => {
      const reply = await raw(
        batch(
          square(10, 10),
          bind("a"),
          square(40, 10),
          bind("b"),
          fill(ref("a"), "Color/Black"),
          group(ref("a"), ref("b")),
        ),
      );
      // Engine 0.70.0 (core c7d9ccb): a batch that translates whole now
      // names each bound mint, as the mixed lane always did. The group
      // was not bound, so it stays unnamed.
      expect(listed(reply)).toEqual(["a=polygon:uc", "b=polygon:ud", "-=group:ue"]);
      expect(reply.payload.createdId).toEqual({ kind: "group", id: "ue" });
      expect(await treeShape(h)).toBe("ua ub ue[uc ud]");
    });

    it("`createSwatch` is not an element and is not listed", async () => {
      const reply = await raw(
        batch(
          {
            op: "createSwatch",
            args: {
              spec: {
                selfId: "Color/minted-probe",
                name: "#112233",
                space: "RGB",
                value: [17, 34, 51],
              },
            },
          },
          square(10, 10),
          bind("a"),
          fill(ref("a"), "Color/minted-probe"),
        ),
      );
      expect(listed(reply)).toEqual(["a=polygon:uc"]);
    });

    it("an element the SAME batch deletes again is STILL listed — minted is what was made, not what is left", async () => {
      const reply = await raw(
        batch(
          square(10, 10),
          bind("keep"),
          square(15, 15, 10),
          bind("absorbed"),
          remove("$h:absorbed"),
        ),
      );
      // …and THIS batch comes back with its handles named too. Before
      // engine 0.70.0 the translate-whole lane dropped its binds and
      // answered `null`; since core c7d9ccb both lanes name them. The
      // NAME stays a cross-check (older engines answer `null`); ORDER is
      // the contract.
      expect(listed(reply)).toEqual(["keep=polygon:uc", "absorbed=polygon:ud"]);
      expect(await treeShape(h)).toBe("ua ub uc");
    });

    it("a group the same batch dissolves again is still listed too", async () => {
      const reply = await raw(
        batch(
          square(10, 10),
          bind("a"),
          square(40, 10),
          bind("b"),
          group(ref("a"), ref("b")),
          bind("g"),
          { op: "dissolveGroup", args: { groupId: "$h:g" } },
        ),
      );
      expect(listed(reply).map((m) => m.split("=")[1])).toEqual([
        "polygon:uc",
        "polygon:ud",
        "group:ue",
      ]);
      expect(await treeShape(h)).toBe("ua ub uc ud");
    });

    it("a handle inside metadata TEXT is content: it is stored as written, never resolved", async () => {
      // Why a flow whose RECORD names the ids it created (the appearance
      // bake's `layers`, Image Trace's `regions`) cannot write that
      // record in the batch that creates them.
      const reply = await raw(
        batch(
          square(10, 10),
          bind("a"),
          stampDrawMetadata(ref("a"), {
            v: 1,
            data: { probe: { id: "$h:a", element: { kind: "polygon", id: "$h:a" } } },
          }),
        ),
      );
      const made = reply.payload.minted![0]!.element;
      expect(await h.host.document.getMetadata(made)).toEqual({
        v: 1,
        data: { probe: { id: "$h:a", element: { kind: "polygon", id: "$h:a" } } },
      });
    });
  });

  describe("mutateMinting — three lanes, one answer", () => {
    /** A batch with everything in it a flow uses: two kept paths, one
     *  absorbed contour, a group. */
    const build = (): MutationInput =>
      batch(
        square(10, 10),
        bind("p0"),
        square(15, 15, 10),
        bind("p0_hole"),
        square(40, 10),
        bind("p1"),
        remove("$h:p0_hole"),
        fill(ref("p0"), "Color/Black"),
        group(A, ref("p0"), ref("p1")),
      );

    /** Run `build()` through ONE counted view of a host, read what came
     *  back, undo it. The view is made once per test: the lane a host
     *  answers through is remembered per host OBJECT. */
    const run = async (counted: {
      host: BundleHost;
      work: WorkLog;
    }): Promise<{
      minting: Minting;
      bound: ReturnType<typeof bindMinted>;
      shape: string;
      undoSteps: number;
      reads: number;
    }> => {
      const mark = await undoMarkOn(h, A);
      counted.work.reset();
      const mutation = build();
      const minting = await mutateMinting(counted.host, mutation);
      const reads = counted.work.count("document.tree");
      const bound = bindMinted(minting, mutation);
      const shape = await treeShape(h);
      const undoSteps = await undoStepsBackTo(h, mark);
      return { minting, bound, shape, undoSteps, reads };
    };

    // Since plugin-sdk 0.2.38 the OUTCOME carries `minted` (RFI K-15),
    // so the headless host and the editor answer through the first lane.
    // The raw client is still listened to on the first write (nothing has
    // shown yet that the outcome carries the list) — and is not needed.
    it("OUTCOME (the headless host, and the editor, on plugin-sdk 0.2.38): the list off the outcome, no tree read", async () => {
      const before = await treeShape(h);
      const counted = countingHost(h.host);
      const { minting, bound, shape, undoSteps, reads } = await run(counted);
      expect(minting.lane).toBe("outcome");
      expect(mintLaneOf(counted.host)).toBe("outcome");
      expect(reads).toBe(0);
      // Everything minted, in order — the absorbed contour included.
      expect(mintedIds(minting).map((e) => `${e.kind}:${String(e.id)}`)).toEqual([
        "polygon:uc",
        "polygon:ud",
        "polygon:ue",
        "group:uf",
      ]);
      expect(Object.fromEntries(bound!.byHandle)).toEqual({
        p0: { kind: "polygon", id: "uc" },
        p0_hole: { kind: "polygon", id: "ud" },
        p1: { kind: "polygon", id: "ue" },
      });
      expect(bound!.groups).toEqual([{ kind: "group", id: "uf" }]);
      expect(shape).toBe("uf[ua uc ue] ub");
      expect(undoSteps).toBe(1);
      expect(await treeShape(h)).toBe(before);
      // Having answered through the outcome, the host no longer listens.
      const again = await run(counted);
      expect(again.minting.lane).toBe("outcome");
      expect(again.reads).toBe(0);
      expect(counted.work.count("editor.client.subscribe")).toBe(0);
    });

    it("REPLY (an SDK before 0.2.38, with the raw client): the list off the raw reply, no tree read", async () => {
      const before = await treeShape(h);
      const counted = countingHost(withoutMintedOutcome(h.host));
      const { minting, bound, shape, undoSteps, reads } = await run(counted);
      expect(minting.lane).toBe("reply");
      expect(mintLaneOf(counted.host)).toBe("reply");
      expect(reads).toBe(0);
      // Everything minted, in order — the absorbed contour included.
      expect(mintedIds(minting).map((e) => `${e.kind}:${String(e.id)}`)).toEqual([
        "polygon:uc",
        "polygon:ud",
        "polygon:ue",
        "group:uf",
      ]);
      expect(Object.fromEntries(bound!.byHandle)).toEqual({
        p0: { kind: "polygon", id: "uc" },
        p0_hole: { kind: "polygon", id: "ud" },
        p1: { kind: "polygon", id: "ue" },
      });
      expect(bound!.groups).toEqual([{ kind: "group", id: "uf" }]);
      expect(shape).toBe("uf[ua uc ue] ub");
      expect(undoSteps).toBe(1);
      expect(await treeShape(h)).toBe(before);
    });

    it("the write went through `document.mutate` — the facade's door, counted and gated", async () => {
      const { host, work } = countingHost(h.host);
      await mutateMinting(host, build());
      expect(work.mutations).toEqual([{ op: "batch", ops: 9 }]);
      // The hatch is LISTENED to, never written through.
      expect(work.count("editor.client.subscribe")).toBe(1);
      expect(work.count("editor.client.send")).toBe(0);
      expect(work.count("editor.client.mutate")).toBe(0);
    });

    it("OUTCOME with no raw client beside it: the same list, and the first write's one tree read", async () => {
      const host = countingHost(withMintedOutcome(h.host));
      const { minting, bound, undoSteps, reads } = await run(host);
      expect(minting.lane).toBe("outcome");
      // The first write on a host with no hatch reads the tree once, in
      // case the outcome says nothing; having learned it does, the next
      // reads nothing.
      expect(reads).toBe(1);
      expect(mintedIds(minting)).toHaveLength(4);
      expect(bound!.groups).toHaveLength(1);
      expect(undoSteps).toBe(1);
      const again = await run(host);
      expect(again.minting.lane).toBe("outcome");
      expect(again.reads).toBe(0);
      expect(Object.fromEntries(again.bound!.byHandle)).toEqual({
        p0: { kind: "polygon", id: "uc" },
        p0_hole: { kind: "polygon", id: "ud" },
        p1: { kind: "polygon", id: "ue" },
      });
    });

    it("DIFF (a host with neither — no raw client, an SDK before 0.2.38): two tree reads, and the same binding for everything that survived", async () => {
      const host = countingHost(withoutHatch(withoutMintedOutcome(h.host)));
      const { minting, bound, shape, undoSteps, reads } = await run(host);
      expect(minting.lane).toBe("diff");
      expect(reads).toBe(2);
      // What a tree can show: the two kept paths, then the group. The
      // absorbed contour was made and unmade inside the batch.
      expect(mintedIds(minting).map((e) => `${e.kind}:${String(e.id)}`)).toEqual([
        "polygon:uc",
        "polygon:ue",
        "group:uf",
      ]);
      expect(Object.fromEntries(bound!.byHandle)).toEqual({
        p0: { kind: "polygon", id: "uc" },
        p1: { kind: "polygon", id: "ue" },
      });
      expect(bound!.groups).toEqual([{ kind: "group", id: "uf" }]);
      expect(shape).toBe("uf[ua uc ue] ub");
      expect(undoSteps).toBe(1);
    });

    it("a hatch whose replies carry no list (and an outcome without one): found out ONCE, by stepping back and forward — then the diff lane", async () => {
      const counted = countingHost(withoutMintedReplies(withoutMintedOutcome(h.host)));
      const before = await treeShape(h);
      const mark = await undoMarkOn(h, A);
      const mutation = build();
      const first = await mutateMinting(counted.host, mutation);
      expect(first.lane).toBe("diff");
      expect(first.outcome.applied).toBe(true);
      // The batch had applied before anyone knew a "before" was needed:
      // one undo, the tree, one redo, the tree.
      expect(counted.work.count("document.undo")).toBe(1);
      expect(counted.work.count("document.redo")).toBe(1);
      expect(counted.work.count("document.tree")).toBe(2);
      expect(counted.work.mutations).toHaveLength(1);
      expect(Object.fromEntries(bindMinted(first, mutation)!.byHandle)).toEqual({
        p0: { kind: "polygon", id: "uc" },
        p1: { kind: "polygon", id: "ue" },
      });
      expect(await treeShape(h)).toBe("uf[ua uc ue] ub");
      // The step back and forward left ONE entry on the undo stack.
      expect(await undoStepsBackTo(h, mark)).toBe(1);
      expect(await treeShape(h)).toBe(before);

      // From here on this host reads its "before" up front: two reads, and
      // no more stepping back.
      const next = await run(counted);
      expect(next.minting.lane).toBe("diff");
      expect(next.reads).toBe(2);
      expect(counted.work.count("document.undo")).toBe(0);
      expect(next.undoSteps).toBe(1);
    });

    it("a REFUSED batch answers an empty list and leaves nothing behind, in every lane", async () => {
      const before = await treeShape(h);
      // The bind before its creating child — refused BY NAME.
      const early = batch(bind("x"), square(10, 10));
      for (const host of [
        h.host,
        withoutMintedOutcome(h.host),
        withoutHatch(withoutMintedOutcome(h.host)),
        withMintedOutcome(h.host),
      ]) {
        const minting = await mutateMinting(host, early);
        expect(minting.outcome.applied).toBe(false);
        expect(minting.minted).toEqual([]);
        expect(bindMinted(minting, early)).toBeNull();
        expect(JSON.stringify(minting.outcome)).toContain(
          "has nothing to name — no creating child ran before it in this batch",
        );
      }
      expect(await treeShape(h)).toBe(before);
    });

    it("a single mutation answers its one creation through the same door", async () => {
      const minting = await mutateMinting(h.host, square(10, 10));
      expect(mintedIds(minting)).toEqual([{ kind: "polygon", id: "uc" }]);
    });

    it("bindMinted REFUSES rather than mis-binds: an insert the batch did not name is a count it cannot explain", async () => {
      const unbound = batch(square(10, 10), square(40, 10), bind("b"));
      const minting = await mutateMinting(h.host, unbound);
      expect(minting.minted).toHaveLength(2);
      expect(bindMinted(minting, unbound)).toBeNull();
      // …and a group where the batch says a path is.
      const one = batch(square(70, 10), bind("p"));
      const told = (element: ElementId, handle: string | null): Minting => ({
        outcome: { applied: true, createdId: null, pageIds: [] },
        minted: [{ element, handle }],
        lane: "reply",
      });
      expect(bindMinted(told({ kind: "group", id: "g" } as ElementId, null), one)).toBeNull();
      // …and a name the engine reports differently from the batch's.
      expect(bindMinted(told({ kind: "polygon", id: "u1" } as ElementId, "q"), one)).toBeNull();
      expect(
        bindMinted(told({ kind: "polygon", id: "u1" } as ElementId, "p"), one)?.byHandle.get("p"),
      ).toEqual({ kind: "polygon", id: "u1" });
    });

    it("a host that refuses `bindCreated` is told apart from all of the above: the batch is REFUSED, not mis-read", async () => {
      const minting = await mutateMinting(refusingBindCreated(h.host), build());
      expect(minting.outcome.applied).toBe(false);
      expect(minting.minted).toEqual([]);
      expect(await treeShape(h)).toBe("ua ub");
    });
  });

  // The rules a flow that replaces what it built has to keep. The first
  // two were known (CLAUDE.md, "Two batch-ORDERING rules"); they are
  // re-measured here with their exact sentences because the one-batch
  // flows now put inserts, deletes and groups in the SAME batch. The
  // rest is what decides how many REBUILDS one batch may carry — and it
  // is the engine's, not this bundle's.
  describe("the batch rules a build-replace-group flow keeps (measured)", () => {
    /** A grouped pair at `x`, built the way a flow builds one. */
    const pair = async (x: number): Promise<[ElementId, ElementId, ElementId]> => {
      const reply = await raw(
        batch(square(x, 200), bind("a"), square(x + 25, 200), bind("b"), group(ref("a"), ref("b"))),
      );
      const [a, b, g] = reply.payload.minted!.map((m) => m.element);
      return [a!, b!, g!];
    };
    const fresh = (i: number, x: number): MutationInput[] => [
      square(x, 230),
      bind(`n${i}_0`),
      square(x + 25, 230),
      bind(`n${i}_1`),
    ];
    const refusal = (reply: RawApplied): string =>
      reply.kind === "mutationFailed" ? JSON.stringify(reply.payload.error) : "";

    it("a batch that DELETES then INSERTS is refused — inserts go first", async () => {
      const one = await raw(square(10, 200));
      const reply = await raw(batch(remove(one.payload.createdId!), square(40, 200), bind("x")));
      // The insert's z-position was resolved against the spread as the
      // batch FOUND it — one item longer than it is by the time it lands.
      expect(refusal(reply)).toMatch(
        /frame mutation failed: batch failed at index 1: position 3 out of range for parent Spread\(\\"us\\"\) \(len 2\)/,
      );
    });

    // ENGINE DEFECT (0.65.0), pinned so it fails when fixed. On 0.64.0 this
    // batch was REFUSED ("group has an id-less member that cannot
    // round-trip"). On 0.65.0 it APPLIES — and its ONE undo step does not
    // bring the group or its members back. So the rule stands, for a new
    // reason: dissolve BEFORE deleting members, which every flow here does.
    it("ENGINE DEFECT — deleting a group's members BEFORE dissolving it applies, and its undo does not restore them", async () => {
      const [a, b, g] = await pair(40);
      const before = await treeShape(h);
      expect(before).toBe("ua ub ue[uc ud]");
      const reply = await raw(batch(remove(a), remove(b), dissolve(g)));
      expect(reply.kind).toBe("mutationApplied");
      expect(await treeShape(h)).toBe("ua ub");
      await h.host.document.undo();
      expect(await treeShape(h)).toBe("ua ub"); // not `before`
    });

    it("ONE rebuild in one batch: insert, dissolve, delete, group — one undo, exactly restored", async () => {
      const [a, b, g] = await pair(40);
      const before = await treeShape(h);
      const reply = await raw(
        batch(...fresh(0, 40), dissolve(g), remove(a), remove(b), group(ref("n0_0"), ref("n0_1"))),
      );
      expect(reply.kind).toBe("mutationApplied");
      expect(await treeShape(h)).toBe("ua ub u11[uf u10]");
      await h.host.document.undo();
      expect(await treeShape(h)).toBe(before);
    });

    it("SEVERAL rebuilds in one batch work in ONE order: every insert, every dissolve, every delete, then every group", async () => {
      const old = [await pair(40), await pair(100), await pair(160)];
      const before = await treeShape(h);
      expect(before).toBe("ua ub ue[uc ud] u11[uf u10] u14[u12 u13]");
      const reply = await raw(
        batch(
          ...old.flatMap((_, i) => fresh(i, 40 + i * 60)),
          ...old.map(([, , g]) => dissolve(g)),
          ...old.flatMap(([a, b]) => [remove(a), remove(b)]),
          ...old.map((_, i) => group(ref(`n${i}_0`), ref(`n${i}_1`))),
        ),
      );
      expect(reply.kind).toBe("mutationApplied");
      expect(await treeShape(h)).toBe("ua ub u1b[u15 u16] u1c[u17 u18] u1d[u19 u1a]");
      // ONE undo step, and it puts back exactly what was there.
      await h.host.document.undo();
      expect(await treeShape(h)).toBe(before);
      await h.host.document.redo();
      expect(await treeShape(h)).toBe("ua ub u1b[u15 u16] u1c[u17 u18] u1d[u19 u1a]");
    });

    it("…and, since 0.65.0, rebuild by rebuild too: interleaved, the batch applies, the document is right and one undo restores it", async () => {
      // On 0.64.0 this APPLIED and was wrong — an EMPTY group, two paths
      // in no tree, and an undo that did not put the document back. The
      // flows keep the grouped order above (it is what every engine
      // accepts); this pins that the interleaved one is no longer a trap.
      const [a1, b1, g1] = await pair(40);
      const [a2, b2, g2] = await pair(100);
      const before = await treeShape(h);
      const reply = await raw(
        batch(
          ...fresh(0, 40),
          ...fresh(1, 100),
          dissolve(g1),
          remove(a1),
          remove(b1),
          group(ref("n0_0"), ref("n0_1")),
          dissolve(g2),
          remove(a2),
          remove(b2),
          group(ref("n1_0"), ref("n1_1")),
        ),
      );
      expect(reply.kind).toBe("mutationApplied");
      expect(await treeShape(h)).toBe("ua ub u16[u12 u13] u17[u14 u15]");
      await h.host.document.undo();
      expect(await treeShape(h)).toBe(before);
    });

    // FIXED in 0.65.0 — a delete below a group no longer breaks that
    // group. On 0.64.0 a page item deleted BELOW a group in z-order left
    // the group's member references pointing one slot too high: a plain
    // deleteFrame dropped a member out of every tree, and a rebuild under
    // a bystander group was refused ("a member already belongs to another
    // group"). Every deleting flow here inherited it. Both now hold.
    describe("FIXED in 0.65.0 — a delete below a group leaves that group whole", () => {
      it("a single deleteFrame under a bystander group: the group keeps both members, and one undo restores", async () => {
        const below = (await raw(square(10, 200))).payload.createdId!;
        const [, , g] = await pair(100);
        const before = await treeShape(h);
        expect(before).toBe(`ua ub uc ${String(g.id)}[ud ue]`);
        expect((await raw(remove(below))).kind).toBe("mutationApplied");
        expect(await treeShape(h)).toBe(`ua ub ${String(g.id)}[ud ue]`);
        await h.host.document.undo();
        expect(await treeShape(h)).toBe(before);
      });

      it("a rebuild under a bystander group applies, leaves the bystander alone, and one undo restores", async () => {
        const [a, b, g] = await pair(40);
        await pair(100); // the bystander, above
        const before = await treeShape(h);
        expect(before).toBe("ua ub ue[uc ud] u11[uf u10]");
        const reply = await raw(
          batch(...fresh(0, 40), dissolve(g), remove(a), remove(b), group(ref("n0_0"), ref("n0_1"))),
        );
        expect(reply.kind).toBe("mutationApplied");
        expect(await treeShape(h)).toBe("ua ub u11[uf u10] u14[u12 u13]");
        await h.host.document.undo();
        expect(await treeShape(h)).toBe(before);
      });
    });
  });
});

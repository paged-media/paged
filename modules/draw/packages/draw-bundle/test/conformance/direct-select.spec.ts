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

// Conformance — the DIRECT SELECTION machine's plans against the REAL
// engine. The machine's own spec (draw-tools) proves what a plan SAYS;
// this proves what it DOES: each test feeds the machine the engine's
// live `pathAnchors`, drives a gesture, lowers the committed plan with
// the machine's own `directSelectMutation`, sends that ONE batch through
// `host.document.mutate`, and reads the anchor table back.
//
// Three things are asserted on every gesture, because each is a way a
// path edit goes wrong that a unit test cannot see:
//   · the table the engine now holds is the table the machine previewed;
//   · the anchors the gesture did NOT name are byte-identical (the
//     wrong-node symptom: an index that lands one off moves a neighbour);
//   · ONE undo restores the original table exactly — a plan of five ops
//     is one step, not five.
//
// What is NOT replayed: pointer events through the editor's gesture
// spine (B-17, the same boundary `test/replay.ts` names). The hit
// description is the host's job, so the specs state it directly.

import { describe, expect, it, beforeAll, afterAll } from "vitest";

import type { ElementId, PathAnchorsResult } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";
import { evalCubic } from "@paged-media/draw-geometry";
import {
  DirectSelectMachine,
  directSelectMutation,
  type DirectSelectHit,
  type DirectSelectSnapshot,
} from "@paged-media/draw-tools";

import { F2_CLOSED_QUAD } from "../fixtures/corpus";
import { SCALED_SQUARE, SMOOTH_ARCH, TWO_CONTOURS } from "../fixtures/path-edit";
import { openHost } from "./host";

type P = [number, number];

const NONE = { shift: false, alt: false };
const SHIFT = { shift: true, alt: false };
const ALT = { shift: false, alt: true };

const polygon = (id: string): ElementId => ({ kind: "polygon", id }) as ElementId;

const anchorHit = (index: number): DirectSelectHit => ({ kind: "anchor", index });
const handleHit = (index: number, side: "left" | "right"): DirectSelectHit => ({
  kind: "handle",
  index,
  side,
});
const segmentHit = (index: number, t: number): DirectSelectHit => ({ kind: "segment", index, t });

/** The three fields a path edit can change, as the engine reports them. */
interface Table {
  anchors: PathAnchorsResult["anchors"];
  subpathStarts: number[];
  subpathOpen: boolean[] | undefined;
}

describe("draw conformance — Direct Selection plans through the real engine", () => {
  let h: HeadlessHost;
  beforeAll(async () => {
    h = await openHost();
  });
  afterAll(() => h?.dispose());

  async function read(el: ElementId): Promise<PathAnchorsResult> {
    const reply = await h.host.document.pathAnchors(el);
    if (!reply) throw new Error(`no path anchors for ${JSON.stringify(el)}`);
    return reply;
  }

  async function tableOf(el: ElementId): Promise<Table> {
    const r = await read(el);
    return { anchors: r.anchors, subpathStarts: r.subpathStarts, subpathOpen: r.subpathOpen };
  }

  /** A machine seated on the engine's live table — exactly what the
   *  editor shim does: the reply's table and its item transform. */
  async function machineOn(el: ElementId, selection: number[] = []) {
    const reply = await read(el);
    return new DirectSelectMachine({
      table: reply,
      transform: reply.itemTransform ?? null,
      slop: 2,
      nudgeStep: 1,
      selection,
    });
  }

  function drag(
    m: DirectSelectMachine,
    from: P,
    to: P,
    hit: DirectSelectHit,
    modifiers = NONE,
  ): DirectSelectSnapshot {
    m.handle({ type: "down", point: from, hit, modifiers: NONE });
    m.handle({ type: "move", point: to, modifiers });
    return m.handle({ type: "up", point: to, modifiers });
  }

  /** Send a committed plan as its ONE batch and assert it applied. */
  async function send(el: ElementId, snap: DirectSelectSnapshot): Promise<void> {
    expect(snap.commit, "the gesture committed a plan").not.toBeNull();
    const mutation = directSelectMutation(snap.commit!, el);
    expect(mutation.op).toBe("batch");
    const outcome = await h.host.document.mutate(mutation);
    expect(outcome.applied, JSON.stringify(outcome)).toBe(true);
  }

  /** ONE undo, then the table must be the original — all of it. */
  async function expectOneUndoRestores(el: ElementId, original: Table): Promise<void> {
    await h.host.document.undo();
    expect(await tableOf(el)).toEqual(original);
  }

  describe("dragging an anchor — the closed quad", () => {
    const el = polygon(F2_CLOSED_QUAD.ids.polygon!);
    beforeAll(async () => {
      await h.load(F2_CLOSED_QUAD.bytes());
    });

    it("moves anchor 2 and ONLY anchor 2; one undo restores the table", async () => {
      const before = await tableOf(el);
      expect(before.anchors.map((a) => a.anchor)).toEqual([
        [100, 100],
        [300, 100],
        [300, 300],
        [100, 300],
      ]);
      const m = await machineOn(el);
      const snap = drag(m, [300, 300], [330, 290], anchorHit(2));
      await send(el, snap);

      const after = await tableOf(el);
      // The dragged anchor, handles and all, is where the preview put it.
      expect(after.anchors[2]).toEqual({ anchor: [330, 290], left: [330, 290], right: [330, 290] });
      expect(after.anchors[2]).toEqual(snap.table.anchors[2]);
      // THE WRONG-NODE SYMPTOM: every other anchor is byte-identical.
      for (const i of [0, 1, 3]) {
        expect(JSON.stringify(after.anchors[i]), `anchor ${i}`).toBe(
          JSON.stringify(before.anchors[i]),
        );
      }
      expect(after.subpathStarts).toEqual(before.subpathStarts);
      expect(after.subpathOpen).toEqual(before.subpathOpen);

      await expectOneUndoRestores(el, before);
    });

    it("moves a two-anchor selection in one batch, and one undo brings both back", async () => {
      const before = await tableOf(el);
      const m = await machineOn(el, [0, 1]);
      const snap = drag(m, [300, 100], [310, 60], anchorHit(1));
      expect(snap.commit!.ops).toHaveLength(2);
      await send(el, snap);

      const after = await tableOf(el);
      expect(after.anchors.map((a) => a.anchor)).toEqual([
        [110, 60],
        [310, 60],
        [300, 300],
        [100, 300],
      ]);
      for (const i of [2, 3]) {
        expect(JSON.stringify(after.anchors[i])).toBe(JSON.stringify(before.anchors[i]));
      }
      await expectOneUndoRestores(el, before);
    });

    it("reshapes a dragged segment: the grabbed point lands where the pointer went", async () => {
      const before = await tableOf(el);
      const m = await machineOn(el);
      // The top edge (100,100)→(300,100) at t = ½, pulled 30 up.
      const snap = drag(m, [200, 100], [200, 70], segmentHit(0, 0.5));
      await send(el, snap);

      const after = await tableOf(el);
      const [s, e] = after.anchors;
      const mid = evalCubic(s.anchor, s.right, e.left, e.anchor, 0.5);
      expect(mid[0]).toBeCloseTo(200, 4);
      expect(mid[1]).toBeCloseTo(70, 4);
      // Only the segment's two INNER handles changed.
      expect(s.anchor).toEqual([100, 100]);
      expect(s.left).toEqual([100, 100]);
      expect(s.right).toEqual([100, 60]);
      expect(e.left).toEqual([300, 60]);
      expect(e.right).toEqual([300, 100]);
      for (const i of [2, 3]) {
        expect(JSON.stringify(after.anchors[i])).toBe(JSON.stringify(before.anchors[i]));
      }
      await expectOneUndoRestores(el, before);
    });

    it("the CLOSING segment wraps: anchor 3's outgoing handle and anchor 0's incoming one", async () => {
      const before = await tableOf(el);
      const m = await machineOn(el);
      // (100,300)→(100,100), pulled 30 left at its midpoint.
      const snap = drag(m, [100, 200], [70, 200], segmentHit(3, 0.5));
      await send(el, snap);

      const after = await tableOf(el);
      expect(after.anchors[3].right).toEqual([60, 300]);
      expect(after.anchors[0].left).toEqual([60, 100]);
      // Nothing else — in particular not anchor 0's OUTGOING handle.
      expect(after.anchors[0].right).toEqual([100, 100]);
      expect(after.anchors[3].left).toEqual([100, 300]);
      for (const i of [1, 2]) {
        expect(JSON.stringify(after.anchors[i])).toBe(JSON.stringify(before.anchors[i]));
      }
      await expectOneUndoRestores(el, before);
    });

    it("a Shift-constrained drag sends the constrained position", async () => {
      const before = await tableOf(el);
      const m = await machineOn(el);
      // 40 across, 3 down: Shift holds it on the horizontal.
      const snap = drag(m, [100, 100], [140, 103], anchorHit(0), SHIFT);
      await send(el, snap);
      const after = await tableOf(el);
      expect(after.anchors[0].anchor[1]).toBeCloseTo(100, 4);
      expect(after.anchors[0].anchor[0]).toBeCloseTo(100 + Math.hypot(40, 3), 4);
      await expectOneUndoRestores(el, before);
    });

    it("each arrow-key nudge is its own undo step", async () => {
      const before = await tableOf(el);
      const m = await machineOn(el, [1, 2]);
      for (let i = 0; i < 3; i++) {
        await send(el, m.handle({ type: "key", key: "ArrowRight", modifiers: NONE }));
      }
      await send(el, m.handle({ type: "key", key: "ArrowUp", modifiers: SHIFT }));
      const after = await tableOf(el);
      expect(after.anchors.map((a) => a.anchor)).toEqual([
        [100, 100],
        [303, 90],
        [303, 290],
        [100, 300],
      ]);
      // The machine kept its own table in step across four plans.
      expect(m.snapshot().table.anchors).toEqual(after.anchors);
      // Four plans, four steps: one undo takes back only the Shift-Up.
      await h.host.document.undo();
      expect((await tableOf(el)).anchors[1].anchor).toEqual([303, 100]);
      for (let i = 0; i < 3; i++) await h.host.document.undo();
      expect(await tableOf(el)).toEqual(before);
    });

    it("Delete removes the selected anchors in one step", async () => {
      const before = await tableOf(el);
      const m = await machineOn(el, [1, 3]);
      const snap = m.handle({ type: "key", key: "Delete", modifiers: NONE });
      expect(snap.commit!.ops).toEqual([
        { op: "pathPointRemove", index: 3 },
        { op: "pathPointRemove", index: 1 },
      ]);
      await send(el, snap);
      const after = await tableOf(el);
      // The survivors are anchors 0 and 2, untouched.
      expect(after.anchors).toEqual([before.anchors[0], before.anchors[2]]);
      expect(after.anchors).toEqual(snap.table.anchors);
      await expectOneUndoRestores(el, before);
    });

    it("a refused Delete and a cancelled drag send nothing", async () => {
      const before = await tableOf(el);
      const m = await machineOn(el, [0, 1, 2]);
      const refused = m.handle({ type: "key", key: "Delete", modifiers: NONE });
      expect(refused.commit).toBeNull();
      expect(refused.refusal).toEqual({ reason: "contourFloor", contours: [0] });
      m.handle({ type: "down", point: [100, 100], hit: anchorHit(0), modifiers: NONE });
      m.handle({ type: "move", point: [150, 150], modifiers: NONE });
      expect(m.handle({ type: "key", key: "Escape", modifiers: NONE }).commit).toBeNull();
      expect(m.handle({ type: "up", point: [150, 150], modifiers: NONE }).commit).toBeNull();
      // No plan ⇒ nothing was sent ⇒ the document is as it was.
      expect(await tableOf(el)).toEqual(before);
    });
  });

  describe("handles — the smooth arch", () => {
    const el = polygon(SMOOTH_ARCH.id);
    beforeAll(async () => {
      await h.load(SMOOTH_ARCH.bytes());
    });

    it("an anchor drag carries its handles — with ONE op, the engine doing the rest", async () => {
      const before = await tableOf(el);
      expect(before.anchors[1]).toEqual({ anchor: [200, 200], left: [160, 200], right: [280, 200] });
      const m = await machineOn(el);
      const snap = drag(m, [200, 200], [210, 220], anchorHit(1));
      expect(snap.commit!.ops).toEqual([
        { op: "pathPointSet", index: 1, role: "anchor", position: [210, 220] },
      ]);
      await send(el, snap);
      const after = await tableOf(el);
      expect(after.anchors[1]).toEqual({ anchor: [210, 220], left: [170, 220], right: [290, 220] });
      expect(after.anchors[1]).toEqual(snap.table.anchors[1]);
      for (const i of [0, 2]) {
        expect(JSON.stringify(after.anchors[i])).toBe(JSON.stringify(before.anchors[i]));
      }
      await expectOneUndoRestores(el, before);
    });

    it("a paired handle drag swings BOTH handles; the opposite keeps its length", async () => {
      const before = await tableOf(el);
      const m = await machineOn(el);
      // The right handle (80 long) swung straight down.
      const snap = drag(m, [280, 200], [200, 280], handleHit(1, "right"));
      expect(snap.commit!.ops).toHaveLength(2);
      await send(el, snap);
      const after = await tableOf(el);
      // The left one is now straight up, still 40 long.
      expect(after.anchors[1]).toEqual({ anchor: [200, 200], left: [200, 160], right: [200, 280] });
      for (const i of [0, 2]) {
        expect(JSON.stringify(after.anchors[i])).toBe(JSON.stringify(before.anchors[i]));
      }
      // Two ops, ONE step.
      await expectOneUndoRestores(el, before);
    });

    it("Alt drags one handle and leaves the other where it was", async () => {
      const before = await tableOf(el);
      const m = await machineOn(el);
      const snap = drag(m, [280, 200], [200, 280], handleHit(1, "right"), ALT);
      expect(snap.commit!.ops).toHaveLength(1);
      await send(el, snap);
      const after = await tableOf(el);
      expect(after.anchors[1]).toEqual({ anchor: [200, 200], left: [160, 200], right: [200, 280] });
      await expectOneUndoRestores(el, before);
    });

    it("a re-seated machine sees the engine's table as its own preview", async () => {
      const before = await tableOf(el);
      const m = await machineOn(el);
      const snap = drag(m, [280, 200], [213, 247], handleHit(1, "right"));
      await send(el, snap);
      // The engine stores f32; the machine previewed in f64. After a
      // sync the machine holds the engine's numbers — and they are the
      // preview's, to f32 precision.
      const synced = m.sync(await read(el));
      synced.table.anchors.forEach((a, i) => {
        for (const role of ["anchor", "left", "right"] as const) {
          expect(a[role][0]).toBeCloseTo(snap.table.anchors[i][role][0], 3);
          expect(a[role][1]).toBeCloseTo(snap.table.anchors[i][role][1], 3);
        }
      });
      await expectOneUndoRestores(el, before);
    });
  });

  describe("subpaths — one element, two contours", () => {
    const el = polygon(TWO_CONTOURS.id);
    beforeAll(async () => {
      await h.load(TWO_CONTOURS.bytes());
    });

    it("the engine reports flat indices with per-contour starts", async () => {
      const t = await tableOf(el);
      expect(t.anchors).toHaveLength(6);
      expect(t.subpathStarts).toEqual([0, 3]);
      expect(t.subpathOpen).toEqual([false, true]);
    });

    it("a drag in the SECOND contour addresses its flat index", async () => {
      const before = await tableOf(el);
      const m = await machineOn(el);
      const snap = drag(m, [400, 200], [410, 240], anchorHit(4));
      await send(el, snap);
      const after = await tableOf(el);
      expect(after.anchors[4].anchor).toEqual([410, 240]);
      for (const i of [0, 1, 2, 3, 5]) {
        expect(JSON.stringify(after.anchors[i]), `anchor ${i}`).toBe(
          JSON.stringify(before.anchors[i]),
        );
      }
      expect(after.subpathStarts).toEqual([0, 3]);
      await expectOneUndoRestores(el, before);
    });

    it("the triangle's closing segment wraps inside ITS contour, not into the next", async () => {
      const before = await tableOf(el);
      const m = await machineOn(el);
      // Anchor 2 (150,200) → anchor 0 (100,100), midpoint pulled left.
      const snap = drag(m, [125, 150], [95, 150], segmentHit(2, 0.5));
      await send(el, snap);
      const after = await tableOf(el);
      expect(after.anchors[2].right).toEqual([110, 200]);
      expect(after.anchors[0].left).toEqual([60, 100]);
      // Anchor 3 — the NEXT contour's first, and flat-adjacent to
      // anchor 2 — did not move.
      for (const i of [1, 3, 4, 5]) {
        expect(JSON.stringify(after.anchors[i]), `anchor ${i}`).toBe(
          JSON.stringify(before.anchors[i]),
        );
      }
      await expectOneUndoRestores(el, before);
    });

    it("Delete across contours: the engine's starts match the machine's", async () => {
      const before = await tableOf(el);
      const m = await machineOn(el, [1, 4]);
      const snap = m.handle({ type: "key", key: "Delete", modifiers: NONE });
      await send(el, snap);
      const after = await tableOf(el);
      expect(after.anchors).toEqual([
        before.anchors[0],
        before.anchors[2],
        before.anchors[3],
        before.anchors[5],
      ]);
      expect(after.subpathStarts).toEqual([0, 2]);
      expect(after.subpathStarts).toEqual([...snap.table.subpathStarts]);
      expect(after.subpathOpen).toEqual([false, true]);
      await expectOneUndoRestores(el, before);
    });

    it("the floor refuses before the engine is asked", async () => {
      const before = await tableOf(el);
      // Two of the open run's three anchors: it would keep one.
      const m = await machineOn(el, [3, 4]);
      const snap = m.handle({ type: "key", key: "Delete", modifiers: NONE });
      expect(snap.refusal).toEqual({ reason: "contourFloor", contours: [1] });
      expect(snap.commit).toBeNull();
      expect(await tableOf(el)).toEqual(before);
    });
  });

  describe("coordinate spaces — a scaled element", () => {
    const el = polygon(SCALED_SQUARE.id);
    beforeAll(async () => {
      await h.load(SCALED_SQUARE.bytes());
    });

    it("the engine reports the item transform beside inner-space anchors", async () => {
      const reply = await read(el);
      expect(reply.itemTransform).toEqual([...SCALED_SQUARE.transform]);
      expect(reply.anchors[1].anchor).toEqual([100, 0]);
    });

    it("a drag in PAGE space is written in the path's INNER space", async () => {
      const before = await tableOf(el);
      const m = await machineOn(el);
      // Inner (100, 0) shows at page (250, 60).
      expect(m.snapshot().table.anchors[1].anchor).toEqual([250, 60]);
      const snap = drag(m, [250, 60], [270, 100], anchorHit(1));
      expect(snap.table.anchors[1].anchor).toEqual([270, 100]);
      await send(el, snap);
      const after = await read(el);
      // 20 across and 40 down on the page is 10 and 20 in a ×2 element.
      expect(after.anchors[1].anchor).toEqual([110, 20]);
      // The transform itself was not touched: a path edit moves points.
      expect(after.itemTransform).toEqual([...SCALED_SQUARE.transform]);
      for (const i of [0, 2, 3]) {
        expect(JSON.stringify(after.anchors[i])).toBe(JSON.stringify(before.anchors[i]));
      }
      await expectOneUndoRestores(el, before);
    });

    it("a marquee is a page-space rectangle and selects by where anchors SHOW", async () => {
      const m = await machineOn(el);
      // Around page (250, 260) — inner (100, 100), anchor 2.
      m.handle({ type: "down", point: [240, 250], hit: { kind: "empty" }, modifiers: NONE });
      const snap = m.handle({ type: "up", point: [260, 270], modifiers: NONE });
      expect(snap.selected).toEqual([2]);
      expect(snap.commit).toBeNull();
    });
  });
});

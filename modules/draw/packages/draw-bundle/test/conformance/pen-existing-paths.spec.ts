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

// Conformance — the PEN on existing paths, against the REAL engine:
// continue an open path from either end, close it onto its own other
// endpoint, join another open path, extend a path with a fresh run, and
// the add / delete anchor clicks. Each test drives the machine with the
// engine's live `pathAnchors`, lowers the plan with the machine's own
// `penPlanMutation`, sends that ONE mutation, and reads the table back —
// then proves ONE undo takes all of it away again.
//
// TWO ENGINE BEHAVIOURS ARE PINNED HERE ON PURPOSE, because the plans
// are shaped around them and would be wrong the day they change:
//
//   · `pathPointInsert` AT a contour boundary files the anchor into the
//     FOLLOWING contour unless the post-insert starts ride along
//     (`prevSubpathStarts`);
//   · `joinPaths` welds the NEAREST pair of ends — it has no way to be
//     told which ends were picked.
//
// Both have a "this is what happens WITHOUT the plan's workaround" test
// next to the "this is what the plan does" test.

import { describe, expect, it, beforeAll, afterAll } from "vitest";

import type {
  ElementId,
  Mutation,
  MutationOutcome,
  PathAnchorsResult,
} from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";
import {
  PenMachine,
  penPlanMutation,
  type PenHit,
  type PenPath,
  type PenPlan,
  type PenSnapshot,
} from "@paged-media/draw-tools";

import { OPEN_THEN_CLOSED, PATH_EDIT_PAGE, PEN_PAIR } from "../fixtures/path-edit";
import { openHost } from "./host";

type P = [number, number];

const NONE = { shift: false, alt: false };

const A: ElementId = { kind: "polygon", id: PEN_PAIR.a } as ElementId;
const B: ElementId = { kind: "graphicLine", id: PEN_PAIR.b } as ElementId;

describe("draw conformance — Pen plans on existing paths, through the real engine", () => {
  let h: HeadlessHost;
  beforeAll(async () => {
    h = await openHost();
  });
  afterAll(() => h?.dispose());

  const read = (el: ElementId): Promise<PathAnchorsResult | null> =>
    h.host.document.pathAnchors(el);

  async function tableOf(el: ElementId) {
    const r = await read(el);
    if (!r) throw new Error(`no path anchors for ${JSON.stringify(el)}`);
    return { anchors: r.anchors, subpathStarts: r.subpathStarts, subpathOpen: r.subpathOpen };
  }

  /** The path as the host would hand it to the machine: the engine's
   *  reply, verbatim. */
  async function pathOf(el: ElementId, selected = false): Promise<PenPath> {
    const r = await read(el);
    if (!r) throw new Error(`no path anchors for ${JSON.stringify(el)}`);
    return { id: el, table: r, transform: r.itemTransform ?? null, selected };
  }

  const anchorHit = (path: PenPath, index: number): PenHit => ({ kind: "anchor", path, index });

  const pen = () => new PenMachine({ closeTolerance: 4, dragThreshold: 2 });

  function click(m: PenMachine, point: P, hit?: PenHit): PenSnapshot {
    m.handle({ type: "down", point, modifiers: NONE, ...(hit ? { hit } : {}) });
    return m.handle({ type: "up", point, modifiers: NONE });
  }

  async function send(plan: PenPlan | null): Promise<MutationOutcome> {
    expect(plan, "the gesture committed a plan").not.toBeNull();
    const outcome = await h.host.document.mutate(penPlanMutation(plan!, PATH_EDIT_PAGE));
    expect(outcome.applied, JSON.stringify(outcome)).toBe(true);
    return outcome;
  }

  const positions = (t: { anchors: PathAnchorsResult["anchors"] }) => t.anchors.map((a) => a.anchor);

  describe("continue / close — two open paths", () => {
    beforeAll(async () => {
      await h.load(PEN_PAIR.bytes());
    });

    it("the fixture: A is an open three-anchor path", async () => {
      const t = await tableOf(A);
      expect(positions(t)).toEqual([
        [100, 400],
        [250, 600],
        [400, 400],
      ]);
      expect(t.subpathOpen?.[0]).toBe(true);
    });

    it("continuing from the END appends; one undo removes every added anchor", async () => {
      const before = await tableOf(A);
      const m = pen();
      click(m, [400, 400], anchorHit(await pathOf(A), 2));
      click(m, [450, 300]);
      click(m, [500, 350]);
      const snap = m.handle({ type: "key", key: "Enter" });
      expect(snap.plan!.kind).toBe("continue");
      await send(snap.plan);
      const after = await tableOf(A);
      expect(positions(after)).toEqual([
        [100, 400],
        [250, 600],
        [400, 400],
        [450, 300],
        [500, 350],
      ]);
      // Still ONE open contour, and the old anchors are untouched.
      expect(after.subpathOpen?.[0]).toBe(true);
      expect(after.anchors.slice(0, 3)).toEqual(before.anchors);
      await h.host.document.undo();
      expect(await tableOf(A)).toEqual(before);
    });

    it("continuing from the START prepends, and the handles follow the new direction", async () => {
      const before = await tableOf(A);
      const m = pen();
      click(m, [100, 400], anchorHit(await pathOf(A), 0));
      // Dragged: onward handle to (30, 280), the incoming one mirrors.
      m.handle({ type: "down", point: [50, 300], modifiers: NONE });
      m.handle({ type: "move", point: [30, 280], modifiers: NONE });
      m.handle({ type: "up", point: [30, 280], modifiers: NONE });
      click(m, [20, 200]);
      await send(m.handle({ type: "key", key: "Enter" }).plan);
      const after = await tableOf(A);
      expect(positions(after)).toEqual([
        [20, 200],
        [50, 300],
        [100, 400],
        [250, 600],
        [400, 400],
      ]);
      // The path now runs (20,200) → (50,300) → (100,400): the handle
      // that led ONWARD while drawing is the anchor's INCOMING one.
      expect(after.anchors[1]).toEqual({ anchor: [50, 300], left: [30, 280], right: [70, 320] });
      expect(after.anchors.slice(2)).toEqual(before.anchors);
      await h.host.document.undo();
      expect(await tableOf(A)).toEqual(before);
    });

    it("a handle pulled off the picked-up endpoint is written with the inserts, in one step", async () => {
      const before = await tableOf(A);
      const m = pen();
      m.handle({ type: "down", point: [400, 400], modifiers: NONE, hit: anchorHit(await pathOf(A), 2) });
      m.handle({ type: "move", point: [440, 380], modifiers: NONE });
      m.handle({ type: "up", point: [440, 380], modifiers: NONE });
      click(m, [500, 350]);
      await send(m.handle({ type: "key", key: "Enter" }).plan);
      const after = await tableOf(A);
      expect(after.anchors[2]).toEqual({ anchor: [400, 400], left: [400, 400], right: [440, 380] });
      expect(after.anchors[3].anchor).toEqual([500, 350]);
      await h.host.document.undo();
      expect(await tableOf(A)).toEqual(before);
    });

    it("ending on its own other endpoint closes the path; one undo reopens it", async () => {
      const before = await tableOf(A);
      const path = await pathOf(A);
      const m = pen();
      click(m, [400, 400], anchorHit(path, 2));
      click(m, [250, 300]);
      const snap = click(m, [100, 400], anchorHit(path, 0));
      expect(snap.plan!.kind).toBe("close");
      await send(snap.plan);
      const after = await tableOf(A);
      expect(positions(after)).toEqual([
        [100, 400],
        [250, 600],
        [400, 400],
        [250, 300],
      ]);
      expect(after.subpathOpen?.[0] ?? false).toBe(false);
      // The inserts AND the close are one step.
      await h.host.document.undo();
      expect(await tableOf(A)).toEqual(before);
    });

    it("a new run that ends on an open endpoint extends that path", async () => {
      const before = await tableOf(A);
      const m = pen();
      click(m, [550, 100]);
      click(m, [480, 250]);
      const snap = click(m, [400, 400], anchorHit(await pathOf(A), 2));
      expect(snap.plan!.kind).toBe("extend");
      // Nothing is created: the run becomes part of A.
      expect(snap.commit).toBeNull();
      await send(snap.plan);
      const after = await tableOf(A);
      expect(positions(after)).toEqual([
        [100, 400],
        [250, 600],
        [400, 400],
        [480, 250],
        [550, 100],
      ]);
      await h.host.document.undo();
      expect(await tableOf(A)).toEqual(before);
    });

    it("the add / delete anchor clicks on the selected path apply and undo as one step", async () => {
      const before = await tableOf(A);
      const m = pen();
      const selected = await pathOf(A, true);
      const added = click(m, [175, 500], { kind: "segment", path: selected, index: 0, t: 0.5 });
      expect(added.plan!.kind).toBe("addAnchor");
      await send(added.plan);
      const grown = await tableOf(A);
      expect(grown.anchors).toHaveLength(4);
      expect(grown.anchors[1].anchor).toEqual([175, 500]);
      await h.host.document.undo();
      expect(await tableOf(A)).toEqual(before);

      const removed = click(m, [250, 600], anchorHit(selected, 1));
      expect(removed.plan!.kind).toBe("deleteAnchor");
      await send(removed.plan);
      expect(positions(await tableOf(A))).toEqual([
        [100, 400],
        [400, 400],
      ]);
      await h.host.document.undo();
      expect(await tableOf(A)).toEqual(before);
    });

    it("a brand-new path still commits as one insertPath", async () => {
      const m = pen();
      click(m, [500, 500]);
      click(m, [560, 520]);
      const snap = m.handle({ type: "key", key: "Enter" });
      expect(snap.plan!.kind).toBe("insertPath");
      const outcome = await send(snap.plan);
      const created = (outcome as Extract<MutationOutcome, { applied: true }>).createdId;
      expect(created).not.toBeNull();
      expect(positions((await read(created!))!)).toEqual([
        [500, 500],
        [560, 520],
      ]);
      await h.host.document.undo();
      expect(await read(created!)).toBeNull();
    });
  });

  describe("join — the picked ends, not the nearest ones", () => {
    beforeAll(async () => {
      await h.load(PEN_PAIR.bytes());
    });

    it("the fixture: B dangles a handle off each end", async () => {
      const t = await tableOf(B);
      expect(t.anchors).toEqual([
        { anchor: [100, 650], left: [80, 640], right: [100, 650] },
        { anchor: [400, 700], left: [400, 700], right: [420, 710] },
      ]);
    });

    it("PINNED: joinPaths alone welds the NEAREST ends", async () => {
      const beforeA = await tableOf(A);
      const beforeB = await tableOf(B);
      // A is continued with (120, 500) and the user picks B's END
      // (400, 700). But (120, 500) is nearer to B's START (100, 650) —
      // and that is where a bare joinPaths welds.
      const outcome = await h.host.document.mutate({
        op: "batch",
        args: {
          ops: [
            {
              op: "pathPointInsert",
              args: { elementId: A, index: 3, anchor: { anchor: [120, 500], left: [120, 500], right: [120, 500] } },
            },
            { op: "joinPaths", args: { elementId: A, otherId: B } },
          ],
        },
      } as Mutation);
      expect(outcome.applied).toBe(true);
      expect(positions(await tableOf(A)).slice(3)).toEqual([
        [120, 500],
        [100, 650],
        [400, 700],
      ]);
      await h.host.document.undo();
      expect(await tableOf(A)).toEqual(beforeA);
      expect(await tableOf(B)).toEqual(beforeB);
    });

    it("the plan welds the PICKED end — and one undo brings both elements back", async () => {
      const beforeA = await tableOf(A);
      const beforeB = await tableOf(B);
      const m = pen();
      click(m, [400, 400], anchorHit(await pathOf(A), 2));
      click(m, [120, 500]);
      const snap = click(m, [400, 700], anchorHit(await pathOf(B), 1));
      expect(snap.plan!.kind).toBe("join");
      await send(snap.plan);

      const joined = await tableOf(A);
      // B arrives END first (reversed), exactly as picked. Six anchors:
      // the twin the plan inserted MERGED with B's endpoint.
      expect(positions(joined)).toEqual([
        [100, 400],
        [250, 600],
        [400, 400],
        [120, 500],
        [400, 700],
        [100, 650],
      ]);
      expect(joined.subpathStarts).toEqual([0]);
      expect(joined.subpathOpen?.[0]).toBe(true);
      // The welded anchor is B's endpoint as it was, seen the other way
      // round: the handle it dangled now faces the bridge.
      expect(joined.anchors[4]).toEqual({ anchor: [400, 700], left: [420, 710], right: [400, 700] });
      expect(joined.anchors[5]).toEqual({ anchor: [100, 650], left: [100, 650], right: [80, 640] });
      // B is gone as an element.
      expect(await read(B)).toBeNull();

      // Inserts + join are ONE step, and it restores BOTH elements.
      await h.host.document.undo();
      expect(await tableOf(A)).toEqual(beforeA);
      expect(await tableOf(B)).toEqual(beforeB);
    });

    it("joins from a path continued at its START as well", async () => {
      const beforeA = await tableOf(A);
      const beforeB = await tableOf(B);
      const m = pen();
      click(m, [100, 400], anchorHit(await pathOf(A), 0));
      click(m, [60, 520]);
      const snap = click(m, [100, 650], anchorHit(await pathOf(B), 0));
      await send(snap.plan);
      const joined = await tableOf(A);
      // The engine reverses the kept path so the weld ends meet; read
      // either way round it is A, the new anchor, then B from its START.
      const forward = positions(joined);
      const sequence =
        forward[0][0] === 400 && forward[0][1] === 400 ? forward : [...forward].reverse();
      expect(sequence).toEqual([
        [400, 400],
        [250, 600],
        [100, 400],
        [60, 520],
        [100, 650],
        [400, 700],
      ]);
      expect(await read(B)).toBeNull();
      await h.host.document.undo();
      expect(await tableOf(A)).toEqual(beforeA);
      expect(await tableOf(B)).toEqual(beforeB);
    });
  });

  describe("subpaths — appending at a contour boundary", () => {
    const el: ElementId = { kind: "polygon", id: OPEN_THEN_CLOSED.id } as ElementId;
    beforeAll(async () => {
      await h.load(OPEN_THEN_CLOSED.bytes());
    });

    it("the fixture: an open run, then a closed triangle", async () => {
      const t = await tableOf(el);
      expect(t.subpathStarts).toEqual([0, 3]);
      expect(t.subpathOpen).toEqual([true, false]);
    });

    it("PINNED: a bare insert at the boundary lands in the NEXT contour", async () => {
      const before = await tableOf(el);
      const outcome = await h.host.document.mutate({
        op: "pathPointInsert",
        args: { elementId: el, index: 3, anchor: { anchor: [350, 450], left: [350, 450], right: [350, 450] } },
      } as Mutation);
      expect(outcome.applied).toBe(true);
      const after = await tableOf(el);
      // The starts did not move: anchor 3 is now the TRIANGLE's first.
      expect(after.subpathStarts).toEqual([0, 3]);
      expect(after.anchors[3].anchor).toEqual([350, 450]);
      await h.host.document.undo();
      expect(await tableOf(el)).toEqual(before);
    });

    it("the plan carries the starts, so the anchor joins the run it continues", async () => {
      const before = await tableOf(el);
      const m = pen();
      click(m, [300, 500], anchorHit(await pathOf(el), 2));
      click(m, [350, 450]);
      click(m, [380, 400]);
      await send(m.handle({ type: "key", key: "Enter" }).plan);
      const after = await tableOf(el);
      expect(after.subpathStarts).toEqual([0, 5]);
      expect(after.subpathOpen).toEqual([true, false]);
      expect(positions(after).slice(0, 5)).toEqual([
        [100, 500],
        [200, 600],
        [300, 500],
        [350, 450],
        [380, 400],
      ]);
      // The triangle is exactly what it was, three anchors on.
      expect(after.anchors.slice(5)).toEqual(before.anchors.slice(3));
      await h.host.document.undo();
      expect(await tableOf(el)).toEqual(before);
    });

    it("closing names the contour by index", async () => {
      const before = await tableOf(el);
      const path = await pathOf(el);
      const m = pen();
      click(m, [300, 500], anchorHit(path, 2));
      const snap = click(m, [100, 500], anchorHit(path, 0));
      await send(snap.plan);
      const after = await tableOf(el);
      expect(after.subpathOpen?.[0] ?? false).toBe(false);
      expect(after.subpathOpen?.[1] ?? false).toBe(false);
      expect(after.anchors).toEqual(before.anchors);
      await h.host.document.undo();
      expect(await tableOf(el)).toEqual(before);
    });
  });
});

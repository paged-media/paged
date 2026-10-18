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

// Pen v2 — the pen on paths that ALREADY EXIST: continue from an open
// endpoint, close onto the other one, join another path, extend a path
// with a fresh run, and the add / delete anchor intents on the selected
// path. v1 (authoring a new path) keeps its own spec, untouched.

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type {
  Affine,
  AnchorTable,
  AnchorTriple,
} from "@paged-media/draw-geometry";
import type { ElementId } from "@paged-media/plugin-api";

import {
  PenMachine,
  penPlanMutation,
  penPreview,
  type PenHit,
  type PenModifiers,
  type PenPath,
  type PenPlan,
} from "../src/pen-machine";
import type { PathPointOp, TargetedPathOp } from "../src/path-edit-ops";
import { applyPathOps, contourOf } from "./support/apply-ops";

type P = [number, number];

const NONE: PenModifiers = { shift: false, alt: false };

const A_ID: ElementId = { kind: "polygon", id: "a" };
const B_ID: ElementId = { kind: "graphicLine", id: "b" };

const corner = (x: number, y: number): AnchorTriple => ({
  anchor: [x, y],
  left: [x, y],
  right: [x, y],
});

const open = (anchors: AnchorTriple[]): AnchorTable => ({
  anchors,
  subpathStarts: [0],
  subpathOpen: [true],
});

/** An open three-anchor path along y = 0. */
const A: PenPath = {
  id: A_ID,
  table: open([corner(0, 0), corner(50, 0), corner(100, 0)]),
};

/** A second open path. Its START dangles a `left` handle and its END a
 *  `right` one — the handles a join must carry over, not flatten. */
const B: PenPath = {
  id: B_ID,
  table: open([
    { anchor: [200, 0], left: [180, 10], right: [200, 0] },
    { anchor: [250, 50], left: [250, 50], right: [270, 60] },
  ]),
};

const anchorHit = (path: PenPath, index: number): PenHit => ({ kind: "anchor", path, index });
const segmentHit = (path: PenPath, index: number, t: number): PenHit => ({
  kind: "segment",
  path,
  index,
  t,
});

function machine() {
  return new PenMachine({ closeTolerance: 4, dragThreshold: 2 });
}

function click(m: PenMachine, point: P, hit?: PenHit, mods = NONE) {
  m.handle({ type: "down", point, modifiers: mods, ...(hit ? { hit } : {}) });
  return m.handle({ type: "up", point, modifiers: mods });
}

function hover(m: PenMachine, point: P, hit?: PenHit) {
  return m.handle({ type: "move", point, modifiers: NONE, ...(hit ? { hit } : {}) });
}

/** The ops of an edit plan addressed at `id`, element stripped — what
 *  the reference model applies to that element's table. */
function opsFor(plan: PenPlan | null, id: ElementId): PathPointOp[] {
  if (!plan || plan.kind === "insertPath") throw new Error("expected an edit plan");
  return plan.ops
    .filter((op) => op.elementId === id)
    .map(({ elementId: _elementId, ...op }) => op as PathPointOp);
}

function editOps(plan: PenPlan | null): TargetedPathOp[] {
  if (!plan || plan.kind === "insertPath") throw new Error("expected an edit plan");
  return plan.ops;
}

const positions = (anchors: readonly AnchorTriple[]) => anchors.map((a) => a.anchor);

describe("PenMachine v2 — intents", () => {
  it("an open path's endpoint offers to continue it, selected or not", () => {
    const m = machine();
    expect(hover(m, [100, 0], anchorHit(A, 2)).intent).toBe("continue");
    expect(hover(m, [0, 0], anchorHit(A, 0)).intent).toBe("continue");
  });

  it("an interior anchor of the SELECTED path offers delete; of another path, nothing", () => {
    const m = machine();
    expect(hover(m, [50, 0], anchorHit({ ...A, selected: true }, 1)).intent).toBe("delete");
    expect(hover(m, [50, 0], anchorHit(A, 1)).intent).toBe("draw");
  });

  it("a segment of the SELECTED path offers add; of another path, nothing", () => {
    const m = machine();
    expect(hover(m, [25, 0], segmentHit({ ...A, selected: true }, 0, 0.5)).intent).toBe("add");
    expect(hover(m, [25, 0], segmentHit(A, 0, 0.5)).intent).toBe("draw");
  });

  it("a closed path has no endpoints: its anchors offer delete, never continue", () => {
    const closed: PenPath = {
      id: A_ID,
      selected: true,
      table: { anchors: [corner(0, 0), corner(50, 0), corner(50, 50)], subpathStarts: [0], subpathOpen: [false] },
    };
    const m = machine();
    expect(hover(m, [0, 0], anchorHit(closed, 0)).intent).toBe("delete");
    expect(hover(m, [0, 0], anchorHit({ ...closed, selected: false }, 0)).intent).toBe("draw");
  });

  it("delete is not offered where the two-anchor floor would refuse it", () => {
    const pair: PenPath = {
      id: A_ID,
      selected: true,
      table: { anchors: [corner(0, 0), corner(50, 0)], subpathStarts: [0], subpathOpen: [false] },
    };
    expect(hover(machine(), [0, 0], anchorHit(pair, 0)).intent).toBe("draw");
  });

  it("empty space, a missing hit and a stale index are all the plain pen", () => {
    const m = machine();
    expect(hover(m, [5, 5]).intent).toBe("draw");
    expect(hover(m, [5, 5], { kind: "empty" }).intent).toBe("draw");
    expect(hover(m, [5, 5], anchorHit(A, 7)).intent).toBe("draw");
    expect(hover(m, [5, 5], segmentHit({ ...A, selected: true }, 2, 0.5)).intent).toBe("draw");
  });

  it("with a path in progress, add / delete give way to placing an anchor", () => {
    const m = machine();
    click(m, [10, 10]);
    const sel = { ...A, selected: true };
    expect(hover(m, [50, 0], anchorHit(sel, 1)).intent).toBe("draw");
    expect(hover(m, [25, 0], segmentHit(sel, 0, 0.5)).intent).toBe("draw");
    // The click lands a new anchor of the run, on top of the path.
    expect(click(m, [50, 0], anchorHit(sel, 1)).anchors).toHaveLength(2);
  });

  it("the press reports its own intent while the pointer is down", () => {
    const m = machine();
    const snap = m.handle({ type: "down", point: [100, 0], modifiers: NONE, hit: anchorHit(A, 2) });
    expect(snap.intent).toBe("continue");
    expect(m.handle({ type: "up", point: [100, 0], modifiers: NONE }).intent).toBe("draw");
  });

  it("the v1 close-on-first-anchor reads as the close intent too", () => {
    const m = machine();
    click(m, [0, 0]);
    click(m, [30, 0]);
    const snap = hover(m, [1, 1]);
    expect(snap.closePreview).toBe(true);
    expect(snap.intent).toBe("close");
  });
});

describe("PenMachine v2 — continuing an open path", () => {
  it("picking up the END adopts it as the run's first anchor", () => {
    const m = machine();
    const snap = click(m, [100, 0], anchorHit(A, 2));
    expect(snap.anchors).toEqual([corner(100, 0)]);
    expect(snap.continuing).toEqual(A_ID);
    expect(snap.active).toBe(true);
    expect(snap.plan).toBeNull();
    // The rubber band now runs from the endpoint.
    const hovering = hover(m, [140, 30]);
    expect(penPreview(hovering, "pg")!.anchors.map((a) => a.anchor)).toEqual([
      [100, 0],
      [140, 30],
    ]);
  });

  it("Enter commits the added anchors as appends on that element, in one batch", () => {
    const m = machine();
    click(m, [100, 0], anchorHit(A, 2));
    click(m, [150, 50]);
    click(m, [200, 50]);
    const snap = m.handle({ type: "key", key: "Enter" });
    expect(snap.active).toBe(false);
    // Not a NEW path: the v1 commit stays empty, the plan carries it.
    expect(snap.commit).toBeNull();
    expect(snap.plan).toEqual({
      kind: "continue",
      ops: [
        { elementId: A_ID, op: "pathPointInsert", index: 3, anchor: corner(150, 50) },
        { elementId: A_ID, op: "pathPointInsert", index: 4, anchor: corner(200, 50) },
      ],
    });
    expect(penPlanMutation(snap.plan!, "pg")).toEqual({
      op: "batch",
      args: {
        ops: [
          { op: "pathPointInsert", args: { elementId: A_ID, index: 3, anchor: corner(150, 50) } },
          { op: "pathPointInsert", args: { elementId: A_ID, index: 4, anchor: corner(200, 50) } },
        ],
      },
    });
    const after = applyPathOps(A.table, opsFor(snap.plan, A_ID));
    expect(positions(after.anchors)).toEqual([
      [0, 0],
      [50, 0],
      [100, 0],
      [150, 50],
      [200, 50],
    ]);
  });

  it("picking up the START prepends — and the path now runs the other way through the new anchors", () => {
    const m = machine();
    click(m, [0, 0], anchorHit(A, 0));
    // First new anchor, dragged: its outgoing handle (onward, away from
    // the path) is pulled to (-70, 20), the incoming one mirrors.
    m.handle({ type: "down", point: [-50, 0], modifiers: NONE });
    m.handle({ type: "move", point: [-70, 20], modifiers: NONE });
    m.handle({ type: "up", point: [-70, 20], modifiers: NONE });
    click(m, [-100, 50]);
    const snap = m.handle({ type: "key", key: "Enter" });
    expect(snap.plan!.kind).toBe("continue");
    // Each insert goes AT the contour's first index, so the run ends up
    // reversed in front of it.
    expect(editOps(snap.plan).map((op) => "index" in op && op.index)).toEqual([0, 0]);
    const after = applyPathOps(A.table, opsFor(snap.plan, A_ID));
    expect(positions(after.anchors)).toEqual([
      [-100, 50],
      [-50, 0],
      [0, 0],
      [50, 0],
      [100, 0],
    ]);
    // In PATH direction the dragged anchor's onward handle is now its
    // INCOMING one (left), and the mirrored one leads on to the old start.
    expect(after.anchors[1]).toEqual({ anchor: [-50, 0], left: [-70, 20], right: [-30, -20] });
  });

  it("dragging off the picked-up END pulls a new outgoing handle and leaves the incoming one alone", () => {
    const curved: PenPath = {
      id: A_ID,
      table: open([corner(0, 0), { anchor: [100, 0], left: [80, 30], right: [100, 0] }]),
    };
    const m = machine();
    m.handle({ type: "down", point: [100, 0], modifiers: NONE, hit: anchorHit(curved, 1) });
    const dragging = m.handle({ type: "move", point: [130, -10], modifiers: NONE });
    expect(dragging.anchors[0]).toEqual({ anchor: [100, 0], left: [80, 30], right: [130, -10] });
    m.handle({ type: "up", point: [130, -10], modifiers: NONE });
    click(m, [200, 0]);
    const snap = m.handle({ type: "key", key: "Enter" });
    // The handle is written FIRST, at the endpoint's old index.
    expect(snap.plan).toEqual({
      kind: "continue",
      ops: [
        { elementId: A_ID, op: "pathPointSet", index: 1, role: "right", position: [130, -10] },
        { elementId: A_ID, op: "pathPointInsert", index: 2, anchor: corner(200, 0) },
      ],
    });
  });

  it("at the START the new outgoing handle is the path's LEFT handle", () => {
    const m = machine();
    m.handle({ type: "down", point: [0, 0], modifiers: NONE, hit: anchorHit(A, 0) });
    m.handle({ type: "move", point: [-20, -20], modifiers: NONE });
    m.handle({ type: "up", point: [-20, -20], modifiers: NONE });
    const snap = m.handle({ type: "key", key: "Enter" });
    // A handle alone is a change worth committing.
    expect(snap.plan).toEqual({
      kind: "continue",
      ops: [{ elementId: A_ID, op: "pathPointSet", index: 0, role: "left", position: [-20, -20] }],
    });
  });

  it("picking an endpoint up and adding nothing commits nothing", () => {
    const m = machine();
    click(m, [100, 0], anchorHit(A, 2));
    const snap = m.handle({ type: "key", key: "Enter" });
    expect(snap.plan).toBeNull();
    expect(snap.commit).toBeNull();
    expect(snap.active).toBe(false);
  });

  it("Escape abandons the continuation with zero ops", () => {
    const m = machine();
    click(m, [100, 0], anchorHit(A, 2));
    click(m, [150, 50]);
    const snap = m.handle({ type: "key", key: "Escape" });
    expect(snap.plan).toBeNull();
    expect(snap.active).toBe(false);
    expect(snap.continuing).toBeNull();
  });

  it("clicking the picked-up endpoint again is just another anchor — it never closes onto itself", () => {
    const m = machine();
    click(m, [100, 0], anchorHit(A, 2));
    click(m, [150, 50]);
    expect(hover(m, [100, 0], anchorHit(A, 2)).intent).toBe("draw");
    const snap = click(m, [100, 0], anchorHit(A, 2));
    expect(snap.active).toBe(true);
    expect(snap.anchors).toHaveLength(3);
  });

  it("Shift constrains the first new anchor to 45° from the endpoint", () => {
    const m = machine();
    click(m, [100, 0], anchorHit(A, 2));
    const snap = click(m, [150, 4], undefined, { shift: true, alt: false });
    expect(snap.anchors[1].anchor[1]).toBeCloseTo(0, 10);
  });

  it("a one-anchor open contour is continued by appending", () => {
    const dot: PenPath = { id: A_ID, table: open([corner(10, 10)]) };
    const m = machine();
    click(m, [10, 10], anchorHit(dot, 0));
    click(m, [40, 10]);
    const snap = m.handle({ type: "key", key: "Enter" });
    expect(editOps(snap.plan)).toEqual([
      { elementId: A_ID, op: "pathPointInsert", index: 1, anchor: corner(40, 10) },
    ]);
  });
});

describe("PenMachine v2 — subpaths and transforms", () => {
  /** An open run (0–2) FOLLOWED by a closed triangle (3–5). */
  const compound: PenPath = {
    id: A_ID,
    table: {
      anchors: [corner(0, 0), corner(50, 0), corner(100, 0), corner(0, 200), corner(40, 200), corner(20, 240)],
      subpathStarts: [0, 3],
      subpathOpen: [true, false],
    },
  };

  it("appending to a contour that is not the last carries the post-insert starts", () => {
    const m = machine();
    click(m, [100, 0], anchorHit(compound, 2));
    click(m, [150, 0]);
    click(m, [200, 0]);
    const snap = m.handle({ type: "key", key: "Enter" });
    expect(editOps(snap.plan)).toEqual([
      { elementId: A_ID, op: "pathPointInsert", index: 3, anchor: corner(150, 0), prevSubpathStarts: [0, 4] },
      { elementId: A_ID, op: "pathPointInsert", index: 4, anchor: corner(200, 0), prevSubpathStarts: [0, 5] },
    ]);
    const after = applyPathOps(compound.table, opsFor(snap.plan, A_ID));
    expect(positions(contourOf(after, 0))).toEqual([
      [0, 0],
      [50, 0],
      [100, 0],
      [150, 0],
      [200, 0],
    ]);
    // The triangle is untouched and still its own contour.
    expect(contourOf(after, 1)).toEqual(compound.table.anchors.slice(3));
  });

  it("without those starts the engine's default rule would misfile the anchor", () => {
    // The reason the override exists, pinned: the SAME insert with no
    // override lands as the first point of the NEXT contour.
    const misfiled = applyPathOps(compound.table, [
      { op: "pathPointInsert", index: 3, anchor: corner(150, 0) },
    ]);
    expect(contourOf(misfiled, 0)).toHaveLength(3);
    expect(contourOf(misfiled, 1)[0].anchor).toEqual([150, 0]);
  });

  it("prepending to a later contour needs no override", () => {
    const later: PenPath = {
      id: A_ID,
      table: {
        anchors: [corner(0, 200), corner(40, 200), corner(20, 240), corner(0, 0), corner(50, 0)],
        subpathStarts: [0, 3],
        subpathOpen: [false, true],
      },
    };
    const m = machine();
    click(m, [0, 0], anchorHit(later, 3));
    click(m, [-50, 0]);
    const snap = m.handle({ type: "key", key: "Enter" });
    expect(editOps(snap.plan)).toEqual([
      { elementId: A_ID, op: "pathPointInsert", index: 3, anchor: corner(-50, 0) },
    ]);
    const after = applyPathOps(later.table, opsFor(snap.plan, A_ID));
    expect(after.subpathStarts).toEqual([0, 3]);
    expect(positions(contourOf(after, 1))).toEqual([
      [-50, 0],
      [0, 0],
      [50, 0],
    ]);
  });

  it("the run is in pointer space; the ops are in the path's inner space", () => {
    // Inner → pointer: ×2, then +(10, 20).
    const transform: Affine = [2, 0, 0, 2, 10, 20];
    const moved: PenPath = { ...A, transform };
    const m = machine();
    const picked = click(m, [210, 20], anchorHit(moved, 2));
    expect(picked.anchors[0].anchor).toEqual([210, 20]);
    click(m, [310, 120]);
    const snap = m.handle({ type: "key", key: "Enter" });
    expect(editOps(snap.plan)).toEqual([
      { elementId: A_ID, op: "pathPointInsert", index: 3, anchor: corner(150, 50) },
    ]);
  });

  it("a path whose transform cannot be inverted is not continued", () => {
    const flat: PenPath = { ...A, transform: [1, 0, 0, 0, 0, 0] };
    expect(hover(machine(), [100, 0], anchorHit(flat, 2)).intent).toBe("draw");
  });
});

describe("PenMachine v2 — closing a continued path", () => {
  it("ending on its own other endpoint closes it: inserts, then closePath", () => {
    const m = machine();
    click(m, [100, 0], anchorHit(A, 2));
    click(m, [50, 80]);
    const hovering = hover(m, [1, 1], anchorHit(A, 0));
    expect(hovering.intent).toBe("close");
    // The rubber band snaps onto the endpoint.
    expect(hovering.rubberTo).toEqual([0, 0]);
    const snap = click(m, [1, 1], anchorHit(A, 0));
    expect(snap.active).toBe(false);
    expect(snap.commit).toBeNull();
    expect(snap.plan).toEqual({
      kind: "close",
      ops: [
        { elementId: A_ID, op: "pathPointInsert", index: 3, anchor: corner(50, 80) },
        { elementId: A_ID, op: "closePath", subpath: 0 },
      ],
    });
    const after = applyPathOps(A.table, opsFor(snap.plan, A_ID));
    expect(after.subpathOpen).toEqual([false]);
    expect(after.anchors).toHaveLength(4);
  });

  it("closing straight away, with nothing added, is just closePath", () => {
    const m = machine();
    click(m, [100, 0], anchorHit(A, 2));
    const snap = click(m, [0, 0], anchorHit(A, 0));
    expect(editOps(snap.plan)).toEqual([{ elementId: A_ID, op: "closePath", subpath: 0 }]);
  });

  it("works from the START onto the END, and names the right contour", () => {
    const later: PenPath = {
      id: A_ID,
      table: {
        anchors: [corner(0, 200), corner(40, 200), corner(20, 240), corner(0, 0), corner(50, 0), corner(100, 0)],
        subpathStarts: [0, 3],
        subpathOpen: [false, true],
      },
    };
    const m = machine();
    click(m, [0, 0], anchorHit(later, 3));
    click(m, [50, -60]);
    const snap = click(m, [100, 0], anchorHit(later, 5));
    expect(editOps(snap.plan)).toEqual([
      { elementId: A_ID, op: "pathPointInsert", index: 3, anchor: corner(50, -60) },
      { elementId: A_ID, op: "closePath", subpath: 1 },
    ]);
    const after = applyPathOps(later.table, opsFor(snap.plan, A_ID));
    expect(after.subpathOpen).toEqual([false, false]);
    expect(positions(contourOf(after, 1))).toEqual([
      [50, -60],
      [0, 0],
      [50, 0],
      [100, 0],
    ]);
  });

  it("the closing press pulls no handle, and commits on release", () => {
    const m = machine();
    click(m, [100, 0], anchorHit(A, 2));
    click(m, [50, 80]);
    const pressed = m.handle({ type: "down", point: [0, 0], modifiers: NONE, hit: anchorHit(A, 0) });
    expect(pressed.plan).toBeNull();
    expect(pressed.intent).toBe("close");
    const dragged = m.handle({ type: "move", point: [-40, -40], modifiers: NONE });
    expect(dragged.anchors).toHaveLength(2);
    expect(m.handle({ type: "up", point: [-40, -40], modifiers: NONE }).plan!.kind).toBe("close");
  });

  it("an open end of ANOTHER contour of the same element is not a close target", () => {
    const twoOpen: PenPath = {
      id: A_ID,
      table: {
        anchors: [corner(0, 0), corner(50, 0), corner(0, 100), corner(50, 100)],
        subpathStarts: [0, 2],
        subpathOpen: [true, true],
      },
    };
    const m = machine();
    click(m, [50, 0], anchorHit(twoOpen, 1));
    // No op welds two contours of one element — see the machine header.
    expect(hover(m, [50, 100], anchorHit(twoOpen, 3)).intent).toBe("draw");
  });
});

describe("PenMachine v2 — joining another open path", () => {
  it("ending on another path's endpoint joins the two", () => {
    const m = machine();
    click(m, [100, 0], anchorHit(A, 2));
    click(m, [150, -20]);
    const hovering = hover(m, [201, 1], anchorHit(B, 0));
    expect(hovering.intent).toBe("join");
    expect(hovering.rubberTo).toEqual([200, 0]);
    const snap = click(m, [201, 1], anchorHit(B, 0));
    expect(snap.active).toBe(false);
    expect(snap.plan).toEqual({
      kind: "join",
      ops: [
        { elementId: A_ID, op: "pathPointInsert", index: 3, anchor: corner(150, -20) },
        // The twin: ON B's picked endpoint, so that pair of ends is the
        // nearest one `joinPaths` can find — carrying the handle that
        // endpoint was dangling as its incoming one.
        {
          elementId: A_ID,
          op: "pathPointInsert",
          index: 4,
          anchor: { anchor: [200, 0], left: [180, 10], right: [200, 0] },
        },
        { elementId: A_ID, op: "joinPaths", otherId: B_ID },
      ],
    });
    expect(penPlanMutation(snap.plan!, "pg").op).toBe("batch");
  });

  it("the twin is bit-for-bit the picked endpoint, never a round-tripped copy", () => {
    const odd: PenPath = { id: B_ID, table: open([corner(0.1 + 0.2, 1 / 3), corner(9, 9)]) };
    const m = machine();
    click(m, [100, 0], anchorHit(A, 2));
    const snap = click(m, [0.3, 0.33], anchorHit(odd, 0));
    const twin = editOps(snap.plan)[0];
    expect(twin.op === "pathPointInsert" && twin.anchor.anchor).toEqual([0.1 + 0.2, 1 / 3]);
  });

  it("joining onto the other path's END carries its right handle", () => {
    const m = machine();
    click(m, [100, 0], anchorHit(A, 2));
    const snap = click(m, [250, 50], anchorHit(B, 1));
    expect(editOps(snap.plan)[0]).toEqual({
      elementId: A_ID,
      op: "pathPointInsert",
      index: 3,
      anchor: { anchor: [250, 50], left: [270, 60], right: [250, 50] },
    });
  });

  it("from a path continued at its START the twin is prepended, handles swapped", () => {
    const m = machine();
    click(m, [0, 0], anchorHit(A, 0));
    click(m, [-40, 30]);
    const snap = click(m, [200, 0], anchorHit(B, 0));
    expect(editOps(snap.plan)).toEqual([
      { elementId: A_ID, op: "pathPointInsert", index: 0, anchor: corner(-40, 30) },
      {
        elementId: A_ID,
        op: "pathPointInsert",
        index: 0,
        // The path runs the other way here, so the dangling handle sits
        // on the RIGHT.
        anchor: { anchor: [200, 0], left: [200, 0], right: [180, 10] },
      },
      { elementId: A_ID, op: "joinPaths", otherId: B_ID },
    ]);
  });

  it("refuses a join across two different item transforms", () => {
    const shifted: PenPath = { ...B, transform: [1, 0, 0, 1, 5, 0] };
    const m = machine();
    click(m, [100, 0], anchorHit(A, 2));
    // `joinPaths` concatenates raw anchors: B would land 5pt off.
    expect(hover(m, [205, 0], anchorHit(shifted, 0)).intent).toBe("draw");
    // An EQUAL transform on both is one shared space, and joins.
    const m2 = machine();
    const t: Affine = [1, 0, 0, 1, 5, 0];
    click(m2, [105, 0], anchorHit({ ...A, transform: t }, 2));
    expect(hover(m2, [205, 0], anchorHit({ ...B, transform: [...t] as unknown as Affine }, 0)).intent).toBe("join");
  });

  it("refuses a join when either path has more than one contour", () => {
    const multi: PenPath = {
      id: B_ID,
      table: {
        anchors: [corner(200, 0), corner(250, 50), corner(300, 300), corner(350, 300)],
        subpathStarts: [0, 2],
        subpathOpen: [true, true],
      },
    };
    const m = machine();
    click(m, [100, 0], anchorHit(A, 2));
    expect(hover(m, [200, 0], anchorHit(multi, 0)).intent).toBe("draw");
    const m2 = machine();
    click(m2, [200, 0], anchorHit(multi, 0));
    expect(hover(m2, [100, 0], anchorHit(A, 2)).intent).toBe("draw");
  });
});

describe("PenMachine v2 — extending a path with a new run", () => {
  it("a NEW run that ends on an open END is appended to that path, reversed", () => {
    const m = machine();
    click(m, [300, 300]);
    // Second anchor dragged: onward handle (toward the path) at (160, 90).
    m.handle({ type: "down", point: [200, 100], modifiers: NONE });
    m.handle({ type: "move", point: [160, 90], modifiers: NONE });
    m.handle({ type: "up", point: [160, 90], modifiers: NONE });
    expect(hover(m, [100, 0], anchorHit(A, 2)).intent).toBe("join");
    const snap = click(m, [100, 0], anchorHit(A, 2));
    expect(snap.active).toBe(false);
    // The run was never an element — nothing is inserted as a path.
    expect(snap.commit).toBeNull();
    expect(snap.plan!.kind).toBe("extend");
    const after = applyPathOps(A.table, opsFor(snap.plan, A_ID));
    expect(positions(after.anchors)).toEqual([
      [0, 0],
      [50, 0],
      [100, 0],
      [200, 100],
      [300, 300],
    ]);
    // Walked from the path's side, the handle that led ON to the path is
    // now the INCOMING one.
    expect(after.anchors[3]).toEqual({ anchor: [200, 100], left: [160, 90], right: [240, 110] });
  });

  it("ending on an open START puts the run in front of it, in drawing order", () => {
    const m = machine();
    click(m, [-200, 50]);
    click(m, [-100, 50]);
    const snap = click(m, [0, 0], anchorHit(A, 0));
    expect(editOps(snap.plan)).toEqual([
      { elementId: A_ID, op: "pathPointInsert", index: 0, anchor: corner(-100, 50) },
      { elementId: A_ID, op: "pathPointInsert", index: 0, anchor: corner(-200, 50) },
    ]);
    const after = applyPathOps(A.table, opsFor(snap.plan, A_ID));
    expect(positions(after.anchors).slice(0, 3)).toEqual([
      [-200, 50],
      [-100, 50],
      [0, 0],
    ]);
  });

  it("extends a multi-contour path too — no join op is involved", () => {
    const multi: PenPath = {
      id: A_ID,
      table: {
        anchors: [corner(0, 0), corner(50, 0), corner(0, 100), corner(50, 100)],
        subpathStarts: [0, 2],
        subpathOpen: [true, true],
      },
    };
    const m = machine();
    click(m, [120, 40]);
    const snap = click(m, [50, 0], anchorHit(multi, 1));
    expect(editOps(snap.plan)).toEqual([
      { elementId: A_ID, op: "pathPointInsert", index: 2, anchor: corner(120, 40), prevSubpathStarts: [0, 3] },
    ]);
  });

  it("an endpoint hit outranks the v1 first-anchor close", () => {
    const m = machine();
    click(m, [100, 2]);
    click(m, [150, 60]);
    // The pointer is within close tolerance of the run's own first
    // anchor AND on A's endpoint: the host's hit wins.
    const snap = click(m, [100, 0], anchorHit(A, 2));
    expect(snap.plan!.kind).toBe("extend");
  });
});

describe("PenMachine v2 — add / delete anchor on the selected path", () => {
  const sel: PenPath = { ...A, selected: true };

  it("a click on a segment plans the curve-preserving insert and leaves the pen armed", () => {
    const m = machine();
    const snap = click(m, [25, 0], segmentHit(sel, 0, 0.5));
    expect(snap.plan).toEqual({
      kind: "addAnchor",
      ops: [
        { elementId: A_ID, op: "pathPointSet", index: 0, role: "right", position: [0, 0] },
        { elementId: A_ID, op: "pathPointSet", index: 1, role: "left", position: [50, 0] },
        // The de Casteljau midpoint: on a straight segment the new
        // anchor's handles lie along it, so the shape is unchanged.
        {
          elementId: A_ID,
          op: "pathPointInsert",
          index: 1,
          anchor: { anchor: [25, 0], left: [12.5, 0], right: [37.5, 0] },
        },
      ],
    });
    expect(snap.active).toBe(true);
    expect(snap.anchors).toHaveLength(0);
    expect(snap.commit).toBeNull();
    // Transient: the next event carries no plan.
    expect(hover(m, [300, 300]).plan).toBeNull();
  });

  it("a click on an interior anchor plans its removal", () => {
    const m = machine();
    const snap = click(m, [50, 0], anchorHit(sel, 1));
    expect(snap.plan).toEqual({
      kind: "deleteAnchor",
      ops: [{ elementId: A_ID, op: "pathPointRemove", index: 1 }],
    });
    expect(snap.active).toBe(true);
  });

  it("the plan arrives on release, not on press, and a drag pulls nothing", () => {
    const m = machine();
    const pressed = m.handle({ type: "down", point: [50, 0], modifiers: NONE, hit: anchorHit(sel, 1) });
    expect(pressed.plan).toBeNull();
    expect(pressed.intent).toBe("delete");
    expect(m.handle({ type: "move", point: [80, 40], modifiers: NONE }).anchors).toHaveLength(0);
    expect(m.handle({ type: "up", point: [80, 40], modifiers: NONE }).plan!.kind).toBe("deleteAnchor");
  });

  it("the pen keeps working after an anchor edit", () => {
    const m = machine();
    click(m, [50, 0], anchorHit(sel, 1));
    click(m, [300, 300]);
    click(m, [350, 300]);
    const snap = m.handle({ type: "key", key: "Enter" });
    expect(snap.commit!.anchors).toHaveLength(2);
  });
});

describe("PenMachine v2 — the plan is a superset of the v1 commit", () => {
  it("a new open path plans an insertPath on the given page", () => {
    const m = machine();
    click(m, [0, 0]);
    click(m, [30, 0]);
    const snap = m.handle({ type: "key", key: "Enter" });
    expect(snap.plan).toEqual({ kind: "insertPath", anchors: snap.commit!.anchors, open: true });
    expect(penPlanMutation(snap.plan!, "page-1")).toEqual({
      op: "insertPath",
      args: { pageId: "page-1", anchors: [corner(0, 0), corner(30, 0)], open: true, smooth: false },
    });
  });

  it("a new closed path plans a closed insertPath", () => {
    const m = machine();
    click(m, [0, 0]);
    click(m, [30, 0]);
    click(m, [15, 20]);
    const snap = click(m, [1, 1]);
    expect(snap.plan).toMatchObject({ kind: "insertPath", open: false });
  });

  it("events with an explicit empty hit behave exactly as v1", () => {
    const m = machine();
    const empty: PenHit = { kind: "empty" };
    click(m, [0, 0], empty);
    const snap = click(m, [30, 0], empty);
    expect(snap.anchors).toHaveLength(2);
    expect(snap.continuing).toBeNull();
    expect(snap.intent).toBe("draw");
  });
});

// ---- properties --------------------------------------------------------

const coord = fc.double({ min: -500, max: 500, noNaN: true });
const pointArb = fc.tuple(coord, coord);

const tripleArb: fc.Arbitrary<AnchorTriple> = fc
  .tuple(pointArb, pointArb, pointArb)
  .map(([a, l, r]) => ({ anchor: [a[0], a[1]], left: [l[0], l[1]], right: [r[0], r[1]] }));

/** 1–3 contours of 1–4 anchors; at least the PICKED contour is open. */
const pathArb = fc
  .array(fc.array(tripleArb, { minLength: 1, maxLength: 4 }), { minLength: 1, maxLength: 3 })
  .chain((contours) =>
    fc.record({
      contours: fc.constant(contours),
      pick: fc.nat({ max: contours.length - 1 }),
      end: fc.constantFrom<"start" | "end">("start", "end"),
      othersOpen: fc.array(fc.boolean(), { minLength: contours.length, maxLength: contours.length }),
    }),
  );

describe("PenMachine v2 — properties", () => {
  it("continuing attaches the run to the picked contour's picked end, and touches nothing else", () => {
    fc.assert(
      fc.property(
        pathArb,
        fc.array(pointArb, { minLength: 1, maxLength: 5 }),
        ({ contours, pick, end, othersOpen }, clicks) => {
          const anchors = contours.flat();
          const subpathStarts: number[] = [];
          let at = 0;
          for (const c of contours) {
            subpathStarts.push(at);
            at += c.length;
          }
          const subpathOpen = othersOpen.map((o, i) => (i === pick ? true : o));
          const table: AnchorTable = { anchors, subpathStarts, subpathOpen };
          const path: PenPath = { id: A_ID, table };
          const from = subpathStarts[pick];
          const to = from + contours[pick].length;
          // A one-anchor contour has one endpoint, and it is its END.
          const atEnd = end === "end" || contours[pick].length === 1;
          const index = atEnd ? to - 1 : from;

          const m = machine();
          const origin = anchors[index].anchor;
          click(m, [origin[0], origin[1]], anchorHit(path, index));
          for (const c of clicks) click(m, c);
          const snap = m.handle({ type: "key", key: "Enter" });
          const ops = opsFor(snap.plan, A_ID);

          // Every index is valid at the moment its op applies (the model
          // throws otherwise), and one anchor arrives per click.
          const after = applyPathOps(table, ops);
          expect(after.anchors).toHaveLength(anchors.length + clicks.length);
          expect(after.subpathOpen).toEqual(subpathOpen);

          // The picked contour grew at the picked end, in the right order.
          const grown = positions(contourOf(after, pick));
          const original = positions(contours[pick]);
          expect(grown).toEqual(
            atEnd ? [...original, ...clicks] : [...[...clicks].reverse(), ...original],
          );
          // Every other contour is exactly what it was.
          contours.forEach((c, i) => {
            if (i !== pick) expect(contourOf(after, i)).toEqual(c);
          });
        },
      ),
      { numRuns: 300 },
    );
  });
});

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

// The Shape Builder's RESULT, planned from the arrangement — the cross and
// the ovals the editor film found broken.
//
// THE CROSS: a horizontal bar 100..340 × 355..415 crossed by a vertical bar
// 190..250 × 290..470 drawn over it. Five faces. Dragging from the left arm
// into the top arm used to leave ONLY those two arms (the engine's
// `pathfinderFaces { keep }` builds one result and drops every other face):
// the centre, the right arm and the bottom arm vanished.

import { describe, expect, it } from "vitest";

import {
  ShapeBuilderMachine,
  faceOwner,
  planShapeBuild,
  type PlanarFaceRef,
  type RegionFace,
  type ShapeBuildPlan,
} from "../src";

type Box = [number, number, number, number]; // x0, y0, x1, y1

const corner = (x: number, y: number) => ({
  anchor: [x, y] as [number, number],
  left: [x, y] as [number, number],
  right: [x, y] as [number, number],
});
const rect = ([x0, y0, x1, y1]: Box) => [
  corner(x0, y0),
  corner(x1, y0),
  corner(x1, y1),
  corner(x0, y1),
];

/** The cross's arrangement, as the engine reports it: inputs TOP-TO-BOTTOM
 *  (0 = the vertical bar, drawn last, in front; 1 = the horizontal bar), face
 *  ids `"<signature>#<component>"` with components ordered by their
 *  top-left-most anchor. */
const CROSS_FACES: { id: string; signature: number[]; box: Box }[] = [
  { id: "0#0", signature: [0], box: [190, 290, 250, 355] }, // top arm
  { id: "0#1", signature: [0], box: [190, 415, 250, 470] }, // bottom arm
  { id: "0-1#0", signature: [0, 1], box: [190, 355, 250, 415] }, // centre
  { id: "1#0", signature: [1], box: [100, 355, 190, 415] }, // left arm
  { id: "1#1", signature: [1], box: [250, 355, 340, 415] }, // right arm
];
const CROSS: (PlanarFaceRef & RegionFace)[] = CROSS_FACES.map((f) => ({
  id: f.id,
  signature: f.signature,
  anchors: rect(f.box),
  subpathStarts: [0],
}));

const TOP = "0#0";
const BOTTOM = "0#1";
const CENTRE = "0-1#0";
const LEFT = "1#0";
const RIGHT = "1#1";

/** Drag `from` → `to` through the machine over `faces`, sampling every 2 pt,
 *  the way pointer moves arrive. Returns what the gesture collected. */
function drag(faces: readonly RegionFace[], from: [number, number], to: [number, number], alt = false) {
  const m = new ShapeBuilderMachine();
  m.setRegions(faces);
  m.handle({ type: "down", point: from, modifiers: { alt } });
  const steps = Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) / 2);
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    m.handle({ type: "move", point: [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t] });
  }
  return m.handle({ type: "up", point: to });
}

/** Every face of the arrangement, and what the plan makes of it:
 *  "merged", "kept by input i" (a rewrite), "inserted for input i", "under
 *  input i" (its owner was left untouched and still covers it), or
 *  "deleted". A face no one accounts for has VANISHED. */
function fates(plan: ShapeBuildPlan, faces: readonly PlanarFaceRef[], swept: readonly string[]) {
  const out = new Map<string, string>();
  for (const f of faces) {
    if (plan.merge?.faces.includes(f.id)) out.set(f.id, "merged");
    else if (swept.includes(f.id)) out.set(f.id, "deleted");
  }
  for (const r of plan.rewrites) out.set(r.face, `kept by ${r.input}`);
  for (const ins of plan.inserts) out.set(ins.face, `inserted for ${ins.paintFrom}`);
  for (const f of faces) {
    if (!out.has(f.id) && plan.untouched.includes(faceOwner(f))) {
      out.set(f.id, `under ${faceOwner(f)}`);
    }
  }
  return out;
}

describe("Shape Builder on a cross-shaped overlap [plugin-draw.shape-builder]", () => {
  it("dragging from the left arm into the top arm crosses exactly those two faces", () => {
    const s = drag(CROSS, [150, 385], [220, 320]);
    expect(s.collected).toEqual([LEFT, TOP]);
    expect(s.faceMode).toBe("keep");
  });

  it("the crossed arms MERGE into one path; the centre and the other two arms STAY", () => {
    const swept = [LEFT, TOP];
    const plan = planShapeBuild(2, CROSS, swept, "keep")!;
    expect(plan).not.toBeNull();
    // The merged path belongs to the vertical bar — the topmost input
    // covering a crossed face — and is carried by it.
    expect(plan.merge).toEqual({ faces: [TOP, LEFT], owner: 0, carrier: "input" });
    // Nothing vanishes: every face is merged, kept or inserted.
    expect(Object.fromEntries(fates(plan, CROSS, swept))).toEqual({
      [TOP]: "merged",
      [LEFT]: "merged",
      // The vertical bar IS the merged path now, so its bottom arm and the
      // centre (on top there) become pieces painted like it...
      [BOTTOM]: "inserted for 0",
      [CENTRE]: "inserted for 0",
      // ...and the horizontal bar keeps its right arm in place.
      [RIGHT]: "kept by 1",
    });
    expect(plan.rewrites).toEqual([{ input: 1, face: RIGHT }]);
    expect(plan.deletes).toEqual([]);
  });

  it("an Alt-drag over the left arm deletes it and nothing else", () => {
    const s = drag(CROSS, [110, 385], [180, 385], true);
    expect(s.collected).toEqual([LEFT]);
    expect(s.faceMode).toBe("remove");
    const plan = planShapeBuild(2, CROSS, s.collected, "remove")!;
    expect(plan.merge).toBeNull();
    // The vertical bar was not touched: it stays whole (and still covers
    // the centre); the horizontal bar keeps what is left of it on show.
    expect(plan.untouched).toEqual([0]);
    expect(Object.fromEntries(fates(plan, CROSS, s.collected))).toEqual({
      [LEFT]: "deleted",
      [RIGHT]: "kept by 1",
      [TOP]: "under 0",
      [BOTTOM]: "under 0",
      [CENTRE]: "under 0",
    });
  });

  it("dragging across all five faces merges them all and consumes the horizontal bar", () => {
    const all = CROSS.map((f) => f.id);
    const plan = planShapeBuild(2, CROSS, all, "keep")!;
    expect(plan.merge?.owner).toBe(0);
    expect(plan.merge?.faces).toHaveLength(5);
    expect(plan.inserts).toEqual([]);
    expect(plan.rewrites).toEqual([]);
    expect(plan.deletes).toEqual([1]);
  });

  it("a click on one face (a one-face gesture) separates it, keeping everything else", () => {
    const plan = planShapeBuild(2, CROSS, [CENTRE], "keep")!;
    expect(plan.merge).toEqual({ faces: [CENTRE], owner: 0, carrier: "input" });
    const f = fates(plan, CROSS, [CENTRE]);
    expect([...f.values()].filter((v) => v === "merged")).toHaveLength(1);
    expect(f.size).toBe(5);
  });

  it("a gesture that crossed no face of the arrangement plans nothing", () => {
    expect(planShapeBuild(2, CROSS, [], "keep")).toBeNull();
    expect(planShapeBuild(2, CROSS, ["7#0"], "keep")).toBeNull();
  });

  it("an input the gesture never touched is left as it was", () => {
    // A third shape far away (index 2) with its own face.
    const faces = [...CROSS, { id: "2#0", signature: [2] }];
    const plan = planShapeBuild(3, faces, [LEFT, TOP], "keep")!;
    expect(plan.untouched).toEqual([2]);
    expect(plan.inserts.some((i) => i.face === "2#0")).toBe(false);
    expect(plan.deletes).not.toContain(2);
  });
});

// TWO OVERLAPPING OVALS. An oval has no path for the engine to rewrite (and
// the engine reads it as its bounding box — the second film bug); the plan
// never rewrites one in place: its pieces are inserted, the oval deleted, and
// a merge it owns is carried by a fresh piece.
describe("Shape Builder over ovals [plugin-draw.shape-builder]", () => {
  // Inputs top-to-bottom: 0 = the left oval (in front), 1 = the right one.
  const OVALS: PlanarFaceRef[] = [
    { id: "0#0", signature: [0] }, // the left crescent
    { id: "0-1#0", signature: [0, 1] }, // the lens
    { id: "1#0", signature: [1] }, // the right crescent
  ];
  const isPath = () => false; // both inputs are ovals

  it("merging the left crescent and the lens: a fresh piece carries the merge, the right crescent stays", () => {
    const plan = planShapeBuild(2, OVALS, ["0#0", "0-1#0"], "keep", isPath)!;
    expect(plan.merge).toEqual({ faces: ["0#0", "0-1#0"], owner: 0, carrier: "piece" });
    expect(plan.rewrites).toEqual([]);
    expect(plan.inserts).toEqual([{ face: "1#0", paintFrom: 1 }]);
    expect(plan.deletes).toEqual([0, 1]);
  });

  it("merging all three faces of two paths rewrites the front one and deletes the other", () => {
    const plan = planShapeBuild(2, OVALS, ["0#0", "0-1#0", "1#0"], "keep")!;
    expect(plan.merge).toEqual({ faces: ["0#0", "0-1#0", "1#0"], owner: 0, carrier: "input" });
    expect(plan.deletes).toEqual([1]);
  });

  it("an Alt-drag over the lens of two ovals keeps both crescents as pieces", () => {
    const plan = planShapeBuild(2, OVALS, ["0-1#0"], "remove", isPath)!;
    expect(plan.merge).toBeNull();
    expect(plan.inserts).toEqual([
      { face: "0#0", paintFrom: 0 },
      { face: "1#0", paintFrom: 1 },
    ]);
    expect(plan.deletes).toEqual([0, 1]);
  });
});

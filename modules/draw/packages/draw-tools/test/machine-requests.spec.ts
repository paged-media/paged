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

// THE EDITOR SHIM'S REQUESTS against the path-editing machines — five
// ADDITIVE API changes, each pinned here. Additive means: every existing
// call keeps its meaning (the machines' own specs run unchanged beside
// this one), and each new surface is opt-in.
//
//   1. setOptions()      — zoom-dependent tolerances changed in place;
//   2. hits: PenHit[]    — several paths under the pointer, ranked by
//                          the machine; the endpoint test exported;
//   3. planAnchorConvertAt(table, index);
//   4. a click COUNT     — passed on `up` (or derived from timestamps),
//                          reported as `clickCount` / `doubleClick`;
//   5. machine.apply(ops) — a plan's ops previewed on the machine's own
//                          table.

import { describe, expect, it } from "vitest";

import type { AnchorTable, AnchorTriple } from "@paged-media/draw-geometry";

import type { ElementId } from "@paged-media/plugin-api";

import {
  DirectSelectMachine,
  PenMachine,
  anchorEditOps,
  penEndpointAt,
  planAnchorAddAt,
  planAnchorConvert,
  planAnchorConvertAt,
  planAnchorDeleteAt,
  type DirectSelectHit,
  type DirectSelectModifiers,
  type PenHit,
  type PenModifiers,
  type PenPath,
} from "../src";

type P = [number, number];

const NONE: DirectSelectModifiers = { shift: false, alt: false };
const PEN_NONE: PenModifiers = { shift: false, alt: false };

const corner = (x: number, y: number): AnchorTriple => ({
  anchor: [x, y],
  left: [x, y],
  right: [x, y],
});

const QUAD: AnchorTable = {
  anchors: [corner(0, 0), corner(100, 0), corner(100, 100), corner(0, 100)],
  subpathStarts: [0],
  subpathOpen: [false],
};

const anchorHit = (index: number): DirectSelectHit => ({ kind: "anchor", index });

describe("1 — setOptions: the zoom-dependent tolerances, changed in place", () => {
  it("DirectSelect: a wider slop turns a 5 pt travel back into a CLICK; the selection survives the change", () => {
    const m = new DirectSelectMachine({ table: QUAD, slop: 2, nudgeStep: 1 });
    // At slop 2 a 5 pt travel is a drag.
    m.handle({ type: "down", point: [0, 0], hit: anchorHit(0), modifiers: NONE });
    const dragged = m.handle({ type: "up", point: [5, 0], modifiers: NONE });
    expect(dragged.commit?.kind).toBe("move");
    expect(dragged.click).toBeNull();

    m.sync(QUAD);
    m.setSelection([2]);
    // Zoomed out: the same screen slop is 8 pt now.
    const after = m.setOptions({ slop: 8 });
    expect(after.selected).toEqual([2]);
    expect(m.currentOptions().slop).toBe(8);
    m.handle({ type: "down", point: [0, 0], hit: anchorHit(0), modifiers: NONE });
    const clicked = m.handle({ type: "up", point: [5, 0], modifiers: NONE });
    expect(clicked.commit).toBeNull();
    expect(clicked.click).toEqual(anchorHit(0));
  });

  it("DirectSelect: the nudge step follows the zoom too", () => {
    const m = new DirectSelectMachine({ table: QUAD, slop: 2, nudgeStep: 1, selection: [0] });
    m.setOptions({ nudgeStep: 4 });
    const snap = m.handle({ type: "key", key: "ArrowRight", modifiers: NONE });
    expect(snap.commit?.ops).toEqual([
      { op: "pathPointSet", index: 0, role: "anchor", position: [4, 0] },
    ]);
  });

  it("DirectSelect: garbage is ignored, and an omitted key keeps its value", () => {
    const m = new DirectSelectMachine({
      table: QUAD,
      slop: 2,
      nudgeStep: 1,
      smoothTolerance: 0.1,
    });
    m.setOptions({ slop: Number.NaN, nudgeStep: -3 });
    expect(m.currentOptions()).toEqual({ slop: 2, nudgeStep: 1, smoothTolerance: 0.1 });
    m.setOptions({ smoothTolerance: 0.2 });
    expect(m.currentOptions()).toEqual({ slop: 2, nudgeStep: 1, smoothTolerance: 0.2 });
  });

  it("Pen: a larger close tolerance brings the first anchor into reach MID-RUN, without losing the run", () => {
    const m = new PenMachine({ closeTolerance: 2, dragThreshold: 2 });
    for (const p of [
      [0, 0],
      [100, 0],
      [100, 100],
    ] as P[]) {
      m.handle({ type: "down", point: p, modifiers: PEN_NONE });
      m.handle({ type: "up", point: p, modifiers: PEN_NONE });
    }
    const far = m.handle({ type: "move", point: [5, 0], modifiers: PEN_NONE });
    expect(far.closePreview).toBe(false);
    const widened = m.setOptions({ closeTolerance: 8 });
    expect(widened.anchors).toHaveLength(3);
    expect(widened.closePreview).toBe(true);
    expect(m.currentOptions().closeTolerance).toBe(8);
    // …and the click there CLOSES.
    m.handle({ type: "down", point: [5, 0], modifiers: PEN_NONE });
    const closed = m.handle({ type: "up", point: [5, 0], modifiers: PEN_NONE });
    expect(closed.commit).toEqual({
      anchors: [corner(0, 0), corner(100, 0), corner(100, 100)],
      open: false,
    });
  });

  it("Pen: the drag threshold decides corner vs smooth on the next press", () => {
    const m = new PenMachine({ closeTolerance: 4, dragThreshold: 2 });
    m.setOptions({ dragThreshold: 10 });
    m.handle({ type: "down", point: [0, 0], modifiers: PEN_NONE });
    const short = m.handle({ type: "move", point: [6, 0], modifiers: PEN_NONE });
    // Within the new threshold: still a corner.
    expect(short.anchors[0]).toEqual(corner(0, 0));
    const long = m.handle({ type: "move", point: [12, 0], modifiers: PEN_NONE });
    expect(long.anchors[0].right).toEqual([12, 0]);
  });

  it("Pen: the options object passed in is never written to", () => {
    const given = { closeTolerance: 4, dragThreshold: 2 };
    const m = new PenMachine(given);
    m.setOptions({ closeTolerance: 9, dragThreshold: Number.POSITIVE_INFINITY });
    expect(given).toEqual({ closeTolerance: 4, dragThreshold: 2 });
    expect(m.currentOptions()).toEqual({ closeTolerance: 9, dragThreshold: 2 });
  });
});

describe("2 — hits: several paths under the pointer, ranked by the machine", () => {
  const openPath = (anchors: AnchorTriple[]): AnchorTable => ({
    anchors,
    subpathStarts: [0],
    subpathOpen: [true],
  });
  const id = (name: string): ElementId => ({ kind: "polygon", id: name });
  /** Open, unselected: its endpoint (0, 0) can be picked up. */
  const A: PenPath = {
    id: id("a"),
    table: openPath([corner(0, 0), corner(50, 0), corner(100, 0)]),
  };
  /** Closed, SELECTED: its anchor 0 sits at (0, 0) too. */
  const S: PenPath = { id: id("s"), table: QUAD, selected: true };
  /** Open, unselected, a second endpoint at (0, 0). */
  const B: PenPath = {
    id: id("b"),
    table: openPath([corner(0, 0), corner(0, -80)]),
  };
  const anchor = (path: PenPath, index: number): PenHit => ({ kind: "anchor", path, index });
  const segment = (path: PenPath, index: number, t: number): PenHit => ({
    kind: "segment",
    path,
    index,
    t,
  });
  const pen = () => new PenMachine({ closeTolerance: 4, dragThreshold: 2 });
  const hover = (m: PenMachine, hits: PenHit[]) =>
    m.handle({ type: "move", point: [0, 0], modifiers: PEN_NONE, hits });

  it("penEndpointAt is the endpoint test the ranking uses", () => {
    expect(penEndpointAt(A, 0)).toMatchObject({ index: 0, end: "start", contour: 0 });
    expect(penEndpointAt(A, 2)).toMatchObject({ index: 2, end: "end" });
    expect(penEndpointAt(A, 1)).toBeNull(); // interior
    expect(penEndpointAt(S, 0)).toBeNull(); // a closed contour has no ends
    expect(penEndpointAt(A, 7)).toBeNull();
  });

  it("a hit that DOES something beats one that does not, whatever the host's order", () => {
    // A's interior anchor (unselected → "draw") listed first, B's
    // endpoint second.
    const snap = hover(pen(), [anchor(A, 1), anchor(B, 0)]);
    expect(snap.intent).toBe("continue");
    expect(snap.hit).toEqual(anchor(B, 0));
  });

  it("the SELECTED path wins a tie: its delete beats another path's continue", () => {
    const snap = hover(pen(), [anchor(A, 0), anchor(S, 0)]);
    expect(snap.intent).toBe("delete");
    expect(snap.hit).toEqual(anchor(S, 0));
  });

  it("on one path an ANCHOR hit beats a SEGMENT hit", () => {
    const snap = hover(pen(), [segment(S, 0, 0.5), anchor(S, 1)]);
    expect(snap.intent).toBe("delete");
    expect(snap.hit).toEqual(anchor(S, 1));
  });

  it("all else equal, the host's order is the last word", () => {
    expect(hover(pen(), [anchor(A, 0), anchor(B, 0)]).hit).toEqual(anchor(A, 0));
    expect(hover(pen(), [anchor(B, 0), anchor(A, 0)]).hit).toEqual(anchor(B, 0));
  });

  it("mid-run, a CLOSE onto the origin's other end beats a JOIN onto a third path", () => {
    const m = pen();
    // Pick A up at its end (100, 0) and add one anchor.
    m.handle({ type: "down", point: [100, 0], modifiers: PEN_NONE, hit: anchor(A, 2) });
    m.handle({ type: "up", point: [100, 0], modifiers: PEN_NONE });
    m.handle({ type: "down", point: [50, 60], modifiers: PEN_NONE });
    m.handle({ type: "up", point: [50, 60], modifiers: PEN_NONE });
    const snap = hover(m, [anchor(B, 0), anchor(A, 0)]);
    expect(snap.intent).toBe("close");
    expect(snap.hit).toEqual(anchor(A, 0));
    // …and the press acts on the winner.
    m.handle({
      type: "down",
      point: [0, 0],
      modifiers: PEN_NONE,
      hits: [anchor(B, 0), anchor(A, 0)],
    });
    const closed = m.handle({ type: "up", point: [0, 0], modifiers: PEN_NONE });
    expect(closed.plan?.kind).toBe("close");
  });

  it("is ADDITIVE: a single `hit` means what it always meant, and `hit` + `hits` are ranked together", () => {
    const single = pen().handle({
      type: "move",
      point: [0, 0],
      modifiers: PEN_NONE,
      hit: anchor(A, 1),
    });
    expect(single.intent).toBe("draw");
    expect(single.hit).toEqual(anchor(A, 1));
    const both = pen().handle({
      type: "move",
      point: [0, 0],
      modifiers: PEN_NONE,
      hit: anchor(A, 1),
      hits: [anchor(B, 0)],
    });
    expect(both.intent).toBe("continue");
    // Empty space and no hits: no hit reported.
    expect(pen().handle({ type: "move", point: [9, 9], modifiers: PEN_NONE }).hit).toBeNull();
    expect(hover(pen(), [{ kind: "empty" }]).hit).toBeNull();
  });
});

describe("3 — planAnchorConvertAt, beside planAnchorAddAt / planAnchorDeleteAt", () => {
  const SMOOTH_ARCH: AnchorTable = {
    anchors: [
      corner(0, 0),
      { anchor: [50, 50], left: [30, 50], right: [90, 50] },
      corner(100, 0),
    ],
    subpathStarts: [0],
    subpathOpen: [true],
  };

  it("toggles by index: a corner plans smooth, a smooth anchor plans a corner", () => {
    expect(planAnchorConvertAt(SMOOTH_ARCH, 0)).toEqual({
      kind: "convert",
      index: 0,
      smooth: true,
    });
    expect(planAnchorConvertAt(SMOOTH_ARCH, 1)).toEqual({
      kind: "convert",
      index: 1,
      smooth: false,
    });
  });

  it("is the same plan the point-and-tolerance planner makes for that anchor", () => {
    for (const [i, a] of SMOOTH_ARCH.anchors.entries()) {
      expect(planAnchorConvertAt(SMOOTH_ARCH, i)).toEqual(
        planAnchorConvert(SMOOTH_ARCH, a.anchor as P, 1),
      );
    }
  });

  it("refuses an index outside the table, like its two siblings", () => {
    for (const bad of [-1, 3, 1.5, Number.NaN]) {
      expect(planAnchorConvertAt(SMOOTH_ARCH, bad)).toBeNull();
      expect(planAnchorDeleteAt(SMOOTH_ARCH, bad)).toBeNull();
    }
    expect(planAnchorAddAt(SMOOTH_ARCH, 2, 0.5)).toBeNull(); // last anchor of an open contour
  });

  it("lowers through anchorEditOps to ONE pathPointCurveType op", () => {
    expect(anchorEditOps(planAnchorConvertAt(SMOOTH_ARCH, 0)!)).toEqual([
      { op: "pathPointCurveType", index: 0, smooth: true },
    ]);
  });
});

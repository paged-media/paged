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

import {
  DirectSelectMachine,
  PenMachine,
  type DirectSelectHit,
  type DirectSelectModifiers,
  type PenModifiers,
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

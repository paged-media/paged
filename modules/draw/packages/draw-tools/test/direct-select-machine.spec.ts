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

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  applyAffine,
  evalCubic,
  type Affine,
  type AnchorTable,
  type AnchorTriple,
} from "@paged-media/draw-geometry";

import {
  DirectSelectMachine,
  directSelectMutation,
  type DirectSelectEvent,
  type DirectSelectHit,
  type DirectSelectModifiers,
  type DirectSelectSnapshot,
} from "../src/direct-select-machine";
import { applyPathOps, type ModelTable } from "./support/apply-ops";

type P = [number, number];

const NONE: DirectSelectModifiers = { shift: false, alt: false };
const SHIFT: DirectSelectModifiers = { shift: true, alt: false };
const ALT: DirectSelectModifiers = { shift: false, alt: true };

const EMPTY: DirectSelectHit = { kind: "empty" };
const anchorHit = (index: number): DirectSelectHit => ({ kind: "anchor", index });
const handleHit = (index: number, side: "left" | "right"): DirectSelectHit => ({
  kind: "handle",
  index,
  side,
});
const segmentHit = (index: number, t: number): DirectSelectHit => ({
  kind: "segment",
  index,
  t,
});

const corner = (x: number, y: number): AnchorTriple => ({
  anchor: [x, y],
  left: [x, y],
  right: [x, y],
});

/** A closed square, corners only — the conformance corpus's F2 shape. */
const QUAD: AnchorTable = {
  anchors: [corner(0, 0), corner(100, 0), corner(100, 100), corner(0, 100)],
  subpathStarts: [0],
  subpathOpen: [false],
};

/** An open arch whose middle anchor is SMOOTH and asymmetric: its
 *  handles are collinear through it, 20 and 40 long. */
const ARCH: AnchorTable = {
  anchors: [
    corner(0, 0),
    { anchor: [50, 50], left: [30, 50], right: [90, 50] },
    corner(100, 0),
  ],
  subpathStarts: [0],
  subpathOpen: [true],
};

/** A closed triangle (anchors 0–2) and an open three-anchor run (3–5):
 *  one path, two contours, flat indices. */
const COMPOUND: AnchorTable = {
  anchors: [
    corner(0, 0),
    corner(40, 0),
    corner(20, 40),
    corner(100, 0),
    corner(150, 50),
    corner(200, 0),
  ],
  subpathStarts: [0, 3],
  subpathOpen: [false, true],
};

function machine(
  table: AnchorTable,
  extra: { transform?: Affine | null; selection?: number[] } = {},
) {
  return new DirectSelectMachine({ table, slop: 2, nudgeStep: 1, ...extra });
}

function down(m: DirectSelectMachine, point: P, hit: DirectSelectHit, mods = NONE) {
  return m.handle({ type: "down", point, hit, modifiers: mods });
}
function move(m: DirectSelectMachine, point: P, mods = NONE) {
  return m.handle({ type: "move", point, modifiers: mods });
}
function up(m: DirectSelectMachine, point: P, mods = NONE) {
  return m.handle({ type: "up", point, modifiers: mods });
}
function click(m: DirectSelectMachine, point: P, hit: DirectSelectHit, mods = NONE) {
  down(m, point, hit, mods);
  return up(m, point, mods);
}
function drag(
  m: DirectSelectMachine,
  from: P,
  to: P,
  hit: DirectSelectHit,
  mods = NONE,
) {
  down(m, from, hit, NONE);
  move(m, to, mods);
  return up(m, to, mods);
}
function key(
  m: DirectSelectMachine,
  k: Extract<DirectSelectEvent, { type: "key" }>["key"],
  mods = NONE,
) {
  return m.handle({ type: "key", key: k, modifiers: mods });
}

function expectTablesClose(
  actual: { anchors: readonly AnchorTriple[] },
  expected: { anchors: readonly AnchorTriple[] },
  digits = 6,
) {
  expect(actual.anchors.length).toBe(expected.anchors.length);
  actual.anchors.forEach((a, i) => {
    for (const role of ["anchor", "left", "right"] as const) {
      expect(a[role][0], `anchor ${i} ${role}.x`).toBeCloseTo(expected.anchors[i][role][0], digits);
      expect(a[role][1], `anchor ${i} ${role}.y`).toBeCloseTo(expected.anchors[i][role][1], digits);
    }
  });
}

describe("DirectSelectMachine — dragging anchors", () => {
  it("drags one anchor and its handles travel with it", () => {
    const m = machine(ARCH);
    const snap = drag(m, [50, 50], [60, 70], anchorHit(1));
    expect(snap.table.anchors[1]).toEqual({
      anchor: [60, 70],
      left: [40, 70],
      right: [100, 70],
    });
    // ONE op: the engine drags both handles with the anchor.
    expect(snap.commit).toEqual({
      kind: "move",
      ops: [{ op: "pathPointSet", index: 1, role: "anchor", position: [60, 70] }],
    });
    expect(snap.selected).toEqual([1]);
    expect(snap.mode).toBe("idle");
  });

  it("leaves every other anchor byte-identical — the wrong-node symptom", () => {
    const m = machine(QUAD);
    const before = m.snapshot().table;
    const snap = drag(m, [100, 100], [130, 90], anchorHit(2));
    expect(snap.table.anchors[2].anchor).toEqual([130, 90]);
    for (const i of [0, 1, 3]) {
      // The very same triples the machine held before, not equal copies.
      expect(snap.table.anchors[i]).toBe(before.anchors[i]);
      expect(snap.table.anchors[i]).toEqual(QUAD.anchors[i]);
    }
    expect(snap.commit!.ops.map((o) => o.index)).toEqual([2]);
  });

  it("previews the move on every pointer sample, before any commit", () => {
    const m = machine(QUAD);
    down(m, [0, 0], anchorHit(0));
    const mid = move(m, [10, 5]);
    expect(mid.mode).toBe("anchors");
    expect(mid.commit).toBeNull();
    expect(mid.table.anchors[0].anchor).toEqual([10, 5]);
    // The input table is never written to.
    expect(QUAD.anchors[0].anchor).toEqual([0, 0]);
  });

  it("drags a multi-anchor selection as one", () => {
    const m = machine(QUAD);
    click(m, [0, 0], anchorHit(0));
    click(m, [100, 0], anchorHit(1), SHIFT);
    // Pressing one of the selected anchors keeps the whole selection.
    const snap = drag(m, [100, 0], [110, -20], anchorHit(1));
    expect(snap.table.anchors[0].anchor).toEqual([10, -20]);
    expect(snap.table.anchors[1].anchor).toEqual([110, -20]);
    expect(snap.table.anchors[2].anchor).toEqual([100, 100]);
    expect(snap.selected).toEqual([0, 1]);
    expect(snap.commit!.ops).toEqual([
      { op: "pathPointSet", index: 0, role: "anchor", position: [10, -20] },
      { op: "pathPointSet", index: 1, role: "anchor", position: [110, -20] },
    ]);
  });

  it("pressing an UNSELECTED anchor drags only it, replacing the selection", () => {
    const m = machine(QUAD, { selection: [0, 1] });
    const snap = drag(m, [100, 100], [120, 120], anchorHit(2));
    expect(snap.selected).toEqual([2]);
    expect(snap.table.anchors[0].anchor).toEqual([0, 0]);
    expect(snap.table.anchors[2].anchor).toEqual([120, 120]);
  });

  it("Shift-pressing an unselected anchor adds it and drags the lot", () => {
    const m = machine(QUAD, { selection: [0] });
    down(m, [100, 0], anchorHit(1), SHIFT);
    move(m, [100, 30]);
    const snap = up(m, [100, 30]);
    expect(snap.selected).toEqual([0, 1]);
    expect(snap.table.anchors[0].anchor).toEqual([0, 30]);
    expect(snap.table.anchors[1].anchor).toEqual([100, 30]);
  });

  it("Shift during the drag constrains to 45° from the drag origin", () => {
    const m = machine(QUAD);
    down(m, [0, 0], anchorHit(0));
    // 30 across, 4 down: nearest 45° ray is the horizontal.
    const snap = move(m, [30, 4], SHIFT);
    expect(snap.table.anchors[0].anchor[1]).toBeCloseTo(0, 10);
    expect(snap.table.anchors[0].anchor[0]).toBeCloseTo(Math.hypot(30, 4), 10);
    // Letting Shift go mid-drag simply un-applies it.
    expect(move(m, [30, 4]).table.anchors[0].anchor).toEqual([30, 4]);
    // A diagonal pull snaps onto the 45° ray.
    const diag = up(m, [40, 35], SHIFT);
    const [x, y] = diag.table.anchors[0].anchor;
    expect(x).toBeCloseTo(y, 10);
  });
});

describe("DirectSelectMachine — dragging handles", () => {
  it("a smooth anchor's handles stay paired: collinear, the opposite keeping its length", () => {
    const m = machine(ARCH);
    // Grab the right handle (40 long) and swing it straight down.
    const snap = drag(m, [90, 50], [50, 90], handleHit(1, "right"));
    const a = snap.table.anchors[1];
    expect(a.anchor).toEqual([50, 50]);
    expect(a.right).toEqual([50, 90]);
    // The left handle swung to the opposite side and is still 20 long.
    expect(a.left[0]).toBeCloseTo(50, 10);
    expect(a.left[1]).toBeCloseTo(30, 10);
    expect(snap.commit!.kind).toBe("handle");
    expect(snap.commit!.ops.map((o) => [o.op, o.index, "role" in o && o.role])).toEqual([
      ["pathPointSet", 1, "left"],
      ["pathPointSet", 1, "right"],
    ]);
  });

  it("the handle keeps its grab offset instead of jumping to the pointer", () => {
    const m = machine(ARCH);
    // Pressed 3pt off the handle's centre; moved 10 right.
    const snap = drag(m, [93, 52], [103, 52], handleHit(1, "right"), ALT);
    expect(snap.table.anchors[1].right).toEqual([100, 50]);
  });

  it("Alt makes the drag independent — the opposite handle does not move", () => {
    const m = machine(ARCH);
    const snap = drag(m, [90, 50], [50, 90], handleHit(1, "right"), ALT);
    expect(snap.table.anchors[1].right).toEqual([50, 90]);
    expect(snap.table.anchors[1].left).toEqual([30, 50]);
    expect(snap.commit!.ops).toEqual([
      { op: "pathPointSet", index: 1, role: "right", position: [50, 90] },
    ]);
  });

  it("Alt is read per sample: releasing it mid-drag re-pairs the handles", () => {
    const m = machine(ARCH);
    down(m, [90, 50], handleHit(1, "right"));
    expect(move(m, [50, 90], ALT).table.anchors[1].left).toEqual([30, 50]);
    const paired = move(m, [50, 90]).table.anchors[1].left;
    expect(paired[0]).toBeCloseTo(50, 10);
    expect(paired[1]).toBeCloseTo(30, 10);
  });

  it("a cusp is a corner: its handles are always independent", () => {
    const cusp: AnchorTable = {
      anchors: [corner(0, 0), { anchor: [50, 50], left: [30, 50], right: [50, 90] }, corner(100, 0)],
      subpathStarts: [0],
      subpathOpen: [true],
    };
    const m = machine(cusp);
    const snap = drag(m, [50, 90], [80, 80], handleHit(1, "right"));
    expect(snap.table.anchors[1].right).toEqual([80, 80]);
    expect(snap.table.anchors[1].left).toEqual([30, 50]);
    expect(snap.commit!.ops).toHaveLength(1);
  });

  it("a one-handled anchor is a corner too: nothing to pair with", () => {
    const oneHanded: AnchorTable = {
      anchors: [{ anchor: [0, 0], left: [0, 0], right: [30, 0] }, corner(100, 0)],
      subpathStarts: [0],
      subpathOpen: [true],
    };
    const m = machine(oneHanded);
    const snap = drag(m, [30, 0], [30, 30], handleHit(0, "right"));
    expect(snap.table.anchors[0]).toEqual({ anchor: [0, 0], left: [0, 0], right: [30, 30] });
    expect(snap.commit!.ops).toEqual([
      { op: "pathPointSet", index: 0, role: "right", position: [30, 30] },
    ]);
  });

  it("Shift snaps a handle's direction to 45° around its ANCHOR", () => {
    const m = machine(ARCH);
    // Right handle to (88, 55): ~7.5° below the horizontal → snaps flat.
    const snap = drag(m, [90, 50], [88, 55], handleHit(1, "right"), {
      shift: true,
      alt: true,
    });
    const r = snap.table.anchors[1].right;
    expect(r[1]).toBeCloseTo(50, 10);
    expect(r[0]).toBeCloseTo(50 + Math.hypot(38, 5), 10);
  });

  it("a handle dragged onto its anchor leaves the opposite one where it was", () => {
    const m = machine(ARCH);
    const snap = drag(m, [90, 50], [50, 50], handleHit(1, "right"));
    expect(snap.table.anchors[1].right).toEqual([50, 50]);
    expect(snap.table.anchors[1].left).toEqual([30, 50]);
  });

  it("dragging a handle does not change the selection", () => {
    const m = machine(ARCH, { selection: [0, 2] });
    expect(drag(m, [90, 50], [90, 80], handleHit(1, "right")).selected).toEqual([0, 2]);
  });
});

describe("DirectSelectMachine — dragging a segment", () => {
  it("reshapes the two adjacent handles so the grabbed point follows the pointer", () => {
    const m = machine(QUAD);
    // The top edge at its midpoint, pulled 20 up.
    const before = evalCubic([0, 0], [0, 0], [100, 0], [100, 0], 0.5);
    const snap = drag(m, [50, 0], [50, -20], segmentHit(0, 0.5));
    const [a, b] = snap.table.anchors;
    const after = evalCubic(a.anchor, a.right, b.left, b.anchor, 0.5);
    expect(after[0]).toBeCloseTo(before[0], 10);
    expect(after[1]).toBeCloseTo(before[1] - 20, 10);
    // The anchors stayed; only the INNER handles of the segment moved.
    expect(a.anchor).toEqual([0, 0]);
    expect(b.anchor).toEqual([100, 0]);
    expect(a.left).toEqual([0, 0]);
    expect(b.right).toEqual([100, 0]);
    // At t = ½ the two handles share the drag equally: 20 / (3·¼·½·2).
    expect(a.right[1]).toBeCloseTo(-80 / 3, 10);
    expect(b.left[1]).toBeCloseTo(-80 / 3, 10);
    expect(snap.commit!.kind).toBe("segment");
    expect(snap.commit!.ops.map((o) => [o.index, "role" in o && o.role])).toEqual([
      [0, "right"],
      [1, "left"],
    ]);
  });

  it("near the start only the start anchor's handle bends", () => {
    const m = machine(QUAD);
    const snap = drag(m, [10, 0], [10, -5], segmentHit(0, 0.1));
    expect(snap.table.anchors[1].left).toEqual([100, 0]);
    expect(snap.table.anchors[0].right[1]).toBeLessThan(0);
    expect(snap.commit!.ops).toHaveLength(1);
  });

  it("a closed contour wraps: its last anchor starts the closing segment", () => {
    const m = machine(QUAD);
    // Segment 3 runs (0,100) → (0,0).
    const snap = drag(m, [0, 50], [-20, 50], segmentHit(3, 0.5));
    // Ops are in ascending index order, whichever way the segment runs.
    expect(snap.commit!.ops.map((o) => [o.index, "role" in o && o.role])).toEqual([
      [0, "left"],
      [3, "right"],
    ]);
    const s = snap.table.anchors[3];
    const e = snap.table.anchors[0];
    expect(evalCubic(s.anchor, s.right, e.left, e.anchor, 0.5)[0]).toBeCloseTo(-20, 10);
  });

  it("an OPEN contour's last anchor starts no segment — the press is empty space", () => {
    const m = machine(ARCH);
    down(m, [100, 0], segmentHit(2, 0.5));
    expect(move(m, [150, 50]).mode).toBe("marquee");
  });

  it("Shift constrains the segment drag to 45° from the drag origin", () => {
    const m = machine(QUAD);
    down(m, [50, 0], segmentHit(0, 0.5));
    const snap = up(m, [53, -20], SHIFT);
    const [a, b] = snap.table.anchors;
    const mid = evalCubic(a.anchor, a.right, b.left, b.anchor, 0.5);
    expect(mid[0]).toBeCloseTo(50, 10);
    expect(mid[1]).toBeCloseTo(-Math.hypot(3, 20), 10);
  });
});

describe("DirectSelectMachine — selecting", () => {
  it("a click selects one anchor", () => {
    const m = machine(QUAD);
    expect(click(m, [100, 0], anchorHit(1)).selected).toEqual([1]);
    expect(click(m, [0, 100], anchorHit(3)).selected).toEqual([3]);
  });

  it("a click on one anchor of a multi-selection collapses it to that anchor", () => {
    const m = machine(QUAD, { selection: [0, 1, 2] });
    // The press alone keeps all three (it may be the start of a drag)…
    expect(down(m, [100, 0], anchorHit(1)).selected).toEqual([0, 1, 2]);
    // …the release, having gone nowhere, picks the one.
    expect(up(m, [100, 0]).selected).toEqual([1]);
  });

  it("Shift-click toggles", () => {
    const m = machine(QUAD);
    click(m, [0, 0], anchorHit(0));
    expect(click(m, [100, 0], anchorHit(1), SHIFT).selected).toEqual([0, 1]);
    expect(click(m, [0, 0], anchorHit(0), SHIFT).selected).toEqual([1]);
    expect(click(m, [100, 0], anchorHit(1), SHIFT).selected).toEqual([]);
  });

  it("a click on empty space deselects; Shift-click on it does not", () => {
    const m = machine(QUAD, { selection: [0, 2] });
    expect(click(m, [300, 300], EMPTY, SHIFT).selected).toEqual([0, 2]);
    expect(click(m, [300, 300], EMPTY).selected).toEqual([]);
  });

  it("a marquee selects the anchors it encloses", () => {
    const m = machine(QUAD);
    down(m, [-10, -10], EMPTY);
    const live = move(m, [110, 50]);
    expect(live.mode).toBe("marquee");
    expect(live.marquee).toEqual({ x: -10, y: -10, width: 120, height: 60 });
    // The selection previews live…
    expect(live.selected).toEqual([0, 1]);
    const snap = up(m, [110, 50]);
    // …and the release keeps it, with the marquee gone and nothing sent.
    expect(snap.selected).toEqual([0, 1]);
    expect(snap.marquee).toBeNull();
    expect(snap.commit).toBeNull();
  });

  it("a marquee dragged up-left is normalised", () => {
    const m = machine(QUAD);
    down(m, [110, 110], EMPTY);
    const live = move(m, [90, 90]);
    expect(live.marquee).toEqual({ x: 90, y: 90, width: 20, height: 20 });
    expect(live.selected).toEqual([2]);
  });

  it("a marquee replaces the selection; a Shift-marquee adds to it", () => {
    const m = machine(QUAD, { selection: [3] });
    down(m, [-10, -10], EMPTY);
    expect(up(m, [10, 10]).selected).toEqual([0]);
    down(m, [90, -10], EMPTY);
    expect(up(m, [110, 110], SHIFT).selected).toEqual([0, 1, 2]);
  });

  it("a marquee that encloses nothing deselects", () => {
    const m = machine(QUAD, { selection: [1] });
    down(m, [200, 200], EMPTY);
    expect(up(m, [260, 260]).selected).toEqual([]);
  });

  it("reports the click's hit so a host can layer double-click / insert on it", () => {
    const m = machine(QUAD);
    expect(click(m, [50, 0], segmentHit(0, 0.5)).click).toEqual(segmentHit(0, 0.5));
    expect(click(m, [0, 0], anchorHit(0)).click).toEqual(anchorHit(0));
    // A drag is not a click.
    expect(drag(m, [0, 0], [20, 20], anchorHit(0)).click).toBeNull();
  });

  it("setSelection replaces it, dropping indices the table does not have", () => {
    const m = machine(QUAD);
    expect(m.setSelection([3, 1, 9, -1, 1.5]).selected).toEqual([1, 3]);
  });
});

describe("DirectSelectMachine — click vs drag", () => {
  it("travel within the slop is a click: no ops, nothing moved", () => {
    const m = machine(QUAD);
    down(m, [0, 0], anchorHit(0));
    const during = move(m, [1, 1]);
    expect(during.mode).toBe("press");
    expect(during.table.anchors[0].anchor).toEqual([0, 0]);
    const snap = up(m, [1.4, 1.4]);
    expect(snap.commit).toBeNull();
    expect(snap.click).toEqual(anchorHit(0));
    expect(snap.table.anchors[0].anchor).toEqual([0, 0]);
  });

  it("travel past the slop is a drag", () => {
    const m = machine(QUAD);
    down(m, [0, 0], anchorHit(0));
    expect(move(m, [2.5, 0]).mode).toBe("anchors");
    expect(up(m, [2.5, 0]).commit).not.toBeNull();
  });

  it("a release far from the press with no move in between is still a drag", () => {
    const m = machine(QUAD);
    down(m, [0, 0], anchorHit(0));
    const snap = up(m, [40, 0]);
    expect(snap.click).toBeNull();
    expect(snap.commit!.ops).toEqual([
      { op: "pathPointSet", index: 0, role: "anchor", position: [40, 0] },
    ]);
  });

  it("a drag that ends where it began emits no ops", () => {
    for (const hit of [anchorHit(1), handleHit(1, "right"), segmentHit(0, 0.5)]) {
      const m = machine(ARCH);
      down(m, [50, 50], hit);
      // Out past the slop — the preview really did change…
      const away = move(m, [80, 20]);
      expect(away.mode, hit.kind).not.toBe("press");
      expect(away.table.anchors, hit.kind).not.toEqual(ARCH.anchors);
      // …and back onto the press point.
      const snap = up(m, [50, 50]);
      expect(snap.commit, hit.kind).toBeNull();
      // It WAS a drag — so it is not a click either.
      expect(snap.click, hit.kind).toBeNull();
      expectTablesClose(snap.table, ARCH, 12);
    }
  });

  it("…even where re-deriving the handles would not land on the same numbers", () => {
    // SMOOTH within tolerance but not exactly collinear: re-pairing the
    // opposite handle would straighten it — an op for a drag that went
    // nowhere.
    const nearly: AnchorTable = {
      anchors: [corner(0, 0), { anchor: [50, 50], left: [30, 50.01], right: [90, 50] }, corner(100, 0)],
      subpathStarts: [0],
      subpathOpen: [true],
    };
    const m = machine(nearly);
    down(m, [90, 50], handleHit(1, "right"));
    // Out there it IS re-paired (the left handle is straightened)…
    expect(move(m, [91, 53]).table.anchors[1].left).not.toEqual([30, 50.01]);
    // …back home it is the anchor the press found.
    const snap = up(m, [90, 50]);
    expect(snap.commit).toBeNull();
    expect(snap.table.anchors[1]).toEqual(nearly.anchors[1]);

    // Shift held on a handle that sits off the 45° grid: the constraint
    // would snap it, though the pointer is back where it started.
    const offGrid: AnchorTable = {
      anchors: [corner(0, 0), { anchor: [50, 50], left: [50, 50], right: [90, 55] }],
      subpathStarts: [0],
      subpathOpen: [true],
    };
    const m2 = machine(offGrid);
    down(m2, [90, 55], handleHit(1, "right"));
    move(m2, [60, 80], SHIFT);
    const held = up(m2, [90, 55], SHIFT);
    expect(held.commit).toBeNull();
    expect(held.table.anchors[1].right).toEqual([90, 55]);
  });

  it("an Escape mid-drag cancels with zero ops and restores the selection", () => {
    const m = machine(QUAD, { selection: [0, 1] });
    down(m, [100, 100], anchorHit(2));
    expect(move(m, [150, 150]).selected).toEqual([2]);
    const cancelled = key(m, "Escape");
    expect(cancelled.commit).toBeNull();
    expect(cancelled.mode).toBe("idle");
    expect(cancelled.selected).toEqual([0, 1]);
    expect(cancelled.table.anchors[2].anchor).toEqual([100, 100]);
    // The trailing `up` belongs to the cancelled gesture: ignored.
    const after = up(m, [150, 150]);
    expect(after.commit).toBeNull();
    expect(after.click).toBeNull();
    expect(after.table.anchors[2].anchor).toEqual([100, 100]);
  });

  it("an Escape cancels a marquee and a handle drag the same way", () => {
    const m = machine(ARCH, { selection: [1] });
    down(m, [-10, -10], EMPTY);
    move(m, [200, 200]);
    const marquee = key(m, "Escape");
    expect(marquee.marquee).toBeNull();
    expect(marquee.selected).toEqual([1]);
    down(m, [90, 50], handleHit(1, "right"));
    move(m, [50, 90]);
    expect(key(m, "Escape").table.anchors[1]).toEqual(ARCH.anchors[1]);
  });

  it("an idle Escape is not the machine's: nothing changes", () => {
    const m = machine(QUAD, { selection: [2] });
    const snap = key(m, "Escape");
    expect(snap.selected).toEqual([2]);
    expect(snap.commit).toBeNull();
  });

  it("a second press while one is open drops the first cleanly", () => {
    const m = machine(QUAD);
    down(m, [0, 0], anchorHit(0));
    move(m, [30, 30]);
    // The `up` was lost. A new press starts from the committed table.
    const snap = down(m, [100, 0], anchorHit(1));
    expect(snap.table.anchors[0].anchor).toEqual([0, 0]);
    expect(snap.mode).toBe("press");
  });

  it("moves with no button down are hovers and change nothing", () => {
    const m = machine(QUAD, { selection: [1] });
    const snap = move(m, [40, 40]);
    expect(snap.mode).toBe("idle");
    expect(snap.selected).toEqual([1]);
    expect(up(m, [40, 40]).commit).toBeNull();
  });
});

describe("DirectSelectMachine — keys", () => {
  it("arrow keys nudge the selected anchors by the caller's step", () => {
    const m = new DirectSelectMachine({ table: QUAD, slop: 2, nudgeStep: 0.5, selection: [0, 2] });
    const right = key(m, "ArrowRight");
    expect(right.commit).toEqual({
      kind: "nudge",
      ops: [
        { op: "pathPointSet", index: 0, role: "anchor", position: [0.5, 0] },
        { op: "pathPointSet", index: 2, role: "anchor", position: [100.5, 100] },
      ],
    });
    // Up is −y: page space is y-down.
    const upSnap = key(m, "ArrowUp");
    expect(upSnap.table.anchors[0].anchor).toEqual([0.5, -0.5]);
    expect(key(m, "ArrowLeft").table.anchors[0].anchor).toEqual([0, -0.5]);
    expect(key(m, "ArrowDown").table.anchors[0].anchor).toEqual([0, 0]);
    // The unselected anchors never moved.
    expect(m.snapshot().table.anchors[1].anchor).toEqual([100, 0]);
  });

  it("Shift multiplies the nudge by ten", () => {
    const m = machine(QUAD, { selection: [1] });
    expect(key(m, "ArrowRight", SHIFT).table.anchors[1].anchor).toEqual([110, 0]);
  });

  it("a nudge carries the handles with the anchor", () => {
    const m = machine(ARCH, { selection: [1] });
    const snap = key(m, "ArrowDown");
    expect(snap.table.anchors[1]).toEqual({ anchor: [50, 51], left: [30, 51], right: [90, 51] });
    expect(snap.commit!.ops).toHaveLength(1);
  });

  it("each key is its own plan; with nothing selected there is none", () => {
    const m = machine(QUAD);
    expect(key(m, "ArrowRight").commit).toBeNull();
    m.setSelection([0]);
    expect(key(m, "ArrowRight").commit).not.toBeNull();
    expect(key(m, "ArrowRight").commit).not.toBeNull();
    expect(m.snapshot().commit).toBeNull();
  });

  it("keys other than Escape wait while the pointer is down", () => {
    const m = machine(QUAD, { selection: [0] });
    down(m, [0, 0], anchorHit(0));
    move(m, [20, 0]);
    expect(key(m, "ArrowRight").commit).toBeNull();
    expect(key(m, "Delete").commit).toBeNull();
    expect(up(m, [20, 0]).table.anchors[0].anchor).toEqual([20, 0]);
  });

  it("Delete removes the selected anchors, highest index first", () => {
    const m = machine(QUAD, { selection: [1, 3] });
    const snap = key(m, "Delete");
    expect(snap.commit).toEqual({
      kind: "delete",
      ops: [
        { op: "pathPointRemove", index: 3 },
        { op: "pathPointRemove", index: 1 },
      ],
    });
    expect(snap.table.anchors.map((a) => a.anchor)).toEqual([
      [0, 0],
      [100, 100],
    ]);
    expect(snap.selected).toEqual([]);
  });

  it("Backspace is Delete", () => {
    const m = machine(QUAD, { selection: [0] });
    expect(key(m, "Backspace").commit!.ops).toEqual([{ op: "pathPointRemove", index: 0 }]);
  });

  it("Delete refuses to shrink a contour below two anchors — nothing is removed", () => {
    const m = machine(QUAD, { selection: [0, 1, 2] });
    const snap = key(m, "Delete");
    expect(snap.commit).toBeNull();
    expect(snap.refusal).toEqual({ reason: "contourFloor", contours: [0] });
    expect(snap.table.anchors).toHaveLength(4);
    expect(snap.selected).toEqual([0, 1, 2]);
    // The refusal is transient.
    expect(m.snapshot().refusal).toBeNull();
  });

  it("the floor is per contour, and one starved contour refuses the whole delete", () => {
    // Contour 1 (anchors 3–5) would keep one; contour 0 would be fine.
    const m = machine(COMPOUND, { selection: [0, 3, 4] });
    const snap = key(m, "Delete");
    expect(snap.refusal).toEqual({ reason: "contourFloor", contours: [1] });
    expect(snap.commit).toBeNull();
    expect(snap.table.anchors).toHaveLength(6);
  });

  it("Delete with nothing selected does nothing", () => {
    const m = machine(QUAD);
    const snap = key(m, "Delete");
    expect(snap.commit).toBeNull();
    expect(snap.refusal).toBeNull();
  });
});

describe("DirectSelectMachine — subpaths", () => {
  it("indices are flat across contours", () => {
    const m = machine(COMPOUND);
    const snap = drag(m, [150, 50], [150, 80], anchorHit(4));
    expect(snap.commit!.ops).toEqual([
      { op: "pathPointSet", index: 4, role: "anchor", position: [150, 80] },
    ]);
    expect(snap.table.subpathStarts).toEqual([0, 3]);
    expect(snap.table.subpathOpen).toEqual([false, true]);
  });

  it("a closed contour's closing segment wraps inside ITS contour", () => {
    const m = machine(COMPOUND);
    // Anchor 2 is the triangle's last: its segment returns to anchor 0,
    // not on to anchor 3 (the next contour's first).
    const snap = drag(m, [10, 20], [0, 20], segmentHit(2, 0.5));
    expect(snap.commit!.ops.map((o) => [o.index, "role" in o && o.role])).toEqual([
      [0, "left"],
      [2, "right"],
    ]);
  });

  it("the open contour's last anchor (the table's last) starts no segment", () => {
    const m = machine(COMPOUND);
    down(m, [200, 0], segmentHit(5, 0.5));
    expect(move(m, [260, 60]).mode).toBe("marquee");
  });

  it("a marquee reaches across contours", () => {
    const m = machine(COMPOUND);
    down(m, [30, -10], EMPTY);
    expect(up(m, [110, 10]).selected).toEqual([1, 3]);
  });

  it("Delete keeps the contour starts pointing at their contours", () => {
    const m = machine(COMPOUND, { selection: [1, 4] });
    const snap = key(m, "Delete");
    expect(snap.commit!.ops).toEqual([
      { op: "pathPointRemove", index: 4 },
      { op: "pathPointRemove", index: 1 },
    ]);
    expect(snap.table.subpathStarts).toEqual([0, 2]);
    expect(snap.table.subpathOpen).toEqual([false, true]);
    // The engine's own remove rule agrees with the machine's table.
    const model = applyPathOps(COMPOUND, snap.commit!.ops);
    expect(model.subpathStarts).toEqual([0, 2]);
    expect(model.anchors).toEqual(snap.table.anchors);
  });

  it("a single-contour table with no explicit starts works the same", () => {
    const bare: AnchorTable = { anchors: QUAD.anchors, subpathStarts: [] };
    const m = machine(bare, { selection: [0] });
    // No `subpathOpen` ⇒ closed ⇒ the closing segment exists.
    expect(drag(m, [0, 50], [-10, 50], segmentHit(3, 0.5)).commit!.ops).toHaveLength(2);
    expect(key(m, "Delete").table.subpathStarts).toEqual([]);
  });
});

describe("DirectSelectMachine — coordinate spaces", () => {
  // Inner → pointer: scale ×2, then +(10, 20).
  const T: Affine = [2, 0, 0, 2, 10, 20];

  it("the snapshot is in POINTER space, the plan in the path's INNER space", () => {
    const m = machine(QUAD, { transform: T });
    // Inner (100, 0) shows at pointer (210, 20).
    expect(m.snapshot().table.anchors[1].anchor).toEqual([210, 20]);
    const snap = drag(m, [210, 20], [230, 60], anchorHit(1));
    expect(snap.table.anchors[1].anchor).toEqual([230, 60]);
    expect(snap.commit!.ops).toEqual([
      { op: "pathPointSet", index: 1, role: "anchor", position: [110, 20] },
    ]);
  });

  it("the slop, the nudge and the marquee are measured in pointer space", () => {
    const m = machine(QUAD, { transform: T, selection: [0] });
    // One pointer-space unit is half an inner unit.
    expect(key(m, "ArrowRight").commit!.ops).toEqual([
      { op: "pathPointSet", index: 0, role: "anchor", position: [0.5, 0] },
    ]);
    down(m, [200, 10], EMPTY);
    expect(up(m, [220, 30]).selected).toEqual([1]);
  });

  it("a rotated path is constrained along the SCREEN's axes, not its own", () => {
    // 90° rotation: inner +x shows as pointer +y.
    const R: Affine = [0, 1, -1, 0, 0, 0];
    const m = machine(QUAD, { transform: R });
    down(m, [0, 0], anchorHit(0));
    const snap = up(m, [30, 3], SHIFT);
    // On screen: a horizontal move.
    expect(snap.table.anchors[0].anchor[1]).toBeCloseTo(0, 10);
    // In the path's own frame that is a move along −y… of inner y, i.e.
    // inner = R⁻¹(pointer) = (py, −px).
    const op = snap.commit!.ops[0];
    if (op.op !== "pathPointSet") throw new Error("expected a pathPointSet");
    expect(op.position[0]).toBeCloseTo(0, 10);
    expect(op.position[1]).toBeCloseTo(-Math.hypot(30, 3), 10);
  });

  it("an identity transform is exactly no transform", () => {
    const m = machine(QUAD, { transform: [1, 0, 0, 1, 0, 0] });
    expect(drag(m, [0, 0], [0.1, 0.2], anchorHit(0), ALT).commit).toBeNull();
    expect(drag(m, [0, 0], [7.3, 0.2], anchorHit(0)).commit!.ops).toEqual([
      { op: "pathPointSet", index: 0, role: "anchor", position: [7.3, 0.2] },
    ]);
  });

  it("a singular transform cannot be written back: refused, nothing moved", () => {
    const m = machine(QUAD, { transform: [1, 0, 0, 0, 0, 0] });
    const snap = drag(m, [0, 0], [30, 0], anchorHit(0));
    expect(snap.commit).toBeNull();
    expect(snap.refusal).toEqual({ reason: "singularTransform" });
    expect(snap.table.anchors[0].anchor).toEqual([0, 0]);
    // Delete addresses indices only, so it still works.
    m.setSelection([0]);
    expect(key(m, "Delete").commit!.ops).toEqual([{ op: "pathPointRemove", index: 0 }]);
  });
});

describe("DirectSelectMachine — the host's side", () => {
  it("sync re-seats the table and keeps the selection that still exists", () => {
    const m = machine(QUAD, { selection: [1, 3] });
    const smaller: AnchorTable = {
      anchors: [corner(5, 5), corner(105, 5), corner(105, 105)],
      subpathStarts: [0],
      subpathOpen: [false],
    };
    const snap = m.sync(smaller);
    expect(snap.table.anchors[0].anchor).toEqual([5, 5]);
    expect(snap.selected).toEqual([1]);
    expect(snap.mode).toBe("idle");
  });

  it("sync drops a gesture in flight and can change the transform", () => {
    const m = machine(QUAD);
    down(m, [0, 0], anchorHit(0));
    move(m, [50, 50]);
    const snap = m.sync(QUAD, [1, 0, 0, 1, 7, 7]);
    expect(snap.mode).toBe("idle");
    expect(snap.table.anchors[0].anchor).toEqual([7, 7]);
    expect(up(m, [50, 50]).commit).toBeNull();
  });

  it("a hit the table cannot honour degrades to empty space", () => {
    const m = machine(QUAD, { selection: [0] });
    for (const hit of [anchorHit(9), handleHit(-1, "left"), segmentHit(0, Number.NaN)]) {
      down(m, [0, 0], hit);
      expect(move(m, [50, 50]).mode).toBe("marquee");
      key(m, "Escape");
    }
  });

  it("a plan lowers to ONE batch addressed at the element", () => {
    const m = machine(QUAD, { selection: [0, 1] });
    const snap = drag(m, [0, 0], [5, 5], anchorHit(0));
    const id = { kind: "polygon", id: "u1" } as const;
    expect(directSelectMutation(snap.commit!, id)).toEqual({
      op: "batch",
      args: {
        ops: [
          { op: "pathPointSet", args: { elementId: id, index: 0, role: "anchor", position: [5, 5] } },
          { op: "pathPointSet", args: { elementId: id, index: 1, role: "anchor", position: [105, 5] } },
        ],
      },
    });
  });

  it("consecutive gestures build on each other without a sync", () => {
    const m = machine(QUAD);
    drag(m, [0, 0], [10, 0], anchorHit(0));
    const snap = drag(m, [10, 0], [10, 10], anchorHit(0));
    expect(snap.commit!.ops).toEqual([
      { op: "pathPointSet", index: 0, role: "anchor", position: [10, 10] },
    ]);
  });
});

// ---- properties --------------------------------------------------------

const coord = fc.double({ min: -500, max: 500, noNaN: true });
const point = fc.tuple(coord, coord);
const modifiersArb = fc.record({ shift: fc.boolean(), alt: fc.boolean() });

const tripleArb: fc.Arbitrary<AnchorTriple> = fc
  .tuple(point, fc.option(point, { nil: null }), fc.option(point, { nil: null }))
  .map(([anchor, left, right]) => ({
    anchor: [anchor[0], anchor[1]],
    left: left ? [left[0], left[1]] : [anchor[0], anchor[1]],
    right: right ? [right[0], right[1]] : [anchor[0], anchor[1]],
  }));

/** 1–3 contours of 2–5 anchors each, open or closed at random. */
const tableArb: fc.Arbitrary<AnchorTable> = fc
  .array(
    fc.record({
      anchors: fc.array(tripleArb, { minLength: 2, maxLength: 5 }),
      open: fc.boolean(),
    }),
    { minLength: 1, maxLength: 3 },
  )
  .map((contours) => {
    const anchors: AnchorTriple[] = [];
    const subpathStarts: number[] = [];
    const subpathOpen: boolean[] = [];
    for (const c of contours) {
      subpathStarts.push(anchors.length);
      subpathOpen.push(c.open);
      anchors.push(...c.anchors);
    }
    return { anchors, subpathStarts, subpathOpen };
  });

/** A smooth anchor: two handles on opposite sides of it, any lengths. */
const smoothArb = fc
  .tuple(
    point,
    fc.double({ min: 0, max: Math.PI * 2, noNaN: true }),
    fc.double({ min: 1, max: 200, noNaN: true }),
    fc.double({ min: 1, max: 200, noNaN: true }),
  )
  .map(([anchor, angle, ll, rl]): AnchorTriple => ({
    anchor: [anchor[0], anchor[1]],
    left: [anchor[0] - Math.cos(angle) * ll, anchor[1] - Math.sin(angle) * ll],
    right: [anchor[0] + Math.cos(angle) * rl, anchor[1] + Math.sin(angle) * rl],
  }));

describe("DirectSelectMachine — properties", () => {
  it("dragging by d then by −d restores the table", () => {
    fc.assert(
      fc.property(tableArb, fc.nat(), point, point, (table, pick, from, d) => {
        // Outside the slop, so both gestures are drags.
        fc.pre(Math.hypot(d[0], d[1]) > 3);
        const index = pick % table.anchors.length;
        const m = machine(table);
        const there: P = [from[0] + d[0], from[1] + d[1]];
        const out = drag(m, from, there, anchorHit(index));
        expect(out.commit).not.toBeNull();
        const back = drag(m, there, from, anchorHit(index));
        expectTablesClose(back.table, table, 9);
      }),
    );
  });

  it("a paired-handle drag keeps the two handles collinear with the anchor", () => {
    fc.assert(
      fc.property(smoothArb, fc.constantFrom<"left" | "right">("left", "right"), point, point, (a, side, from, to) => {
        fc.pre(Math.hypot(to[0] - from[0], to[1] - from[1]) > 3);
        const table: AnchorTable = {
          anchors: [corner(-600, -600), a, corner(600, 600)],
          subpathStarts: [0],
          subpathOpen: [true],
        };
        const other = side === "left" ? "right" : "left";
        const snap = drag(machine(table), from, to, handleHit(1, side));
        const after = snap.table.anchors[1];
        const dragged: P = [after[side][0] - a.anchor[0], after[side][1] - a.anchor[1]];
        const opposite: P = [after[other][0] - a.anchor[0], after[other][1] - a.anchor[1]];
        const dl = Math.hypot(dragged[0], dragged[1]);
        fc.pre(dl > 1e-6);
        const ol = Math.hypot(opposite[0], opposite[1]);
        // Collinear…
        expect(Math.abs(dragged[0] * opposite[1] - dragged[1] * opposite[0])).toBeLessThanOrEqual(1e-7 * dl * ol + 1e-9);
        // …on opposite sides of the anchor…
        expect(dragged[0] * opposite[0] + dragged[1] * opposite[1]).toBeLessThan(0);
        // …and the opposite handle kept its own length.
        expect(ol).toBeCloseTo(Math.hypot(a[other][0] - a.anchor[0], a[other][1] - a.anchor[1]), 6);
        // The anchor itself never moves under a handle drag.
        expect(after.anchor).toEqual(a.anchor);
      }),
    );
  });

  it("the grabbed point of a segment follows the pointer", () => {
    fc.assert(
      fc.property(
        tripleArb,
        tripleArb,
        fc.double({ min: 0.05, max: 0.95, noNaN: true }),
        point,
        point,
        (s, e, t, from, d) => {
          fc.pre(Math.hypot(d[0], d[1]) > 3);
          const table: AnchorTable = { anchors: [s, e], subpathStarts: [0], subpathOpen: [true] };
          const before = evalCubic(s.anchor, s.right, e.left, e.anchor, t);
          const snap = drag(machine(table), from, [from[0] + d[0], from[1] + d[1]], segmentHit(0, t));
          const [a, b] = snap.table.anchors;
          const after = evalCubic(a.anchor, a.right, b.left, b.anchor, t);
          expect(after[0]).toBeCloseTo(before[0] + d[0], 6);
          expect(after[1]).toBeCloseTo(before[1] + d[1], 6);
          expect(a.anchor).toEqual(s.anchor);
          expect(b.anchor).toEqual(e.anchor);
        },
      ),
    );
  });

  // Any event stream at all: hits that may not exist, modifiers at
  // random, keys mid-drag.
  const eventArb = (n: number): fc.Arbitrary<DirectSelectEvent> => {
    const index = fc.integer({ min: -1, max: n });
    const hit: fc.Arbitrary<DirectSelectHit> = fc.oneof(
      fc.constant<DirectSelectHit>(EMPTY),
      index.map(anchorHit),
      fc.tuple(index, fc.constantFrom<"left" | "right">("left", "right")).map(([i, s]) => handleHit(i, s)),
      fc.tuple(index, fc.double({ min: 0, max: 1, noNaN: true })).map(([i, t]) => segmentHit(i, t)),
    );
    return fc.oneof(
      fc.record({ type: fc.constant("down" as const), point, hit, modifiers: modifiersArb }),
      fc.record({ type: fc.constant("move" as const), point, modifiers: modifiersArb }),
      fc.record({ type: fc.constant("up" as const), point, modifiers: modifiersArb }),
      fc.record({
        type: fc.constant("key" as const),
        key: fc.constantFrom(
          "ArrowLeft" as const,
          "ArrowRight" as const,
          "ArrowUp" as const,
          "ArrowDown" as const,
          "Delete" as const,
          "Escape" as const,
        ),
        modifiers: modifiersArb,
      }),
    );
  };

  const scenarioArb = tableArb.chain((table) =>
    fc.tuple(fc.constant(table), fc.array(eventArb(table.anchors.length), { maxLength: 40 })),
  );

  function replay(
    table: AnchorTable,
    events: DirectSelectEvent[],
    transform: Affine | null,
    check: (snap: DirectSelectSnapshot, engine: ModelTable) => void,
  ) {
    const m = machine(table, { transform });
    // What the ENGINE holds: the inner-space table, changed only by the
    // plans the machine commits.
    let engine: AnchorTable = table;
    for (const event of events) {
      const snap = m.handle(event);
      if (!snap.commit) continue;
      expect(snap.commit.ops.length).toBeGreaterThan(0);
      // Throws on any index the table does not have at that point.
      const next = applyPathOps(engine, snap.commit.ops);
      engine = next;
      check(snap, next);
    }
  }

  it("commit ops reference only valid indices, and applying them yields the previewed table", () => {
    fc.assert(
      fc.property(scenarioArb, ([table, events]) => {
        replay(table, events, null, (snap, engine) => {
          expectTablesClose(snap.table, engine, 6);
          expect([...snap.table.subpathStarts]).toEqual(engine.subpathStarts);
          for (const i of snap.selected) expect(i).toBeLessThan(engine.anchors.length);
        });
      }),
      { numRuns: 300 },
    );
  });

  it("under any invertible transform the plan, applied in inner space, shows as the preview", () => {
    const affineArb = fc
      .tuple(
        fc.double({ min: 0, max: Math.PI * 2, noNaN: true }),
        fc.double({ min: 0.25, max: 4, noNaN: true }),
        fc.double({ min: 0.25, max: 4, noNaN: true }),
        point,
      )
      .map(([r, sx, sy, [tx, ty]]): Affine => [
        Math.cos(r) * sx,
        Math.sin(r) * sx,
        -Math.sin(r) * sy,
        Math.cos(r) * sy,
        tx,
        ty,
      ]);
    fc.assert(
      fc.property(scenarioArb, affineArb, ([table, events], transform) => {
        replay(table, events, transform, (snap, engine) => {
          const shown = {
            anchors: engine.anchors.map((a) => ({
              anchor: applyAffine(transform, a.anchor[0], a.anchor[1]),
              left: applyAffine(transform, a.left[0], a.left[1]),
              right: applyAffine(transform, a.right[0], a.right[1]),
            })),
          };
          expectTablesClose(snap.table, shown, 5);
        });
      }),
      { numRuns: 200 },
    );
  });

  it("Escape during any gesture leaves no trace", () => {
    fc.assert(
      fc.property(tableArb, fc.nat(), point, point, modifiersArb, (table, pick, from, to, mods) => {
        const n = table.anchors.length;
        const hits = [EMPTY, anchorHit(pick % n), handleHit(pick % n, "left"), segmentHit(pick % n, 0.4)];
        for (const hit of hits) {
          const m = machine(table, { selection: [0] });
          const before = m.snapshot();
          down(m, from, hit, mods);
          move(m, to, mods);
          const snap = key(m, "Escape");
          expect(snap.commit).toBeNull();
          expect(snap.table).toBe(before.table);
          expect(snap.selected).toEqual(before.selected);
          expect(up(m, to, mods).commit).toBeNull();
        }
      }),
    );
  });
});

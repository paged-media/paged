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

import { describe, expect, it } from "vitest";

import {
  PenMachine,
  penPreview,
  strokeWidthFromPressure,
  type PenModifiers,
} from "../src/pen-machine";

const NONE: PenModifiers = { shift: false, alt: false };
const SHIFT: PenModifiers = { shift: true, alt: false };
const ALT: PenModifiers = { shift: false, alt: true };

function machine() {
  return new PenMachine({ closeTolerance: 4, dragThreshold: 2 });
}

function click(m: PenMachine, point: [number, number], mods = NONE) {
  m.handle({ type: "down", point, modifiers: mods });
  return m.handle({ type: "up", point, modifiers: mods });
}

describe("PenMachine — clicks", () => {
  it("click places a corner anchor", () => {
    const m = machine();
    const snap = click(m, [10, 10]);
    expect(snap.anchors).toHaveLength(1);
    expect(snap.anchors[0]).toEqual({
      anchor: [10, 10],
      left: [10, 10],
      right: [10, 10],
    });
    expect(snap.active).toBe(true);
    expect(snap.commit).toBeNull();
  });

  it("Shift+click constrains placement to 45° from the previous anchor", () => {
    const m = machine();
    click(m, [0, 0]);
    const snap = click(m, [20, 3], SHIFT);
    expect(snap.anchors[1].anchor[1]).toBeCloseTo(0);
  });

  it("Enter commits an open path with >= 2 anchors", () => {
    const m = machine();
    click(m, [0, 0]);
    click(m, [30, 0]);
    const snap = m.handle({ type: "key", key: "Enter" });
    expect(snap.commit).not.toBeNull();
    expect(snap.commit!.open).toBe(true);
    expect(snap.commit!.anchors).toHaveLength(2);
    expect(snap.active).toBe(false);
  });

  it("Enter with a single anchor cancels instead of committing", () => {
    const m = machine();
    click(m, [0, 0]);
    const snap = m.handle({ type: "key", key: "Enter" });
    expect(snap.commit).toBeNull();
    expect(snap.active).toBe(false);
  });

  it("Escape cancels without commit", () => {
    const m = machine();
    click(m, [0, 0]);
    click(m, [30, 0]);
    const snap = m.handle({ type: "key", key: "Escape" });
    expect(snap.commit).toBeNull();
    expect(snap.active).toBe(false);
  });
});

describe("PenMachine — drags (smooth anchors)", () => {
  it("drag creates a smooth anchor with mirrored handles", () => {
    const m = machine();
    m.handle({ type: "down", point: [10, 10], modifiers: NONE });
    m.handle({ type: "move", point: [18, 14], modifiers: NONE });
    const snap = m.handle({ type: "up", point: [18, 14], modifiers: NONE });
    expect(snap.anchors[0].anchor).toEqual([10, 10]);
    expect(snap.anchors[0].right).toEqual([18, 14]);
    expect(snap.anchors[0].left).toEqual([2, 6]);
  });

  it("movement under the drag threshold stays a corner", () => {
    const m = machine();
    m.handle({ type: "down", point: [10, 10], modifiers: NONE });
    m.handle({ type: "move", point: [11, 10], modifiers: NONE });
    const snap = m.handle({ type: "up", point: [11, 10], modifiers: NONE });
    expect(snap.anchors[0].right).toEqual([10, 10]);
  });

  it("Alt during drag freezes the mirrored left handle", () => {
    const m = machine();
    m.handle({ type: "down", point: [0, 0], modifiers: NONE });
    m.handle({ type: "move", point: [10, 0], modifiers: NONE });
    // left mirrored to [-10, 0] here; Alt breaks the pair…
    m.handle({ type: "move", point: [10, 10], modifiers: ALT });
    const snap = m.handle({ type: "up", point: [10, 10], modifiers: ALT });
    expect(snap.anchors[0].right).toEqual([10, 10]);
    expect(snap.anchors[0].left).toEqual([-10, 0]);
  });

  it("Shift constrains the handle pull", () => {
    const m = machine();
    m.handle({ type: "down", point: [0, 0], modifiers: NONE });
    m.handle({ type: "move", point: [20, 2], modifiers: SHIFT });
    const snap = m.handle({ type: "up", point: [20, 2], modifiers: SHIFT });
    expect(snap.anchors[0].right[1]).toBeCloseTo(0);
  });
});

describe("PenMachine — closing + preview", () => {
  it("clicking the first anchor closes the path", () => {
    const m = machine();
    click(m, [0, 0]);
    click(m, [30, 0]);
    click(m, [30, 30]);
    const snap = click(m, [1, 1]); // within closeTolerance of [0,0]
    expect(snap.commit).not.toBeNull();
    expect(snap.commit!.open).toBe(false);
    expect(snap.commit!.anchors).toHaveLength(3);
    expect(snap.active).toBe(false);
  });

  it("hover publishes the rubber band and the close preview", () => {
    const m = machine();
    click(m, [0, 0]);
    click(m, [30, 0]);
    let snap = m.handle({ type: "move", point: [40, 10], modifiers: NONE });
    expect(snap.rubberTo).toEqual([40, 10]);
    expect(snap.closePreview).toBe(false);
    snap = m.handle({ type: "move", point: [2, 1], modifiers: NONE });
    expect(snap.closePreview).toBe(true);
  });

  it("a close-click on the first anchor of a 1-anchor path places a point instead", () => {
    const m = machine();
    click(m, [0, 0]);
    const snap = click(m, [1, 1]);
    expect(snap.commit).toBeNull();
    expect(snap.anchors).toHaveLength(2);
  });

  it("events after commit are inert", () => {
    const m = machine();
    click(m, [0, 0]);
    click(m, [30, 0]);
    m.handle({ type: "key", key: "Enter" });
    const snap = click(m, [50, 50]);
    expect(snap.active).toBe(false);
    expect(snap.anchors).toHaveLength(2);
  });
});

describe("penPreview — B-07 cubic tool preview", () => {
  // The variant the host pushes through `overlay.setToolPreview`: the
  // SAME anchor/handle run the machine holds, NOT a flattened polyline.
  // The shell renderer turns these into one <path> of `C` commands.

  it("emits the cubic anchor run verbatim — segment data, not sampled points", () => {
    const m = machine();
    // Corner, then a smooth anchor via a drag (pulls handles).
    click(m, [0, 0]);
    m.handle({ type: "down", point: [40, 0], modifiers: NONE });
    const snap = m.handle({ type: "move", point: [60, 20], modifiers: NONE });
    const preview = penPreview(snap, "p1");
    expect(preview).not.toBeNull();
    // It carries `anchors` (the cubic form), NOT `points` (a polyline).
    expect(preview).toHaveProperty("anchors");
    expect(preview).not.toHaveProperty("points");
    expect(preview!.pageId).toBe("p1");
    expect(preview!.anchors).toHaveLength(2);
    // The dragged anchor's outgoing handle is the pull — true curve data,
    // proving NO flattening happened (a polyline would have lost it).
    const dragged = preview!.anchors[1];
    expect(dragged.right).toEqual([60, 20]);
    expect(dragged.left).toEqual([20, -20]); // mirrored about [40,0]
  });

  it("appends the rubber-band to the hover cursor as a trailing corner anchor", () => {
    const m = machine();
    click(m, [0, 0]);
    click(m, [30, 0]);
    const snap = m.handle({ type: "move", point: [40, 10], modifiers: NONE });
    const preview = penPreview(snap, "p1")!;
    // Two placed anchors + the live rubber-band segment to the cursor.
    expect(preview.anchors).toHaveLength(3);
    const tail = preview.anchors[2];
    expect(tail.anchor).toEqual([40, 10]);
    // A corner anchor — collapsed handles → a straight cubic.
    expect(tail.left).toEqual([40, 10]);
    expect(tail.right).toEqual([40, 10]);
    expect(preview.close).toBe(false);
  });

  it("marks `close` and omits the rubber-band when hovering the first anchor", () => {
    const m = machine();
    click(m, [0, 0]);
    click(m, [30, 0]);
    click(m, [30, 30]);
    const snap = m.handle({ type: "move", point: [2, 1], modifiers: NONE });
    expect(snap.closePreview).toBe(true);
    const preview = penPreview(snap, "p1")!;
    // Three placed anchors, no rubber-band tail (the closing cubic
    // returns to anchor 0).
    expect(preview.anchors).toHaveLength(3);
    expect(preview.close).toBe(true);
  });

  it("returns null for a run too short to stroke (a single anchor)", () => {
    const m = machine();
    const snap = click(m, [0, 0]); // one anchor, no hover
    expect(penPreview(snap, "p1")).toBeNull();
  });

  it("honours the dashed styling option", () => {
    const m = machine();
    click(m, [0, 0]);
    click(m, [30, 0]);
    const snap = m.handle({ type: "move", point: [40, 10], modifiers: NONE });
    expect(penPreview(snap, "p1", { dashed: true })!.dashed).toBe(true);
    // Solid by default — no `dashed` key.
    expect(penPreview(snap, "p1")).not.toHaveProperty("dashed");
  });
});

describe("PenMachine — B-08 pressure", () => {
  it("records the pressure sample per anchor, parallel to anchors", () => {
    const m = machine();
    m.handle({
      type: "down",
      point: [0, 0],
      modifiers: NONE,
      sample: { pressure: 0.2 },
    });
    m.handle({ type: "up", point: [0, 0], modifiers: NONE });
    const snap = m.handle({
      type: "down",
      point: [30, 0],
      modifiers: NONE,
      sample: { pressure: 0.9 },
    });
    expect(snap.anchors).toHaveLength(2);
    expect(snap.pressures).toEqual([0.2, 0.9]);
  });

  it("a missing sample (mouse) records the 0.5 mouse default", () => {
    const m = machine();
    const snap = click(m, [5, 5]);
    expect(snap.pressures).toEqual([0.5]);
  });

  it("pressure NEVER alters the geometry (machines stay pure)", () => {
    const noSample = machine();
    noSample.handle({ type: "down", point: [10, 10], modifiers: NONE });
    noSample.handle({ type: "move", point: [18, 14], modifiers: NONE });
    const a = noSample.handle({ type: "up", point: [18, 14], modifiers: NONE });

    const withSample = machine();
    withSample.handle({
      type: "down",
      point: [10, 10],
      modifiers: NONE,
      sample: { pressure: 0.05, tiltX: 40, tiltY: -10 },
    });
    withSample.handle({ type: "move", point: [18, 14], modifiers: NONE });
    const b = withSample.handle({
      type: "up",
      point: [18, 14],
      modifiers: NONE,
    });

    expect(b.anchors[0]).toEqual(a.anchors[0]);
  });

  it("clamps out-of-range / non-finite pressure into 0..1", () => {
    const m = machine();
    m.handle({
      type: "down",
      point: [0, 0],
      modifiers: NONE,
      sample: { pressure: 5 },
    });
    m.handle({ type: "up", point: [0, 0], modifiers: NONE });
    m.handle({
      type: "down",
      point: [10, 0],
      modifiers: NONE,
      sample: { pressure: -3 },
    });
    const snap = m.handle({ type: "up", point: [10, 0], modifiers: NONE });
    expect(snap.pressures).toEqual([1, 0]);
  });

  it("Escape clears the recorded pressure profile", () => {
    const m = machine();
    m.handle({
      type: "down",
      point: [0, 0],
      modifiers: NONE,
      sample: { pressure: 0.7 },
    });
    m.handle({ type: "up", point: [0, 0], modifiers: NONE });
    const snap = m.handle({ type: "key", key: "Escape" });
    expect(snap.pressures).toEqual([]);
  });
});

describe("strokeWidthFromPressure (B-08 width hook)", () => {
  const profile = { min: 1, max: 5 };

  it("interpolates min..max across pressure 0..1", () => {
    expect(strokeWidthFromPressure(0, profile)).toBe(1);
    expect(strokeWidthFromPressure(1, profile)).toBe(5);
    expect(strokeWidthFromPressure(0.5, profile)).toBe(3);
  });

  it("a mouse pressure (0.5) lands mid-range", () => {
    expect(strokeWidthFromPressure(0.5, profile)).toBe(3);
  });

  it("clamps out-of-range pressure before mapping", () => {
    expect(strokeWidthFromPressure(2, profile)).toBe(5);
    expect(strokeWidthFromPressure(-1, profile)).toBe(1);
    expect(strokeWidthFromPressure(Number.NaN, profile)).toBe(3);
  });

  it("penPreview geometry is unaffected by pressure (pure overlay)", () => {
    // The preview path the host pushes to the overlay is geometry-only;
    // pressure rides the snapshot's `pressures`, never the anchors —
    // so a pressure-carrying run previews identically to a mouse run.
    const m = machine();
    m.handle({
      type: "down",
      point: [0, 0],
      modifiers: NONE,
      sample: { pressure: 0.1 },
    });
    m.handle({ type: "up", point: [0, 0], modifiers: NONE });
    const snap = m.handle({
      type: "down",
      point: [30, 0],
      modifiers: NONE,
      sample: { pressure: 0.95 },
    });
    const preview = penPreview(snap, "page-1");
    expect(preview).not.toBeNull();
    expect(preview!.anchors).toHaveLength(2);
    expect(preview!.anchors[0].anchor).toEqual([0, 0]);
    expect(preview!.anchors[1].anchor).toEqual([30, 0]);
  });
});

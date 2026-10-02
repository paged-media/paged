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

import { ShapeBuilderMachine } from "../src";

const NONE = { alt: false };
const ALT = { alt: true };

describe("ShapeBuilderMachine", () => {
  it("down begins a gesture; mode is unite without Alt", () => {
    const m = new ShapeBuilderMachine();
    const s = m.handle({ type: "down", point: [10, 10], modifiers: NONE });
    expect(s.building).toBe(true);
    expect(s.mode).toBe("unite");
    expect(s.path).toEqual([[10, 10]]);
    expect(s.crossed).toEqual([]);
  });

  it("Alt-down fixes the gesture to subtract for the whole gesture", () => {
    const m = new ShapeBuilderMachine();
    m.handle({ type: "down", point: [0, 0], modifiers: ALT });
    // A later cross does not change the (start-fixed) mode.
    const s = m.handle({ type: "cross", key: "ua" });
    expect(s.mode).toBe("subtract");
  });

  it("collects crossed region keys in first-cross order, de-duped", () => {
    const m = new ShapeBuilderMachine();
    m.handle({ type: "down", point: [0, 0], modifiers: NONE });
    m.handle({ type: "cross", key: "ua" });
    m.handle({ type: "move", point: [50, 50] });
    m.handle({ type: "cross", key: "ub" });
    // A repeat of ua (re-entering the first region) is ignored.
    m.handle({ type: "cross", key: "ua" });
    const s = m.handle({ type: "cross", key: "uc" });
    expect(s.crossed).toEqual(["ua", "ub", "uc"]);
  });

  it("ignores cross events that arrive before a down (no active gesture)", () => {
    const m = new ShapeBuilderMachine();
    const s = m.handle({ type: "cross", key: "ua" });
    expect(s.crossed).toEqual([]);
    expect(s.building).toBe(false);
  });

  it("move extends the gesture polyline while dragging", () => {
    const m = new ShapeBuilderMachine();
    m.handle({ type: "down", point: [0, 0], modifiers: NONE });
    m.handle({ type: "move", point: [10, 0] });
    const s = m.handle({ type: "move", point: [20, 0] });
    expect(s.path).toEqual([
      [0, 0],
      [10, 0],
      [20, 0],
    ]);
  });

  it("up freezes the gesture; crossed + path persist, building flips false", () => {
    const m = new ShapeBuilderMachine();
    m.handle({ type: "down", point: [0, 0], modifiers: NONE });
    m.handle({ type: "cross", key: "ua" });
    m.handle({ type: "cross", key: "ub" });
    const s = m.handle({ type: "up", point: [100, 100] });
    expect(s.building).toBe(false);
    expect(s.crossed).toEqual(["ua", "ub"]);
    expect(s.path?.at(-1)).toEqual([100, 100]);
    // After up, further cross events are inert (no active drag).
    const after = m.handle({ type: "cross", key: "uc" });
    expect(after.crossed).toEqual(["ua", "ub"]);
  });

  it("Escape clears the gesture state", () => {
    const m = new ShapeBuilderMachine();
    m.handle({ type: "down", point: [0, 0], modifiers: NONE });
    m.handle({ type: "cross", key: "ua" });
    const s = m.handle({ type: "key", key: "Escape" });
    expect(s.path).toBeNull();
    expect(s.crossed).toEqual([]);
    expect(s.building).toBe(false);
  });

  it("snapshots are defensive copies (mutating a snapshot doesn't leak)", () => {
    const m = new ShapeBuilderMachine();
    m.handle({ type: "down", point: [0, 0], modifiers: NONE });
    const s = m.handle({ type: "cross", key: "ua" });
    (s.crossed as string[]).push("mutant");
    (s.path as unknown as number[][])?.push([99, 99]);
    const fresh = m.handle({ type: "move", point: [1, 1] });
    expect(fresh.crossed).toEqual(["ua"]);
    expect(fresh.path).toEqual([
      [0, 0],
      [1, 1],
    ]);
  });

  // The path is copied on FIRST READ, not on every event (a drag of N
  // moves used to clone the whole polyline N times). These pin what that
  // must not change: a snapshot is still a snapshot.
  it("a snapshot's path is the polyline as it stood when the snapshot was TAKEN, however late it is read", () => {
    const m = new ShapeBuilderMachine();
    m.handle({ type: "down", point: [0, 0], modifiers: NONE });
    const early = m.handle({ type: "move", point: [1, 1] });
    // …the gesture goes on before anyone looks at `early`.
    m.handle({ type: "move", point: [2, 2] });
    const late = m.handle({ type: "up", point: [3, 3] });
    expect(early.path).toEqual([
      [0, 0],
      [1, 1],
    ]);
    expect(late.path).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
    // And a NEW gesture does not reach back into an old snapshot.
    m.handle({ type: "down", point: [50, 50], modifiers: NONE });
    expect(late.path).toHaveLength(4);
    expect(late.path?.[0]).toEqual([0, 0]);
  });

  it("a snapshot's path is its OWN copy: stable across reads, shared with no other snapshot", () => {
    const m = new ShapeBuilderMachine();
    m.handle({ type: "down", point: [0, 0], modifiers: NONE });
    const a = m.handle({ type: "move", point: [1, 1] });
    const b = m.handle({ type: "move", point: [2, 2] });
    // The same array every time it is asked for (what a caller wrote
    // into it is still there on the next read, as it always was).
    expect(a.path).toBe(a.path);
    (a.path as unknown as number[][])[0][0] = 99;
    expect(a.path?.[0]).toEqual([99, 0]);
    // …and neither the array nor a point in it belongs to anyone else.
    expect(b.path).not.toBe(a.path);
    expect(b.path?.[0]).not.toBe(a.path?.[0]);
    expect(b.path?.[0]).toEqual([0, 0]);
    expect(m.handle({ type: "move", point: [3, 3] }).path?.[0]).toEqual([0, 0]);
  });

  it("an idle machine has no path, before a gesture and after Escape", () => {
    const m = new ShapeBuilderMachine();
    expect(m.handle({ type: "move", point: [5, 5] }).path).toBeNull();
    const dragging = m.handle({ type: "down", point: [0, 0], modifiers: NONE });
    const cleared = m.handle({ type: "key", key: "Escape" });
    expect(cleared.path).toBeNull();
    // The snapshot taken DURING the gesture still has its point.
    expect(dragging.path).toEqual([[0, 0]]);
  });
});

// ---------------------------------------------------------------------
// B-22 — the REGION lane: the machine resolves the face under the
// cursor from an installed arrangement and collects the faces a drag
// crosses. The fixture is the canonical two-overlapping-squares
// arrangement the engine reports for A = [100,100]-[300,300] over
// B = [200,200]-[400,400]: three faces, ids `<signature>#<component>`.

const rect = (
  l: number,
  t: number,
  r: number,
  b: number,
): Array<{
  anchor: [number, number];
  left: [number, number];
  right: [number, number];
}> =>
  (
    [
      [l, t],
      [r, t],
      [r, b],
      [l, b],
    ] as Array<[number, number]>
  ).map((p) => ({ anchor: p, left: p, right: p }));

/** The overlap face (0-1#0), B-only (0#0) and A-only (1#0). The two
 *  non-overlap faces are given as their full squares so the fixture
 *  stays readable; the overlap is listed FIRST, which is what makes the
 *  first-match rule observable (a point in the overlap is inside all
 *  three outlines here). */
const FACES = [
  { id: "0-1#0", anchors: rect(200, 200, 300, 300), subpathStarts: [0] },
  { id: "0#0", anchors: rect(200, 200, 400, 400), subpathStarts: [0] },
  { id: "1#0", anchors: rect(100, 100, 300, 300), subpathStarts: [0] },
];

describe("ShapeBuilderMachine — region lane (B-22)", () => {
  it("setRegions makes the hover resolvable; a move highlights the face under the cursor", () => {
    const m = new ShapeBuilderMachine();
    expect(m.setRegions(FACES).hasRegions).toBe(true);
    const s = m.handle({ type: "move", point: [250, 250] });
    expect(s.hovered).toBe("0-1#0");
    // Hovering is live BEFORE any drag — nothing is collected yet.
    expect(s.collected).toEqual([]);
    expect(s.building).toBe(false);
  });

  it("a hover outside every face clears the highlight", () => {
    const m = new ShapeBuilderMachine();
    m.setRegions(FACES);
    expect(m.handle({ type: "move", point: [250, 250] }).hovered).toBe("0-1#0");
    expect(m.handle({ type: "move", point: [50, 50] }).hovered).toBeNull();
  });

  it("a drag COLLECTS the faces it crosses, in first-cross order, de-duped", () => {
    const m = new ShapeBuilderMachine();
    m.setRegions(FACES);
    m.handle({ type: "down", point: [250, 250], modifiers: NONE }); // overlap
    m.handle({ type: "move", point: [150, 150] }); // A-only
    m.handle({ type: "move", point: [250, 250] }); // back to the overlap
    const s = m.handle({ type: "up", point: [350, 350] }); // B-only
    expect(s.collected).toEqual(["0-1#0", "1#0", "0#0"]);
    expect(s.building).toBe(false);
  });

  it("the face under the DOWN point is collected (a plain click is a one-face gesture)", () => {
    const m = new ShapeBuilderMachine();
    m.setRegions(FACES);
    m.handle({ type: "down", point: [250, 250], modifiers: NONE });
    const s = m.handle({ type: "up", point: [250, 250] });
    expect(s.collected).toEqual(["0-1#0"]);
  });

  it("a drag over empty space collects nothing (the honest no-op)", () => {
    const m = new ShapeBuilderMachine();
    m.setRegions(FACES);
    m.handle({ type: "down", point: [20, 20], modifiers: NONE });
    const s = m.handle({ type: "up", point: [60, 60] });
    expect(s.collected).toEqual([]);
    expect(s.hovered).toBeNull();
  });

  it("faceMode follows the gesture mode: drag = keep, Alt-drag = remove", () => {
    const plain = new ShapeBuilderMachine();
    plain.setRegions(FACES);
    expect(
      plain.handle({ type: "down", point: [250, 250], modifiers: NONE })
        .faceMode,
    ).toBe("keep");
    const alt = new ShapeBuilderMachine();
    alt.setRegions(FACES);
    const s = alt.handle({ type: "down", point: [250, 250], modifiers: ALT });
    expect(s.faceMode).toBe("remove");
    expect(s.mode).toBe("subtract");
  });

  it("without an arrangement the machine resolves nothing and rides injected region events (cold start)", () => {
    const m = new ShapeBuilderMachine();
    expect(m.handle({ type: "move", point: [250, 250] }).hasRegions).toBe(
      false,
    );
    m.handle({ type: "down", point: [250, 250], modifiers: NONE });
    // The host asked the engine's point query and injects the answer.
    const s = m.handle({ type: "region", id: "0-1#0" });
    expect(s.hovered).toBe("0-1#0");
    expect(s.collected).toEqual(["0-1#0"]);
    // A null answer (pointer outside every input) clears the highlight
    // without dropping what was already collected.
    const s2 = m.handle({ type: "region", id: null });
    expect(s2.hovered).toBeNull();
    expect(s2.collected).toEqual(["0-1#0"]);
  });

  it("an arrangement landing mid-hover highlights immediately (no wait for the next move)", () => {
    const m = new ShapeBuilderMachine();
    m.handle({ type: "move", point: [250, 250] });
    expect(m.setRegions(FACES).hovered).toBe("0-1#0");
  });

  it("setRegions(null) drops the cache; the hover stays put until the next answer", () => {
    const m = new ShapeBuilderMachine();
    m.setRegions(FACES);
    expect(m.handle({ type: "move", point: [250, 250] }).hovered).toBe("0-1#0");
    const s = m.setRegions(null);
    expect(s.hasRegions).toBe(false);
    // A move with no arrangement leaves the last answer alone rather
    // than flickering the highlight off between round trips.
    expect(m.handle({ type: "move", point: [50, 50] }).hovered).toBe("0-1#0");
  });

  it("Escape clears the collected faces and the highlight too", () => {
    const m = new ShapeBuilderMachine();
    m.setRegions(FACES);
    m.handle({ type: "down", point: [250, 250], modifiers: NONE });
    const s = m.handle({ type: "key", key: "Escape" });
    expect(s.collected).toEqual([]);
    expect(s.hovered).toBeNull();
  });

  it("region events before a down highlight but never collect", () => {
    const m = new ShapeBuilderMachine();
    const s = m.handle({ type: "region", id: "0-1#0" });
    expect(s.hovered).toBe("0-1#0");
    expect(s.collected).toEqual([]);
  });

  it("collected snapshots are defensive copies", () => {
    const m = new ShapeBuilderMachine();
    m.setRegions(FACES);
    m.handle({ type: "down", point: [250, 250], modifiers: NONE });
    const s = m.handle({ type: "move", point: [150, 150] });
    (s.collected as string[]).push("mutant");
    expect(m.handle({ type: "move", point: [150, 150] }).collected).toEqual([
      "0-1#0",
      "1#0",
    ]);
  });

  it("both lanes run off ONE gesture — element keys and face ids are tracked side by side", () => {
    const m = new ShapeBuilderMachine();
    m.setRegions(FACES);
    m.handle({ type: "down", point: [250, 250], modifiers: NONE });
    m.handle({ type: "cross", key: "ua" });
    m.handle({ type: "move", point: [150, 150] });
    const s = m.handle({ type: "cross", key: "ub" });
    expect(s.crossed).toEqual(["ua", "ub"]);
    expect(s.collected).toEqual(["0-1#0", "1#0"]);
  });

  // The lookup flattens every face ONCE, when the arrangement is
  // installed, and skips a face whose bounding box does not hold the
  // point. These pin the three things that could quietly change with it.
  it("where outlines overlap, the FIRST face installed is the one resolved", () => {
    const m = new ShapeBuilderMachine();
    // (250, 250) is inside all three outlines of the fixture.
    m.setRegions(FACES);
    expect(m.handle({ type: "move", point: [250, 250] }).hovered).toBe("0-1#0");
    m.setRegions([FACES[2], FACES[1], FACES[0]]);
    expect(m.handle({ type: "move", point: [250, 250] }).hovered).toBe("1#0");
  });

  it("a face with a HOLE is not hit through the hole, and a curved two-anchor face is hit", () => {
    const m = new ShapeBuilderMachine();
    const ring = {
      id: "ring#0",
      anchors: [...rect(0, 0, 100, 100), ...rect(40, 40, 60, 60)],
      subpathStarts: [0, 4],
    };
    // The lens between two overlapping circles, as its two crossing
    // anchors — fewer than three anchors, and still a face.
    const lens = {
      id: "lens#0",
      anchors: [
        { anchor: [200, 0], left: [203, -5], right: [203, 5] },
        { anchor: [210, 0], left: [207, 5], right: [207, -5] },
      ] as Array<{
        anchor: [number, number];
        left: [number, number];
        right: [number, number];
      }>,
    };
    m.setRegions([ring, lens]);
    expect(m.handle({ type: "move", point: [20, 20] }).hovered).toBe("ring#0");
    expect(m.handle({ type: "move", point: [50, 50] }).hovered).toBeNull();
    expect(m.handle({ type: "move", point: [205, 0] }).hovered).toBe("lens#0");
    // Inside the lens's bounding box, outside the lens.
    expect(m.handle({ type: "move", point: [200.5, 3] }).hovered).toBeNull();
  });

  it("a point on the edge of a face's bounding box resolves as the outline decides", () => {
    const m = new ShapeBuilderMachine();
    m.setRegions([{ id: "sq#0", anchors: rect(100, 100, 200, 200) }]);
    const at = (x: number, y: number) =>
      m.handle({ type: "move", point: [x, y] }).hovered;
    // The crossing rule's own convention: the left and top edges are
    // in, the right and bottom ones are out.
    expect(at(100, 150)).toBe("sq#0");
    expect(at(150, 100)).toBe("sq#0");
    expect(at(200, 150)).toBeNull();
    expect(at(150, 200)).toBeNull();
    expect(at(99.999999, 150)).toBeNull();
    expect(at(150, 99.999999)).toBeNull();
  });
});

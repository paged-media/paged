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

import { LivePaintMachine, type RegionFace } from "../src";

/** An axis-aligned square face with collapsed handles. */
const face = (
  id: string,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): RegionFace => ({
  id,
  anchors: (
    [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ] as [number, number][]
  ).map((p) => ({ anchor: p, left: p, right: p })),
  subpathStarts: [0],
});

/** Two side-by-side faces plus one that overlaps neither. */
const LEFT = face("0#0", 0, 0, 100, 100);
const RIGHT = face("1#0", 100, 0, 200, 100);
const FAR = face("0-1#0", 300, 300, 400, 400);

describe("LivePaintMachine", () => {
  it("resolves the hovered face from the installed arrangement, with no gesture at all", () => {
    const m = new LivePaintMachine();
    expect(m.setRegions([LEFT, RIGHT]).hasRegions).toBe(true);
    const s = m.handle({ type: "move", point: [50, 50] });
    expect(s.hovered).toBe("0#0");
    // Hovering is not painting: nothing is collected outside a gesture.
    expect(s.collected).toEqual([]);
    expect(s.painting).toBe(false);
  });

  it("a plain CLICK is a one-face gesture (down collects the face under the point)", () => {
    const m = new LivePaintMachine();
    m.setRegions([LEFT, RIGHT]);
    const down = m.handle({ type: "down", point: [150, 50] });
    expect(down.painting).toBe(true);
    expect(down.collected).toEqual(["1#0"]);
    const up = m.handle({ type: "up", point: [150, 50] });
    expect(up.painting).toBe(false);
    expect(up.collected).toEqual(["1#0"]);
  });

  it("a DRAG collects every crossed face in first-cross order, de-duped", () => {
    const m = new LivePaintMachine();
    m.setRegions([LEFT, RIGHT, FAR]);
    m.handle({ type: "down", point: [50, 50] });
    m.handle({ type: "move", point: [150, 50] });
    m.handle({ type: "move", point: [350, 350] });
    // Re-entering the first face does not append it twice.
    m.handle({ type: "move", point: [60, 60] });
    const s = m.handle({ type: "up", point: [60, 60] });
    expect(s.collected).toEqual(["0#0", "1#0", "0-1#0"]);
  });

  it("a sample over no face clears the hover and collects nothing", () => {
    const m = new LivePaintMachine();
    m.setRegions([LEFT]);
    m.handle({ type: "down", point: [50, 50] });
    const s = m.handle({ type: "move", point: [900, 900] });
    expect(s.hovered).toBeNull();
    expect(s.collected).toEqual(["0#0"]);
  });

  it("with NO arrangement installed it resolves nothing itself — the cold-start state", () => {
    const m = new LivePaintMachine();
    const s = m.handle({ type: "move", point: [50, 50] });
    expect(s.hasRegions).toBe(false);
    expect(s.hovered).toBeNull();
  });

  it("an injected `region` event (the engine point query) wins, and collects while painting", () => {
    const m = new LivePaintMachine();
    m.handle({ type: "down", point: [50, 50] });
    const s = m.handle({ type: "region", id: "0-1#0" });
    expect(s.hovered).toBe("0-1#0");
    expect(s.collected).toEqual(["0-1#0"]);
    // A null answer (the pointer is over no face) clears the highlight.
    expect(m.handle({ type: "region", id: null }).hovered).toBeNull();
  });

  it("a `region` event outside a gesture highlights but never collects", () => {
    const m = new LivePaintMachine();
    const s = m.handle({ type: "region", id: "0#0" });
    expect(s.hovered).toBe("0#0");
    expect(s.collected).toEqual([]);
  });

  it("a cache installed MID-HOVER highlights immediately, without waiting for the next move", () => {
    const m = new LivePaintMachine();
    m.handle({ type: "move", point: [150, 50] });
    expect(m.setRegions([LEFT, RIGHT]).hovered).toBe("1#0");
  });

  it("Escape clears the gesture, the hover and the collected set", () => {
    const m = new LivePaintMachine();
    m.setRegions([LEFT]);
    m.handle({ type: "down", point: [50, 50] });
    const s = m.handle({ type: "key", key: "Escape" });
    expect(s).toEqual({
      hovered: null,
      collected: [],
      painting: false,
      hasRegions: true,
    });
  });

  it("setRegions(null) drops the arrangement (a document mutation invalidated it)", () => {
    const m = new LivePaintMachine();
    m.setRegions([LEFT]);
    m.handle({ type: "move", point: [50, 50] });
    const s = m.setRegions(null);
    expect(s.hasRegions).toBe(false);
    // The last hover is NOT cleared — clearing would flicker the
    // highlight off between round trips (the cold-start rule).
    expect(s.hovered).toBe("0#0");
  });

  it("snapshots are copies — a caller cannot mutate the machine's collected set", () => {
    const m = new LivePaintMachine();
    m.setRegions([LEFT]);
    const s = m.handle({ type: "down", point: [50, 50] });
    (s.collected as string[]).push("bogus");
    expect(m.handle({ type: "up", point: [50, 50] }).collected).toEqual(["0#0"]);
  });
});

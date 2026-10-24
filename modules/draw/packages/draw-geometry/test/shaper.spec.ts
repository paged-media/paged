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

// The Shaper's recogniser over RECORDED strokes: jittered, hand-drawn-
// like point sequences captured once into fixtures/shaper-strokes.json
// (a deterministic generator, so the file is reproducible) and replayed
// here verbatim.

import { describe, expect, it } from "bun:test";

import { recogniseShape, type Vec2 } from "../src";
import strokes from "./fixtures/shaper-strokes.json";

const S = strokes as unknown as Record<string, Vec2[]>;

describe("recogniseShape — the Shaper over recorded strokes [plugin-draw.tool-wave-3]", () => {
  it("a circle is a circle (equal radii) and an ellipse keeps its two radii", () => {
    const c = recogniseShape(S.circle!)!;
    expect(c.kind).toBe("ellipse");
    const xs = c.table!.anchors.map((a) => a.anchor[0]);
    const ys = c.table!.anchors.map((a) => a.anchor[1]);
    const rx = (Math.max(...xs) - Math.min(...xs)) / 2;
    const ry = (Math.max(...ys) - Math.min(...ys)) / 2;
    expect(rx).toBeCloseTo(ry, 9);
    expect(rx).toBeGreaterThan(55);
    expect(rx).toBeLessThan(65);
    const e = recogniseShape(S.ellipse!)!;
    expect(e.kind).toBe("ellipse");
    const exs = e.table!.anchors.map((a) => a.anchor[0]);
    expect((Math.max(...exs) - Math.min(...exs)) / 2).toBeGreaterThan(100);
  });

  it("a rectangle becomes an axis-aligned box; a rotated one keeps its angle", () => {
    const r = recogniseShape(S.rectangle!)!;
    expect(r.kind).toBe("rectangle");
    const [tl, tr, br, bl] = r.table!.anchors.map((a) => a.anchor);
    expect(tl![1]).toBe(tr![1]);
    expect(bl![1]).toBe(br![1]);
    expect(tl![0]).toBe(bl![0]);
    const rot = recogniseShape(S.rotatedRectangle!)!;
    expect(rot.kind).toBe("rectangle");
    const [a, b] = rot.table!.anchors.map((x) => x.anchor);
    const deg = (Math.atan2(b![1] - a![1], b![0] - a![0]) * 180) / Math.PI;
    expect(Math.abs(Math.abs(deg % 90) - 30) < 4 || Math.abs(Math.abs(deg % 90) - 60) < 4).toBe(true);
  });

  it("a triangle has three corners; five and six corners are regular polygons", () => {
    expect(recogniseShape(S.triangle!)!.kind).toBe("triangle");
    expect(recogniseShape(S.triangle!)!.table!.anchors).toHaveLength(3);
    const p5 = recogniseShape(S.pentagon!)!;
    expect(p5).toMatchObject({ kind: "polygon", sides: 5 });
    const p6 = recogniseShape(S.hexagon!)!;
    expect(p6).toMatchObject({ kind: "polygon", sides: 6 });
  });

  it("a line is a line, and a nearly horizontal one snaps level", () => {
    const l = recogniseShape(S.line!)!;
    expect(l.kind).toBe("line");
    expect(l.table!.subpathOpen).toEqual([true]);
    const h = recogniseShape(S.nearHorizontalLine!)!;
    expect(h.kind).toBe("line");
    const [p, q] = h.table!.anchors.map((a) => a.anchor);
    expect(p![1]).toBeCloseTo(q![1], 9);
  });

  it("a back-and-forth scrub is a SCRIBBLE; an open hook and a twitch are nothing", () => {
    expect(recogniseShape(S.scribble!)).toEqual({ kind: "scribble", table: null });
    expect(recogniseShape(S.openHook!)).toBeNull();
    expect(recogniseShape(S.tiny!)).toBeNull();
  });

  it("is deterministic: the same stroke is the same answer", () => {
    for (const k of Object.keys(S))
      expect(recogniseShape(S[k]!)).toEqual(recogniseShape(S[k]!));
  });
});

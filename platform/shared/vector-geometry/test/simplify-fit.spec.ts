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

import { describe, expect, it } from "bun:test";

import {
  evalCubic,
  interiorAngleAt,
  simplifyAnchorTable,
  type AnchorTable,
  type AnchorTriple,
  type Vec2,
} from "../src";

type P = [number, number];
const corner = (p: P): AnchorTriple => ({ anchor: p, left: p, right: p });

/** A dense polyline of corners along a sine wave — what a pencil leaves. */
function wave(n: number): AnchorTable {
  const anchors: AnchorTriple[] = [];
  for (let i = 0; i <= n; i++) {
    const x = (i / n) * 200;
    anchors.push(corner([x, 50 + 30 * Math.sin((x / 200) * Math.PI * 2)]));
  }
  return { anchors, subpathStarts: [0], subpathOpen: [true] };
}

/** Max distance from the ORIGINAL polyline's points to the result. */
function deviation(original: AnchorTable, result: AnchorTable): number {
  const pts: Vec2[] = [];
  const a = result.anchors;
  const closed = !(result.subpathOpen?.[0] ?? false);
  const segs = closed ? a.length : a.length - 1;
  for (let i = 0; i < segs; i++) {
    const p = a[i]!;
    const q = a[(i + 1) % a.length]!;
    for (let s = 0; s <= 200; s++)
      pts.push(evalCubic(p.anchor, p.right, q.left, q.anchor, s / 200));
  }
  let worst = 0;
  for (const o of original.anchors) {
    let best = Infinity;
    for (const p of pts)
      best = Math.min(best, Math.hypot(p[0] - o.anchor[0], p[1] - o.anchor[1]));
    worst = Math.max(worst, best);
  }
  return worst;
}

describe("simplifyAnchorTable — the Simplify preview's fit [plugin-draw.tool-wave-3]", () => {
  it("reduces a dense polyline to a few smooth anchors within the tolerance", () => {
    const t = wave(80);
    const out = simplifyAnchorTable(t, { tolerance: 1, cornerAngleDeg: 0 });
    expect(out.anchors.length).toBeLessThan(12);
    expect(out.subpathOpen).toEqual([true]);
    expect(deviation(t, out)).toBeLessThanOrEqual(1.5);
    // The ends stay where they were.
    expect(out.anchors[0]!.anchor).toEqual(t.anchors[0]!.anchor);
    expect(out.anchors.at(-1)!.anchor).toEqual(t.anchors.at(-1)!.anchor);
  });

  it("a larger tolerance never keeps more anchors", () => {
    const t = wave(80);
    const counts = [0.25, 1, 4, 10].map(
      (tolerance) =>
        simplifyAnchorTable(t, { tolerance, cornerAngleDeg: 0 }).anchors.length,
    );
    for (let i = 1; i < counts.length; i++)
      expect(counts[i]!).toBeLessThanOrEqual(counts[i - 1]!);
  });

  it("the interior angle is 180 straight on, 90 at a square corner", () => {
    const sq = [
      corner([0, 0]),
      corner([10, 0]),
      corner([10, 10]),
      corner([0, 10]),
    ];
    expect(interiorAngleAt(sq, true, 1)).toBeCloseTo(90, 6);
    const line = [corner([0, 0]), corner([10, 0]), corner([20, 0])];
    expect(interiorAngleAt(line, false, 1)).toBeCloseTo(180, 6);
    expect(interiorAngleAt(line, false, 0)).toBe(180);
  });

  it("the CORNER THRESHOLD keeps a sharp corner sharp where 0 rounds it", () => {
    // A dense V: two straight arms meeting at (100, 100) at ~53°.
    const anchors: AnchorTriple[] = [];
    for (let i = 0; i <= 20; i++) anchors.push(corner([i * 5, 100 - i * 10]));
    for (let i = 1; i <= 20; i++)
      anchors.push(corner([100 + i * 5, -100 + i * 10]));
    const t: AnchorTable = { anchors, subpathStarts: [0], subpathOpen: [true] };
    const tip: P = [100, -100];
    const kept = simplifyAnchorTable(t, { tolerance: 2, cornerAngleDeg: 90 });
    const hit = kept.anchors.find(
      (a) => Math.hypot(a.anchor[0] - tip[0], a.anchor[1] - tip[1]) < 1e-9,
    );
    expect(hit).toBeDefined();
    // Sharp: both handles collapsed onto the anchor (straight arms).
    expect(hit!.left).toEqual(hit!.anchor);
    expect(hit!.right).toEqual(hit!.anchor);
    // Each arm is one straight segment: tip + two ends.
    expect(kept.anchors).toHaveLength(3);
  });

  it("a closed dense circle stays closed with a smooth seam", () => {
    const anchors: AnchorTriple[] = [];
    for (let i = 0; i < 64; i++) {
      const a = (i / 64) * Math.PI * 2;
      anchors.push(corner([100 + 50 * Math.cos(a), 100 + 50 * Math.sin(a)]));
    }
    const t: AnchorTable = {
      anchors,
      subpathStarts: [0],
      subpathOpen: [false],
    };
    const out = simplifyAnchorTable(t, { tolerance: 0.5, cornerAngleDeg: 30 });
    expect(out.subpathOpen).toEqual([false]);
    expect(out.anchors.length).toBeGreaterThanOrEqual(2);
    expect(out.anchors.length).toBeLessThan(12);
    expect(deviation(t, out)).toBeLessThanOrEqual(0.75);
    // No anchor of a circle is sharper than 30°, so the seam is smooth.
    const a0 = out.anchors[0]!;
    const inDir = [a0.anchor[0] - a0.left[0], a0.anchor[1] - a0.left[1]];
    const outDir = [a0.right[0] - a0.anchor[0], a0.right[1] - a0.anchor[1]];
    const cross = inDir[0]! * outDir[1]! - inDir[1]! * outDir[0]!;
    expect(
      Math.abs(cross) /
        (Math.hypot(inDir[0]!, inDir[1]!) * Math.hypot(outDir[0]!, outDir[1]!)),
    ).toBeLessThan(1e-6);
  });

  it("a single segment between two corners is kept verbatim", () => {
    const sq: AnchorTable = {
      anchors: [
        corner([0, 0]),
        corner([10, 0]),
        corner([10, 10]),
        corner([0, 10]),
      ],
      subpathStarts: [0],
      subpathOpen: [false],
    };
    const out = simplifyAnchorTable(sq, { tolerance: 1, cornerAngleDeg: 100 });
    expect(out.anchors.map((a) => a.anchor)).toEqual(
      sq.anchors.map((a) => a.anchor),
    );
  });

  it("never ADDS anchors: a square re-fitted without its corners stays the square", () => {
    const sq: AnchorTable = {
      anchors: [
        corner([0, 0]),
        corner([100, 0]),
        corner([100, 100]),
        corner([0, 100]),
      ],
      subpathStarts: [0],
      subpathOpen: [false],
    };
    const out = simplifyAnchorTable(sq, { tolerance: 1, cornerAngleDeg: 60 });
    expect(out.anchors.map((a) => a.anchor)).toEqual(
      sq.anchors.map((a) => a.anchor),
    );
  });

  it("every contour of a compound table keeps its own open flag", () => {
    const w = wave(40);
    const t: AnchorTable = {
      anchors: [
        ...w.anchors,
        ...wave(40).anchors.map((a) =>
          corner([a.anchor[0], a.anchor[1] + 200]),
        ),
      ],
      subpathStarts: [0, 41],
      subpathOpen: [true, false],
    };
    const out = simplifyAnchorTable(t, { tolerance: 1, cornerAngleDeg: 0 });
    expect(out.subpathStarts).toHaveLength(2);
    expect(out.subpathOpen).toEqual([true, false]);
  });
});

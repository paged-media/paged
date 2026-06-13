// SVG path `d` ⇄ anchor-model round-trip. Coverage: every command family
// (M/m L/l H/h V/v C/c S/s Q/q T/t A/a Z/z), absolute + relative,
// implicit-lineto-after-moveto, compound paths, and parse→serialize→
// re-parse STABILITY (the geometry must not drift across a round-trip
// once it's in the cubic model).

import { describe, expect, it } from "vitest";

import {
  parsePathData,
  serializePathData,
  quadToCubic,
  evalCubic,
  type AnchorTable,
  type AnchorTriple,
} from "../src";

// Sample N points along a table's outline (cubic-aware) for a tolerance
// comparison between two tables of the SAME topology.
function samplePoints(t: AnchorTable, per = 8): [number, number][] {
  const out: [number, number][] = [];
  const starts = t.subpathStarts.length ? t.subpathStarts : [0];
  const open = t.subpathOpen ?? [];
  for (let s = 0; s < starts.length; s++) {
    const begin = starts[s];
    const end = s + 1 < starts.length ? starts[s + 1] : t.anchors.length;
    const count = end - begin;
    if (count === 0) continue;
    const isOpen = open[s] ?? false;
    const segs = isOpen ? count - 1 : count;
    for (let i = 0; i < segs; i++) {
      const a = t.anchors[begin + i];
      const b = t.anchors[begin + ((i + 1) % count)];
      for (let k = 0; k <= per; k++) {
        out.push(evalCubic(a.anchor, a.right, b.left, b.anchor, k / per));
      }
    }
  }
  return out;
}

function maxDeviation(a: AnchorTable, b: AnchorTable, per = 8): number {
  const pa = samplePoints(a, per);
  const pb = samplePoints(b, per);
  expect(pa.length).toBe(pb.length);
  let max = 0;
  for (let i = 0; i < pa.length; i++) {
    max = Math.max(max, Math.hypot(pa[i][0] - pb[i][0], pa[i][1] - pb[i][1]));
  }
  return max;
}

describe("parsePathData — command families", () => {
  it("M + L absolute: two-segment open polyline", () => {
    const t = parsePathData("M 10 10 L 20 10 L 20 20");
    expect(t.anchors.length).toBe(3);
    expect(t.subpathOpen).toEqual([true]);
    expect(t.anchors[0].anchor).toEqual([10, 10]);
    expect(t.anchors[2].anchor).toEqual([20, 20]);
    // Straight segments leave handles collapsed.
    expect(t.anchors[0].right).toEqual([10, 10]);
  });

  it("relative commands track the pen (m/l/h/v)", () => {
    const abs = parsePathData("M 10 10 L 20 10 L 20 20 L 10 20");
    const rel = parsePathData("m 10 10 l 10 0 l 0 10 l -10 0");
    expect(rel.anchors.map((a) => a.anchor)).toEqual(
      abs.anchors.map((a) => a.anchor),
    );
  });

  it("H/V emit horizontal/vertical segments", () => {
    const t = parsePathData("M 5 5 H 25 V 30");
    expect(t.anchors[1].anchor).toEqual([25, 5]);
    expect(t.anchors[2].anchor).toEqual([25, 30]);
  });

  it("implicit lineto after moveto", () => {
    const t = parsePathData("M 0 0 10 0 10 10");
    expect(t.anchors.length).toBe(3);
    expect(t.anchors[1].anchor).toEqual([10, 0]);
    expect(t.anchors[2].anchor).toEqual([10, 10]);
  });

  it("C cubic preserves both control points as handles", () => {
    const t = parsePathData("M 0 0 C 10 0 10 10 0 10");
    expect(t.anchors[0].right).toEqual([10, 0]);
    expect(t.anchors[1].left).toEqual([10, 10]);
    expect(t.anchors[1].anchor).toEqual([0, 10]);
  });

  it("S reflects the previous cubic's control point", () => {
    // Two cubics; the S's first control = reflection of (8,0) about (10,0).
    const t = parsePathData("M 0 0 C 2 0 8 0 10 0 S 18 10 20 10");
    // After the first C the current point is (10,0), prev ctrl (8,0).
    // Reflected → (12,0).
    expect(t.anchors[1].right).toEqual([12, 0]);
    expect(t.anchors[2].anchor).toEqual([20, 10]);
  });

  it("Q elevates to cubic identical to an explicit C", () => {
    const q = parsePathData("M 0 0 Q 10 10 20 0");
    const { right, left } = quadToCubic([0, 0], [10, 10], [20, 0]);
    expect(q.anchors[0].right).toEqual(right);
    expect(q.anchors[1].left).toEqual(left);
  });

  it("T reflects the previous quadratic control point", () => {
    const t = parsePathData("M 0 0 Q 5 10 10 0 T 20 0");
    // prev quad ctrl (5,10), current point (10,0) → reflected (15,-10).
    const { right } = quadToCubic([10, 0], [15, -10], [20, 0]);
    expect(t.anchors[1].right).toEqual(right);
  });

  it("Z closes the subpath (open flag false)", () => {
    const t = parsePathData("M 0 0 L 10 0 L 10 10 Z");
    expect(t.subpathOpen).toEqual([false]);
  });

  it("multiple subpaths → a compound table", () => {
    const t = parsePathData("M 0 0 L 10 0 Z M 20 0 L 30 0 Z");
    expect(t.subpathStarts).toEqual([0, 2]);
    expect(t.subpathOpen).toEqual([false, false]);
  });

  it("empty / junk input → empty table", () => {
    expect(parsePathData("").anchors).toHaveLength(0);
    expect(parsePathData("   garbage  ").anchors).toHaveLength(0);
  });

  it("tight number packing (no separators, signs, decimals)", () => {
    const t = parsePathData("M0 0L1.5.5L-2-3");
    expect(t.anchors[1].anchor).toEqual([1.5, 0.5]);
    expect(t.anchors[2].anchor).toEqual([-2, -3]);
  });
});

describe("serializePathData — inverse", () => {
  it("emits M/L/Z for a closed polygon", () => {
    const t = parsePathData("M 0 0 L 10 0 L 10 10 Z");
    expect(serializePathData(t)).toBe("M 0 0 L 10 0 L 10 10 Z");
  });

  it("emits C for cubic segments", () => {
    const d = "M 0 0 C 10 0 10 10 0 10";
    const t = parsePathData(d);
    expect(serializePathData(t)).toBe("M 0 0 C 10 0 10 10 0 10");
  });

  it("rounds to the requested precision and trims zeros", () => {
    const t = parsePathData("M 0.123456 0 L 1 1");
    expect(serializePathData(t, 2)).toBe("M 0.12 0 L 1 1");
  });
});

describe("round-trip stability (parse → serialize → re-parse)", () => {
  const corpus = [
    "M 0 0 L 100 0 L 100 100 L 0 100 Z",
    "M 10 10 C 40 10 40 40 10 40 C -20 40 -20 10 10 10 Z",
    "M 0 0 Q 50 80 100 0 T 200 0",
    "m 5 5 l 20 0 l 0 20 l -20 0 z",
    "M 0 0 S 30 30 60 0 S 90 -30 120 0",
    "M 50 50 A 30 30 0 1 1 50 50.0001", // near-full arc
    "M 0 0 A 40 20 0 0 1 80 0 A 40 20 0 0 1 0 0", // two-arc oval
    "M 0 0 L 10 0 Z M 50 50 C 60 50 60 60 50 60 Z", // compound
    "M 10 80 C 40 10 65 10 95 80 S 150 150 180 80", // smooth chain
    "M 100 200 H 150 V 250 H 100 Z",
  ];

  it.each(corpus)("is stable for: %s", (d) => {
    const t1 = parsePathData(d);
    const re = serializePathData(t1, 4);
    const t2 = parsePathData(re);
    // Same topology.
    expect(t2.anchors.length).toBe(t1.anchors.length);
    expect(t2.subpathStarts).toEqual(t1.subpathStarts);
    expect(t2.subpathOpen).toEqual(t1.subpathOpen);
    // Geometry stable within rounding tolerance.
    expect(maxDeviation(t1, t2)).toBeLessThan(1e-2);
  });
});

// A diagnostic helper so the corpus suite reads as anchor-level too.
const firstAnchor = (t: AnchorTable): AnchorTriple => t.anchors[0];
describe("anchor model shape", () => {
  it("a closed square's first anchor is a corner", () => {
    const a = firstAnchor(parsePathData("M 0 0 L 10 0 L 10 10 L 0 10 Z"));
    expect(a.left).toEqual(a.anchor);
    expect(a.right).toEqual(a.anchor);
  });
});

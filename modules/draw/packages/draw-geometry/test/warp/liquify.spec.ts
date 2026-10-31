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

// THE LIQUIFY KERNELS — brush falloff, exact densification, each of the
// seven kernels' defining property, the "brush affects" switches, the
// determinism a Rust port reproduces, and the refit that leaves the
// untouched part of a path byte-identical. Tagged for cockpit
// [plugin-draw.distortion-tools].

import { describe, expect, it } from "bun:test";

import {
  brushDistance,
  brushWeight,
  evalCubic,
  liquifyChanged,
  liquifyDensify,
  liquifyDisplace,
  liquifyRefit,
  liquifySpacing,
  liquifyStart,
  liquifyStep,
  simplifyTolerance,
  type AnchorTable,
  type AnchorTriple,
  type LiquifyBrush,
  type LiquifyParams,
  type LiquifyState,
  type Vec2,
} from "../../src";

type P = [number, number];
const corner = (p: P): AnchorTriple => ({ anchor: p, left: p, right: p });

/** A closed square 100..300. */
const SQUARE: AnchorTable = {
  anchors: [
    corner([100, 100]),
    corner([300, 100]),
    corner([300, 300]),
    corner([100, 300]),
  ],
  subpathStarts: [0],
};

/** A closed circle of radius 100 at (200, 200), four arcs. */
const K = 0.5522847498307936 * 100;
const CIRCLE: AnchorTable = {
  anchors: [
    { anchor: [200, 100], left: [200 - K, 100], right: [200 + K, 100] },
    { anchor: [300, 200], left: [300, 200 - K], right: [300, 200 + K] },
    { anchor: [200, 300], left: [200 + K, 300], right: [200 - K, 300] },
    { anchor: [100, 200], left: [100, 200 + K], right: [100, 200 - K] },
  ],
  subpathStarts: [0],
};

/** An open horizontal line 0..400 at y = 200. */
const LINE: AnchorTable = {
  anchors: [corner([0, 200]), corner([400, 200])],
  subpathStarts: [0],
  subpathOpen: [true],
};

const brush = (c: Vec2, extra: Partial<LiquifyBrush> = {}): LiquifyBrush => ({
  center: c,
  width: 100,
  height: 100,
  angleDeg: 0,
  strength: 1,
  ...extra,
});

/** Dense samples of every segment of a table. */
function samples(t: AnchorTable, per = 16): P[] {
  const out: P[] = [];
  const n = t.anchors.length;
  const starts = t.subpathStarts.length ? t.subpathStarts : [0];
  starts.forEach((from, s) => {
    const to = s + 1 < starts.length ? starts[s + 1]! : n;
    const closed = !(t.subpathOpen?.[s] ?? false);
    const m = to - from;
    const segs = closed ? m : m - 1;
    for (let i = 0; i < segs; i++) {
      const a = t.anchors[from + i]!;
      const b = t.anchors[from + ((i + 1) % m)]!;
      for (let k = 0; k <= per; k++)
        out.push(evalCubic(a.anchor, a.right, b.left, b.anchor, k / per));
    }
  });
  return out;
}

/** The largest distance from any point of `a` to the polyline of `b`'s
 *  samples. */
function hausdorffOneWay(a: P[], b: P[]): number {
  let worst = 0;
  for (const p of a) {
    let best = Infinity;
    for (let i = 1; i < b.length; i++) {
      const q = b[i - 1]!;
      const r = b[i]!;
      const dx = r[0] - q[0];
      const dy = r[1] - q[1];
      const l2 = dx * dx + dy * dy;
      let t = l2 > 0 ? ((p[0] - q[0]) * dx + (p[1] - q[1]) * dy) / l2 : 0;
      t = Math.max(0, Math.min(1, t));
      best = Math.min(
        best,
        Math.hypot(p[0] - q[0] - t * dx, p[1] - q[1] - t * dy),
      );
    }
    worst = Math.max(worst, best);
  }
  return worst;
}

const run = (
  t: AnchorTable,
  b: LiquifyBrush,
  params: LiquifyParams,
  steps = 1,
  detail = 2,
): LiquifyState => {
  let s = liquifyStart(t);
  for (let i = 0; i < steps; i++) s = liquifyStep(s, b, params, detail);
  return s;
};

describe("liquify — the brush [plugin-draw.distortion-tools]", () => {
  it("weighs 1 at the centre, 0 on and past the rim, smoothly in between", () => {
    const b = brush([0, 0]);
    expect(brushWeight(b, [0, 0])).toBe(1);
    expect(brushWeight(b, [50, 0])).toBe(0);
    expect(brushWeight(b, [80, 0])).toBe(0);
    const w = brushWeight(b, [25, 0]);
    expect(w).toBeCloseTo(0.5625, 9);
  });

  it("is an ellipse that turns with its angle", () => {
    const b = brush([0, 0], { width: 200, height: 50 });
    expect(brushDistance(b, [100, 0])).toBeCloseTo(1, 9);
    expect(brushDistance(b, [0, 25])).toBeCloseTo(1, 9);
    const turned = { ...b, angleDeg: 90 };
    expect(brushDistance(turned, [0, 100])).toBeCloseTo(1, 9);
    expect(brushDistance(turned, [25, 0])).toBeCloseTo(1, 9);
  });

  it("detail sets the anchor spacing in brush radii", () => {
    const b = brush([0, 0]);
    expect(liquifySpacing(b, 1)).toBeCloseTo(25, 9);
    expect(liquifySpacing(b, 4)).toBeCloseTo(10, 9);
    // clamped to Illustrator's 1..10
    expect(liquifySpacing(b, 99)).toBe(liquifySpacing(b, 10));
  });

  it("simplify maps 0.2..100 onto a fit tolerance", () => {
    expect(simplifyTolerance(50)).toBeCloseTo(1, 9);
    expect(simplifyTolerance(0)).toBeCloseTo(0.004, 9);
    expect(simplifyTolerance(1000)).toBeCloseTo(2, 9);
  });
});

describe("liquify — densify is exact and local [plugin-draw.distortion-tools]", () => {
  it("adds anchors only where the brush reaches, and the curve does not move", () => {
    const b = brush([300, 200]);
    const d = liquifyDensify(liquifyStart(CIRCLE), b, 10);
    expect(d.table.anchors.length).toBeGreaterThan(CIRCLE.anchors.length + 4);
    // Every minted anchor is near the brush.
    d.table.anchors.forEach((a, i) => {
      if (d.touched[i])
        expect(Math.hypot(a.anchor[0] - 300, a.anchor[1] - 200)).toBeLessThan(
          120,
        );
    });
    // Same curve, both ways.
    expect(hausdorffOneWay(samples(d.table), samples(CIRCLE, 64))).toBeLessThan(
      0.05,
    );
    expect(hausdorffOneWay(samples(CIRCLE), samples(d.table, 64))).toBeLessThan(
      0.05,
    );
    // The far anchor (100, 200) is untouched and unmoved.
    const far = d.table.anchors.find(
      (a) => a.anchor[0] === 100 && a.anchor[1] === 200,
    );
    expect(far).toEqual(CIRCLE.anchors[3]);
  });

  it("splits a straight edge into pieces no longer than the spacing", () => {
    const b = brush([200, 200], { width: 400, height: 400 });
    const d = liquifyDensify(liquifyStart(LINE), b, 20);
    const xs = d.table.anchors.map((a) => a.anchor[0]);
    for (let i = 1; i < xs.length; i++)
      expect(xs[i]! - xs[i - 1]!).toBeLessThanOrEqual(20 + 1e-9);
    expect(xs[0]).toBe(0);
    expect(xs[xs.length - 1]).toBe(400);
    expect(d.table.subpathOpen).toEqual([true]);
  });

  it("a brush away from the path changes nothing", () => {
    const s = run(SQUARE, brush([600, 600]), { kind: "pucker" });
    expect(s.table.anchors).toEqual(SQUARE.anchors);
    expect(liquifyChanged(s)).toBe(false);
  });
});

describe("liquify — the seven kernels [plugin-draw.distortion-tools]", () => {
  it("WARP drags points by the pointer's motion, scaled by the falloff", () => {
    const b = brush([200, 200]);
    expect(
      liquifyDisplace(b, { kind: "warp", delta: [10, -4] }, [200, 200]),
    ).toEqual([210, 196]);
    const half = liquifyDisplace(
      b,
      { kind: "warp", delta: [10, 0] },
      [225, 200],
    );
    expect(half[0]).toBeCloseTo(225 + 10 * 0.5625, 9);
    const s = run(LINE, b, { kind: "warp", delta: [0, -30] });
    const mid = s.table.anchors.reduce((m, a) => Math.min(m, a.anchor[1]), 999);
    expect(mid).toBeCloseTo(170, 6);
    // Outside the brush the line is unmoved.
    expect(s.table.anchors[0]).toEqual(LINE.anchors[0]);
  });

  it("strength scales every kernel; zero strength is the identity", () => {
    const b = brush([200, 200], { strength: 0 });
    for (const kind of ["warp", "twirl", "pucker", "bloat"] as const)
      expect(liquifyDisplace(b, { kind, delta: [5, 5] }, [210, 205])).toEqual([
        210, 205,
      ]);
  });

  it("TWIRL turns points about the centre, keeping their distance; positive is counter-clockwise on screen", () => {
    const b = brush([0, 0], { width: 400, height: 400 });
    const p: Vec2 = [10, 0];
    const q = liquifyDisplace(b, { kind: "twirl", twirlRate: 90 }, p);
    expect(Math.hypot(q[0], q[1])).toBeCloseTo(10, 9);
    // Counter-clockwise ON SCREEN with y down: from +x toward −y.
    expect(q[1]).toBeLessThan(0);
    const back = liquifyDisplace(b, { kind: "twirl", twirlRate: -90 }, p);
    expect(back[1]).toBeGreaterThan(0);
  });

  it("PUCKER pulls toward the centre and BLOAT pushes away", () => {
    const b = brush([200, 200], { width: 300, height: 300 });
    const p: Vec2 = [240, 200];
    const pu = liquifyDisplace(b, { kind: "pucker" }, p);
    const bl = liquifyDisplace(b, { kind: "bloat" }, p);
    expect(pu[0]).toBeLessThan(240);
    expect(pu[0]).toBeGreaterThan(200);
    expect(bl[0]).toBeGreaterThan(240);
    expect(pu[1]).toBe(200);
    // On the circle: puckering shrinks it, bloating grows it.
    const shrink = run(CIRCLE, brush([200, 200], { width: 300, height: 300 }), {
      kind: "pucker",
    });
    const grow = run(CIRCLE, brush([200, 200], { width: 300, height: 300 }), {
      kind: "bloat",
    });
    const r = (t: AnchorTable) =>
      Math.max(
        ...t.anchors.map((a) =>
          Math.hypot(a.anchor[0] - 200, a.anchor[1] - 200),
        ),
      );
    expect(r(shrink.table)).toBeLessThan(100);
    expect(r(grow.table)).toBeGreaterThan(100);
  });

  it("SCALLOP draws the anchors under the brush toward its centre", () => {
    const b = brush([300, 200], { width: 120, height: 120 });
    const s = run(CIRCLE, b, { kind: "scallop", complexity: 1 }, 3, 3);
    const moved = s.table.anchors.filter((_, i) => s.touched[i]);
    expect(moved.length).toBeGreaterThan(3);
    // Every touched anchor near the brush centre moved inward relative to
    // the circle.
    const inward = moved.filter(
      (a) => Math.hypot(a.anchor[0] - 200, a.anchor[1] - 200) < 99.9,
    );
    expect(inward.length).toBeGreaterThan(0);
  });

  it("CRYSTALLIZE pushes some anchors out as spikes and leaves the valleys", () => {
    const b = brush([300, 200], { width: 120, height: 120 });
    const s = run(CIRCLE, b, { kind: "crystallize", complexity: 4 }, 3, 4);
    const radii = s.table.anchors.map((a) =>
      Math.hypot(a.anchor[0] - 200, a.anchor[1] - 200),
    );
    expect(Math.max(...radii)).toBeGreaterThan(102);
    // Not every touched anchor is a spike.
    const touchedRadii = radii.filter((_, i) => s.touched[i]);
    expect(touchedRadii.some((r) => r < 100.5)).toBe(true);
  });

  it("WRINKLE moves anchors only along the axes it is given", () => {
    const b = brush([200, 200], { width: 200, height: 200 });
    const vertical = run(LINE, b, {
      kind: "wrinkle",
      horizontal: 0,
      vertical: 100,
      complexity: 2,
    });
    const ys = vertical.table.anchors.map((a) => a.anchor[1]);
    expect(ys.some((y) => Math.abs(y - 200) > 0.1)).toBe(true);
    // Horizontal 0 %: every anchor keeps its x from the densified line.
    const dense = liquifyDensify(liquifyStart(LINE), b, liquifySpacing(b, 2));
    expect(vertical.table.anchors.map((a) => a.anchor[0])).toEqual(
      dense.table.anchors.map((a) => a.anchor[0]),
    );
  });

  it("BRUSH AFFECTS: with anchors off, only the chosen handles move", () => {
    const b = brush([200, 200], { width: 200, height: 200 });
    const s = run(LINE, b, {
      kind: "scallop",
      affectAnchors: false,
      affectIn: true,
      affectOut: false,
    });
    const dense = liquifyDensify(liquifyStart(LINE), b, liquifySpacing(b, 2));
    s.table.anchors.forEach((a, i) => {
      const d = dense.table.anchors[i]!;
      expect(a.anchor).toEqual(d.anchor);
      expect(a.right).toEqual(d.right);
    });
    expect(
      s.table.anchors.some(
        (a, i) => a.left[1] !== dense.table.anchors[i]!.left[1],
      ),
    ).toBe(true);
  });

  it("the detail kernels are deterministic, and the seed changes them", () => {
    const b = brush([300, 200], { width: 120, height: 120 });
    const p: LiquifyParams = { kind: "crystallize", complexity: 6, seed: 3 };
    expect(run(CIRCLE, b, p, 2).table).toEqual(run(CIRCLE, b, p, 2).table);
    expect(run(CIRCLE, b, { ...p, seed: 4 }, 2).table).not.toEqual(
      run(CIRCLE, b, p, 2).table,
    );
  });

  it("repeated steps accumulate (holding the button keeps twirling)", () => {
    const b = brush([200, 200], { width: 300, height: 300 });
    const one = run(CIRCLE, b, { kind: "twirl", twirlRate: 10 }, 1);
    const five = run(CIRCLE, b, { kind: "twirl", twirlRate: 10 }, 5);
    const angle = (t: AnchorTable) => {
      const a = t.anchors[0]!.anchor;
      return Math.atan2(a[1] - 200, a[0] - 200);
    };
    expect(Math.abs(angle(five.table) - angle(CIRCLE))).toBeGreaterThan(
      Math.abs(angle(one.table) - angle(CIRCLE)) * 3,
    );
  });
});

describe("liquify — the refit [plugin-draw.distortion-tools]", () => {
  it("re-fits the touched run within the tolerance and keeps every untouched anchor byte-identical", () => {
    const b = brush([300, 200], { width: 120, height: 120 });
    const s = run(CIRCLE, b, { kind: "bloat" }, 4, 6);
    const fit = liquifyRefit(s, 0.5);
    expect(fit.anchors.length).toBeLessThan(s.table.anchors.length);
    expect(fit.anchors.length).toBeGreaterThanOrEqual(4);
    // The far anchors are exactly as they were.
    for (const a of [CIRCLE.anchors[3]!]) expect(fit.anchors).toContainEqual(a);
    // Within the tolerance of the dense result (plus sampling slack).
    expect(
      hausdorffOneWay(samples(fit, 24), samples(s.table, 24)),
    ).toBeLessThan(0.75);
  });

  it("an open path keeps its ends and its open flag", () => {
    const b = brush([200, 200], { width: 200, height: 200 });
    const s = run(LINE, b, { kind: "warp", delta: [0, -40] }, 1, 4);
    const fit = liquifyRefit(s, 0.2);
    expect(fit.subpathOpen).toEqual([true]);
    expect(fit.anchors[0]!.anchor).toEqual([0, 200]);
    expect(fit.anchors[fit.anchors.length - 1]!.anchor).toEqual([400, 200]);
    expect(fit.anchors.length).toBeLessThan(s.table.anchors.length);
  });

  it("an untouched state refits to the original", () => {
    expect(liquifyRefit(liquifyStart(SQUARE), 1)).toEqual({
      ...SQUARE,
      subpathStarts: [0],
    });
  });

  it("several contours: only the touched one changes", () => {
    const two: AnchorTable = {
      anchors: [
        ...SQUARE.anchors,
        ...CIRCLE.anchors.map((a) => ({
          anchor: [a.anchor[0] + 500, a.anchor[1]] as P,
          left: [a.left[0] + 500, a.left[1]] as P,
          right: [a.right[0] + 500, a.right[1]] as P,
        })),
      ],
      subpathStarts: [0, 4],
    };
    const s = run(two, brush([800, 200]), { kind: "pucker" }, 2);
    const fit = liquifyRefit(s, 0.3);
    expect(fit.subpathStarts[0]).toBe(0);
    expect(fit.anchors.slice(0, 4)).toEqual(SQUARE.anchors);
  });
});

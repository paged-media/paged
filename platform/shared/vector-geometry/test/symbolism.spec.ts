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
  clampNineSlice,
  nineSliceApplies,
  nineSliceGuides,
  nineSlicePoint,
  sprayMove,
  spraySpacing,
  sprayStart,
  sprayTick,
  symbolismCentre,
  symbolismStep,
  symbolismWeight,
  type SymbolismItem,
} from "../src";

const at = (x: number, y: number, s = 1): SymbolismItem => ({
  matrix: [s, 0, 0, s, x, y],
  box: [-10, -10, 10, 10],
  tint: null,
  opacity: 100,
});
const brush = (x: number, y: number) => ({
  center: [x, y] as [number, number],
  diameter: 100,
  intensity: 10,
});

describe("symbolism kernels [plugin-draw.symbols]", () => {
  it("the brush weighs 1 at its centre and 0 at and past its rim", () => {
    expect(symbolismWeight(0, 100)).toBe(1);
    expect(symbolismWeight(25, 100)).toBeCloseTo(0.75, 12);
    expect(symbolismWeight(50, 100)).toBe(0);
    expect(symbolismWeight(80, 100)).toBe(0);
  });

  it("an instance out of reach comes back as the same object", () => {
    const far = at(500, 500);
    const [out] = symbolismStep([far], { kind: "sizer", brush: brush(0, 0) });
    expect(out).toBe(far);
  });

  it("Shifter moves by the drag, weighted; Scruncher pulls in and Alt pushes out", () => {
    const [moved] = symbolismStep([at(0, 0)], {
      kind: "shifter",
      brush: brush(0, 0),
      delta: [10, 0],
    });
    expect(symbolismCentre(moved!)).toEqual([10, 0]);
    const [pulled] = symbolismStep([at(20, 0)], {
      kind: "scruncher",
      brush: brush(0, 0),
    });
    expect(symbolismCentre(pulled!)[0]).toBeLessThan(20);
    const [pushed] = symbolismStep([at(20, 0)], {
      kind: "scruncher",
      brush: brush(0, 0),
      invert: true,
    });
    expect(symbolismCentre(pushed!)[0]).toBeGreaterThan(20);
  });

  it("Sizer scales about the instance's centre; Alt shrinks; the centre stays", () => {
    const [grown] = symbolismStep([at(10, 0)], {
      kind: "sizer",
      brush: brush(10, 0),
    });
    expect(grown!.matrix[0]).toBeCloseTo(1.05, 12);
    expect(symbolismCentre(grown!)[0]).toBeCloseTo(10, 9);
    const [shrunk] = symbolismStep([at(10, 0)], {
      kind: "sizer",
      brush: brush(10, 0),
      invert: true,
    });
    expect(shrunk!.matrix[0]).toBeCloseTo(1 / 1.05, 12);
  });

  it("Spinner turns towards the drag direction", () => {
    let items = [at(0, 0)];
    for (let i = 0; i < 40; i++)
      items = symbolismStep(items, {
        kind: "spinner",
        brush: brush(0, 0),
        delta: [0, 5],
      });
    const m = items[0]!.matrix;
    expect(Math.atan2(m[1], m[0])).toBeCloseTo(Math.PI / 2, 3);
    expect(symbolismCentre(items[0]!)[0]).toBeCloseTo(0, 9);
  });

  it("Stainer tints towards its colour, Alt takes the tint back off", () => {
    let [s] = symbolismStep([at(0, 0)], {
      kind: "stainer",
      brush: brush(0, 0),
      color: [0, 0, 1],
    });
    expect(s!.tint).toEqual([0, 0, 1, 0.1]);
    [s] = symbolismStep([s!], {
      kind: "stainer",
      brush: brush(0, 0),
      color: [1, 0, 0],
    });
    expect(s!.tint![3]).toBeCloseTo(0.2, 12);
    expect(s!.tint![0]).toBeCloseTo(0.5, 12);
    [s] = symbolismStep([s!], {
      kind: "stainer",
      brush: brush(0, 0),
      invert: true,
    });
    [s] = symbolismStep([s!], {
      kind: "stainer",
      brush: brush(0, 0),
      invert: true,
    });
    expect(s!.tint).toBeNull();
  });

  it("Screener lowers opacity and Alt raises it, within 0..100", () => {
    let [s] = symbolismStep([at(0, 0)], {
      kind: "screener",
      brush: brush(0, 0),
    });
    expect(s!.opacity).toBe(90);
    for (let i = 0; i < 20; i++)
      [s] = symbolismStep([s!], { kind: "screener", brush: brush(0, 0) });
    expect(s!.opacity).toBe(0);
    [s] = symbolismStep([s!], {
      kind: "screener",
      brush: brush(0, 0),
      invert: true,
    });
    expect(s!.opacity).toBe(10);
  });

  it("the Sprayer sprays every diameter/density of travel, inside the brush, from its seed", () => {
    const o = {
      diameter: 50,
      intensity: 5,
      density: 5,
      sizeScatter: 50,
      rotationScatter: 30,
      followDrag: false,
      seed: 7,
    };
    expect(spraySpacing(o)).toBe(10);
    let s = sprayMove(sprayStart(o), [0, 0]);
    expect(s.placed).toHaveLength(1);
    s = sprayMove(s, [100, 0]);
    expect(s.placed).toHaveLength(11);
    for (const p of s.placed) {
      const scale = Math.hypot(p.matrix[0], p.matrix[1]);
      expect(scale).toBeGreaterThanOrEqual(0.5 - 1e-9);
      expect(scale).toBeLessThanOrEqual(1.5 + 1e-9);
      expect(
        Math.abs(Math.atan2(p.matrix[1], p.matrix[0])),
      ).toBeLessThanOrEqual((30 * Math.PI) / 180 + 1e-9);
    }
    // Every placement within the brush of the drag line.
    for (const p of s.placed)
      expect(Math.abs(p.matrix[5])).toBeLessThanOrEqual(25 + 1e-9);
    // The same seed replays the same spray; a tick adds one more.
    const again = sprayMove(sprayMove(sprayStart(o), [0, 0]), [100, 0]);
    expect(again.placed).toEqual(s.placed);
    expect(sprayTick(s).placed).toHaveLength(12);
  });
});

describe("9-slice mapping [plugin-draw.symbols]", () => {
  const box: [number, number, number, number] = [-50, -30, 50, 30];
  const insets: [number, number, number, number] = [20, 15, 20, 15];

  it("at its own size an instance is not sliced", () => {
    expect(nineSliceApplies([1, 0, 0, 1, 5, 5])).toBe(false);
    expect(nineSlicePoint([-50, -30], box, insets, [1, 0, 0, 1, 5, 5])).toEqual(
      [-45, -25],
    );
  });

  it("corners keep their size, the centre stretches", () => {
    const m = [2, 0, 0, 1, 0, 0] as const;
    // The left edge lands at -100, a corner point 10 in stays 10 in.
    expect(nineSlicePoint([-50, -30], box, insets, m)).toEqual([-100, -30]);
    expect(nineSlicePoint([-40, -30], box, insets, m)).toEqual([-90, -30]);
    // The centre column: -30..30 → -80..80.
    expect(nineSlicePoint([0, 0], box, insets, m)).toEqual([0, 0]);
    expect(nineSlicePoint([30, 0], box, insets, m)[0]).toBeCloseTo(80, 9);
  });

  it("rotation rides along without being sliced", () => {
    const r = Math.PI / 2;
    const m = [
      2 * Math.cos(r),
      2 * Math.sin(r),
      -Math.sin(r),
      Math.cos(r),
      0,
      0,
    ] as const;
    const p = nineSlicePoint([-40, -30], box, insets, m);
    expect(p[0]).toBeCloseTo(30, 9);
    expect(p[1]).toBeCloseTo(-90, 9);
  });

  it("the guides are drawn where the cuts land; clamping keeps them in the box", () => {
    const g = nineSliceGuides(box, insets, [2, 0, 0, 1, 0, 0]);
    expect(g[0][0][0]).toBeCloseTo(-80, 9);
    expect(g[2][0][0]).toBeCloseTo(80, 9);
    expect(clampNineSlice(box, [-5, 10, 200, 70], 0)).toEqual([0, 10, 100, 50]);
  });
});

describe("9-slice guides on canvas [plugin-draw.symbols]", () => {
  const box: [number, number, number, number] = [-50, -30, 50, 30];
  const insets: [number, number, number, number] = [20, 15, 20, 15];

  it("picks the guide under the pointer and drags it to where the pointer is", async () => {
    const { nineSliceDrag, nineSliceGuideAt } = await import("../src");
    const m = [2, 0, 0, 1, 300, 200] as const;
    // The left guide is drawn at x = 300 − 100 + 20 = 220.
    expect(nineSliceGuideAt([221, 200], box, insets, m, 3)).toBe(0);
    expect(nineSliceGuideAt([300, 200], box, insets, m, 3)).toBeNull();
    expect(nineSliceDrag(0, [230, 200], box, insets, m)).toEqual([
      30, 15, 20, 15,
    ]);
    // The bottom guide, up by 5.
    expect(nineSliceDrag(3, [300, 210], box, insets, m)).toEqual([
      20, 15, 20, 20,
    ]);
    // A drag past the opposite guide stops at it.
    expect(nineSliceDrag(0, [500, 200], box, insets, m)[0]).toBe(80);
  });
});

describe("fitAffine [plugin-draw.symbols]", () => {
  it("recovers an affine from point pairs, and refuses collinear points", async () => {
    const { fitAffine, applyAffine } = await import("../src");
    const m = [1.5, 0.3, -0.2, 0.8, 40, -7] as const;
    const src: [number, number][] = [
      [0, 0],
      [10, 0],
      [0, 10],
      [7, 3],
    ];
    const dst = src.map(([x, y]) => applyAffine(m, x, y) as [number, number]);
    const fit = fitAffine(src, dst)!;
    for (let i = 0; i < 6; i++) expect(fit[i]!).toBeCloseTo(m[i]!, 9);
    expect(
      fitAffine(
        [
          [0, 0],
          [1, 1],
          [2, 2],
        ],
        [
          [0, 0],
          [1, 1],
          [2, 2],
        ],
      ),
    ).toBeNull();
  });
});

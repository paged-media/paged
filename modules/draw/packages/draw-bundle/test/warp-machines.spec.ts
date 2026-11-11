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

// THE DISTORTION MACHINES ON THE ENGINE'S KERNEL — vector-tools' Liquify
// and Puppet Warp machines driven by paged-warp through this bundle's
// wasm (`src/warp-kernel.ts`): press / move / dwell / refit / Escape,
// pins added, dragged, turned and removed, the end-of-drag refit, and
// what one drag sample costs. The kernels' own maths is tested in Rust
// (engine/core/crates/paged-warp). [plugin-draw.distortion-tools]

import { beforeAll, describe, expect, it } from "bun:test";

import { KAPPA } from "@paged-media/helpers";
import type { AnchorTable, AnchorTriple } from "@paged-media/vector-geometry";
import {
  LIQUIFY_DEFAULTS,
  LiquifyMachine,
  PuppetWarpMachine,
  liquifyRefit,
  liquifyStart,
  simplifyTolerance,
  type LiquifyBrush,
  type LiquifyParams,
  type LiquifyState,
  type WarpKernel,
} from "@paged-media/vector-tools";

import { bootWarpKernel } from "../src/warp-kernel";

let kernel: WarpKernel;
beforeAll(async () => {
  kernel = await bootWarpKernel();
});

type P = [number, number];
const corner = (p: P): AnchorTriple => ({ anchor: p, left: p, right: p });
const square = (
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): AnchorTable => ({
  anchors: [
    corner([x0, y0]),
    corner([x1, y0]),
    corner([x1, y1]),
    corner([x0, y1]),
  ],
  subpathStarts: [0],
});
const LINE: AnchorTable = {
  anchors: [corner([0, 200]), corner([400, 200])],
  subpathStarts: [0],
  subpathOpen: [true],
};

const liquify = (
  kind: (typeof LIQUIFY_DEFAULTS & { kind: never })["kind"] | string,
  targets: AnchorTable[],
  extra = {},
) =>
  new LiquifyMachine({
    options: {
      ...LIQUIFY_DEFAULTS,
      kind: kind as never,
      intensity: 100,
      ...extra,
    },
    targets,
    kernel,
  });

describe("LiquifyMachine [plugin-draw.distortion-tools]", () => {
  it("Warp: a drag carries the line with it and commits ONE refitted table", () => {
    const m = liquify("warp", [LINE]);
    m.handle({ type: "down", point: [200, 200] });
    for (let i = 1; i <= 5; i++)
      m.handle({ type: "move", point: [200, 200 - i * 6] });
    const s = m.handle({ type: "up", point: [200, 170] });
    expect(s.commit).toHaveLength(1);
    expect(s.commit![0]!.index).toBe(0);
    const ys = s.commit![0]!.table.anchors.map((a) => a.anchor[1]);
    expect(Math.min(...ys)).toBeLessThan(185);
    expect(s.active).toBe(false);
  });

  it("Warp ignores dwell ticks; Twirl keeps turning while the button rests", () => {
    const sq = square(150, 150, 250, 250);
    const w = liquify("warp", [sq]);
    w.handle({ type: "down", point: [200, 200] });
    w.handle({ type: "tick" });
    expect(w.handle({ type: "up", point: [200, 200] }).commit).toBeNull();
    const t = liquify("twirl", [sq], { width: 300, height: 300 });
    t.handle({ type: "down", point: [200, 200] });
    const one = t.handle({ type: "tick" }).tables![0]!;
    for (let i = 0; i < 5; i++) t.handle({ type: "tick" });
    const many = t.handle({ type: "tick" }).tables![0]!;
    const turn = (tb: AnchorTable) => {
      const a = tb.anchors[0]!.anchor;
      const b = sq.anchors[0]!.anchor;
      let d =
        Math.atan2(a[1] - 200, a[0] - 200) - Math.atan2(b[1] - 200, b[0] - 200);
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      return Math.abs(d);
    };
    expect(turn(many)).toBeGreaterThan(turn(one) * 3);
    expect(t.handle({ type: "up", point: [200, 200] }).commit).not.toBeNull();
  });

  it("Pucker and Bloat step on the press; a brush away from every target commits nothing", () => {
    const sq = square(150, 150, 250, 250);
    const p = liquify("pucker", [sq], { width: 300, height: 300 });
    expect(
      p.handle({ type: "down", point: [200, 200] }).tables![0]!.anchors.length,
    ).toBeGreaterThan(4);
    expect(p.handle({ type: "up", point: [200, 200] }).commit).not.toBeNull();
    const miss = liquify("bloat", [sq]);
    miss.handle({ type: "down", point: [900, 900] });
    expect(miss.handle({ type: "up", point: [900, 900] }).commit).toBeNull();
  });

  it("only the targets the brush touched are committed", () => {
    const a = square(0, 0, 50, 50);
    const b = square(300, 300, 350, 350);
    const m = liquify("crystallize", [a, b], { complexity: 5 });
    m.handle({ type: "down", point: [325, 300] });
    const s = m.handle({ type: "up", point: [325, 300] });
    expect(s.commit!.map((c) => c.index)).toEqual([1]);
  });

  it("use pressure: a pen's pressure replaces the intensity, a mouse keeps it", () => {
    const sq = square(150, 150, 250, 250);
    const light = liquify("bloat", [sq], {
      usePressure: true,
      width: 300,
      height: 300,
    });
    const lt = light.handle({
      type: "down",
      point: [200, 200],
      pressure: 0.1,
      pen: true,
    }).tables![0]!;
    const hard = liquify("bloat", [sq], {
      usePressure: true,
      width: 300,
      height: 300,
    });
    const ht = hard.handle({
      type: "down",
      point: [200, 200],
      pressure: 1,
      pen: true,
    }).tables![0]!;
    const r = (t: AnchorTable) =>
      Math.max(...t.anchors.map((x) => Math.abs(x.anchor[0] - 200)));
    expect(r(ht)).toBeGreaterThan(r(lt));
    const mouse = liquify("bloat", [sq], {
      usePressure: true,
      width: 300,
      height: 300,
    });
    const mt = mouse.handle({
      type: "down",
      point: [200, 200],
      pressure: 0.1,
      pen: false,
    }).tables![0]!;
    expect(r(mt)).toBeCloseTo(r(ht), 9);
  });

  it("Escape cancels: nothing is committed", () => {
    const m = liquify("wrinkle", [LINE]);
    m.handle({ type: "down", point: [200, 200] });
    m.handle({ type: "move", point: [210, 200] });
    const s = m.handle({ type: "key", key: "Escape" });
    expect(s.commit).toBeNull();
    expect(s.tables).toBeNull();
    expect(m.handle({ type: "up", point: [210, 200] }).commit).toBeNull();
  });

  it("hovering moves the brush outline without distorting", () => {
    const m = liquify("pucker", [LINE]);
    const s = m.handle({ type: "move", point: [50, 60] });
    expect(s.brush!.center).toEqual([50, 60]);
    expect(s.tables).toBeNull();
  });
});

describe("PuppetWarpMachine [plugin-draw.distortion-tools]", () => {
  const bar = square(0, 0, 200, 40);

  it("meshes the selection and places three automatic pins", () => {
    const m = new PuppetWarpMachine({ targets: [bar], tolerance: 4, kernel });
    expect(m.usable).toBe(true);
    const v = m.view();
    expect(v.pins).toHaveLength(3);
    expect(v.meshEdges.length).toBeGreaterThan(50);
    // At rest the mapped table is the input.
    v.tables[0]!.anchors.forEach((a, i) => {
      expect(a.anchor[0]).toBeCloseTo(bar.anchors[i]!.anchor[0], 3);
      expect(a.anchor[1]).toBeCloseTo(bar.anchors[i]!.anchor[1], 3);
    });
  });

  it("dragging a pin bends the artwork and commits once, on release", () => {
    const m = new PuppetWarpMachine({ targets: [bar], tolerance: 4, kernel });
    const tip = m.pinPoints().reduce((a, b) => (b[0] > a[0] ? b : a));
    m.handle({ type: "down", point: tip });
    const mid = m.handle({ type: "move", point: [tip[0], tip[1] + 40] });
    expect(mid.commit).toBeNull();
    expect(mid.dragging).toBe(true);
    const s = m.handle({ type: "up", point: [tip[0], tip[1] + 60] });
    expect(s.commit).toHaveLength(1);
    const right = s.commit![0]!.anchors[1]!.anchor; // (200, 0)
    expect(right[1]).toBeGreaterThan(30);
    // The other pins held; the far end barely moved.
    const others = (pts: [number, number][]) =>
      pts.filter((p) => p !== tip && p[0] < 150);
    expect(others(s.pins.map((p) => p.point))).toEqual(others(m.pinPoints()));
    expect(Math.abs(s.commit![0]!.anchors[0]!.anchor[0])).toBeLessThan(6);
  });

  it("a click on the mesh adds a pin without moving anything; Alt+click removes one and re-solves", () => {
    const m = new PuppetWarpMachine({
      targets: [bar],
      tolerance: 4,
      kernel,
      autoPinCount: 2,
    });
    const before = m.view().tables[0]!;
    const added = m.handle({ type: "down", point: [60, 20] });
    expect(added.pins).toHaveLength(3);
    const up = m.handle({ type: "up", point: [60, 20] });
    expect(up.commit).toBeNull();
    up.tables[0]!.anchors.forEach((a, i) => {
      expect(a.anchor[0]).toBeCloseTo(before.anchors[i]!.anchor[0], 3);
    });
    const pin = up.pins.find((p) => p.selected)!.point;
    const removed = m.handle({ type: "down", point: pin, alt: true });
    expect(removed.pins).toHaveLength(2);
    expect(removed.commit).not.toBeNull();
  });

  it("the rotation ring turns the artwork about the selected pin", () => {
    const m = new PuppetWarpMachine({
      targets: [bar],
      tolerance: 4,
      kernel,
      autoPinCount: 0,
    });
    m.handle({ type: "down", point: [100, 20] });
    m.handle({ type: "up", point: [100, 20] });
    const centre = m.view().pins[0]!.point;
    // Press on the ring (2 pick radii out), turn a quarter.
    m.handle({ type: "down", point: [centre[0] + 8, centre[1]] });
    const s = m.handle({ type: "up", point: [centre[0], centre[1] + 8] });
    expect(s.commit).not.toBeNull();
    const a = s.commit![0]!.anchors[1]!.anchor; // (200, 0) turned 90° about ~(100, 20)
    // Near-rigid: two constraints a mesh edge apart steer a 100 pt lever.
    expect(
      Math.hypot(a[0] - (centre[0] + 20), a[1] - (centre[1] + 100)),
    ).toBeLessThan(3);
  });

  it("Delete removes the selected pin; Escape puts a dragged pin back", () => {
    const m = new PuppetWarpMachine({ targets: [bar], tolerance: 4, kernel });
    const p = m.pinPoints()[0]!;
    m.handle({ type: "down", point: p });
    m.handle({ type: "move", point: [p[0] + 30, p[1]] });
    const esc = m.handle({ type: "key", key: "Escape" });
    expect(esc.pins[0]!.point[0]).toBeCloseTo(p[0], 9);
    expect(esc.commit).toBeNull();
    m.handle({ type: "down", point: p });
    m.handle({ type: "up", point: p });
    const del = m.handle({ type: "key", key: "Delete" });
    expect(del.pins).toHaveLength(2);
    expect(del.commit).not.toBeNull();
  });

  it("a selection with no outline is not usable", () => {
    const m = new PuppetWarpMachine({ targets: [LINE], tolerance: 4, kernel });
    expect(m.usable).toBe(false);
    expect(m.handle({ type: "down", point: [100, 200] }).commit).toBeNull();
  });
});

const K = KAPPA * 100;
const CIRCLE: AnchorTable = {
  anchors: [
    { anchor: [200, 100], left: [200 - K, 100], right: [200 + K, 100] },
    { anchor: [300, 200], left: [300, 200 - K], right: [300, 200 + K] },
    { anchor: [200, 300], left: [200 + K, 300], right: [200 - K, 300] },
    { anchor: [100, 200], left: [100, 200 + K], right: [100, 200 - K] },
  ],
  subpathStarts: [0],
};

const brush = (c: P, extra: Partial<LiquifyBrush> = {}): LiquifyBrush => ({
  center: c,
  width: 100,
  height: 100,
  angleDeg: 0,
  strength: 1,
  ...extra,
});

const run = (
  t: AnchorTable,
  b: LiquifyBrush,
  params: LiquifyParams,
  steps = 1,
  detail = 2,
): LiquifyState => {
  let s = liquifyStart(t);
  for (let i = 0; i < steps; i++) s = kernel.liquifyStep(s, b, params, detail);
  return s;
};

describe("liquify — the refit [plugin-draw.distortion-tools]", () => {
  it("re-fits the touched run and keeps every untouched anchor byte-identical", () => {
    const s = run(
      CIRCLE,
      brush([300, 200], { width: 120, height: 120 }),
      { kind: "bloat" },
      4,
      6,
    );
    const fit = liquifyRefit(s, 0.5);
    expect(fit.anchors.length).toBeLessThan(s.table.anchors.length);
    expect(fit.anchors.length).toBeGreaterThanOrEqual(4);
    expect(fit.anchors).toContainEqual(CIRCLE.anchors[3]!);
  });

  it("an open path keeps its ends and its open flag", () => {
    const s = run(
      LINE,
      brush([200, 200], { width: 200, height: 200 }),
      { kind: "warp", delta: [0, -40] },
      1,
      4,
    );
    expect(s.table.subpathOpen).toEqual([true]);
    const fit = liquifyRefit(s, 0.2);
    expect(fit.subpathOpen).toEqual([true]);
    expect(fit.anchors[0]!.anchor).toEqual([0, 200]);
    expect(fit.anchors[fit.anchors.length - 1]!.anchor).toEqual([400, 200]);
    expect(fit.anchors.length).toBeLessThan(s.table.anchors.length);
  });

  it("an untouched state refits to the original; a table without open flags stays without", () => {
    const sq = square(100, 100, 300, 300);
    expect(liquifyRefit(liquifyStart(sq), 1)).toEqual(sq);
    expect(run(sq, brush([900, 900]), { kind: "pucker" }).table).toEqual(sq);
    expect(simplifyTolerance(50)).toBeCloseTo(1, 9);
  });

  it("several contours: only the touched one changes", () => {
    const two: AnchorTable = {
      anchors: [
        ...square(100, 100, 300, 300).anchors,
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
    expect(fit.anchors.slice(0, 4)).toEqual(square(100, 100, 300, 300).anchors);
  });
});

describe("the kernel's cost per drag sample [plugin-draw.distortion-tools]", () => {
  it("a Puppet Warp sample and a Liquify step stay well inside a frame", () => {
    // About 320 vertices (the tool's default cap) over a star outline.
    const ring: P[] = Array.from({ length: 72 }, (_, i) => {
      const a = (i / 72) * 2 * Math.PI;
      const r = i % 2 ? 120 : 200;
      return [300 + r * Math.cos(a), 300 + r * Math.sin(a)];
    });
    const star: AnchorTable = {
      anchors: ring.map((p) => corner(p)),
      subpathStarts: [0],
    };
    const m = new PuppetWarpMachine({
      targets: [star],
      tolerance: 4,
      spacing: 12,
      maxVertices: 320,
      kernel,
    });
    expect(m.mesh.vertices.length).toBeGreaterThan(200);
    const tip = m.pinPoints().reduce((a, b) => (b[0] > a[0] ? b : a));
    m.handle({ type: "down", point: tip });
    const n = 20;
    const t0 = performance.now();
    for (let i = 1; i <= n; i++)
      m.handle({ type: "move", point: [tip[0] + i * 2, tip[1] + i * 3] });
    const puppet = (performance.now() - t0) / n;

    const lq = new LiquifyMachine({
      options: {
        ...LIQUIFY_DEFAULTS,
        kind: "twirl",
        intensity: 100,
        width: 150,
        height: 150,
      },
      targets: [star],
      kernel,
    });
    lq.handle({ type: "down", point: [480, 300] });
    const t1 = performance.now();
    for (let i = 1; i <= n; i++)
      lq.handle({ type: "move", point: [480 - i * 4, 300 + i * 4] });
    const liquify = (performance.now() - t1) / n;
    console.log(
      `warp kernel: puppet ${m.mesh.vertices.length} vertices ${puppet.toFixed(2)} ms/sample; ` +
        `liquify ${liquify.toFixed(2)} ms/step`,
    );
    // Generous bounds (shared CI runners); the measured numbers are in
    // src/warp-kernel.ts.
    expect(puppet).toBeLessThan(100);
    expect(liquify).toBeLessThan(100);
  });
});

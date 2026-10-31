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

// THE DISTORTION MACHINES — Liquify (press steps, move steps, dwell
// ticks, one refit commit, Escape), Puppet Warp (auto pins, add / drag /
// rotate / remove pins, commits), the Perspective Grid handles and widget,
// and Perspective Selection (attach, move along the plane, draw on it).
// [plugin-draw.distortion-tools]

import { describe, expect, it } from "bun:test";

import {
  defaultGrid,
  flatRect,
  pageToPlane,
  planeToPage,
  type AnchorTable,
  type AnchorTriple,
} from "@paged-media/draw-geometry";

import {
  LIQUIFY_DEFAULTS,
  LiquifyMachine,
  PerspectiveGridMachine,
  PerspectiveSelectMachine,
  PuppetWarpMachine,
  planeForKey,
  planeWidgetHit,
  planeWidgetLayout,
} from "../src";

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
    const m = new PuppetWarpMachine({ targets: [bar], tolerance: 4 });
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
    const m = new PuppetWarpMachine({ targets: [bar], tolerance: 4 });
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
    const m = new PuppetWarpMachine({ targets: [bar], tolerance: 4 });
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
    const m = new PuppetWarpMachine({ targets: [LINE], tolerance: 4 });
    expect(m.usable).toBe(false);
    expect(m.handle({ type: "down", point: [100, 200] }).commit).toBeNull();
  });
});

describe("PerspectiveGridMachine and the plane widget [plugin-draw.distortion-tools]", () => {
  const g = defaultGrid(2, 612, 792);

  it("drags a vanishing point and commits the new grid", () => {
    const m = new PerspectiveGridMachine({ grid: g, tolerance: 6 });
    m.handle({ type: "down", point: [g.vpLeft, g.horizonY] });
    m.handle({ type: "move", point: [g.vpLeft + 40, g.horizonY] });
    const s = m.handle({ type: "up", point: [g.vpLeft + 50, g.horizonY + 3] });
    expect(s.commit!.vpLeft).toBe(g.vpLeft + 50);
    expect(s.commit!.horizonY).toBe(g.horizonY);
  });

  it("a locked grid refuses handle drags; a press on no handle does nothing", () => {
    const locked = new PerspectiveGridMachine({
      grid: { ...g, locked: true },
      tolerance: 6,
    });
    locked.handle({ type: "down", point: [g.vpLeft, g.horizonY] });
    expect(
      locked.handle({ type: "up", point: [g.vpLeft + 50, g.horizonY] }).commit,
    ).toBeNull();
    const miss = new PerspectiveGridMachine({ grid: g, tolerance: 6 });
    miss.handle({ type: "down", point: [5, 5] });
    expect(miss.handle({ type: "up", point: [9, 9] }).commit).toBeNull();
  });

  it("the widget and keys 1–4 switch the active plane", () => {
    const cells = planeWidgetLayout([10, 10], 20);
    expect(planeWidgetHit(cells, [15, 15])).toBe("left");
    expect(planeWidgetHit(cells, [35, 15])).toBe("right");
    expect(planeWidgetHit(cells, [15, 35])).toBe("floor");
    expect(planeWidgetHit(cells, [35, 35])).toBe("none");
    expect(planeWidgetHit(cells, [80, 80])).toBeNull();
    const m = new PerspectiveGridMachine({
      grid: g,
      tolerance: 6,
      widget: cells,
    });
    expect(
      m.handle({ type: "down", point: [35, 15] }).commit!.activePlane,
    ).toBe("right");
    expect(planeForKey("2")).toBe("floor");
    const k = new PerspectiveGridMachine({ grid: g, tolerance: 6 });
    expect(k.handle({ type: "key", key: "3" }).commit!.activePlane).toBe(
      "right",
    );
    // The same plane again changes nothing.
    const same = new PerspectiveGridMachine({ grid: g, tolerance: 6 });
    expect(same.handle({ type: "key", key: "1" }).commit).toBeNull();
  });
});

describe("PerspectiveSelectMachine [plugin-draw.distortion-tools]", () => {
  const g = { ...defaultGrid(2, 612, 792), activePlane: "right" as const };

  it("dragging free artwork onto the active plane attaches it", () => {
    const art = square(100, 100, 160, 140);
    const m = new PerspectiveSelectMachine({ grid: g, shape: "none" });
    m.handle({
      type: "down",
      point: [100, 140],
      hit: { kind: "free", table: art },
    });
    const drop: P = [g.origin[0] + 30, g.origin[1] - 20];
    const s = m.handle({ type: "up", point: drop });
    expect(s.commit!.kind).toBe("attach");
    expect(s.commit!.plane).toBe("right");
    expect(s.commit!.page.anchors[3]!.anchor[0]).toBeCloseTo(drop[0], 6);
    expect(s.commit!.page.anchors[3]!.anchor[1]).toBeCloseTo(drop[1], 6);
  });

  it("attached artwork moves along ITS plane, whatever the active plane", () => {
    const flat = flatRect([-80, -60], [-20, -10]);
    const m = new PerspectiveSelectMachine({ grid: g, shape: "none" });
    const from = planeToPage(g, "left", [-50, -30])!;
    const to = planeToPage(g, "left", [-90, -30])!;
    m.handle({
      type: "down",
      point: from,
      hit: { kind: "attached", plane: "left", flat },
    });
    const s = m.handle({ type: "up", point: to });
    expect(s.commit!.kind).toBe("move");
    expect(s.commit!.plane).toBe("left");
    expect(s.commit!.flat.anchors[0]!.anchor[0]).toBeCloseTo(-120, 6);
  });

  it("with a shape option, a drag on nothing draws on the active plane", () => {
    const m = new PerspectiveSelectMachine({ grid: g, shape: "ellipse" });
    const a = planeToPage(g, "right", [20, -100])!;
    const b = planeToPage(g, "right", [120, -20])!;
    m.handle({ type: "down", point: a, hit: { kind: "none" } });
    m.handle({ type: "move", point: b });
    const s = m.handle({ type: "up", point: b });
    expect(s.commit!.kind).toBe("draw");
    const xs = s.commit!.flat.anchors.map((x) => x.anchor[0]);
    expect(Math.min(...xs)).toBeCloseTo(20, 6);
    expect(Math.max(...xs)).toBeCloseTo(120, 6);
    // The ellipse starts at its right-hand point (svg-shapes' κ ellipse).
    expect(
      pageToPlane(g, "right", s.commit!.page.anchors[0]!.anchor)![0],
    ).toBeCloseTo(120, 3);
  });

  it("no active plane: free artwork is not attached; a click commits nothing; Escape cancels", () => {
    const none = { ...g, activePlane: "none" as const };
    const m = new PerspectiveSelectMachine({ grid: none, shape: "rectangle" });
    m.handle({
      type: "down",
      point: [100, 100],
      hit: { kind: "free", table: square(0, 0, 10, 10) },
    });
    expect(m.handle({ type: "up", point: [300, 600] }).commit).toBeNull();
    const click = new PerspectiveSelectMachine({ grid: g, shape: "rectangle" });
    click.handle({ type: "down", point: [400, 500], hit: { kind: "none" } });
    expect(click.handle({ type: "up", point: [400, 500] }).commit).toBeNull();
    const esc = new PerspectiveSelectMachine({ grid: g, shape: "rectangle" });
    esc.handle({ type: "down", point: [400, 500], hit: { kind: "none" } });
    esc.handle({ type: "move", point: [420, 520] });
    expect(esc.handle({ type: "key", key: "Escape" }).commit).toBeNull();
  });
});

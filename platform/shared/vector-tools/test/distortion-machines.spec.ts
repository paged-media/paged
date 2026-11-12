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

// THE DISTORTION MACHINES — the Perspective Grid handles and widget, and
// Perspective Selection (attach, move along the plane, draw on it). The
// Liquify and Puppet Warp machines run on the engine's warp kernel and are
// tested where it boots: modules/draw/packages/draw-bundle/test/
// warp-machines.spec.ts. [plugin-draw.distortion-tools]

import { describe, expect, it } from "bun:test";

import {
  defaultGrid,
  flatRect,
  pageToPlane,
  planeToPage,
  type AnchorTable,
  type AnchorTriple,
} from "@paged-media/vector-geometry";

import {
  PerspectiveGridMachine,
  PerspectiveSelectMachine,
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

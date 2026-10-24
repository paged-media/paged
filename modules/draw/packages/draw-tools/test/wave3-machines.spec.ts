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

// The WP6.1 part-2 gesture machines: the shared scrub (Join, Path
// Eraser, Shaper), Reflect, Reshape, Star and Flare. Pure — points in,
// snapshots out.

import { describe, expect, it } from "bun:test";

import type { AnchorTable, AnchorTriple } from "@paged-media/draw-geometry";

import {
  FlareMachine,
  ReflectMachine,
  ReshapeMachine,
  ScrubMachine,
  StarMachine,
  axisAngleOf,
} from "../src";

type P = [number, number];
const corner = (p: P): AnchorTriple => ({ anchor: p, left: p, right: p });
const NONE = { alt: false, shift: false };

describe("ScrubMachine [plugin-draw.tool-wave-3]", () => {
  it("records decimated samples and commits them with the release point", () => {
    const m = new ScrubMachine({ minSampleDistance: 2 });
    m.handle({ type: "down", point: [0, 0] });
    m.handle({ type: "move", point: [1, 0] });
    m.handle({ type: "move", point: [3, 0] });
    const s = m.handle({ type: "up", point: [6, 0] });
    expect(s.commit).toEqual([
      [0, 0],
      [3, 0],
      [6, 0],
    ]);
    expect(s.active).toBe(false);
  });

  it("a click or a twitch cancels; Escape cancels", () => {
    const click = new ScrubMachine({ minLength: 2 });
    click.handle({ type: "down", point: [0, 0] });
    expect(click.handle({ type: "up", point: [0.5, 0] }).commit).toBeNull();
    const esc = new ScrubMachine();
    esc.handle({ type: "down", point: [0, 0] });
    esc.handle({ type: "move", point: [10, 0] });
    const s = esc.handle({ type: "key", key: "Escape" });
    expect(s.commit).toBeNull();
    expect(s.points).toEqual([]);
  });
});

describe("ReflectMachine [plugin-draw.tool-wave-3]", () => {
  it("before any click the axis point is the default (the selection's centre); a drag commits the axis angle", () => {
    const m = new ReflectMachine({ clickTolerance: 2 });
    m.setDefaultPivot([100, 100]);
    m.handle({ type: "down", point: [150, 100], modifiers: NONE });
    const mid = m.handle({ type: "move", point: [100, 160], modifiers: NONE });
    expect(mid.axisAngleDeg).toBeCloseTo(90, 9);
    const up = m.handle({ type: "up", point: [100, 160], modifiers: NONE });
    expect(up.commit).toEqual({ pivot: [100, 100], angleDeg: 90, copy: false });
    expect(up.axisAngleDeg).toBeNull();
  });

  it("a click moves the axis point and it stays; Shift snaps; Alt at release copies", () => {
    const m = new ReflectMachine({ clickTolerance: 2 });
    m.setDefaultPivot([100, 100]);
    m.handle({ type: "down", point: [10, 10], modifiers: NONE });
    const click = m.handle({ type: "up", point: [10, 10], modifiers: NONE });
    expect(click.pivot).toEqual([10, 10]);
    expect(click.commit).toBeNull();
    m.setDefaultPivot([500, 500]); // a click beats the default
    m.handle({ type: "down", point: [40, 12], modifiers: NONE });
    const up = m.handle({ type: "up", point: [50, 13], modifiers: { alt: true, shift: true } });
    expect(up.commit).toEqual({ pivot: [10, 10], angleDeg: 0, copy: true });
  });

  it("Alt+click asks for the options at the clicked axis point; Escape drops a drag", () => {
    const m = new ReflectMachine({ clickTolerance: 2 });
    m.handle({ type: "down", point: [20, 30], modifiers: { alt: true, shift: false } });
    const s = m.handle({ type: "up", point: [20, 30], modifiers: { alt: true, shift: false } });
    expect(s.openOptions).toEqual([20, 30]);
    m.handle({ type: "down", point: [60, 30], modifiers: NONE });
    m.handle({ type: "move", point: [60, 80], modifiers: NONE });
    expect(m.handle({ type: "key", key: "Escape" }).axisAngleDeg).toBeNull();
    expect(m.handle({ type: "up", point: [60, 80], modifiers: NONE }).commit).toBeNull();
  });

  it("axisAngleOf snaps to 45°", () => {
    expect(axisAngleOf([0, 0], [10, 9], true)).toBe(45);
    expect(axisAngleOf([0, 0], [10, 9], false)).toBeCloseTo(41.987, 2);
  });
});

describe("ReshapeMachine [plugin-draw.tool-wave-3]", () => {
  const line: AnchorTable = {
    anchors: [corner([0, 0]), corner([50, 0]), corner([100, 0]), corner([150, 0])],
    subpathStarts: [0],
    subpathOpen: [true],
  };

  it("dragging an anchor moves it fully and its neighbours by the falloff", () => {
    const m = new ReshapeMachine({ table: line, tolerance: 3, radius: 80 });
    m.handle({ type: "down", point: [50, 1] });
    m.handle({ type: "move", point: [50, 20] });
    const s = m.handle({ type: "up", point: [50, 31] });
    const ys = s.commit!.anchors.map((a) => a.anchor[1]);
    expect(ys[1]).toBe(30);
    expect(ys[0]).toBeGreaterThan(0);
    expect(ys[2]).toBeGreaterThan(0);
    expect(ys[0]).toBeLessThan(30);
    expect(ys[3]).toBeLessThan(ys[2]!);
  });

  it("a press on a segment adds an anchor there first; a plain click on one commits the insert", () => {
    const m = new ReshapeMachine({ table: line, tolerance: 3, radius: 40 });
    const down = m.handle({ type: "down", point: [75, 0.5] });
    expect(down.index).toBe(2);
    expect(down.table!.anchors).toHaveLength(5);
    const s = m.handle({ type: "up", point: [75, 0.5] });
    expect(s.commit!.anchors).toHaveLength(5);
  });

  it("a click on an anchor without a drag is no edit; a miss is nothing", () => {
    const click = new ReshapeMachine({ table: line, tolerance: 3, radius: 40 });
    click.handle({ type: "down", point: [100, 0] });
    expect(click.handle({ type: "up", point: [100, 0] }).commit).toBeNull();
    const miss = new ReshapeMachine({ table: line, tolerance: 3, radius: 40 });
    expect(miss.handle({ type: "down", point: [75, 40] }).active).toBe(false);
  });
});

describe("StarMachine / FlareMachine [plugin-draw.tool-wave-3]", () => {
  it("a drag sizes Radius 1, keeps the Radius 2 ratio, turns with the pointer", () => {
    const m = new StarMachine({ points: 5, ratio: 0.5, clickTolerance: 2 });
    m.handle({ type: "down", point: [100, 100] });
    m.handle({ type: "move", point: [140, 100] });
    const s = m.handle({ type: "up", point: [160, 100] });
    expect(s.commit).toMatchObject({ cx: 100, cy: 100, radius1: 60, radius2: 30, points: 5 });
    expect(s.commit!.rotationDeg).toBeCloseTo(90, 9);
  });

  it("arrow keys change the point count during the drag; Shift keeps it upright", () => {
    const m = new StarMachine({ points: 5, ratio: 0.4, clickTolerance: 2 });
    m.handle({ type: "down", point: [0, 0] });
    m.handle({ type: "move", point: [30, 30] });
    m.handle({ type: "key", key: "ArrowUp" });
    m.handle({ type: "key", key: "ArrowUp" });
    expect(m.handle({ type: "key", key: "ArrowDown" }).star!.points).toBe(6);
    const s = m.handle({ type: "up", point: [30, 30], modifiers: { shift: true } });
    expect(s.commit!.points).toBe(6);
    expect(s.commit!.rotationDeg).toBe(0);
  });

  it("a click asks for the options at the centre; points never drop below 3", () => {
    const m = new StarMachine({ points: 3, ratio: 0.5, clickTolerance: 2 });
    m.handle({ type: "down", point: [5, 5] });
    m.handle({ type: "key", key: "ArrowDown" });
    expect(m.handle({ type: "up", point: [5, 5] }).openOptions).toEqual([5, 5]);
  });

  it("a flare is two gestures: size, then the rings' end", () => {
    const m = new FlareMachine({ clickTolerance: 2 });
    m.handle({ type: "down", point: [100, 100] });
    m.handle({ type: "move", point: [130, 100] });
    const first = m.handle({ type: "up", point: [140, 100] });
    expect(first.commit).toBeNull();
    expect(first.step).toBe("end");
    m.handle({ type: "move", point: [250, 180] });
    m.handle({ type: "down", point: [260, 190] });
    const s = m.handle({ type: "up", point: [300, 200] });
    expect(s.commit).toEqual({ centre: [100, 100], size: 40, end: [300, 200] });
  });

  it("Escape between the steps keeps the flare without rings; a first click opens the options", () => {
    const m = new FlareMachine({ clickTolerance: 2 });
    m.handle({ type: "down", point: [0, 0] });
    m.handle({ type: "up", point: [20, 0] });
    expect(m.handle({ type: "key", key: "Escape" }).commit).toEqual({ centre: [0, 0], size: 20, end: null });
    const c = new FlareMachine({ clickTolerance: 2 });
    c.handle({ type: "down", point: [7, 7] });
    expect(c.handle({ type: "up", point: [7, 7] }).openOptions).toEqual([7, 7]);
  });
});

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

import { KnifeMachine } from "../src";

const NONE = { alt: false, shift: false };
const ALT = { alt: true, shift: false };
const ALT_SHIFT = { alt: true, shift: true };

describe("KnifeMachine", () => {
  it("collects decimated freehand samples while cutting (the live preview)", () => {
    const m = new KnifeMachine({ tolerance: 1, minSampleDistance: 2 });
    m.handle({ type: "down", point: [0, 0] });
    m.handle({ type: "move", point: [1, 0] }); // under the floor — dropped
    m.handle({ type: "move", point: [5, 0] });
    const snap = m.handle({ type: "move", point: [10, 3], modifiers: NONE });
    expect(snap.points).toEqual([
      [0, 0],
      [5, 0],
      [10, 3],
    ]);
    expect(snap.active).toBe(true);
    expect(snap.straight).toBe(false);
    expect(snap.commit).toBeNull();
  });

  it("the commit is the RDP-simplified cut, endpoints kept", () => {
    const m = new KnifeMachine({ tolerance: 0.5 });
    m.handle({ type: "down", point: [0, 0] });
    for (let x = 1; x <= 50; x++) m.handle({ type: "move", point: [x, 0] });
    for (let y = 1; y <= 50; y++) m.handle({ type: "move", point: [50, y] });
    const done = m.handle({ type: "up", point: [50, 50] });
    expect(done.commit).toEqual({
      cut: [
        [0, 0],
        [50, 0],
        [50, 50],
      ],
      straight: false,
    });
    expect(done.active).toBe(false);
  });

  it("Alt makes it a STRAIGHT cut from the press point; Alt+Shift snaps it to 45°", () => {
    const m = new KnifeMachine({ tolerance: 0.5 });
    m.handle({ type: "down", point: [0, 0] });
    m.handle({ type: "move", point: [10, 7] });
    const straight = m.handle({ type: "move", point: [40, 3], modifiers: ALT });
    expect(straight.straight).toBe(true);
    expect(straight.points).toEqual([
      [0, 0],
      [40, 3],
    ]);
    const done = m.handle({ type: "up", point: [40, 3], modifiers: ALT_SHIFT });
    expect(done.commit!.straight).toBe(true);
    expect(done.commit!.cut[0]).toEqual([0, 0]);
    expect(done.commit!.cut[1][1]).toBeCloseTo(0, 12);
    expect(done.commit!.cut[1][0]).toBeCloseTo(Math.hypot(40, 3), 12);
  });

  it("releasing Alt mid-drag returns to the freehand line already drawn", () => {
    const m = new KnifeMachine({ tolerance: 0.5 });
    m.handle({ type: "down", point: [0, 0] });
    m.handle({ type: "move", point: [10, 10] });
    m.handle({ type: "move", point: [30, 0], modifiers: ALT });
    const back = m.handle({ type: "move", point: [20, 20], modifiers: NONE });
    expect(back.straight).toBe(false);
    expect(back.points).toEqual([
      [0, 0],
      [10, 10],
      [20, 20],
    ]);
  });

  it("a click or a twitch shorter than minLength cancels — nothing to cut along", () => {
    const click = new KnifeMachine({ tolerance: 0.5 });
    click.handle({ type: "down", point: [5, 5] });
    const c = click.handle({ type: "up", point: [5, 5] });
    expect(c.commit).toBeNull();
    expect(c.active).toBe(false);

    const twitch = new KnifeMachine({ tolerance: 0.5, minLength: 3 });
    twitch.handle({ type: "down", point: [0, 0] });
    expect(twitch.handle({ type: "up", point: [2, 0] }).commit).toBeNull();
  });

  it("Escape cancels the cut in flight; the trailing up commits nothing", () => {
    const m = new KnifeMachine({ tolerance: 0.5 });
    m.handle({ type: "down", point: [0, 0] });
    m.handle({ type: "move", point: [40, 0] });
    const esc = m.handle({ type: "key", key: "Escape" });
    expect(esc.active).toBe(false);
    expect(esc.points).toEqual([]);
    expect(m.handle({ type: "up", point: [80, 0] }).commit).toBeNull();
  });

  it("a move or up with no press is ignored", () => {
    const m = new KnifeMachine({ tolerance: 0.5 });
    expect(m.handle({ type: "move", point: [3, 3] }).points).toEqual([]);
    expect(m.handle({ type: "up", point: [3, 3] }).commit).toBeNull();
  });
});

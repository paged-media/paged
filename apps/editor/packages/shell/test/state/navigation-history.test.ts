/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
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

// Navigation history (UXI-CAM-016; editor ADR "Navigation history and one
// current page"): a browser's Back and Forward over camera places, pushed
// only by explicit navigations.

import { describe, expect, test } from "bun:test";

import { covers } from "@paged-media/test-kit";

import {
  createNavigationHistory,
  sameView,
} from "../../src/state/navigation-history";

const at = (tx: number, ty = 0, scale = 1, rotation = 0) => ({
  scale,
  tx,
  ty,
  rotation,
});

describe("navigation history", () => {
  test("Back returns where the last navigation started, Forward undoes it", () => {
    covers(
      "command:paged.view.navigateBack",
      "command:paged.view.navigateForward",
    );
    const h = createNavigationHistory();
    expect(h.state()).toEqual({ back: 0, forward: 0 });
    // A at 0 → navigate to B at 100 → navigate to C at 200.
    h.record(at(0), at(100));
    h.record(at(100), at(200));
    expect(h.state()).toEqual({ back: 2, forward: 0 });
    // The user panned around C (free moves record nothing) to 250.
    expect(h.back(at(250))).toEqual(at(100));
    expect(h.back(at(100))).toEqual(at(0));
    expect(h.back(at(0))).toBeNull();
    expect(h.state()).toEqual({ back: 0, forward: 2 });
    // Forward comes back through B to where the user left C (250).
    expect(h.forward(at(0))).toEqual(at(100));
    expect(h.forward(at(100))).toEqual(at(250));
    expect(h.forward(at(250))).toBeNull();
  });

  test("a new navigation forgets the forward places", () => {
    const h = createNavigationHistory();
    h.record(at(0), at(100));
    h.back(at(100));
    expect(h.state().forward).toBe(1);
    h.record(at(0), at(300));
    expect(h.state()).toEqual({ back: 1, forward: 0 });
    expect(h.forward(at(300))).toBeNull();
  });

  test("a navigation that does not move the view, or repeats the last place, records nothing", () => {
    const h = createNavigationHistory();
    h.record(at(0), at(0.2));
    expect(h.state().back).toBe(0);
    h.record(at(0), at(100));
    h.record(at(0.3), at(200));
    expect(h.state().back).toBe(1);
    // Back skips a place the user is already at.
    expect(h.back(at(0))).toBeNull();
  });

  test("zoom and rotation are part of a place", () => {
    expect(sameView(at(0, 0, 1), at(0, 0, 1.5))).toBe(false);
    expect(sameView(at(0, 0, 1, 0), at(0, 0, 1, Math.PI / 12))).toBe(false);
    expect(sameView(at(0, 0, 1), at(0.4, -0.4, 1.00005))).toBe(true);
  });

  test("it holds a bounded number of places and can be emptied", () => {
    const h = createNavigationHistory(3);
    for (let i = 0; i < 6; i++) h.record(at(i * 100), at(i * 100 + 50));
    expect(h.state().back).toBe(3);
    expect(h.back(at(9999))).toEqual(at(500));
    h.clear();
    expect(h.state()).toEqual({ back: 0, forward: 0 });
  });

  test("subscribers hear a change, and the state is stable between changes", () => {
    const h = createNavigationHistory();
    let calls = 0;
    const off = h.subscribe(() => calls++);
    const s0 = h.state();
    expect(h.state()).toBe(s0);
    h.record(at(0), at(10));
    expect(calls).toBe(1);
    expect(h.state()).not.toBe(s0);
    h.back(at(10));
    expect(calls).toBe(2);
    off();
    h.clear();
    expect(calls).toBe(2);
  });
});

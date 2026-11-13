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

// The docks' sizing rules (cockpit/dock-sizing.ts; editor ADR "Docks are
// resizable and the workspace adapts"): the 240–480 px bounds, the
// defaults a double-click restores, how docked columns give way so the
// canvas keeps its working minimum, and the divider's keys.

import { describe, expect, test } from "bun:test";

import {
  CANVAS_MIN_WORKING_PX,
  DOCK_DEFAULT_PX,
  DOCK_KEY_STEP_LARGE_PX,
  DOCK_KEY_STEP_PX,
  DOCK_MAX_PX,
  DOCK_MIN_PX,
  OVERLAY_GUTTER_PX,
  clampDockWidth,
  dockWidthForKey,
  fitDocks,
  maxDockWidth,
  maxOverlayWidth,
  resolvedDockWidths,
} from "../../src/cockpit/dock-sizing";

describe("dock widths", () => {
  test("the bounds are 240–480 px and the defaults the cockpit's columns", () => {
    expect([DOCK_MIN_PX, DOCK_MAX_PX]).toEqual([240, 480]);
    expect(DOCK_DEFAULT_PX).toEqual({ left: 262, right: 320, form: 340 });
  });

  test("a width is held inside the bounds; a non-number is the default", () => {
    expect(clampDockWidth("right", 100)).toBe(240);
    expect(clampDockWidth("right", 900)).toBe(480);
    expect(clampDockWidth("right", 333.4)).toBe(333);
    expect(clampDockWidth("left", Number.NaN)).toBe(262);
    expect(resolvedDockWidths({ right: 9999 })).toEqual({
      left: 262,
      right: 480,
      form: 340,
    });
  });

  test("docked columns give way, left first, so the canvas keeps its minimum", () => {
    // Room for everything: nothing moves.
    expect(fitDocks(2000, { left: 400, right: 400 })).toEqual({
      left: 400,
      right: 400,
    });
    // 1400 px: 400 + 400 + 640 is 40 px too much — the left dock gives it.
    expect(fitDocks(1400, { left: 400, right: 400 })).toEqual({
      left: 360,
      right: 400,
    });
    // Short of more: the left stops at its minimum, then the right gives.
    expect(fitDocks(1200, { left: 400, right: 400 })).toEqual({
      left: DOCK_MIN_PX,
      right: 1200 - CANVAS_MIN_WORKING_PX - DOCK_MIN_PX,
    });
    // Never below the minimum (the workspace turns them into overlays
    // before this happens, workspace-class.ts).
    expect(fitDocks(1000, { left: 400, right: 400 })).toEqual({
      left: DOCK_MIN_PX,
      right: DOCK_MIN_PX,
    });
    // An unmeasured work area clamps nothing.
    expect(fitDocks(0, { right: 480 })).toEqual({ right: 480 });
  });

  test("the widest a divider may go leaves the canvas its minimum", () => {
    expect(maxDockWidth(1600, 262)).toBe(480);
    expect(maxDockWidth(1200, 262)).toBe(1200 - 262 - CANVAS_MIN_WORKING_PX);
    expect(maxDockWidth(900, 262)).toBe(DOCK_MIN_PX);
    expect(maxDockWidth(0, 0)).toBe(DOCK_MAX_PX);
    expect(maxOverlayWidth(600)).toBe(480);
    expect(maxOverlayWidth(400)).toBe(400 - OVERLAY_GUTTER_PX);
    expect(maxOverlayWidth(200)).toBe(DOCK_MIN_PX);
  });

  test("the arrows move the divider: a left dock grows right, a right dock left", () => {
    const key = (side: "start" | "end", k: string, shift = false) =>
      dockWidthForKey("right", side, 320, k, shift, 480);
    expect(key("end", "ArrowLeft")).toBe(320 + DOCK_KEY_STEP_PX);
    expect(key("end", "ArrowRight")).toBe(320 - DOCK_KEY_STEP_PX);
    expect(key("start", "ArrowRight")).toBe(320 + DOCK_KEY_STEP_PX);
    expect(key("end", "ArrowLeft", true)).toBe(320 + DOCK_KEY_STEP_LARGE_PX);
    expect(key("end", "Home")).toBe(DOCK_MIN_PX);
    expect(key("end", "End")).toBe(480);
    expect(key("end", "Enter")).toBe(DOCK_DEFAULT_PX.right);
    expect(key("end", "a")).toBeNull();
    // Never past the room the canvas leaves.
    expect(dockWidthForKey("right", "end", 400, "End", false, 410)).toBe(410);
    expect(dockWidthForKey("right", "end", 405, "ArrowLeft", false, 410)).toBe(
      410,
    );
  });
});

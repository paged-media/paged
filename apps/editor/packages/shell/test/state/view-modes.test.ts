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

// Editor ADR 287 — the grid overlay's lines, the View menu's snap
// settings, the Guides & Grid preferences and the rotated camera.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  cameraMatrix,
  docToViewport,
  normaliseRotation,
  rotateCameraAbout,
  viewportToDoc,
} from "@paged-media/client";
import { covers, stubGlobal, unstubAllGlobals } from "@paged-media/test-kit";

import { gridPath } from "../../src/overlays/grid-overlay";
import { createEditorScope } from "../../src/state/editor-scope";
import {
  DEFAULT_VIEW_PREFERENCES,
  gridStep,
  resetViewPreferences,
  setViewPreferences,
  subscribeViewPreferences,
  viewPreferences,
} from "../../src/state/view-preferences";
import { snapSettingsOf } from "../../src/state/view-settings-sync";
import { setViewToggle } from "../../src/state/view-toggles";
import { memoryStorage } from "../settings/memory-storage";

beforeEach(() => {
  stubGlobal("localStorage", memoryStorage());
  resetViewPreferences();
});
afterEach(() => {
  unstubAllGlobals();
  resetViewPreferences();
});

describe("Guides & Grid preferences", () => {
  test("defaults, a change persists, a bad value is ignored", () => {
    covers("setting:paged.viewPreferences");
    expect(viewPreferences()).toEqual(DEFAULT_VIEW_PREFERENCES);
    expect(gridStep(viewPreferences())).toBe(9);
    let heard = 0;
    const off = subscribeViewPreferences(() => heard++);
    setViewPreferences({ gridEvery: 36, gridSubdivisions: 4 });
    expect(heard).toBe(1);
    setViewPreferences({ gridEvery: 36 }); // no change
    expect(heard).toBe(1);
    setViewPreferences({ gridSubdivisions: 0, gridColor: "red" });
    expect(viewPreferences().gridSubdivisions).toBe(4);
    expect(viewPreferences().gridColor).toBe(DEFAULT_VIEW_PREFERENCES.gridColor);
    off();
    // A reload reads what was stored.
    resetViewPreferences();
    expect(viewPreferences().gridEvery).toBe(36);
    expect(gridStep(viewPreferences())).toBe(9);
  });

  test("a hand-edited store falls back field by field", () => {
    covers("setting:paged.viewPreferences");
    localStorage.setItem(
      "paged.viewPreferences",
      JSON.stringify({ gridEvery: -3, gridColor: "#112233", spacing: "yes" }),
    );
    resetViewPreferences();
    const p = viewPreferences();
    expect(p.gridEvery).toBe(72);
    expect(p.gridColor).toBe("#112233");
    expect(p.spacing).toBe(true);
  });
});

describe("the snap settings the View menu sends", () => {
  test("toggles and preferences map onto the engine's fields", () => {
    covers(
      "setting:view.snapToGrid",
      "setting:view.snapToPixel",
      "setting:view.smartGuides",
    );
    const scope = createEditorScope();
    const prefs = { ...DEFAULT_VIEW_PREFERENCES, customAngle: 30 };
    const s = snapSettingsOf(scope, prefs);
    expect(s).toMatchObject({
      enabled: true,
      grid: false,
      pixel: false,
      alignment: true,
      gridEvery: 72,
      gridSubdivisions: 8,
      angleGuides: true,
      customAngle: 30,
      spacing: true,
      intersections: true,
      tolerancePx: 4,
    });
    setViewToggle(scope, "snapToGrid", true);
    setViewToggle(scope, "snapToPixel", true);
    setViewToggle(scope, "smartGuides", false);
    const t = snapSettingsOf(scope, DEFAULT_VIEW_PREFERENCES);
    expect(t).toMatchObject({
      grid: true,
      pixel: true,
      alignment: false,
      angleGuides: false,
      spacing: false,
      intersections: false,
    });
    expect("customAngle" in t).toBe(false);
  });
});

describe("the grid overlay's lines", () => {
  const page = { x: 0, y: 100, w: 36, h: 18 };
  test("every step across the page, clipped to the view", () => {
    covers("setting:view.showGrid");
    expect(gridPath(page, 9, null)).toBe(
      "M0 100V118M9 100V118M18 100V118M27 100V118M36 100V118" +
        "M0 100H36M0 109H36M0 118H36",
    );
    // Only what the viewport shows.
    expect(gridPath(page, 9, { x0: 10, y0: 0, x1: 20, y1: 105 })).toBe(
      "M18 100V105M10 100H20",
    );
    // Subdivisions skip the gridlines.
    expect(gridPath(page, 9, null, (k) => k % 2 === 0)).toBe(
      "M9 100V118M27 100V118M0 109H36",
    );
    expect(gridPath(page, 0, null)).toBe("");
  });
});

describe("the rotated camera", () => {
  test("doc → viewport → doc is the identity at any rotation", () => {
    const cam = { scale: 2, tx: 30, ty: -12, rotation: 0.4 };
    const [x, y] = docToViewport(cam, 17, 41);
    const [dx, dy] = viewportToDoc(cam, x, y);
    expect(dx).toBeCloseTo(17, 6);
    expect(dy).toBeCloseTo(41, 6);
    const m = cameraMatrix(cam);
    expect(m[0] * 17 + m[2] * 41 + m[4]).toBeCloseTo(x, 6);
    expect(m[1] * 17 + m[3] * 41 + m[5]).toBeCloseTo(y, 6);
  });

  test("turning about a viewport point keeps the document point under it", () => {
    const cam = { scale: 1.5, tx: 100, ty: 50, rotation: 0 };
    const before = viewportToDoc(cam, 400, 300);
    const turned = rotateCameraAbout(cam, Math.PI / 12, 400, 300);
    expect(turned.rotation).toBeCloseTo(Math.PI / 12, 9);
    const after = viewportToDoc(turned, 400, 300);
    expect(after[0]).toBeCloseTo(before[0], 6);
    expect(after[1]).toBeCloseTo(before[1], 6);
    const back = rotateCameraAbout(turned, -(turned.rotation ?? 0), 400, 300);
    expect(back.rotation).toBe(0);
    expect(back.tx).toBeCloseTo(cam.tx, 6);
    expect(back.ty).toBeCloseTo(cam.ty, 6);
    expect(normaliseRotation(Math.PI * 3)).toBeCloseTo(Math.PI, 9);
    expect(normaliseRotation(-Math.PI * 2)).toBe(0);
  });
});

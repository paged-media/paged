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

// Settings `view.textThreads`, `view.snapToPoints`, `view.headingAnchors`,
// `view.dataMarkers`
// (view-toggles.ts): the View-menu toggles an overlay or a tool reads and
// a command flips. Module-scope and in memory: they survive a dock
// close/reopen, and a reload starts from the defaults.

import { afterEach, describe, expect, test } from "bun:test";

import { covers } from "@paged-media/test-kit";

import {
  getViewToggle,
  resetViewToggles,
  setViewToggle,
  subscribeViewToggles,
  toggleViewToggle,
  type ViewToggle,
} from "../../src/state/view-toggles";
import { createEditorScope } from "../../src/state/editor-scope";

// The toggles are an editor's (plan task E1): each test is a new one.
let scope = createEditorScope();
afterEach(() => {
  scope = createEditorScope();
});

const DEFAULTS: Record<ViewToggle, boolean> = {
  textThreads: false,
  snapToPoints: true,
  headingAnchors: false,
  dataMarkers: false,
};

describe("view toggles", () => {
  test("defaults: threads off, snap to points on, heading anchors and data markers off", () => {
    covers(
      "setting:view.textThreads",
      "setting:view.snapToPoints",
      "setting:view.headingAnchors",
      "setting:view.dataMarkers",
    );
    for (const [k, v] of Object.entries(DEFAULTS))
      expect({ k, v: getViewToggle(scope, k as ViewToggle) }).toEqual({ k, v });
  });

  test("each flag changes alone, and toggling returns the new value", () => {
    covers(
      "setting:view.textThreads",
      "setting:view.snapToPoints",
      "setting:view.headingAnchors",
      "setting:view.dataMarkers",
    );
    for (const k of Object.keys(DEFAULTS) as ViewToggle[]) {
      resetViewToggles(scope);
      expect(toggleViewToggle(scope, k)).toBe(!DEFAULTS[k]);
      for (const other of Object.keys(DEFAULTS) as ViewToggle[]) {
        expect({ k, other, v: getViewToggle(scope, other) }).toEqual({
          k,
          other,
          v: other === k ? !DEFAULTS[k] : DEFAULTS[other],
        });
      }
      expect(toggleViewToggle(scope, k)).toBe(DEFAULTS[k]);
    }
  });

  test("subscribers hear a change, never a no-op, and stop hearing on unsubscribe", () => {
    covers("setting:view.textThreads", "setting:view.snapToPoints");
    let heard = 0;
    const off = subscribeViewToggles(scope, () => heard++);
    setViewToggle(scope, "textThreads", false); // already false
    expect(heard).toBe(0);
    setViewToggle(scope, "textThreads", true);
    expect(heard).toBe(1);
    toggleViewToggle(scope, "snapToPoints");
    expect(heard).toBe(2);
    off();
    toggleViewToggle(scope, "snapToPoints");
    expect(heard).toBe(2);
  });

  test("they are not persisted: a reload starts from the defaults", async () => {
    covers(
      "setting:view.textThreads",
      "setting:view.snapToPoints",
      "setting:view.headingAnchors",
      "setting:view.dataMarkers",
    );
    // A reload mounts a new editor, with a new scope.
    const before = createEditorScope();
    setViewToggle(before, "textThreads", true);
    setViewToggle(before, "snapToPoints", false);
    setViewToggle(before, "headingAnchors", true);
    setViewToggle(before, "dataMarkers", true);
    const after = createEditorScope();
    expect({
      textThreads: getViewToggle(after, "textThreads"),
      snapToPoints: getViewToggle(after, "snapToPoints"),
      headingAnchors: getViewToggle(after, "headingAnchors"),
      dataMarkers: getViewToggle(after, "dataMarkers"),
    }).toEqual(DEFAULTS);
  });

  test("reset restores the defaults and tells subscribers once", () => {
    covers("setting:view.headingAnchors");
    setViewToggle(scope, "headingAnchors", true);
    setViewToggle(scope, "textThreads", true);
    let heard = 0;
    const off = subscribeViewToggles(scope, () => heard++);
    resetViewToggles(scope);
    expect(heard).toBe(1);
    resetViewToggles(scope); // nothing to reset
    expect(heard).toBe(1);
    off();
    expect(getViewToggle(scope, "headingAnchors")).toBe(false);
  });
});

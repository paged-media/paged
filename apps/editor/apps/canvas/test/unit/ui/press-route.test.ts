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

// The canvas's one arbitration decision (the interaction specification's
// §4.1–§4.2, owner precedence at the unit layer of §23.2): each press has
// exactly one route, in the documented order.

import { describe, expect, test } from "bun:test";

import { routePress, type PressFacts } from "../../../src/ui/press-route";

const press = (over: Partial<PressFacts> = {}): PressFacts => ({
  button: 0,
  pointerType: "mouse",
  secondTouch: false,
  overContent: false,
  toolGesture: false,
  legacyAlso: false,
  bundleHandle: false,
  pathEdit: false,
  forcePan: false,
  zoomClick: false,
  touchPans: false,
  tool: "select",
  ...over,
});

describe("routePress", () => {
  test("a plain Selection-tool press is the legacy selection path", () => {
    expect(routePress(press())).toEqual({
      kind: "legacy",
      owner: null,
      adapter: "LegacySelectionAdapter",
    });
  });

  test("a second touch is a pinch, over anything", () => {
    expect(
      routePress(
        press({ pointerType: "touch", secondTouch: true, toolGesture: true }),
      ).kind,
    ).toBe("pinch");
  });

  test("the active context's frame takes its content pointer before a tool", () => {
    const r = routePress(press({ overContent: true, toolGesture: true }));
    expect(r).toMatchObject({ kind: "content", owner: "frame-content" });
  });

  test("a registered tool takes the primary button; the Type tool keeps its click", () => {
    expect(routePress(press({ toolGesture: true })).kind).toBe("tool");
    expect(
      routePress(press({ toolGesture: true, legacyAlso: true, tool: "text" })),
    ).toMatchObject({ kind: "type", owner: "canvas-text" });
  });

  test("the middle button pans whatever tool is in hand", () => {
    expect(
      routePress(press({ button: 1, toolGesture: true, overContent: true })),
    ).toMatchObject({ kind: "camera", owner: "canvas-camera" });
  });

  test("a bundle's handle wins over path edit; both only with the Selection tool", () => {
    expect(routePress(press({ bundleHandle: true, pathEdit: true })).kind).toBe(
      "bundle-handle",
    );
    expect(routePress(press({ pathEdit: true })).kind).toBe("path-edit");
    expect(routePress(press({ bundleHandle: true, tool: "text" })).kind).toBe(
      "legacy",
    );
  });

  test("the Hand, the Zoom tool and a filler's finger are the camera's, not a handle's", () => {
    for (const over of [
      { forcePan: true },
      { zoomClick: true },
      { touchPans: true, pointerType: "touch" },
    ] as const) {
      expect(routePress(press({ ...over, bundleHandle: true })).kind).toBe(
        "camera",
      );
    }
    // A filler's mouse is not a finger.
    expect(routePress(press({ touchPans: true })).kind).toBe("legacy");
  });
});

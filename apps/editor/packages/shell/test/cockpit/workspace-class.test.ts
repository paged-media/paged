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

// The workspace classes (cockpit/workspace-class.ts, UX audit F-55): wide,
// laptop and narrow by the width the cockpit is given, and the camera's
// resize anchor (UXI-CAM-003) the canvas applies when that width changes.

import { describe, expect, test } from "bun:test";

import {
  CANVAS_COMFORT_PX,
  WORKSPACE_LAPTOP_MIN_PX,
  WORKSPACE_WIDE_MIN_PX,
  workspaceClassOf,
} from "../../src/cockpit/workspace-class";
import {
  CANVAS_MIN_WORKING_PX,
  DOCK_DEFAULT_PX,
} from "../../src/cockpit/dock-sizing";
import { cameraKeepingCentre } from "../../src/state/camera-context";
import { viewportToDoc } from "@paged-media/client";

describe("workspace classes", () => {
  test("the thresholds are canvas budgets beside the default docks", () => {
    expect(WORKSPACE_WIDE_MIN_PX).toBe(
      CANVAS_COMFORT_PX + DOCK_DEFAULT_PX.left + DOCK_DEFAULT_PX.right,
    );
    expect(WORKSPACE_LAPTOP_MIN_PX).toBe(
      CANVAS_MIN_WORKING_PX + DOCK_DEFAULT_PX.right,
    );
  });

  test("a full-window editor at 1600 px is wide, 1280 laptop, 1024 narrow", () => {
    // The work area is the window less the tool rail and the panel rail
    // (69 + 65 px): the strategy's ~1600 / ~1100 breakpoints.
    const rails = 134;
    expect(workspaceClassOf(1600 - rails)).toBe("wide");
    expect(workspaceClassOf(1440 - rails)).toBe("laptop");
    expect(workspaceClassOf(1280 - rails)).toBe("laptop");
    expect(workspaceClassOf(1100 - rails)).toBe("laptop");
    expect(workspaceClassOf(1024 - rails)).toBe("narrow");
    expect(workspaceClassOf(800 - rails)).toBe("narrow");
  });

  test("an unmeasured cockpit is wide (the layout it always had)", () => {
    expect(workspaceClassOf(0)).toBe("wide");
    expect(workspaceClassOf(Number.NaN)).toBe("wide");
  });
});

describe("the camera keeps the document point at the viewport's centre on a resize (UXI-CAM-003)", () => {
  const centreDoc = (
    cam: { scale: number; tx: number; ty: number; rotation?: number },
    size: readonly [number, number],
  ) => viewportToDoc(cam, size[0] / 2, size[1] / 2);

  test("a dock that opens narrows the viewport; the centre point stays", () => {
    const cam = { scale: 0.75, tx: 120, ty: -40, rotation: 0 };
    const from = [1200, 800] as const;
    const to = [880, 800] as const;
    const next = cameraKeepingCentre(cam, from, to);
    expect(next.scale).toBe(cam.scale);
    const [x0, y0] = centreDoc(cam, from);
    const [x1, y1] = centreDoc(next, to);
    expect(x1).toBeCloseTo(x0, 9);
    expect(y1).toBeCloseTo(y0, 9);
  });

  test("the same in a turned view, and for a height change", () => {
    const cam = { scale: 2, tx: 10, ty: 20, rotation: Math.PI / 6 };
    const from = [900, 700] as const;
    const to = [1300, 640] as const;
    const next = cameraKeepingCentre(cam, from, to);
    expect(next.rotation).toBe(cam.rotation);
    const [x0, y0] = centreDoc(cam, from);
    const [x1, y1] = centreDoc(next, to);
    expect(x1).toBeCloseTo(x0, 9);
    expect(y1).toBeCloseTo(y0, 9);
  });

  test("a hidden (0) or unchanged size moves nothing", () => {
    const cam = { scale: 1, tx: 5, ty: 6 };
    expect(cameraKeepingCentre(cam, [0, 0], [800, 600])).toBe(cam);
    expect(cameraKeepingCentre(cam, [800, 600], [0, 0])).toBe(cam);
    expect(cameraKeepingCentre(cam, [800, 600], [800, 600])).toBe(cam);
  });
});

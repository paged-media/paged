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

// Extensions ADR 340 — the geometry of an edit context's WORKSPACE: the
// frame the rulers measure in, where its guides lie and the area its grid
// covers. Pure functions over the provider's answer and the page's rect
// in document space, shared by the rulers, the guide overlay, the guide
// drag controller and the grid overlay so they can never disagree about
// where base 0 is.

import type { ShellWorkspace } from "../catalog/binding-providers";

export interface DocRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The workspace's area in document pt. */
export function workspaceDocRect(ws: ShellWorkspace, page: DocRect): DocRect {
  return {
    x: page.x + ws.origin[0],
    y: page.y + ws.origin[1],
    w: ws.size[0] * ws.ptPerBase,
    h: ws.size[1] * ws.ptPerBase,
  };
}

/** Document pt one ruler unit spans. */
export function ptPerRulerUnit(ws: ShellWorkspace): number {
  return ws.ptPerBase * ws.unit.basePerUnit;
}

/** A page-local coordinate on `axis` → base units from the origin. */
export function pageToBase(
  ws: ShellWorkspace,
  axis: "x" | "y",
  pageLocal: number,
): number {
  const o = axis === "x" ? ws.origin[0] : ws.origin[1];
  return (pageLocal - o) / (ws.ptPerBase || 1);
}

/** Base units → a page-local coordinate on `axis`. */
export function baseToPage(
  ws: ShellWorkspace,
  axis: "x" | "y",
  base: number,
): number {
  const o = axis === "x" ? ws.origin[0] : ws.origin[1];
  return o + base * ws.ptPerBase;
}

/** Round a base position to the workspace's guide step (whole pixels by
 *  default). */
export function snapToGuideStep(ws: ShellWorkspace, base: number): number {
  const step = ws.guideStep && ws.guideStep > 0 ? ws.guideStep : 1;
  const v = Math.round(base / step) * step;
  return Object.is(v, -0) ? 0 : v;
}

/** The grid step in base units for a physical "gridline every" (pt). */
export function workspaceGridEvery(
  ws: ShellWorkspace,
  everyPt: number,
): number {
  return everyPt * ws.basePerPoint;
}

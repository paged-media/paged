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

// The precision magnifier's arithmetic (paged.draw ADR 370): which page
// region the loupe shows, where the loupe sits on screen, and where a page
// point lands inside it. Pure, so the rules are tested without a canvas.

/** The loupe's side, CSS px. */
export const MAGNIFIER_SIZE_PX = 148;
/** How much larger than the view the loupe shows the page. */
export const MAGNIFIER_FACTOR = 4;
/** The loupe's distance from the pointer, CSS px (it never covers the
 *  point being placed). */
export const MAGNIFIER_GAP_PX = 28;

/** The tools that place or drag anchors: the magnifier answers the held
 *  key only while one of them is in hand (or path editing is on). */
export const PRECISION_TOOL_IDS: ReadonlySet<string> = new Set([
  "paged.tool.pen",
  "paged.tool.directSelect",
  "media.paged.draw.tool.curvature",
  "media.paged.draw.tool.addAnchor",
  "media.paged.draw.tool.deleteAnchor",
  "media.paged.draw.tool.convertAnchor",
]);

/** The key held for the magnifier: Control (on every platform; it is not
 *  one of the Pen's modifiers — Shift constrains, Alt breaks a handle,
 *  Cmd is Direct Selection and the snap bypass). */
export const MAGNIFIER_KEY = "Control";

export interface PageRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The page region (page pt) the loupe shows around `point`, at the
 *  view's `scale` (CSS px per pt). */
export function magnifierRegion(
  point: readonly [number, number],
  scale: number,
  sizePx = MAGNIFIER_SIZE_PX,
  factor = MAGNIFIER_FACTOR,
): PageRegion {
  const side = sizePx / (Math.max(scale, 1e-6) * factor);
  return {
    x: point[0] - side / 2,
    y: point[1] - side / 2,
    width: side,
    height: side,
  };
}

/** Where the loupe's top-left corner goes (host px): above and to the
 *  right of the pointer, flipped to the other side near an edge, and kept
 *  inside the host. */
export function magnifierPlacement(
  pointer: readonly [number, number],
  host: { width: number; height: number },
  sizePx = MAGNIFIER_SIZE_PX,
  gap = MAGNIFIER_GAP_PX,
): { left: number; top: number } {
  const right = pointer[0] + gap;
  const left = right + sizePx <= host.width ? right : pointer[0] - gap - sizePx;
  const above = pointer[1] - gap - sizePx;
  const top = above >= 0 ? above : pointer[1] + gap;
  return {
    left: Math.max(0, Math.min(left, host.width - sizePx)),
    top: Math.max(0, Math.min(top, host.height - sizePx)),
  };
}

/** Where page point `p` lands in the loupe (CSS px from its top-left),
 *  given the region the image covers. */
export function pointInLoupe(
  p: readonly [number, number],
  region: PageRegion,
  sizePx = MAGNIFIER_SIZE_PX,
): [number, number] {
  return [
    ((p[0] - region.x) / region.width) * sizePx,
    ((p[1] - region.y) / region.height) * sizePx,
  ];
}

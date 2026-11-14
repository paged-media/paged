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

// Semantic zoom (interaction contract UXI-CAM-017; the redesign strategy's
// §4.4; editor ADR "Page lenses and semantic zoom"): the canvas shows
// different amounts of STRUCTURE at different zooms, never different
// content and never another tool. Three tiers by the camera's scale:
//
//   overview  below 15 %: a 72 pt frame is under 11 CSS px, smaller than
//             the handles that would sit on it. Handles, ports, path
//             points, the content grabber and the live-shape widgets are
//             not drawn; the selection's outline, the markers (overset,
//             issues), page names and numbers stay, at their screen size.
//   page      15 % to 400 %: normal editing.
//   detail    from 400 %: precision aids — the rulers draw minor ticks
//             between their labelled marks.
//
// The tiers decide only what the overlay host and the rulers draw: the
// selection, the active tool and the document are the same at every zoom.

/** Below this scale the canvas is an overview. */
export const OVERVIEW_MAX_SCALE = 0.15;
/** From this scale the canvas shows precision aids. */
export const DETAIL_MIN_SCALE = 4;

export type ZoomTier = "overview" | "page" | "detail";

export function zoomTier(scale: number): ZoomTier {
  if (!(scale > 0)) return "page";
  if (scale < OVERVIEW_MAX_SCALE) return "overview";
  if (scale >= DETAIL_MIN_SCALE) return "detail";
  return "page";
}

/** The overlays an overview does not draw: handles and points too big
 *  for what they would sit on. */
export const OVERVIEW_HIDDEN_OVERLAYS: ReadonlySet<string> = new Set([
  "paged.resize-handles",
  "paged.rotate-handle",
  "paged.threading-ports",
  "paged.live-shape-handles",
  "paged.content-grabber",
  "paged.path-edit",
]);

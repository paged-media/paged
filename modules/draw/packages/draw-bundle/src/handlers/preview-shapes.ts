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

// The overlay vocabulary the distortion tools draw with, as pure
// builders over draw-geometry's own shape tables (svg-shapes' `polyToPath`
// / `ellipseToPath` / `mapTable` — nothing is flattened or re-derived
// here): straight runs and outlines as DASHABLE `ToolPreviewPath`s, an
// ellipse (the liquify brush, a pin's rotation ring) as real cubics, a
// small square (a handle, a pin) and an anchor table.

import type { ToolPreviewShape } from "@paged-media/plugin-api";
import {
  contourRanges,
  ellipseToPath,
  mapTable,
  polyToPath,
  type AnchorTable,
  type Vec2,
} from "@paged-media/draw-geometry";

type P = [number, number];

/** Every contour of a page-space table as real cubics. */
export function tableShapes(
  pageId: string,
  table: AnchorTable,
  dashed = true,
): ToolPreviewShape[] {
  return contourRanges(table.anchors.length, table.subpathStarts).map(
    ([from, to], i) => ({
      pageId,
      anchors: table.anchors.slice(from, to).map((a) => ({
        anchor: [a.anchor[0], a.anchor[1]] as P,
        left: [a.left[0], a.left[1]] as P,
        right: [a.right[0], a.right[1]] as P,
      })),
      close: !(table.subpathOpen?.[i] ?? false),
      ...(dashed ? { dashed: true } : {}),
    }),
  );
}

/** A polyline through `points` (closed when `close`). */
export function polyShape(
  pageId: string,
  points: readonly Vec2[],
  options: { close?: boolean; dashed?: boolean } = {},
): ToolPreviewShape {
  return tableShapes(
    pageId,
    polyToPath(points, options.close ?? false),
    options.dashed ?? false,
  )[0]!;
}

/** An ellipse (`rx`, `ry`, turned by `angleDeg` counter-clockwise on
 *  screen, y down) round `centre`. */
export function ellipseShape(
  pageId: string,
  centre: Vec2,
  rx: number,
  ry: number,
  angleDeg = 0,
  options: { dashed?: boolean } = {},
): ToolPreviewShape {
  const a = (-angleDeg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const table = mapTable(
    ellipseToPath(0, 0, Math.max(rx, 1e-3), Math.max(ry, 1e-3)),
    [c, s, -s, c, centre[0], centre[1]],
  );
  return tableShapes(pageId, table, options.dashed ?? false)[0]!;
}

/** A square of half-size `r` round `p` (a handle or a pin). */
export function squareShape(
  pageId: string,
  p: Vec2,
  r: number,
  dashed = false,
): ToolPreviewShape {
  return polyShape(
    pageId,
    [
      [p[0] - r, p[1] - r],
      [p[0] + r, p[1] - r],
      [p[0] + r, p[1] + r],
      [p[0] - r, p[1] + r],
    ],
    { close: true, dashed },
  );
}

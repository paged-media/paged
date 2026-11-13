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

// Editing aid "Baseline grid" (editor ADR "Editing aids and Proof view"):
// the document's baseline grid, from its grid preferences
// (`DocumentMeta.baselineGrid*`: the start, the increment, relative to the
// top of the page or the top margin), drawn across each page as InDesign
// draws it. A document without grid preferences shows InDesign's default
// grid (36 pt start, 12 pt increment, from the top of the page). Off by
// default, as in InDesign; per-frame custom grids are not on the wire and
// are not drawn.

import type { ReactNode } from "react";

import type { PageId } from "@paged-media/client";

import { useCollection, useDocumentMeta } from "../catalog/use-collection";
import type { OverlayContribution, OverlayProps } from "../registries/overlay";

/** InDesign's defaults for a document that declares no grid. */
const DEFAULT_START_PT = 36;
const DEFAULT_DIVISION_PT = 12;
/** Past this many lines a page draws none: the grid would be a fill. */
const MAX_LINES_PER_PAGE = 2000;
/** Lines closer than this on screen read as a grey fill, not a grid:
 *  zoomed that far out the grid is not drawn (semantic zoom, UXI-CAM-017). */
export const BASELINE_GRID_MIN_SPACING_PX = 3;

export interface BaselineGridSettings {
  baselineGridStart?: number | null;
  baselineGridDivision?: number | null;
  baselineGridRelativeTo?: string | null;
}

/** The y of every grid line on a page, page points: from the start
 *  (measured from the top margin when the grid is relative to it) to the
 *  page's bottom, one increment apart. Pure. */
export function baselineGridLines(
  settings: BaselineGridSettings | null,
  pageHeightPt: number,
  marginTopPt = 0,
): number[] {
  const division =
    settings?.baselineGridDivision && settings.baselineGridDivision > 0
      ? settings.baselineGridDivision
      : DEFAULT_DIVISION_PT;
  const start =
    (settings?.baselineGridStart ?? DEFAULT_START_PT) +
    (settings?.baselineGridRelativeTo === "TopMargin" ? marginTopPt : 0);
  const out: number[] = [];
  for (let y = start; y <= pageHeightPt; y += division) {
    if (out.length >= MAX_LINES_PER_PAGE) return [];
    out.push(y);
  }
  return out;
}

interface PageTop {
  selfId: string;
  marginTopPt?: number;
}

function BaselineGridRender(props: OverlayProps) {
  const meta = useDocumentMeta() as BaselineGridSettings | null;
  const pages = useCollection<PageTop>("pages");
  const margins = new Map((pages ?? []).map((p) => [p.selfId, p.marginTopPt]));
  const division =
    meta?.baselineGridDivision && meta.baselineGridDivision > 0
      ? meta.baselineGridDivision
      : DEFAULT_DIVISION_PT;
  if (division * props.camera.scale < BASELINE_GRID_MIN_SPACING_PX)
    return <g data-baseline-grids="too-dense" />;
  const out: ReactNode[] = [];
  for (const [id, r] of props.pageRects) {
    const lines = baselineGridLines(meta, r.h, margins.get(id as string) ?? 0);
    out.push(
      <g key={id} data-baseline-grid={id as PageId}>
        {lines.map((y) => (
          <line
            key={y}
            x1={r.x}
            y1={r.y + y}
            x2={r.x + r.w}
            y2={r.y + y}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </g>,
    );
  }
  return (
    <g
      data-baseline-grids=""
      stroke="var(--overlay-snap)"
      strokeOpacity={0.35}
      strokeWidth={1}
      pointerEvents="none"
    >
      {out}
    </g>
  );
}

export const baselineGridContribution: OverlayContribution = {
  id: "paged.overlay.baselineGrid",
  render: BaselineGridRender,
  // Under the margins (40): the grid is the lowest of the aids.
  z: 35,
};

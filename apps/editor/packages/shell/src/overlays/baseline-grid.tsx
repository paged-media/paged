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
// default, as in InDesign. A text frame with a grid of its own (Text Frame
// Options ▸ Baseline Options ▸ Use Custom Baseline Grid) draws that grid
// across the frame, through its turn, where the engine sets the frame's
// aligned lines (`frameBaselineGrids`, engine ADR 1306), re-read after
// every change to the document.

import { useEffect, useRef, useState, type ReactNode } from "react";

import {
  changesTheDocument,
  type FrameBaselineGrid,
  type PageId,
} from "@paged-media/client";

import { useCollection, useDocumentMeta } from "../catalog/use-collection";
import type { OverlayContribution, OverlayProps } from "../registries/overlay";
import { useCanvasClient } from "../state/canvas-client-context";

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

/** The y of every line of a frame's own grid, in the frame's own
 *  coordinates: from its first line (`start` below the frame's top edge)
 *  to its bottom edge, one `increment` apart. Pure. */
export function frameGridLines(
  grid: Pick<FrameBaselineGrid, "bounds" | "start" | "increment">,
): number[] {
  const [top, , bottom] = grid.bounds as [number, number, number, number];
  if (!(grid.increment > 0)) return [];
  const out: number[] = [];
  for (let y = top + grid.start; y <= bottom + 1e-3; y += grid.increment) {
    if (out.length >= MAX_LINES_PER_PAGE) return [];
    if (y >= top) out.push(y);
  }
  return out;
}

/** The custom grids of the document's text frames, re-read after every
 *  change; null when a read failed or a newer one started. */
async function readFrameGrids(
  client: ReturnType<typeof useCanvasClient>,
  current: () => boolean,
): Promise<FrameBaselineGrid[] | null> {
  try {
    const grids = await client.frameBaselineGrids();
    return current() ? grids : null;
  } catch {
    return null;
  }
}

function FrameGrids(props: OverlayProps) {
  const client = useCanvasClient();
  const [grids, setGrids] = useState<FrameBaselineGrid[]>([]);
  const runRef = useRef(0);
  useEffect(() => {
    const refresh = () => {
      const run = ++runRef.current;
      void readFrameGrids(client, () => run === runRef.current).then((read) => {
        if (read) setGrids(read);
      });
    };
    refresh();
    return client.subscribe((msg) => {
      if (
        changesTheDocument(msg) ||
        (msg.kind === "viewSettingsApplied" && msg.payload.rebuilt === true)
      )
        refresh();
    });
  }, [client]);
  // A frame's own grid in the violet of the other per-object aids, apart
  // from the document grid it stands over.
  return (
    <g
      data-frame-baseline-grids={grids.length}
      stroke="var(--overlay-guide)"
      strokeOpacity={0.5}
    >
      {grids.map((grid) => {
        const page = props.pageRects.get(grid.pageId);
        if (!page) return null;
        if (grid.increment * props.camera.scale < BASELINE_GRID_MIN_SPACING_PX)
          return null;
        const [, left, , right] = grid.bounds as [
          number,
          number,
          number,
          number,
        ];
        const m = grid.itemTransform ?? [1, 0, 0, 1, 0, 0];
        return (
          <g
            key={grid.frameId}
            data-frame-baseline-grid={grid.frameId}
            transform={`translate(${page.x} ${page.y}) matrix(${m.join(" ")})`}
          >
            {frameGridLines(grid).map((y) => (
              <line
                key={y}
                x1={left}
                y1={y}
                x2={right}
                y2={y}
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </g>
        );
      })}
    </g>
  );
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
    return (
      <g
        data-baseline-grids="too-dense"
        stroke="var(--overlay-snap)"
        strokeOpacity={0.35}
        strokeWidth={1}
        pointerEvents="none"
      >
        <FrameGrids {...props} />
      </g>
    );
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
      <FrameGrids {...props} />
    </g>
  );
}

export const baselineGridContribution: OverlayContribution = {
  id: "paged.overlay.baselineGrid",
  render: BaselineGridRender,
  // Under the margins (40): the grid is the lowest of the aids.
  z: 35,
};

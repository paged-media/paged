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

// Margin and column guides: every page's margin box, and the edges of
// its columns' gutters, drawn as InDesign draws them, in the guide
// colour. The values come from the pages collection (the Margins and
// Columns panel writes the same fields), so a change in the panel shows
// on the page at once. Non-printing chrome: Normal screen mode only.

import type { ReactNode } from "react";

import type { PageId } from "@paged-media/client";

import { useCollection } from "../catalog/use-collection";
import type { OverlayContribution, OverlayProps } from "../registries/overlay";
import { useOptionalScreenMode } from "../state/screen-mode-context";

/** The fields of a page summary the guides read. */
export interface PageMargins {
  selfId: string;
  sizePt: [number, number];
  marginTopPt?: number;
  marginLeftPt?: number;
  marginBottomPt?: number;
  marginRightPt?: number;
  columnCount?: number;
  columnGutterPt?: number;
}

/** A page's guides in page points: its margin box (null when every
 *  margin is zero, as on a page made without margins) and the x of every
 *  column edge inside it (both edges of each gutter). Pure. */
export function marginGuides(p: PageMargins): {
  box: { x: number; y: number; w: number; h: number } | null;
  columns: number[];
} {
  const [width, height] = p.sizePt;
  const top = p.marginTopPt ?? 0;
  const left = p.marginLeftPt ?? 0;
  const bottom = p.marginBottomPt ?? 0;
  const right = p.marginRightPt ?? 0;
  const w = width - left - right;
  const h = height - top - bottom;
  const count = Math.max(1, Math.floor(p.columnCount ?? 1));
  const gutter = Math.max(0, p.columnGutterPt ?? 0);
  const hasMargins = top > 0 || left > 0 || bottom > 0 || right > 0;
  if (w <= 0 || h <= 0) return { box: null, columns: [] };
  const columns: number[] = [];
  if (count > 1) {
    const col = (w - gutter * (count - 1)) / count;
    if (col > 0) {
      for (let i = 1; i < count; i++) {
        const edge = left + i * col + (i - 1) * gutter;
        columns.push(edge);
        if (gutter > 0) columns.push(edge + gutter);
      }
    }
  }
  if (!hasMargins && columns.length === 0) return { box: null, columns: [] };
  return { box: { x: left, y: top, w, h }, columns };
}

function MarginGuidesRender(props: OverlayProps) {
  const pages = useCollection<PageMargins>("pages");
  const screenMode = useOptionalScreenMode();
  if (screenMode && screenMode.screenMode !== "normal") return null;
  if (!pages) return null;
  const out: ReactNode[] = [];
  for (const p of pages) {
    const r = props.pageRects.get(p.selfId as PageId);
    if (!r || !p.sizePt) continue;
    const { box, columns } = marginGuides(p);
    if (!box) continue;
    out.push(
      <g
        key={p.selfId}
        data-margin-guides={p.selfId}
        stroke="var(--overlay-guide)"
        strokeOpacity={0.55}
        strokeWidth={1}
        fill="none"
        pointerEvents="none"
      >
        <rect
          x={r.x + box.x}
          y={r.y + box.y}
          width={box.w}
          height={box.h}
          vectorEffect="non-scaling-stroke"
        />
        {columns.map((x) => (
          <line
            key={x}
            data-column-guide=""
            x1={r.x + x}
            y1={r.y + box.y}
            x2={r.x + x}
            y2={r.y + box.y + box.h}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </g>,
    );
  }
  return <>{out}</>;
}

export const marginGuidesContribution: OverlayContribution = {
  id: "paged.margin-guides",
  render: MarginGuidesRender,
  // Under the ruler guides and every selection cue.
  z: 40,
};

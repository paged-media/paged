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

// Proof view's surface (editor ADR "Editing aids and Proof view"; the
// redesign strategy's §4.5): in a proof screen mode the pasteboard is
// masked outside what the publication shows — the trim (Proof view), the
// bleed (Bleed) or the slug (Slug) — and the trim is marked by crop marks
// at its corners. The engine's raster is not the judge of the bleed: the
// CPU lane clips a page at its trim while the GPU lane lets bleed artwork
// run onto the pasteboard, so the mask, not the raster, says where the
// publication ends, and the badge over the canvas says what is shown.
// Mounted by the overlay host only in a proof.

import type { PageId } from "@paged-media/client";

import { useCollection } from "../catalog/use-collection";
import type { OverlayContribution, OverlayProps } from "../registries/overlay";
import { useOptionalScreenMode } from "../state/screen-mode-context";

/** How far the mask reaches past the pages, pt: well past any view. */
const MASK_REACH_PT = 1e6;
/** Crop marks: their length and their offset from the trim, CSS px. */
const MARK_PX = 14;
const MARK_GAP_PX = 4;
/** InDesign's default slug, pt, when a document declares none. */
export const PROOF_SLUG_PT = 0;

export interface PageBleed {
  selfId: string;
  bleedTopPt?: number;
  bleedLeftPt?: number;
  bleedBottomPt?: number;
  bleedRightPt?: number;
}

/** The box a proof shows of a page, in document points: the trim, or
 *  the trim grown by the bleed. */
export function proofBox(
  r: { x: number; y: number; w: number; h: number },
  bleed: PageBleed | undefined,
  withBleed: boolean,
): { x: number; y: number; w: number; h: number } {
  if (!withBleed || !bleed) return r;
  const t = bleed.bleedTopPt ?? 0;
  const l = bleed.bleedLeftPt ?? 0;
  const b = bleed.bleedBottomPt ?? 0;
  const rt = bleed.bleedRightPt ?? 0;
  return { x: r.x - l, y: r.y - t, w: r.w + l + rt, h: r.h + t + b };
}

function ProofSurfaceRender(props: OverlayProps) {
  const mode = useOptionalScreenMode()?.screenMode ?? "preview";
  const pages = useCollection<PageBleed>("pages");
  const byId = new Map((pages ?? []).map((p) => [p.selfId, p]));
  const withBleed = mode === "bleed" || mode === "slug";
  const k = 1 / props.camera.scale;
  // One path: the reach of the canvas, with each page's box cut out
  // (even-odd), so the pasteboard is covered and the pages are not.
  let d = `M ${-MASK_REACH_PT} ${-MASK_REACH_PT} H ${MASK_REACH_PT} V ${MASK_REACH_PT} H ${-MASK_REACH_PT} Z`;
  const marks: string[] = [];
  for (const [id, r] of props.pageRects) {
    const box = proofBox(r, byId.get(id as string), withBleed);
    d += ` M ${box.x} ${box.y} h ${box.w} v ${box.h} h ${-box.w} Z`;
    // Crop marks: two short strokes at each trim corner, off the trim.
    const gap = MARK_GAP_PX * k + (box.x < r.x ? r.x - box.x : 0);
    const len = MARK_PX * k;
    for (const [cx, cy, sx, sy] of [
      [r.x, r.y, -1, -1],
      [r.x + r.w, r.y, 1, -1],
      [r.x + r.w, r.y + r.h, 1, 1],
      [r.x, r.y + r.h, -1, 1],
    ] as const) {
      marks.push(
        `M ${cx + sx * gap} ${cy} h ${sx * len}`,
        `M ${cx} ${cy + sy * gap} v ${sy * len}`,
      );
    }
  }
  return (
    <g data-proof-surface={withBleed ? "bleed" : "trim"} pointerEvents="none">
      <path
        d={d}
        fillRule="evenodd"
        style={{ fill: "var(--canvas-surround)" }}
      />
      <path
        data-proof-crop-marks=""
        d={marks.join(" ")}
        style={{ stroke: "var(--pg-muted-fg)" }}
        strokeWidth={1}
        fill="none"
        vectorEffect="non-scaling-stroke"
      />
      {withBleed &&
        [...props.pageRects].map(([id, r]) => (
          <rect
            key={id}
            data-proof-trim={id as PageId}
            x={r.x}
            y={r.y}
            width={r.w}
            height={r.h}
            fill="none"
            style={{ stroke: "var(--pg-muted-fg)" }}
            strokeOpacity={0.6}
            strokeDasharray={`${3 * k} ${3 * k}`}
            vectorEffect="non-scaling-stroke"
          />
        ))}
    </g>
  );
}

export const proofSurfaceContribution: OverlayContribution = {
  id: "paged.overlay.proofSurface",
  render: ProofSurfaceRender,
  // Over the document, under everything else that still draws.
  z: 5,
};

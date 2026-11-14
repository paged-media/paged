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

// Editing aid "Frame edges" (editor ADR "Editing aids and Proof view"):
// the edge of every page item, selected or not, as InDesign's View ▸
// Extras ▸ Show Frame Edges draws them — so an empty frame or a frame
// with no fill and no stroke can be found on the page. Off by default (a
// clean page reads as the publication; the selection shows its own
// outline). The overlay host mounts it only while the aid is on and the
// view is not a proof, so with it off it issues no wire traffic at all.
//
// The items are each spread's top-level members (the `spreads`
// collection, every page's and the pasteboard's), their bounds and turn
// from one batched `elementGeometry`; re-read after every change the
// engine pushes. Violet, the colour of nonprinting structure, thin and
// faint so it never competes with the selection's magenta.

import { useEffect, useRef, useState } from "react";

import type { ElementGeometryItem, ElementId } from "@paged-media/client";

import type { OverlayContribution, OverlayProps } from "../registries/overlay";
import { useCanvasClient } from "../state/canvas-client-context";

import { applyAffine } from "./affine";

interface SpreadMembers {
  members?: ReadonlyArray<{ id: ElementId; pageId?: string | null }>;
}

/** Every top-level page item's geometry, or null when a read failed or a
 *  newer read started (the overlay draws what it had; a closed document,
 *  a reload). Outside the component: no conditional in a `try` (ADR 229). */
async function readFrames(
  client: ReturnType<typeof useCanvasClient>,
  current: () => boolean,
): Promise<ElementGeometryItem[] | null> {
  try {
    const spreads = await client.collection<SpreadMembers>("spreads");
    if (!current()) return null;
    const ids: ElementId[] = [];
    for (const s of spreads) for (const m of s.members ?? []) ids.push(m.id);
    if (ids.length === 0) return [];
    const items = await client.elementGeometry(ids);
    return current() ? items : null;
  } catch {
    return null;
  }
}

/** The outline of one item, in document points: its four corners through
 *  its transform, moved by its page's place (null off the pages). */
export function frameEdgePoints(
  item: Pick<ElementGeometryItem, "bounds" | "itemTransform">,
  page: { x: number; y: number } | undefined,
): string | null {
  if (!page || item.bounds.length < 4) return null;
  const [top, left, bottom, right] = item.bounds as [
    number,
    number,
    number,
    number,
  ];
  return (
    [
      [left, top],
      [right, top],
      [right, bottom],
      [left, bottom],
    ] as const
  )
    .map(([x, y]) => {
      const [px, py] = applyAffine(item.itemTransform, x, y);
      return `${page.x + px},${page.y + py}`;
    })
    .join(" ");
}

function FrameEdgesRender(props: OverlayProps) {
  const client = useCanvasClient();
  const [items, setItems] = useState<ElementGeometryItem[]>([]);
  const runRef = useRef(0);

  useEffect(() => {
    const refresh = () => {
      const run = ++runRef.current;
      void readFrames(client, () => run === runRef.current).then((read) => {
        if (read) setItems(read);
      });
    };
    refresh();
    return client.subscribe((msg) => {
      if (
        msg.kind === "mutationApplied" ||
        msg.kind === "undoApplied" ||
        msg.kind === "redoApplied" ||
        msg.kind === "documentLoaded"
      )
        refresh();
    });
  }, [client]);

  return (
    <g
      data-frame-edges={items.length}
      stroke="var(--overlay-guide)"
      strokeOpacity={0.5}
      strokeWidth={1}
      fill="none"
      pointerEvents="none"
    >
      {items.map((item) => {
        const page = item.pageId ? props.pageRects.get(item.pageId) : undefined;
        const points = frameEdgePoints(item, page);
        return points ? (
          <polygon
            key={`${item.id.kind}:${String(item.id.id)}`}
            data-frame-edge={String(item.id.id)}
            points={points}
            vectorEffect="non-scaling-stroke"
          />
        ) : null;
      })}
    </g>
  );
}

export const frameEdgesContribution: OverlayContribution = {
  id: "paged.overlay.frameEdges",
  render: FrameEdgesRender,
  // With the margins (40), under the guides (80) and the selection (200).
  z: 45,
};

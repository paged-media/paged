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

// Editing aid "Overset markers" (editor ADR "Editing aids and Proof
// view"): the red plus InDesign shows in the out port of a frame whose
// story runs past it, on EVERY such frame, selected or not. Before, the
// plus showed only on the one selected frame (`threading-ports.tsx`), so a
// story that overflowed on page 47 was invisible from anywhere else. On
// by default. The host mounts it only while the aid is on and the view is
// not a proof.
//
// The overset stories come from the `stories` collection; for each, its
// frame chain's last frame (one `frameChain` per overset story only) and
// that frame's geometry (one batched `elementGeometry`), re-read after
// every change the engine pushes.

import { useEffect, useRef, useState } from "react";

import type { ElementGeometryItem, ElementId } from "@paged-media/client";

import type { OverlayContribution, OverlayProps } from "../registries/overlay";
import { useCanvasClient } from "../state/canvas-client-context";

import { applyAffine } from "./affine";

/** The marker's size, CSS px at any zoom (the port's). */
const MARK_PX = 9;

/** The last frame of every overset story, with its geometry; null when a
 *  read failed or a newer one started. */
async function readOverset(
  client: ReturnType<typeof useCanvasClient>,
  current: () => boolean,
): Promise<ElementGeometryItem[] | null> {
  try {
    const stories = await client.collection<{
      selfId: string;
      overset?: boolean;
    }>("stories");
    if (!current()) return null;
    const last: ElementId[] = [];
    for (const story of stories) {
      if (!story.overset) continue;
      const chain = await client.frameChain(story.selfId);
      if (!current()) return null;
      const end = chain[chain.length - 1];
      if (end) last.push({ kind: "textFrame", id: end.frameId });
    }
    if (last.length === 0) return [];
    const items = await client.elementGeometry(last);
    return current() ? items : null;
  } catch {
    return null;
  }
}

function OversetMarkersRender(props: OverlayProps) {
  const client = useCanvasClient();
  const [frames, setFrames] = useState<ElementGeometryItem[]>([]);
  const runRef = useRef(0);

  useEffect(() => {
    const refresh = () => {
      const run = ++runRef.current;
      void readOverset(client, () => run === runRef.current).then((read) => {
        if (read) setFrames(read);
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

  const k = 1 / props.camera.scale;
  const size = MARK_PX * k;
  return (
    <g data-overset-markers={frames.length} pointerEvents="none">
      {frames.map((item) => {
        const page = item.pageId ? props.pageRects.get(item.pageId) : undefined;
        if (!page || item.bounds.length < 4) return null;
        const [, , bottom, right] = item.bounds as [
          number,
          number,
          number,
          number,
        ];
        const [px, py] = applyAffine(item.itemTransform, right, bottom);
        // Inside the frame's bottom-right corner, where the out port sits.
        const x = page.x + px - size;
        const y = page.y + py - size;
        return (
          <g key={String(item.id.id)} data-overset-marker={String(item.id.id)}>
            <rect
              x={x}
              y={y}
              width={size}
              height={size}
              fill="var(--overlay-target)"
            />
            <path
              d={`M ${x + size / 2} ${y + 2 * k} V ${y + size - 2 * k} M ${x + 2 * k} ${y + size / 2} H ${x + size - 2 * k}`}
              stroke="#ffffff"
              strokeWidth={1.25 * k}
            />
          </g>
        );
      })}
    </g>
  );
}

export const oversetMarkersContribution: OverlayContribution = {
  id: "paged.overlay.oversetMarkers",
  render: OversetMarkersRender,
  // Over the aids, under the selection chrome (200) and its ports (320).
  z: 90,
};

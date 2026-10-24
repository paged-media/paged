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

// WP4.5 — the colour under the cursor. The canvas is an OffscreenCanvas
// the worker owns, so the main thread cannot read its pixels; the
// sampler asks the engine for a snapshot of the page under the pointer
// (drawn as the canvas draws it, markers included), decodes it once and
// reads pixels out of that. A page's snapshot is taken again only after
// an edit names it, so moving the pointer costs no engine work.

import type { CanvasClient, PageId, WorkerToMain } from "@paged-media/client";

import type { Raster } from "./info-readouts";

/** Pixels across the sampled page snapshot: fine enough for a point
 *  colour, small enough to decode in a frame. */
export const SAMPLE_WIDTH_PX = 1200;

export type DecodePng = (png: Uint8Array) => Promise<Raster | null>;

/** The browser decode: a PNG to RGBA through an ImageBitmap. Null where
 *  the platform has neither (a test DOM). */
export const decodePngInBrowser: DecodePng = async (png) => {
  if (
    typeof createImageBitmap !== "function" ||
    typeof OffscreenCanvas === "undefined"
  ) {
    return null;
  }
  const bitmap = await createImageBitmap(
    new Blob([png as BlobPart], { type: "image/png" }),
  );
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
};

export interface PageSampler {
  /** The page's decoded raster (taken on first ask, cached until an edit
   *  names the page). Null when the snapshot or the decode fails. */
  raster(pageId: PageId): Promise<Raster | null>;
  dispose(): void;
}

function changed(msg: WorkerToMain): readonly PageId[] | "all" | null {
  switch (msg.kind) {
    case "mutationApplied":
    case "undoApplied":
    case "redoApplied":
    case "gestureCommitted":
      return msg.payload.pageIds;
    case "documentLoaded":
      return "all";
    default:
      return null;
  }
}

export function createPageSampler(
  client: Pick<CanvasClient, "requestSnapshot" | "subscribe">,
  decode: DecodePng = decodePngInBrowser,
): PageSampler {
  const cache = new Map<PageId, Promise<Raster | null>>();
  const off = client.subscribe((msg) => {
    const pages = changed(msg);
    if (pages === "all") cache.clear();
    else if (pages) for (const id of pages) cache.delete(id);
  });
  return {
    raster(pageId) {
      let hit = cache.get(pageId);
      if (!hit) {
        hit = client
          .requestSnapshot(pageId, SAMPLE_WIDTH_PX, undefined, {
            markers: true,
          })
          .then((snap) => decode(new Uint8Array(snap.pngBytes)))
          .catch(() => null);
        cache.set(pageId, hit);
      }
      return hit;
    },
    dispose() {
      off();
      cache.clear();
    },
  };
}

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

// Comment markers on the slide (ADR 711, amendment 2026-10-25): a small
// square with the author's initials where each open thread sits, as
// PowerPoint marks them, drawn on the host's retained overlay layer
// (`host.overlay.layer`, W-20; data only, no React). A thread with no
// position, or anchored to a shape with none, is the slide's: its marker
// stacks in the slide's top-left corner. Resolved threads are not marked,
// as in PowerPoint. Only the active slide is marked.

import type { BundleHost, ToolPreviewShape } from "@paged-media/plugin-api";

import type { CommentsStore, SlideComment } from "./comments-model.js";
import type { SlidesStore } from "./slides-model.js";

/** The marker's size and the corner stack's step, pt. */
const SIZE = 18;
const STEP = 22;
const INSET = 8;

/** The shapes that mark `comments` on `pageId`. */
export function markerShapes(
  pageId: string,
  comments: readonly SlideComment[],
): ToolPreviewShape[] {
  const out: ToolPreviewShape[] = [];
  let stacked = 0;
  for (const c of comments) {
    if (c.status === "resolved" || c.status === "closed") continue;
    let x = c.x;
    let y = c.y;
    if (x === null || y === null) {
      x = INSET;
      y = INSET + STEP * stacked++;
    }
    out.push({ pageId, rect: [y, x, y + SIZE, x + SIZE] });
    out.push({
      kind: "text",
      pageId,
      x: x + SIZE / 2,
      y: y + SIZE * 0.7,
      text: c.initials || "•",
      anchor: "middle",
      background: true,
    });
  }
  return out;
}

/** Keep the active slide's markers on the canvas; null when the host draws
 *  no overlay layers. */
export function contributeCommentMarkers(
  host: BundleHost,
  slides: SlidesStore,
  comments: CommentsStore,
): { dispose(): void } | null {
  if (!host.supports("overlay.layers@1")) return null;
  const layer = host.overlay.layer("media.paged.slide.comments");
  const paint = () => {
    const page = slides.isDeck() ? slides.activePage() : null;
    if (!page) {
      layer.clear();
      return;
    }
    layer.set(markerShapes(page, comments.forPage(page)));
  };
  const offSlides = slides.subscribe(paint);
  const offComments = comments.subscribe(paint);
  paint();
  return {
    dispose() {
      offSlides();
      offComments();
      layer.dispose();
    },
  };
}

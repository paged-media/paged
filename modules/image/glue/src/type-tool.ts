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

// The TYPE tool (WP5.10): Photoshop's horizontal type tool on the image.
//
// - A CLICK on empty canvas makes a POINT type layer whose first baseline
//   starts at the click; a DRAG makes PARAGRAPH type in the dragged box.
// - A click on an existing TYPE layer's text opens its editing session.
// Either way the text is then typed in the on-canvas overlay
// (`type-overlay.tsx`), laid out by the engine, and each editing session
// is one undo step. The type of before — glyphs painted straight into the
// active layer — is Type ▸ Paint text into layer.

import type {
  BundleHost,
  CanvasPointerEvent,
  DeactivateReason,
  PagedEditor,
  GestureHandler,
} from "@paged-media/plugin-api";

import { pageToImage, resolveFrameFit, type FitTransform } from "./frame-fit";
import type { ImageSession } from "./session";
import { hitsType } from "./type-layer";

/** Below this many image px a drag is a click. */
export const TYPE_DRAG_PX = 4;

export function makeTypeGesture(
  host: BundleHost,
  session: ImageSession,
): GestureHandler {
  let fit: FitTransform | null = null;
  let down: [number, number] | null = null;

  const ensureFit = async () => {
    fit = await resolveFrameFit(host, session.state().source, "type tool");
  };

  return {
    onActivate(_paged: PagedEditor) {
      void ensureFit();
    },

    onDeactivate(_reason: DeactivateReason) {
      fit = null;
      down = null;
      session.endTypeEdit();
    },

    onPointerDown(e: CanvasPointerEvent) {
      if (!e.pagePoint || !fit) return;
      down = pageToImage(fit, e.pagePoint);
    },

    onPointerMove(_e: CanvasPointerEvent) {},

    onPointerUp(e: CanvasPointerEvent) {
      const start = down;
      down = null;
      if (!start || !e.pagePoint || !fit) return;
      const end = pageToImage(fit, e.pagePoint);
      void typeAt(session, start, end);
    },
  };
}

/** What a type-tool click or drag from `start` to `end` (image px) does. */
export async function typeAt(
  session: ImageSession,
  start: [number, number],
  end: [number, number],
): Promise<number | null> {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  if (Math.hypot(dx, dy) >= TYPE_DRAG_PX) {
    session.endTypeEdit();
    return session.addTypeLayer({
      kind: "box",
      x: Math.min(start[0], end[0]),
      y: Math.min(start[1], end[1]),
      width: Math.max(1, Math.abs(dx)),
      height: Math.max(1, Math.abs(dy)),
    });
  }
  // A click on a type layer's text edits it (the topmost first).
  const rows = [...session.state().layers.layers].reverse();
  for (const row of rows) {
    if (row.kind !== "type" || !row.visible) continue;
    const src = session.typeLayerSource(row.index);
    if (src && hitsType(src, start[0], start[1])) {
      session.setActiveLayer(row.index);
      session.beginTypeEdit(row.index);
      return row.index;
    }
  }
  session.endTypeEdit();
  return session.addTypeLayer({ kind: "point", x: start[0], y: start[1] });
}

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

// What is under a dragged file (editor ADR 1205): the empty canvas, a
// page, the pasteboard, or a frame, by the engine's own hit test at the
// pointer, so the frame the label names is the frame that takes the
// picture. Also the frame's outline on screen for the ghost overlay.

import { docToViewport, viewportToDoc } from "@paged-media/client";

import { layoutPageRects } from "../cockpit/canvas-frame/page-layout";
import { queryEditor } from "./editor-dom";
import { editorRootOf } from "./editor-root";
import type { DropTarget } from "./drop-intent";
import type { PagedEditor } from "./paged-editor";

const VIEWPORT = "[data-paged-viewport]";

/** Frames a picture can fill. */
const GRAPHIC = new Set(["rectangle", "oval", "polygon"]);

export interface ResolvedDropTarget {
  readonly target: DropTarget;
  /** The hit frame's box on screen (client pixels), when there is one. */
  readonly frame: {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  } | null;
}

/** The target under the client point `(clientX, clientY)` of `editor`'s
 *  canvas. */
export async function dropTargetAt(
  editor: PagedEditor,
  clientX: number,
  clientY: number,
): Promise<ResolvedDropTarget> {
  const handle = editor.document.handle;
  if (!handle || handle.pageCount === 0)
    return { target: { kind: "empty" }, frame: null };
  const viewport = queryEditor(editorRootOf(editor.scope), VIEWPORT);
  const camera = editor.camera.camera;
  if (!viewport || !(camera.scale > 0))
    return { target: { kind: "pasteboard" }, frame: null };
  const box = viewport.getBoundingClientRect();
  const [x, y] = viewportToDoc(camera, clientX - box.left, clientY - box.top);
  const rects = layoutPageRects(handle.pageSizesPt, handle.pageOriginsPt);
  const i = rects.findIndex(
    (r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h,
  );
  const page = rects[i];
  const pageId = handle.pageIds[i];
  if (!page || !pageId) return { target: { kind: "pasteboard" }, frame: null };
  const reply = await editor.client
    .send({
      kind: "hitTest",
      payload: { pageId, docPoint: [x - page.x, y - page.y], filter: "any" },
    })
    .catch(() => null);
  const element =
    reply?.kind === "hitResult" ? (reply.payload.element ?? null) : null;
  if (!element || typeof element.id !== "string")
    return { target: { kind: "page", pageId }, frame: null };
  const graphic = GRAPHIC.has(element.kind);
  let hasImage = false;
  if (graphic) {
    const [geometry] = await editor.client
      .elementGeometry([element])
      .catch(() => []);
    hasImage = geometry?.hasImage === true;
  }
  const bounds = reply?.kind === "hitResult" ? reply.payload.frameBounds : null;
  let frame: ResolvedDropTarget["frame"] = null;
  if (bounds) {
    // Page-local [top, left, bottom, right] → client pixels.
    const [left, top] = docToViewport(
      camera,
      page.x + bounds.left,
      page.y + bounds.top,
    );
    const [right, bottom] = docToViewport(
      camera,
      page.x + bounds.right,
      page.y + bounds.bottom,
    );
    frame = {
      left: box.left + Math.min(left, right),
      top: box.top + Math.min(top, bottom),
      width: Math.abs(right - left),
      height: Math.abs(bottom - top),
    };
  }
  return {
    target: {
      kind: "frame",
      element: { kind: element.kind, id: element.id },
      pageId,
      graphic,
      hasImage,
      locked: false,
    },
    frame,
  };
}

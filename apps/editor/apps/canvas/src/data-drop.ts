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

// Editor ADR 291, drag to place: a field header dragged out of the Data
// panel and dropped on the document. The drop point is hit-tested like the
// context menu's right-click (the page under it, then the engine's
// `hitTest`); the item it lands on is handed to the data service, which
// places the field there (a variable in a text frame's story, a graphic
// frame's picture) or says why it cannot.

import { viewportToDoc } from "@paged-media/client";
import type { DataPlaced, DataService } from "@paged-media/plugin-api";
import {
  editorRootOf,
  queryEditor,
  scopeOf,
  type DataFieldDrag,
  type PagedEditor,
} from "@paged-media/shell";
import { defineMessages, t } from "@paged-media/strings";

import { layoutPages } from "./ui/layout";

export const DATA_DROP_MESSAGES = defineMessages("app.dataDrop", {
  noItem: "drop it on a text or graphic frame",
  noService: "no module serves the document's data",
  placeFailed: "Could not place {field}: {reason}",
});

/** The page item under a client point, as an address (`textFrame:u12`). */
export async function itemUnder(
  paged: PagedEditor,
  clientX: number,
  clientY: number,
): Promise<string | null> {
  const viewport = queryEditor(
    editorRootOf(scopeOf(paged)),
    "[data-paged-viewport]",
  );
  const handle = paged.document.handle;
  const cam = paged.camera.camera;
  if (!viewport || !handle || handle.pageIds.length === 0 || !(cam.scale > 0))
    return null;
  const r = viewport.getBoundingClientRect();
  const [x, y] = viewportToDoc(cam, clientX - r.left, clientY - r.top);
  const rects = layoutPages(handle.pageSizesPt);
  const i = rects.findIndex(
    (p) => x >= p.x && x <= p.x + p.w && y >= p.y && y <= p.y + p.h,
  );
  if (i < 0) return null;
  const reply = await paged.client.send({
    kind: "hitTest",
    payload: {
      pageId: handle.pageIds[i],
      docPoint: [x - rects[i].x, y - rects[i].y],
      filter: "any",
    },
  });
  if (reply.kind !== "hitResult") return null;
  const element = reply.payload.element;
  return element ? `${element.kind}:${String(element.id)}` : null;
}

/** Place a dropped field: what was placed, or the reason it was not. */
export async function placeDroppedField(
  paged: PagedEditor,
  service: DataService | null,
  drag: DataFieldDrag,
  at: { clientX: number; clientY: number },
): Promise<DataPlaced | { error: string }> {
  const M = DATA_DROP_MESSAGES;
  const fail = (reason: string) => ({
    error: t(M.placeFailed, { field: drag.field, reason }),
  });
  if (!service?.place) return fail(t(M.noService));
  const target = await itemUnder(paged, at.clientX, at.clientY);
  if (!target) return fail(t(M.noItem));
  try {
    return await service.place(target, drag.query, drag.field);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

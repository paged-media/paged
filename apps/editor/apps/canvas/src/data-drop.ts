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

// Editor ADR 291, drag to place: a field header, a table tab or a grid row
// dragged out of the Data panel and dropped on the document. The drop point
// is hit-tested like the context menu's right-click (the page under it,
// then the engine's `hitTest`); the item it lands on is handed to the data
// service, which places the field there (a variable in a text frame's
// story, a graphic frame's picture), the table in the text frame, or fills
// the design with the record — or says why it cannot. A record fills the
// group under the point when there is one (the group a click selects: the
// outermost), else the item.

import { viewportToDoc } from "@paged-media/client";
import type { DataPlaced, DataService } from "@paged-media/plugin-api";
import {
  editorRootOf,
  queryEditor,
  scopeOf,
  type DataDrop,
  type PagedEditor,
} from "@paged-media/shell";
import { defineMessages, t } from "@paged-media/strings";

import { layoutPages } from "./ui/layout";

export const DATA_DROP_MESSAGES = defineMessages("app.dataDrop", {
  noItem: "drop it on a text or graphic frame",
  noFrame: "drop it on a text frame",
  noDesign: "drop it on a group or a frame",
  noService: "no module serves the document's data",
  placeFailed: "Could not place {field}: {reason}",
  tableFailed: "Could not place {query} as a table: {reason}",
  recordFailed: "Could not fill the design with record {record}: {reason}",
});

/** What lies under a client point: the page item (`textFrame:u12`) and the
 *  outermost group holding it (`group:u40`), when there is one. */
export async function hitUnder(
  paged: PagedEditor,
  clientX: number,
  clientY: number,
): Promise<{ item: string; group: string | null } | null> {
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
  const rects = layoutPages(handle.pageSizesPt, handle.pageOriginsPt);
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
  if (!element) return null;
  const chain = reply.payload.groupChain ?? [];
  return {
    item: `${element.kind}:${String(element.id)}`,
    group: chain.length > 0 ? `group:${chain[0]}` : null,
  };
}

/** The page item under a client point, as an address (`textFrame:u12`). */
export async function itemUnder(
  paged: PagedEditor,
  clientX: number,
  clientY: number,
): Promise<string | null> {
  return (await hitUnder(paged, clientX, clientY))?.item ?? null;
}

const reasonOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Place a dropped field, table or record: what was placed, or the reason
 *  it was not. */
export async function placeDropped(
  paged: PagedEditor,
  service: DataService | null,
  drop: DataDrop,
  at: { clientX: number; clientY: number },
): Promise<DataPlaced | readonly DataPlaced[] | { error: string }> {
  const M = DATA_DROP_MESSAGES;
  const fail = (reason: string) => ({
    error:
      drop.kind === "field"
        ? t(M.placeFailed, { field: drop.field, reason })
        : drop.kind === "table"
          ? t(M.tableFailed, { query: drop.query, reason })
          : t(M.recordFailed, { record: drop.record + 1, reason }),
  });
  const can =
    drop.kind === "field"
      ? !!service?.place
      : drop.kind === "table"
        ? !!service?.placeTable
        : !!service?.placeRecord;
  if (!service || !can) return fail(t(M.noService));
  const hit = await hitUnder(paged, at.clientX, at.clientY);
  if (!hit)
    return fail(
      t(
        drop.kind === "field"
          ? M.noItem
          : drop.kind === "table"
            ? M.noFrame
            : M.noDesign,
      ),
    );
  try {
    if (drop.kind === "field")
      return await service.place!(hit.item, drop.query, drop.field);
    if (drop.kind === "table")
      return await service.placeTable!(hit.item, drop.query, drop.fields);
    return await service.placeRecord!(
      hit.group ?? hit.item,
      drop.query,
      drop.record,
    );
  } catch (e) {
    return fail(reasonOf(e));
  }
}

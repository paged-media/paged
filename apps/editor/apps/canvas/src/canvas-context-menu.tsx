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

// The canvas context menu's rows and doors (ADR 232, UX audit F-27).
//
// A right-click on the canvas opens the menu at the pointer instead of the
// browser's page menu. As in InDesign, the click selects what it lands on
// first when that is not already selected, so the menu acts on the item
// under the pointer; a click on empty canvas keeps the selection. Shift+F10
// and the context-menu key open it from the keyboard (the command
// `paged.edit.contextMenu`), at the selection's centre or the view's.
//
// The rows are commands — the clipboard, Arrange, Group, Lock and Hide
// (F-41), Delete, Select all — each greyed by its own `when`.

import { useEffect, useLayoutEffect, useRef } from "react";

import {
  CanvasContextMenu,
  openCanvasContextMenu,
  scopeOf,
  usePaged,
  type CommandContribution,
  type ContextMenuEntry,
  type KeybindingContribution,
  type PagedEditor,
} from "@paged-media/shell";
import { docToViewport, viewportToDoc } from "@paged-media/client";

import {
  PAGED_EDIT_COPY,
  PAGED_EDIT_CUT,
  PAGED_EDIT_DUPLICATE,
  PAGED_EDIT_PASTE,
  PAGED_EDIT_PASTE_IN_PLACE,
} from "./clipboard-commands";
import {
  PAGED_OBJECT_BRING_FORWARD,
  PAGED_OBJECT_BRING_TO_FRONT,
  PAGED_OBJECT_DELETE,
  PAGED_OBJECT_GROUP,
  PAGED_OBJECT_HIDE,
  PAGED_OBJECT_LOCK,
  PAGED_OBJECT_SEND_BACKWARD,
  PAGED_OBJECT_SEND_TO_BACK,
  PAGED_OBJECT_UNGROUP,
} from "./object-commands";
import { PAGED_EDIT_SELECT_ALL } from "./select-all";
import { layoutPages } from "./ui/layout";
import { defineMessages, t } from "@paged-media/strings";

const M = defineMessages("app.canvasContextMenu", {
  showContextMenu: "Show context menu",
});

export const PAGED_EDIT_CONTEXT_MENU = "paged.edit.contextMenu";

/** The rows, InDesign's object context menu in our command set. */
export const CANVAS_CONTEXT_MENU: readonly ContextMenuEntry[] = [
  { command: PAGED_EDIT_CUT, group: "clipboard" },
  { command: PAGED_EDIT_COPY, group: "clipboard" },
  { command: PAGED_EDIT_PASTE, group: "clipboard" },
  { command: PAGED_EDIT_PASTE_IN_PLACE, group: "clipboard" },
  { command: PAGED_EDIT_DUPLICATE, group: "duplicate" },
  { command: PAGED_OBJECT_BRING_TO_FRONT, group: "arrange" },
  { command: PAGED_OBJECT_BRING_FORWARD, group: "arrange" },
  { command: PAGED_OBJECT_SEND_BACKWARD, group: "arrange" },
  { command: PAGED_OBJECT_SEND_TO_BACK, group: "arrange" },
  { command: PAGED_OBJECT_GROUP, group: "group" },
  { command: PAGED_OBJECT_UNGROUP, group: "group" },
  { command: PAGED_OBJECT_LOCK, group: "lock" },
  { command: PAGED_OBJECT_HIDE, group: "lock" },
  { command: PAGED_OBJECT_DELETE, group: "delete" },
  { command: PAGED_EDIT_SELECT_ALL, group: "select" },
];

const VIEWPORT = "[data-paged-viewport]";

/** Select the page item under a client point unless it is selected. */
async function selectUnder(
  paged: PagedEditor,
  viewport: Element,
  clientX: number,
  clientY: number,
): Promise<void> {
  const handle = paged.document.handle;
  const cam = paged.camera.camera;
  if (!handle || handle.pageIds.length === 0 || !(cam.scale > 0)) return;
  const r = viewport.getBoundingClientRect();
  const [x, y] = viewportToDoc(cam, clientX - r.left, clientY - r.top);
  const rects = layoutPages(handle.pageSizesPt);
  const i = rects.findIndex(
    (p) => x >= p.x && x <= p.x + p.w && y >= p.y && y <= p.y + p.h,
  );
  if (i < 0) return;
  const reply = await paged.client.send({
    kind: "hitTest",
    payload: {
      pageId: handle.pageIds[i],
      docPoint: [x - rects[i].x, y - rects[i].y],
      filter: "any",
    },
  });
  if (reply.kind !== "hitResult") return;
  const element = reply.payload.element;
  if (!element) return;
  const key = JSON.stringify(element);
  if (paged.selection.elementSelection.some((s) => JSON.stringify(s) === key))
    return;
  const ids = await paged.client.setElementSelection([element], "replace");
  paged.selection.setElementSelection(ids);
  paged.selection.setElementGeometry(await paged.client.elementGeometry(ids));
}

/** Where the keyboard opens the menu: the selection's centre on screen,
 *  else the view's. */
function keyboardPoint(paged: PagedEditor): [number, number] {
  const viewport = document.querySelector(VIEWPORT);
  const r = viewport?.getBoundingClientRect();
  if (!r) return [window.innerWidth / 2, window.innerHeight / 2];
  const geo = paged.selection.elementGeometry;
  const handle = paged.document.handle;
  if (geo.length > 0 && handle) {
    const rects = layoutPages(handle.pageSizesPt);
    const g = geo[0] as unknown as {
      pageId: string;
      bounds: [number, number, number, number];
    };
    const i = handle.pageIds.indexOf(g.pageId);
    if (i >= 0) {
      const [vx, vy] = docToViewport(
        paged.camera.camera,
        rects[i].x + (g.bounds[1] + g.bounds[3]) / 2,
        rects[i].y + (g.bounds[0] + g.bounds[2]) / 2,
      );
      return [r.left + vx, r.top + vy];
    }
  }
  return [r.left + r.width / 2, r.top + r.height / 2];
}

export const CANVAS_CONTEXT_MENU_COMMAND: CommandContribution = {
  id: PAGED_EDIT_CONTEXT_MENU,
  get title() {
    return t(M.showContextMenu);
  },
  category: "Edit",
  handler: (paged) => {
    const [x, y] = keyboardPoint(paged as PagedEditor);
    openCanvasContextMenu(scopeOf(paged), x, y);
  },
};

export const CANVAS_CONTEXT_MENU_KEYBINDINGS: KeybindingContribution[] = [
  { key: "shift+f10", command: PAGED_EDIT_CONTEXT_MENU },
  { key: "contextmenu", command: PAGED_EDIT_CONTEXT_MENU },
];

/** The right-click door and the menu itself. Render inside PagedShell. */
export function CanvasContextMenuHost() {
  const paged = usePaged();
  // The live editor for the document listener (ADR 229: written in a
  // layout effect, read in the event).
  const pagedRef = useRef(paged);
  useLayoutEffect(() => {
    pagedRef.current = paged;
  });
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      const target = e.target as Element | null;
      const viewport = target?.closest?.(VIEWPORT);
      if (!viewport) return;
      e.preventDefault();
      const { clientX, clientY } = e;
      void selectUnder(pagedRef.current, viewport, clientX, clientY)
        .catch(() => undefined)
        .then(() =>
          openCanvasContextMenu(pagedRef.current.scope, clientX, clientY),
        );
    };
    document.addEventListener("contextmenu", onContextMenu, true);
    return () =>
      document.removeEventListener("contextmenu", onContextMenu, true);
  }, []);
  return <CanvasContextMenu entries={CANVAS_CONTEXT_MENU} />;
}

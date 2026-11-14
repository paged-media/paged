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

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  CANVAS_POINTER,
  CONTEXT_MENU_ROOT,
  CanvasContextMenu,
  FRAME_SURFACE_ATTR,
  editorRootOf,
  isEnabled,
  openCanvasContextMenu,
  ownsEvent,
  queryEditor,
  interactionCoordinatorOf,
  scopeOf,
  usePaged,
  type CommandContribution,
  type ContextMenuEntry,
  type KeybindingContribution,
  type PagedEditor,
  type PickableObject,
  nextAbove,
  nextBelow,
  objectsOver,
  objectsUnder,
} from "@paged-media/shell";
import { transformBounds, type Affine } from "@paged-media/helpers";
import {
  docToViewport,
  viewportToDoc,
  type ElementId,
} from "@paged-media/client";

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
  selectBelow: "Select next object below",
  selectAbove: "Select next object above",
  rectangle: "Rectangle",
  oval: "Ellipse",
  polygon: "Polygon",
  line: "Line",
  textFrame: "Text frame",
  group: "Group",
  item: "Item",
});

export const PAGED_EDIT_SELECT_BELOW = "paged.edit.selectBelow";
export const PAGED_EDIT_SELECT_ABOVE = "paged.edit.selectAbove";

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

/** The page and page-local point under a client point, or null. */
function pagePointAt(
  paged: PagedEditor,
  viewport: Element,
  clientX: number,
  clientY: number,
): { pageId: string; point: [number, number] } | null {
  const handle = paged.document.handle;
  const cam = paged.camera.camera;
  if (!handle || handle.pageIds.length === 0 || !(cam.scale > 0)) return null;
  const r = viewport.getBoundingClientRect();
  const [x, y] = viewportToDoc(cam, clientX - r.left, clientY - r.top);
  const rects = layoutPages(handle.pageSizesPt, handle.pageOriginsPt);
  const i = rects.findIndex(
    (p) => x >= p.x && x <= p.x + p.w && y >= p.y && y <= p.y + p.h,
  );
  if (i < 0) return null;
  return {
    pageId: handle.pageIds[i]!,
    point: [x - rects[i]!.x, y - rects[i]!.y],
  };
}

/** What a click selects for a hit (canvas-panel's rule, ADR 235): the
 *  outermost group at the top level, the hit inside the entered group,
 *  the leaf with Direct Selection. */
function clickTarget(
  paged: PagedEditor,
  element: ElementId,
  chain: readonly string[],
): ElementId {
  const activeGroup = paged.selection.activeGroup ?? null;
  const direct = paged.tool.effectiveTool === "paged.tool.directSelect";
  if (direct || (activeGroup !== null && chain.includes(activeGroup)))
    return element;
  return chain.length > 0
    ? ({ kind: "group", id: chain[0] } as ElementId)
    : element;
}

/** Select `ids` and mirror them, as a click does. */
async function selectIds(paged: PagedEditor, ids: ElementId[]): Promise<void> {
  const applied = await paged.client.setElementSelection(ids, "replace");
  paged.selection.setElementSelection(applied);
  paged.selection.setElementGeometry(
    await paged.client.elementGeometry(applied),
  );
}

/** Select the page item under a client point unless it is selected —
 *  promoted to its group as a click would be (IC6). */
async function selectUnder(
  paged: PagedEditor,
  viewport: Element,
  clientX: number,
  clientY: number,
): Promise<void> {
  const at = pagePointAt(paged, viewport, clientX, clientY);
  if (!at) return;
  // IC3 — the menu's answer applies only while no newer press, document or
  // context came first (the interaction specification's UXI-OWN-008).
  const interactions = interactionCoordinatorOf(scopeOf(paged));
  const token = interactions.token("context-menu");
  const reply = await paged.client.send({
    kind: "hitTest",
    payload: { pageId: at.pageId, docPoint: at.point, filter: "any" },
  });
  if (!interactions.confirm(token)) return;
  if (reply.kind !== "hitResult") return;
  const hit = reply.payload.element;
  if (!hit) return;
  const element = clickTarget(paged, hit, reply.payload.groupChain ?? []);
  const key = JSON.stringify(element);
  if (paged.selection.elementSelection.some((s) => JSON.stringify(s) === key))
    return;
  const ids = await paged.client.setElementSelection([element], "replace");
  if (!interactions.confirm(token)) return;
  paged.selection.setElementSelection(ids);
  paged.selection.setElementGeometry(await paged.client.elementGeometry(ids));
}

/** Where the keyboard opens the menu: the selection's centre on screen,
 *  else the view's. */
function keyboardPoint(paged: PagedEditor): [number, number] {
  const viewport = queryEditor(editorRootOf(scopeOf(paged)), VIEWPORT);
  const r = viewport?.getBoundingClientRect();
  if (!r) return [window.innerWidth / 2, window.innerHeight / 2];
  const geo = paged.selection.elementGeometry;
  const handle = paged.document.handle;
  if (geo.length > 0 && handle) {
    const rects = layoutPages(handle.pageSizesPt, handle.pageOriginsPt);
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

type Box = [number, number, number, number];

/** The page-local box around `items` on the first one's page. Pure. */
export function unionBox(
  items: ReadonlyArray<{
    pageId?: string | null;
    bounds: readonly number[];
    itemTransform?: readonly number[] | null;
  }>,
): { pageId: string; box: Box } | null {
  const first = items.find((g) => g.pageId != null);
  if (!first) return null;
  let box: Box | null = null;
  for (const g of items) {
    if (g.pageId !== first.pageId) continue;
    const b = transformBounds(
      [...g.bounds] as Box,
      (g.itemTransform as Affine | null | undefined) ?? null,
    ) as Box;
    box = box
      ? [
          Math.min(box[0], b[0]),
          Math.min(box[1], b[1]),
          Math.max(box[2], b[2]),
          Math.max(box[3], b[3]),
        ]
      : b;
  }
  return box ? { pageId: String(first.pageId), box } : null;
}

/** The stack the cycle steps through, topmost first: the objects under
 *  the pointer when it is over a page (IC6); from the keyboard, with no
 *  pointer on the canvas, the objects that overlap the selection's box
 *  (editor ADR "An accessible object tree", `UXI-A11Y-008`). A pointer off
 *  the pages, or nothing selected and no pointer: nothing to step through. */
async function cycleStack(editor: PagedEditor): Promise<ElementId[]> {
  const group = editor.selection.activeGroup ?? null;
  const pointer = scopeOf(editor).get(CANVAS_POINTER).get();
  if (pointer) {
    if (!pointer.pageId || !pointer.pagePoint) return [];
    return objectsUnder(
      editor.client,
      pointer.pageId,
      pointer.pagePoint,
      group,
    );
  }
  const selection = editor.selection.elementSelection;
  if (selection.length === 0) return [];
  const area = unionBox(await editor.client.elementGeometry([...selection]));
  return area
    ? objectsOver(editor.client, area.pageId as never, area.box, group)
    : [];
}

/** IC6 (`UXI-HIT-006`) — the next object below the selection at the
 *  pointer, wrapping to the topmost: what lies under the topmost item is
 *  reached by the user's explicit choice, never by the default click.
 *  From the keyboard (⌥⌘[) it steps through the objects stacked where the
 *  selection is. */
export const SELECT_BELOW_COMMAND: CommandContribution = {
  id: PAGED_EDIT_SELECT_BELOW,
  get title() {
    return t(M.selectBelow);
  },
  category: "Edit",
  handler: async (paged) => {
    const editor = paged as PagedEditor;
    const next = nextBelow(
      await cycleStack(editor),
      editor.selection.elementSelection,
    );
    if (next) await selectIds(editor, [next]);
  },
};

/** The next object above, wrapping to the bottommost (⌥⌘]). */
export const SELECT_ABOVE_COMMAND: CommandContribution = {
  id: PAGED_EDIT_SELECT_ABOVE,
  get title() {
    return t(M.selectAbove);
  },
  category: "Edit",
  handler: async (paged) => {
    const editor = paged as PagedEditor;
    const next = nextAbove(
      await cycleStack(editor),
      editor.selection.elementSelection,
    );
    if (next) await selectIds(editor, [next]);
  },
};

/** The type of an item, in words (the object picker's rows). */
function kindLabel(kind: string): string {
  switch (kind) {
    case "rectangle":
      return t(M.rectangle);
    case "oval":
      return t(M.oval);
    case "polygon":
      return t(M.polygon);
    case "graphicLine":
      return t(M.line);
    case "textFrame":
      return t(M.textFrame);
    case "group":
      return t(M.group);
    default:
      return t(M.item);
  }
}

/** The objects under a client point, for the picker. */
async function pickablesAt(
  paged: PagedEditor,
  viewport: Element,
  clientX: number,
  clientY: number,
): Promise<PickableObject[]> {
  const at = pagePointAt(paged, viewport, clientX, clientY);
  if (!at) return [];
  const stack = await objectsUnder(
    paged.client,
    at.pageId,
    at.point,
    paged.selection.activeGroup ?? null,
  );
  return stack.map((id, i) => ({
    id,
    label: `${kindLabel(id.kind)} ${i + 1}`,
  }));
}

export const CANVAS_CONTEXT_MENU_KEYBINDINGS: KeybindingContribution[] = [
  { key: "shift+f10", command: PAGED_EDIT_CONTEXT_MENU },
  { key: "contextmenu", command: PAGED_EDIT_CONTEXT_MENU },
];

/** The right-click rows a frame surface's bundle contributed for the active
 *  edit context: menu items under `Context/…` whose `when` holds
 *  (extensions ADR 334). The label is the path's last segment. */
export function frameSurfaceRows(paged: PagedEditor): ContextMenuEntry[] {
  const menus = (
    paged as unknown as {
      registries?: {
        menus?: {
          list(): Array<{
            path: string;
            command: string;
            group?: string;
            order?: number;
            when?: unknown;
          }>;
        };
      };
    }
  ).registries?.menus;
  if (!menus) return [];
  return menus
    .list()
    .filter(
      (m) =>
        m.path.startsWith(`${CONTEXT_MENU_ROOT}/`) &&
        isEnabled(m.when as never, () => paged),
    )
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
    .map((m) => ({
      command: m.command,
      group: m.group ?? "default",
      label: m.path.split("/").filter(Boolean).at(-1),
    }));
}

/** The right-click door and the menu itself. Render inside PagedShell. */
export function CanvasContextMenuHost() {
  const paged = usePaged();
  const [entries, setEntries] =
    useState<readonly ContextMenuEntry[]>(CANVAS_CONTEXT_MENU);
  const [objects, setObjects] = useState<readonly PickableObject[]>([]);
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
      // This editor's viewport only: a page may hold two.
      if (!viewport || !ownsEvent(editorRootOf(scopeOf(pagedRef.current)), e))
        return;
      e.preventDefault();
      const { clientX, clientY } = e;
      // Inside a frame surface: its bundle's rows, and no page-item hit
      // test (the surface already chose what the right-click is about).
      if (target?.closest?.(`[${FRAME_SURFACE_ATTR}]`)) {
        const rows = frameSurfaceRows(pagedRef.current);
        if (rows.length === 0) return;
        setEntries(rows);
        openCanvasContextMenu(scopeOf(pagedRef.current), clientX, clientY);
        return;
      }
      setEntries(CANVAS_CONTEXT_MENU);
      setObjects([]);
      const editor = pagedRef.current;
      void selectUnder(editor, viewport, clientX, clientY)
        .catch(() => undefined)
        .then(() =>
          pickablesAt(editor, viewport, clientX, clientY).catch(() => []),
        )
        .then((picks) => {
          setObjects(picks);
          openCanvasContextMenu(scopeOf(editor), clientX, clientY);
        });
    };
    document.addEventListener("contextmenu", onContextMenu, true);
    return () =>
      document.removeEventListener("contextmenu", onContextMenu, true);
  }, []);
  return (
    <CanvasContextMenu
      entries={entries}
      objects={objects}
      onPick={(id) => void selectIds(pagedRef.current, [id]).catch(() => {})}
    />
  );
}

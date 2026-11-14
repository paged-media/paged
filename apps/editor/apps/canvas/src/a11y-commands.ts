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

// The keyboard's way to the document's objects (editor ADR "An accessible
// object tree"; UXI-A11Y-002, A11Y-006, A11Y-008):
//
//   paged.view.objectTree        Alt+Shift+O — from the canvas to the object
//                                tree (the Tree panel, shown if it was not)
//                                and back. Escape in the tree also returns.
//   paged.object.selectNextBelow Cmd/Ctrl+Alt+[ — the next object below the
//   paged.object.selectNextAbove Cmd/Ctrl+Alt+] — selection, and above it.
//
// THE CYCLE. With a selection, the candidates are the objects that overlap
// the selection's box, top first, as a click would take them (the entered
// group's members inside a group, else the top-level items): the stack a
// pointer cannot reach under the top object. Below steps one down the
// stack and wraps to the top, above one up. With nothing selected, the
// candidates are every object of the page in view, and below starts at the
// top, above at the bottom (InDesign's Select ▸ Next Object Below / Above).
// Each step is a selection change only: no undo step (D-15).

import {
  editorRootOf,
  focusCanvasViewport,
  focusReturnOf,
  queryEditor,
  scopeOf,
  type CommandContribution,
  type KeybindingContribution,
  type MenuItemContribution,
  type PagedEditor,
} from "@paged-media/shell";
import type { ElementId } from "@paged-media/client";
import { transformBounds, type Affine } from "@paged-media/helpers";
import { defineMessages, t } from "@paged-media/strings";

import { currentPageTarget } from "./insert-commands";
import { objectVerbApplies } from "./object-commands";
import { OBJECT_TREE_SURFACE } from "./ui/A11yObjectTree";

const M = defineMessages("app.a11yCommands", {
  objectTree: "Go to object tree",
  selectNextBelow: "Select next object below",
  selectNextAbove: "Select next object above",
});

// The menu leaves (`menu.<label>`).
defineMessages("menu", {
  "Go to object tree": "Go to object tree",
  "Select next object below": "Select next object below",
  "Select next object above": "Select next object above",
});

export const A11Y_TREE_COMMAND = "paged.view.objectTree";
export const SELECT_NEXT_BELOW_COMMAND = "paged.object.selectNextBelow";
export const SELECT_NEXT_ABOVE_COMMAND = "paged.object.selectNextAbove";

/** The panel the object tree docks in. */
export const OBJECT_TREE_PANEL = "paged.tree";

type Box = [number, number, number, number];

const keyOf = (id: ElementId): string =>
  `${id.kind}:${String((id as { id?: unknown }).id)}`;

/** The next candidate: `stack` is top first; `current` the selected one's
 *  place in it, or -1. Wraps both ways. Pure, for the unit test. */
export function nextInStack(
  length: number,
  current: number,
  direction: "below" | "above",
): number {
  if (length === 0) return -1;
  if (current < 0) return direction === "below" ? 0 : length - 1;
  const step = direction === "below" ? 1 : -1;
  return (current + step + length) % length;
}

/** The page-local box around `items` on the first one's page. */
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

/** Step the selection through the objects stacked where it is. */
export async function cycleSelection(
  paged: PagedEditor,
  direction: "below" | "above",
): Promise<ElementId | null> {
  const client = paged.client;
  const selection = paged.selection.elementSelection;
  const group = paged.selection.activeGroup;
  let area: { pageId: string; box: Box } | null = null;
  if (selection.length > 0) {
    area = unionBox(await client.elementGeometry([...selection]));
  } else {
    const target = currentPageTarget(paged);
    if (target)
      area = {
        pageId: String(target.pageId),
        box: [0, 0, target.rect.h, target.rect.w],
      };
  }
  if (!area) return null;
  const stack = await client.marqueeHits(area.pageId as never, area.box, {
    mode: "intersect",
    scope: group
      ? ({ kind: "group", id: group } as never)
      : ({ kind: "document" } as never),
  });
  const current =
    selection.length === 1
      ? stack.findIndex((id) => keyOf(id) === keyOf(selection[0]!))
      : -1;
  const next = stack[nextInStack(stack.length, current, direction)];
  if (!next) return null;
  const applied = await client.setElementSelection([next], "replace");
  paged.selection.setElementSelection(applied);
  paged.selection.setElementGeometry(await client.elementGeometry(applied));
  return next;
}

/** Move focus between the canvas and the object tree. */
async function toggleObjectTree(
  paged: PagedEditor,
  showPanel: (id: string) => unknown,
): Promise<void> {
  const scope = scopeOf(paged);
  const root = editorRootOf(scope);
  const focusReturn = focusReturnOf(scope);
  const find = () =>
    queryEditor<HTMLElement>(root, "[data-object-tree]") ?? null;
  const open = find();
  if (open && open.contains(document.activeElement)) {
    if (!focusReturn.close(OBJECT_TREE_SURFACE)) focusCanvasViewport({ root });
    return;
  }
  focusReturn.open(OBJECT_TREE_SURFACE);
  if (!open) await showPanel(OBJECT_TREE_PANEL);
  // The panel mounts on a later frame when it was not open.
  for (let i = 0; i < 30; i++) {
    const tree = find();
    if (tree) {
      tree.focus({ preventScroll: true });
      return;
    }
    await new Promise((r) => requestAnimationFrame(() => r(null)));
  }
}

export interface A11yCommandDeps {
  /** Show a dock panel (`paged.panel.show.<id>`). */
  showPanel(id: string): unknown;
}

const hasDocument = (state: unknown): boolean =>
  Boolean(
    (state as { document?: { handle?: unknown } | null } | null)?.document
      ?.handle,
  );

/** At the document root, with no caret and no path being edited. */
const cycleApplies = (state: unknown): boolean =>
  hasDocument(state) && objectVerbApplies(state);

export function buildA11yCommands(
  deps: A11yCommandDeps,
): CommandContribution[] {
  return [
    {
      id: A11Y_TREE_COMMAND,
      get title() {
        return t(M.objectTree);
      },
      category: "View",
      when: hasDocument,
      handler: (paged: unknown) =>
        toggleObjectTree(paged as PagedEditor, deps.showPanel),
    },
    {
      id: SELECT_NEXT_BELOW_COMMAND,
      get title() {
        return t(M.selectNextBelow);
      },
      category: "Object",
      when: cycleApplies,
      handler: (paged: unknown) =>
        cycleSelection(paged as PagedEditor, "below"),
    },
    {
      id: SELECT_NEXT_ABOVE_COMMAND,
      get title() {
        return t(M.selectNextAbove);
      },
      category: "Object",
      when: cycleApplies,
      handler: (paged: unknown) =>
        cycleSelection(paged as PagedEditor, "above"),
    },
  ];
}

export const A11Y_MENU_ITEMS: MenuItemContribution[] = [
  {
    path: "View/Go to object tree",
    command: A11Y_TREE_COMMAND,
    order: 52,
    group: "objects",
    when: hasDocument,
  },
  {
    path: "Object/Select next object below",
    command: SELECT_NEXT_BELOW_COMMAND,
    order: 22.1,
    group: "group",
    when: cycleApplies,
  },
  {
    path: "Object/Select next object above",
    command: SELECT_NEXT_ABOVE_COMMAND,
    order: 22.2,
    group: "group",
    when: cycleApplies,
  },
];

/** Alt+Shift+O matches by the physical key (Option changes `key` on a
 *  Mac); the brackets likewise (`codeMatches` in the keybinding registry).
 *  InDesign's Select ▸ Next Object Below / Above are ⌥⌘[ and ⌥⌘]. */
export const A11Y_KEYBINDINGS: KeybindingContribution[] = [
  { key: "alt+shift+o", command: A11Y_TREE_COMMAND },
  { key: "cmd+alt+[", command: SELECT_NEXT_BELOW_COMMAND, when: cycleApplies },
  {
    key: "ctrl+alt+[",
    command: SELECT_NEXT_BELOW_COMMAND,
    when: cycleApplies,
  },
  { key: "cmd+alt+]", command: SELECT_NEXT_ABOVE_COMMAND, when: cycleApplies },
  {
    key: "ctrl+alt+]",
    command: SELECT_NEXT_ABOVE_COMMAND,
    when: cycleApplies,
  },
];

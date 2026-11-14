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
//   paged.edit.selectBelow       Cmd/Ctrl+Alt+[ — the next object below the
//   paged.edit.selectAbove       Cmd/Ctrl+Alt+] — selection, and above it
//                                (IC6's cycle, canvas-context-menu.tsx: under
//                                the pointer when it is over a page; from the
//                                keyboard the objects overlapping the
//                                selection's box).
//                                Object ▸ Select next object below / above.
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
import { defineMessages, t } from "@paged-media/strings";

import {
  PAGED_EDIT_SELECT_ABOVE,
  PAGED_EDIT_SELECT_BELOW,
} from "./canvas-context-menu";
import { objectVerbApplies } from "./object-commands";
import { OBJECT_TREE_SURFACE } from "./ui/A11yObjectTree";

const M = defineMessages("app.a11yCommands", {
  objectTree: "Go to object tree",
});

// The menu leaves (`menu.<label>`).
defineMessages("menu", {
  "Go to object tree": "Go to object tree",
  "Select next object below": "Select next object below",
  "Select next object above": "Select next object above",
});

export const A11Y_TREE_COMMAND = "paged.view.objectTree";
export const SELECT_NEXT_BELOW_COMMAND = PAGED_EDIT_SELECT_BELOW;
export const SELECT_NEXT_ABOVE_COMMAND = PAGED_EDIT_SELECT_ABOVE;

/** The panel the object tree docks in. */
export const OBJECT_TREE_PANEL = "paged.tree";

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

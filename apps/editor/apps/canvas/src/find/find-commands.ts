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

// Editor ADR 303 — Find & Replace, the commands: Edit ▸ Find… (the
// results panel's search field), Find and replace… (the dialog), Find
// next / previous, Go to page…, with the host's keys. A host feature for
// every text document — InDesign's Find/Change as much as Word's — so a
// content type's scoped keys (paged.doc's Cmd+F / Cmd+H / Cmd+G) name
// these command ids rather than owning a find of their own.

import {
  cockpitActionsOf,
  scopeOf,
  type CommandContribution,
  type KeybindingContribution,
  type MenuItemContribution,
  type PagedEditor,
} from "@paged-media/shell";
import { defineMessages, t } from "@paged-media/strings";

import { findStoreOf, findNext, patchFind } from "./find-state";
import { FIND_RESULTS_PANEL, findDepsOf } from "./find-ui";

const M = defineMessages("app.findCommands", {
  find: "Find…",
  replace: "Find and replace…",
  findNext: "Find next",
  findPrevious: "Find previous",
  goTo: "Go to page…",
});

defineMessages("menu", {
  "Find…": "Find…",
  "Find and replace…": "Find and replace…",
  "Find next": "Find next",
  "Find previous": "Find previous",
  "Go to page…": "Go to page…",
});

export const PAGED_EDIT_FIND = "paged.edit.find";
export const PAGED_EDIT_REPLACE = "paged.edit.replace";
export const PAGED_EDIT_FIND_NEXT = "paged.edit.findNext";
export const PAGED_EDIT_FIND_PREVIOUS = "paged.edit.findPrevious";
export const PAGED_EDIT_GO_TO = "paged.edit.goTo";

const hasDocument = (state: unknown): boolean => {
  const s = state as {
    document?: { handle?: { pageCount?: number } | null } | null;
  } | null;
  return (s?.document?.handle?.pageCount ?? 0) > 0;
};

/** Open the results panel with its search field focused. */
export function openFind(paged: PagedEditor): void {
  const scope = scopeOf(paged);
  const store = findStoreOf(scope);
  cockpitActionsOf(scope).openPanel?.(FIND_RESULTS_PANEL);
  patchFind(store, { focusSearch: store.get().focusSearch + 1 });
}

export const FIND_COMMANDS: CommandContribution[] = [
  {
    id: PAGED_EDIT_FIND,
    get title() {
      return t(M.find);
    },
    category: "Edit",
    when: hasDocument,
    handler: (paged) => openFind(paged as PagedEditor),
  },
  {
    id: PAGED_EDIT_REPLACE,
    get title() {
      return t(M.replace);
    },
    category: "Edit",
    when: hasDocument,
    handler: (paged) =>
      patchFind(findStoreOf(scopeOf(paged)), { dialog: true, goTo: false }),
  },
  {
    id: PAGED_EDIT_FIND_NEXT,
    get title() {
      return t(M.findNext);
    },
    category: "Edit",
    when: hasDocument,
    handler: (paged) => {
      const scope = scopeOf(paged);
      return findNext(
        findDepsOf(paged as PagedEditor, scope),
        findStoreOf(scope),
      );
    },
  },
  {
    id: PAGED_EDIT_FIND_PREVIOUS,
    get title() {
      return t(M.findPrevious);
    },
    category: "Edit",
    when: hasDocument,
    handler: (paged) => {
      const scope = scopeOf(paged);
      return findNext(
        findDepsOf(paged as PagedEditor, scope),
        findStoreOf(scope),
        true,
      );
    },
  },
  {
    id: PAGED_EDIT_GO_TO,
    get title() {
      return t(M.goTo);
    },
    category: "Edit",
    when: hasDocument,
    handler: (paged) =>
      patchFind(findStoreOf(scopeOf(paged)), { goTo: true, dialog: false }),
  },
];

export const FIND_MENU_ITEMS: MenuItemContribution[] = [
  { path: "Edit/Find…", command: PAGED_EDIT_FIND, order: 20, group: "find" },
  {
    path: "Edit/Find and replace…",
    command: PAGED_EDIT_REPLACE,
    order: 21,
    group: "find",
  },
  {
    path: "Edit/Find next",
    command: PAGED_EDIT_FIND_NEXT,
    order: 22,
    group: "find",
  },
  {
    path: "Edit/Find previous",
    command: PAGED_EDIT_FIND_PREVIOUS,
    order: 23,
    group: "find",
  },
  {
    path: "Edit/Go to page…",
    command: PAGED_EDIT_GO_TO,
    order: 24,
    group: "find",
  },
];

/** The host's keys: Cmd+F find, Cmd+Alt+F (InDesign's Find/Change) and
 *  Ctrl+H replace, Cmd+J go to page (InDesign's). Word's Cmd+H and
 *  Cmd+G are paged.doc's, scoped to a Word document. */
export const FIND_KEYBINDINGS: KeybindingContribution[] = [
  { key: "cmd+f", command: PAGED_EDIT_FIND, when: hasDocument },
  { key: "ctrl+f", command: PAGED_EDIT_FIND, when: hasDocument },
  { key: "cmd+alt+f", command: PAGED_EDIT_REPLACE, when: hasDocument },
  { key: "ctrl+h", command: PAGED_EDIT_REPLACE, when: hasDocument },
  { key: "cmd+j", command: PAGED_EDIT_GO_TO, when: hasDocument },
];

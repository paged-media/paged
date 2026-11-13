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

// The Focus workspace (strategy §2.3; editor ADR "Docks are resizable and
// the workspace adapts"): one command hides everything but the canvas and
// the tool rail — the header, the context toolbar, the docks, the panel
// rail, the mode bar, the title bar, the page strip and the status bar —
// and the same command brings the layout back exactly as it was. It is a
// flag OVER the layout, not a change to it: the docks' widths, the Tab
// toggles' state and the open panels are untouched, so leaving restores
// them. Nothing it hides is unmounted from the canvas's side: the selection,
// the caret and the zoom stay (the camera keeps the document point at the
// viewport's centre as the canvas grows, UXI-CAM-003).
//
// The Tab and Cmd+\ chrome toggles are a separate thing (editor ADR 234)
// and stay as they are.

import { useEffect, useSyncExternalStore } from "react";
import { defineMessages, t } from "@paged-media/strings";

import {
  createValueStore,
  scopeOf,
  scoped,
  useScoped,
  type EditorScope,
  type ValueStore,
} from "../state/editor-scope";
import { useRegistries } from "../state/registries-context";

export const FOCUS_WORKSPACE_COMMAND = "paged.view.focusWorkspace";

/** Its chord: Cmd+. (Ctrl+. off the Mac). */
export const FOCUS_WORKSPACE_KEYS = ["cmd+.", "ctrl+."] as const;

const M = defineMessages("shell.focusWorkspace", {
  title: "Focus workspace",
  exit: "Leave Focus workspace",
});

defineMessages("menu", {
  "Focus workspace": "Focus workspace",
});

/** Whether the editor is in the Focus workspace, per editor. */
const FOCUS = scoped("focusWorkspace", (): ValueStore<boolean> =>
  createValueStore(false),
);

export function isFocusWorkspace(scope: EditorScope): boolean {
  return scope.get(FOCUS).get();
}

export function setFocusWorkspace(scope: EditorScope, on: boolean): void {
  scope.get(FOCUS).set(on);
}

/** Whether this component's editor is in the Focus workspace now. */
export function useFocusWorkspace(): boolean {
  const store = useScoped(FOCUS);
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/** The words of the command and of its exit button. */
export function focusWorkspaceStrings(): { title: string; exit: string } {
  return { title: t(M.title), exit: t(M.exit) };
}

/** Register the command, its chord and its View menu item for the
 *  lifetime of the calling component (the shell). */
export function useFocusWorkspaceCommand(): void {
  const registries = useRegistries();
  useEffect(() => {
    const disposables = [
      registries.commands.register({
        id: FOCUS_WORKSPACE_COMMAND,
        title: t(M.title),
        category: "View",
        handler: (paged) => {
          const scope = scopeOf(paged);
          const on = !isFocusWorkspace(scope);
          // After the event that ran it: a menu row closes its menu in the
          // same event, and a menu bar hidden in that commit would keep
          // the close pending (a hidden <Activity> defers its updates).
          setTimeout(() => setFocusWorkspace(scope, on), 0);
        },
      }),
      ...FOCUS_WORKSPACE_KEYS.map((key) =>
        registries.keybindings.register({
          key,
          command: FOCUS_WORKSPACE_COMMAND,
        }),
      ),
      registries.menus.register({
        path: "View/Focus workspace",
        command: FOCUS_WORKSPACE_COMMAND,
        checked: (paged) => isFocusWorkspace(scopeOf(paged)),
        order: 95,
        group: "workspace",
      }),
    ];
    return () => {
      for (const d of disposables) d.dispose();
    };
  }, [registries]);
}

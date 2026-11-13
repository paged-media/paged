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

// The adaptive workspace (editor ADR "Docks are resizable and the
// workspace adapts"; UX audit F-55; strategy §2.1). The cockpit arranges
// its docks by the width it is GIVEN, measured on its own element — what
// remains for the canvas and the docks after the host page, the header and
// the editor's two rails — never by the browser window: an editor embedded
// in a narrow column of a wide page is narrow.
//
//   wide    the canvas keeps a comfortable width beside both docks at
//           their defaults: left navigation and the inspector are docked
//   laptop  only the inspector fits beside a working canvas: the left dock
//           collapses to a rail whose button opens it as a flyout (the
//           user may pin it docked again)
//   narrow  not even the inspector fits: both docks are overlays (the
//           left a flyout, the right a drawer) that close on the next
//           canvas interaction
//
// With the editor's rails and a full-window editor the thresholds fall at
// about 1575 px and 1095 px of window, the strategy's 1600 / 1100. The fill
// shapes keep their own layout below 720 px of editor (`state/compact.ts`).

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
import { editorStorage } from "../state/storage";
import { useRegistries } from "../state/registries-context";
import { CANVAS_MIN_WORKING_PX, DOCK_DEFAULT_PX } from "./dock-sizing";

export type WorkspaceClass = "wide" | "laptop" | "narrow";

/** The canvas width the wide workspace keeps beside both docks. */
export const CANVAS_COMFORT_PX = 860;

/** The work area (canvas column + docks) from which the workspace is wide:
 *  the comfortable canvas beside the left and right docks' defaults. */
export const WORKSPACE_WIDE_MIN_PX =
  CANVAS_COMFORT_PX + DOCK_DEFAULT_PX.left + DOCK_DEFAULT_PX.right;

/** The work area from which the inspector stays docked: the canvas's
 *  working minimum beside the right dock's default. Below it, narrow. */
export const WORKSPACE_LAPTOP_MIN_PX =
  CANVAS_MIN_WORKING_PX + DOCK_DEFAULT_PX.right;

/** The class of a work area `px` wide. Unmeasured (0): wide, the layout
 *  the cockpit has always had, so a DOM test or a first render without
 *  layout changes nothing. */
export function workspaceClassOf(px: number): WorkspaceClass {
  if (!(px > 0) || px >= WORKSPACE_WIDE_MIN_PX) return "wide";
  if (px >= WORKSPACE_LAPTOP_MIN_PX) return "laptop";
  return "narrow";
}

/** The editor's workspace class, written by the cockpit layout that
 *  measures it and read by the chrome around it (the mode bar, the
 *  header) — per editor. */
const WORKSPACE = scoped("workspaceClass", (): ValueStore<WorkspaceClass> =>
  createValueStore<WorkspaceClass>("wide"),
);

/** The store the cockpit layout writes the measured class to. */
export function useWorkspaceClassStore(): ValueStore<WorkspaceClass> {
  return useScoped(WORKSPACE);
}

/** The editor's workspace class now ("wide" before the cockpit measures,
 *  and in an editor without a cockpit). */
export function useWorkspaceClass(): WorkspaceClass {
  const store = useScoped(WORKSPACE);
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/** Whether the right dock's drawer is open (a narrow workspace), per
 *  editor: the cockpit layout draws it, the panel rail opens it. */
const RIGHT_DRAWER = scoped("rightDrawerOpen", (): ValueStore<boolean> =>
  createValueStore(false),
);

/** The drawer's open state and its setter. */
export function useRightDrawer(): [boolean, (open: boolean) => void] {
  const store = useScoped(RIGHT_DRAWER);
  const open = useSyncExternalStore(store.subscribe, store.get, store.get);
  return [open, store.set];
}

// ── The preference: adapt, or keep the docks as they are ──────────────
//
// On by default. Off, the cockpit is the fixed layout it always was at
// every width — both docks docked at their chosen widths, nothing collapsed
// into a rail or an overlay, nothing given way for the canvas — for a user
// who sizes the window to the docks and wants them to stay. Edit ▸
// Settings ▸ "Adapt the workspace to the window" switches it, and the
// browser suite boots with it off unless a spec is about the workspace
// (`openCanvas`'s `adaptiveWorkspace`), so the panels' specs read the same
// layout at the suite's 1280 px window as they always did.

const ADAPTIVE_KEY = "paged.adaptiveWorkspace";

export const ADAPTIVE_WORKSPACE_COMMAND = "paged.view.adaptiveWorkspace";

function loadAdaptive(scope: EditorScope): boolean {
  try {
    return editorStorage(scope).getItem(ADAPTIVE_KEY) !== "off";
  } catch {
    return true;
  }
}

const ADAPTIVE = scoped("adaptiveWorkspace", (scope): ValueStore<boolean> =>
  createValueStore(loadAdaptive(scope)),
);

export function isAdaptiveWorkspace(scope: EditorScope): boolean {
  return scope.get(ADAPTIVE).get();
}

/** Switch it and remember the choice. */
export function setAdaptiveWorkspace(scope: EditorScope, on: boolean): void {
  scope.get(ADAPTIVE).set(on);
  try {
    editorStorage(scope).setItem(ADAPTIVE_KEY, on ? "on" : "off");
  } catch {
    /* persistence is a convenience only */
  }
}

/** Whether this component's editor adapts its workspace to its width. */
export function useAdaptiveWorkspace(): boolean {
  const store = useScoped(ADAPTIVE);
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

const M = defineMessages("shell.adaptiveWorkspace", {
  title: "Adapt the workspace to the window",
});

defineMessages("menu", {
  "Adapt the workspace to the window": "Adapt the workspace to the window",
});

/** Register the toggle and its Edit ▸ Settings row for the lifetime of the
 *  calling component (the shell). */
export function useAdaptiveWorkspaceCommand(): void {
  const registries = useRegistries();
  useEffect(() => {
    const disposables = [
      registries.commands.register({
        id: ADAPTIVE_WORKSPACE_COMMAND,
        title: t(M.title),
        category: "View",
        handler: (paged) => {
          const scope = scopeOf(paged);
          setAdaptiveWorkspace(scope, !isAdaptiveWorkspace(scope));
        },
      }),
      registries.menus.register({
        path: "Edit/Settings/Adapt the workspace to the window",
        command: ADAPTIVE_WORKSPACE_COMMAND,
        checked: (paged) => isAdaptiveWorkspace(scopeOf(paged)),
        order: 84,
        group: "settings",
      }),
    ];
    return () => {
      for (const d of disposables) d.dispose();
    };
  }, [registries]);
}

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

// "Tab hides panels (InDesign)" — an opt-in preference (ADR 1201, D-03;
// ADR 234's amendment).
//
// Tab and Shift+Tab move focus, the canvas included, as everywhere else on
// the web: that is the default. The chrome toggle is the command
// `paged.view.toggleChrome` on Cmd/Ctrl+\. A user who comes from InDesign
// can turn this preference on: Tab on a canvas they clicked into then hides
// the panels and the tool rail again (Shift+Tab the panels only), exactly as
// ADR 234's decision 2 had it. Reached by keyboard, the canvas still passes
// Tab on, so the preference never makes it a trap.
//
// One value per editor, kept where the editor keeps its settings (the
// page's localStorage on its own page, the host's storage when embedded:
// `apps/editor/scripts/settings-inventory.json`).

import { useSyncExternalStore } from "react";

import {
  createValueStore,
  scoped,
  useScoped,
  type EditorScope,
  type ValueStore,
} from "../state/editor-scope";
import { editorStorage } from "../state/storage";

/** The storage key (settings-inventory.json, `paged.keyboard.tabHidesPanels`). */
export const TAB_HIDES_PANELS_KEY = "paged.keyboard.tabHidesPanels";

/** The chrome toggle: the panels and the tool rail (ADR 1201, D-03; the
 *  plan's `view.toggleChrome`). Its old id, `paged.chrome.toggleAll`, is
 *  a deprecated alias for two releases (apps/canvas/deprecated-ids.json). */
export const TOGGLE_CHROME_COMMAND = "paged.view.toggleChrome";

/** The command that flips the preference. */
export const TAB_HIDES_PANELS_COMMAND = "paged.preferences.tabHidesPanels";

function stored(scope: EditorScope): boolean {
  try {
    return editorStorage(scope).getItem(TAB_HIDES_PANELS_KEY) === "true";
  } catch {
    return false;
  }
}

const PREFERENCE = scoped("tabHidesPanels", (scope): ValueStore<boolean> =>
  createValueStore(stored(scope)),
);

/** Does Tab on a clicked-into canvas hide the chrome in `scope`'s editor? */
export function tabHidesPanels(scope: EditorScope): boolean {
  return scope.get(PREFERENCE).get();
}

/** Set the preference (persisted; off removes the stored value). */
export function setTabHidesPanels(scope: EditorScope, on: boolean): void {
  scope.get(PREFERENCE).set(on);
  try {
    const storage = editorStorage(scope);
    if (on) storage.setItem(TAB_HIDES_PANELS_KEY, "true");
    else storage.removeItem(TAB_HIDES_PANELS_KEY);
  } catch {
    // A sandbox that refuses storage keeps the value for this session.
  }
}

/** The preference, read during render. */
export function useTabHidesPanels(): boolean {
  const store = useScoped(PREFERENCE);
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

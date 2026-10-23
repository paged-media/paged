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

// Cockpit — per-mode UI-state persistence. Replaces the dockview
// layout snapshots: the fixed cockpit has nothing to serialize but
// "which right-dock tabs are open, which is active". One small
// localStorage blob, debounced writes, and a one-shot cleanup of the
// legacy `paged.layout.*` keys.

import { createDebouncer } from "@paged-media/panel-kit";

import type { WorkflowMode } from "../state/workflow-mode-context";
import { scopedChromeKey } from "../state/chrome-storage-scope";
import { scoped, type EditorScope } from "../state/editor-scope";
import { editorStorage } from "../state/storage";
import { isRecord, isStringArray } from "../lib/stored-settings";

const KEY_BASE = "paged.cockpit.v1";
/** Scoped per workspace — solo runs the cockpit under the mode id
 *  `"design"`, and this blob is keyed BY MODE ID, so an unscoped key
 *  would have solo and the ordinary editor overwriting each other's
 *  right-dock tabs. See `state/chrome-storage-scope.ts`. */
const KEY = (scope: EditorScope) => scopedChromeKey(scope, KEY_BASE);
const LEGACY_PREFIXES = ["paged.layout."];

export interface ModeUiState {
  /** Ordered right-dock tabs (panel ids). */
  rightTabs: string[];
  /** Active tab id; must be a member of `rightTabs`. */
  activeTab: string | null;
}

export type CockpitStore = Partial<Record<WorkflowMode, ModeUiState>>;

/** Load the persisted per-mode state and delete the legacy dockview
 *  layout keys (one-shot migration: old snapshots are meaningless in
 *  the fixed cockpit). */
export function loadCockpitStore(scope: EditorScope): CockpitStore {
  // The editor's settings store (state/storage.ts).
  const ls = editorStorage(scope);
  try {
    // Legacy cleanup — enumerate first, then remove (removal mutates
    // the key index).
    const stale = (ls.keys?.() ?? []).filter((k) =>
      LEGACY_PREFIXES.some((p) => k.startsWith(p)),
    );
    for (const k of stale) ls.removeItem(k);
  } catch {
    /* storage unavailable — nothing to migrate */
  }

  try {
    const raw = ls.getItem(KEY(scope));
    if (!raw) return {};
    return checkedStore(JSON.parse(raw) as unknown);
  } catch {
    return {};
  }
}

/** The stored blob with every mode entry of the wrong shape dropped, so
 *  that mode falls back to its slot seed (SH-101, ADR 247): `rightTabs`
 *  must be a list of panel ids, and an `activeTab` that is not one of
 *  them (and not null) reads as the first tab. */
function checkedStore(parsed: unknown): CockpitStore {
  if (!isRecord(parsed)) return {};
  const out: Record<string, ModeUiState> = {};
  for (const [mode, entry] of Object.entries(parsed)) {
    if (!isRecord(entry) || !isStringArray(entry.rightTabs)) continue;
    const rightTabs = entry.rightTabs as string[];
    const activeTab =
      entry.activeTab === null
        ? null
        : typeof entry.activeTab === "string" &&
            rightTabs.includes(entry.activeTab)
          ? entry.activeTab
          : (rightTabs[0] ?? null);
    out[mode] = { rightTabs, activeTab };
  }
  return out as CockpitStore;
}

/** The blob last saved, and one write 300 ms after the last change (the
 *  panel kit's debouncer), per editor. */
const PENDING = scoped("cockpitPersistence", () => ({
  latest: {} as CockpitStore,
  write: createDebouncer(300),
}));

/** Merge one mode's state into the blob; debounced 300 ms. */
export function saveModeUiState(
  scope: EditorScope,
  store: CockpitStore,
  mode: WorkflowMode,
  state: ModeUiState,
): CockpitStore {
  const next: CockpitStore = { ...store, [mode]: state };
  const pending = scope.get(PENDING);
  pending.latest = next;
  const ls = editorStorage(scope);
  pending.write.schedule(() => {
    try {
      ls.setItem(KEY(scope), JSON.stringify(pending.latest));
    } catch {
      /* quota / privacy mode — state stays in-memory */
    }
  });
  return next;
}

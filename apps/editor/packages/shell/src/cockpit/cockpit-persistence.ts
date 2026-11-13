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
// layout snapshots: the cockpit serializes "which right-dock tabs are
// open, which is active" and, in a second blob, the docks' widths. Small
// localStorage blobs, debounced writes, and a one-shot cleanup of the
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

// ── Dock layout (editor ADR "Docks are resizable and the workspace
// adapts") — per workflow mode, the widths the user dragged the docks to
// and whether the left dock is pinned open on a laptop-width workspace. Its
// own small blob beside the tabs', debounced the same way.

const DOCKS_KEY_BASE = "paged.cockpit.docks.v1";
const DOCKS_KEY = (scope: EditorScope) =>
  scopedChromeKey(scope, DOCKS_KEY_BASE);

export interface ModeDockState {
  /** Widths chosen per dock (CSS px); a missing one is its default. */
  left?: number;
  right?: number;
  form?: number;
  /** The left dock stays docked on a laptop-width workspace. */
  leftPinned?: boolean;
}

export type DockStore = Partial<Record<WorkflowMode, ModeDockState>>;

/** Each mode's dock layout, with every field of the wrong type dropped
 *  (ADR 247: read field by field). */
export function loadDockStore(scope: EditorScope): DockStore {
  try {
    const raw = editorStorage(scope).getItem(DOCKS_KEY(scope));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return {};
    const out: Record<string, ModeDockState> = {};
    for (const [mode, entry] of Object.entries(parsed)) {
      if (!isRecord(entry)) continue;
      const state: ModeDockState = {};
      for (const dock of ["left", "right", "form"] as const) {
        const px = entry[dock];
        if (typeof px === "number" && Number.isFinite(px)) state[dock] = px;
      }
      if (typeof entry.leftPinned === "boolean")
        state.leftPinned = entry.leftPinned;
      out[mode] = state;
    }
    return out as DockStore;
  } catch {
    return {};
  }
}

const DOCKS_PENDING = scoped("cockpitDockPersistence", () => ({
  latest: {} as DockStore,
  write: createDebouncer(300),
}));

/** Merge one mode's dock layout into the blob; debounced 300 ms. */
export function saveModeDockState(
  scope: EditorScope,
  store: DockStore,
  mode: WorkflowMode,
  state: ModeDockState,
): DockStore {
  const next: DockStore = { ...store, [mode]: state };
  const pending = scope.get(DOCKS_PENDING);
  pending.latest = next;
  const ls = editorStorage(scope);
  pending.write.schedule(() => {
    try {
      ls.setItem(DOCKS_KEY(scope), JSON.stringify(pending.latest));
    } catch {
      /* quota / privacy mode — the layout stays in-memory */
    }
  });
  return next;
}

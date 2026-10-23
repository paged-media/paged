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

// Cockpit — the right-dock tab state + inspector-context override.
//
// EVERY mode owns an ordered tab list: design seeds the kit's
// Properties|Library|Swatches; single-inspector modes seed exactly
// one tab (the strip auto-hides at one tab, so the kit's "single
// fixed inspector" look holds). Any registered panel — including a
// late-registered plugin/bundle panel — can be opened as an extra
// closable tab via `openPanel` (panel rail, Window menu, tests).
// That is the WHOLE configurability surface: tabs in one dock,
// never free-floating panels.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";

import { useWorkflowMode } from "../state/workflow-mode-context";
import {
  scoped,
  useEditorScope,
  useScoped,
  type EditorScope,
} from "../state/editor-scope";
import { useRegistries } from "../state/registries-context";
import { useRegistryView } from "../state/live";
import type { WorkflowMode } from "../state/workflow-mode-context";
import {
  loadCockpitStore,
  saveModeUiState,
  type CockpitStore,
  type ModeUiState,
} from "./cockpit-persistence";

/** Manual override for the Properties panel's sub-inspector — the
 *  kit's panel-rail Text/Image/Pages clicks. Live selection still
 *  wins when present; this is the "show me the text properties"
 *  steer. */
export type InspectorContext = "text" | "image" | "page";

export interface CockpitState {
  /** Ordered right-dock tabs for the ACTIVE mode. */
  rightTabs: string[];
  /** Active tab id (member of `rightTabs`; null when empty). */
  activeTab: string | null;
  /** Tabs seeded by the mode's slots — closing them is allowed, but
   *  they re-seed on a fresh visit when no persisted state exists.
   *
   *  `activate: false` OPENS the tab without raising it — the ADR 023
   *  follow-up lane. This dock shows one panel at a time, so raising IS
   *  hiding; a context that serves the panel currently on screen must be
   *  able to add its own tab without taking the shared panel off screen
   *  at the exact moment it retargets. Default stays `true`. */
  openPanel(id: string, options?: { activate?: boolean }): void;
  activateTab(id: string): void;
  closeTab(id: string): void;
  inspectorContext: InspectorContext | null;
  setInspectorContext(ctx: InspectorContext | null): void;
}

const CockpitStateContext = createContext<CockpitState | null>(null);

/** The cockpit's panel placement as plain functions, per editor (plan
 *  task E1): the provider keeps them pointed at the live actions so code
 *  rendered ABOVE the provider (the panel show/hide commands, the plugin
 *  host's `shell.openPanel`) can reach the cockpit without context
 *  plumbing. Null while no cockpit provider is mounted. */
export interface CockpitActions {
  openPanel: ((id: string, options?: { activate?: boolean }) => void) | null;
  closeTab: ((id: string) => void) | null;
  /** The tab currently ON SCREEN (this dock shows only that one; the
   *  other open tabs stay mounted in a hidden Activity, ADR 240), or
   *  null. Read by the edit-context controller to decide whether raising
   *  a context's own panels would displace a panel it serves. */
  activeTab: (() => string | null) | null;
}

const COCKPIT_ACTIONS = scoped("cockpitActions", (): CockpitActions => ({
  openPanel: null,
  closeTab: null,
  activeTab: null,
}));

/** `scope`'s cockpit actions (one object for the editor's lifetime). */
export function cockpitActionsOf(scope: EditorScope): CockpitActions {
  return scope.get(COCKPIT_ACTIONS);
}

/** Point `scope`'s actions at a mounted cockpit; returns the unbind. */
function bindCockpitActions(
  scope: EditorScope,
  live: {
    openPanel: NonNullable<CockpitActions["openPanel"]>;
    closeTab: NonNullable<CockpitActions["closeTab"]>;
    activeTab: NonNullable<CockpitActions["activeTab"]>;
  },
): () => void {
  const actions = cockpitActionsOf(scope);
  Object.assign(actions, live);
  return () => {
    actions.openPanel = null;
    actions.closeTab = null;
    actions.activeTab = null;
  };
}

/** The cockpit actions of the editor this component is mounted in. */
export function useCockpitActions(): CockpitActions {
  return useScoped(COCKPIT_ACTIONS);
}

/** Seed a mode's tab list from its registered slots. */
function seedTabs(
  mode: WorkflowMode,
  modes: ReturnType<typeof useRegistries>["modes"],
): ModeUiState {
  const slots = modes.get(mode)?.slots;
  const tabs = slots?.tabs ?? (slots?.inspector ? [slots.inspector] : []);
  return { rightTabs: [...tabs], activeTab: tabs[0] ?? null };
}

export function CockpitStateProvider({ children }: PropsWithChildren) {
  const { mode } = useWorkflowMode();
  const registries = useRegistries();
  // What was persisted when the cockpit mounted, for a mode's first visit;
  // every later change of a mode's state is in `byMode` as well.
  const scope = useEditorScope();
  const [persisted] = useState(() => loadCockpitStore(scope));
  const storeRef = useRef<CockpitStore>(persisted);

  // Per-mode state map kept in a single useState so a mode switch is
  // one render. Lazy: a mode materialises on first visit (persisted
  // state or slot seed).
  const [byMode, setByMode] = useState<
    Partial<Record<WorkflowMode, ModeUiState>>
  >({});
  const [inspectorContext, setInspectorContext] =
    useState<InspectorContext | null>(null);

  // Modes register in app effects AFTER the first render: the slot seed
  // is read through a view of the mode registry (state/live.ts), so it
  // is derived again once the app's modes land.
  const modes = useRegistryView(registries.modes);
  const current: ModeUiState =
    byMode[mode] ?? persisted[mode] ?? seedTabs(mode, modes);

  // eslint-disable-next-line no-restricted-syntax -- keeps an effect dependency stable (ADR 229)
  const commit = useCallback(
    (next: ModeUiState) => {
      setByMode((prev) => ({ ...prev, [mode]: next }));
      storeRef.current = saveModeUiState(scope, storeRef.current, mode, next);
    },
    [mode, scope],
  );

  // eslint-disable-next-line no-restricted-syntax -- keeps an effect dependency stable; context consumers compare it (ADR 229)
  const activateTab = useCallback(
    (id: string) => {
      if (!current.rightTabs.includes(id)) return;
      commit({ ...current, activeTab: id });
    },
    [commit, current],
  );

  // eslint-disable-next-line no-restricted-syntax -- keeps an effect dependency stable; context consumers compare it (ADR 229)
  const openPanel = useCallback(
    (id: string, options?: { activate?: boolean }) => {
      // Any REGISTERED panel may open; unknown ids are ignored so a
      // stale persisted tab or a disposed plugin panel can't wedge
      // the dock.
      if (!registries.panels.get(id)) return;
      const activate = options?.activate ?? true;
      const alreadyOpen = current.rightTabs.includes(id);
      // Background-open an already-open tab: nothing to change, and
      // committing anyway would churn the persisted layout.
      if (alreadyOpen && !activate) return;
      const rightTabs = alreadyOpen
        ? current.rightTabs
        : [...current.rightTabs, id];
      // A background open still needs SOMETHING active — an empty dock
      // would otherwise render "No panel open." next to a live tab.
      const activeTab = activate ? id : (current.activeTab ?? id);
      commit({ rightTabs, activeTab });
    },
    [commit, current, registries.panels],
  );

  // eslint-disable-next-line no-restricted-syntax -- keeps an effect dependency stable; context consumers compare it (ADR 229)
  const closeTab = useCallback(
    (id: string) => {
      const idx = current.rightTabs.indexOf(id);
      if (idx < 0) return;
      const rightTabs = current.rightTabs.filter((t) => t !== id);
      const activeTab =
        current.activeTab === id
          ? (rightTabs[Math.max(0, idx - 1)] ?? null)
          : current.activeTab;
      commit({ rightTabs, activeTab });
    },
    [commit, current],
  );

  // Keep the editor's dispatch pointed at the live actions.
  const activeTab = current.activeTab;
  useEffect(
    () =>
      bindCockpitActions(scope, {
        openPanel,
        closeTab,
        activeTab: () => activeTab,
      }),
    [activeTab, closeTab, openPanel, scope],
  );

  // eslint-disable-next-line no-restricted-syntax -- a context value its consumers compare; its type argument types it (ADR 229)
  const value = useMemo<CockpitState>(
    () => ({
      rightTabs: current.rightTabs,
      activeTab: current.activeTab,
      openPanel,
      activateTab,
      closeTab,
      inspectorContext,
      setInspectorContext,
    }),
    [activateTab, closeTab, current, inspectorContext, openPanel],
  );

  return (
    <CockpitStateContext.Provider value={value}>
      {children}
    </CockpitStateContext.Provider>
  );
}

export function useCockpitState(): CockpitState {
  const ctx = useContext(CockpitStateContext);
  if (!ctx) {
    throw new Error("useCockpitState requires CockpitStateProvider");
  }
  return ctx;
}

export function useOptionalCockpitState(): CockpitState | null {
  return useContext(CockpitStateContext);
}

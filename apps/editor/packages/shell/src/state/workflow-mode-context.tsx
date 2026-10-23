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

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type PropsWithChildren,
} from "react";

import { scopedChromeKey } from "./chrome-storage-scope";
import { useEditorScope, type EditorScope } from "./editor-scope";
import { editorStorage } from "./storage";

// Design system (publishing cockpit) — the workflow mode. One
// product, six purpose-built experiences: each mode re-skins the
// context toolbar, the visible panel sets and the canvas overlays
// (the contributions live in the ModeRegistry; this context holds
// only the active id — the screen-mode pattern). Pure VIEW state:
// switching modes writes NOTHING to the document.

/** The editor's own six modes. */
export type BuiltInWorkflowMode =
  "design" | "content" | "prepress" | "data" | "review" | "export";

/** A workflow mode id: one of the six, or one an editor profile declares
 *  (docs/composable-editor.md §5.3). Open, so a preset can name its own
 *  mode instead of borrowing `design`; the six stay as literals for
 *  completion. */
export type WorkflowMode = BuiltInWorkflowMode | (string & {});

const STORAGE_KEY_BASE = "paged.workflowMode";
/** Scoped per workspace — see `chrome-storage-scope.ts`. Solo must not
 *  INHERIT the mode an ordinary session left behind: booting into
 *  `prepress` when solo registers only one mode leaves the cockpit with
 *  no registered slots and therefore no left panel at all. */
const storageKey = (scope: EditorScope) =>
  scopedChromeKey(scope, STORAGE_KEY_BASE);

function loadInitialMode(scope: EditorScope): WorkflowMode {
  try {
    const raw = editorStorage(scope).getItem(storageKey(scope));
    // Any stored id is taken here; the shell falls back to the first
    // registered mode when it is not one of this editor's (PagedShell).
    if (raw && raw.length <= 64) return raw;
  } catch {
    /* storage unavailable — fall through */
  }
  return "design";
}

interface WorkflowModeValue {
  mode: WorkflowMode;
  setMode: (m: WorkflowMode) => void;
}

const Context = createContext<WorkflowModeValue | null>(null);

export interface WorkflowModeProviderProps extends PropsWithChildren {
  /** Force the starting mode and DO NOT read persistence.
   *
   *  Solo mode needs this. It registers exactly one mode, and if the
   *  provider seeded from `localStorage` a user whose last ordinary
   *  session ended in `prepress` would boot solo into a mode that is not
   *  registered — `registries.modes.get(mode)` returns undefined, so
   *  `slots` is undefined, so the cockpit renders NO left panel and an
   *  empty right dock. The app would look broken for a reason entirely
   *  outside the current page. */
  initialMode?: WorkflowMode;
}

export function WorkflowModeProvider({
  children,
  initialMode,
}: WorkflowModeProviderProps) {
  const scope = useEditorScope();
  const [mode, setModeState] = useState<WorkflowMode>(
    () => initialMode ?? loadInitialMode(scope),
  );
  // eslint-disable-next-line no-restricted-syntax -- keeps an effect dependency stable (ADR 229)
  const setMode = useCallback(
    (m: WorkflowMode) => {
      setModeState(m);
      try {
        editorStorage(scope).setItem(storageKey(scope), m);
      } catch {
        /* persistence is a convenience only */
      }
    },
    [scope],
  );
  // eslint-disable-next-line no-restricted-syntax -- its type argument types the value (ADR 229)
  const value = useMemo<WorkflowModeValue>(
    () => ({ mode, setMode }),
    [mode, setMode],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useWorkflowMode(): WorkflowModeValue {
  const ctx = useContext(Context);
  if (!ctx) {
    throw new Error("useWorkflowMode called outside WorkflowModeProvider");
  }
  return ctx;
}

export function useOptionalWorkflowMode(): WorkflowModeValue | null {
  return useContext(Context);
}

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

// W3.2 — the edit-context STACK (closes plugin-draw B-02 / plugin-web
// W-03). The registry (registries/edit-context.ts) holds the registered
// contexts + object types; THIS provider owns the live, ordered STACK of
// entered contexts and the chrome/scope they imply.
//
// The stack itself is `edit-context-store.ts`: a reducer and a post-commit
// effect queue (editor ADR 1211), so every hook runs exactly once, after
// the stack has changed, in the order of the actions. This file puts one
// store in front of React (`useSyncExternalStore`), wires its resolve
// prompt and the engine's scope query, and registers it with the replace
// guard, so a document switch resolves the contexts first.
//
// STACK SEMANTICS
//   · `enter(contribution, id, …)` PUSHES a frame. Re-entering the SAME
//     type on the SAME element when it is on top is a no-op (UXI-CTX-002).
//   · `leave(reason)` leaves the TOP frame the one way every exit takes:
//     `resolveContextExit` (context-exit.ts) decides commit, cancel, a plain
//     pop, or asking — from the reason, whether the context is dirty and
//     the module's `exitPolicy` (D-04). `leaveAll` / `leaveTo` walk down.
//   · `commit()` / `cancel()` / `pop()` / `exitAll()` are the direct exits
//     a module asks for itself (`host.shell.exitEditContext`, a frame
//     surface's exit) and the document's own replacement.
//   · `active` is the TOP frame (or null); `breadcrumb` is the whole
//     stack root→top for the UI trail.
//
// WRITE-SCOPE LINE (UXI-CTX-010, UXI-CTX-011): `isInScope(id)` is the
// selection-level scope — the entered root, plus what the engine's scope
// query (`client.scopeContains`, EN5) last said lies inside its subtree
// (`checkScope`). Without the query only the root is in scope; root
// equality is never presented as subtree isolation. Engine-level refusal
// of out-of-scope mutations is the engine's job, not this line's.

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type PropsWithChildren,
} from "react";

import type { ElementId } from "@paged-media/client";

import type { EditContextContribution } from "../registries/edit-context";
import { useOptionalCanvasClient } from "./canvas-client-context";
import {
  askContextExit,
  resolveContextExit,
  type ContextExitReason,
  type ContextExitResolution,
} from "./context-exit";
import {
  createEditContextStore,
  scopeQueryOf,
  type ContextLeave,
  type EditContextFrame,
  type EditContextStore,
  type EnterPoint,
} from "./edit-context-store";
import { useEditorScope } from "./editor-scope";
import { setContextResolver } from "./replace-guard";

export type {
  ContextLeave,
  EditContextFrame,
  EnterPoint,
} from "./edit-context-store";

export interface EditContextStackValue {
  /** The whole stack, root→top. */
  stack: readonly EditContextFrame[];
  /** The TOP frame, or null when no context is active. */
  active: EditContextFrame | null;
  /** The TOP frame's CONTRIBUTION (its live hooks — onContentPointer*,
   *  onCommit/onCancel/isDirty), or null. K-1: the canvas reads this to
   *  deliver content-space pointers to the active context. */
  activeContribution: EditContextContribution | null;
  /** Breadcrumb trail (root→top) — the same as `stack`, named for the UI. */
  breadcrumb: readonly EditContextFrame[];
  /** Push a context onto the stack (double-click / programmatic enter).
   *  Re-entering the same type+element on top is a no-op. Returns the
   *  pushed frame, or the existing one when it was a no-op. */
  enter(
    contribution: EditContextContribution,
    on: ElementId,
    at?: EnterPoint,
  ): EditContextFrame;
  /** Leave the TOP frame for `reason` through the one exit resolver
   *  (editor ADR 1211, D-04). */
  leave(reason: ContextExitReason): ContextLeave;
  /** Leave every frame, top to root, for `reason`; false when the user
   *  kept a context (Cancel in the resolve prompt). */
  leaveAll(reason: ContextExitReason): Promise<boolean>;
  /** Leave frames until `depth` remain (the breadcrumb). */
  leaveTo(depth: number, reason: ContextExitReason): Promise<boolean>;
  /** Pop the TOP frame with no resolution (onExit only). */
  pop(): EditContextFrame | null;
  /** COMMIT the top frame: its `onCommit`, then `onExit` (a module's own
   *  exit with commit). */
  commit(): EditContextFrame | null;
  /** CANCEL the top frame: its `onCancel`, then `onExit`. */
  cancel(): EditContextFrame | null;
  /** Does the active context have unsaved edits? Polls the top
   *  contribution's `isDirty` (false when none / no context). */
  isActiveDirty(): boolean;
  /** Does `frame` hold unsaved edits? */
  isDirty(frame: EditContextFrame): boolean;
  /** Clear the entire stack. With `{ commit: true }` each frame's
   *  `onCommit` runs before its `onExit`, top to root; without it only
   *  `onExit` runs (the document is gone). */
  exitAll(opts?: { commit?: boolean }): void;
  /** Is `id` inside the ACTIVE context's write-scope? True when no context
   *  is active. The entered root, and what `checkScope` last learned. */
  isInScope(id: ElementId | null | undefined): boolean;
  /** Ask the engine which of `ids` lie inside the active context's scope
   *  (EN5); without the query, the root only. */
  checkScope(ids: readonly ElementId[]): Promise<boolean[]>;
}

const Context = createContext<EditContextStackValue | null>(null);

function valueOf(store: EditContextStore): EditContextStackValue {
  const snap = store.getSnapshot();
  return {
    stack: snap.stack,
    active: snap.active,
    activeContribution: snap.activeContribution,
    breadcrumb: snap.stack,
    enter: store.enter,
    leave: store.leave,
    leaveAll: store.leaveAll,
    leaveTo: store.leaveTo,
    pop: store.pop,
    commit: store.commit,
    cancel: store.cancel,
    isActiveDirty: store.isActiveDirty,
    isDirty: store.isDirty,
    exitAll: store.exitAll,
    isInScope: store.isInScope,
    checkScope: store.checkScope,
  };
}

export function EditContextStackProvider({ children }: PropsWithChildren) {
  const scope = useEditorScope();
  const client = useOptionalCanvasClient();
  const [store] = useState(createEditContextStore);
  useEffect(() => {
    store.configure({
      ask: (request) => askContextExit(scope, request),
      scopeQuery: scopeQueryOf(client),
    });
  }, [store, scope, client]);
  // A document switch resolves the contexts before the replace question
  // (D-04, UXI-T43): Cancel in either keeps everything as it was.
  useEffect(
    () => setContextResolver(scope, () => store.resolveForDocumentSwitch()),
    [store, scope],
  );
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  const [value, setValue] = useState(() => valueOf(store));
  if (value.stack !== snapshot.stack) setValue(valueOf(store));
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useEditContextStack(): EditContextStackValue {
  const ctx = useContext(Context);
  if (!ctx) {
    throw new Error(
      "useEditContextStack called outside EditContextStackProvider",
    );
  }
  return ctx;
}

/** The one exit resolver for a caller that decides at once (editor ADR
 *  1211). */
export interface ContextExit {
  /** What leaving the top context for `reason` would do now; null with
   *  no context. Asks nothing, changes nothing. */
  resolution(reason: ContextExitReason): ContextExitResolution | null;
  /** Leave the top context for `reason` (see `EditContextStackValue.leave`):
   *  `outcome === "asking"` means a question is up and the caller's event
   *  must do nothing else (the answer finishes the exit). */
  leave(reason: ContextExitReason): ContextLeave;
}

/**
 * The exit resolver as a hook. The canvas's press outside the active
 * context's frame (track IC owns `ViewportCanvas.tsx`) calls
 * `leave("click-outside")` where it used to call `commit()`, and stops
 * handling the press when the outcome is `"asking"`:
 *
 *     if (editContextStack.leave("click-outside").outcome === "asking") return;
 *
 * With no stack mounted both members answer as if no context were open.
 */
export function useContextExit(): ContextExit {
  const stack = useOptionalEditContextStack();
  return {
    resolution(reason) {
      const top = stack?.active ?? null;
      if (!stack || !top) return null;
      return resolveContextExit(reason, {
        dirty: stack.isDirty(top),
        exitPolicy: top.exitPolicy,
      });
    },
    leave(reason) {
      return stack
        ? stack.leave(reason)
        : { outcome: "none", done: Promise.resolve(true) };
    },
  };
}

/** Non-throwing variant for consumers that may mount standalone. */
export function useOptionalEditContextStack(): EditContextStackValue | null {
  return useContext(Context);
}

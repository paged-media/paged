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

// The edit-context stack as a reducer and a post-commit effect queue
// (editor ADR 1212, task CM1; UXI-CTX-001, UXI-CTX-002, UXI-PLG-005).
//
// The stack used to live in a React `useState` and ran the contexts'
// hooks (onEnter, onCommit, onCancel, onExit) INSIDE the `setStack`
// updaters. An updater runs when React decides: twice under StrictMode,
// later than the call when the fiber already has pending work. A hook
// could run twice, or not at all, and `enter` could return before it knew
// whether it had pushed. The hooks were keyed by the context TYPE, so two
// stacked contexts of one type shared one entry and the inner one's exit
// dropped the outer one's hooks.
//
// Here the state is a plain value changed only by `reduce` (pure: state +
// action → next state + effects). `dispatch` commits the next state (the
// snapshot every reader sees), notifies, and then runs the effects in
// order, exactly once each. A hook that dispatches (a context leaving
// itself from its onEnter) queues behind the effects already waiting, so
// the order is always the order of the actions. Each frame has an id of
// its own; its contribution (its hooks) is held under that id.

import type { ElementId } from "@paged-media/client";

import type {
  EditContextContribution,
  EnteredEditContext,
} from "../registries/edit-context";
import {
  resolutionOfAnswer,
  resolveContextExit,
  type ContextExitAnswer,
  type ContextExitPolicy,
  type ContextExitReason,
  type ContextExitRequest,
} from "./context-exit";

/** One entered context — a stack frame. */
export interface EditContextFrame {
  /** This entry's own id: the key its hooks are held under (two stacked
   *  contexts of one type are two frames). */
  id: string;
  /** The edit-context type (`"vectorGraphic"`, `"webFrame"`, …). */
  type: string;
  /** The element the context was entered on — the write-scope root. */
  scopeRoot: ElementId;
  /**
   * Tool ids the rail is restricted to while this frame is top.
   *
   * `null` = the context DECLARED NOTHING, so nothing is restricted —
   * the permissive default for a context that has not thought about it.
   * `[]` = the context declared that NO tool applies here, which is a
   * statement and not the same fact (UXI-CTX-004, ADR 024 decision 2).
   */
  toolIds: readonly string[] | null;
  /** Panel ids the cockpit emphasizes while this frame is active. */
  panelIds: string[];
  /** The context's name as the user reads it: the module's `label`, else
   *  its type title-cased (UXI-CTX-005, F-45). */
  label: string;
  /** The module's declared exit policy (null: none declared). */
  exitPolicy: ContextExitPolicy | null;
}

/** W-19 — where a POINTER entry happened, handed to the context's
 *  `onEnter` (see `EnteredEditContext`). */
export interface EnterPoint {
  pageId: import("@paged-media/client").PageId;
  pagePoint: [number, number];
  contentPoint?: [number, number];
}

/** How a frame leaves: keep its work, revert it, or neither. */
export type ExitMode = "commit" | "cancel" | "pop";

export interface EditContextState {
  readonly frames: readonly EditContextFrame[];
  /** Each frame's contribution, by frame id. */
  readonly contributions: ReadonlyMap<string, EditContextContribution>;
}

export type EditContextAction =
  | {
      kind: "enter";
      frame: EditContextFrame;
      contribution: EditContextContribution;
      entered: EnteredEditContext;
    }
  /** Leave the TOP frame — only when it is `frameId` (if given). */
  | { kind: "exit"; mode: ExitMode; frameId?: string }
  /** Leave every frame, top to root. */
  | { kind: "exitAll"; mode: ExitMode };

/** A hook to run after the state commit. */
export interface EditContextEffect {
  hook: "onEnter" | "onCommit" | "onCancel" | "onExit";
  frame: EditContextFrame;
  contribution: EditContextContribution;
  entered: EnteredEditContext;
}

export const EMPTY_STATE: EditContextState = {
  frames: [],
  contributions: new Map(),
};

/** Stable string key for an ElementId (kind + id). */
export function elementKey(id: ElementId): string {
  const anyId = id as unknown as { kind?: string; id?: unknown };
  return `${anyId.kind ?? ""}:${String(anyId.id ?? id)}`;
}

/** `vectorGraphic` → `Vector graphic`; `webFrame` → `Web frame`. */
export function titleCaseType(type: string): string {
  const spaced = type.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

/** A context's user-facing name: its module's label, else its type. */
export function contextLabel(
  contribution: Pick<EditContextContribution, "type" | "label">,
): string {
  const label = contribution.label?.trim();
  return label ? label : titleCaseType(contribution.type);
}

function exitEffects(
  frame: EditContextFrame,
  contribution: EditContextContribution | undefined,
  mode: ExitMode,
): EditContextEffect[] {
  if (!contribution) return [];
  const entered = { type: frame.type, id: frame.scopeRoot };
  const out: EditContextEffect[] = [];
  if (mode === "commit")
    out.push({ hook: "onCommit", frame, contribution, entered });
  else if (mode === "cancel")
    out.push({ hook: "onCancel", frame, contribution, entered });
  out.push({ hook: "onExit", frame, contribution, entered });
  return out;
}

/** The reducer: pure. Returns the same state object when nothing changes. */
export function reduceEditContexts(
  state: EditContextState,
  action: EditContextAction,
): { state: EditContextState; effects: EditContextEffect[] } {
  switch (action.kind) {
    case "enter": {
      const top = state.frames[state.frames.length - 1];
      // UXI-CTX-002 — the same context on the same root, already on top:
      // nothing changes and no hook runs again.
      if (
        top &&
        top.type === action.frame.type &&
        elementKey(top.scopeRoot) === elementKey(action.frame.scopeRoot)
      ) {
        return { state, effects: [] };
      }
      const contributions = new Map(state.contributions);
      contributions.set(action.frame.id, action.contribution);
      return {
        state: { frames: [...state.frames, action.frame], contributions },
        effects: [
          {
            hook: "onEnter",
            frame: action.frame,
            contribution: action.contribution,
            entered: action.entered,
          },
        ],
      };
    }
    case "exit": {
      const top = state.frames[state.frames.length - 1];
      if (!top) return { state, effects: [] };
      if (action.frameId !== undefined && top.id !== action.frameId)
        return { state, effects: [] };
      const contributions = new Map(state.contributions);
      const contribution = contributions.get(top.id);
      contributions.delete(top.id);
      return {
        state: { frames: state.frames.slice(0, -1), contributions },
        effects: exitEffects(top, contribution, action.mode),
      };
    }
    case "exitAll": {
      if (state.frames.length === 0) return { state, effects: [] };
      const effects: EditContextEffect[] = [];
      for (let i = state.frames.length - 1; i >= 0; i--) {
        const frame = state.frames[i]!;
        effects.push(
          ...exitEffects(frame, state.contributions.get(frame.id), action.mode),
        );
      }
      return { state: EMPTY_STATE, effects };
    }
  }
}

/** What `leave` did: the context is gone now, a question is open (the
 *  caller consumes its event; the answer finishes the exit), or there
 *  was no context. `done` resolves true once the context is gone, false
 *  when the user kept it. */
export interface ContextLeave {
  outcome: "left" | "asking" | "none";
  done: Promise<boolean>;
}

/** The engine's scope query (EN5, `client.scopeContains`): for each id,
 *  whether it lies inside `root`'s subtree. */
export type ScopeQuery = (
  root: ElementId,
  ids: readonly ElementId[],
) => Promise<readonly boolean[]>;

/** The engine's whole edit scope of a root (EN5, `client.editScope`,
 *  engine ADR 1301), with a synchronous membership test. */
export interface EditScopeLike {
  contains(id: ElementId): boolean;
}

/** What the provider wires in: the resolve prompt and the scope queries. */
export interface EditContextEnvironment {
  ask(request: ContextExitRequest): Promise<ContextExitAnswer>;
  scopeQuery: ScopeQuery | null;
  /** The whole scope of a root, cached by the client per document state. */
  editScope: ((root: ElementId) => Promise<EditScopeLike>) | null;
}

export interface EditContextSnapshot {
  stack: readonly EditContextFrame[];
  active: EditContextFrame | null;
  activeContribution: EditContextContribution | null;
}

export interface EditContextStore {
  getSnapshot(): EditContextSnapshot;
  subscribe(listener: () => void): () => void;
  configure(env: Partial<EditContextEnvironment>): void;
  enter(
    contribution: EditContextContribution,
    on: ElementId,
    at?: EnterPoint,
  ): EditContextFrame;
  pop(): EditContextFrame | null;
  commit(): EditContextFrame | null;
  cancel(): EditContextFrame | null;
  exitAll(opts?: { commit?: boolean }): void;
  leave(reason: ContextExitReason): ContextLeave;
  leaveAll(reason: ContextExitReason): Promise<boolean>;
  leaveTo(depth: number, reason: ContextExitReason): Promise<boolean>;
  resolveForDocumentSwitch(): Promise<boolean>;
  isDirty(frame: EditContextFrame): boolean;
  isActiveDirty(): boolean;
  isInScope(id: ElementId | null | undefined): boolean;
  checkScope(ids: readonly ElementId[]): Promise<boolean[]>;
}

export function createEditContextStore(): EditContextStore {
  let state: EditContextState = EMPTY_STATE;
  let snapshot: EditContextSnapshot = {
    stack: [],
    active: null,
    activeContribution: null,
  };
  let seq = 0;
  const listeners = new Set<() => void>();
  const queue: EditContextEffect[] = [];
  let draining = false;
  let env: EditContextEnvironment = {
    ask: () => Promise.resolve("commit"),
    scopeQuery: null,
    editScope: null,
  };
  /** The open question per frame, so two exits never ask twice. */
  const asking = new Map<string, Promise<boolean>>();
  /** The engine's last answers per frame: element key → inside. */
  const scopeAnswers = new Map<string, Map<string, boolean>>();
  /** The engine's whole scope per frame, when the client offers it. */
  const scopes = new Map<string, EditScopeLike>();

  const fetchScope = async (
    frame: EditContextFrame,
  ): Promise<EditScopeLike | null> => {
    const editScope = env.editScope;
    if (!editScope) return null;
    try {
      const scope = await editScope(frame.scopeRoot);
      if (state.frames.some((f) => f.id === frame.id))
        scopes.set(frame.id, scope);
      return scope;
    } catch {
      return null;
    }
  };

  const runEffect = (e: EditContextEffect) => {
    const c = e.contribution;
    // UXI-PLG-005 — a throwing hook never wedges the stack.
    try {
      if (e.hook === "onEnter") c.onEnter?.(e.entered);
      else if (e.hook === "onCommit") c.onCommit?.();
      else if (e.hook === "onCancel") c.onCancel?.();
      else c.onExit?.(e.entered);
    } catch {
      /* the module's own failure; the stack has already moved on */
    }
  };

  const dispatch = (action: EditContextAction): EditContextState => {
    const before = state;
    const out = reduceEditContexts(state, action);
    if (out.state !== before) {
      state = out.state;
      for (const id of scopeAnswers.keys()) {
        if (!state.contributions.has(id)) scopeAnswers.delete(id);
      }
      for (const id of scopes.keys()) {
        if (!state.contributions.has(id)) scopes.delete(id);
      }
      const top = state.frames[state.frames.length - 1] ?? null;
      snapshot = {
        stack: state.frames,
        active: top,
        activeContribution: top
          ? (state.contributions.get(top.id) ?? null)
          : null,
      };
      for (const l of [...listeners]) l();
    }
    queue.push(...out.effects);
    if (!draining) {
      draining = true;
      try {
        while (queue.length > 0) runEffect(queue.shift()!);
      } finally {
        draining = false;
      }
    }
    return before;
  };

  const top = () => state.frames[state.frames.length - 1] ?? null;

  const exitTop = (mode: ExitMode): EditContextFrame | null => {
    const frame = top();
    if (!frame) return null;
    dispatch({ kind: "exit", mode, frameId: frame.id });
    return frame;
  };

  const isDirty = (frame: EditContextFrame): boolean => {
    const c = state.contributions.get(frame.id);
    try {
      return c?.isDirty?.() ?? false;
    } catch {
      return false;
    }
  };

  const leave = (reason: ContextExitReason): ContextLeave => {
    const frame = top();
    if (!frame) return { outcome: "none", done: Promise.resolve(true) };
    const open = asking.get(frame.id);
    if (open) return { outcome: "asking", done: open };
    const resolution = resolveContextExit(reason, {
      dirty: isDirty(frame),
      exitPolicy: frame.exitPolicy,
    });
    if (resolution !== "ask") {
      dispatch({ kind: "exit", mode: resolution, frameId: frame.id });
      return { outcome: "left", done: Promise.resolve(true) };
    }
    const done = env
      .ask({ label: frame.label, reason })
      .catch((): ContextExitAnswer => "cancel")
      .then((answer) => {
        asking.delete(frame.id);
        // Gone meanwhile (the module left by itself): nothing to keep.
        if (!state.frames.some((f) => f.id === frame.id)) return true;
        const mode = resolutionOfAnswer(answer);
        if (!mode) return false;
        // Only the top can leave; a context entered above it meanwhile
        // keeps this one.
        if (top()?.id !== frame.id) return false;
        dispatch({ kind: "exit", mode, frameId: frame.id });
        return true;
      });
    asking.set(frame.id, done);
    return { outcome: "asking", done };
  };

  const leaveTo = async (
    depth: number,
    reason: ContextExitReason,
  ): Promise<boolean> => {
    while (state.frames.length > depth) {
      const before = top();
      const step = leave(reason);
      if (!(await step.done)) return false;
      // An exit that changed nothing (the frame stayed on top) ends the
      // walk rather than looping.
      if (top() === before) return false;
    }
    return true;
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    configure(next) {
      env = { ...env, ...next };
    },
    enter(contribution, on, at) {
      const frame: EditContextFrame = {
        id: `ctx-${++seq}`,
        type: contribution.type,
        scopeRoot: on,
        toolIds: contribution.toolIds ?? null,
        panelIds: contribution.panelIds ?? [],
        label: contextLabel(contribution),
        exitPolicy: contribution.exitPolicy ?? null,
      };
      const entered: EnteredEditContext = {
        type: frame.type,
        id: on,
        ...(at
          ? {
              pageId: at.pageId,
              pagePoint: at.pagePoint,
              ...(at.contentPoint ? { contentPoint: at.contentPoint } : {}),
            }
          : {}),
      };
      const before = dispatch({ kind: "enter", frame, contribution, entered });
      // A no-op (CTX-002) leaves the existing frame on top.
      if (state === before) return before.frames[before.frames.length - 1]!;
      // The engine's scope of the root, ahead of the first `isInScope`.
      void fetchScope(frame);
      return frame;
    },
    pop: () => exitTop("pop"),
    commit: () => exitTop("commit"),
    cancel: () => exitTop("cancel"),
    exitAll(opts) {
      dispatch({ kind: "exitAll", mode: opts?.commit ? "commit" : "pop" });
    },
    leave,
    leaveAll: (reason) => leaveTo(0, reason),
    leaveTo,
    async resolveForDocumentSwitch() {
      // Only unfinished work is asked about before the guard: a clean
      // context stays until the replacement really happens (the
      // controller pops it then), so Cancel in the replace question keeps
      // it too (UXI-T43).
      for (;;) {
        const frames = state.frames;
        let dirtyAt = -1;
        for (let i = frames.length - 1; i >= 0; i--) {
          if (isDirty(frames[i]!)) {
            dirtyAt = i;
            break;
          }
        }
        if (dirtyAt < 0) return true;
        while (state.frames.length - 1 > dirtyAt) exitTop("pop");
        const before = top();
        if (!(await leave("document-switch").done)) return false;
        if (top() === before) return false;
      }
    },
    isDirty,
    isActiveDirty() {
      const frame = top();
      return frame ? isDirty(frame) : false;
    },
    isInScope(id) {
      const frame = top();
      if (!frame) return true; // no context → no restriction
      if (id == null) return false;
      const key = elementKey(id);
      if (key === elementKey(frame.scopeRoot)) return true;
      // The engine's scope of the root (EN5), else its last answers for
      // this frame (checkScope); unknown is outside: root equality is not a
      // subtree (UXI-CTX-011).
      const scope = scopes.get(frame.id);
      if (scope) return scope.contains(id);
      return scopeAnswers.get(frame.id)?.get(key) ?? false;
    },
    async checkScope(ids) {
      const frame = top();
      if (!frame) return ids.map(() => true);
      const rootKey = elementKey(frame.scopeRoot);
      const fallback = () => ids.map((id) => elementKey(id) === rootKey);
      // The whole scope first (it also answers `isInScope` afterwards);
      // the client caches it until the document changes.
      const scope = await fetchScope(frame);
      if (scope)
        return ids.map(
          (id) => elementKey(id) === rootKey || scope.contains(id),
        );
      const query = env.scopeQuery;
      if (!query || ids.length === 0) return fallback();
      let answer: readonly boolean[];
      try {
        answer = await query(frame.scopeRoot, ids);
      } catch {
        return fallback();
      }
      if (answer.length !== ids.length) return fallback();
      const out = ids.map(
        (id, i) => answer[i] === true || elementKey(id) === rootKey,
      );
      // Remember it for the synchronous `isInScope` while the frame lives.
      if (state.frames.some((f) => f.id === frame.id)) {
        const known = scopeAnswers.get(frame.id) ?? new Map<string, boolean>();
        ids.forEach((id, i) => known.set(elementKey(id), out[i]!));
        scopeAnswers.set(frame.id, known);
      }
      return out;
    },
  };
}

/** The whole-scope read of a client that has one (EN5, protocol 80,
 *  `client.editScope`), else null. */
export function editScopeOf(
  client: unknown,
): ((root: ElementId) => Promise<EditScopeLike>) | null {
  const c = client as {
    editScope?: (root: ElementId) => Promise<EditScopeLike>;
  } | null;
  if (!c || typeof c.editScope !== "function") return null;
  return (root) => c.editScope!(root);
}

/** The scope query of a client that has one (EN5, protocol 80), else
 *  null: `isInScope` then knows the entered root only. Accepts the answer
 *  as an array or as `{ contains }`. */
export function scopeQueryOf(client: unknown): ScopeQuery | null {
  const c = client as {
    scopeContains?: (
      root: ElementId,
      ids: readonly ElementId[],
    ) => Promise<readonly boolean[] | { contains: readonly boolean[] }>;
  } | null;
  if (!c || typeof c.scopeContains !== "function") return null;
  return async (root, ids) => {
    const reply = await c.scopeContains!(root, ids);
    return Array.isArray(reply)
      ? (reply as readonly boolean[])
      : (reply as { contains: readonly boolean[] }).contains;
  };
}

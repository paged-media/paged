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

// The interaction coordinator (the interaction specification, §3.2,
// `UXI-STATE-001`; editor ADR "The interaction coordinator").
//
// One per editor instance (an editor-scope store): it holds the SESSION
// that owns the pointer, the EPOCHS a late answer is checked against, and
// the TRACE of what it decided. It decides nothing about what a press
// means — the canvas and the tools still do — but every pointer sequence
// is a session it knows about, so one place can end them all:
//
//   const s = coordinator.begin({ owner: "canvas-transform", kind: "translate",
//     pointerId, mutating: true, onAbort: (why) => rollBack(why) });
//   if (!s) return;                       // another owner holds the pointer
//   coordinator.transition(s, "previewing");
//   …
//   coordinator.end(s, "commit");         // or "cancel"
//
// `abortAll(reason)` is what a terminal event calls — a lost pointer
// capture, a window blur, a hidden page, unmount, a document switch, a
// tool switch (§7.2): each open session's `onAbort` rolls its owner back,
// and the session ends exactly once (`UXI-INV-002`, `UXI-GST-007`).
//
// A request whose answer comes back later records a TOKEN; the answer is
// applied only while the token is current (`guard`, `isCurrent`): no new
// press since, no other document, no other context, its session not
// aborted (`UXI-OWN-008`, `UXI-ASY-002`, `UXI-INV-005`, `UXI-INV-015`).

import { scoped, useScoped, type EditorScope } from "../state/editor-scope";
import { debugHandlesEnabled } from "../state/debug-handles";
import { createEpochs, type EpochKind, type EpochSnapshot } from "./epochs";
import {
  ownerRank,
  PHASE_EDGES,
  POINTER_PHASES,
  type InteractionOwner,
  type InteractionPhase,
} from "./owners";
import { createTrace, type InteractionTrace, type TraceEntry } from "./trace";

/** What `guard` resolves to for an answer that came too late. */
export const STALE: unique symbol = Symbol.for("paged.interaction.stale");
export type Stale = typeof STALE;

/** How a session ended. */
export type EndResult = "commit" | "cancel" | "abort";

export interface SessionSpec {
  owner: InteractionOwner;
  /** What the owner calls this sequence (`marquee`, `translate`,
   *  `tool`): a fixed diagnostic word. */
  kind?: string;
  /** The effective tool's id, a registry key. */
  toolId?: string;
  pointerId?: number;
  pointerType?: string;
  /** Does the sequence change the document (a move, a draw)? A
   *  spring-loaded tool waits while one is active (D-09). */
  mutating?: boolean;
  /** The first phase (default `pressed`). */
  phase?: "pressed" | "pending-hit";
  /** Take the pointer from whoever holds it (a pinch over a pending
   *  press). Default: only a higher-ranked owner (§3.4) does. */
  preempt?: boolean;
  /** The owner's own roll-back, called when the session is ended from
   *  OUTSIDE (`cancel`, `abortAll`): a lost capture, Escape, a blur, a
   *  document or tool switch, unmount. Not called by `end`. */
  onAbort?: (reason: string) => void;
}

export interface InteractionSession {
  readonly id: string;
  readonly owner: InteractionOwner;
  readonly kind: string;
  readonly toolId: string | undefined;
  readonly pointerId: number | undefined;
  readonly pointerType: string | undefined;
  readonly mutating: boolean;
  /** The epochs when the session began. */
  readonly epochs: EpochSnapshot;
  /** Aborted when the session is cancelled or aborted. */
  readonly signal: AbortSignal;
  readonly phase: InteractionPhase;
  readonly ended: boolean;
  readonly result: EndResult | null;
}

/** What a late answer is checked against. */
export interface GuardToken {
  readonly label: string;
  readonly epochs: EpochSnapshot;
  readonly session: InteractionSession | null;
}

/** The pointer holder, as a component reads it. */
export interface ActiveSessionView {
  readonly id: string;
  readonly owner: InteractionOwner;
  readonly kind: string;
  readonly phase: InteractionPhase;
  readonly mutating: boolean;
  readonly toolId: string | undefined;
}

export interface InteractionSnapshot {
  /** The session holding the pointer, or null. */
  readonly active: ActiveSessionView | null;
  /** Every open session, the committing ones included. */
  readonly open: number;
  readonly doc: number;
  readonly context: number;
}

export interface InteractionCoordinator {
  /** Open a session, or null when another owner holds the pointer and
   *  this claim may not take it (`UXI-INV-001`). Begins a new input
   *  epoch: answers earlier presses wait for go stale. */
  begin(spec: SessionSpec): InteractionSession | null;
  /** Move a session along a legal edge of §3.3; false (and traced) for
   *  an illegal one or an ended session. */
  transition(session: InteractionSession, phase: InteractionPhase): boolean;
  /** The owner ends its own session. Idempotent: false when it had
   *  already ended (`UXI-GST-007`). */
  end(session: InteractionSession, result: EndResult, reason?: string): boolean;
  /** End a session from outside: its `onAbort` rolls it back first.
   *  `result` is "cancel" for an explicit reversal (Escape), "abort" for
   *  an interruption (the default). */
  cancel(
    session: InteractionSession,
    reason: string,
    result?: "cancel" | "abort",
  ): boolean;
  /** End every open session from outside; returns how many ended. */
  abortAll(reason: string): number;
  /** The session holding the pointer, or null. */
  current(): InteractionSession | null;
  /** Every open session (a committing one has let the pointer go). */
  sessions(): readonly InteractionSession[];
  /** Is a document-changing session holding the pointer? */
  mutatingActive(): boolean;
  isIdle(): boolean;
  /** Resolves once no session is open (at once when none is). */
  whenIdle(): Promise<void>;
  /** A token for a request answered later; `session` ties it to one. */
  token(label: string, session?: InteractionSession | null): GuardToken;
  /** Is the answer to `token`'s request still wanted? */
  isCurrent(token: GuardToken): boolean;
  /** `isCurrent`, tracing `stale <label> discarded` when it is not: for an
   *  answer checked between the steps of a chain. */
  confirm(token: GuardToken): boolean;
  /** `promise`'s value while `token` is current, else `STALE` (traced). */
  guard<T>(token: GuardToken, promise: Promise<T>): Promise<T | Stale>;
  /** A document was loaded, replaced or closed: every session aborts
   *  first, then the document epoch moves on (§7.2). */
  documentChanged(reason: string): void;
  /** An edit context was entered or left. */
  contextChanged(reason: string): void;
  /** The camera moved. */
  cameraChanged(): void;
  /** Record that a claim was put off (D-09's spring-load). */
  deferred(reason: string, owner?: InteractionOwner): void;
  epochs(): EpochSnapshot;
  /** An immutable view, replaced on every change (useSyncExternalStore). */
  snapshot(): InteractionSnapshot;
  subscribe(listener: () => void): () => void;
  readonly trace: InteractionTrace;
}

interface MutableSession extends InteractionSession {
  phase: InteractionPhase;
  ended: boolean;
  result: EndResult | null;
  readonly controller: AbortController;
  readonly onAbort: ((reason: string) => void) | undefined;
  readonly startedAt: number;
}

export interface CoordinatorOptions {
  /** Record a trace (development and demo builds). */
  trace?: boolean;
  now?: () => number;
}

export function createInteractionCoordinator(
  options: CoordinatorOptions = {},
): InteractionCoordinator {
  const now = options.now ?? (() => performance.now());
  const epochs = createEpochs();
  const trace = createTrace(options.trace ?? false, now);
  const open: MutableSession[] = [];
  const listeners = new Set<() => void>();
  let idleWaiters: Array<() => void> = [];
  let nextId = 1;
  let view: InteractionSnapshot | null = null;

  const doc = () => epochs.now().doc;
  const holder = (): MutableSession | null =>
    open.find((s) => POINTER_PHASES.has(s.phase)) ?? null;

  const changed = () => {
    view = null;
    for (const l of [...listeners]) l();
  };

  const settle = () => {
    if (open.length > 0) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const w of waiters) w();
  };

  const record = (
    event: TraceEntry["event"],
    s: MutableSession | null,
    extra: Partial<Omit<TraceEntry, "t" | "event" | "doc">> = {},
  ) =>
    trace.record({
      event,
      doc: doc(),
      ...(s
        ? {
            id: s.id,
            owner: s.owner,
            phase: s.phase,
            ...(s.toolId ? { tool: s.toolId } : {}),
            ...(s.pointerType ? { pointerType: s.pointerType } : {}),
          }
        : {}),
      ...extra,
    });

  const coordinator: InteractionCoordinator = {
    begin(spec) {
      const held = holder();
      if (held) {
        const takes =
          spec.preempt ?? ownerRank(spec.owner) < ownerRank(held.owner);
        if (!takes) {
          record("refused", held, {
            reason: `claim refused: ${spec.owner} while ${held.owner} holds the pointer`,
          });
          return null;
        }
        coordinator.cancel(held, `preempted by ${spec.owner}`);
      }
      epochs.bump("input");
      const controller = new AbortController();
      const s: MutableSession = {
        id: `i-${nextId++}`,
        owner: spec.owner,
        kind: spec.kind ?? spec.owner,
        toolId: spec.toolId,
        pointerId: spec.pointerId,
        pointerType: spec.pointerType,
        mutating: spec.mutating ?? false,
        epochs: epochs.now(),
        controller,
        signal: controller.signal,
        phase: spec.phase ?? "pressed",
        ended: false,
        result: null,
        onAbort: spec.onAbort,
        startedAt: now(),
      };
      open.push(s);
      record("begin", s, { reason: s.kind });
      changed();
      return s;
    },

    transition(session, phase) {
      const s = session as MutableSession;
      if (s.ended || !PHASE_EDGES[s.phase].includes(phase)) {
        record("illegal-transition", s, {
          reason: `${s.ended ? "ended" : s.phase} -> ${phase}`,
        });
        return false;
      }
      if (s.phase === phase) return true;
      s.phase = phase;
      record("phase", s);
      changed();
      return true;
    },

    end(session, result, reason) {
      const s = session as MutableSession;
      if (s.ended) return false;
      if (result !== "commit" && s.phase !== "canceling") s.phase = "canceling";
      s.phase = "settled";
      s.ended = true;
      s.result = result;
      if (result !== "commit") s.controller.abort(reason ?? result);
      const i = open.indexOf(s);
      if (i >= 0) open.splice(i, 1);
      record("end", s, {
        result,
        ...(reason ? { reason } : {}),
        latencyMs: Math.round(now() - s.startedAt),
      });
      changed();
      settle();
      return true;
    },

    cancel(session, reason, result = "abort") {
      const s = session as MutableSession;
      if (s.ended) return false;
      try {
        s.onAbort?.(reason);
      } finally {
        coordinator.end(s, result, reason);
      }
      return true;
    },

    abortAll(reason) {
      const all = open.slice();
      if (all.length === 0) return 0;
      record("abort-all", null, { reason });
      let n = 0;
      for (const s of all) if (coordinator.cancel(s, reason)) n++;
      return n;
    },

    current: () => holder(),
    sessions: () => open.slice(),
    mutatingActive: () => holder()?.mutating === true,
    isIdle: () => open.length === 0,
    whenIdle() {
      if (open.length === 0) return Promise.resolve();
      return new Promise<void>((resolve) => idleWaiters.push(resolve));
    },

    token(label, session = null) {
      return { label, epochs: epochs.now(), session };
    },

    isCurrent(token) {
      if (!epochs.holds(token.epochs)) return false;
      const s = token.session as MutableSession | null;
      return !s || !s.controller.signal.aborted;
    },

    confirm(token) {
      if (coordinator.isCurrent(token)) return true;
      record("stale", (token.session as MutableSession | null) ?? null, {
        reason: `stale ${token.label} discarded`,
      });
      return false;
    },

    guard<T>(token: GuardToken, promise: Promise<T>): Promise<T | Stale> {
      return promise.then((value) =>
        coordinator.confirm(token) ? value : STALE,
      );
    },

    documentChanged(reason) {
      coordinator.abortAll(reason);
      bump("doc", reason);
      bump("context", reason);
      changed();
    },

    contextChanged(reason) {
      bump("context", reason);
      changed();
    },

    cameraChanged() {
      epochs.bump("camera");
    },

    deferred(reason, owner) {
      record("deferred", null, { reason, ...(owner ? { owner } : {}) });
    },

    epochs: () => epochs.now(),

    snapshot() {
      if (view) return view;
      const h = holder();
      const e = epochs.now();
      view = {
        active: h
          ? {
              id: h.id,
              owner: h.owner,
              kind: h.kind,
              phase: h.phase,
              mutating: h.mutating,
              toolId: h.toolId,
            }
          : null,
        open: open.length,
        doc: e.doc,
        context: e.context,
      };
      return view;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    trace,
  };

  function bump(kind: EpochKind, reason: string) {
    const value = epochs.bump(kind);
    trace.record({
      event: "epoch",
      doc: doc(),
      reason: `${kind} ${value}: ${reason}`,
    });
  }

  return coordinator;
}

/** The coordinator of each editor (one per editor scope). */
export const INTERACTION_COORDINATOR = scoped("interactionCoordinator", () =>
  createInteractionCoordinator({ trace: debugHandlesEnabled() }),
);

/** `scope`'s coordinator. */
export function interactionCoordinatorOf(
  scope: EditorScope,
): InteractionCoordinator {
  return scope.get(INTERACTION_COORDINATOR);
}

/** This component's editor's coordinator. */
export function useInteractionCoordinator(): InteractionCoordinator {
  return useScoped(INTERACTION_COORDINATOR);
}

/** What the page entry shows as `__interaction` in development builds:
 *  the trace and the state, with no user text in either. */
export function interactionDebugView(c: InteractionCoordinator) {
  return {
    trace: () => c.trace.entries(),
    clearTrace: () => c.trace.clear(),
    snapshot: () => c.snapshot(),
    epochs: () => c.epochs(),
    sessions: () =>
      c.sessions().map((s) => ({
        id: s.id,
        owner: s.owner,
        kind: s.kind,
        phase: s.phase,
        mutating: s.mutating,
        toolId: s.toolId,
      })),
  };
}

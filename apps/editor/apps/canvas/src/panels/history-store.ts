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

// Editor ADR 285 — the History panel's store: the engine's named undo
// timeline (engine ADR 1030), read again after every change the client
// reports, and this session's snapshots. One store per client, so every
// mounted History panel of an editor shows the same list and a snapshot
// survives the panel being closed.

import type { UndoLog, WorkerToMain } from "@paged-media/client";
import { changesTheDocument } from "@paged-media/client";

/** The client doors the store needs (a `CanvasClient` has them all). */
export interface HistoryClient {
  subscribe(listener: (msg: WorkerToMain) => void): () => void;
  undoLog(limit?: number): Promise<UndoLog>;
  undoTo(appliedSeq: number): Promise<WorkerToMain>;
  redoTo(appliedSeq: number): Promise<WorkerToMain>;
  restoreTo(appliedSeq: number, label?: string): Promise<WorkerToMain>;
  setHistoryDepth(depth: number): Promise<number>;
}

/** A named checkpoint: the document as it was right after the step
 *  `appliedSeq` (`0`: as opened). */
export interface HistorySnapshot {
  id: number;
  name: string;
  appliedSeq: number;
  /** The step its last restore made: while that step is current, the
   *  document IS the snapshot. */
  restoredSeq: number | null;
}

export interface HistoryState {
  /** The timeline; `null` before the first read or with no document. */
  log: UndoLog | null;
  snapshots: readonly HistorySnapshot[];
  /** The last refusal or failure, in the engine's words. */
  error: string | null;
}

/** How many steps the panel lists (the newest; the engine keeps more). */
export const HISTORY_LIST_LIMIT = 500;

/** The history depths the preference offers (engine ADR 1030's clamp is
 *  1..=10,000). */
export const HISTORY_DEPTHS = [50, 100, 500, 1000, 10000] as const;

export interface HistoryStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): HistoryState;
  /** Read the timeline again. */
  refresh(): Promise<void>;
  /** The step the document is at: the newest undo step's seq, `0` with
   *  none. */
  current(): number;
  /** Go to the state right after the undo step at `index` of `log.undo`
   *  (`-1`: before every listed step). One engine round trip. */
  goToUndo(index: number): Promise<void>;
  /** Redo up to and including the redo step at `index` of `log.redo`. */
  goToRedo(index: number): Promise<void>;
  /** Remember the current state as a snapshot named `name`. */
  takeSnapshot(name: string): HistorySnapshot;
  /** Is the document the snapshot right now? */
  isCurrent(s: HistorySnapshot): boolean;
  /** Can the snapshot still be reached from the timeline? */
  reachable(s: HistorySnapshot): boolean;
  /** Restore a snapshot as ONE new undo step (`label` names it). */
  restoreSnapshot(id: number, label: string): Promise<void>;
  deleteSnapshot(id: number): void;
  setDepth(depth: number): Promise<number>;
}

const stores = new WeakMap<HistoryClient, HistoryStore>();

/** The store of `client`, made on first use. */
export function historyStoreOf(client: HistoryClient): HistoryStore {
  let store = stores.get(client);
  if (!store) {
    store = createHistoryStore(client);
    stores.set(client, store);
  }
  return store;
}

const refusal = (reply: WorkerToMain): string | null => {
  if (reply.kind !== "mutationFailed") return null;
  const e = reply.payload.error as { kind?: string; details?: unknown };
  const d = e.details as { what?: string } | string | undefined;
  return typeof d === "string" ? d : (d?.what ?? e.kind ?? "refused");
};

export function createHistoryStore(client: HistoryClient): HistoryStore {
  let state: HistoryState = { log: null, snapshots: [], error: null };
  const listeners = new Set<() => void>();
  let nextId = 1;
  let reading = 0;
  let unsubscribe: (() => void) | null = null;

  const set = (next: Partial<HistoryState>) => {
    state = { ...state, ...next };
    for (const l of [...listeners]) l();
  };

  const refresh = async () => {
    const ticket = ++reading;
    try {
      const log = await client.undoLog(HISTORY_LIST_LIMIT);
      // A later read wins: replies of an older one are dropped.
      if (ticket === reading) set({ log });
    } catch {
      if (ticket === reading) set({ log: null });
    }
  };

  const onMessage = (msg: WorkerToMain) => {
    if (msg.kind === "documentLoaded") {
      // A snapshot names a step of the document it was taken in.
      nextId = 1;
      set({ snapshots: [], error: null });
    }
    // A step named after its write (`labelStep`) changes the list too.
    if (changesTheDocument(msg) || msg.kind === "stepLabeled") void refresh();
  };

  const run = async (reply: Promise<WorkerToMain>) => {
    const r = await reply;
    set({ error: refusal(r) });
    // The change itself also reaches `onMessage`; reading here as well
    // keeps a caller that awaits the step in step with the list.
    await refresh();
  };

  const current = () => state.log?.undo.at(-1)?.appliedSeq ?? 0;
  const isCurrent = (s: HistorySnapshot) =>
    s.appliedSeq === current() || s.restoredSeq === current();

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (!unsubscribe) {
        unsubscribe = client.subscribe(onMessage);
        void refresh();
      }
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => state,
    refresh,
    current,
    async goToUndo(index) {
      const undo = state.log?.undo ?? [];
      // The state after step `index` is reached by undoing the next one.
      const next = undo[index + 1];
      if (!next) return;
      await run(client.undoTo(next.appliedSeq));
    },
    async goToRedo(index) {
      const step = state.log?.redo[index];
      if (!step) return;
      await run(client.redoTo(step.appliedSeq));
    },
    takeSnapshot(name) {
      const s: HistorySnapshot = {
        id: nextId++,
        name,
        appliedSeq: current(),
        restoredSeq: null,
      };
      set({ snapshots: [...state.snapshots, s] });
      return s;
    },
    reachable(s) {
      const log = state.log;
      if (!log) return false;
      if (s.appliedSeq === 0) {
        // The opened document is behind the oldest step only while the
        // depth evicted none.
        return log.evicted === 0 && log.undoLen > 0;
      }
      return (
        log.undo.some((e) => e.appliedSeq === s.appliedSeq) ||
        log.redo.some((e) => e.appliedSeq === s.appliedSeq)
      );
    },
    async restoreSnapshot(id, label) {
      const s = state.snapshots.find((x) => x.id === id);
      if (!s || isCurrent(s)) return;
      const reply = await client.restoreTo(s.appliedSeq, label);
      if (reply.kind === "mutationApplied") {
        const restoredSeq = reply.payload.appliedSeq;
        set({
          snapshots: state.snapshots.map((x) =>
            x.id === id ? { ...x, restoredSeq } : x,
          ),
        });
      }
      set({ error: refusal(reply) });
      await refresh();
    },
    isCurrent,
    deleteSnapshot(id) {
      set({ snapshots: state.snapshots.filter((s) => s.id !== id) });
    },
    async setDepth(depth) {
      const applied = await client.setHistoryDepth(depth);
      await refresh();
      return applied;
    },
  };
}

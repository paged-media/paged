// The session snapshot a panel renders, kept current: the panel re-reads it
// whenever the session says it changed (a restore landing after the panel
// mounted, a diagnostic from a background step, a save). `refresh` re-reads it
// after an action the panel itself started.
//
// The third element is a view of the session (react-live), renewed with the
// snapshot: what a panel reads from the session itself while rendering
// (`listBindings()`, `getLocale()`) goes through it, so a memo over it, the
// React Compiler's included, recomputes with the snapshot (editor ADR 229).

import { freshView } from "@paged-media/react-live";
import { useMemo, useSyncExternalStore } from "react";

import type { DataSourceSession, SessionState } from "../session";

interface Read {
  state: SessionState;
  view: DataSourceSession;
}

// A panel the dock hides sits in a hidden <Activity> (editor ADR 240): its
// effects are unmounted, so a subscription made in an effect misses every
// change while it is hidden and shows the old snapshot when it is shown
// again (a source imported while Dataset preview was a background tab). So
// every session carries ONE counter, bumped by a listener that lives as long
// as the session; a panel reads the counter through useSyncExternalStore,
// which compares it again whenever the panel subscribes.
interface Changes {
  count: number;
  subscribe(onChange: () => void): () => void;
  current(): number;
  bump(): void;
}

const changes = new WeakMap<DataSourceSession, Changes>();

function changesOf(session: DataSourceSession): Changes {
  const known = changes.get(session);
  if (known) return known;
  const listeners = new Set<() => void>();
  const c: Changes = {
    count: 0,
    subscribe(onChange) {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    current: () => c.count,
    bump() {
      c.count += 1;
      for (const l of [...listeners]) l();
    },
  };
  session.onDidChange(() => c.bump());
  changes.set(session, c);
  return c;
}

function readSession(session: DataSourceSession, _count: number): Read {
  return { state: session.getState(), view: freshView(session) };
}

export function useSessionSnapshot(
  session: DataSourceSession,
): [SessionState, () => void, DataSourceSession] {
  const c = changesOf(session);
  const count = useSyncExternalStore(c.subscribe, c.current);
  const read = useMemo(() => readSession(session, count), [session, count]);
  return [read.state, c.bump, read.view];
}

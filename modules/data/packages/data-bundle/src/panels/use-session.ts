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

function readSession(session: DataSourceSession): Read {
  return { state: session.getState(), view: freshView(session) };
}

/** The session as an external store. A dock tab the user is not looking at
 *  sits in a hidden <Activity>, which keeps the component's state but
 *  unmounts its subscription, so a change made while it was hidden (a save,
 *  a whole document opened) was never heard: the tab showed the old session
 *  until something else happened to change. React reads the snapshot again
 *  when it subscribes, and a fresh subscription marks it stale, because
 *  anything may have changed while nobody listened. */
function sessionStore(session: DataSourceSession) {
  let current = readSession(session);
  let stale = false;
  const listeners = new Set<() => void>();
  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      const sub = session.onDidChange(() => {
        stale = true;
        listener();
      });
      stale = true;
      return () => {
        listeners.delete(listener);
        sub.dispose();
      };
    },
    read(): Read {
      if (stale) {
        stale = false;
        current = readSession(session);
      }
      return current;
    },
    refresh(): void {
      stale = true;
      for (const l of [...listeners]) l();
    },
  };
}

export function useSessionSnapshot(
  session: DataSourceSession,
): [SessionState, () => void, DataSourceSession] {
  const store = useMemo(() => sessionStore(session), [session]);
  const read = useSyncExternalStore(store.subscribe, store.read);
  return [read.state, store.refresh, read.view];
}

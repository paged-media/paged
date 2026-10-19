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
import { useEffect, useState } from "react";

import type { DataSourceSession, SessionState } from "../session";

interface Read {
  state: SessionState;
  view: DataSourceSession;
}

function readSession(session: DataSourceSession): Read {
  return { state: session.getState(), view: freshView(session) };
}

export function useSessionSnapshot(
  session: DataSourceSession,
): [SessionState, () => void, DataSourceSession] {
  const [read, setRead] = useState(() => readSession(session));
  useEffect(() => {
    const sub = session.onDidChange(() => setRead(readSession(session)));
    return () => sub.dispose();
  }, [session]);
  return [read.state, () => setRead(readSession(session)), read.view];
}

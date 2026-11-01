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
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

// Editor ADR 291 — View ▸ Show data markers: which frames the document's
// data is placed in, and whether each is in step with the data.

// Engine ADR 1055 — which comment thread the user is looking at. A pin on the
// canvas sets it, the Comments panel reads it (and scrolls to the thread), and
// the panel's own click sets it back. A store in the editor's scope, like the
// view toggles: the writer is an overlay's click and the reader a panel, with
// no provider between them, and it lasts as long as the editor.

import { scoped, type EditorScope } from "./editor-scope";

type Listener = () => void;

const FOCUS = scoped("commentFocus", () => ({
  thread: null as string | null,
  listeners: new Set<Listener>(),
}));

export function getFocusedThread(scope: EditorScope): string | null {
  return scope.get(FOCUS).thread;
}

/** Focus a thread by its id (a thread's id is its root comment's), or none. */
export function focusThread(scope: EditorScope, id: string | null): void {
  const state = scope.get(FOCUS);
  if (state.thread === id) return;
  state.thread = id;
  for (const l of [...state.listeners]) l();
}

export function subscribeFocusedThread(
  scope: EditorScope,
  listener: Listener,
): () => void {
  const { listeners } = scope.get(FOCUS);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

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

// The open document's save state, per editor (editor ADR 1203). The
// machine is the repository package's (`save-state.ts`, pure); this holds
// one store of it in the editor's scope. What the shell knows (which
// document is open and where it came from, its dirty flag, whether this
// editor may save) is fed in by `SaveStateController`; the save itself
// (the app's File ▸ Save) reports its steps through `saveStateOf`; the
// header's `SaveStatus` reads it.

import {
  createSaveStateStore,
  needsSave,
  type DocumentOrigin,
  type SaveState,
  type SaveStateStore,
} from "@paged-media/repository";
import { useSyncExternalStore } from "react";

import { scoped, useEditorScope, type EditorScope } from "./editor-scope";

interface SaveStateSlot {
  readonly store: SaveStateStore;
  /** The origin the next document to open declares (a recovery restore
   *  says so before it loads); taken once by the controller. */
  nextOrigin: DocumentOrigin | null;
}

const SAVE_STATE = scoped("saveState", (): SaveStateSlot => ({
  store: createSaveStateStore(),
  nextOrigin: null,
}));

/** `scope`'s save-state store: the save reports into it. */
export function saveStateOf(scope: EditorScope): SaveStateStore {
  return scope.get(SAVE_STATE).store;
}

/** The next document to open in `scope` comes from `origin` (a restore
 *  from the recovery journal); null withdraws it. */
export function declareNextOrigin(
  scope: EditorScope,
  origin: DocumentOrigin | null,
): void {
  scope.get(SAVE_STATE).nextOrigin = origin;
}

/** The origin a restore declared for the document that just opened, once. */
export function takeNextOrigin(scope: EditorScope): DocumentOrigin | null {
  const slot = scope.get(SAVE_STATE);
  const origin = slot.nextOrigin;
  slot.nextOrigin = null;
  return origin;
}

/** Must `scope`'s document be saved before it is replaced or the page is
 *  left: dirty, or restored from the journal and not saved since. */
export function documentNeedsSave(scope: EditorScope): boolean {
  return needsSave(saveStateOf(scope).get());
}

/** This editor's save state, re-read when it changes. */
export function useSaveState(): SaveState {
  const store = saveStateOf(useEditorScope());
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

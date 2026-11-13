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

// Tells the save state (editor ADR 1203) what the shell knows. A new
// document (its `docId`) is `opened`, from the origin a restore declared,
// else from its file name, else blank; nothing open is `closed`; the dirty
// flag and the session's role follow.

import type { DocumentOrigin } from "@paged-media/repository";
import { useEffect, useEffectEvent } from "react";

import { useDocumentMeta } from "../catalog/use-collection";
import { useDocument } from "./document-context";
import { useEditorScope } from "./editor-scope";
import { saveStateOf, takeNextOrigin } from "./save-status";
import { useSessionRole } from "./session-role";

export function SaveStateController() {
  const scope = useEditorScope();
  const store = saveStateOf(scope);
  const { handle, sourceName } = useDocument();
  const meta = useDocumentMeta();
  const role = useSessionRole();
  const docId = handle?.docId ?? null;
  const dirty = meta?.dirty ?? false;

  const originNow = useEffectEvent(
    (): DocumentOrigin =>
      takeNextOrigin(scope) ??
      (sourceName ? { kind: "opened", name: sourceName } : { kind: "blank" }),
  );

  useEffect(() => {
    if (docId === null) {
      store.dispatch({ type: "closed" });
      return;
    }
    store.dispatch({ type: "opened", origin: originNow(), at: Date.now() });
  }, [store, docId]);

  // Keyed on the document too: a new document starts clean, then reads
  // its own flag.
  useEffect(() => {
    if (docId !== null) store.dispatch({ type: "dirty", dirty });
  }, [store, docId, dirty]);

  useEffect(() => {
    store.dispatch({
      type: "read-only",
      reason: role === "viewer" ? "viewer" : null,
    });
  }, [store, role]);

  return null;
}

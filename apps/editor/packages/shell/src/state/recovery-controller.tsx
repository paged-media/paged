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

// When the recovery journal keeps a checkpoint (editor ADR 1204):
//
//   · when editing pauses for IDLE_MS after an accepted operation;
//   · after EVERY_OPS accepted operations, even while editing goes on;
//   · when the page is hidden (it may not come back);
//   · before an edited document is replaced (the replace guard runs it).
//
// Never more often than MIN_INTERVAL_MS apart, except before a replace: a
// checkpoint writes the whole document out, in the worker, so it is not
// taken while the user is in the middle of something. Accepted operations
// are the client's own count (`editMark`: mutations, undo, redo, committed
// gestures, script results, plugin part writes).

import { useEffect, useEffectEvent } from "react";
import { t } from "@paged-media/strings";

import { useDocumentMeta } from "../catalog/use-collection";
import { HEADER } from "../chrome/messages";
import { useCanvasClient } from "./canvas-client-context";
import { useDocument } from "./document-context";
import { useEditorScope } from "./editor-scope";
import { resetEditBase, writeCheckpoint } from "./recovery";
import { setBeforeReplace } from "./replace-guard";

export const IDLE_MS = 3_000;
export const EVERY_OPS = 40;
export const MIN_INTERVAL_MS = 15_000;

export function RecoveryController() {
  const scope = useEditorScope();
  const client = useCanvasClient();
  const { handle, sourceName } = useDocument();
  const meta = useDocumentMeta();
  const docId = handle?.docId ?? null;

  const facts = useEffectEvent(() => ({
    name: meta?.documentName || sourceName || t(HEADER.untitled),
    pages: handle?.pageCount ?? null,
  }));

  useEffect(() => {
    let seen = client.editMark;
    let pending = 0;
    let lastWrite = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const clear = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    const write = (reason: "idle" | "operations" | "hidden") => {
      clear();
      pending = 0;
      lastWrite = Date.now();
      void writeCheckpoint(scope, client, { reason, ...facts() });
    };
    const schedule = () => {
      clear();
      const wait = Math.max(IDLE_MS, lastWrite + MIN_INTERVAL_MS - Date.now());
      timer = setTimeout(() => {
        timer = null;
        if (pending > 0) write("idle");
      }, wait);
    };
    const off = client.subscribe(() => {
      const mark = client.editMark;
      if (mark === seen) return;
      pending += Math.max(1, mark - seen);
      seen = mark;
      if (pending >= EVERY_OPS && Date.now() - lastWrite >= MIN_INTERVAL_MS)
        write("operations");
      else schedule();
    });
    // A save: the work is persisted, the next checkpoint counts from here.
    const offSaved = client.onSaved(() => {
      clear();
      pending = 0;
      seen = client.editMark;
      resetEditBase(scope, client.editMark);
    });
    const onVisibility = () => {
      if (document.visibilityState === "hidden" && pending > 0) write("hidden");
    };
    document.addEventListener("visibilitychange", onVisibility);
    const offBefore = setBeforeReplace(scope, () =>
      writeCheckpoint(scope, client, { reason: "before-replace", ...facts() }),
    );
    return () => {
      clear();
      off();
      offSaved();
      offBefore();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [scope, client]);

  // Another document: its edits count from its opening.
  useEffect(() => {
    if (docId !== null) resetEditBase(scope, client.editMark);
  }, [scope, client, docId]);

  return null;
}

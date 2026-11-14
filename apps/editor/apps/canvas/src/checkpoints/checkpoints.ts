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

// Publication time travel (editor ADR 1234; the UX strategy's Concept H):
// named checkpoints on the document's own repository (the local library,
// ADR 225). A checkpoint keeps the open document's state as it is — saved
// or not — as a commit on the person's checkpoints ref, never on main: it
// is no save and never moves the saved version (ADR 1204). The timeline is
// the import ("Imported annual.idml"), the checkpoints the person names
// ("Typography pass"), and those kept automatically after an export
// ("Exported annual.pdf") and before an operation that replaces the open
// document ("Before restoring …", "Before promoting …"); the approval of the
// publication contract keeps one too ("Approved", ADR 1236). Bounded by the
// recovery journal's rules: a state over 256 MB is not kept, automatic
// checkpoints beyond 20 leave the timeline oldest first, named ones beyond
// 100 are refused.
//
// Restoring one is a NEW state: the open document is kept first ("Before
// restoring …"), then the checkpoint's state becomes main's newest version
// ("Restore …") and opens. Nothing is overwritten and nothing rewinds.

import { useEffect } from "react";

import type { CheckpointEntry, CheckpointKind } from "@paged-media/repository";
import {
  currentLibraryDocument,
  getLibrary,
  operationFeedbackOf,
  openLibraryDocument,
  useEditorScope,
  usePaged,
  type EditorScope,
  type PagedEditor,
} from "@paged-media/shell";
import { defineMessages, t } from "@paged-media/strings";

const M = defineMessages("app.checkpoints", {
  notInLibrary:
    "Save the document first: checkpoints are kept with its versions in the library.",
  noLibrary: "The library is not available here.",
  tooLarge: "The document is larger than a checkpoint may be (256 MB).",
  tooMany:
    "This document already keeps 100 named checkpoints: remove one first.",
  keep: "keep the checkpoint {name}",
  kept: "Checkpoint kept: {name}",
  exported: "Exported: {what}",
  beforeRestore: "Before restoring {name}",
  restore: "restore {name}",
  restored:
    "{name} is the newest version now. What was open is kept as the checkpoint {before}.",
  approved: "Approved",
});

export const CHECKPOINT_WORDS = M;

/** Why a checkpoint could not be kept, in words. */
export function checkpointRefusal(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/too-large/.test(message)) return t(M.tooLarge);
  if (/too-many/.test(message)) return t(M.tooMany);
  return message;
}

/** Keep the open document's state as a checkpoint named `name`. Throws a
 *  worded error when it cannot be kept. */
export async function keepCheckpoint(
  paged: PagedEditor,
  name: string,
  kind: CheckpointKind,
): Promise<CheckpointEntry> {
  const library = getLibrary(paged.scope);
  if (!library) throw new Error(t(M.noLibrary));
  const doc = currentLibraryDocument(paged.scope);
  if (!doc) throw new Error(t(M.notInLibrary));
  const bytes = await paged.client.exportPaged();
  try {
    return await library.checkpoint(doc.id, bytes, {
      name,
      kind,
      ...(paged.document.handle
        ? { pages: paged.document.handle.pageCount }
        : {}),
    });
  } catch (err) {
    throw new Error(checkpointRefusal(err));
  }
}

/** Keep a checkpoint and say so (a named one), or say why not. */
export async function keepCheckpointReported(
  paged: PagedEditor,
  name: string,
  kind: CheckpointKind = "named",
): Promise<CheckpointEntry | null> {
  const feedback = operationFeedbackOf(paged.scope);
  try {
    const entry = await keepCheckpoint(paged, name, kind);
    feedback.report({
      action: t(M.keep, { name }),
      outcome: "success",
      title: t(M.kept, { name }),
      key: "paged.checkpoints|keep",
      source: "paged.checkpoints",
    });
    return entry;
  } catch (err) {
    feedback.report({
      action: t(M.keep, { name }),
      outcome: "blocked",
      reason: err instanceof Error ? err.message : String(err),
      document: "unchanged",
      key: "paged.checkpoints|keep",
      source: "paged.checkpoints",
    });
    return null;
  }
}

/** Keep the open document before an operation replaces it ("Before …").
 *  Quiet; false when it could not be kept (the caller decides whether to
 *  go on). */
export async function keepBefore(
  paged: PagedEditor,
  name: string,
): Promise<boolean> {
  try {
    await keepCheckpoint(paged, name, "before");
    return true;
  } catch {
    return false;
  }
}

/** Make `entry`'s state the newest version, as a new state: the open
 *  document is kept first, then the checkpoint is restored onto main and
 *  opened. Resolves false when nothing changed. */
export async function restoreCheckpointAsNew(
  paged: PagedEditor,
  entry: CheckpointEntry,
): Promise<boolean> {
  const scope = paged.scope;
  const feedback = operationFeedbackOf(scope);
  const library = getLibrary(scope);
  const doc = currentLibraryDocument(scope);
  const action = t(M.restore, { name: entry.name });
  if (!library || !doc) {
    feedback.report({
      action,
      outcome: "blocked",
      reason: t(library ? M.notInLibrary : M.noLibrary),
      document: "unchanged",
      source: "paged.checkpoints",
    });
    return false;
  }
  const before = t(M.beforeRestore, { name: entry.name });
  if (!(await keepBefore(paged, before))) {
    feedback.report({
      action,
      outcome: "blocked",
      reason: t(M.notInLibrary),
      document: "unchanged",
      source: "paged.checkpoints",
    });
    return false;
  }
  await library.restoreCheckpoint(doc.id, entry.id);
  const opened = await openLibraryDocument(paged, doc, {
    action,
    confirmed: true,
  });
  if (opened)
    feedback.report({
      action,
      outcome: "success",
      prominent: true,
      title: t(M.restored, { name: entry.name, before }),
      actions: [],
      key: "paged.checkpoints|restore",
      source: "paged.checkpoints",
    });
  return opened;
}

/** Keep a checkpoint after every export the editor reports (the guided PDF
 *  export, an exporter's file, the page images): "Exported: <file>".
 *  Mounted once, by the canvas app. */
export function useAutomaticCheckpoints(): void {
  const scope = useEditorScope();
  const paged = usePaged();
  useEffect(() => watchExports(scope, () => paged), [scope, paged]);
}

/** Watch `scope`'s feedback for successful exports; keep a checkpoint for
 *  each. Answers the unsubscribe. */
export function watchExports(
  scope: EditorScope,
  editor: () => PagedEditor,
): () => void {
  const feedback = operationFeedbackOf(scope);
  let seen = feedback.snapshot().log.length;
  let last = feedback.snapshot().log.at(-1);
  return feedback.subscribe(() => {
    const log = feedback.snapshot().log;
    // The log is bounded: find where the new entries start.
    const from = last ? log.lastIndexOf(last) + 1 : Math.min(seen, log.length);
    const fresh = log.slice(from > 0 ? from : 0);
    seen = log.length;
    last = log.at(-1);
    for (const r of fresh) {
      if (r.source !== "paged.export" || r.outcome !== "success") continue;
      // "Exported annual.pdf · 4 pages · in your downloads": its first part.
      const name = r.title
        ? r.title.split(" · ")[0]!
        : t(M.exported, { what: r.action });
      void keepCheckpoint(editor(), name.slice(0, 80), "export").catch(
        () => undefined,
      );
    }
  });
}

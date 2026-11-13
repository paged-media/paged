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

// The recovery journal, as one editor uses it (editor ADR 1204; the UX
// strategy's §6.2; interaction spec UXI-MUT-008 to UXI-MUT-010). The
// journal itself is the repository package's (`recovery.ts`); the app
// begins this editor's session and hands it over (`attachRecovery`), with
// the checkpoints an earlier session left behind. From here:
//
//   · `writeCheckpoint` keeps the open document's unsaved work in the
//     session (the controller calls it when editing pauses, every N
//     operations, when the page is hidden, and before the document is
//     replaced);
//   · `purgeCheckpoints` drops it once the work is saved or the document
//     is closed;
//   · the offers (`recoveryOffers`) are what the prompt shows: Restore
//     recovered work, Compare with the saved document, Discard.
//
// Restoring NEVER overwrites the source (UXI-MUT-010): the copy opens as a
// new document, "<name> (recovered)", tied to no file and to no library
// document, so its first save makes a new library document and a new file.
// Until it is saved the replace question and the unload guard treat it as
// unsaved work, and the journal keeps it.

import type {
  DocumentOrigin,
  RecoveryCheckpoint,
  RecoveryDocument,
  RecoveryJournal,
  RecoverySession,
  CheckpointReason,
} from "@paged-media/repository";
import type { CanvasClient } from "@paged-media/client";
import { t } from "@paged-media/strings";

import { loadDocumentFile } from "./document-loader";
import { scoped, type EditorScope } from "./editor-scope";
import { currentLibraryDocument } from "./library-document";
import { RECOVERY } from "./messages";
import { getOpenFileHandle, setOpenFileHandle } from "./open-file-handle";
import type { PagedEditor } from "./paged-editor";
import { confirmReplace } from "./replace-guard";
import {
  declareNextOrigin,
  documentNeedsSave,
  saveStateOf,
} from "./save-status";

/** What the app hands over when it begins this editor's session. */
export interface RecoveryAttachment {
  journal: RecoveryJournal;
  session: RecoverySession;
  /** The open document's identity (editor ADR 264). */
  identify(): { key: string; stable: boolean };
  /** Checkpoints of sessions that ended without a clean close, newest
   *  first, each claimed for this editor (`release` gives it back). */
  offers: { checkpoint: RecoveryCheckpoint; release(): void }[];
}

interface RecoveryState {
  attachment: RecoveryAttachment | null;
  offers: { checkpoint: RecoveryCheckpoint; release(): void }[];
  /** The edit mark the newest checkpoint holds, so an unchanged document
   *  is not written again. */
  checkpointMark: number | null;
  /** The edit mark at the document's last save (or its opening): the
   *  edits a checkpoint holds count from here. */
  baseMark: number;
  writing: Promise<RecoveryCheckpoint | null> | null;
  /** Bumped by every purge: a checkpoint whose export started before one
   *  is not written after it (it would hold work that was just saved). */
  generation: number;
  readonly listeners: Set<() => void>;
}

const STATE = scoped("recovery", (): RecoveryState => ({
  attachment: null,
  offers: [],
  checkpointMark: null,
  baseMark: 0,
  writing: null,
  generation: 0,
  listeners: new Set(),
}));

function changed(st: RecoveryState): void {
  for (const l of [...st.listeners]) l();
}

/** The app began this editor's session (and found `offers`). Returns the
 *  clean close: the session's checkpoints go and its lock is let go.
 *
 *  From here the journal follows the save state, synchronously (a React
 *  effect would run too late for a restore, which keeps its copy right
 *  after it opens): another document opening purges the checkpoints of the
 *  one it replaced (that one was saved, or the user chose not to save it),
 *  and a save that left the document clean purges them too (the work is in
 *  the library, the file or a download). */
export function attachRecovery(
  scope: EditorScope,
  attachment: RecoveryAttachment,
): () => Promise<void> {
  const st = scope.get(STATE);
  st.attachment = attachment;
  st.offers = [...attachment.offers];
  changed(st);
  const store = saveStateOf(scope);
  let openedAt = store.get().document?.openedAt ?? null;
  let savedAt = store.get().saved?.at ?? null;
  const off = store.subscribe(() => {
    const now = store.get();
    const opened = now.document?.openedAt ?? null;
    const saved = now.saved?.at ?? null;
    if (opened !== openedAt) {
      openedAt = opened;
      savedAt = saved;
      void purgeCheckpoints(scope);
      return;
    }
    if (saved !== savedAt) {
      savedAt = saved;
      if (saved !== null && !now.dirty) void purgeCheckpoints(scope);
    }
  });
  return async () => {
    off();
    if (st.attachment !== attachment) return;
    for (const o of st.offers) o.release();
    st.offers = [];
    st.attachment = null;
    changed(st);
    await attachment.session.end();
  };
}

/** Is a journal kept for this editor? */
export function recoveryAttached(scope: EditorScope): boolean {
  return scope.get(STATE).attachment !== null;
}

/** The checkpoints offered for recovery, oldest question first. */
export interface RecoveryOffers {
  subscribe(listener: () => void): () => void;
  current(): RecoveryCheckpoint | null;
}

export function recoveryOffers(scope: EditorScope): RecoveryOffers {
  const st = scope.get(STATE);
  return {
    subscribe(listener) {
      st.listeners.add(listener);
      return () => {
        st.listeners.delete(listener);
      };
    },
    current: () => st.offers[0]?.checkpoint ?? null,
  };
}

/** The document a checkpoint of the open document is a copy of. */
function describeOpenDocument(
  scope: EditorScope,
  attachment: RecoveryAttachment,
  name: string,
): RecoveryDocument {
  const state = saveStateOf(scope).get();
  const library = currentLibraryDocument(scope);
  const file = getOpenFileHandle(scope);
  const identity = attachment.identify();
  return {
    key: identity.key,
    stable: identity.stable,
    name,
    source: library
      ? { kind: "library", documentId: library.id }
      : file
        ? { kind: "file", name: file.name }
        : { kind: "none" },
    openedAt: state.document?.openedAt ?? Date.now(),
    savedAt: state.saved?.at ?? null,
  };
}

/** The open document was saved, or another one opened: its edits count
 *  from `mark` now. */
export function resetEditBase(scope: EditorScope, mark: number): void {
  scope.get(STATE).baseMark = mark;
}

/**
 * Keep the open document's unsaved work as a checkpoint. Nothing when no
 * journal is kept, nothing is unsaved, or the document has not changed
 * since the newest checkpoint (unless `force`). Never throws: a checkpoint
 * that cannot be written leaves the work as unsaved as it was.
 */
export async function writeCheckpoint(
  scope: EditorScope,
  client: Pick<CanvasClient, "exportPaged" | "editMark" | "documentMeta">,
  input: {
    reason: CheckpointReason;
    name: string;
    pages: number | null;
    force?: boolean;
  },
): Promise<RecoveryCheckpoint | null> {
  const st = scope.get(STATE);
  const attachment = st.attachment;
  if (!attachment) return null;
  if (!documentNeedsSave(scope)) return null;
  const mark = client.editMark;
  if (!input.force && st.checkpointMark === mark) return null;
  if (st.writing) await st.writing.catch(() => null);
  const generation = st.generation;
  const run = (async () => {
    const bytes = await client.exportPaged();
    if (st.generation !== generation || !documentNeedsSave(scope)) return null;
    const checkpoint = await attachment.session.write({
      document: describeOpenDocument(scope, attachment, input.name),
      bytes,
      reason: input.reason,
      edits: Math.max(0, mark - st.baseMark),
      pages: input.pages,
    });
    if (checkpoint) {
      st.checkpointMark = mark;
      saveStateOf(scope).dispatch({ type: "checkpoint", at: checkpoint.at });
    }
    return checkpoint;
  })().catch((err: unknown) => {
    console.warn("recovery: could not keep a checkpoint:", err);
    return null;
  });
  st.writing = run;
  const result = await run;
  if (st.writing === run) st.writing = null;
  return result;
}

/** The work is saved, or the document closed on purpose: its checkpoints
 *  go. */
export async function purgeCheckpoints(scope: EditorScope): Promise<void> {
  const st = scope.get(STATE);
  const attachment = st.attachment;
  if (!attachment) return;
  st.checkpointMark = null;
  st.generation += 1;
  // Queued in the session at once: a checkpoint written after this call
  // lands after the purge, never under it.
  await attachment.session.purge().catch((err: unknown) => {
    console.warn("recovery: could not clear the checkpoints:", err);
  });
  saveStateOf(scope).dispatch({ type: "checkpoint", at: null });
}

/** Resolves once the save state shows the document `origin` opened (the
 *  shell's controller declares it after the load lands), or after
 *  `timeoutMs`. */
function untilOpened(
  scope: EditorScope,
  checkpointAt: number,
  timeoutMs = 10_000,
): Promise<boolean> {
  const store = saveStateOf(scope);
  const opened = () => {
    const origin = store.get().document?.origin;
    return origin?.kind === "recovered" && origin.checkpointAt === checkpointAt;
  };
  if (opened()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      off();
      resolve(false);
    }, timeoutMs);
    const off = store.subscribe(() => {
      if (!opened()) return;
      clearTimeout(timer);
      off();
      resolve(true);
    });
  });
}

function takeOffer(st: RecoveryState, checkpoint: RecoveryCheckpoint) {
  const i = st.offers.findIndex(
    (o) => o.checkpoint.session === checkpoint.session,
  );
  if (i < 0) return null;
  const [offer] = st.offers.splice(i, 1);
  changed(st);
  return offer ?? null;
}

/** Not now: the checkpoint stays in the journal and is offered again at
 *  the next start. */
export function postponeCheckpoint(
  scope: EditorScope,
  checkpoint: RecoveryCheckpoint,
): void {
  takeOffer(scope.get(STATE), checkpoint)?.release();
}

/** Discard the recovered copy: it is gone from the journal. The source is
 *  not touched. */
export async function discardCheckpoint(
  scope: EditorScope,
  checkpoint: RecoveryCheckpoint,
): Promise<void> {
  const st = scope.get(STATE);
  const offer = takeOffer(st, checkpoint);
  await st.attachment?.journal.discard(checkpoint.session);
  offer?.release();
}

/** What Compare shows of the saved version a checkpoint departs from. */
export interface SavedVersion {
  kind: "library" | "file" | "none";
  name: string | null;
  /** When the saved version was last written, when known. */
  savedAt: number | null;
}

/** The saved version a checkpoint's document came from, as far as this
 *  editor can tell without opening it. */
export async function savedVersionOf(
  checkpoint: RecoveryCheckpoint,
  listLibrary:
    (() => Promise<{ id: string; name: string; updatedAt: number }[]>) | null,
): Promise<SavedVersion> {
  const source = checkpoint.document.source;
  if (source.kind === "library") {
    const entries = listLibrary ? await listLibrary().catch(() => []) : [];
    const entry = entries.find((e) => e.id === source.documentId) ?? null;
    return {
      kind: "library",
      name: entry?.name ?? checkpoint.document.name,
      savedAt: entry?.updatedAt ?? checkpoint.document.savedAt,
    };
  }
  if (source.kind === "file")
    return {
      kind: "file",
      name: source.name,
      savedAt: checkpoint.document.savedAt,
    };
  return { kind: "none", name: null, savedAt: null };
}

/**
 * Restore recovered work: the checkpoint opens as a new document, never
 * over its source. Asks first when the open document has unsaved work.
 * Resolves true when the copy opened; the journal then holds it again in
 * this editor's session and forgets the old one.
 */
export async function restoreCheckpoint(
  editor: PagedEditor,
  checkpoint: RecoveryCheckpoint,
  sinks: { setStatus: (s: string) => void; pushWarning: (w: string) => void },
): Promise<boolean> {
  const scope = editor.scope;
  const st = scope.get(STATE);
  const attachment = st.attachment;
  if (!attachment) return false;
  const name = t(RECOVERY.recoveredName, { name: checkpoint.document.name });
  if (
    !(await confirmReplace(scope, editor.client, {
      action: t(RECOVERY.restoring, { name: checkpoint.document.name }),
      documentName: name,
    }))
  )
    return false;
  const bytes = await attachment.journal.read(checkpoint).catch(() => null);
  if (!bytes) {
    sinks.pushWarning(
      t(RECOVERY.unreadable, { name: checkpoint.document.name }),
    );
    return false;
  }
  const origin: DocumentOrigin = {
    kind: "recovered",
    name: checkpoint.document.name,
    checkpointAt: checkpoint.at,
  };
  // Never write back to the file the source came from.
  setOpenFileHandle(scope, null);
  declareNextOrigin(scope, origin);
  const before = editor.client.openDocument;
  await loadDocumentFile(
    editor.client,
    new File([bytes.slice()], `${name}.paged`, {
      type: "application/x-paged+zip",
    }),
    {
      setHandle: editor.document.setHandle,
      setSourceName: editor.document.setSourceName,
      setLoading: editor.document.setLoading,
      setStatus: sinks.setStatus,
      setSnapshotsReady: editor.document.setSnapshotsReady,
      addSnapshot: (pageId, url) => {
        editor.document.setSnapshots((prev) => {
          const next = new Map(prev);
          next.set(pageId, url);
          return next;
        });
      },
      resetForNewDocument: editor.document.resetForNewDocument,
      pushWarning: sinks.pushWarning,
      remember: false,
      scope,
    },
  );
  if (editor.client.openDocument === before) {
    // The copy did not open: it stays in the journal for the next start.
    declareNextOrigin(scope, null);
    postponeCheckpoint(scope, checkpoint);
    sinks.pushWarning(
      t(RECOVERY.notRestored, { name: checkpoint.document.name }),
    );
    return false;
  }
  // Kept again by this editor's session before the old one is forgotten,
  // so there is always one copy. The session purged what it held for the
  // replaced document when this one opened; this lands after that.
  await untilOpened(scope, checkpoint.at);
  const meta = await editor.client.documentMeta().catch(() => null);
  await writeCheckpoint(scope, editor.client, {
    reason: "recovered",
    name,
    pages: meta?.pageCount ?? checkpoint.pages,
    force: true,
  });
  await discardCheckpoint(scope, checkpoint);
  return true;
}

# ADR 1204 — The recovery journal

- **Status:** Accepted 2026-11-13.
- **Scope:** `packages/repository/src/recovery.ts` (new: the journal over a `RepoFs`, Web
  Locks liveness, retention), `packages/repository/src/fs.ts` (`RepoFs.remove`, listing the
  root), `packages/shell/src/state/recovery.ts` and `recovery-controller.tsx` (new: one session
  per editor, when to checkpoint, restore and discard),
  `packages/shell/src/chrome/RecoveryPrompt.tsx` (new), `state/replace-guard.ts`
  (`setBeforeReplace`; a restored, unsaved document is asked about), `state/document-loader.ts`
  (`remember: false`), `PagedShell.tsx` (the unload guard), `apps/canvas/src/app/recovery-start.ts`
  (new) and `mountEditor` (`recovery`). The UX strategy's §6.2; `UXI-MUT-008` to `UXI-MUT-010` of
  the interaction specification ([ADR 1200](1200-the-interaction-contract-is-adopted.md)); task
  DF2 of [`interaction-plan.md`](../interaction-plan.md). Closes UX audit F-06's loss of unsaved
  work on a reload or a crash.

## Context

A reload or a crashed tab lost every unsaved edit (F-06). The page asked before unloading an
edited document (the unload guard), which buys a confirmation and nothing more, and the local
library (ADR 180) versions saved documents only. The strategy asks for checkpoints kept while
editing and before risky operations, identified well enough to match their source, bounded, and
offered back as Restore, Compare or Discard, never written over the source silently.

## Decision

1. **One journal session per editor.** `mountEditor` begins a session when the local library
   starts (the page entry and the plain editor; `recovery` overrides; an embedded editor keeps
   none unless its host asks, so it never writes to the host's origin storage unasked, ADR 277).
   Checkpoints are `.paged` bytes in the origin-private file system under `paged-recovery`, one
   directory per session with a list (`meta.json`) written after the bytes. The session holds a
   Web Lock named after it for as long as the editor lives; a page that goes (a crash, a reload,
   a closed tab) releases it. A session whose directory remains and whose lock nobody holds
   ended without a clean close: its newest checkpoint is offered at the next start, claimed by a
   second lock so two tabs do not offer it twice. Without Web Locks no journal is kept, since a
   live tab could not be told from a crashed one. `localStorage["paged.recovery"] = "off"`, read
   through the editor's storage adapter, switches it off (`scripts/settings-inventory.json`).
2. **When a checkpoint is kept.** Only while the document has unsaved work, and only when it
   changed since the newest checkpoint: when editing pauses (3 s after an accepted operation),
   after 40 accepted operations (the client's `editMark`), when the page is hidden, and before an
   edited document is replaced (the replace guard waits up to 3 s for it before asking, since a
   load can fail or take the tab down). At most one every 15 s, except before a replace. A
   checkpoint names its source by the document identity of ADR 264 (`lib:`, `fh:`, `t:`), its
   name, where its saved version lives (a library document, a file, none), when it was opened
   and last saved, the edits since that save and its page count.
3. **When it goes.** A save that leaves the document clean purges the session (the work is in
   the library, the file or a download); another document opening purges it (the old one was
   saved or the user chose not to save it); a clean close (`dispose`) ends it. Both follow the
   save state synchronously, and a checkpoint whose export began before a purge is not written
   after it.
4. **Bounded.** A session keeps its two newest checkpoints; a checkpoint over 256 MB is not
   kept; orphaned sessions older than 14 days, beyond eight, or beyond 512 MB together are
   pruned at start, oldest first; damaged sessions are removed.
5. **Restore, Compare, Discard, Not now.** The prompt names the document and when the copy was
   kept. Compare shows the copy (time, unsaved edits, pages) against the saved version (the
   library document and when it was saved, the file, or never saved) and says what Restore will
   do. Restore asks the replace question if the open document has unsaved work, then opens the
   copy as a new document, "<name> (recovered)", tied to no file handle and to no library
   document and not taken into the library: its first save makes a new library document and a
   new file, so the saved version is never overwritten (`UXI-MUT-010`). The restored document is
   kept again by the new session before the old one is forgotten. Discard deletes the copy;
   Not now (or Escape) leaves it for the next start. Nothing touches the source.
6. **A restored document is unsaved work** until it is saved: the save state reads
   `recovered`, and the replace question and the unload guard ask, though the engine reads a
   freshly loaded document as clean.

## Consequences

- F-06's reload no longer costs unsaved work. Reopening the last saved document on start and
  Open recent stay open (they belong to the library, not to the journal).
- The journal is no save and is never shown as one: the save status mentions a checkpoint only
  as "a recovery copy … It is not a save".
- An export per checkpoint runs in the render worker; the idle trigger and the 15 s floor keep
  it out of continuous editing.
- Tests: `packages/repository/test/recovery.test.ts` (sessions, orphans, retention, purge, the
  claim), `apps/canvas/test/unit/app/recovery-start.test.ts` (the flag, the start),
  `packages/shell/test/chrome/recovery-prompt.dom.test.tsx` (Compare, Discard, Not now),
  `packages/shell/test/commands/replace-guard.test.ts` (a restored document is asked about; the
  checkpoint precedes the question), and `apps/canvas/tests/e2e/uxi-documents.spec.ts` (a reload
  with a dirty journal offers it; Restore opens the recovered model as a new document with
  nothing to undo; Discard and a save leave nothing to offer).

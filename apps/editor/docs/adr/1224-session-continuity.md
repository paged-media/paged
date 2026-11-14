# ADR 1224 — Session continuity: the last document, Open recent, Close

- **Status:** Accepted 2026-11-13.
- **Scope:** `apps/canvas/src/session-continuity.ts` (new: the document open last remembered and
  reopened, the recent list, opening a row), `panels/open-recent-dialog.tsx` (new),
  `document-identity.ts` (a file handle's `seenAt`; `recentFiles`), `app-commands.ts`
  (`paged.file.openRecent`, `paged.file.close`), `cockpit-menus.ts` (the two `soon` rows go),
  `app/mount.tsx` (the start is decided once the recovery journal has said what it offers),
  `packages/shell/src/state/commands/file-commands.ts` (`closeDocument`), the setting
  `paged.session.lastDocument.v1`; `panels/library-panel.tsx` (a push reports to the save
  status). Closes the rest of UX audit F-06 (with [ADR 1204](1204-recovery-journal.md)); amends
  [ADR 1203](1203-save-status-says-what-is-saved-where.md).

## Context

After a reload the editor came back on "No document" although the local library held the
document; File ▸ Open recent and File ▸ Close were disabled "soon" rows (F-06). The recovery
journal (ADR 1204) brings back unsaved work after a crash, not the document itself. ADR 1203 left
the Library panel's push to paged.server out of the save status.

## Decision

1. **The document open last comes back.** The library document open now is remembered per
   editor (`paged.session.lastDocument.v1`, `{ id }`, read with a shape check); at the next start,
   once the journal has said what it offers, and only when it offers nothing and nothing else
   opened a document, that library document opens again (the library's own open path). A crashed
   session's unsaved work comes first; an embedded editor, which keeps no library, reopens
   nothing.
2. **File ▸ Close** asks the replace question when the document has unsaved edits (ADR 230), then
   shows the empty canvas; the closed document is forgotten (the next start reopens nothing), and
   its recovery copy goes as it goes after a save.
3. **File ▸ Open recent…** lists the library's documents and the files opened or saved lately
   (their handles, kept with the time they were last seen), newest first. A library document opens
   as the Library panel opens it; a file asks the browser for read permission again, opens through
   File ▸ Open's path and keeps its handle so Save writes back to it.
4. **A push is the save status's remote step** (amends ADR 1203's consequence): pushing the open
   document reads "Saved locally · Syncing…", then "Saved" with the repository among its
   destinations, or "Saved locally · Not synced" with the server's words when the push fails. A
   push of another library document leaves the open one's status alone.

## Consequences

- Tests: `apps/canvas/tests/e2e/session-continuity.spec.ts` (a reload reopens the document as it
  was, nothing to undo; Close; nothing reopens after Close; Open recent brings it back),
  `apps/canvas/test/unit/app/library-push-status.test.ts`.

# ADR 225 — The local library: open is an import, save is a version

- **Status:** Proposed 2026-10-17.
- **Scope:** `packages/repository` (`@paged-media/repository`: the library, its OPFS file
  system, the worker protocol); `apps/canvas/src/library-worker.ts`; the library hooks in
  `packages/shell/src/state/library-document.ts` and `document-loader.ts`; `savePaged` in
  `apps/canvas/src/main.tsx`; the Library panel (`apps/canvas/src/panels/library-panel.tsx`).
  Depends on `@paged-media/repo-wasm` (core ADR 180).

## Context

Core ADR 180 makes a document's authoritative state a repository: content-addressed parts,
commits, refs and an evidence log. A `.paged` or `.idml` file becomes a projection of one
version. The editor has no backend (ADR 211) and must keep working with none, so the
repository has to live in the browser, and it has to be complete there: history, restore,
releases and evidence without a server.

Until now a save wrote a file and nothing else. The editor kept no history, so a save over
the wrong edit could not be undone across sessions.

## Decision

1. **The library lives in the origin-private file system** under `paged-library/`, one
   directory per document, kept as packs (core `docs/reference/paged-repo-format.md`). It runs
   in its own worker (`library-worker.ts`), so hashing and unzipping a large document on save
   never blocks the main thread.
2. **Opening a file is an import.** A file opened through the shell's loader becomes a library
   document whose first version records the file's name and hash. A `.paged` file that carries
   its history brings it. A document opened from the library is not imported again.
3. **Saving is a version.** `Save (.paged)` commits the same bytes it writes to the file. A save
   that changed nothing makes no version. A blank document becomes a library document on its
   first save.
4. **The library rides alongside the file, never instead of it.** The file write and the
   download fallback are unchanged. A library failure is reported to the console and the file
   is still written.
5. **The library is optional.** Without OPFS, or with `localStorage["paged.library"] = "off"`,
   every hook is a no-op and the editor behaves as before.
6. **Nothing rewinds.** Restore commits an old version again on top of the newest, so the
   version it replaces stays in the list. A release names a version once and never moves.
7. **The library asks to persist** (`navigator.storage.persist()`), so the browser does not
   evict it under storage pressure. A refused request is not fatal: the file on disk, or
   Export with history, is the backup.
8. **A server is opt-in at build time.** `PAGED_SERVER_URL` names the paged.server a build
   syncs with; its origin joins the network wall (`connect-src`) exactly as a data origin
   does. Without it the panel has no server controls. With it, the panel signs in with an
   OAuth 2.1 popup (PKCE; the callback answers over a same-origin `BroadcastChannel`,
   because the cross-origin-isolated editor's popup has no opener), pushes what the server
   lacks, pulls through the local kernel (a document that moved apart is refused, not
   merged), and opens a server repository as a new library document.

9. **Claude can use a connected tab.** "Connect to Claude" opens the tab's end of
   paged.server's live relay. A model's engine tools run here through the editor's own
   doors: scripts through the undoable Script-panel path, renders through the page
   snapshot. Every call is logged in the panel. While "Ask before each change" is on (the
   default), a script or a save waits for the person's Allow. A save becomes an agent's
   version on `agent/<run>/live` with provenance naming the person, and only the person
   merges it into main ("Merge into main").

## Consequences

- The editor now holds data the user did not explicitly save to disk: every opened file is
  kept in the library until deleted. The panel lists it; deleting a document is not in this
  change.
- A document opened again from disk becomes a second library document. Matching a file to
  the document it came from is a follow-up.
- Tokens are kept in `localStorage` per server: an hour-long signed access token and a
  rotating refresh token. Anything that can run script on the editor's origin can read them.
- A script Claude runs in the tab changes the working document like any script: it is
  undoable, and the person's next Save commits it as theirs. A version is Claude's only when
  Claude saves it (`save_document`).
- The repository package is new on npm and reaches the editor once core publishes it.
  Until then the editor builds against a local package (`~/paged/.local-wasm/repo-wasm` via a
  `file:` override that is not committed).

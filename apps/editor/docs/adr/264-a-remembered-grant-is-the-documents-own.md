# ADR 264 — A remembered grant is the document's own, keyed by what the host opened

- **Status:** Accepted 2026-10-20.
- **Scope:** `apps/canvas/src/document-identity.ts` (new), `plugin-consent.ts`,
  `ConsentDialog.tsx`, `main.tsx`; `packages/shell/src/state/document-source.ts` (new),
  `document-loader.ts`, `open-file-handle.ts`, `PagedShell.tsx` (the open picker);
  `packages/client` (`CanvasClient.openDocument`); in the plugin SDK, `ConsentBackend.grants` and
  the `host.network` door. Builds on [ADR 218](218-network-wall-build-time-data-origins.md) (the network
  wall) and the network-consent door (plugin-sdk `host.network`).

## Context

Finding HOST-5: "Remember for this document" was not for this document. The SDK stored a
remembered origin in the bundle's own `localStorage` namespace, per browser, so every document
the bundle met afterwards, after a reload and in any file, held the grant. A file that carries
queries is treated as carrying code (paged.data §11): the grant is the user's decision about
one document reaching one origin.

Keying the grant needs a document identity, and the obvious ones fail:

- **The engine's `docId`** is minted per load. Opening the same file twice gives two ids.
- **An id inside the file** (a label, a container part) is the file's to write. A hostile file
  could copy the id of a document the user trusted and inherit its grant, or simply carry a
  grant of its own. Nothing a file contains can decide what it may reach.
- **The file's name, path string or bytes** are equally the sender's: the same name and the
  same bytes arrive from a stranger's download.

Microsoft Office's trusted documents are keyed by the file's location on this machine, and
re-prompt when the file is moved; the browser gives the editor the equivalent, for the files it
opened itself.

## Decision

1. **Grants live on the host, never in the file.** The editor's consent backend keeps them:
   session grants in memory, remembered grants in this browser's `localStorage`
   (`paged.consent.grants.v1`: document key → plugin id → origins). The SDK's door asks the
   backend what a plugin holds (`ConsentBackend.grants`, new) and keeps and stores nothing
   itself; the old per-bundle key is ignored and cleared.
2. **The key is minted by the host and bound to what the host opened**
   (`document-identity.ts`):
   - `fh:<uuid>` — a file the user picked with the File System Access picker. The handle is
     kept in IndexedDB with the file's `lastModified` and `size`; reopening a file is
     recognised by `FileSystemHandle.isSameEntry` against the kept handles, and only while
     the file reads as it did when the editor last opened or saved it. A change made elsewhere
     mints a new key. A save through the handle updates the record; another document saved
     over the file forgets it.
   - `lib:<id>` — a document of the local library, by the id the library minted when it took
     the file in (`importFile` never takes an id from the bytes).
   - `t:<uuid>` — everything else: a drop, the `<input type=file>` fallback, a URL, New, a
     plugin-built document. One key per load, never stored.
   The handle travels with the `File` object the picker returns (a `WeakMap`), so only the
   opener that holds the handle can claim it; the shell's loader declares each load's source
   for the engine `docId` it produced, and a load nothing declared is transient.
3. **A fresh source asks again.** Only `fh:` and `lib:` keys are rememberable. For a transient
   document the dialog's "Remember for this document" is disabled with the reason, and a grant
   lasts while the document stays open. Every grant, session or remembered, belongs to the
   document that asked: opening another document starts from nothing.
4. **The SDK says only what it can keep.** Without a backend that keeps grants, the door keeps
   this host's session grants and answers `remembered: false`.

## Consequences

- Finding HOST-5 is fixed: the bundle-host contract test remembers a grant for a picked file,
  meets a new document with nothing, reopens the file and finds the grant, and asks again for
  the same name and bytes from another handle and for the file changed elsewhere.
- A grant made for one document no longer carries to the next one opened in the same session;
  a user who opens a different file is asked again.
- Trust follows the place, as in Office: a library document synced from a server keeps its
  grant when collaborators change it, and a file the editor saved keeps its grant. A file
  replaced on disk by another program is a new document.
- A browser without the File System Access picker (or under automation) opens files through the
  input fallback: nothing can be remembered there. The library path still remembers.

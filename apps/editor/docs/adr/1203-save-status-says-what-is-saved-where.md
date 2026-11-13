# ADR 1203 — The save status says what is saved where

- **Status:** Accepted 2026-11-13.
- **Scope:** `packages/repository/src/save-state.ts` (new: the machine, pure),
  `packages/shell/src/state/save-status.ts` and `save-state-controller.tsx` (new: one store per
  editor, fed by the shell), `packages/shell/src/chrome/SaveStatus.tsx` (new: the header's
  label and popover), `chrome/Header.tsx` (the document chip), `state/open-file-handle.ts`
  (`writeBackToOpenFile`), `state/replace-guard.ts` (`documentSaver`),
  `apps/canvas/src/app/save-paged.ts` (new: File ▸ Save, moved out of `mount.tsx`, reporting
  each step). Builds the decision D-10 of [ADR 1201](1201-interaction-decisions.md) and
  `UXI-INV-010`, `UXI-FIL-003` and `UXI-MUT-009` of the interaction specification
  ([ADR 1200](1200-the-interaction-contract-is-adopted.md)); task DF1 of
  [`interaction-plan.md`](../interaction-plan.md). Closes UX audit F-07.

## Context

The document chip carried one dot. It showed the engine's status string whenever that string
did not contain "ready", and after an open the string reads "imported Annual.idml" or "loaded 4
pages", so the dot stayed amber, the colour of unsaved work, for the whole session (F-07). Once
the engine was ready the dot was the dirty flag: dirty or not. A save gave no feedback.

The save itself has several steps with different guarantees (`savePagedFile`, A5 and ADR 180):
a commit in the browser's local library, then a write back to the file the document was opened
from, else a download; or, in an embedding host, the host's `save` action alone. The write back
can fail (a declined permission prompt, a moved or locked file) after the library commit has
landed. The code fell back to a download and cleared the dirty flag either way, so "no unsaved
edits" was all the user saw, whether the file was written or not.

## Decision

1. **One machine says what persistence is true, per editor.** `save-state.ts` reduces events to
   a state: `new` (nothing saved in this session: a blank document, or a file opened and not
   edited), `editing`, `saving`, `saved-local` (the bytes are on this device: the library and/or
   a download, and the document has no target of its own), `syncing` (on this device, being
   written to the target), `synced` (the target holds them: the file it was opened from, the
   host, a server), `not-synced` (on this device, the target did not take them), `failed`
   (nothing was persisted), `read-only` (the session's role is `viewer`) and `recovered` (see the
   recovery journal's record). The kind is a function of the facts, in a fixed order: read-only;
   a running save; a failure (it outranks later edits until a save stores something); dirty;
   the last save's destinations; a restored, unsaved origin. A recovery checkpoint is never a
   save (`UXI-MUT-009`). The store lives in the editor's scope; nothing is module state.
2. **The save reports each step** (`save-paged.ts`): started; each destination it stored the
   bytes in; the target it starts writing to; the target's refusal with a code
   (`permission-denied`, `file-missing`, `write-failed`, `host-refused`, `export-failed`) and
   the platform's words for a details view; notes that are no failure (the library did not keep
   the save; a plugin did not finish preparing); finished or failed. `writeBackToOpenFile` says
   whether there was a file to write to and why it did not take the bytes, where
   `writeToOpenFile` said only true or false.
3. **D-10: a local save whose target failed reads "Saved locally · Not synced", with Retry.** It
   never reads "Saved". Retry runs the save again (the one `setDocumentSaver` registered, the
   replace question's Save), which commits nothing new to the library when nothing changed and
   writes the file again.
4. **The header says it in words.** `SaveStatus`, after the menus, shows a dot and the label
   ("No changes", "Not saved yet", "Unsaved changes", "Saving…", "Saved locally",
   "Downloaded", "Saved locally · Syncing…", "Saved", "Saved locally · Not synced", "Couldn't
   save", "Read-only", "Recovered · Not saved"); its popover says where (the library, the file by
   name, the download by name, the host, the server), when, why a step failed, and offers Retry.
   `data-save-state` carries the state for tests and scripts. Below 1400 px of editor width, and
   on a phone-width fill layout, the dot shows alone and the label is the button's name and
   tooltip. After the menus, not beside the name: the menus stay the first tab stop and keep
   their place, so deep submenus keep their room. The chip keeps the name and shows a dot only
   while the engine is busy (a status ending in "…") or failed; a settled status is no longer
   read as unsaved work.

## Consequences

- F-07 closes: the chip no longer reads every settled engine message as an edit, and a save
  says where it went.
- Track WS's header slot (WS6) mounts `SaveStatus` where it moves the header's items; the
  component and `data-save-state` stay as they are.
- A push to paged.server from the Library panel is not reported yet; the machine has the
  `remote` destination for it.
- Tests: `packages/repository/test/save-state.test.ts`, `apps/canvas/test/unit/app/save-paged.test.ts`,
  `packages/shell/test/chrome/save-status.dom.test.tsx`, and `UXI-T67` in
  `apps/canvas/tests/e2e/uxi-documents.spec.ts` (a write back that fails after the local commit
  reads not synced and never synced; Retry reaches synced).

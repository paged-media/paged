# ADR 230 — One question before any document replaces the open one

- **Status:** Accepted 2026-10-19.
- **Scope:** `packages/shell/src/state/replace-guard.ts`,
  `packages/shell/src/chrome/ReplaceDocumentPrompt.tsx`,
  `packages/shell/src/state/commands/file-commands.ts` (`openFile`), `PagedShell.tsx` (the
  canvas drop and the file input), `apps/canvas/src/plugin-native-document.ts`,
  `apps/canvas/src/plugin-documents.ts`, `apps/canvas/src/main.tsx` (Open PDF…, the saver)

## Context

The editor holds one document, so every open replaces it. File ▸ New and File ▸ Open asked
first, with a native OK/Cancel `confirm`. The other routes did not: a file dropped on the
canvas, File ▸ Open PDF…, and every importer that opens what it produced through
`host.nativeDocument.open` (a dropped `.docx`, a `.pdf`) replaced an edited document at once
(finding R8, SH-10, UX audit F-01). A never-saved document was then lost for good, since the
library versions saved documents only. The plugin documents door (`host.documents.open`,
ADR 219) asked with a dialog of its own, Keep or Discard. Three answers to one question, and
on most routes none.

The native `confirm` had a second problem (UX audit F-05): it offered no Save. A user had to
cancel, save and do it again, and its text said Cmd+S on every platform.

## Decision

1. **One guard.** `confirmReplace(client, { action, requester?, documentName? })` is the
   only place that decides whether a replacement may go on. Every route reaches it before
   the engine loads anything: File ▸ New, File ▸ Open…, the canvas drop and the shell's file
   input (both through `openFile`, File ▸ Open's own path), the library panel, New from a
   brief, the dev corpus picker, `host.nativeDocument.open` (its backend asks, so every
   importer that opens a document is covered, including Open PDF…) and
   `host.documents.open`. A clean document, or none, is replaced without a question. One
   import is one replacement: an importer that opens twice on the way (paged.doc opens a
   skeleton, styles it, and re-opens it when the engine refuses span columns) is asked about
   once, for the session the shell runs it in (`setPendingImportSource`).
2. **InDesign's question.** Save, Don't save, Cancel. Save runs the save the app registers
   with `setDocumentSaver` (the command Cmd+S runs) and goes on only when the document is
   clean afterwards, so an abandoned save keeps the document. Cancel, Escape, the backdrop
   and a prompt unmounted mid-question keep it too. The default button is Save (Cancel when
   no save is registered), never Don't save.
3. **Where it is asked.** The shell's `<ReplaceDocumentPrompt>` renders the question queue
   (one at a time, oldest first). With no prompt mounted (a failed bundle load, the unit
   tests, the headless editor) the guard falls back to the platform `confirm`, whose text
   names this platform's save chord. Asking nothing is never the fallback.
4. **Declining a plugin open.** `host.documents.open` answers
   `{ opened: false, reason: "declined" }` as before. `host.nativeDocument.open` rejects
   with an error named `AbortError`; the shell treats it as an answer, not a failure (a
   status line, no warning). The contract's comment says so.
5. **Tests.** The shell's unit lane covers every answer and the fallback
   (`test/commands/replace-guard.test.ts`); the DOM lane mounts PagedShell over the real
   engine and drops a file on the canvas (`apps/canvas/test/shell/document-replace.dom.test.tsx`);
   the headless lane opens through a plugin host's doors. Playwright's driver answers the
   question with Don't save unless a spec opts out (`answerReplacePrompts: false`), the way
   it accepted the native `confirm` before, and records each answer.

## Consequences

- The keep-or-discard dialog of ADR 219 is gone; its test ids live on in the shell prompt
  (`replace-document-keep` is Cancel, `replace-document-discard` is Don't save).
- A drop of an image, a Word or a spreadsheet file still opens it as a document when an
  importer opens it; placing such a file into the open document instead (F-03) is a separate
  decision.

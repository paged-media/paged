# ADR 270 — The file chooser holds its input until it answers

- **Status:** Accepted 2026-10-20.
- **Scope:** `packages/shell/src/lib/file-chooser.ts` (new, `chooseFiles`); its callers: File ▸
  Place… and `host.shell.pickFile` (`apps/canvas/src/shell-file-picker.ts`), File ▸ Open…'s
  fallback and Import swatches (`PagedShell.tsx`), Color settings ▸ Add profile.

## Context

Filming the home film, File ▸ Place… sometimes opened no file chooser (twice in rehearsal, once at
low load), and Insert ▸ Word document… once did the same. Every picker in the editor made a fresh
`<input type="file">`, never attached it, set its handlers and called `click()`. Nothing held the
element afterwards, so a garbage collection between `click()` and the browser reporting the
chooser collected it: the automation layer, which resolves a chooser through its element, saw
none, and in a browser a file the user picked would never fire `change`. Driving Place while the
page collected garbage continuously reproduced it: 1 of 15 and 9 of 15 choosers opened. ⌘D was
not immune; closing a menu allocates more in the same moment, which made the menu path lose more
often.

## Decision

One chooser, `chooseFiles(options)` in the shell, behind every picker. Its input is attached to the
document (hidden, `tabIndex = -1`, `aria-hidden`) and kept in a module-level set until the chooser
answers (`change` or `cancel`); then it is removed. `click()` still runs synchronously in the
caller's gesture, so the browser's user-activation rule is met as before. A cancel answers an
empty list, which Open and Import swatches now take as a cancel instead of a promise that never
settled.

## Consequences

Under the same continuous collection, Place opens its chooser 15 of 15 times
(`tests/e2e/place-and-table.spec.ts`, which fails on the detached input). The chooser's own
contract is in `packages/shell/test/chrome/file-chooser.dom.test.ts`. A browser that fires no
`cancel` leaves one hidden input in the document until the next answer.

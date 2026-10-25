# ADR 303 — Find & Replace

- **Status:** Accepted 2026-10-25.
- **Scope:** `apps/canvas/src/find/{find-model,find-state,find-ui,find-commands}.ts(x)`,
  `apps/canvas/src/panels/built-in-panels.tsx` (`paged.find-results`),
  `apps/canvas/src/app/mount.tsx`, `apps/canvas/tests/headless/harness.ts`,
  `packages/client/src/protocol.ts` (`FindHit`, `FindMode`, `FindSpec`). Engine: ADR 1021
  (`RequestFindText` → `FoundText`, `findReplace`). Contract: extensions ADR 348 amendment 1
  (`host.text.find` / `replace`). First keys from a content type: paged.doc (doc ADR 608
  amendment 1).

## Context

A Word user expects Find & Replace (match case, whole word, wildcards, find by style, `^p` `^t`
`^l` `^m`, Replace All as one undo step) and the Navigation pane's Results list. An InDesign user
expects the same from Find/Change. The engine now answers a find with hits in caret and character
offsets and replaces in one batch (engine ADR 1021); what was missing was the UI.

## Decision

- **A host feature, not a plugin's.** Find & Replace works on any text document, so the dialog,
  the results panel and the commands live in the host. A content type's scoped keys only name
  the host's command ids (paged.doc binds Cmd+F / Cmd+H / Cmd+G inside a Word document).
- **Commands** (Edit menu, palette): `paged.edit.find` (opens the results panel and focuses its
  search field), `paged.edit.replace` (the dialog), `paged.edit.findNext`,
  `paged.edit.findPrevious`, `paged.edit.goTo` (the Go To dialog: a page number). Host keys:
  Cmd+F / Ctrl+F find, Cmd+Alt+F (InDesign's Find/Change) and Ctrl+H replace, Cmd+J go to page
  (InDesign's). Cmd+H and Cmd+G are left to content types (Cmd+G is the host's Group).
- **One store per editor** (`find-state.ts`, scoped): the options, the last hits, the hit gone
  to, the status line. The dialog and the results panel are two views of it.
- **The dialog** is modeless (the document stays editable behind it): Find / Replace with fields,
  Match case, Whole words only, Current story only, Search mode (text, Word wildcards, regular
  expression), a Special menu inserting `^p` `^t` `^l` `^m` `^?` `^#` `^$` (find) or `^p` `^t`
  `^l` `^&` (replace), Find style (paragraph / character style filter) and Replace with style;
  Find previous / Find next / Replace / Replace all, and a status line (`2 of 7`, `Not found`,
  `3 replacements`).
- **Find next** goes from the selection: the next hit in the caret's story, else the first of
  the stories after it (hits come in document story order), wrapping. The hit is revealed and
  selected through the page doors' `revealText` (the camera onto it, then the text selection).
- **Replace** replaces the hit the selection stands on, not the document's first: one batch of
  `deleteRange` + `insertText` (+ `applyStyle` for a replace style), one undo step, with the
  replacement's specials and groups expanded as the engine does (`replacementFor`); then it goes
  to the next hit. Standing on no hit, the first press finds, as in Word.
- **Replace All** is the engine's one `findReplace` (`replaceAll: true`): one undo step however
  many hits.
- **The results panel** (`paged.find-results`, left dock with the Pages panel: the Navigation
  pane's Results tab) has a search field (Enter searches, again goes to the next hit), Match case
  and Whole word, the count, and every hit with its context, the match marked; a click goes to
  the hit. After an edit the search runs again (debounced).

## Consequences

- Every text document gets Find & Replace; paged.doc gets Word's keys onto it without a dialog of
  its own.
- Residuals inherited from engine ADR 1021: table cells and notes are not searched; "find by
  format" filters on applied styles only; `^m` cannot be put in by a replace.
- The panel and dialog are covered by `test/find/find-replace.dom.test.tsx` over the real engine
  and by the `doc-word-editing` journey (Cmd+H → Replace All → one undo).

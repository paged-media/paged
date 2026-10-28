# ADR 301 — Headers, footers and notes are edited in place

- **Status:** Accepted 2026-10-28.
- **Scope:** `packages/shell/src/registries/sub-context.ts`,
  `packages/shell/src/state/sub-context-controller.tsx` (`SubContextController`,
  `useSubContextEntry`, `storyEndOffset`), `packages/shell/src/overlays/sub-context.tsx`,
  `packages/shell/src/state/content-selection-context.tsx` (`pagePin`, `pinToPage`),
  `packages/shell/src/state/edit-context-controller.tsx` (Escape),
  `apps/canvas/src/ui/ViewportCanvas.tsx` (the double-click), `apps/canvas/src/app/mount.tsx`.
  Contract: extensions ADR 349 (C6). Engine: ADR 1022 (a Word section's headers and footers are
  master frames whose stories are ordinary stories; `PageSummary.appliedMaster`). First
  consumer: paged.doc (doc ADR 611).

## Context

Word's headers and footers are edited where they stand: a double-click on the header area of a
page puts the caret in that page's header, dims the body, and shows a bar with Different First
Page, Different Odd & Even Pages, Link to Previous and the page-number and date fields; Esc or a
double-click in the body returns. paged.doc places a Word section's headers and footers on
masters (engine ADR 1022), which the editor shows on every page but never let the user type
into: a master item is not hit by the canvas's hit test on a body page, and the caret and range
geometry of a story the engine lays out on several pages (a master's) is answered on the first
of them.

## Decision

- **The bundle decides what a double-click on a page edits.** A sub-context provider (extensions
  ADR 349) of the active edit context, else of the document context (ADR 298), is offered every
  page double-click FIRST, with any tool, before the hit test. It answers from what it knows
  (the page's master and where its header and footer frames stand) with the story, the page,
  the area and the bar's commands, or `null`, which leaves the double-click to the canvas (a
  word selection in the body, entering a frame). The editor learns no Word vocabulary.
- **Entering** puts the caret at the end of the story (or the offset given), takes the Type
  tool, and pins the story's caret and range to the page entered on: the engine's geometry is
  page-local, a master frame stands at the same place on every page that shows the master, so
  the controller only replaces the page (`pinToPage`). Typing, deleting and the text keys are
  the ordinary text input (ADR 234) on that story.
- **The chrome** is an overlay: the isolation veil (WP4.6) with the edited area cut out,
  a dashed outline round the area, and a slim bar under a header (over a footer or a note) with
  the label, the bundle's commands as buttons and Close. The veil takes no pointer events.
- **Leaving.** The sub-context ends when the caret leaves its story: Escape takes the caret out
  of the text (inside a frame-level context Escape is now the text's while a sub-context is
  shown, not the context's), a click in the body moves it. Close, the bundle's
  `exitSubContext` and a newly loaded document end it too and take the caret with them.

## Consequences

- A Word user edits a header on the page they see it on, with Word's gesture and keys.
- The same door serves a footnote's text once the engine can put a caret in it (`kind: "note"`).
- **Engine gaps, worked around here, recorded for the engine:** the hit test does not see master
  items, so a click inside the header while editing it does not move the caret (the arrows,
  Home/End and the mouse in the body do what they do); `caretNav` and the line reads walk a
  master story's lines on every page that shows it, so Up/Down may land on another page's copy.
  A page-qualified content selection (`ContentSelection.pageId`) and master items in
  `hitTest` close both.
- Tests: `packages/shell/test/state/sub-context.dom.test.tsx` (registry order and per-bundle
  exit, a provider that throws, the pin, entering by double-click in the document context with
  the caret at the story's end on the entered page, the veil and the bar's command, leaving by
  the caret, Close and a new document).

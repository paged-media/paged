# ADR 725 — A deck opens in the slide sorter: the sorter is a deck's navigation

- **Status:** Accepted 2026-11-14.
- **Scope:** `packages/slide-bundle/src/show/sorter-on-open.ts` (the sorter on open and its
  switch), `src/activate.ts` (wiring it, the play door handed to the sorter),
  `views/slide-sorter.tsx` (Play, notes, the current slide, the keys, the delete, the aspect-aware
  grid, the "open decks here" switch), `panels/slides-panel.tsx` (a thumbnail's actions on hover
  and focus), `messages.ts` and `locales/de.json`; the editor's test harness
  (`apps/editor/apps/canvas/tests/fidelity/canvas-driver.ts`, `slideSorterOnOpen`). Task CM5
  (slide) of the editor's interaction plan; the UX strategy's §7.7; UX audit F-47. Extends
  [ADR 716](716-slide-show-and-presenter-view.md) (the sorter as a module view) and
  [ADR 720](720-output-formats-including-mp4.md) (sections). No contract change: the bundle uses
  `host.shell.showView`, `host.viewport` and `host.storage` as they are.

## Context

A ten-slide deck opened as a vertical stack of pages at about 11 %, the same as a long document;
the slide sorter existed behind View ▸ Slide Sorter only (F-47). The sorter showed thumbnails,
sections, drag to rearrange, hidden slides and transitions, but no Play, no speaker notes, no mark
of the slide being edited and no keyboard; the Slides panel repeated Duplicate, Delete and Hide
under every thumbnail.

## Decision

1. **A deck of two or more slides opens in the sorter.** When a document opens and the store says
   it is a deck, the bundle shows the sorter view once for that document; a one-slide deck (a new
   presentation) opens on its slide. Normal view, a double-click on a slide or Enter leaves the
   sorter for the canvas; View ▸ Slide Sorter comes back. A switch in the sorter's toolbar, "Open
   decks in the sorter", turns this off (kept in the bundle's storage, `sorterOnOpen`). The
   rendering and the object model are the canvas's: the sorter's thumbnails are the engine's
   snapshots of the same pages.
2. **The sorter is a deck's navigation.** Its toolbar plays the show (from the first selected
   slide, else the beginning) and shows the speaker notes under each thumbnail on request; the
   slide shown on the canvas is marked; the arrow keys move through the slides (Shift extends the
   selection), Home and End go to the ends, Enter opens the slide in Normal view, Delete removes
   the selected slides in one batch (one undo step); a portrait deck gets narrower columns. Every
   rearrangement, section edit, hide and delete stays one mutation, one undo step, as before.
3. **The Slides panel's per-slide actions appear on hover and focus** (Duplicate, Delete, Hide),
   not under every thumbnail at once.
4. **Tests boot without it.** The editor's browser suite opens decks on the canvas unless a spec
   opts in (`openCanvas(page, { slideSorterOnOpen: true })`), as it boots without the adaptive
   workspace: every existing deck journey edits on the canvas.

## Interaction contract (the specification's §21.3)

The sorter owns no canvas pointer (it is a view in the canvas's place); its keys are its own while
it has focus; every change is one undo step through the document; a refused mutation is logged and
changes nothing; Escape is not taken (Normal view is the way back, by button or Enter).

## Consequences

- Tests: `packages/slide-bundle/test/show/show-surfaces.dom.test.tsx` (the deck opening in the
  sorter, its notes, current slide, keys and one-step delete), `test/sorter-on-open.spec.ts` (the sorter on open,
  once per document, not for one slide, not when switched off) and in the editor
  `tests/e2e/slide-sorter-default.spec.ts` (a deck opens in the sorter; Enter opens the slide; the
  model and the history).
- UX audit F-47: a deck has a sorter as its navigation, per-slide actions on hover, and Play in the
  sorter. Page nouns ("Slide 2" in the Document Map and the page captions) are the host's and are
  not changed here.

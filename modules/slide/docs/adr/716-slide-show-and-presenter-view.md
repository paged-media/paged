# ADR 716 — Slide show and presenter view

- **Status:** Accepted 2026-10-25.
- **Scope:** `packages/slide-bundle/src/show/` (`show-model.ts`, `slide-show.ts`, `presenter.ts`,
  `frames.ts`, `compositor.ts`, `ink.ts`, `transition-renderer.ts`, `contribute.ts`),
  `packages/slide-bundle/src/views/slide-sorter.tsx`. Part of the PowerPoint parity program
  (ADR 711, wave 2), on extensions ADRs 345 and 346 and editor ADRs 304–306. Transitions are
  drawn as ADR 721 decides.

## Context

A deck in the editor could be edited and exported but not shown. PowerPoint's Slide Show (F5,
Shift+F5), Presenter View (Alt+F5), Rehearse Timings and Slide Sorter are what a user expects
next, with PowerPoint's keys.

## Decision

- **One presentation, three roles.** `media.paged.slide.show` draws a single-screen show
  (`show`), a presenter console (`console`) or the audience window (`audience`), by the role the
  host gives it. The console owns the show and sends the audience a snapshot after every change
  over the presentation's channel; a key pressed in the audience window goes back to it.
- **A pure state machine** (`show-model.ts`) holds the slide up, the blank screens, the typed
  digits, the grid, the pointer tool and the end. PowerPoint's keys: next N, →, ↓, Space, Enter,
  Page Down; previous P, ←, ↑, Backspace, Page Up; a number and Enter jumps (hidden slides
  too); B or . black, W or , white (an advance key only takes the screen back); Home, End; G the
  slide grid; Ctrl/Cmd+L laser, Ctrl/Cmd+P pen, Ctrl/Cmd+A arrow, E erase; Esc ends. Hidden
  slides are skipped by next and previous. After the last slide comes a black end screen; the
  next advance ends the show, or with `loop` the show starts over until Esc.
- **Timings.** A slide whose transition says "after N seconds" (`advanceAfterMs`, which the
  Transition panel edits; the deck's own `advTm` from the import report when the label has none)
  advances by itself, unless the screen is blanked or the grid is open. Rehearse Timings runs the
  show without them, times each slide, and on exit writes the times into the slides'
  transitions (`advanceAfterMs`, rounded to 10 ms, `advanceOnClick` kept) in one undo step.
- **Frames.** Each slide is `host.render.layers(page).background` (extensions ADR 346) at the
  screen's resolution, decoded, cached per page and scale, and prefetched a slide ahead. They
  are drawn as the exports draw, without the editor's substituted-font highlight. Per-item layers
  come with animations (wave 5).
- **Transitions** go through the `TransitionRenderer` seam (`transition-renderer.ts`): WebGPU,
  one WGSL shader per kind, registered by the shader library (ADR 721). Without a registered
  renderer, or without WebGPU, fade-like kinds cross-fade on the 2D canvas and the rest cut.
- **Ink.** The pen draws on the slide and the laser follows the pointer; strokes are kept per
  slide for the show in slide coordinates, so the audience draws them at its size. They are not
  written into the document.
- **The presenter console** shows the slide up (pen and laser on it), the next slide, the notes
  with their own zoom, a timer that pauses and resets, the clock, slide x of y, the grid, a black
  screen and End show. Without an audience window it runs alone and says so.
- **The editor afterwards.** When the show ends the editor goes to the slide it ended on.
- **Slide Sorter** is a module view (extensions ADR 345, C5): the slides as a grid of thumbnails;
  click, Shift+click and Cmd/Ctrl+click select; dragging moves the selection; the bar hides or
  shows the selection and sets its transition (a changed kind drops the deck's own element, which
  no longer describes it); a double-click opens a slide in the normal view. Each edit is one undo
  step.
- **Commands.** Slide Show ▸ From Beginning (F5), From Current Slide (Shift+F5), Presenter View
  (Alt+F5), Rehearse Timings, and View ▸ Slide Sorter, each a palette command with a typed twin
  (ADR 323), offered in a deck while no show runs and no text caret is active.

## Consequences

- The solo slide profile binds the same commands; the show needs nothing from it.
- Custom shows, sections in the sorter and saving ink as annotations are later work (wave 6).
- The audience window is drawn by the editor window's code; a standalone audience page can join
  the same channel later (editor ADR 305).

# ADR 345 — Presentations and module views

- **Status:** Accepted 2026-10-25.
- **Scope:** `PresentationContribution`, `PresentationContext`, `PresentationChannel`,
  `PresentRequest`, `PresentResult`, `PresentationState`, `PresentationRegistry`,
  `ViewContribution`, `ViewProps` and `ViewRegistry` in `packages/plugin-api/src/editor.ts`;
  `ContributionSurface.presentation` / `view` and `ShellSurface.present` / `exitPresent` /
  `presentation` / `onDidChangePresentation` / `showView` / `activeView` / `onDidChangeView` in
  `packages/plugin-api/src/host.ts`; `contributes.presentations` and `contributes.views` in the
  manifest; the doors in `packages/plugin-sdk/src/host-impl.ts`; the harness's presenter and view
  registry. Contracts C1 and C5 of the PowerPoint parity program (slide ADR 711). The editor half
  is editor ADRs 304, 305 and 306.

## Context

A slide show fills the screen, and a presenter view puts a console on one screen and the slides
on another. A slide sorter replaces the canvas with a grid of slides while the document stays
open. ADR 323 gave a presentation plugin page navigation and page images and left the screen
itself out: "fullscreen presenting and a presenter window need a shell surface". The sheet's full
screen (ADR 334, editor ADR 283) hides the chrome for one entered frame through a chrome override;
it is not a door a bundle can open, and it cannot reach a second window.

## Decision

- **A presentation (C1).** `contribute.presentation({ id, title?, render(el, ctx) })` registers a
  surface the host shows on `host.shell.present({ id, target, options })`:
  - `"screen"`: one surface over the editor's window, in the browser's full screen where it
    allows it;
  - `"window"`: one surface in a window of its own;
  - `"secondary"`: a `"console"` surface in the editor's window and an `"audience"` surface in a
    window of its own, placed on another screen when the browser allows it. When that window
    cannot open, the console is shown alone on the screen and the answer's `target` is
    `"screen"`.
- **`render` is DOM, not React.** A surface can live in a window the bundle's React root does not
  reach. `render` gets an empty element and a context (`id`, `target`, `role`, `options`, the
  surface's `window`, a `channel`, `exit()`), and answers a cleanup.
- **One channel per presentation.** The surfaces of one presentation talk over
  `ctx.channel`, a `BroadcastChannel` named for it with one end per surface. A surface never
  receives its own messages. The console owns the state; the audience draws what it is sent.
- **Keys belong to the surface.** The host makes each surface root a key-owning container
  (`role="dialog"`, `aria-modal`) and focuses it, so the editor's bindings leave plain keys alone;
  a Cmd/Ctrl chord reaches the editor only if the surface lets it bubble.
- **Only one's own.** A bundle presents, exits and shows only what it registered. `present` must
  be called from a user gesture: a browser opens a window and enters full screen only then.
- **A module view (C5).** `contribute.view({ id, title, render })` registers a React work surface
  the host shows in place of the canvas on `host.shell.showView(id)`; `showView(null)` gives the
  canvas back. One view is shown at a time; the canvas stays mounted behind it.
- **Declared like importers.** `contributes.presentations[]` and `contributes.views[]` list the
  ids, namespaced under the bundle's id. The CLI validator and the conformance check know both.
- **Probes.** `contribute.presentation@1` and `contribute.view@1` (the doors, static);
  `shell.present@1`, `shell.present.secondary@1` and `shell.views@1` (the editor's registries).
  Without a registry the doors warn and register nothing, `present` answers
  `{ presented: false }` and `showView` answers `false`.

## Consequences

- paged.slide's slide show, presenter view and slide sorter are built on these doors (slide
  ADR 716).
- The harness wires a presenter and a view registry that keep the state and draw nothing, so a
  headless test asserts what was asked for.
- The sheet's full screen stays an edit-context presentation (ADR 334). A later change can let a
  frame surface ask for a presentation instead.

## Related

- [ADR 323](323-page-navigation-and-page-images.md) — page navigation and page images.
- [ADR 334](334-a-frame-surface-for-live-editing.md) — frame surfaces and their full screen.
- [ADR 346](346-page-layers.md) — the frames a presentation draws.

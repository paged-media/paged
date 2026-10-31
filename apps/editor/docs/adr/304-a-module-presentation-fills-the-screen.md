# ADR 304 — A module's presentation fills the screen

- **Status:** Accepted 2026-10-25.
- **Scope:** `packages/shell/src/registries/presentation.ts` (`createPresentationRegistry`,
  `PRESENTATION_ATTR`), `packages/shell/src/cockpit/PresentationChrome.tsx`, the `presentations`
  registry in `state/registries-context.tsx`. The editor half of extensions ADR 345 (C1).
  Generalises [ADR 283](283-a-frame-surface-goes-full-screen.md).

## Context

A slide show needs the whole screen: no menu bar, panels, rulers or thumbnails, and the browser's
own full screen. ADR 283 hides the chrome for one entered frame through a chrome override. A
presentation is not tied to a frame, and its surface can also live in another window
(ADR 305), where React does not render.

## Decision

- **The presenter is plain DOM.** The `presentations` registry holds the bundles' presentations
  and shows one at a time. For a surface in the editor's window it makes a root fixed over the
  whole window (black, above everything), marks it `data-paged-presentation="<role>"`, makes it a
  key-owning container (`role="dialog"`, `aria-modal`, focused) and hands it to the
  contribution's `render`.
- **The chrome goes through the one mechanism.** `PresentationChrome` (in the cockpit layout)
  pushes a chrome override that keeps only the canvas region, with no title bar, rulers or
  thumbnails, while a presentation fills the editor's window, and pops it when it ends. The
  canvas stays mounted under the surface, so the engine keeps rendering the pages the show draws.
- **Full screen.** On the `screen` target the presenter asks for the browser's full screen on the
  surface root. A refusal leaves the surface filling the window. Leaving full screen with the
  browser's own Esc ends the presentation.
- **Exit.** `ctx.exit()`, `host.shell.exitPresent()`, disposing the contribution or presenting
  another presentation run the surface's cleanup, remove the root, leave full screen and close
  any window the presenter opened.
- **Probe.** The registry makes the SDK report `shell.present@1`.

## Consequences

- The sheet's full screen (ADR 283) stays as it is: it belongs to an entered frame and keeps the
  frame surface's React tree.
- A presentation draws over everything, including toasts and dialogs the editor opens while it
  runs; the bundle owns what the user sees until it exits.

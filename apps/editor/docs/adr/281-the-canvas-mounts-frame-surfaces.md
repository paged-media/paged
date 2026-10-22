# ADR 281 — The canvas mounts a bundle's frame surface over the active frame

- **Status:** Accepted 2026-10-22.
- **Scope:** `apps/canvas/src/ui/FrameSurfaceHost.tsx`, `ViewportCanvas.tsx`, `main.tsx` and
  `plugin-host-options.ts` (`exitEditContext`); `packages/shell` (`registries/frame-surface.ts`,
  `ShellRegistries.frameSurfaces`, `focus/key-ownership.ts`, `state/edit-context-stack.tsx`).
  The contract is extensions ADR 334.

## Context

Extensions ADR 334 lets a bundle contribute a live DOM surface for one of its edit contexts. The
editor has to place it over the frame, keep it there, decide which events are the surface's,
and end the context when the surface asks.

## Decision

- **Where.** `FrameSurfaceHost` renders inside the viewport's host element, above the canvas and
  the overlay SVG and below the HUD, when the active edit context has a registered surface and
  its frame has geometry on a laid-out page. Its transform is computed from the same camera,
  page rectangles and element geometry the selection chrome and the content-point mapping use.
- **Events.** Pointer, double-click, context-menu and (plain) wheel events stop at the surface's
  root, so the canvas's tools and the click-outside commit do not see them. A press outside the
  surface still reaches the canvas and commits the context as before. Cmd/Ctrl-wheel passes
  through and zooms.
- **Keys.** The root carries `data-paged-frame-surface`; `canvasKeyYields` treats focus inside
  it as owning the key, as it does for a dialog.
- **Exit.** The surface's `exit` and `host.shell.exitEditContext` commit or cancel the stack's
  top frame when it is of the bundle's type.
- **Selection moved.** When the selection moves to another element while a context is active,
  the stack now commits each frame before exiting (`exitAll({ commit: true })`), matching a click
  outside. Clearing the stack on document close still only exits.

## Consequences

- One viewport mounts the interactive surface; a second viewport shows page content, which
  updates when the context ends.
- The surface follows the current camera. If a fast pan shows the surface ahead of the canvas,
  the host will position it with the camera of the last presented frame instead.
- Full-screen presentation is a later decision (it builds on the shell's chrome regions).

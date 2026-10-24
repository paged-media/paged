# ADR 283 — A frame surface goes full screen through a chrome override

- **Status:** Accepted 2026-10-23.
- **Scope:** `packages/shell/src/state/chrome-regions.tsx` (`useChromeOverride`,
  `ChromeOverride`), `packages/shell/src/registries/frame-surface.ts` (`fullscreen`),
  `apps/canvas/src/ui/FrameSurfaceHost.tsx`. Builds on ADR 281 and extensions ADR 334; uses the
  chrome-regions mechanism of ADRs 274/275.

## Context

A spreadsheet edited inside a small frame on a page is cramped. The frame surface contract
(extensions ADR 334) lets a bundle ask for a full-screen presentation; the editor has to give
the surface the whole work area and give the page back afterwards, without a second way of
hiding chrome next to the editor profile's regions.

## Decision

- **One mechanism.** `ChromeRegionsProvider` keeps a stack of temporary overrides;
  `useChromeOverride()` pushes one and returns its pop. An override only narrows what the
  profile allows: the regions it keeps, and the canvas furniture (title bar, rulers,
  thumbnails) it switches off. No flag in `PagedShell`.
- **Full screen.** On `requestPresentation("fullscreen")` the frame-surface host pushes an
  override that keeps the canvas region and the context menu, with no title bar, rulers or
  thumbnails, and lays the surface out upright and unscaled over the whole canvas host (one CSS
  pixel a point), its bar along the top. `presentation` and `frameBoxPt` tell the surface which
  presentation it is in and how large the frame is, so it can mark the part that lands on the
  page.
- **Leaving.** `requestPresentation("frame")` (the sheet's Esc and its bar button) pops the
  override and puts the surface back on the frame; leaving the edit context from full screen
  pops it too. Full screen belongs to one entered frame.
- **Probe.** The registry's `fullscreen: true` makes the SDK report
  `editContext.frameSurface.fullscreen@1`.

## Consequences

- The browser's own Fullscreen API is not used; a later toggle in the bar can add it.
- The right dock is hidden in full screen; offering the property panels there is a later
  addition to the override's kept regions.

## Amendment 2026-10-24

The sheet's full-screen bar now offers the browser's Fullscreen API as a "Whole screen" toggle,
next to "Back to page" in its header (ADR 284). In full screen the sheet keeps sheet tabs, a
status bar (Ready/Edit, Average · Count · Sum) and its own zoom (10–400 %, Ctrl/Cmd + wheel)
under the grid, inside the surface. The host's zoom and the page camera do not change.

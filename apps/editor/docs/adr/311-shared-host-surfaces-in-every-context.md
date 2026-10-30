# ADR 311 — Gradients, Picture adjustments, History and Free Transform in every edit context

- **Status:** Accepted 2026-10-30.
- **Scope:** `packages/shell/src/state/tool-context.tsx` (`CONTEXT_SHARED_TOOL_IDS`,
  `toolStaysInContext`), the leaving-by-tool rule of `state/edit-context-controller.tsx`, the
  rail's restriction in `chrome/ToolRail.tsx`, `apps/canvas/src/ui/ViewportCanvas.tsx` and
  `FrameSurfaceHost.tsx` (a press with the shared tool in hand), and the solo profiles
  (`apps/canvas/src/solo/profiles.ts`). Plan WP10.7; builds on ADR 024 (applicability), ADR 213
  (solo mode), ADR 281 (frame surfaces), ADR 285 (History), ADR 295 (Free Transform) and
  ADR 309 (Effects, Transparency and Appearance in every context).

## Context

Every module enters its own edit context on a frame: a Word document, a slide deck, a sheet, a
vector graphic, a raster image, a web frame, a data binding. ADR 309 made the Effects,
Transparency and Appearance panels available in each. The other host surfaces that act on any
page item were not, or only by accident:

- **Free Transform** was hidden inside every context that declares `toolIds` (the rail hides a
  tool the context does not list), and picking it by its key left the context (ADR 024's
  leaving by tool). Inside a sheet or a web frame the module's frame surface (ADR 281) sat over
  the frame and took every press, so the tool could not reach the frame even when in hand.
- **Gradients, Picture adjustments and History** were offered in each context (no context
  claims them, so `panelBelongsHere` offers them), but solo applications dropped them: only
  `paged.draw` kept Gradients, three profiles kept Picture adjustments, none kept History.

## Decision

- **Free Transform is a context-shared host tool.** `CONTEXT_SHARED_TOOL_IDS` lists it.
  Inside a context that restricts the rail it stays on the rail; picking it, by the rail or by
  `e` where no tool of the context claims that key, keeps the context (`toolStaysInContext`: the context's own tools, Hand and Zoom, and the
  shared tools); with it in hand a press goes to the tool, not to the context's content
  pointer, and the frame surface lets presses through to the canvas (it stays drawn). The tool
  then moves, scales, rotates and shears the frame being edited — one engine gesture and one
  undo step, as on the page. The context bar still says no canvas tool edits a sheet's content:
  Free Transform edits the frame, not what is in it.
- **Every solo profile keeps Gradients, Picture adjustments, History and Free Transform**
  (`SHARED_HOST_PANELS`, `SHARED_HOST_TOOLS`, each added once to a profile's own list).
- **Inside a raster image the Gradients panel's Fill row is the foreground colour well.**
  paged.image serves `frameFillColor` there (its colour provider, ADR 023), and a gradient is
  not a colour, so the row is disabled rather than writing the frame behind the user's back. On
  the page the gradient applies to the image's placement as to any frame.

## Consequences

- An editor e2e per context (`tests/host-panels-every-context.spec.ts`: doc, slide, sheet,
  draw, image, web, data and a publish document) enters the context, opens each panel through
  its menu row, performs one action and asserts one engine undo step and that the context is
  still the one entered. A unit test holds the applicability and the profiles.
- A module that wants a tool of its own in place of Free Transform inside its context (the
  image's layer transform) keeps it; the shared tool transforms the placement beside it.
- A further shared tool joins `CONTEXT_SHARED_TOOL_IDS`; a further shared panel joins
  `SHARED_HOST_PANELS` (ADR 309's three can move there when both land).

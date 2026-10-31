# ADR 340 — The workspace and readout lanes: an edit context's rulers, guides, grid and Info rows

- **Status:** Accepted 2026-10-27. (Number assigned at merge.)
- **Scope:** `packages/plugin-api/src/{binding-provider,index}.ts`,
  `packages/plugin-sdk/src/host-impl.ts`. Editor side: the rulers, guide overlay, guide drag
  controller, grid overlay and Info panel read the lanes. First consumer: paged.image's raster
  context (image ADR 471, WP5.12). DESIGN.md §18.13.

## Context

Inside a raster image a user measures in pixels from the image's corner, drags guides that
belong to the image (Photoshop keeps them in the file), sees the grid over the image and reads
the pixel under the cursor in the Info panel. The host already had all of that for the page:
rulers in the document unit, guide drag-out, move and delete, the document grid (editor ADR
287) and the Info panel (WP4.5). The image module had none of it, and the only way to get it
was a second set of rulers, guides, grid and Info panel inside the module.

## Decision

Two optional lanes on the binding provider (ADR-023), so the active context answers for the
host's chrome the way it already answers for its panels:

- **Workspace**: `provides.workspace`, `readWorkspace()` → a page, an origin on it, page pt per
  base unit, the extent, the ruler unit, base units per physical point, the context's guides
  and whether they show and are locked; `editGuide(edit)` for create / move / delete from the
  host's guide machinery (one undo step in the context's own history); `workspaceView(view)`,
  the host's grid and snapping state, delivered on activation and on change.
- **Readouts**: `provides.readouts: ["info"]`, `readReadouts()` → titled sections of
  label / value rows, re-read on `invalidate()`.
- The registry answers `readWorkspace`, `editGuide`, `setWorkspaceView` and `readReadouts` to the
  host, innermost active claimer first; a declined workspace keeps the page rulers.
- Dynamic flags `bindings.workspace@1` and `bindings.readouts@1`, true with a shared registry.
- plugin-sdk / plugin-api move to 0.74.3-canary.32.

## Alternatives considered

- A second ruler/guide/grid implementation in the image module: rejected, it duplicates host
  chrome (plan Phase 11) and could never sit where the page rulers sit.
- Synthetic `PropertyPath`s for guides and readouts: rejected by the vocabulary rule (§18.6);
  these are host chrome, not document values.
- A separate `contribute.workspace` door: rejected, it would need its own activation; the
  provider already borrows the context's.

## Consequences

- Any content type with a measurable frame (a sheet, a slide) can drive the host rulers and
  guides without host code that knows it.
- Rotated frames are out of scope: the provider declines and the page rulers stay.

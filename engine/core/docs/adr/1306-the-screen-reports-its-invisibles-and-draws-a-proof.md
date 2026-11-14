# ADR 1306 — The screen reports its invisibles and draws a proof; both lanes draw a page to one extent

- **Status:** Accepted 2026-11-14.
- **Scope:** protocol v81. `paged-canvas` (`invisibles.rs`: `CanvasModel::hidden_characters`;
  `frame_grids.rs`: `CanvasModel::frame_baseline_grids`; `view.rs`: `ViewSettings.hideNonprinting`
  / `proof`, `screen_extent`; `model.rs`: `set_view_settings` rebuilds on a build option, the live
  build's `omit_nonprinting` / `degraded_asset_markers`; `hit.rs`: nonprinting items are not hit
  while hidden; `snapshot.rs`: `render_screen_tile_png`), `paged-renderer` (`LineLayout.turn`,
  `pipeline::frame_custom_grid`), `paged-gpu` (`screen.rs`: `screen_extent`;
  `vello_rs::screen_page_scene`; `SurfacePresenter::build_page_scene_framed` and the raster page
  scene over the extent), `paged-canvas-wasm` (the two new kinds, `ViewSettingsApplied.rebuilt`,
  `renderTilePng` draws the extent, `screenExtent`, the presenter's page edge), the editor's worker
  (`render.ts`) and client (`hiddenCharacters`, `frameBaselineGrids`). The engine's side of editor
  ADR 1212 (Editing aids and Proof view), which recorded these five gaps.

## Context

Editor ADR 1212 gave the canvas eight editing aids and a Proof view, and shipped two aids
disabled and three proof shortcomings, each waiting on the engine:

1. **Hidden characters.** Nothing reported where a composed line holds its spaces, tabs,
   returns, forced line breaks or the end of its story.
2. **Nonprinting items.** The export leaves them out (`omit_nonprinting`, ADR 1095); the screen
   always drew them, and no view option could hide them.
3. **A proof that is a proof.** The GPU presenter drew a 1 pt grey page edge into every page
   scene, and the live build always painted the degraded-asset markers (the pink behind a
   substituted face, the cross over a placed EPS or PDF whose link is missing).
4. **Bleed.** The CPU lane's tile was a page-sized raster, so it cut every page at its trim; the
   GPU lane drew the display list unclipped, so bleed artwork and items left on the pasteboard
   spilled past the page. The same document showed different pages on the two lanes (engine
   ADR 146 holds the GPU lane to the CPU lane).
5. **Per-frame baseline grids.** A text frame's own grid (Text Frame Options ▸ Baseline Options)
   steered the composer (ADR 140) but was not on the wire, so the editor's Baseline grid aid drew
   the document's grid only.

## Decision

**Hidden characters are reported, and the editor draws them.** `RequestHiddenCharacters {
pageIds }` answers `HiddenCharacters { pages, revision }`: per page, per composed line, each
invisible's kind and x on the line (`HiddenCharacterKind`: space, nonbreaking and fixed-width
spaces, tab, forced and discretionary line breaks, an anchored object's place, the paragraph's
end, the break characters a following paragraph's `StartParagraph` stands for, the end of the
story or of a cell's text), with the line's baseline, text size and turn. It reads the build the
canvas holds — the per-cluster positions the caret and the hit test use and the story text they
index — so it costs a walk over the lines of the pages asked for. The line's turn is new on
`LineLayout` (`turn`: the affine a turned frame, and a vertical story's quarter turn, apply to the
line's glyphs; the recorded positions stay upright, as the caret's always were).

Why a report and an overlay, not a render layer: interaction and what is drawn over the page
are the engine's answers and the main thread's SVG (ADR 114), and every other editing aid is an
overlay under one rule — shown while its aid is on and the view is not a proof (editor ADR 1212).
Drawn into the page raster, the marks would be a build or raster option: every toggle would
rebuild and re-rasterise the visible pages on both lanes, the display list and its digest
(ADR 101) would carry what never prints, and the proof rule would need a second home. As a
report, a toggle costs no rebuild, both lanes are untouched, and the editor asks only for the
pages in view.

**Nonprinting items and a proof are view options of the live build.** `ViewSettings` gains
`hideNonprinting` and `proof` (both optional, off by default):

- `hideNonprinting` builds the live pages with `omit_nonprinting`, the export's own rule (ADR
  1095), so the screen without them is the print; the hit test and the marquee skip a nonprinting
  item while it is off the screen, as they skip a hidden one (F-41).
- `proof` builds without `degraded_asset_markers` — the page is the export's — and both lanes
  leave the page edge out (the presenter's page scene; the worker's tile loop). A missing image
  keeps InDesign's grey placeholder, which the export prints too.

Unlike the view mode (a raster-time rewrite, editor ADR 287), these change the live build, so
`SetViewSettings` rebuilds every page when one changes (`ViewSettings::build_differs`), dropping
the cross-build emit caches that were filled under the other options, and says so
(`ViewSettingsApplied.rebuilt`); the wasm dispatch drops every cached page scene. Neither is a
document change: no undo step, the document's hash unchanged, nothing saved. Exports and
separations still build the document as printed; a snapshot that asks for the canvas's markers
reads the live pages as before, and `live_build_is_export_faithful` now counts the nonprinting
items the live build draws. The editor sets `proof` in every proof screen mode and
`hideNonprinting` while the Nonprinting items aid is off or a proof is on.

**One screen extent for both lanes.** On screen a page draws its artwork past its trim — what
bleeds, and what was left on the pasteboard beside it, as InDesign's Normal view shows — out to
the pasteboard's reach, one page width and height past each edge; the paper is the trim alone.
`paged_gpu::screen::screen_extent` is the rule: the trim grown to what the display list paints
(padded a point for antialiasing, in whole points), within the reach. The CPU lane's tile is a
raster of exactly that rect on a transparent ground (`renderTilePng`, at its width across the
trim so a page that spills keeps its resolution), drawn by the worker at `screenExtent(pageId)`
over the paper; the GPU lane's page scene (`screen_page_scene`, shared by the presenter and the
viewer session) draws the list over the paper and clips it to the same rect when the artwork
reaches past it; Overprint Preview's raster scene covers the extent too. The proof views mask
the pasteboard over either (editor ADR 1212). `tests/it/screen_parity.rs` (paged-gpu) draws a
page that bleeds and an item past the reach through both lanes' screen paths and compares them.

**A frame's own baseline grid is on the wire.** `RequestFrameBaselineGrids { pageIds }` answers
`FrameBaselineGrids { grids, revision }`: every text frame on those pages (every page when none
is named) that uses a grid of its own, with its box and transform (as `ElementGeometryItem`), the
first line's distance below the frame's top edge and the increment — the grid the composer sets
the frame's aligned lines on (`pipeline::frame_custom_grid`, the same computation), and what it
is measured from. A grid measured from the page on a turned frame, which the composer does not
apply, is not reported. The frame grid's colour is not read; the editor draws frame grids in one
colour of its own.

## Consequences

- The editor's Hidden characters and Nonprinting items aids work (editor ADR 1212, amendment
  2026-11-14); its Baseline grid aid draws each frame's own grid; Proof view shows the page
  without its edge, its markers and its nonprinting items; the CPU and GPU lanes show the same
  bleed.
- Hiding nonprinting items or switching a proof costs one whole-document rebuild per toggle.
- The CLI sends neither new kind (`cli_surface.rs`: 44 of 93); its renders are exports.
- Tests: `paged-canvas` `it::screen_aids` (the marks and their positions, a turned line, the
  rebuild without the nonprinting item and the hit test, the proof without markers, the CPU tile
  over the bleed, the frame grid) and `invisibles` unit tests; `paged-canvas-wasm`
  `it::dispatch` (the wire, the cache effect, the settings across a load); `paged-gpu`
  `screen` unit tests and `it::screen_parity`; the editor's `worker-render-extent` unit test, overlay
  units and `tests/e2e/editing-aids.spec.ts`.

## Related

- Editor ADR 1212 — the aids and Proof view; amended.
- ADR 146 — the GPU lane is held to the CPU lane; the screen's extent is one more thing held.
- ADR 1095 — nonprinting items are left out of print; the screen now can too.
- ADR 114 — interaction lives in the engine; the hidden characters follow its split.
- ADR 140 — the baseline grid the composer aligns to.

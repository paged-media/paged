# ADR 288 — Asset Export

- **Status:** Accepted 2026-10-28.
- **Scope:** the Asset Export panel (`apps/canvas/src/panels/asset-export-panel.tsx`, dock id
  `paged.object-export`), its model, run and commands (`apps/canvas/src/asset-export/`), the
  Layers panel's drag payload (`panels/layer-objects.tsx`), `CanvasClient.requestSnapshot`'s
  options (`packages/client`), the engine's encoded snapshot formats
  (`engine/core/crates/paged-canvas/src/snapshot.rs`, `RequestSnapshot.format` / `.quality`,
  `SnapshotPng.bytes`), and the shared ZIP writer (`platform/shared/helpers/src/zip.ts`).
  Work package WP4.8 of the image/draw master plan.

## Context

Illustrator's Asset Export (and Export for Screens) writes artwork, artboards and pages as files
at several scales and in several formats in one go. The editor had pieces of it in different
places: the Export Center wrote whole pages as PNG or browser-encoded JPEG, File ▸ Export ▸ SVG
wrote a page or the selection, the PDF export wrote a page range. Nothing wrote one object as
pixels, nothing wrote WebP or TIFF, and nothing wrote several sizes at once. The dock slot
`paged.object-export` held a concept panel (alt text, tagged-PDF role, EPUB conversion) whose
fields were all seams.

The engine already had what the export needs: `requestSnapshot` draws items alone, a region
and a trimmed image (extensions ADR 338), `paged-svg` writes SVG (engine ADR 1031), and
`paged-raster` encodes PNG, JPEG, WebP and TIFF (engine ADR 1005). Only the encoders were out
of reach of the editor.

## Decision

- **One panel, one store, the same actions as the commands.** The concept panel's slot becomes
  the Asset Export panel. Its assets and export settings live in one scoped store
  (`asset-export/model.ts`); the panel's buttons and the commands run the same functions
  (`asset-export/commands.ts`), so File ▸ Export ▸ Asset Export…, Object ▸ Collect for Export ▸
  As Multiple Assets / As Single Asset, Collect All Artboards and Pages and Export All Assets
  cannot disagree with the panel.
- **An asset is items or a page.** An object asset names page items (one per selected item, or
  all of them as one); a page asset names a page, and a page whose metadata carries an
  `x-paged:paged.artboard` name (engine ADR 1011) is an artboard named after it. A Layers-panel
  row dropped on the list is collected (`application/x-paged-elements`, the ids as JSON). An
  item on the pasteboard belongs to no page and is reported, not collected.
- **Settings are rows of scale, suffix and format.** A scale is 72 ppi × the factor (0.5x to 4x,
  or a custom value up to the snapshot's 2400 ppi); its default suffix is `@<n>x`, which follows
  a scale change until the user edits it. Every asset is written once per row; names that clash
  count up. SVG and PDF ignore the scale, so two vector rows that differ only in scale write one
  file.
- **Pixels come from the snapshot door; the engine encodes them.** An object is drawn with
  `only` its items, `clip` 72 pt around their bounds (`regionAround`, `host.render.element`'s
  recipe) and `trim` on a transparent ground; a page on paper, or transparent on request.
  `RequestSnapshot.format` gains `"jpeg"`, `"webp"` and `"tiff"`, with `quality` for JPEG: the
  CPU rasterizer draws the image and `paged-raster` writes the file into `SnapshotPng.bytes`,
  the sRGB profile embedded and the resolution set to the dpi. JPEG has no alpha, so the engine
  flattens a transparent image onto white first. The fields are additive (a new enum member and
  `serde(default)` fields on an existing message): no protocol bump. An engine without them
  answers a PNG, and the run refuses that file by name rather than writing a PNG under a JPEG
  name. No second rasteriser or encoder exists in the editor.
- **SVG is `paged-svg`, PDF is the page's.** SVG uses `exportSvg` (the items alone, or the
  page). PDF writes a page or artboard through the PDF export with that one page as its range.
  A PDF of some items needs an item-filtered PDF export the engine does not have; the run
  reports it by name and points to SVG.
- **Several files are one ZIP, through the one writer.** The CLI's ZIP writer moved to
  `@paged-media/helpers` (plan C13), with deflate supplied by the caller: the CLI passes
  Node's, the editor stores (its PNG, JPEG and WebP files are compressed already). Several files
  go out as `<document>-assets.zip`; one file, or the ZIP turned off, goes out as one download
  each, through the app's download door. What was not written reaches the Problems list and the
  panel's status line.

## Consequences

- The concept panel's alt-text, tagged-PDF and EPUB sketch is gone from the dock; that
  metadata belongs with Export Tagging's model when it lands.
- WebP is lossless only (`paged-raster` has no lossy WebP encoder).
- The Export Center's page images still encode JPEG in the browser; moving them onto the
  engine's formats is a follow-up.
- An `rgba`-sized image still crosses the worker channel as a JSON number array; the encoded
  formats make that payload smaller, not faster.

## Related

- Extensions [ADR 338](../../../../platform/extensions/docs/adr/338-items-render-to-pixels.md)
  — items render to pixels.
- Engine ADR 1031 — SVG through `paged-svg`; engine ADR 1011 — artboards; engine ADR 1005 —
  `paged-raster`.

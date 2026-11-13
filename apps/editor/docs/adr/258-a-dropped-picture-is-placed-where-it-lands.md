# ADR 258 — A picture dropped on an open document is placed where it lands

- **Status:** Accepted 2026-10-20.
- **Scope:** `packages/shell/src/state/commands/file-commands.ts` (`dropFile`, `dropPlaces`,
  `PlaceDropPayload`), the canvas column's drop handler (`cockpit/CockpitLayout.tsx`),
  `PagedShell`'s `onFile`, and `placeImage` / the Place command's payload
  (`apps/canvas/src/insert-commands.ts`).

## Context

UX audit F-03: with a document open, a picture dropped on the page went to its importer (the
image module decoded it into its panel) and nothing appeared on the page. In InDesign a picture
dropped on a layout is placed at the drop point.

## Decision

- A drop on the canvas carries its point. With a document open, a raster picture (`image/*`
  other than SVG, or a `.png`, `.jpg`, `.gif`, `.webp`, `.bmp`, `.tif`, `.psd`, `.psb` file) is
  handed to Place (`paged.insert.placeImage`) with the file and the point: no picker, no
  second click. Place mints the frame with its top-left at the drop point on the page under
  it, at natural size within the page bound, as a click after File ▸ Place does; a Photoshop
  file goes through its importer as Place already sends it.
- Everything else opens as before: a drop with no document, an SVG (its importer draws it as
  native paths), a document format, and a file from the header's picker.

## Consequences

- F-03's place-on-drop closes (`packages/shell/test/commands/file-commands.test.ts`,
  `apps/canvas/test/unit/commands/insert-commands.test.ts`).
- The other half of F-03 is not changed: with NO document open, a spreadsheet or a picture
  still fills its panel rather than opening a document sized to it.

## Amendment (2026-11-13, [ADR 1205](1205-drop-says-what-it-will-do.md))

A drop says what it will do before it lands, and does exactly that. A picture dropped over a
graphic frame goes into the frame under the pointer (an empty one is filled, one with a picture
has it replaced), never into the selected frame; on a page or the pasteboard it is still placed
as a new frame where it lands. File ▸ Place, which has no pointer to go by, keeps filling the
selected empty frame.

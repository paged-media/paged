# ADR 262 — A file opened with nothing open becomes a document

- **Status:** Accepted 2026-10-20.
- **Scope:** `packages/shell/src/state/commands/file-commands.ts` (`openFile`, `dropFile`,
  `PlaceDropPayload.fillPage`), `packages/shell/src/state/picture-size.ts`,
  `createBlankDocument` (now resolves to the new handle), the command registry's
  `liveEditor()`, `placeImage` (`apps/canvas/src/insert-commands.ts`), the contract's
  `ImportRequest.newDocument` (plugin-api, contract 0.2.89-canary.0), and paged.sheet's `.xlsx` and
  `.csv`/`.tsv` importers.

## Context

UX audit F-03: File ▸ Open (and a drop) accept pictures and spreadsheets, but with no document
open a picture filled the Image adjustments panel and a workbook filled the Workbook panel,
while the canvas still said "No document". Word, PowerPoint, PDF and IDML files open as
documents; these did not. ADR 258 settled the drop onto an open document (a picture is placed
where it lands).

InDesign has no "open a picture" command: a picture is placed into a document. The nearest
equivalent, and what other layout and image editors do on open, is a document whose page is
the picture.

## Decision

With no document open:

- **A picture** (the raster types ADR 258 places) opens as a document of one page the
  picture's size, one point per pixel (Place's natural size, 72 ppi), with the picture placed
  on it edge to edge. The size is read from the file's header (PNG, JPEG, GIF, BMP, WebP,
  PSD/PSB) or, failing that, the browser's decoder. A picture larger than InDesign's largest
  page (15,552 pt) is scaled down whole to fit it. The document is named after the file. A
  Photoshop file is placed through its importer, as Place sends it.
- **A file whose importer adds content rather than opening a document** (paged.sheet's
  workbook and delimited text) runs as before; when it opened no document, the editor makes a
  US Letter document and runs the importer again with `newDocument: true`. A new optional
  field on the contract's `ImportRequest` says so; an importer that adds content places it on
  that document. paged.sheet places the workbook's used range, as "Place selection on page"
  does.
- An importer that opens a document of its own (Word, PowerPoint, PDF, IDML) is left to do so.
- Anything the editor cannot size or place opens the ordinary way.

With a document open nothing changes: a dropped picture is placed where it lands (ADR 258),
every other file goes through its importer, and a file that replaces the document asks first
(ADR 230). A workbook opened into an open document still lands in its panel only.

A minted document reaches the editor's state on the next render. The command registry hands
out the live editor (`liveEditor()`), and the open waits until it shows the new document before
Place runs, so the Place command's `when` sees the document it is placing onto.

## Consequences

- F-03 closes (`packages/shell/test/commands/file-commands.test.ts`,
  `apps/canvas/test/unit/commands/insert-commands.test.ts`,
  `modules/sheet/packages/sheet-bundle/test/io.spec.ts`,
  `apps/canvas/tests/e2e/ux-audit-open.spec.ts`).
- A workbook opened with nothing open is imported twice: once into its panel, once into the
  new document. The second import replaces the first in the sheet session.
- The contract grows by one optional field; importers that ignore it behave as before.

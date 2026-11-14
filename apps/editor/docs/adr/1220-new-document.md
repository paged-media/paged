# ADR 1220 — New document

- **Status:** Accepted 2026-11-13.
- **Scope:** `packages/shell/src/state/new-document-presets.ts` (new: the presets, the setup,
  its validation, the stored shape and the preview's geometry, pure),
  `state/commands/new-document.ts` (new: `paged.file.newDialog`, and `applyDocumentSetup`, the
  engine writes a setup becomes), `chrome/NewDocumentDialog.tsx` (new: the dialog),
  `state/commands/file-commands.ts` (`paged.file.new` takes a setup), `PagedShell.tsx` (the
  command and the dialog), `apps/canvas/src/cockpit-menus.ts` (File ▸ New document… opens the
  dialog), `apps/canvas/src/panels/empty-canvas.tsx` (its New document opens the dialog), the
  setting `paged.newDocument.v1` (`scripts/settings-inventory.json`). The UX strategy's §6.5;
  task DF5 of [`interaction-plan.md`](../interaction-plan.md). Closes UX audit F-04.

## Context

File ▸ New document… carried an ellipsis and opened nothing: it always made one US Letter page
in points, with no margins, columns, bleed or unit (F-04). Most of the world works in A4 and
millimetres, and every other setting had to be found afterwards in Document Setup and Margins and
Columns. Scripts, embeds, the journeys and the films use `paged.file.new` as the quick way to a
blank page and rely on it creating one at once.

## Decision

1. **A dialog with purpose presets first.** Print (magazine, book, brochure, poster, business
   card, packaging), Digital (PDF publication, presentation, web output, marketing graphic) and
   Structured (catalog, product sheet, variable-data template) each fill every field; Custom is
   any setup the user changed. Every field is shown at once beside the presets: width and height,
   orientation, units (ADR 245), page count, bleed, the four margins, columns and gutter
   (ADR 267). A paper-sized preset takes the reader's paper: Letter where the locale's region
   prints on it (US, CA, MX, PH), A4 elsewhere; digital presets are in pixels, which the editor
   counts as points (ADR 245).
2. **A live miniature.** The page drawn to scale with its bleed (dashed, outside), its margin box
   and its columns follows every change, with a one-line summary ("210 × 297 mm · 12 pages · 3
   columns").
3. **Validation where the field is** (`UXI-FBK-001`). A page outside 1 pt…216 in, a page count
   outside 1…999, a bleed outside 0…6 in, margins that leave no room, columns outside 1…216 or
   columns and gutters that do not fit between the margins each say why under the field, and
   Create waits.
4. **Create runs the one New path.** It remembers the setup (`paged.newDocument.v1`, read field
   by field, ADR 247; a stored setup that cannot be created is not offered back), makes its unit
   the editor's document unit (ADR 245), closes, and invokes `paged.file.new` with the setup: the
   replace question (ADR 230), then the blank document at the setup's size
   (`mintBlankDocument`), then `applyDocumentSetup` with the engine's own writes, the ones
   Document Setup and Margins and Columns make: `insertPage` for the further pages, `set` on `doc`
   for the bleed, and `set` on each `page:#n` for its margins, column count and gutter. The writes
   are one undo group, and the document is marked as made (`markSaved`, as an importer's build is,
   F-08): it opens "Not saved yet", not "Unsaved changes". A write the engine refuses leaves the
   document as far as it got and says so; nothing is faked.
5. **`paged.file.new` stays the quick path.** Without a payload it makes the blank Letter page at
   once, as before; with `{ widthPt, heightPt, pages?, bleedPt?, margins?, columns?, gutterPt? }`
   it makes that document without the dialog (scripts, embeds). File ▸ New document… and the empty
   canvas's New document run `paged.file.newDialog`.
6. **Facing pages are said to be unavailable.** The engine has no operation that lays pages out
   as spreads (`InsertPage` mints a spread per page; a blank document is single-sided), so the
   dialog shows "Not available yet: pages are laid out singly" in the place of a switch that would
   do nothing, and the preview shows one page. Inside and outside are the left and right margins
   of a single-sided page.

## Consequences

- F-04 closes: a new document starts at the reader's paper, in their unit, with margins,
  columns and bleed, remembered for the next one.
- Undo right after Create steps back through the setup to the blank page (one step), as it does
  after an import.
- Facing pages wait for an engine operation; when one exists the dialog offers the switch and
  the preview draws the spread.
- Tests: `packages/shell/test/state/new-document-presets.test.ts` (presets, paper, validation,
  stored shape, payload, preview geometry, the writes), `packages/shell/test/chrome/
  new-document-dialog.dom.test.tsx` (presets fill the fields and the preview, inline validation
  holds Create back, Create runs `paged.file.new` with the setup, the remembered setup), and
  `apps/canvas/tests/e2e/new-document-dialog.spec.ts` (the model: page size, three pages, bleed,
  every page's margins, columns and gutter; one undo step; a clean document; Cancel creates
  nothing).

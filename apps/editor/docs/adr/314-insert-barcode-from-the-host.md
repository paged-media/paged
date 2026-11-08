# ADR 314 — Insert barcode… is a host command, for every kind of document

- **Status:** Accepted 2026-11-08.
- **Scope:** `apps/canvas/src/barcode-commands.ts` (`paged.insert.barcode`, `Object ▸ Insert barcode…`),
  `panels/barcode-dialog.tsx`, `insert-commands.ts` (the verb's words), `app/mount.tsx`, `locales/de.json`.
  Rests on engine [ADR 1092](../../../../engine/core/docs/adr/1092-paged-barcode-the-encoder-without-a-binding.md).

## Context

paged.data draws a barcode from a bound record. A Word document, a deck or a layout with a fixed product code
had no way to place one: the encoder was in the data wasm only (capability register, W9).

## Decision

**One host command, like Insert star.** `paged.insert.barcode` run bare opens the Barcode dialog (data and
symbology: EAN-13, UPC-A, Code-128, QR); run with `symbology` and `data` (and optionally `width`, `height`,
`quietZone`, `cx`, `cy`, `page`) it inserts. It asks the engine for the geometry (`paged.barcode`), merges
dark modules that touch on a row into one rectangle, and writes ONE batch: a filled rectangle per run (black,
no stroke, as paged.data's lowering paints, because a stroke widens every bar), then a group, which is
selected. One undo step removes the symbol.

**The menu row is the host's, so it is in every kind of document.** Its gate is the inserts' own (an open
document at its root); doc and slide get the row without a command of their own, which a bundle's menu entry
could not reach (an entry names a command the bundle registered itself).

**What it does not do.** No human-readable line under a 1D symbol (the geometry carries the text; the host
draws none), no binding (a symbol drawn here is artwork; paged.data's bound barcode is the live one), no
validation beyond the engine's, whose sentence is shown in the Problems panel.

## Consequences

- Tested through the real engine in `test/panels/barcode-dialog.dom.test.tsx` (the dialog, one group in one
  undo step, a refusal in words) and `test/unit/commands/barcode-commands.test.ts` (the pure parts).
- A QR code is a few hundred rectangles in one batch; row merging keeps it to one op per run.

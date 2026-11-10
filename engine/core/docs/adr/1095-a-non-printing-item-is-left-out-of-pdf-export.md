# ADR 1095 — A non-printing item is left out of PDF export

- **Status:** Accepted 2026-11-10; built.
- **Scope:** `paged-scene` (`Document::has_nonprinting`, `Document::without_nonprinting`),
  `paged-renderer` (`PipelineOptions::omit_nonprinting`), `paged-canvas` (the export build sets
  it), `paged-export-pdf`'s `paged-export` binary (sets it).
- **Builds on:** ADR 119 (the PDF export backend).

## Context

IDML's `Nonprinting` attribute (Attributes palette ▸ Nonprinting, `frameNonprinting` in the
script API) was read into the model and written back on IDML export. The build never consulted
it, so a non-printing item was drawn into every PDF. InDesign shows such an item in its normal
view and leaves it out of PDF export and print.

This came up on a real large-format job. Glass designs carry a non-printing rectangle that stands
for the frosted foil already on the glass, so a concept render shows the design in place. The
production PDF printed that grey rectangle as well, which would have put a grey plate under every
foil.

## Decision

`PipelineOptions::omit_nonprinting` (default `false`) asks the build for print output.

- When it is set and the document has a non-printing item, `build_document` builds from
  `Document::without_nonprinting()`. That is a copy in which every non-printing text frame,
  rectangle, oval, graphic line and polygon, on spreads and masters, is hidden.
- The build then skips those items exactly where it already skips a hidden item, so there is no
  second predicate to keep in step with the hit-tester.
- Documents without a non-printing item pay nothing.
- The canvas export build (`build_for_export`, behind `paged export` and the editor's export) and
  the `paged-export` binary set the option. The live canvas and `paged render` do not, so they
  show the item as InDesign's normal view does.

## Consequences

- A non-printing text frame in a thread is hidden like a hidden one. The text that would have
  flowed through it is not set elsewhere.
- InDesign's "Print Non-printing Objects" export option has no equivalent yet. It would be
  `omit_nonprinting: false` on the export wire.

## Tests

`paged-canvas` `export_pdf::nonprinting_items_are_left_out_of_the_export`: the same fixture with
its spot rectangle marked non-printing gives the live build the same commands and the export build
fewer.

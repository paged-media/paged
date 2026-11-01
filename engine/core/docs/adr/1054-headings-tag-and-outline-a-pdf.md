# ADR 1054 — A paragraph style's PDF tag is settable, and a PDF's outline can come from its headings

- **Status:** Accepted 2026-11-01.
- **Scope:** additive; no protocol bump (a `PropertyPath` and an optional wire field).
  - `paged-mutate`: `PropertyPath::ParagraphStylePdfExportTag` (`paragraphStyle.pdfExportTag`),
    its `SetStyleProperty` arm (`apply/layer.rs`).
  - `paged-introspect`: the catalog entry `paragraphStylePdfExportTag` (settable paths 288).
  - `paged-canvas`: the path's read (`model.rs`), `ExportPdfWireOptions.headingOutline` and
    `export::pdf_heading_outline`.

## Context

A tagged PDF (ADR 182) maps a paragraph to a standard structure type from its style's
`pdf_export_tag` (`H`, `H1`–`H6`, else `P`), but only IDML import ever set it, so a document made
or opened by a content plugin (paged.doc's Word headings) was tagged `P` throughout. The PDF
outline (ADR 171) comes only from the document's bookmarks, so a document with headings and no
bookmarks had none. Word writes both: "Document structure tags" and "Create bookmarks using
Headings".

## Decision

1. **The tag is a style property.** `SetStyleProperty` with `paragraphStylePdfExportTag` (text;
   the empty string clears it) sets the paragraph style's tag, undoable like every style
   property. The renderer already role-maps it (`structure_role`); nothing else changes in the
   tagged-PDF writer.
2. **The outline can come from the headings.** With `headingOutline` set, the PDF's outline is
   built from every paragraph whose style role-maps to `H`/`H1`–`H6`, in story order: the title
   is the paragraph's text (whitespace collapsed), the destination the page the paragraph is laid
   out on, the depth the heading level (a heading nests under the nearest shallower one; a skipped
   level nests one deeper than its parent, never more). It replaces the bookmark outline when both
   are asked for. Off by default: IDML output is unchanged.

## Consequences

- A host that wants Word's behaviour sets the tag on its heading styles and passes
  `tagged` and `headingOutline`; the editor's Export PDF dialog has the checkbox.
- The Word-style cascade (a style based on a heading) is the host's to apply: the engine reads
  the style's own tag only, as it did.
- `paged export` (the CLI) does not offer the option yet.

## Evidence

- `paged-canvas/tests/it/tagged_pdf.rs::heading_tags_and_the_heading_outline`: a style tagged
  `H1` role-maps to `H1`, `headingOutline` writes `/Outlines` with a titled item, and without it
  there is none.
- `catalog_apply_parity` and the committed `catalog.json` / `mutation.schema.json` artifacts.

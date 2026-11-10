# ADR 1094 — A page over 200 inches is written in a larger user unit

- **Status:** Accepted 2026-11-10; built.
- **Scope:** `paged-export-pdf` (`user_unit_for`, `page.rs`'s boxes and base CTM, the marks, link and
  comment annotations; `writer.rs` writes `/UserUnit`).
- **Builds on:** ADR 119 (the PDF export backend).

## Context

PDF limits a page side to 14,400 units in default user space (ISO 32000-1, Annex C: 200 in,
508 cm). Large-format work goes past it: a fence banner of 787 × 204 cm, a glass band of
898 × 150 cm. The exporter wrote such a page at its full size in points, with nothing to say it
was out of range; Acrobat and RIPs refuse or clip it. InDesign stops at 216 in, so a document
cannot be checked against it at that size either.

## Decision

A page whose media box (trim, bleed and the marks margin) exceeds 14,400 pt on either side is
written with `/UserUnit u`, where `u` is the smallest whole number that brings the longer side
within the limit (`user_unit_for`). A whole number keeps the page's numbers exact for RIPs that
read them; a 787 cm or 898 cm page gets `u = 2`. Every page within the limit is written as before,
with no `/UserUnit`.

On such a page:

- the media, trim, bleed and crop boxes are divided by `u`;
- the page's base CTM (trim origin and y-flip) also scales by `1/u`. Shading and tiling patterns
  already map to the page's default space through the base CTM, and captured forms draw under it,
  so they need nothing more;
- the printer's marks, drawn in media coordinates outside the base CTM, are wrapped in their own
  `1/u` scale;
- link annotations and comment positions are divided by `u`.

## Consequences

- A banner or mural is exported at real size and reads at its real size in Acrobat (which applies
  the user unit) and in RIPs that follow PDF 1.6.
- Readers that ignore `/UserUnit` show the page at `1/u` scale; that is the usual 1:2 large-format
  convention, and the boxes still have the right proportions.
- The marks keep their size in points, so at `u = 2` they print twice as large; a mark size that
  follows the page size is a separate decision.

## Tests

- `paged-export-pdf` `user_unit_tests`: the unit for pages inside and outside the limit.
- `tests/it/user_unit.rs`: the `gradients` sample widened to 787 cm with 3 cm bleed and crop marks
  exports with `/UserUnit 2`, boxes within the limit that measure 787 cm and 3 cm in the unit, the
  content and marks drawn at ½, and every shading pattern's matrix at ½. At 480 cm it has no
  `/UserUnit`.

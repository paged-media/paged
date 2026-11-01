# ADR 621 — Word headings tag the PDF and give it an outline

- **Status:** Accepted 2026-11-01 (wave W5). Closes the tagged-PDF gap recorded in ADR 616.
- **Scope:** `docx-lower` (`heading_level`, the `paragraphStylePdfExportTag` style property).
- **Builds on:** engine ADR 1054; doc ADR 616 (which found the two gaps), 618–620.

## Context

ADR 616 checked the tagged PDF and found Word headings tagged `P` and no outline. Word's own
PDF has heading tags and bookmarks from the headings.

## Decision

Every Word paragraph style named `heading N` (case-insensitive, N 1–6), and every style based on
one (nearest ancestor wins), is lowered with the style property `paragraphStylePdfExportTag` =
`H<N>`. That is all the document side does: the engine role-maps the paragraphs (ADR 1054), and
the host's Export PDF with "Create Tagged PDF" and "Outline from headings" writes the structure
and the outline. Direct `w:outlineLvl` on a paragraph and `heading 7`–`9` are not tagged (PDF has
H1–H6). An older engine that does not know the path refuses the property; the lowering is
otherwise unchanged.

## Evidence

- `docx-conformance/tests/it/structure.rs::heading_styles_carry_the_pdf_export_tag`.
- Bundle: `packages/doc-bundle/test/headless/files.spec.ts` exports a tagged PDF with the heading
  outline from a Word document over the real engine.

## Related

- [ADR 616](616-files.md) — the check that found the gap
- engine ADR 1054

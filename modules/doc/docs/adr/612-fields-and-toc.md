# ADR 612 — Fields and tables of contents

- **Status:** Accepted 2026-10-28.
- **Builds on:** engine ADR 1022 (Word fields as runs, `updateFields`, show field codes, text
  anchors, `insertCrossReference`, `insertTableOfContents`, `insertIndexMarker`).
- **Scope:** `docx-core` (`Run::{field_code, field_seq}`, `Paragraph::toc_field`),
  `docx-import`, `docx-lower` (`structure.rs`: `word_field`, `find_tocs`, `toc_levels`;
  `LoweredRun::field`, `LoweredDoc::tocs`), `doc-host-model` (fields and bookmarks in the
  pour), `doc-bundle` (`word/structure.ts`, `word/references.ts`,
  `panels/references-panel.tsx`), the engine's story read (`RunContent.fieldCode`,
  `ParagraphContent.toc`, `StoryContent.textAnchors`, an additive rider on protocol 77).

## Decision

**A Word field is an engine Word field.** The importer keeps each field's whole instruction
and numbers the fields of a paragraph; the lowering marks every result run of a field the
engine can hold (`word_field`: an instruction, text only — no picture, break, positional tab or
note reference, not in a table cell) with its code. `HYPERLINK` (a native link), `MERGEFIELD`
(the template fields) and `TOC` (below) are left to their own paths. The pour leaves the result
out of `insertText` and inserts the field after the text with `insertField { word: { code,
result } }` at its place in the finished pour, addressed in the `insertText` space so a field
alone in its paragraph lands there; the runs of one field are one engine field, styled with
its first run's look. `PAGE`, `NUMPAGES`, `SECTIONPAGES`, `PAGEREF` and `STYLEREF` then follow
the layout, `DATE`, `REF` and `SEQ` update on F9, every other kind keeps Word's result.

**Bookmarks are text anchors.** Each bookmark that starts in a paragraph (Word's `_GoBack`
excepted) becomes `insertTextAnchor` at the paragraph's start, so a `PAGEREF` or `REF` to it,
and a TOC entry's page number, are live.

**A TOC keeps Word's entries.** A paragraph where a `TOC` field begins starts a table of
contents that runs over the following TOC-entry paragraphs (`TOC1`…`TOC9` by id or name); the
lowering records it (`LoweredToc`: instruction, blocks, `\o` levels). Its entries pour as they
are, their `PAGEREF`s live: the page numbers follow the layout before any update. Update table
is the engine's `updateTableOfContents` on a table the engine made; a Word TOC rebuilt from the
headings is Insert ▸ Table of contents.

**Commands (wordDocument context).** F9 updates the fields of the caret's story with the host's
clock (`updateFields`, one undo step; the engine refuses when every field already shows its
result); Shift+F9 and Alt+F9 toggle `documentShowFieldCodes`. Insert: Page number, Number of
pages, Date (`DATE \@ "MMMM d, yyyy"`, updated at once), Field… (any code), Bookmark…,
Cross-reference… (a bookmark or a heading as text, page number or above/below; a heading gets
Word's hidden `_Ref` bookmark), Mark index entry… (a topic path), Table of contents (from the
document's `heading 1`–`3` styles) and Update table; page and section breaks (next, odd, even
page: a break rule on the new paragraph; continuous: a paragraph break). The host has no modal
dialog door: Word's dialogs are sections of the References panel, which the commands open at
their section; its Page setup section sizes the caret's section page, sets its margins and
columns and puts its frame on the margin box. Every command has a typed twin (ADR 323).

**Save-back reads fields, TOC entries and bookmarks.** The story read names the field a run is
the result of, the TOC style a paragraph is an entry of and the story's named text anchors;
save-back uses them to write a field result changed by F9 into its result runs and new fields,
bookmarks and tables of contents as Word's (ADR 610 amendment).

## Evidence

- `docx-lower/src/structure.rs` unit tests (`toc_levels`, TOC styles, which fields stay live);
  `docx-conformance/tests/it/conformance.rs` (DATE and PAGE live), `tests/it/structure.rs`
  (every field of `structure_docx()` with Word's result, the bookmarks, the TOC's blocks and
  levels).
- `doc-host-model/test/structure.spec.ts`: results out of the text, `insertField` in order with
  both offsets, one field over two runs, styled after it lands; `insertTextAnchor`.
- `doc-bundle/test/headless/word-structure.spec.ts` (real engine): every field's code read back,
  the bookmarks as text anchors, the TOC entries with live page numbers, F9 and field codes.
- `test/headless/word-structure-commands.spec.ts`: page number, page count and date inserted;
  F9; Shift+F9 both ways; a table of contents from the headings; a page break; a bookmark, a
  cross-reference to a heading as its page number, an index entry and a page setup through the
  References panel's actions.
- `test/structure-commands.spec.ts`, `test/panels/references-panel.dom.test.tsx`: each
  command's and each panel section's write.

## Residuals

- Fields in table cells, and fields whose result holds a picture or a break, stay text.
- A field over runs of different looks takes its first run's.
- Word's `TOC` itself is not an engine table of contents: Update table rebuilds only a table
  made in paged; a Word TOC's page numbers are live, its entry list is Word's until replaced.
- Section breaks are break rules: a new section's own page setup and headers need the section
  stories of a reopened document.
- F9 updates the caret's story, not only the selected field.

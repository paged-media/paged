# ADR 611 — Headers, footers and notes placed

- **Status:** Accepted 2026-10-28.
- **Accepts:** thoughts ADRs 033 (headers and footers) and 034 (footnotes), as built on engine
  ADR 1022 (a grow rule names its masters) and engine ADRs 163 / 174 (inserting footnotes and
  endnotes). Decision 3 of 033 (masters written as IDML) is superseded by ADR 606: the skeleton
  is a native document.
- **Scope:** `docx-core` (`Run::note_is_endnote`, `note_at`, `note_marker`, `is_lowered`),
  `docx-import` (where a note reference stands in its run), `docx-lower` (`structure.rs`:
  `plan_masters`, `section_start`; `LoweredDoc::{header_footer_parts, masters, notes}`,
  `LoweredSection::{masters, section_start}`, `LoweredRun::note`), `docx-skeleton` (master
  spreads, their stories, `AppliedMaster`, page-numbering sections), `docx-export/src/notes.rs`,
  `doc-host-model` (the pour's atomics, `withoutNotes`, `noteTexts`), `doc-bundle` (`open.ts`:
  grow rules with masters, `pourHeadersFooters`, `setFootnoteOptions`; `word/structure.ts`: the
  header/footer sub-context and its bar), contract C6 (extensions ADR 349, editor ADR 301).

## Context

The import read every section's header and footer references (with Word's inheritance), the
notes and their numbering, and placed none of it: a diagnostic said so. The engine now lets a
grow rule name the masters of its chain's pages (first page, odd, even) and an odd- or
even-page section start, and has create doors for footnotes and endnotes.

## Decision

**One master per distinct header/footer pair.** For each section that opens a native story,
`plan_masters` takes the parts the section shows on a default page, on its first page (with
`w:titlePg`) and on an even page (with `w:evenAndOddHeaders`), and makes one master per distinct
(header part, footer part, page geometry). A section that links to the previous one shows the
same parts and so takes the same master; "link to previous" needs nothing else. A first or even
page whose kind has no part gets a master with no frame there (Word prints a blank header).
Masters are `docx_m{n}`, named `Section k`, `Section k First Page`, `Section k Even Page`.

**The skeleton writes them.** Each master is a page of its section's size with a header frame
(from `w:pgMar/@w:header` to the top margin, at the margin box's width, at least 18 pt tall)
and a footer frame (from the bottom margin to `w:pgMar/@w:footer` above the foot, its text set on
the frame's foot), each holding an empty story (`docx_m{n}_h`, `docx_m{n}_f`). A story's page
shows its section's first master. A section that restarts its numbers or numbers in another
format gets a numbering section on its page (and the first page one, then).

**The grow rule names them.** The bundle sets each story's rule with `master`,
`firstMaster`, `evenMaster` and, for an odd- or even-page section, `sectionStart` (the engine
then puts a blank page in front, showing the previous section's header, as Word prints it). Such
a section no longer carries a `NextOddPage` / `NextEvenPage` rule on its first paragraph.

**The parts are poured with the body's pour.** Header and footer paragraphs are lowered as body
paragraphs (positional tabs reach the part's margin box) into
`LoweredDoc.header_footer_parts`; the bundle pours each into every master story that shows it.

**Notes stand at their references.** A body run holding a note reference reads as the engine's
marker (`U+E01C` footnote, `U+E01D` endnote) at its place in the run (`note_at`; Word may write
text on both sides), so the lowering, the read-back and every offset agree. The pour leaves the
marker out of `insertText` and inserts the note after the text with `insertFootnote` /
`insertEndnote` and the note's text (`LoweredNote::text`, the paragraphs' text joined by `\n`
without the space Word writes after its mark), at its final offset and paragraph. The first
section's `w:footnotePr` becomes the document's footnote numbering (format, start, restart). An
inserted document (ADR 603) leaves the references out (`withoutNotes`).

**In-place editing (editor ADR 301, contract C6).** In the `wordDocument` context the bundle
contributes a sub-context provider: a double-click in a page's header band (above the top
margin) or footer band (below the bottom margin) resolves to the master the page shows and its
frame there, and the editor edits that master story in place with the body dimmed. The bar
offers Different first page (a new blank first-page master), Different odd & even (an even
master per section, shared by linked sections), Link to previous (the previous section's masters,
or a copy to edit apart), Page number, Number of pages, Date and Close; each toggle rewrites
the section's grow rule. Insert ▸ Edit header / Edit footer enter the active page's.

**Save-back.** Note markers are stripped from the baseline and the read-back before the diff
(`notes::strip_lowered`, `strip_content`), so body edits around a reference keep it in place.
Header and footer edits splice into their parts; note edits, new and removed notes
into the notes parts, with new parts, relationships and content types where needed (ADR 610
amendment 1).

## Evidence

- `docx-conformance/tests/it/headers.rs`: the planned masters, picked per page as the engine's
  rule picks them, print Word's header and footer on every page of `headers.word.json` (with
  and without even/odd); linked sections share masters; frame bounds follow the distances.
- `tests/it/structure.rs` on `structure_docx()` and Word's answer
  (`fixtures/structure.word.json`, `scripts/word-structure-probe.sh`): per-section masters
  with a linked footer, PAGE and NUMPAGES with Word's numbers on all three pages, each footnote
  on its reference's page; notes, markers and the TOC lowered.
- `docx-skeleton/tests/skeleton.rs`: master spreads, their frames and empty stories, the pages'
  first masters, the numbering sections.
- `doc-host-model/test/structure.spec.ts`: note markers out of the text and inserted with their
  text; `withoutNotes`.
- `doc-bundle/test/headless/word-structure.spec.ts` (real engine): the story rules name the
  masters, the master stories hold the parts with live fields, the footnotes collection holds
  the notes at their references, an endnote story is made.
- `test/headless/word-structure-commands.spec.ts`: a double-click in the header band enters the
  first-page master's header and typing edits it; the body is not a band.
- `test/structure-commands.spec.ts`: band resolution, labels, the bar's toggles.

## Consequences and residuals

- Header and footer height does not push the body (033 decision 8): a taller header oversets.
- Pictures and tables in headers are not poured (the part's paragraphs only).
- The engine's note text is plain: Word's note styles and its separator are the engine's; there
  is no door to edit a note's text in place (the References panel inserts a note with its text).
- Word sets endnotes after the last text and numbers them in lower roman; the engine's endnote
  story is a page of its own after the last, numbered from 1, and no wire path sets endnote
  numbering.
- A continuous section's own headers are not applied (it joins the story before it); Word's
  blank page before a restarting section with even/odd headers keeps its diagnostic.
- The bar's toggles change this session's masters and rules; writing `w:titlePg`,
  `w:evenAndOddHeaders` and new header references back into the `.docx` is not done.
- In the headless host pages grow only as the editor requests them, so page-level alternation
  is the engine's evidence (engine ADR 1022), not the bundle's.

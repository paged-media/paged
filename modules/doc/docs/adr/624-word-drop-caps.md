# ADR 624 — Word drop caps are the engine's paragraph drop cap

- **Status:** Accepted 2026-11-02.
- **Scope:** `docx-core` (`Paragraph::drop_cap`, `ParagraphHeld::drop_cap`), `docx-import`
  (the fold), `docx-lower` (`paragraphDropCapLines`, `paragraphDropCapCharacters`),
  `docx-export` (`RunLock::DropCap`, the held refusal).
- **Builds on:** ADR 606 (lowering onto native text), ADR 613 (save-back splices only edited paragraphs).

## Context

Word stores a drop cap as a framed paragraph (`w:framePr w:dropCap="drop|margin" w:lines="N"`)
holding the cap characters, followed by the paragraph proper. The engine has a paragraph drop
cap (the first M characters over N of the paragraph's own lines).

## Decision

The import folds the framed paragraph into the paragraph after it: the cap's runs lead the
paragraph's runs, the size and lowered baseline Word writes on the cap's run are dropped, and
`Paragraph::drop_cap` records `lines`, `chars` and whether the cap is a margin cap. The lowering
gives the paragraph's synthesized style `paragraphDropCapLines` and `paragraphDropCapCharacters`.
The folded block stands for two `w:p`: save-back never rewrites it (an edit, delete, format
change or structural op addressed to it is refused with a note), and an unedited cap keeps its
XML byte for byte. A framed paragraph that is not a drop cap, a cap with no paragraph after it,
a cap inside a content control, and a cap defined by a paragraph style's `framePr` stay what
they were.

## Evidence

Word's own render of the drop cap fixture is measured in
[`../reference/drop-cap-word-measurements.md`](../reference/drop-cap-word-measurements.md); the
tests are `docx-conformance/tests/it/reach.rs` and the bundle's
`test/headless/drop-cap.spec.ts` (the real engine against Word's numbers).

## Consequences

The drop cap is a property of the paragraph, set by the pour (`setElementProperty` on a story
range), not of its style: the engine refuses the two paths on a style.

The engine sizes and places the cap by its own rule, which is not Word's. Measured against Word's
render (numbers in the measurements note): a 2-line cap matches (height +1 %, indent 0.13 pt, same
breaks); a 3-line cap is 10 % taller and indents 2.1 pt more, which moves a break; Word's cap sits
4.3 pt lower; and Word wraps a following paragraph beside a cap taller than its own paragraph, which
paged does not (the lowering does not know the line count). These are known differences, not
decisions: closing them is engine work. A margin drop cap is set in the text (Word set the measured
one the same way).

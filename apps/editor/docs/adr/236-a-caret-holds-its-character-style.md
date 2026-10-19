# ADR 236 — A caret holds the character style chosen at it

- **Status:** Accepted 2026-10-19.
- **Scope:** `packages/shell/src/state/content-selection-context.tsx` (`typingStyle`,
  `heldTypingStyle`), `apps/canvas/src/panels/character-styles-panel.tsx`,
  `apps/canvas/src/panels/style-apply.tsx` (`caret`), `apps/canvas/src/ui/useTextEditing.ts`
  (`insertAt`). No engine or wire change.

## Context

Choosing a character style with a collapsed caret sent a write on the empty range; the engine
stores no style on an empty range, so nothing was kept and the list showed nothing applied
(finding PN-152). In InDesign a character style chosen at an insertion point applies to the
text typed there, and the Character Styles panel marks it.

## Decision

1. **The caret holds it.** At a collapsed caret the Character Styles panel hands the chosen
   style to the content selection (`setTypingStyle`) instead of writing, and marks it applied
   while the caret stays where it was chosen.
2. **The next insert carries it.** An insert at that caret (typing, a glyph, a paste through
   `insertAt`) is one batch: the text, then `set appliedCharacterStyle` on the inserted range.
   One undo step. The text typed after it extends that run.
3. **Any new selection drops it.** Moving the caret, selecting, or leaving the text clears it,
   as in InDesign. A caret in a table cell holds nothing yet (cell ranges have their own
   address form).

## Consequences

PN-152 closes; the Character Styles panel's finding test and "text typed at that caret
carries the held style" hold it. Paragraph styles need no hold: a caret applies them to its
whole paragraph.

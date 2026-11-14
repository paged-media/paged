# ADR 1238 — The Typography Debugger

- **Status:** Accepted 2026-11-14.
- **Scope:** `apps/canvas/src/typography-evidence.ts` (new: the target, the words for a line's
  evidence, the tightness colours, the preview's writes), `panels/typography-panel.tsx` (new),
  `overlays/typography-overlay.tsx` (new: View ▸ Typography debugger on the canvas),
  `panels/built-in-panels.tsx`, `panels/window-categories.ts`, `app-commands.ts`
  (`paged.view.toggleTypographyDebugger`), `app/mount.tsx`, `locales/de.json`;
  `packages/shell/src/state/view-toggles.ts` (the `typography` toggle), `state/editing-aids.ts`;
  `packages/client` (`CanvasClient.lineEvidence`, protocol 82). The UX strategy's Concept E; task
  PX2 of [`interaction-plan.md`](../interaction-plan.md). The engine's side is engine ADR 1310.

## Context

"Why did this line break here?" had no answer in the editor. The composer knows the measure it
filled, the line's natural width, how far it stretched the spaces, whether it hyphenated, and the
settings it used, but the build kept none of it past the line's glyph positions; a designer
checking a loose line or a ladder of hyphens tried a change and undid it.

## Decision

1. **The evidence is the engine's** (`client.lineEvidence`, engine ADR 1310): per composed line
   the measure, the natural width, the breaker's ratio, the word spaces as set (% of the font's
   space, mean, smallest, largest), the letters' spread, the break (word space, hyphen,
   discretionary hyphen, hard hyphen, forced line break, paragraph end, story end, an emergency
   cut), the hyphenation points the dictionary offered for the word at the break and the one
   used, the tightness against the paragraph's word spacing, the outliers, the baseline grid's
   shift; per paragraph the composer, alignment, hyphenation settings and spacing bands; the
   overset. The editor turns it into sentences (`whyThisBreak`, `spacingFacts`) and colours; it
   measures nothing.
2. **The story** is the caret's, else the selected text frame's (asked of the engine once per
   selection).
3. **The panel** (`paged.typography`, Window ▸ Utilities) lists the story's lines with a tightness
   swatch and the word spacing; the line at the caret, or one clicked, shows "Why did this line
   break here?"; the paragraph's composition settings are below.
4. **View ▸ Typography debugger** (`paged.view.toggleTypographyDebugger`, the panel's switch too)
   tints each line of the story by its tightness (very tight red, tight amber, loose blue, very
   loose magenta; a normal line is not tinted), marks a hyphen and a forced break at the line's
   end, and puts a marker there whose hover is the line's "why"; the line before overset text
   gets a red marker. Diagnostic chrome: off by default, hidden in Proof view, never printed.
5. **A change is previewed before it is made.** The panel offers tracking, hyphenation on or off,
   the hyphenation zone and the composer, for the paragraph at the caret or the whole story.
   Preview asks the engine for the evidence of a copy of the document with that write applied —
   nothing in the document, its history or its revision changes — and shows the lines, loose and
   tight lines and hyphens before and after. Apply sends the same write as an ordinary mutation:
   one undo step. Discard drops the preview.

## Consequences

- A preview builds a copy of the whole document (engine ADR 1310): a deliberate action, not a
  live scrub. The copy is the engine's general dry run of a write (`client.preview`), which
  other previews share — the Pathfinder's result preview first (paged.draw ADR 370,
  amendment 1).
- The preview offers the paragraph settings the operation layer can write; the word and letter
  spacing bands have no write path yet and are shown, not previewed.
- Tests: `apps/canvas/test/panels/typography-panel.dom.test.tsx` and
  `test/unit/typography-evidence.test.ts` (the sentences, the change range, the writes);
  `tests/e2e/xray.spec.ts` (the panel shows the engine's lines; a preview leaves the model and
  the undo depth unchanged; Apply is one undo step).

# Drop caps: Word's layout, measured, against paged's (doc ADR 624)

Word's own render of `docx_conformance::drop_cap_docx()` (`dump-fixture <out> drop-cap`),
saved as PDF by Word 16 for Mac. `scripts/word-drop-cap-probe.sh` extracts the numbers into
`docx-conformance/fixtures/drop-cap.word.json`; `packages/doc-bundle/test/headless/drop-cap.spec.ts`
holds the engine against them. Calibri 11 pt, US Letter, 72 pt margins.

## What Word does

The XML in the fixture is what Word itself writes for a drop cap (a framed paragraph, `w:lines`
3 or 2, an exact line of lines x 13.4 pt, the cap's run at `sz` 96 / 64 and lowered 13.5 / 6.5 pt).

| | 3-line `T` | 2-line `Th` |
|---|---|---|
| cap font size (PDF) | 48.0 pt | 32.0 pt |
| cap ink box (x0 y0 x1 y1, pt) | 72.46 111.04 95.26 141.52 | 72.24 164.46 101.76 186.30 |
| cap ink height | 30.5 pt | 21.8 pt |
| x of the lines beside the cap | 95.55 | 104.55 |
| cap advance + indent | 23.39 + 0.14 | 32.30 + 0.20 |

- The cap sits at the margin (x = 72.0); wrapped lines start at the cap's advance plus about 0.14 pt.
- Word's line pitch here is 15.52 pt (the fixture's styles omit `pPrDefault`, and Word lays its own
  defaults: 8 pt after, 1.158 lines). The cap's top is 4.9 pt below line 1's baseline and its bottom
  4.3 pt below the (virtual) line 3 baseline: the cap is placed by the frame, not by the lines.
- The frame is lines x 13.4 pt tall. A following line whose top lies inside the frame is indented:
  the paragraph after the 3-line cap (`P2`, x = 95.55) sits beside the cap because the cap's own
  paragraph is only two lines. `P4` and `P6` start flush.
- `dropCap="margin"` renders exactly as `drop` in this render (cap at x = 72, text indented).

## paged against Word

| | Word | paged | difference |
|---|---|---|---|
| `Th` cap ink height | 21.84 pt | 22.08 pt | +1.1 % |
| `Th` x of lines beside the cap | 104.55 | 104.42 | -0.13 pt |
| `Th` line breaks | "...pack" / "my box..." | same | none |
| `T` cap ink height | 30.48 pt | 33.6 pt | +10 % |
| `T` x of lines beside the cap | 95.55 | 97.67 | +2.12 pt |
| `T` line 1 | ends "...pack my" | ends "...pack" | "my" moves down |
| text after the cap's lines | flush | flush | none |

## Known differences

The engine sizes a cap by its own rule (engine ADR: the cap height spans the dropped lines, from the
first line's cap height to line N's baseline: `((N-1) x leading + size x capRatio) / capRatio`),
measured against InDesign, not Word. The cap's size is not a property the lowering can set (only
`DropCapLines` and `DropCapCharacters` exist, and not on a style), so no value of either property
reproduces Word's cap for 3 lines. Not changed: the engine is out of this change's scope.

1. **Cap size and indent.** A 2-line cap matches (the two rules coincide at Calibri 11 pt); a 3-line cap
   is 10 % taller and indents 2.1 pt more than Word's, which moves a line break.
2. **Cap position.** The engine puts the cap's baseline on line N's baseline; Word's sits 4.3 pt below
   it (2.1 pt for `Th`).
3. **The paragraph after a cap taller than its own paragraph** wraps beside the cap in Word. In
   paged the cap overlaps that paragraph. The lowering does not know the line count (the engine
   breaks lines), so it cannot add the indent; the carve would belong to the engine.
4. **Line pitch.** Word 15.52 pt against paged's 13.42 pt with no space after, for a document whose
   `docDefaults` omit `pPrDefault`. Not a drop cap matter; every vertical figure above was therefore
   compared against each renderer's own baselines.
5. **Margin caps** are set in the text (Word set the measured one the same way).

# ADR 620 — Right-to-left and East Asian text

- **Status:** Accepted 2026-10-30 (wave W4b).
- **Scope:** `docx-core` (`ParaProps.bidi`; `RunProps.rtl`, `complex_script`, `bold_cs`,
  `italic_cs`, `size_cs_half_pts`, `font_hint`), `docx-import` (the three `w:rPr` forms, the
  three `w:pPr` forms, `theme::apply_fonts`), `docx-lower` (`script_props`, `para_props`),
  `docx-export` (`rpr.rs`, `diff.rs`, `styles.rs`, `overlay.rs`).
- **Builds on:** engine ADR 1051 (a paragraph's base direction and a run's script slots); doc
  ADRs 602 (save-back), 609 (theme fonts), 614 (W4a read `w:lang` and the East Asian and
  complex-script fonts without lowering them).

## Context

Word sets a paragraph right to left with `w:bidi`, a run right to left with `w:rtl`, and gives a
run three faces (`w:rFonts` `ascii`/`hAnsi`, `eastAsia`, `cs`) with a hint for shared
characters (`w:hint`), a complex-script size (`w:szCs`) and weight (`w:bCs`, `w:iCs`), and
`w:cs` for a run that is complex script as a whole. W4a read the East Asian and complex-script
fonts but the engine had nowhere to put them, nor a paragraph direction: Arabic and Hebrew
documents opened left-aligned and left to right, and Japanese runs drew in the Latin face
(their glyphs missing where it had none).

## Decision

**Read.** `w:bidi` on a paragraph, a paragraph style and the document defaults; `w:rtl`,
`w:cs`, `w:bCs`, `w:iCs`, `w:szCs` on a run, a style and the defaults (the run's choice form,
the style's named form and the defaults' base form); the hint from `w:rFonts/@w:hint`
(`ascii` reads as the default slot). The East Asian and complex-script faces were already read
(W4a), through their theme references.

**Lowered** onto engine ADR 1051, in the same generated styles as the rest of the direct
formatting: `w:bidi` → `paragraphDirection` `rtl` (`ltr` for an explicit off);
`w:rFonts/@w:eastAsia` → `characterEastAsianFont`, `@w:cs` → `characterComplexFont`,
`w:szCs` → `characterComplexFontSize`, `w:bCs` / `w:iCs` → `characterComplexBold` /
`characterComplexItalic`, `w:cs` → `characterComplexScript`, `w:rtl` →
`characterDirection` `rtl`, `w:hint` → `characterFontHint`. Word's alignment and indents in a
`w:bidi` paragraph are its start edge's (`w:jc="left"` and `w:ind/@w:left` are the right in a
right-to-left paragraph), which is how the engine reads a right-to-left paragraph, so `w:jc`
and `w:ind` lower unchanged.

**Saved back.** A run whose script properties the canvas changed is written with Word's
elements: `w:rFonts` with `w:eastAsia`, `w:cs` and `w:hint` beside the Latin faces (the
element is rewritten as a whole when any of its faces changed, keeping the ones that did not),
`w:bCs`, `w:iCs`, `w:szCs`, `w:rtl` and `w:cs` at their schema places, every other child of
the run's `w:rPr` byte for byte. A style edit writes the same into `styles.xml`;
`paragraphDirection` on a paragraph style writes `w:bidi`. A paragraph's own `w:bidi` is kept
as it is (the read-back carries no direct paragraph formatting). An unedited save stays
byte-identical.

## Evidence

- `docx-conformance/tests/it/w4b.rs` (`w4b_scripts_docx`: an Arabic and a Hebrew
  right-to-left paragraph, a Latin / Japanese paragraph with an East Asian face and hint, two
  Latin right-to-left paragraphs aligned left and right): the lowered paths, a script edit
  written back as Word's run properties, zero-edit saves byte-identical.
- Word's answer is still to be asked: Word opened no probe file during this wave's session
  (status.md, W4b). The fixture's p3 and p4 (`w:jc="left"` with a left indent, `w:jc="right"`,
  both `w:bidi`) are the question; until Word answers, the logical reading is the
  specification's (ECMA-376 `start`/`end`, which transitional `left`/`right` alias in a
  right-to-left paragraph).

## Consequences

- Residuals: Word does not bolden complex script with `w:b` unless `w:bCs` says so; the engine
  takes the run's own weight when no complex weight is set, so a bold Latin style over Arabic
  text draws the Arabic bold. A paragraph's own `w:bidi` changed on the canvas is not written
  back (only through its style). `w:lang/@w:bidi` and `@w:eastAsia` stay read only (no
  hyphenation for those scripts).

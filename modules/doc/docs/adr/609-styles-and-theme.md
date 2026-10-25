# ADR 609 — Styles and theme

- **Status:** Accepted 2026-10-24.
- **Scope:** `docx-core/src/theme.rs`, `docx-import/src/theme.rs`, `docx-lower` (theme
  swatches, the "Word theme" group, `theme_fonts`), `docx-export` (`diff.rs` colour and font
  inversion, `rpr.rs`), `doc-host-model` (`createColorGroup`), the bundle's `canvasColors`.
  Save-back of styles themselves: [ADR 610](610-save-back-across-sessions-and-new-parts.md).

## Context

Word documents carry their colours and fonts mostly by reference to the document theme
(`word/theme/theme1.xml`): `w:color w:themeColor="accent1" w:themeShade="BF"`,
`w:rFonts w:asciiTheme="minorHAnsi"`, `w:shd w:themeFill="accent6"`. The `w:val` beside a
theme colour is only Word's cached rendering. Until now the import dropped every theme
reference: a run in a theme colour kept its cached hex at best, and a document whose
defaults name only the theme's body font (every Word document since 2007) lowered with no
family at all.

The Word-parity plan asks for the theme as a "Word theme" swatch group, tints and shades as
swatch tints, theme fonts as document font aliases, and save-back that writes `themeColor`
while the colour still matches.

## Decision

- **The theme is read** (`a:clrScheme`: the twelve scheme slots, `a:sysClr` by its
  `lastClr`; `a:fontScheme`: major and minor Latin, East Asian and complex-script faces),
  with `settings.xml`'s `w:clrSchemeMapping` deciding what `text1`, `background1`, `text2`,
  `background2` (and remapped accents) mean. `DocxDocument::theme` carries it.
- **References resolve at import and stay beside the value.** `RunProps::color` is the
  resolved colour, `RunProps::theme_color` the reference (`slot`, `tint`, `shade` as Word
  wrote them). The theme reference wins over `w:val` (Word's rule); without a theme part
  the cached `w:val` stands in. A tint lightens and a shade darkens the HSL luminance
  (`L·t + 1 − t`, `L·s`, the byte over 255). Fonts: `w:asciiTheme` (and `w:eastAsiaTheme`,
  `w:cstheme`) win over the named face; `RunProps::font` is the family, `font_theme` the
  slot; the East Asian and complex-script faces are read (`font_east_asia`, `font_cs`) and
  not lowered (the engine has one family per run). `w:shd` on runs and style runs is read
  as its fill (`Shading`, with `theme_fill`) and not lowered: the wire has no character or
  paragraph shading on text.
- **Theme colours are named swatches in a "Word theme" group.** The lowering mints a swatch
  per scheme slot whether used or not (`Color/docx-theme-dark1` … `-followedHyperlink`,
  named as Word's picker names them: `Dark 1`, `Accent 1`, `Followed Hyperlink`), then one
  per reference the document uses beyond those: `Color/docx-theme-text1` (`Text 1`),
  `Color/docx-theme-accent1-tint-99` (`Accent 1, Lighter 40%`),
  `Color/docx-theme-accent1-shade-BF` (`Accent 1, Darker 25%`). Runs and styles reference
  them by id. `ColorGroup/docx-word-theme` holds them all (`createColorGroup`, after the
  swatches). Each theme swatch carries what it stands for (`LoweredSwatch::theme`: the
  reference and the colour at import).
- **Tints and shades are their own swatches, not swatch tints.** The engine's swatch-level
  tint (`ColorEntry::tint`) is applied only to spot and CMYK colours, and the wire has no
  per-run fill tint; a shade (toward black) has no tint equivalent at all. So a tint or
  shade is minted as an RGB swatch holding the resolved colour, named as Word names it.
- **Theme fonts resolve to concrete families.** The engine has no font aliases; the
  lowering writes the family (`Calibri`, `Calibri Light`), and `LoweredDoc::theme_fonts`
  keeps the theme's heading and body faces for save-back.
- **Save-back writes the reference while the colour is unchanged.** A run whose `<w:rPr>`
  is untouched keeps its `w:color` bytes, reference and all. When a run's look is written,
  a colour that is a theme swatch still showing its import colour is written
  `w:color w:val="…" w:themeColor="…" [w:themeTint|w:themeShade]`; any other colour is
  written as hex alone (the old element is replaced whole, so no stale `w:themeColor`
  survives to override it). A family equal to the theme's body or heading face is written
  with `w:asciiTheme` / `w:hAnsiTheme` (`minorHAnsi`, `majorHAnsi`) beside its name.
- **Editing a theme swatch recolours its runs, and save writes hex.** The bundle reads the
  display colour of every theme swatch at save (`swatchDisplay`); one that moved by more
  than 2 per channel (colour management may round) is a changed colour, so its runs are
  written with the new hex and without the reference.
- **Any document swatch is writable as hex.** A run filled with a swatch the import did not
  make (a CMYK, spot or Lab swatch of the document, or one made on the canvas) is written
  as the colour the host displays for it, as before (save-back leftovers, 2026-10-24).

## Consequences

- A Word document's text now lowers in its theme fonts (Calibri, Aptos, …) instead of the
  engine's default face, and its headings in their theme colours.
- Inserting two Word documents with different themes into one layout shares the swatch ids
  `Color/docx-theme-*`: the second document's theme colours take the first's swatches (the
  pour does not recreate an existing swatch). Each document's own save-back still compares
  against its own import colours.
- `w:themeColor` on `w:u` (underline colour) and theme colours in table and paragraph
  borders are not read: the engine has none of those.

## Related

- [ADR 600](600-docx-lowered-onto-native-model.md) — the lowering this extends.
- [ADR 602](602-save-back-is-a-byte-splice.md) — the splice that writes the references.
- [ADR 610](610-save-back-across-sessions-and-new-parts.md) — styles.xml save-back.
- Sheet [ADR 518](../../../sheet/docs/adr/518-cell-visual-model-and-colour-references.md) —
  the same "reference beside the concrete value" rule for workbook colours.

# ADR 713 — Live theme: theme colours as swatches by key, theme fonts on the root styles, one mutation per theme

- **Status:** Accepted 2026-10-29. Part of the parity program ([ADR 711](711-powerpoint-parity-program.md)),
  wave W3. Amends [ADR 703](703-slide-data-storage.md) (the theme lives in the deck label) and
  [ADR 711](711-powerpoint-parity-program.md) (palette edits, theme colours on export).
- **Scope:** `platform/shared/ooxml` (`SchemeColors::theme_key`), `platform/shared/dml-native`
  (theme swatches by id), `slide-resolve` (`theme`), `slide-native`, `pptx-import` (`themes_in`),
  `pptx-export` (`theme`, `text`), `slide-js` (`theme`), `packages/slide-bundle` (`design.ts`,
  `panels/design-panel.tsx`, the manifest).

## Context

Import baked every theme colour into its RGB value. A colour that happened to equal a theme
slot got the slot's swatch (`Color/accent1`); a tint (`accent1` lighter 40 %) or a mapped colour
(`bg1` on a dark slide) became a plain `Color/RRGGBB`. Theme fonts were baked into every run.
So a deck could not change its theme: there was nothing to recolour, and export wrote the theme
part as the deck had it. PowerPoint's Design ▸ Themes changes every theme colour and the heading
and body fonts of the deck at once, and its Variants do the same within one theme.

The engine has swatches, swatch groups, paragraph and character styles, and one undoable
batch of mutations. It has no theme. The plan for wave W3 keeps it that way: the theme is a
plugin concept over engine styles.

## Decision

- **A theme colour is a swatch by key.** The resolver keeps, for every colour it resolves from
  `a:schemeClr`, a key: the theme slot the colour lands on through the colour map (so `bg1`
  under `clrMap bg1="dk1"` is `dk1`: `clrMap` and `clrMapOvr` resolve as swatch aliasing), and the
  colour's transforms, alpha left out (it is the item's opacity): `accent1 lumMod60000
  lumOff40000`. `phClr` takes the style reference's key and appends its own transforms. A theme
  other than the deck's first prefixes its part's name (`theme2:accent1`). The key is the
  swatch's id, `Color/<key>`, named as PowerPoint names it (`Accent 1, Lighter 40%`). The hook is
  `SchemeColors::theme_key` in the shared DrawingML resolver: a default method that keeps doc's
  and sheet's reading (the slot of an untransformed colour), and that the slide's colour context
  overrides.
- **Swatches by id.** The shared mapper gets an opt-in (`Mapper::with_theme_keys`): a solid paint
  with a key fills with that key's swatch, and one without a key with a plain colour's swatch even
  when its value equals a theme colour. A literal white stays white under a dark variant. Gradient
  stops and effect colours keep the value match they had.
- **The "Theme" swatch group.** Import writes a colour group `Theme`: the twelve slots (Dark 1,
  Light 1, Dark 2, Light 2, Accent 1–6, Hyperlink, Followed Hyperlink), each tinted slot's five
  tints and shades from PowerPoint's colour picker (lighter 80/60/40 %, darker 25/50 % for a mid
  colour; the black, white, very dark and very light rows as PowerPoint has them), and every other
  key the deck's art uses. A colour picked from the group stays a theme colour.
- **Theme fonts on the root styles.** The paragraph styles `Title` and `Body` carry the theme's
  major and minor Latin font ([ADR 719](719-document-styles.md) makes the placeholder styles their
  children). A run in a theme font has no font of its own when its paragraph's style is rooted in
  that font; otherwise it takes the character style `Headings font` or `Body font`.
- **The theme as data, in the deck label.** The deck label carries `theme` (the theme the
  document shows: name, the twelve slots as `RRGGBB`, the two fonts, the variant, and the
  remap of [ADR 719](719-document-styles.md)) and `deckTheme` (the deck's own). It is in the label,
  not in a container part (ADR 703 put the theme map there), because a theme change must undo
  with the swatches it recoloured.
- **Applying a theme is one mutation.** Design ▸ Themes, a variant and the typed `applyTheme` send
  one batch: an `editSwatch` per theme swatch of the document, with its key's colour under the new
  theme (computed in Rust, `theme::swatch_values`); a `setStyleProperty` of the font on the root
  styles and the theme-font character styles; and the deck label. Items recolour through their
  swatches. A key of another theme of the deck takes the applied theme too: a theme applies to
  every master, as in PowerPoint.
- **The gallery.** No Office theme file is vendored: Microsoft's `.thmx` files ship with Office,
  under its licence, and nothing clearly allows redistributing them. The gallery
  (`slide-resolve/themes/gallery.json`, written by `scripts/gen-theme-gallery.py`) holds two themes
  read from OOXML packages already in this repository (the slide fixtures' `Office` theme and the
  `Office 2007 – 2010` theme of a sheet test workbook), and four of paged's own (Paper, Slate,
  Harbour, Meadow) on the same twelve slots. The deck's own theme comes first as "This
  presentation". Each theme has four variants derived from it: as it is, Dark (the dark and light
  slots swapped), Shifted (accents rotated by two) and Muted (accent saturation 45 %). Browse for
  Themes… reads a `.thmx` (its theme, with its own variants when it has them), a `.potx` or a
  `.pptx` (`pptx_import::themes_in`), adds them to the gallery for the session and applies the
  first.
- **Export.** The theme the document shows is read from the document itself: each slot's
  swatch (or its remap), the fonts of `Title` and `Body`, the name in the label. When it is not
  the deck's own theme, every slide master's theme part is written with its colour scheme, its
  Latin fonts and its name; the format scheme and everything else stay. A swatch with a key is
  written as `a:schemeClr` of its slot (named as the slide's master maps it, `dk1` → `tx1`) with
  its transforms, whatever its current value. A run with a theme-font character style writes
  `+mj-lt` / `+mn-lt` where its level's font is another. Slides that were not edited keep their
  bytes: their colours were scheme colours all along.

## Consequences

- A theme change recolours every item, table style, object style and paragraph style that refers
  to a theme swatch, and is one undo step. Undo restores the label with the swatches.
- Editing a slot swatch's colour directly (the swatches panel) is a theme edit: export writes it
  into the theme part (ADR 711's "palette edits do not mark shapes edited" no longer loses it).
  Its tints are not recomputed until the next theme is applied; export writes them as scheme
  colours with transforms, so PowerPoint shows them right.
- Approximations: gradient stops, effect colours (shadows, glows), bullet colours and pattern
  fills keep their value (a value equal to a slot still takes the slot's swatch, as before); a
  gradient fill does not recolour. Only the Latin theme fonts are live; East Asian and complex
  script theme fonts stay resolved. Variants are derived, not PowerPoint's own (a `.thmx` read with
  Browse brings its own). The theme's format scheme (fill, line and effect styles) is not changed
  by a theme from the gallery: it keeps the deck's.
- The engine stays without a theme type, as the plan decided. Masters and layouts (engine
  ADR 1026) are another wave's; when a deck has two masters with two themes, a theme applies to
  both.

# ADR 365 — Pattern Options save an engine pattern swatch; the tile field stays as pattern artwork

- **Status:** Accepted 2026-10-29.
- **Scope:** `packages/draw-bundle/src/commands/pattern.ts` (`patternSwatchSpecFor`,
  `patternSwatchIdFor`, `applySavePatternSwatch`, `SAVE_PATTERN_SWATCH_COMMAND_ID`,
  `PATTERN_PAINT_FEATURE`, `PatternField.swatch`, `PATTERN_SWATCH_NOTE`),
  `panels/pattern-panel.tsx`, `menu.ts`, `manifest.json`, `locales/de.json`;
  `scripts/illustrator/probes/pattern-render.jsx`. Work package WP6.9 of the image/draw plan;
  gap D-16. Rests on engine ADR 1041.

## Context

Pattern editing v1 (2026-08) built everything Illustrator's Pattern Options ask for except the
swatch: a re-editable field of copies on a grid, brick or hex lattice, with tile size, spacing,
overlap order, copy counts and dimming. The swatch was a wall (RFI C-31): no pattern paint in
the format, the engine model or the wire, so the field produced artwork, and the module, the
command title, the panel note and `PATTERN_SWATCH_NOTE` said so. Engine ADR 1041 removed the
wall: a pattern swatch is now a palette entry `createSwatch` writes, any frame takes as a fill or
a stroke, both canvas lanes draw and PDF writes as a tiling pattern.

## Decision

**The field is pattern editing mode; the swatch is what it saves.** The field keeps its role —
its copies are the live preview of the tile — and is named *pattern artwork* where the two could
be confused. Two actions join it:

- **Save swatch** (`media.paged.draw.command.savePatternSwatch`, Draw ▸ Pattern ▸ Save as
  pattern swatch, the panel's per-field button): the field's saved parameters, merged with the
  Pattern Options panel's draft, and its sources' current geometry and paint become one
  `createSwatch` with a `pattern` — or, once saved, one `editSwatch` of the id the recipe
  remembers (`PatternField.swatch`). One undo step. The id is a slug of the field's name
  (`Pattern/rings`, `Pattern/rings-2`, …), never one the `swatches` collection lists.
- **Done** (the same command with `exit: true`, the panel's Done button): save, then remove the
  copies as Delete copies does; the sources stay, as Illustrator keeps the artwork a pattern was
  made from.

The Swatches panel lists the swatch (kind `"pattern"`, a tile glyph for a chip) and applies it as
a fill, or with Alt as a stroke, through the `colorRef` it uses for a colour.

**The mapping (`patternSwatchSpecFor`, pure).** The tile is `params.tile` or the sources' bounds,
its origin their top-left; each source with a document colour fill or a stroked colour becomes an
item, its contours moved to the tile origin, its paint by swatch reference (a gradient, `None` or
a pattern paints nothing in a tile and is dropped; nothing paintable refuses). The lattice is the
one the copies preview: `grid` → `Grid`; `brick` → `BrickByRow` with the row shift as the brick
offset; `hex` → `BrickByRow` too, its vertical spacing chosen so the row pitch is the preview's
`(tile + spacing) × √3/2`. Spacing and overlap order map one to one. For a row shift other than
½ the engine's brick lattice shifts every row cumulatively (a true lattice), where the field
alternates; ½ — the default and Illustrator's — is the same in both.

**The feature door.** The save asks `supports("document.patternPaint@1")` and refuses in words
on an engine without it; the panel disables the two buttons with the same sentence.
`PATTERN_SWATCH_NOTE` and the panel note now say what a field is and what the swatch is, and
the conformance tests pin the new wording as they pinned the old.

**The oracle.** Illustrator's scripting cannot make a pattern swatch from artwork, so
`scripts/illustrator/probes/pattern-render.jsx` hands it the engine's PDF tiling patterns and
records how it reads, draws and re-exports them (engine ADR 1041 replays it).

## Consequences

- RFI C-31 is closed: a pattern made here is a fill and a stroke for any object, kept by
  `.paged`, written to PDF as a pattern, and carried through IDML in a label.
- A field saved twice updates one swatch; deleting the field's recipe (Delete copies, Release)
  forgets the link, and a later save mints a new swatch.
- A tile item is a path with a colour: text, placed pictures and gradients in the source do not
  reach the swatch (they are dropped or refused with a log line), as engine ADR 1041 models it.

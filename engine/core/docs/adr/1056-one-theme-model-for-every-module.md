# ADR 1056 — One theme model for every module: colour slots and a font scheme on the document

- **Status:** Accepted 2026-11-01; **slices 1 to 3 built** (the model, its `.paged` encoding,
  slide's import; the `theme` collection and the three operations, riding v78; swatches that follow
  a slot, with the colour arithmetic in `paged-colour-math`). Open: doc and sheet lowering, font
  references on styles, export write-back from the model (slice 4 onward). Part of the capability layering of PM-0014 and PM-0017
  ([capability register](../../../../docs/development/capability-register.md), "Themes"). Amends
  slide [ADR 713](../../../../modules/slide/docs/adr/713-live-theme.md) and
  [ADR 719](../../../../modules/slide/docs/adr/719-document-styles.md) (see Migration).
- **Scope:** `paged-model` (`theme.rs`), `paged-scene` (`Document.theme`), `paged-store` (the
  native encoding), later `paged-mutate`, `paged-wire`, `paged-canvas` (the `theme` collection);
  for the readers and writers per format: slide (`slide-native`, `pptx-export`), doc
  (`docx-*`), sheet (`sheet-xlsx`); the one DrawingML reader is `paged-ooxml::drawingml::theme`.

## Context

Word, PowerPoint and Excel carry the same `a:theme` part: a colour scheme of twelve slots, a font
scheme (a headings set and a body set, each with a face per script) and a format scheme (fills,
lines, effects). The engine has no such concept. Five places read the part (doc ×2, slide ×2,
sheet; the shared reader exists since PM-0017's first wave) and each lowers it its own way:

| Where | Lowers a theme to |
|---|---|
| slide (ADR 713, 719) | swatches by key (`Color/accent1 lumMod60000 lumOff40000`) in a "Theme" swatch group; two character styles `Headings font` / `Body font` and the root paragraph styles `Title` / `Body`; the theme as JSON in the deck label; the Design panel's `applyTheme` batch |
| doc | literal swatches; the theme's fonts are baked into styles |
| sheet | literal colours; the part is kept as a blob for export |

So a document opened from Word cannot offer a theme picker, a Word theme change cannot reach
content, and a host that wants one list of themes has to know three plugin conventions.

## Decision

### The model

`Document.theme: Option<Theme>` (absent from the native encoding when the document has none, so
older documents read unchanged and their canonical hash does not move).

```
Theme { name, color_scheme_name?, colors: [ThemeColor], font_scheme_name?,
        major: ThemeFonts, minor: ThemeFonts, source?: SourceBlob }
ThemeColor { slot, value: "RRGGBB", system?: "windowText" | "window" }
ThemeFonts { latin?, east_asian?, complex?, scripts: [(script, typeface)] }
```

- **Twelve slots**, in the order the file writes them: `dk1, lt1, dk2, lt2, accent1..accent6,
  hlink, folHlink` (`THEME_SLOTS`). A slot the file has no colour for is absent. `dk1` and `lt1`
  are system colours in Office's themes; the model keeps the last value as `value` and the system
  name as `system`, so a writer can restore the `sysClr`.
- **Fonts** are the font scheme as the file has it: major (headings) and minor (body), each a Latin,
  East Asian and complex-script face and a list of per-script faces (`Jpan`, `Hans`, `Arab`, …) in
  file order. An empty face in the file is no face.
- **Variants are not in the model.** PowerPoint's Variants and the gallery are module behaviour
  (slide's `ThemeIr::variant`, the dark/swapped/muted variants of `slide-resolve`): a variant is a
  theme with other slot values, and applying one is the slot-colour operation below. Excel's tint
  steps and Word's "Lighter 40%" names are colour *transforms* on a slot and stay with the module
  that writes the `schemeClr`.
- **Not in slice 1: the format scheme** (fill, line and effect styles). Slide's resolver reads them
  and lowers references; the engine model gets them when a second consumer needs them.

### How content follows a theme change (slice 3, built for swatches)

A swatch gains an optional **theme reference**: `slot` plus the transforms after it (the key
slide already writes, `accent1 lumMod60000 lumOff40000`). A swatch with a reference takes its value
from the theme: setting a slot colour recolours every such swatch, and so every item that uses it,
in the same undo step. This is slide's mechanism (swatch id = key), moved into the engine; the
swatch group "Theme" becomes a view of the theme (its slots and tints) rather than a stored list.
**Built.** `ColorEntry.theme_ref: Option<ThemeRef { slot, transforms }>` (absent from the encoding
when `None`, so every existing output is unchanged). `SetTheme` and `SetThemeColor` recolour, in the
same step, every swatch that has one: `Theme::resolve` takes the slot's colour and applies the
transform chain with `paged-colour-math` (the one owner of the sRGB curve, HSL and the DrawingML
transforms, moved out of `paged-ooxml` with an oracle test that keeps the old code and compares
bit for bit), clamps and rounds as a scheme colour resolves. A slot the theme lacks leaves its
swatch alone. `RestoreTheme` (the inverse of all three) carries the theme and the followers'
values, so undo restores both. `EditSwatch` leaves the reference alone (the reference is the
theme's, not the spec's); a deleted swatch that is brought back by undo comes back as a literal
colour (a known gap). Slide's import gives a reference to each swatch that is a key of the deck's
own theme and whose colour its theme resolves to (so following it changes nothing today); slide's
`applyTheme` sends `setTheme` first, then the swatch edits it always sent, which stay as the fallback
for decks whose swatches carry no reference and for a remapped slot's stand-in.

Fonts: a **theme font reference** (`major` / `minor`, per script) on a character and paragraph
style's font, resolved against the theme at composition time. Until slice 3 the references are
the two slide character styles and the root paragraph styles, written as today.

### Operations (slice 2, built)

Each is one named undo step (ADR 1030), over the wire (`setTheme`, `setThemeColor`,
`setThemeFonts`) and in the script bridge (`paged.setTheme`, `paged.setThemeColor`,
`paged.setThemeFonts`): `setTheme(theme)` replaces the theme (a theme picker; creates one in a
document that has none), `setThemeColor(slot, value)` sets one slot (`RRGGBB`, `#` allowed; a
system colour becomes a fixed one; a slot the theme lacks is inserted in scheme order),
`setThemeFonts(which, fonts)` replaces the `major` or `minor` set. The last two need a theme and
refuse without one; an unknown slot, a bad colour, a duplicate slot or a `which` other than
`major`/`minor` is refused and changes nothing. The inverse of all three is the inverse-only
`RestoreTheme`, which carries the theme as it was.

**The source after an edit (decided).** The source is kept and the theme is marked `edited`
(`Theme.edited`, set by every theme operation, absent from the encoding while false). It is not
cleared: the part holds the format scheme, extension lists and `objectDefaults` the model does not
carry, which a clear would lose. A writer therefore has three cases: `source` and not `edited` ->
re-emit byte for byte; `source` and `edited` -> patch the colour and font schemes of the source
with the model (slide's `rewrite_theme_xml`); no `source` -> render a theme part from the model.
`SetTheme` over a theme keeps its source, so a picker applying another theme to a Word, Excel or
PowerPoint document still writes into that document's own part. Undo restores `edited` with the
rest. Recolouring the referencing swatches in the same step is slice 3.

### Reads

The collection `theme` (slice 2, built): an array of zero or one row, the model as above with
`source` reported as `{format, bytes}` (not its text) and `edited`. A host's theme picker reads it and sends `setTheme`; the list of
available themes (the gallery) is the module's.

### Fidelity

`source` holds the original theme part, as comments' `source` does (ADR 1055): a writer
re-emits it **byte for byte** until the theme is edited. After an edit the writer rewrites the colour
and font schemes in the original XML and keeps everything else in it (the format scheme, extension
lists, `objectDefaults`): slide's `rewrite_theme_xml` is that writer. A field a target cannot carry
is a reported loss. Word's and Excel's theme parts, and a `.thmx`, read into the same type.

### What slice 1 covers

- `paged-model::Theme`, `ThemeColor`, `ThemeFonts`, `THEME_SLOTS`; `Document.theme`; the native
  `.paged` encoding (serde; absent when `None`).
- slide's import fills it from the deck's first theme: name, colour scheme name, the twelve slots
  with `dk1`/`lt1` system names, both font sets with their scripts, and the part as `source`.
- Additive and byte-neutral: slide's swatches, "Theme" group, character styles and deck label are
  unchanged, and `pptx-export` still writes from them (its tests and goldens pass unchanged).
- **No wire change** in slice 1. Slice 2 adds the collection and the three operations (rides v78,
  before its first consumer sync) with the full resync in one commit.

### Slices after

2. (built) The `theme` collection and the three operations. 3. (swatches built; font references open)
Swatch and font theme references; slide's `applyTheme` sends `setTheme`; the Design panel reads the
collection.
4. doc and sheet lower onto it (their literal swatches become references; the doc's theme fonts
leave the styles); export writes back from the model. 5. The format scheme.

## Oracle (PowerPoint, 2026-11-01)

A deck saved by PowerPoint (the conformance fixtures are) carries `ppt/theme/theme1.xml` named
`Office`: `clrScheme` in the order `dk1` (`sysClr windowText 000000`), `lt1` (`sysClr window
FFFFFF`), `dk2` 0E2841, `lt2` E8E8E8, `accent1` 156082, `accent2` E97132, `accent3` 196B24,
`accent4` 0F9ED5, `accent5` A02B93, `accent6` 4EA72E, `hlink` 467886, `folHlink` 96607D;
`fontScheme` `Office` with `majorFont` latin `Aptos Display`, `minorFont` latin `Aptos`, then `ea`,
`cs` and 94 `font script=` faces in the two sets. To prove PowerPoint keeps a *non-default* theme as
the model reads it, the fixture's theme was edited (theme name `Probe Theme`, scheme name `Probe
Colours`, font scheme `Probe Fonts`, ten slots changed, Georgia/Verdana as the Latin faces), opened in
PowerPoint and saved as `.pptx`: the saved `theme1.xml` has the same name, scheme and font scheme
names, the same twelve slots in the same order with the new values, `sysClr` kept for `dk1`/`lt1`,
and the new faces. The notes master's own theme (`theme2.xml`) stays `Office`; one theme per
master, so a deck can hold several (the model holds the first master's, as slide does today; the
others stay with the deck's package).

## Consequences

- One model for the theme picker, the Design/Page Layout surfaces and the CLI, whichever module
  opened the file; a theme change can recolour Word and Excel content once their swatches reference
  slots.
- The document holds both the model and (until slice 3) slide's swatch convention; the two agree
  because both are built from the same part in one import.
- The `.paged` of a slide deck is larger by the theme part (about 9 KB before compression).

## Migration

1. **slide** (ADR 713, 719). Slice 1 changes nothing they describe. From slice 3 the theme in the deck
   label (`theme`, `deckTheme`) is the model's `theme` plus the variant name; the "Theme" group and
   the `Headings font` / `Body font` styles become views of the theme and theme-font references.
   ADR 713's "the engine has no theme" is amended by this ADR now.
2. **doc, sheet.** Their readers keep lowering to literal swatches until slice 4; each adds the
   `Document.theme` fill (a call to the same constructor) at that point.
3. **Old documents** read unchanged: no `theme` field means no theme.

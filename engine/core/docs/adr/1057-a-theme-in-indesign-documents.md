# ADR 1057 — A theme in InDesign documents: native source of truth, plain swatches in IDML, the theme in a document label

- **Status:** Accepted 2026-11-02; **stage 2 built** (the model, the operations, the label in `paged-mutate`'s `theme_interchange`, the `themePresets` collection). The Theme panel (stage 3) is built, with CMYK followers, style font references and the import notes; the InDesign label size is measured (Amendment below). Extends
  [ADR 1056](1056-one-theme-model-for-every-module.md) to the IDML / publish half, where the
  format has no theme. Part of the capability layering of PM-0014 and PM-0017
  ([capability register](../../../../docs/development/capability-register.md), "Themes").
- **Scope:** `paged-model` (`theme.rs`: presets, font references), `paged-mutate` and `paged-wire`
  (`createThemeFromSwatches`, `setStyleThemeFont`, the `themePresets` rows), `paged-mutate` (`apply/theme_interchange.rs`: the label writer and reader, the symbols mechanism of
  ADR 1039; the export loss lines come from it), `idml-export` (the document label is the
  existing one), `idml-import` (the label reader and the detach report), `sheet-chart` (the
  palette owner, follow-up).

## Context

ADR 1056 gave every document an optional theme: twelve colour slots, a font scheme, swatches that
follow a slot (`ColorEntry.theme_ref`). InDesign has none of it: a `<Color>` is a value, a style
names one font. A document that was opened from Word or PowerPoint, or one a user themed in the
editor, still has to leave as IDML that InDesign reads as ordinary swatches, and come back to the
editor with its theme. Four things were open: where the theme lives in the IDML, how a document
without a theme gets one, how styles follow the font scheme, and what the default palette is.

## Decision

### (a) Persistence: the model is the source of truth; IDML gets plain swatches and a label

- **`.paged`.** The native model part (`document.pgm`, ADR 118) stores `Document.theme` and every
  `theme_ref`. Nothing changes; this is the only lossless form.
- **IDML, what InDesign sees.** Export writes ordinary `<Color>` swatches. A following swatch's
  value is already its resolved colour (the operations recolour in the same step), so *flattening
  is dropping the reference*; no resolver runs at export. A paragraph or character style that
  references a theme font (c) is written with the face it resolves to. A document without a theme
  produces byte-identical output to today (no label, no change; the goldens of `idml-export` and
  `idml-import` stay as they are).
- **IDML, what paged reads back.** The theme goes in one **document label**,
  `x-paged:core.theme` in `<Document><Properties><Label>` (the mechanism of ADR 1000 and 1014 and of
  `idml-export`'s `document_labels.rs`). This follows the existing preservation rules rather than
  the container parts of ADR 118: a label is what InDesign keeps through an open and a save, while
  `paged/…` ZIP entries are dropped by InDesign's save and are not written into the `.idml`
  product at all. InDesign shows the label only as script label data; it ignores its content.
  The value is JSON:

  ```
  { "v": 1,
    "theme": { …Theme as ADR 1056 encodes it (name, colours, fonts; `source` while <= 64 KiB) },
    "links": [ { "swatch": "<Color name>", "ref": "accent1 lumMod60000 lumOff40000",
                 "value": "RRGGBB", "space": "RGB" } … ],
    "fonts": [ { "style": "<style name>", "kind": "paragraph|character", "which": "major|minor" } … ] }
  ```

  Links and font references are keyed by **name**, not by `Self`: InDesign renumbers `Self` on a
  save, a swatch name is unique in a document and is what a user sees. `value` is the colour the
  export wrote, kept for the detection in (e).
- **Loss report.** A theme-carrying document exports with a note in the loss list (the
  `lost in translation to IDML` channel of ADR 1055, `theme_losses` beside `comment_losses`):
  "theme `<name>` written as plain swatches; the link of N swatches and M styles lives in the
  document label `x-paged:core.theme`, which only paged reads". Also reported: the format scheme
  (not modelled), a `source` over the size limit (dropped from the label), a swatch that
  cannot follow a slot, and a label that would exceed the limit measured on InDesign (see
  Amendment 1: none was found).
- **Import.** `idml-import` reads the label after the swatches and styles, sets `Document.theme`,
  restores each `theme_ref` whose swatch still has the recorded value, and each font reference
  whose style still has the recorded face. A label of another `v`, or unparseable, is ignored with
  an import note (the swatches are the document, as before).

### (b) Import without a theme: "Create theme from swatches"

An IDML from InDesign has no theme. One operation promotes swatches to a theme:
`createThemeFromSwatches { name?, slots: [{ slot, swatch }], relink }`. One named undo step
(ADR 1030). It creates the theme (refused when the document already has one: replace it with
`setTheme`), sets each named slot to its swatch's colour, and, with `relink`, gives a `theme_ref` to
the slot's own swatch and to every other RGB swatch that is a **tint of a slot the DrawingML way**:
the chain `lumMod` / `lumOff` at the standard 20, 40, 60, 80 and `lumMod 50 / 75` steps (the
Office "Lighter" and "Darker" names) resolves to the same sRGB value, compared exactly after the
engine's rounding. Nothing is guessed beyond that: a swatch that matches no slot stays literal.

- **Colour space (built, amended 2026-11-03).** A theme slot is sRGB. Which swatches follow:
  - **Process RGB** and **process CMYK** swatches follow a slot and stay in their space. When the
    slot changes, an RGB follower takes the slot's bytes; a CMYK follower takes four percentages
    derived from them.
  - **Spot, mixed-ink, Lab, gray and pattern swatches never follow.** A spot ink IS its colour (a
    plate), the others have no exact inverse. Nothing is dropped silently: `createThemeFromSwatches`,
    `createSwatch` with a `themeRef` and an `editSwatch` that would turn a follower into one of
    these are refused with a message that says why, and the Theme panel disables such swatches in
    its picker and says so in words.
  - **Deviation from the first design ("converted through the one CMS").** The conversion is
    profile-free: `paged_color::math::srgb_to_naive_cmyk` (the inverse of `naive_cmyk_to_srgb`,
    the conversion the engine uses wherever no CMYK profile is configured), rounded to two
    decimals. Reason: an operation must give the same numbers on every host and on every replay,
    undo and remote apply, and the CMS needs a profile the operation layer does not hold. With no
    CMYK profile the follower renders exactly as its slot; with one, the renderer sends the numbers
    through the CMS like any CMYK swatch, so the printed colour may differ from the slot's sRGB
    within the gamut. A CMYK swatch given to a slot gives the slot its naive sRGB value
    (the panel says so); a CMYK swatch is relinked when that value equals a tint of a slot.
  - The label records a CMYK link as `"space": "CMYK"` and `"value": "c,m,y,k"` (percent, two
    decimals); the import check (e) compares space and value, so a number changed in InDesign
    detaches the link and is reported.
- **Which swatches.** The host proposes slots from a swatch group (darkest to `dk1`, lightest to
  `lt1`, the rest by chroma to `accent1..6`); the user edits the assignment. The engine takes the
  explicit list and never proposes.

### (c) Font scheme by reference

ADR 1056 slice 3 built the swatch half only; its font half says "resolved against the theme at
composition time" and has nothing built (slide keeps its two `Headings font` / `Body font`
character styles). Decision, **amending that sentence**: a font reference is resolved **when the
theme changes, not when text is composed**, exactly like a swatch.

`ParagraphStyleDef` and `CharacterStyleDef` gain `font_ref: Option<ThemeFontRef { which: Major |
Minor }>`, absent from the encoding when `None`. `SetTheme` and `SetThemeFonts` set `font` of every
style with a reference to the scheme's Latin face (the Latin face of `major` or `minor`) in the
same undo step, and `RestoreTheme` carries the old faces for undo. Reasons: composition, the
renderer, the IDML export and every font-substitution path keep reading `font` and stay untouched;
text in a styled document restyles through the style, which is what InDesign users expect of a
style; byte-neutral for documents with no reference. Scripts (`east_asian`, `complex`, the
per-script list) are not referenced in this slice: ADR 1051's script slots are a different
field; a script-face reference is a later amendment. **Built:** the reference is set and cleared by
`setStyleThemeFont { collection, styleId, which? }` (`which` absent stops following and keeps the
face); a `setStyleProperty` of `font` leaves the reference alone, as `EditSwatch` leaves a swatch's
(slide's save path edits following swatches and relies on that), so the next theme change restyles
the style again until the reference is cleared.

### (d) Presets: defined once (built)

`paged_model::theme::presets` owns the preset themes as constants: `office-2013` (the Office
theme of Word, Excel and PowerPoint 2013 to 2022: `dk2 44546A`, `accent1 4472C4`, `ED7D31`,
`A5A5A5`, `FFC000`, `5B9BD5`, `70AD47`, hyperlinks `0563C1` / `954F72`; Calibri Light and Calibri)
and `office-2023` (the PowerPoint oracle recorded in ADR 1056: `0E2841`, `E8E8E8`, `156082`,
`E97132`, `196B24`, `0F9ED5`, `A02B93`, `4EA72E`, `467886` / `96607D`; Aptos Display and Aptos),
each a full `Theme` with `dk1` / `lt1` as system colours. Hosts read them as **read-only rows of a
`theme-preset` collection** (no new message; applying one is `setTheme`). The capability register
listed the default Office palette twice; the theme-lowering work has since made
`paged_ooxml::drawingml::theme::OFFICE` the reader's one fallback. `presets::OFFICE_2013_RGB` is the
engine-side owner (the model cannot depend on `paged-ooxml`, which sits above it, and `paged-ooxml`
cannot yet take the model as a dependency without a workspace decision); a test in `dml-native`
holds the two equal, and `sheet-chart`'s `OFFICE_THEME` remains for the sheet owner to fold into
`OFFICE`.

### (e) Risk: a flattened swatch edited in InDesign

InDesign sees plain swatches, so a user can change a linked swatch's colour, rename it or delete
it, and paged would otherwise restore the link over the user's edit or drop it silently. The
label records `value` (and `space`) per link; on import each link is **checked against the
swatch as it is now**:

- name present, value equal -> link restored;
- name present, value or space differs -> **detached**, the InDesign edit wins, the swatch is a
  literal colour, reported: "swatch `<name>` was edited outside paged; its link to `accent1 …` was
  dropped";
- name absent -> reported as lost (renamed or deleted); a renamed swatch is **not** guessed;
- a swatch with no link in the label but the same name as a former link is a plain swatch.

The report is an import note (same channel as other import warnings) and appears in the host's
import summary. Detached swatches can be re-linked with the Theme panel's relink (stage 3), which
runs (b)'s matching. The same check protects a style whose face was changed in InDesign. The
theme itself cannot be edited in InDesign (no UI shows the label), so its integrity needs no check
beyond `v`.

## Alternatives considered

- **A `paged/core/theme` container part.** Not chosen alone: InDesign drops it on save and the
  `.idml` product never carries it; the label survives both.
- **`Self`-keyed links.** Not chosen: renumbered by InDesign.
- **Resolving font references at composition time.** Not chosen: touches the renderer, the
  composer and every export for no visible gain over a style edit.
- **A swatch label per `<Color>` instead of one document label.** Not chosen: one atomic value
  that a reader either takes or drops, and the document label path exists; per-swatch labels
  would be kept by InDesign but split the state.

## Consequences

- IDML output differs only for documents that carry a theme (slide and Office imports and
  themed documents); everything else is byte-identical.
- Round trip IDML -> engine -> IDML -> engine keeps the theme and the links of untouched swatches;
  a document that went through InDesign keeps whatever InDesign did not change.
- A wire change in stage 2: `createThemeFromSwatches`, the `theme-preset` rows, `font_ref` in the
  style encodings. It needs the full resync in one commit and the plugin-api / plugin-sdk bump.

## Slices

1. This ADR (design, docs only). 2. Engine and IDML: presets, `font_ref`, the operation, the
label writer / reader, `theme_losses`, round-trip tests; sheet-chart's palette follow-up.
3. Host: the one Theme panel (core, every module context except slide): slots and fonts, apply a
theme or preset, create from swatches, relink; one undo step each.

## Amendment 1 (2026-11-03): host surface, CMYK followers, the label size

- **Host.** The Theme panel lists swatches with their space (`SwatchSummary.space`), sets a style's
  font reference through `setStyleThemeFont` (`fontRef` on the paragraph and character style
  rows), and shows what opening a file dropped from the `importNotes` collection (rows
  `{ message }`, the lines of `CanvasModel::import_notes()`). Additive wire change, contract canary.
- **CMYK followers and spot swatches:** decided under (b), "Colour space".
- **Label size, measured.** `tooling/oracle/indesign/label-size-probe.sh` (windowless, never
  interactive) sets one document label on a new document in Adobe InDesign 20.0.1.32 (2025) and
  reads it back; the recording is `label-size-probe.json`. A label of 1 KiB to 16 Mi characters
  (quotes, angle brackets, an ampersand and non-ASCII included) is kept in memory, and through an
  IDML export and reopen at 64 Ki, 256 Ki, 1 Mi, 4 Mi and 16 Mi characters. **No limit was found
  up to 16 Mi characters**, three orders of magnitude above the theme label (the `source` part is
  dropped over 64 KiB). The size guard stays at 64 KiB for `source`; no further limit is needed.

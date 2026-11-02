# ADR 1057 — A theme in InDesign documents: native source of truth, plain swatches in IDML, the theme in a document label

- **Status:** Accepted 2026-11-02 (design; stage 2 builds it). Extends
  [ADR 1056](1056-one-theme-model-for-every-module.md) to the IDML / publish half, where the
  format has no theme. Part of the capability layering of PM-0014 and PM-0017
  ([capability register](../../../../docs/development/capability-register.md), "Themes").
- **Scope:** `paged-model` (`theme.rs`: presets, font references), `paged-mutate` and `paged-wire`
  (`createThemeFromSwatches`, the `theme-preset` rows), `paged-canvas` (`theme_export.rs`: the
  lowering and its losses, beside `comment_export.rs`), `idml-export` (the document label is the
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
  (not modelled), a `source` over the size limit (dropped from the label), a spot swatch that
  cannot follow a slot, and a label that would exceed the limit measured on InDesign (stage 2
  measures it on the installed application and records the figure here).
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

- **Colour space.** A theme slot is sRGB. A swatch that follows one stays in its space: the
  slot's colour is converted through the one CMS (ADR 1032) when the theme changes. A **spot
  swatch never follows** a slot. A CMYK swatch chosen for a slot gives the slot its converted sRGB
  value; the host says so before applying. (Stage 2 checks what slice 3's recolour does for a CMYK
  follower today and aligns it.)
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
field; a script-face reference is a later amendment. A style with `font_ref` whose `font` the user
then sets by hand loses the reference (an `EditStyle` of `font` clears it, as an `EditSwatch` of a
value cannot, because a swatch edit of the value is the user choosing a literal colour: it also
clears the swatch reference in stage 2, amending slice 3's "leaves the reference alone", which
made a recoloured swatch jump back on the next theme change).

### (d) Presets: defined once

`paged_model::theme::presets` owns the preset themes as constants: `office-2013` (the Office
theme of Word, Excel and PowerPoint 2013 to 2022: `dk2 44546A`, `accent1 4472C4`, `ED7D31`,
`A5A5A5`, `FFC000`, `5B9BD5`, `70AD47`, hyperlinks `0563C1` / `954F72`; Calibri Light and Calibri)
and `office-2023` (the PowerPoint oracle recorded in ADR 1056: `0E2841`, `E8E8E8`, `156082`,
`E97132`, `196B24`, `0F9ED5`, `A02B93`, `4EA72E`, `467886` / `96607D`; Aptos Display and Aptos),
each a full `Theme` with `dk1` / `lt1` as system colours. Hosts read them as **read-only rows of a
`theme-preset` collection** (no new message; applying one is `setTheme`). The capability register
lists the default Office palette twice: `sheet-chart/src/colors.rs` `OFFICE_THEME` (a `[u32; 12]`
of the 2013 palette) and the sheet-xlsx style table. Both become a read of
`presets::OFFICE_2013` (a `[u32; 12]` accessor beside the `Theme`), and the duplicates are
deleted; that edit is in sheet code and is made by the sheet owner after stage 2 lands the
constant (the lowering work in doc and sheet is in progress and is not touched here).

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

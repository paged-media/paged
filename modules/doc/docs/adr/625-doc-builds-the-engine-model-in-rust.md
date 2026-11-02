# ADR 625 — Doc builds the engine's model in Rust; the plugin-local IR retires slice by slice

- **Status:** Accepted 2026-11-02. Slices 1 to 5 implemented (2 to 5 behind a flag, off); the rest is a plan.
- **Scope:** `docx-skeleton` (`body`), later `docx-lower`, `docx-export`, `docx-js`,
  `packages/doc-host-model`.
- **Builds on:** ADR 600 (lowering onto the native model), 602 and 613 (save-back is a
  byte splice of edited paragraphs), 606 (the skeleton is a native document), 618 (the shared
  DrawingML mapper reaches the model crate).

## Context

`docx-lower` produces a plugin-local IR (`ir.rs` and `ir_objects.rs`, forty-odd types).
`doc-host-model` turns it into host mutations (`mutations.ts`, about 1950 lines), and the
host's door styles a range only by applying a named style (ADR 600). Three costs follow:

1. Every distinct set of direct formatting becomes an invented named style
   (`docx-auto-pN`, `docx-auto-cN`), which the user sees in the style panel and which a
   save-back has to un-invent (`docx-export` `styles.rs`, `diff.rs`).
2. The model is reached only through a running host. "Save as .docx" of a document that is
   open is a read of stories (`docx-export/native.rs`), so tables, pictures and frames are
   not written, and there is no save-back from the live model.
3. Slide already goes the other way: `slide-native` builds `paged_model` in Rust and
   `pptx-export/native.rs` reads the model back. Doc is the odd one out, and the IR is a
   second description of what the model already is.

## Decision

Rust builds `paged_model` directly. The IR stays as the carrier for what has no model
construct yet, and shrinks one slice at a time. A slice lands only when the real CI is
green with the old path still working; until the last slice nothing is removed.

### The seam

`docx_skeleton::body::native_body(&LoweredDoc) -> NativeBody` returns, per story block and at
the block's index, either a model `Paragraph` or `Deferred { reason }`. A deferred block is
poured by the old path, so nothing is dropped. Because blocks keep their index and
`LoweredParagraph::source_index`, the ordinal map of `docx-export/bindings.rs` is unchanged.
The seam reads the IR, so the lowering is untouched while the slice is proven: a synthesized
style is resolved to the Word style it is based on plus its properties, and the properties are
set on the model's paragraph and run fields (the same assignments `setElementProperty`
performs in `paged-mutate`). The step that removes the IR for a slice is moving the same
property computation from `docx-lower` into the builder, after the slice has been in use.

### What each IR type becomes

| IR | Model construct | Slice |
| --- | --- | --- |
| `LoweredParagraph` (style, direct paragraph properties) | `Paragraph` with `paragraph_style` = the Word style and its own fields | 1 |
| `LoweredRun` (text, direct character properties) | `CharacterRun` with `character_style` and its own fields | 1 |
| `LoweredStyle` (Word styles) | `ParagraphStyleDef` / `CharacterStyleDef` in `StyleSheet`; the `docx-auto-*` styles disappear | 2 |
| `LoweredSwatch`, `LoweredColorGroup`, `SwatchTheme` | `Graphic` swatches and the engine theme (engine ADR 1056) | 2 |
| `LoweredSegment`, `LoweredListRef`, `LoweredDropCap`, tab stops | paragraph fields (`start_paragraph`, list fields, drop cap, `tab_list`) | 2 |
| `LoweredTable`, `LoweredCell`, `LoweredCellLook`, `LoweredNestedTable` | the model's table in the story, cell paragraphs built as above | 3 |
| `LoweredImage` (inline, crop, `fx`) | anchored frame holding the image, `imageContentTransform` (ADR 623), looks on the frame (ADR 619) | 4 |
| `LoweredAnchor`, `LoweredFloat*`, `LoweredTextBox`, `LoweredPageItem` | anchored objects and page items (ADR 614) | 4 |
| `LoweredField`, `LoweredToc`, merge fields, hyperlinks, bookmarks | `CharacterRun::field`, `hyperlink_source`, bookmarks | 5 |
| `LoweredComment`, `LoweredChange`, `LoweredFormatChange`, `LoweredPropsChange` | the model's comments and `Change` on runs and paragraphs (ADR 613) | 6 |
| `LoweredNote`, `LoweredMaster`, header and footer parts | model notes; masters (the skeleton already builds them, ADR 611) | 7 |
| `LoweredSection`, `sections` | already native (skeleton) | done |

What the IR still carries after slice 1: everything above except plain body paragraphs and
runs whose direct formatting maps to a model field. Slice 1 builds the fields for paragraph
justification, indents, spacing, keep options, and run font, style, size, leading, tracking,
baseline shift, case, position, underline, strikethrough and fill colour. A paragraph with any
other property, a character property in a paragraph style under a run that has a character
style (the cascade order would change), a list item, picture, field, note, comment, tracked
change, content control, bookmark, hyperlink, drop cap or in-paragraph break is deferred.

### Order

1. Direct formatting on body paragraphs (this ADR's implementation). The builder is not yet
   called by the open path: it is proven by a test that compares it with the IR.
2. Styles, swatches and the remaining paragraph fields: Rust writes the `StyleSheet`, and the
   synthesized styles are gone from the document for good. First slice wired into the open
   path (`docx-js` returns the pre-filled skeleton; `mutations.ts` skips what the skeleton
   already holds).
3. Tables. 4. Pictures and anchored frames. 5. Fields. 6. Comments and tracked changes.
7. Notes and masters. After 7 the IR is deleted, together with `doc-host-model`'s mutation
   builders; the TS bundle keeps the panel and the file input (ADR 600's thin-glue rule).

### Slice 2 as built: the prefilled skeleton

Styles and swatches stay with the old path for now (about fifty property paths, and the
catalogue is the part a save-back inverts); what slice 2 moves is the body. `skeleton_prefilled`
(`docx-skeleton`) returns the skeleton with the stories already holding the model paragraphs of
slice 1, or `None` unless the WHOLE body is native (a story half built here and half poured would
split a paragraph's range between two mechanisms): any deferred block, a comment, a table of
contents or tracked changes makes it `None`, and the document opens by the old pour. The bundle
calls it when `NATIVE_BODY.enabled` (off) and then skips the body pour; the styles and swatches the
paragraphs name are created after the open, as before. The real-engine spec
`test/headless/native-body.spec.ts` opens a fixture both ways and requires the same text, the same
page count and the same selection rectangles per paragraph, no `docx-auto` style on a native
paragraph, and an unedited export equal to the source. The flag turns on when that spec and the
conformance suites are green on the final commit and the remaining slices make the document
mostly native, not before.

### Slice 3 as built: tables

`body::build_table` makes the table `insertTable` and the bundle's cell pour make: the whole
grid of cells with InDesign's new-table edges, column-major, header rows, row heights and column
widths from the lowering, each cell's borders and shading, Word's table layout (indent, autofit, width, cell widths, rows that may
not split), each cell's spans, insets and vertical alignment, and the cell's paragraphs built as
body paragraphs. The table stands in a paragraph of its own, which takes the Word table
paragraph's style (it aligns the table). Still deferred, and so the document opens by the old
pour: nested tables, pictures in cells, a table poured as text, rows
held at an exact height. The table's id is `Table/docx_t<n>`, not the engine's minted `u<hex>`.

### Slice 4a as built: inline pictures

An inline picture is an anchored frame on its paragraph (`AnchoredFrame`, a rectangle holding the
image, a character of its line at the picture's offset), its crop the frame's inner image
placement. Floating pictures (anchored objects with wrap), pictures with a DrawingML look and text
boxes stay deferred (4b), as do pictures whose frame ids the old path takes from the engine's
mint: a native frame is `docx_img<n>`. A paragraph that holds a picture and no text, under a
paragraph style with character properties (the picture line's pitch), is deferred too: the model
has no paragraph-level character properties and an empty run is not known to carry them.

### Slice 5 as built: fields

A Word field the engine keeps live is one native run carrying `WordField::parse(code)`, its result
the joined text of the field's runs, in the first run's look (what the bundle's `insertField`
makes). A merge field needs nothing native (its text pours as text; the object model reads the
IR). A hyperlink is a text source on the run plus a URL destination and a link in the document's
design map (`skeleton_prefilled` writes them); a hyperlinked field is deferred. Bookmarks (text
anchors) and a table of contents stay deferred.

### Slice 2 amendment: list items

A list item is a paragraph with the engine's list fields (`bullets_list_type`, `bullet_character`,
`numbering_format`) beside its indents; the identity the IR keeps (`numId`, level) is the object
model's, not the model's.

### Slice 2 amendment: drop caps

A Word drop cap (ADR 624) is the paragraph's `drop_cap_characters` and `drop_cap_lines`.

### Save-back

Save-back keeps ADR 602's contract (a byte splice of the edited paragraphs): the ordinal map
(`bindings.rs`) binds a story block and run to a `<w:p>` and `<w:r>` ordinal, and the lowered
style token to the Word `styleId`. Both survive slices 1 to 7 because blocks keep their index.
Direct formatting no longer needs the inverse of a synthesized style (`char_token_to_style_id`
loses its `auto` entries in slice 2). From slice 2 the model can be read back as slide does:
`docx-export/native.rs` extends from stories to the whole model, and save-back diffs the model
against the `NativeBody` built at open, which is the live save-back this ADR is after. The
splice stays the writer; only the source of the edits changes.

### Wasm size

The doc wasm (manifest `maxBytes` 8 MiB; the app budget in `apps/editor/scripts/wasm-budget.mjs`
is 140 MB for the page) already links `paged-model`, `paged-scene` and `paged-store` through
the skeleton. Slice 1 adds one module of plain field assignments and no dependency. The
builder deliberately does not use `paged-mutate` (about 20 000 lines and `paged-vector-fx`,
`paged-geom`, which the doc wasm does not link today); it sets the model's fields itself, and
the comparison test is what keeps it equal to the engine's operations. Each slice states the
measured delta of `docx_js_bg.wasm` in its commit, checked against the manifest ceiling and
`wasm-budget.mjs` in CI. The expected direction is a small growth of the wasm and a larger
shrink of the bundle's TypeScript and of the IR's JSON on the wire.

### Rollback

A slice is a pure addition behind a flag until it is wired. Wired slices (2 on) are selected by
a `docx-js` option; the old pour stays selectable until slice 7. Rolling back is turning the
option off, or reverting the slice's commit: each slice's commit contains its builder, its
wiring and its comparison test, and removes nothing from the old path.

## Evidence

`docx-skeleton/tests/body_native.rs` lowers the conformance fixtures (mixed sizes, paragraph
spacing, line spacing, run specials, symbols, memo, tier 1, breaks, pagination) and, for every
block the builder takes, requires that the paragraph's and each run's resolved properties
equal the IR's (Word style chain plus synthesized style against Word style chain plus the
model's own fields), that the text is equal, and that no synthesized style is named. The
existing `docx-conformance` goldens run unchanged, because the old path is untouched.

## Consequences

Direct formatting lives where Word put it (on the paragraph or the run) rather than in
styles the user never made. Until slice 2 the document is still created by the old path, so
the style panel still shows the synthesized styles: slice 1 proves the mapping, it does not
yet change what the user sees. The comparison test is the only guard that the builder and the
engine's operations agree; a property added to the lowering must be added to both the builder
and the test's path lists, or the block is deferred.

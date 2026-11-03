# ADR 625 — Doc builds the engine's model in Rust; the plugin-local IR retires slice by slice

- **Status:** Accepted 2026-11-02. Slices 1 to 7 implemented, looks, endnotes and breaks included; the prefilled open is ON (2026-11-02); 4b, 6 and 7 and the removal of the IR remain; the rest is a plan.
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

### Slice 2 amendment: the catalogue

The theme, swatches, colour groups and styles of a prefilled skeleton are set on the model by
`docx-skeleton` `catalog`, in the order `buildStyleMutations` sends them. Each style property is
the field the engine's `setStyleProperty` sets, read the way it reads it (`""` clears a text slot,
a count rounds, an enum is parsed by the model's own `from_idml`); a property the model has no
field for (a language, say) refuses the whole catalogue and the document opens by the old pour,
which reports it. The styles the lowering invented for direct formatting (`docx-auto-*`) are left
out when nothing the old path still pours (headers, footers, notes, page items) names them: the
document then holds only the styles Word defined.

**Why not the engine's operations.** The first version applied the catalogue with
`paged_mutate::apply`, which is exact and short. Measured by the wasm build in CI it takes
`docx_js_bg.wasm` from 8,170,515 bytes (7.79 MiB) to 12,939,388 (12.34 MiB): `paged-mutate`, with
`paged-geom` and `paged-vector-fx`. That passes the manifest only by raising `maxBytes` and it
fails the editor package's `dist/` budget (PM-0013 amendment 5: 80.6 MB against 76.5 MB), a public
budget whose rise is "a decision, not a drift". So the catalogue is a port of about fifty field
assignments, kept equal to the engine's by the same comparison tests, and `paged-mutate` stays out
of the doc wasm. Slices 4b, 6 and 7 are therefore ports too (the picture look's translation, the
review records, the notes), or they wait for that budget to be decided.

### The flag is on

`NATIVE_BODY.enabled` is true. What held both paths equal before turning it on, on the final
commit: the Rust comparison over the conformance fixtures (resolved properties, text, tables,
pictures, fields, links, drop caps), the real-engine spec `native-body.spec.ts` (text, page
count, per-paragraph geometry, no invented style, unedited export equal to the old pour's, on
seven fixtures), and the whole headless suite run on natively opened bodies where the body allows it
(editing, review, save-back, structure, object model: green). A document with anything the builder
defers (floating pictures, picture looks, text boxes, comments, tracked changes, notes, bookmarks,
tables of contents, nested tables, breaks inside a paragraph, exact-height rows, headers and
footers are poured but do not block) opens by the old pour, whole.

### Slice 4b (part): floating pictures

A float is the inline picture's anchored frame with the anchored-object setting the host model sets
(`anchoredFloat`: position, anchor point, references, alignments, offsets) and the layout it sends
(`layoutSpec`: wrap mode, offsets, side, contour polygon, behind text, no overlap). Picture looks and
text boxes stay deferred. The spec `native-body.spec.ts` now opens EVERY `.docx` fixture of the bundle
both ways and compares them (text, pages, geometry, unedited export), and requires seven named
fixtures to keep opening natively: the safety net of the default-on open.

### Slice 7 (part): footnotes

A footnote reference is the engine's marker character in a run of its own (unstyled, as the engine
writes it into the unstyled text) and a `Footnote` on the paragraph at the marker's character, its
text the marker, the document's separator (the default tab: the options are set after the pour) and
the note's text. Endnotes (they need the endnote story and range definitions) stay deferred.

### Slice 6: comments and tracked changes

A tracked change is the run's `revision` (insert, delete), its `format_change` (the change and the
run's look before it, built from the style token the lowering names and that style's direct
formatting, not a snapshot of the run now) or the paragraph's `mark_revision` / `props_change`. A
comment is the id on the runs it covers and a `Comment` on the story that holds them (a root whose
range is in the story, its replies after it); the document's change tracking is still switched on by
the bundle once the document stands. Reviewed fields and note references stay deferred. A comment on a table
cell's text is built too: the engine anchors a comment in a cell (`insertComment` with a cell address)
and the thread belongs to the story; the old pour placed none, so this is the one construct where the
native open keeps more than the old pour did.

### Slice 7 (part): bookmarks and tables of contents

A Word bookmark is a `StoryDestination` (text anchor) of the story, at the start of the paragraph it
opens in (the paragraph's index in the story, offset 0); Word's hidden `_GoBack` is none and a name
is kept once, as the engine keeps it. A table of contents is its cached entries, which are ordinary
paragraphs with live `PAGEREF` fields: the pour never read `LoweredDoc::tocs`, so nothing is built
for them.

### Fallback closed: breaks inside a paragraph

A page or column break inside a Word paragraph makes the parts after it paragraphs to the engine
(ADR 028/029): `build_parts` returns one native paragraph per part, the runs, pictures and
footnotes cut at the break's character, each later part in the style the lowering gives its break
(the Word style plus the break's rule). A break inside a field, a tracked paragraph change on a split
paragraph, and a part with other character properties than the first stay deferred.

### Fallbacks closed: nested tables and exact-height rows

A table nested in a cell takes the cell's empty paragraph that stands for it (else a fresh paragraph
at its index), as `insertTable` with a cell address does; a row Word holds at an exact height is
the row's height with `auto_grow` off (`setRowHeight`).

### Slice 7 (part): headers and footers

The story of every master header and footer frame (`LoweredMaster`, ADR 611) is filled in the
prefilled skeleton with the part's paragraphs, built as body paragraphs; the bundle then skips
`pourHeadersFooters`. A bookmark, a note or a comment in a header or footer (the old pour places none
of them as a note or comment) sends the document to the old pour. With no header, footer or body
paragraph left to the old pour, the only thing that still names the lowering's invented styles is a
page item (a float or text box placed on the page), so the catalogue omits them unless the document
has page items.

### Slice 4b (part): text boxes

A text box anchored in a paragraph is an anchored text frame (insets, wrap, the anchored-object
setting) whose story, `docx_tb<n>`, is added to the document with the box's paragraphs; a text box
placed as a page item (ADR 614; the skeleton already wrote its frame) has its story filled like a
master's. The bundle skips `pourPageItems` for a prefilled skeleton, so nothing the old pour still
places names the invented styles and the catalogue always leaves them out. A box with a look (fill,
outline, effects) or holding a bookmark, note or comment stays deferred.

### Fallback closed: paragraphs that cannot carry their character properties

A paragraph style's character properties (the line pitch of a picture's line, a size) are the runs'
own in the model. A paragraph with no text has no run, and a run whose Word character style sets the
same path would be overridden by them. For those two the paragraph keeps the style the lowering made
for it (the old pour's way), and the catalogue includes that style and its invented parents: the only
case in which a prefilled document holds a `docx-auto-p` style. A break in such a paragraph stays
deferred.

### Fallbacks closed: looks, endnotes, a language, breaks in a kept style

All by hand ports; `paged-mutate` stays out of the doc wasm (the editor's `dist/` budget).

- **Picture and text box looks** (`docx-skeleton` `look`): `nativeFxOps` of the lowering kit
  (extensions ADR 347) written onto the `AnchoredFrame` fields in the same order as the engine's
  anchored arms (engine ADR 1045): fill or gradient swatch, outline, opacity, drop and inner
  shadow, glow, soft edge, gradient feather, then the effect stack through the model's own
  `set_stack` (the blur, colour overlay and reflection entries are ported from
  `EffectEntrySpec::to_model`; any other kind defers). Presets are `paged_model::effect_stack::defaults`.
  Colours are `Color/docx-RRGGBB`; a picture in a cell has none minted, so the skeleton makes it;
  gradients are the content-addressed `Gradient/docx-…` swatches the pour made.
- **Endnotes** (`docx-skeleton` `endnote`): buildable without `paged-mutate`; `CreateEndnoteStory`
  and `InsertEndnote` only edit plain model data. A reference is the marker run and an
  `EndnoteReference`; the story is a page appended after the last page (on its master and margins),
  an endnote text frame over its margin box, and the title paragraph holding the ranges in
  reference order. The options are the engine's defaults, as in the pour (set afterwards). An
  endnote in a table cell still defers (the engine orders them by the story's own paragraphs).
- **A style property with no model field**: only `characterLanguage` is emitted by the lowering
  without a field (`CharacterStyleDef` has none, and the engine's `setStyleProperty` refused it on both
  style kinds, so the old pour reported a warning and went on, while the catalogue refused the whole
  document, which includes any file with `w:lang` in its defaults). It is now left out the same way
  and reported through `prefilled_notes` as the same warning. Not applying it on runs keeps the
  native open equal to the old pour (setting the run's language would change hyphenation).
- **Breaks**: a paragraph that keeps its invented style is split into parts that keep their breaks'
  invented styles (with their parents in the catalogue). A break at a paragraph's very end that
  cannot be carried (a table follows, the section ends) or in an empty paragraph leaves the empty
  paragraph after it, as the pour does (the first native version dropped it).

Evidence: `tests/body_native.rs`; `native-body.spec.ts` now also compares each anchored frame's
look and the endnote elements of the exported IDML, old pour against native, on every fixture, and
requires `picture-effects`, `objects-text-boxes`, `objects-languages`, `endnote-body` and
`break-kept-body` to open natively. What still defers: comments in a field, hyperlinked or reviewed
fields, content controls, an endnote in a cell, a table poured as text.

### Amendment: what removing the IR and `mutations.ts` takes (design, not built)

The plan said the IR goes after the last slice. Having built the slices, that is not one step. Three
things hold the IR up, and only one of them is the pour:

1. **The standalone pour** (`mutations.ts` for a document opened as the document). This is what the
   slices replaced: for a document the builder takes whole the pour is not run. What is left for it
   is the fallback (picture looks, endnotes, comments in table cells, a document the catalogue
   refuses). Deleting the pour means closing those four; then `buildStoryBlocks`,
   `buildStyleMutations`, `pourSteps`, `page-items.ts` and `pourHeadersFooters` go, and the open is
   one door.
2. **Embedded placement** (`place.ts`, ADR 603: a `.docx` placed in a frame of a host layout). It
   works on a live host document that already has its own styles, swatches and stories, so it can
   only add to it through the host's mutation door (`insertText`, `applyStyle`, `insertTable`, ...)
   or through a door that takes finished model content. The plugin API has no such door (there is no
   snippet or paragraphs door in `host.ts`). Two ways: (a) a Rust entry returns the placement as a
   `Vec<Mutation>` batch, built from the same builder (tables, pictures, fields and so on become the
   batch's `insertTable`/`insertAnchoredFrame`/... ops), which keeps the wire as it is but is the
   old pour written in Rust; or (b) a new host door, `host.document.insertContent(model)`, taking the
   builder's paragraphs, styles and swatches, with the engine merging the catalogue (id clashes, the
   host's theme). (b) is the cleaner end state and is an engine change, hence a contract bump (a
   plugin-api edit, canary +1) and a wire/engine resync in one commit; (a) needs no engine change.
3. **Save-back.** `docx-export` takes the `LoweredDoc` as the baseline it diffs the edited story
   against (82 uses; `bindings.rs`' ordinal map, `diff.rs`, `overlay.rs`, `review.rs`, `splice.rs`,
   17 000 lines in all). The IR is the Word-side view of the file, not only the input to the pour:
   it holds what a model paragraph does not (Word style ids, `numId`, the original run boundaries,
   `source_index`). Replacing it means a baseline built from `docx-core` plus a model read-back, and
   that is the live save-back this ADR set out for; it is a project of its own.

So `docx-lower` does not emit model paragraphs *instead of* the IR: the builder reads the IR and
that is a sound split (Word semantics in `docx-lower`, the model in `docx-skeleton::body`). The
tractable removal is (1) and, with (a) or (b), (2). The IR stays as the save-back baseline (3), renamed
at the end to what it is.

Cost, in the order I would do it: (1) close the four fallbacks, about four slices of the size of those
already landed (picture looks ~400 lines of field ports and presets; endnotes need the page and frame
`CreateEndnoteStory` makes, ~300 lines; comments in cells need the engine to anchor them first),
then delete the pour and its tests, about a week with the CI cycle this repository has; (2a) a Rust
batch builder for placement, about a week; (2b) the door, about two weeks across engine, contract and
bundle; (3) several weeks and out of scope here. Deleting `mutations.ts` before (2) breaks Insert.

### Amendment: placement by a Rust batch, slices 1 to 5 built

Option (a) above, without a plugin-API change and without the mutation engine in the doc wasm:
`docx-skeleton::place::place_batch` builds the placement from the same `native_body` the
standalone open uses, as JSON of operations the mutation door accepts today. `DocEngine.placeBatch`
returns it, `place.ts` submits it as the one batch (one undo step) in place of the pour. The
document then holds the Word styles; the lowering's invented `docx-auto-*` styles remain only where
the pour has no other way to carry direct formatting (table cells: the cell address of `applyStyle`
takes a style, `setElementProperty` has no cell range).

Built, slice by slice:

1. **Paragraphs and styles.** `insertText`, `applyStyle` (paragraph, character, caret for blank
   lines), `setElementProperty` over the paragraph's or run's range for direct formatting, the
   `create*Style` / `setStyleProperty` catalogue.
2. **Tables.** `insertTable` (grid, header rows, widths, row heights, Word's layout), per cell
   `insertText` and cell-addressed `applyStyle`, insets, vertical alignment, borders and fill,
   `setCellSpan`, exact row heights, nested tables, and the table paragraph's style. The story is
   built in steps as the pour's (`buildStoryBlocks`): text, table, text, with the `insertText`
   offset space (bytes and paragraph breaks) kept apart from the style ranges (contiguous
   characters).
3. **Pictures.** `insertAnchoredFrame` with the float's layout, anchored-object settings and the
   crop's placement, as one nested batch with a handle. A picture look (DrawingML fill, outline,
   effects) is still the pour's.
4. **Fields, lists, hyperlinks, bookmarks, drop caps.** `insertField` (the result is not in the
   inserted text), the list properties of the model, `insertHyperlink`, `insertTextAnchor`, the
   drop cap properties.
5. **Notes and comments.** An inserted document places no footnotes or endnotes (ADR 603: their
   markers are stripped before the batch is built, as the pour's `withoutNotes` does); comments are
   `insertComment` / `replyComment` over the range of the runs that carry them.

A document with anything the builder does not take (tracked changes, content controls, breaks
inside a paragraph, text boxes, a picture look, floating objects placed on the page, a picture or a
comment in a table cell) is refused with the reason before anything is applied, and
`NATIVE_PLACE` / the refusal falls back to the TypeScript pour for the whole document: nothing is
half placed. `test/headless/place-batch.spec.ts` places the same fixtures both ways into an empty
document on the real engine and compares text, page count and every paragraph's geometry, checks
that the batch offered is the batch applied, that no `docx-auto` style exists where the builder
needs none, and that one undo leaves the placed story empty.

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

# Status

What the engine ships and what it does not, read from the code of the protocol-72 batch
(`PROTOCOL_VERSION` 72: generated text, editorial notes and bookmarks over the wire — Generate
Index, Update Cross-References, notes, bookmark editing and PDF bookmarks — on top of protocol
71, the object model: one address grammar and typed property schemas). This page stays
at the level of the engine and its surfaces; it does not list which document constructs are
rendered. How the parts fit is in [`architecture.md`](architecture.md).

## Shipped

- **Templates.** A document's policy in labels makes it a template (ADR 1000): fields of every
  kind, permissions checked for a filler at every door (ADR 1001), fields from XML tags and tags
  written back (ADR 1002), text fields written in the character styles and with the breaks
  their author allows, and alternates that show one of several frames (ADR 1017). `paged
template fields | fill | check` run the same messages headlessly.
- **Two engine npm packages per release tag** (PM-0008, amendment 3). `@paged-media/paged`
  (`packages/paged`: the files of the private workspace package `canvas-wasm`, with the
  `./introspect` and `./repo` entries, and the `paged` bin, `paged mcp` included) and
  `@paged-media/viewer` (with the `./session` entry), built and published by
  `.github/workflows/release.yml` together with `@paged-media/plugin-sdk` (the contract as
  its `./api`).
- **Word's first-fit composer** ([ADR 1016](adr/1016-word-first-fit-composer.md)).
  `paragraphComposer = "Word First-fit"` sets a paragraph one line at a time the way Word
  does: no compressed justified line, Word's hyphenation zone (0.25 in by default, no hyphen
  limit), a hyphen in the text as an ordinary break, and a word wider than the measure split
  on a line of its own. The doc module selects it for every Word paragraph; IDML documents
  keep their composers. Word's own answer to the probe (`first_fit_docx()`) is not committed
  yet.
- **Open and create.** `LoadDocument` opens an `.idml` package or a `.paged` container;
  `NewBlankDocument` and `paged new` make an empty document.
- **Render.** One display list per page, drawn on the CPU with `vello_cpu` (`paged render`,
  editor snapshots without WebGPU) or with Vello on WebGPU (`presentFrame` and editor snapshots
  in the editor wasm, `ViewerSession` in the viewer; [ADR 188](adr/188-snapshots-draw-on-the-worker-gpu.md)),
  from one mapping ([ADR 189](adr/189-one-rendering-model.md)). The mapping applies stroke
  adjustment as Acrobat and poppler do (edges along the axes on pixel boundaries) and flattens
  filled curves to 0.1 device px, the same for both lanes; all 101 InDesign fidelity fixtures
  pass on it.
- **Placed SVGs with their filters.** `usvg` parses a placed SVG and the engine draws it on
  `vello_cpu` when the document is built, all seventeen filter primitives included, so both
  lanes and the PDF export draw the same pixels. Eighteen fixtures hold it to the `resvg`
  renders it replaced (`paged-gpu/tests/it/svg_reference.rs`) and the GPU lane to the CPU lane
  (`svg-filters`; [ADR 190](adr/190-a-placed-svg-draws-its-filters.md)). An SVG without filters,
  masks or patterns is drawn as vectors: its paths, strokes, gradients, clips and groups go
  into the display list under the placement, so it stays sharp at every zoom and in the PDF
  export (`svg-vectors`; ADR 190, amendment of 2026-10-20).
- **Edit.** 137 mutation operations over the wire, batches that are atomic and cost one
  rebuild and one undo step, undo and redo, and engine-minted ids reported in the reply.
- **Locks and deletes follow InDesign.** A locked item, and the content of a locked container,
  is not moved, resized, reshaped, restacked or deleted: the operation is refused with
  `OperationError::Locked`, and a gesture on it fails at `beginGesture`. Its attributes and its
  text still change, and unlocking it is an ordinary property write. Deleting a container deletes
  what is pasted into it, and a group goes with its last member. One undo restores either
  ([ADR 133](adr/133-locks-and-deletes-follow-indesign.md)).
- **What a committed change reports.** A frame resized by its handles reports the content-box
  reflow its `resizeFrame` would (`GestureCommitted.reflow`); a script reports how many writes it
  committed and the pages they changed (`ScriptResult.writes` / `page_ids`); a page reports its
  origin in its spread and its spread (`PageSummary.page_origin` / `spread_id`); a table reports
  its header and footer bands (`tableHeaderRowCount` / `tableFooterRowCount`, read-only)
  ([ADR 159](adr/159-what-a-committed-change-reports.md), `v0.71.13`, additive on protocol 71).
- **Page and margin reads.** A spread names its pages and its top-level items, each with the
  page it sits on by the rule `elementGeometry` applies, the page holding the centre of its
  transformed box (`SpreadSummary.page_ids` / `members`); a page reports its place in its spread,
  the side its spine is on by the renderer's binding rule, and its inside and outside margins
  beside the physical four (`PageSummary.index_in_spread` / `binding_edge` /
  `margin_inside_pt` / `margin_outside_pt`). Additive serde-default fields, no protocol bump;
  the editor's Align to page / margins / spread reads them
  (`paged-canvas/tests/it/spread_membership_reads.rs`).
- **Interaction.** Hit testing, element and text selection, caret and selection geometry,
  gestures (rotate, scale and shear
  about a given point) and snapping, as message kinds. Snapping is one engine resolver
  ([ADR 125](adr/125-snapping-lives-in-the-engine.md)): `requestSnapPoint` and the move, resize
  and path-edit gestures snap to every visible element's points and outlines, the page, ruler
  guides, the grid and the lines through those points, under `setSnapSettings`.
- **Plugin fields and labels.** Placeholder fields are placed at a story offset or at the caret
  (`insertField.contentOffset`). Text typed at a field's edge lands beside it. A
  document-scoped, undoable plugin label is written with `setDocumentMetadata` and read in
  `DocumentMeta` ([ADR 127](adr/127-fields-and-document-labels-for-data.md), protocol 69); the
  IDML adapter carries it as the designmap `<Document>`'s label.
- **A drop shadow on every shape.** The `frameDropShadow*` paths apply to text frames,
  rectangles, ovals, polygons and lines (a line's shadow is cast by its stroke), and IDML carries
  them ([ADR 130](adr/130-plugin-faces-shadows-and-batch-handles.md), protocol 70).
- **Pages in a batch.** `bindCreated` names a page that `insertPage` or `duplicatePage` minted, so
  pages and their content are one batch and one undo step. Every batch lane reports each mint's
  handle in `minted[].handle` ([ADR 130](adr/130-plugin-faces-shadows-and-batch-handles.md)), and the
  reply names every page a mutation created, in creation order (`createdPages`,
  [ADR 186](adr/186-a-mutation-names-the-pages-it-created.md)). A duplicated page owns copies of its
  stories, including their hyperlink sources, and keeps its margins. An inserted page takes its
  master's margins. `duplicateElements` copies a story that holds hyperlink sources
  ([ADR 128](adr/128-pages-a-merge-can-make.md), protocol 69).
- **Pages and masters for presentations.** `movePage` reorders pages. A page carries plugin
  labels that travel with it (`setPageMetadata`), and a text range links to a page
  (`insertHyperlink.page`). A snapshot can leave items out (`requestSnapshot.hideItems`).
  `onMaster` edits a master's items with the ordinary mutations, and `createMaster`,
  `deleteMaster` and `renameMaster` make, remove and name masters. A radial gradient is centred
  at its `GradientFillStart`, and a cell edge draws in its stroke style (a double border as two
  rules) ([ADR 129](adr/129-pages-and-masters-for-presentations.md), protocol 70).
- **Footnotes and hyperlinks edited over the wire.** `insertFootnote` and `deleteFootnote` add
  and remove a note and its reference, and a text delete over a reference takes its note
  ([ADR 163](adr/163-footnotes-inserted-and-deleted.md)). `deleteHyperlink` and `editHyperlink`
  address any link, an InDesign document's own included, by its id; an edited link keeps its
  appearance through a save ([ADR 164](adr/164-hyperlinks-deleted-and-edited.md), `v0.71.13`).
- **Update Table of Contents.** A TOC story prints what it holds, as InDesign does; an empty one
  prints nothing. `updateTableOfContents` rewrites it over the current layout as InDesign writes
  one: the title, then each heading with its page number after or before it in its own character
  style. TOC styles read in InDesign's spelling ([ADR 165](adr/165-update-table-of-contents.md),
  `v0.71.13`). The hidden links and bookmarks InDesign adds to the entries are not written yet.
- **Generate Index.** `generateIndex` writes the document's index into a story as InDesign writes
  one: the title, a heading per letter, each topic with its pages and See references, subtopics at
  level 2, and creates the index styles a document lacks. Topics, page references and
  `IndexOptions` read in InDesign's spelling ([ADR 168](adr/168-generate-index.md), protocol 72).
  Run-in format, page ranges and levels 3 and 4 are not written yet.
- **Cross-references.** A reference prints its destination's page live, as InDesign does, and
  `updateCrossReferences` rewrites its text from its format (full paragraph with its list number,
  paragraph text, number, anchor name) as InDesign writes it. Formats, sources and paragraph
  destinations read in InDesign's spelling ([ADR 169](adr/169-update-cross-references.md)).
- **Endnotes and PDF bookmarks.** Endnote references and the endnote story's numbers print as
  InDesign numbers them, and its endnote frame is placed ([ADR 170](adr/170-endnotes-as-indesign-writes-them.md));
  `insertEndnote`, `deleteEndnote` and `convertFootnoteToEndnote` edit them as InDesign does, the
  first making the endnote story on a page of its own, and they save as InDesign reads them back
  ([ADR 174](adr/174-endnotes-inserted-and-deleted.md), protocol 73). PDF export writes the
  document's bookmarks as a nested outline when asked
  ([ADR 171](adr/171-pdf-bookmarks.md)).
- **Editorial notes.** A `<Note>` is read as InDesign keeps it, one character of the text that
  prints nothing, with its text, author and dates (`documentCollection:notes`); `insertNote`,
  `editNote`, `deleteNote` and `convertNoteToText` edit them, and they save as IDML
  ([ADR 172](adr/172-editorial-notes.md)).
- **Bookmarks edited.** `createBookmark` (to a page through a page destination of its own, or to
  a destination), `renameBookmark`, `moveBookmark` (nesting and order) and `deleteBookmark` (with
  its children and the page destinations nothing else goes to) edit the tree as InDesign does,
  and it saves as InDesign reads it back ([ADR 173](adr/173-bookmarks-edited.md)).
- **Tracked changes.** A tracked deletion is kept as InDesign keeps it, a character of the text
  that prints nothing, with its author, date and deleted text (`documentCollection:trackedChanges`),
  and it saves as it was read; `acceptTrackedChange` and `rejectTrackedChange` resolve it as
  InDesign does, the text staying deleted or coming back ([ADR 184](adr/184-tracked-changes.md),
  protocol 74). An edit in a story with a tracked insertion keeps the insertion wrapped.
  Insertions are not listed or resolved yet, and typing does not record changes.
- **One object model.** Every object has an address (`doc`, `page:#2`, `swatch:Color/Red`,
  `style:object/<id>`, `cell:<table>/0,1`, `textVariable:<id>`, …) and selectors find them
  (`page:#3 > frame[name="price"]`, `RequestQuery`, `paged.query`, `paged query`)
  ([ADR 131](adr/131-one-address-grammar-and-selectors.md)). Every property has a typed schema
  in the catalog's `propertySchemas`, and one `set` writes any of them by (address, path, value)
  through the operation that already owns it, with `RequestGet` as its read twin —
  `paged.set`/`paged.get`, `paged set`/`paged get`
  ([ADR 132](adr/132-typed-property-schemas-and-virtual-paths.md), protocol 71). Object, cell
  and table styles, page margins and columns, document bleed and slug, text-variable
  definitions, effects on lines and item names became settable; a custom text variable can be
  created and instanced in text, and one `set` switches every instance. A swatch is
  addressed by its id or its name. A `set` is always one undo step, colour settings and the
  other application state included. `null` clears a nullable row (text, enum or reference)
  exactly as `""` does. A cell reads its `text` (its paragraphs joined by `\n`, the stream a
  cell-addressed `insertText` writes), as a story does, and its `paragraphs` (each
  paragraph's style and runs with their text, character style and direct formatting, the
  story-content read's shape, as JSON text), read-only. A read tells a mixed value (`mixed: true`, a range whose runs
  disagree) from a refusal, which carries a code (`noSuchPath`, `notFound`, `badAddress`,
  `noDocument`). A frame's image content (`imageBytes`), its thread links
  (`nextTextFrame`, `previousTextFrame`), its opacity mask (`opacityMask`) and its path points
  (`points[i].anchor`, `.left`, `.right`, `.curveType`) are rows too, so a binding can write
  them; `null` unlinks, releases or clears.
- **Every operation on the command line.** `paged invoke <doc> <op> [args]` applies any
  operation the catalog lists with its wire arguments (inline JSON, a file, or stdin), and
  `paged ops` lists them. The vocabulary is the catalog's, so a new op is a verb without a CLI
  change; only `bindCreated` (legal only inside a batch) is not invoked on its own.
- **Read.** Document collections, element properties, the scene tree (each item with its
  plugin metadata), layers, frame chains, story content, a text frame's glyphs as outlines,
  colour previews and ink coverage as message kinds; most also in `paged read`.
- **Page growth.** A story with a grow rule (`setFlowGrowRule`) gets generated pages until
  it fits or reaches its page cap.
- **Scripting.** `ExecuteScript` and `paged script` run JavaScript against the document
  under a budget. Every operation but one (`BindCreated`, legal only inside a batch) has a
  `paged.*` function; `paged.batch` accepts raw operations. With `ExecuteScript.hostObjects`
  a script reaches plugin objects (`plugin:` addresses): it suspends with
  `RequestHostObjects`, the host answers with `HostObjectsResult`, and the script resumes
  (`await` works; the Boa clock is wasm-safe). Its writes undo as one step that holds only
  the script's own records and the host commits it reports in `committed`. Typed commands
  (`core.<op>` and plugin commands) are reached the same way: `paged.invoke(id, args)`,
  `paged.commands(owner?)`, and `{ op: "invoke" }` ops in an object `paged.batch`.
- **Export.** IDML (with a list of what the format could not carry), `.paged`, and PDF
  through an export session; `paged export --format idml|paged|pdf`.
- **Container parts and plugin content.** Read, list, write and delete parts under
  `paged/` (`paged parts`); scene layers, pixel layers and pulled image tiles drawn inside a frame.
  A scene layer's text run draws in the face it names, resolved through the registered fonts;
  a family that does not resolve draws in the default font and is reported per frame
  ([ADR 126](adr/126-scene-text-in-its-own-face.md), protocol 68).
  A face registered with `scope: "sceneLayer"` serves scene-layer text only and never the
  document's layout, missing-font report or substitution trace
  ([ADR 130](adr/130-plugin-faces-shadows-and-batch-handles.md), protocol 70).
- **Viewer.** `ViewerSession` (load, layout, present, RGBA readback) and the TypeScript
  wrapper with camera, input and events.
- **Command line.** `paged` with sixteen top-level subcommands, the line-delimited JSON
  session (`paged session`, `paged-run`), and the binaries `paged-inspect`, `paged-diff`,
  `paged-gen` and `paged-export`.
- **Capability catalog.** `paged describe`, `describeCatalog()` and the committed
  `crates/paged-introspect/catalog.json`: 161 host functions, 221 settable paths, 403
  property schemas, 130 operations, and the 30 address forms of `idGrammar`. 355 of the
  schema rows name the IDML element and attribute their value is read from (`idml`).
- **Nested styles and OpenType as InDesign sets them** ([ADR 134](adr/134-nested-styles-and-opentype-as-indesign-sets-them.md)).
  Nested styles read from InDesign's `<AllNestedStyles>` lists on a style or a range, cascade
  through `EmptyNestedStyles`, layer under a hand-applied character style, and range by the rules
  InDesign 20.0.1 answered (through and up to, words, sentences, repeat, a drop cap's style). A
  paragraph style carries `Ligatures`, `KerningMethod` and the `OTF*` toggles; the OpenType
  positions are the font's `sups` / `subs` / `numr` / `dnom` glyphs; All Caps asks for `case`
  and `cpsp`; historical forms and stylistic alternates shape.
- **Text wrap as InDesign sets it** ([ADR 139](adr/139-jump-object-and-next-column-wraps.md)).
  Bounding-box and contour wraps narrow the lines beside them, and those lines break by minimum
  raggedness, squeezing word spaces to keep a word. A jump-object wrap leaves its rows empty and
  text resumes below it on the leading grid; at a next-column wrap the rest of the story moves to
  the next frame. A contour wrap is written `Contour`, the value InDesign reads.
  Text stands on the side the wrap names (left, right, the larger area, towards or away from the
  spine), a contour wrap follows the item's outline grown by its offset and stroke, a frame's
  `IgnoreWrap` is honoured, and a master item's wrap acts on the pages that show it unless it
  applies to the master only ([ADR 151](adr/151-which-side-text-wraps-to.md)).
- **Line breaks as InDesign's Paragraph Composer sets them** ([ADR 141](adr/141-a-line-may-overrun-its-measure-by-a-sliver.md),
  [ADR 142](adr/142-ragged-text-breaks-by-minimum-raggedness.md)). Ragged text breaks by minimum
  raggedness in every frame; a line keeps its last word while it overruns its measure by about a
  99th of that word, and the overrun comes out of the word spaces. Justified text prices a line
  that shrinks past the minimum word spacing instead of forbidding it, and stretches as far as it
  must ([ADR 144](adr/144-justified-text-prices-over-shrunk-lines.md)): 99 of 160 probed
  paragraphs set every line as InDesign does. A drop cap spans the paragraph's leading at the
  face's cap height. 46 of the 73 generator fixtures set every line as InDesign does.
- **Align to baseline grid** ([ADR 140](adr/140-align-to-baseline-grid.md)). A paragraph aligned
  to the grid stands each line on the first grid line at or below it, on the document's grid or its
  frame's own, first line only where it says so; every baseline of the two grid fixtures matches
  InDesign's to 0.001 pt.
- **Positions are exact sums** ([ADR 138](adr/138-positions-are-exact-sums.md)). Baselines and
  glyph advances are summed exactly and rounded once, so a 14.4 pt leading or a 12 pt Open Sans
  line does not drift off InDesign's positions down a page or along a line.
- **Condition sets as InDesign records them.** A set keeps each condition's recorded visibility;
  applying it restores the listed conditions and leaves the others as they are. Bleed and slug
  set in paged reach an IDML save, with a `DocumentPreference` added to a package that had none.
- **Word's paragraph, character and list model** ([ADR 1018](adr/1018-word-paragraph-character-and-list-model.md)).
  Runs and styles carry highlight (a band behind the glyphs), hidden text (no room unless the
  document's `showHiddenText` is on), Word's underline kinds and an underline colour, and
  double strikethrough; a paragraph carries its own shading and border over its style's. A
  numbering list may carry Word's nine level definitions (format, `%1.%2.` text, start,
  restart, indents, bullet and its font), laid over the paragraph's list cascade. Twelve
  property paths set them; `setListLevel`, `restartNumbering` and `setStyleBasedOn` (cycles
  refused) edit lists and styles; Enter at a paragraph's end applies the style's Next Style.
  IDML carries the underline kind and colour, double strike and direct shading / border;
  highlight is written as InDesign's highlight underline, hidden text and list levels only in
  the `.paged` model.
- **Find and replace** ([ADR 1021](adr/1021-find-and-replace.md)). Literal, Word wildcards or
  ECMAScript regex (on the `regress` engine Boa already links), match case, whole word, Word's
  `^p` `^t` `^l` `^m` `^?` `^#`, style filters; hits in caret and character offsets with
  context (`RequestFindText`, `paged.find`); `findReplace` replaces one hit or all of them as
  one undo step.
- **Word document structure** ([ADR 1022](adr/1022-word-document-structure.md)). A growing
  story's rule names a Word section's first / odd / even masters (parity by page number) and an
  odd- or even-page start, which puts a blank page in front when it lands wrong;
  `PageSummary.appliedMaster` says which master a page shows. Runs may be Word fields (`DATE`,
  `TIME`, `NUMPAGES`, `SECTIONPAGES`, `PAGE`, `REF`, `PAGEREF`, `SEQ`, `STYLEREF`, and opaque
  ones shown as their result): the page-dependent kinds print the current layout's answer,
  `updateFields` is Word's F9 (one undo step), `documentShowFieldCodes` prints the codes.
  `insertTextAnchor` / `deleteTextAnchor` (Word's bookmarks; text edits keep them in place),
  `insertCrossReference`, `insertTableOfContents` (a table inside the text, updated in place by
  `updateTableOfContents`) and `insertIndexMarker`. IDML writes fields as InDesign's variables
  where one exists, else as their result.
- **Word's review** ([ADR 1040](adr/1040-word-change-tracking.md),
  [ADR 1020](adr/1020-range-comments-with-threads.md)). Tracked insertions, deletions,
  formatting and paragraph changes and inserted or deleted paragraph marks are carried by the
  runs and paragraphs they changed (`recordChange` for importers). While
  `documentTrackChanges` is on, typing, deleting and range formatting record changes (your own
  insertion deleted goes outright); `acceptChange` / `rejectChange` resolve one, an author's
  or all, as each other's opposite (proptest), one undo step each. `documentMarkupView` shows
  All Markup (author colours), Simple / No Markup or Original. Range comments with threads:
  `insertComment`, `replyComment`, `resolveComment`, `deleteComment`, `editComment`, the
  `comments` collection; the story read names every change and comment.
- **Fidelity tooling.** The fixture generator (67 samples), the image-diff tool, 66
  reference PDFs with thresholds (`docx-pagination` has none and is not gated), and the
  scripts that drive InDesign to export them.

## Limits of what is shipped

- **WebGPU is required in the browser.** The viewer rejects when `navigator.gpu` is absent
  and has no CPU page rasteriser. In the editor wasm `presentFrame` returns `false` without a
  GPU surface or after a device loss; `recoverGpu` asks for a new device, and the editor
  falls back to the CPU when none is granted (ADR 188).
- **The CPU rasterizer is single-threaded**, natively too (ADR 189: `vello_cpu`'s threads
  cost more than they save on effect-heavy and sparse pages). Without the glyph-run table (the
  live canvas does not collect it) a glyph that is exactly a rectangle is stroke-adjusted like
  a shape.
- **A placed SVG is a raster at one pixel per user unit**, decoded once, so it is scaled up at
  higher zoom and print resolutions rather than drawn as vectors, and its text is not drawn
  (`usvg` is built without fonts). Raster images inside an SVG are not decoded (ADR 190).
- **No font and no colour profile is bundled.** Text for which neither a registered font
  nor a default font resolves is not shaped. Without a CMYK profile, CMYK is converted by a
  naive formula.
- **Word additions not yet everywhere** (ADRs 1018, 1021). Level-2+ list counts do not continue
  across stories; tables and notes draw no underline kinds or highlight; a changed `BasedOn` of
  a style from the source package is not re-spelt in its IDML `<Properties>`; find does not
  search table cells or notes. Word fields other than the nine kinds are opaque; a bookmark is
  a point; a TOC style made by `insertTableOfContents`, new text destinations and index topics
  reach the `.paged` model, not IDML; no continuous section breaks (ADR 1022).
- **Review limits** (ADRs 1040, 1020). Changes and comments in table cells are kept and
  resolved but not listed; Simple Markup draws no change bar and a deleted paragraph mark
  still breaks the line; Word's changes and comments reach the `.paged` model, not IDML.
- **A commit rebuilds the whole document.** Caches make unchanged paragraphs and stories
  cheap, and only a build of text edits in one story reuses previous pages.
- **Two mutation lanes.** Text edits have no `Operation` form; they use `TextOp` in
  `paged-canvas`. Undo keeps the newest 10,000 steps; a batch is one step at any size and in
  either lane.
- **The command line sends 42 of the 75 message kinds.** The rest are listed with a reason
  each in `crates/paged-cli/tests/it/cli_surface.rs`; half of them (15 of 33) need a pointer or a caret.
- **The Vello path is held to the CPU path, with known gaps.** `corpus/generated/parity-diff.sh`
  renders every generated fixture through both and budgets each in
  `corpus/generated/parity-thresholds.json` ([ADR 146](adr/146-the-gpu-lane-is-held-to-the-cpu-lane.md)).
  Both lanes are Vello: 97 of 101 fixtures measure under 0.05. Ink separations and coverage are CPU only. A knockout group, and a non-isolated group below
  100 % opacity whose members use blend modes, are drawn as isolated groups. The blur of a
  `PushLayer` is a multi-tap approximation of the CPU's Gaussian.
- **The viewer reads IDML parts only.** `ViewerSession::load` calls the IDML importer and
  does not read the native model part of a `.paged` container. It has no write surface.
- **A `.paged` save carries the document twice**: the IDML parts and the model part, which
  is one JSON document (`crates/paged-canvas/src/model.rs:5126-5129`). A model part with
  another format version is ignored on load, and the IDML parts are parsed instead.
- **Hash and diamond stroke styles draw their marks with the default cap and join, and no gap
  colour.** The marks are laid out along the path as InDesign lays them out
  ([ADR 150](adr/150-hashes-and-diamonds-are-marks-along-the-path.md)); a frame's own `EndCap` /
  `EndJoin` and a gap colour under them are not measured yet.
- **Paragraph line setting: the pyramid and vee shapes, and an overset no-break span.** Auto
  leading, single-word justification, the last line's indent, `FullyBalanced` ragged lines and
  no-break text are set as InDesign sets them, saved, and editable through five property paths
  ([ADR 153](adr/153-a-paragraphs-line-setting.md)). `PyramidShape` and `VeeShape` balance as
  ragged text. A no-break span wider than its line is set squeezed, where InDesign oversets the
  rest of the story.
- **Line and GREP styles are read and kept, not applied.** `<AllLineStyles>` and
  `<AllGREPStyles>` reach the model and the IDML export; the renderer sets no line or GREP style.
  End Nested Style Here (`<?ACE 3?>`) is not kept by the story reader, so a nested style that
  ends there runs on to its other limits.
- **An inverted text wrap wraps round its obstacle.** InDesign sets the band's text inside the
  shape; the composer cannot leave a row empty in mid-frame, which that needs
  ([ADR 151](adr/151-which-side-text-wraps-to.md)). A contour from an image uses the frame's path,
  and an object style's `IgnoreWrap` is not read.
- **A placed PDF is drawn from its own operations, with gaps.** Paths, clips, groups, images
  and glyph outlines reach the display list
  ([ADR 154](adr/154-a-placed-pdf-is-drawn-from-its-own-operations.md)). Colours come through
  the interpreter's RGB conversion, not the document's CMYK profile. Patterns and shadings
  paint mid-grey, and a group's soft mask is ignored.
  Stencil images and Type 3 glyphs are skipped. The first page is drawn whatever `PageNumber`
  says. EPS draws nothing.
- **Column rules: no vertical justification, object styles or spans.** A frame's rules stand
  and run as InDesign draws them ([ADR 155](adr/155-column-rules.md)). The rule's end ignores
  vertical justification, an object style's rules are not read, span and split regions draw
  none, and no property path writes them.
- **Multi-level lists within one story, levels set by paragraph or style.** Levels 1 to 9
  number, restart and print `^1` … `^9` as InDesign does
  ([ADR 158](adr/158-how-indesign-numbers-a-multi-level-list.md)), and
  `paragraphNumberingLevel` / `paragraphNumberingApplyRestartPolicy` set them. A level above 1
  does not continue across stories or documents, the restart policy is read and written but no
  path sets it, and `editNumberingList` takes no per-level fields.
- **A footnote reference that overflows into a new restart scope keeps its composed number.**
  Notes are numbered through each story, restarted by page, spread or section, with their prefix
  and suffix, as InDesign numbers them ([ADR 156](adr/156-how-indesign-numbers-footnotes.md)). A
  reference is labelled when its paragraph is composed, so one whose line then moves to a page
  that restarts the numbering keeps the earlier number. Notes stand under each column or span
  the frame as InDesign sets them ([ADR 160](adr/160-footnotes-in-columns.md)); a note too
  tall for the room under its reference continues in the next column or frame under the
  continuing rule, or moves its reference line on with `NoSplitting`
  ([ADR 161](adr/161-a-note-too-tall-for-its-frame.md)). End-of-story placement is not read, and
  an overset area does not grow its frame.
- **Page numbers in the Roman edition's thirteen styles only.** Sections, chapters and footnotes
  format numbers in every style InDesign 20.0.1's Roman edition offers, as it labels them
  ([ADR 157](adr/157-every-page-numbering-style.md)). Styles only other editions offer
  (full-width, Hindi, Thai, Farsi) fall back to Arabic, and no rendered fixture covers the
  Hebrew and Arabic styles: the corpus ships no face with those scripts.
- **An unresolved table of contents built at render numbers its entries from each story's head
  frame.** A story with no text bound to a TOC style (on its `<Story>` or its frame) is filled from
  the TOC style while the page is built, before layout says where a heading lands. The canvas's
  TOC list and `Document::resolve_toc_on` / `resolve_index_on` take the page a paragraph was laid
  out on.
- **A host that does not send `HostObjectsResult.committed`** gets its plugin write as an
  undo step of its own, separate from the script's core writes.
- **An edit made while a script waits splits the script's undo step.** The fold merges only
  the script's own CONSECUTIVE records (and the host commits it reports). When a UI edit is
  logged during a host wait, the script's writes made before it stay one undo step and its
  writes after it another, with the UI edit between them: undoing the whole script then takes
  two steps, and undoing once takes back only the later part. Folding across the foreign
  record would swallow the UI edit into the script's step, which is worse.
- **A layer's lock is enforced by hit testing only.** A mutation addressed to an item on a locked
  layer applies; only the item's own lock, or its container's, is refused by the engine.
- **Script wall-clock limits are checked at host-function calls**, not inside a loop that
  makes none; such a loop is bounded by the iteration limit.
- **The fidelity gate needs the reference colour profile.** On a runner without a FOGRA39
  profile a failing fixture ends the run "inconclusive" (exit 3), which the workflow reports
  as a warning (`.github/workflows/fidelity.yml:98-121`). In the PDF export-diff gate three fixtures
  (`effects`, `footnotes`, `swatches`) are advisory.
- **The size gate measures a stand-in.** `spikes/wasm-size` links the viewer crate and
  wgpu 22; the size of the published viewer wasm is printed at release, not enforced.

## Releases

Protocol 71 shipped as `v0.71.0` through `v0.71.13`; the fields of
[ADR 159](adr/159-what-a-committed-change-reports.md) are additive and arrive in `v0.71.13`.
The release order when core and the IDML adapter pin each other is in
[`reference/protocol-governance.md`](reference/protocol-governance.md).

## Not built

- A retained layout tree or demand-driven recomputation. Every build is the whole-document
  build with caller-owned caches ([ADR 107](adr/107-whole-document-build.md)); no manifest
  depends on `salsa`, which `crates/paged-canvas/src/lib.rs` still names as a later phase.
- Rendering a document from the composition model. `paged-composition` is derived from the
  scene, the function that stores it as a part is called only by tests, and
  `paged-composition-render` (single page, page-relative positions) has no dependents.
- `TextFlow`, the region-chain form of story layout, as the live path: per
  `crates/paged-renderer/src/flow.rs:31-33` it does not replace `StoryEmitter`.
- A shared GPU device or texture for plugins
  ([ADR 018](adr/018-stage-b-gpu-texture-defer-record-only.md)).
- A CPU or WebGL fallback in the viewer, and any editing in it.
- A raw-JSON subcommand on the command line; `paged session` is the general door.
- A digest comparison between the browser wasm and the native build; the equivalence test
  runs natively (`crates/paged-sdk/tests/it/digest_equivalence.rs:24-26`).
- A bundled typeface or ICC profile; crates on a Rust registry (`publish = false`).

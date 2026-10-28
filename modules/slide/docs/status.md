# paged.slide — status

Read from the code on 2026-10-28.

## Built

- **Package reading.** `pptx-import` reads a `.pptx` into the `pptx-core` IR: slide size, slides in
  order, slide masters with their text styles and colour map, layouts, themes, shapes (shapes,
  pictures, groups, connectors, tables, chart and SmartArt references), text, backgrounds, speaker
  notes, transitions (with their original XML), animation timing (verbatim), sections, embedded font
  references, and every chart part (`chart::Chart`: plots, series with their cached values, axes,
  title, legend, data labels).
- **Inheritance** (`slide-resolve`, ADR 702). Theme → master → layout → slide, placeholders by
  `idx` then type (pictures included), list-level chains, theme fonts, colour transforms, style
  references, group spaces and `grpFill`, gradients (sorted stops, per-stop alpha), translucent
  paints as item opacity.
- **Geometry** (`platform/shared/dml-geom`, `slide-geom` here; ADR 717). All 187 ECMA-376 preset
  shapes and custom geometry, as Bézier outlines, with their 243 adjust handles and their
  connection sites.
- **Live presets and connectors** (ADR 717). A preset shape keeps its preset, adjust values, flips
  and box in its label. Resized in the editor, it is drawn again for its new box (a rounded
  rectangle keeps its corner radius), with its detail element and text frame. A connector glued
  to two shapes (`a:stCxn` / `a:endCxn`) is routed again when one of them moves. Both are written
  in the edit's undo step. The selected preset shows its yellow adjust handles; a drag changes
  the adjust values (one undo step). Insert ▸ Shapes opens a Shapes panel with every preset, and
  the typed command `media.paged.slide.insertShape` inserts one; either way the shape is a live
  preset. Export writes a live preset as `a:prstGeom` with its `a:avLst`.
- **Charts** (`slide-chart`). Clustered, stacked and percent bars in both directions, lines
  (smoothed), areas, pies and doughnuts, gridlines, axis lines, tick and data labels, legends;
  Excel's automatic value scale; Office's default chart-style paints. Drawn as groups of native
  shapes.
- **Live charts** (ADR 715; `slide-sheet`, `charts.ts`). Each chart's workbook is paged.sheet's,
  linked into the slide wasm: the embedded workbook (`c:externalData`) read by `sheet-xlsx`, or
  one made from the chart's cached values in PowerPoint's sheet layout, the series bound to the
  cells by their formulas, formulas calculated by `sheet-calc`. Kept per chart as a container
  part. Double-click a chart (twice: group, then chart) to edit its data in the chart data
  sheet (the `slideChart` context's frame surface: the bound cells tinted, sheet tabs, full
  screen); leaving redraws every frame of the chart in one undo step, where the frame stands now.
  `slide-chart` draws the 2-D bar, line, area, pie and doughnut charts from the live values;
  paged.sheet's chart engine draws every other kind (scatter, bubble, radar, stock, surface,
  3-D, the Office 2016 kinds). Export writes an edited chart's part (caches from the cells) and
  its workbook; a made workbook becomes the chart's embedded one. Untouched charts keep their
  bytes. The slide wasm is 4.94 MiB with the sheet engine (+2.1 MB).
- **Tables and table styles.** All 74 built-in table styles (eleven families, plain or per
  accent) and a deck's own styles, resolved cell by cell in PowerPoint's layer order and written
  as native table styles (region cell styles, alternating fills) with local values only where
  the native cascade differs. A table without a known style is drawn as No Style, Table Grid.
- **SmartArt.** Each diagram's drawing (the shapes PowerPoint laid out) becomes a group of
  native shapes; text boxes and style text colours as PowerPoint draws them.
- **SmartArt text pane** (ADR 717, amendment 2026-10-28). Import reads each diagram's data
  model: its text points by level and which drawing shape shows which. The Text Pane
  (Slide ▸ SmartArt text pane) lists the selected diagram's points. An edit writes the point's
  text into every shape that shows it, keeping its formatting, in one undo step. Typed commands
  read and set a point's text. Export writes the text back to new data and drawing parts of
  the slide. There is no layout engine: points are edited, not added or removed.
- **Pictures in every format** (ADR 717, amendment 2026-10-28). Insert ▸ Pictures… places a
  PNG, JPEG, GIF, BMP, TIFF, WebP, SVG, ICO, PSD, TGA, QOI, AVIF, JPEG XL, HDR, EXR, DNG or EPS
  file at its own size on the active slide (one undo step; typed command `insertPicture`).
  Export writes PNG, JPEG, GIF, BMP and TIFF as they are, with their content types. It writes
  any other format as a PNG of the frame, which the host renders (`render.element`).
- **SVG and icons.** Insert ▸ Icons… places an SVG, which the engine draws as vectors. Export
  writes it as PowerPoint does: `asvg:svgBlip` beside a PNG fallback the host renders at
  192 dpi. Import draws an `asvg:svgBlip` picture from its SVG.
- **The format painter.** Copy and Paste formatting (Slide menu; Ctrl/Cmd+Shift+C and
  Ctrl/Cmd+Shift+V in a deck; typed commands) copy a shape's fill, line, transparency and
  effects and its text's character and paragraph formatting onto the selected shapes or text,
  in one undo step.
- **The native document** (`slide-native`, ADR 700, ADR 708). Built with the engine's model
  crates and opened as `.paged`, the same document the IDML package of before opened to. A
  flattened master spread per used layout, a page per slide, every item, story and picture
  (pictures as image blobs); tables; text frames that grow from their anchored edge;
  PowerPoint's first baseline for percentage line spacing; unwrapped text; gradient feathers for
  translucent gradients; radial gradients centred where `a:fillToRect` puts them; slide numbers as
  page-number markers.
- **Slide state on pages.** Each slide's speaker notes, hidden flag and transition are written
  into its page's plugin metadata at import (`x-paged:media.paged.slide`), so they move,
  duplicate and undo with the slide (engine protocol 70).
- **New slide from a layout.** The Slides panel offers the deck's layouts (every layout a slide
  uses); a new slide is a copy of one such slide with only its placeholders kept and emptied, so
  it has the layout's master and PowerPoint's placeholder formatting. Placeholders carry their
  PowerPoint type and index as item metadata. Typing into an emptied placeholder keeps its
  formatting once the engine keeps a cleared paragraph's character attributes (core, next
  release).
- **Slides and Notes panels** (M3, first part). A sorter with a thumbnail per slide from the
  engine's renderer: click to go to the slide, drag to reorder, duplicate, delete, hide from the
  slideshow, each one undo step. A notes panel edits the active slide's speaker notes.
- **Palette commands and menus** (`src/commands.ts`, `src/menu.ts`). The user's verbs as
  palette commands (category Slide) with a menu entry each: File ▸ Open PowerPoint deck… (the
  importer, through the host's file picker) and File ▸ Export PowerPoint deck… (the exporter,
  through the host's file saver), and New slide, Duplicate slide, Delete slide, Move slide up and
  Move slide down under Plugins ▸ Slide. Each is offered only where it applies (a deck open, a
  slide active, more than one slide to delete, a neighbour to pass) and acts on the active slide;
  New and Duplicate run the typed commands, so the palette, a script and the Node CLI make the
  same slide; each is one undo step. A bare invoke that cannot act logs why and does nothing.
  Each slide verb has a key, a Cmd chord with its Ctrl twin (`SLIDE_KEYBINDINGS`): Option+Cmd+N
  new slide, Option+Shift+Cmd+N duplicate, Option+Cmd+Backspace delete, Cmd+Up and Cmd+Down
  move (PowerPoint's own; its Cmd+Shift+N and Cmd+D are the browser's new window and the
  editor's Place). A key is offered where its command is and no text caret is active; the
  editor's keybinding test holds the chords free of its own.
- **Comments** (ADR 711, amendment 2026-10-25). PowerPoint's threaded comments (text, author,
  date, status, replies, a position or a shape anchor) and its legacy comments are imported per
  slide and kept in the container part `comments/comments.json`, by page id. The Comments panel
  lists the active slide's threads: reply, resolve and reopen, delete, add a comment, show the
  resolved ones. Open threads are marked on the slide with their author's initials (the host's
  overlay layers). Typed commands add, reply to, resolve and delete comments. Export writes a
  slide's comments back as one modern comment part when they changed (legacy ones converted),
  extends `ppt/authors.xml`, and keeps the bytes of every slide whose comments did not change.
- **The slide profile and Normal-view keys** (editor ADR 307). `?solo=paged.slide` opens the
  editor as a presentation program: the Slides rail on the left, the slide at the deck's size,
  Slide, Transition, Placeholder, Deck, Comments and Notes in the right dock. A deck holds the
  `slideDeck` document context, and PowerPoint's keys are scoped to it: Cmd/Ctrl+M new slide,
  Cmd/Ctrl+D duplicate slide while nothing is selected, PageUp and PageDown the previous and
  next slide; Delete on a focused thumbnail deletes its slide. Previous slide, Next slide and New
  comment are palette commands with typed twins and Slide menu entries.

- **Slide show and presenter view** (ADR 716). Slide Show ▸ From Beginning (F5) and From Current
  Slide (Shift+F5) fill the screen (extensions ADR 345): PowerPoint's keys (next, previous, a
  number and Enter, black and white screens, Home/End, the slide grid, laser, pen, erase, Esc),
  hidden slides skipped, automatic advance from the slides' timings, an end screen, loop on
  request; the editor goes back to the slide the show ended on. Presenter View (Alt+F5) keeps a
  console in the editor's window (the slide up, the next slide, notes with zoom, timer, clock,
  slide x of y, grid, black screen) and opens the audience in a window of its own, synced over a
  BroadcastChannel; without a second window it runs alone. Rehearse Timings writes each slide's
  time into its transition in one undo step. Frames are the engine's page layers (extensions
  ADR 346), prefetched, drawn without the editor's substituted-font highlight. Transitions play
  through the WGSL shader library (ADR 721) on WebGPU, with the deck's effect options; without
  WebGPU the show cuts and says so once.
- **Slide Sorter** (View ▸ Slide Sorter, ADR 716): a module view in place of the canvas;
  select, Shift/Cmd+click, drag to move the selection, hide, set the transition, double-click to
  open a slide.
- **The importer** (`packages/slide-bundle`, `@paged-media/slide`). File ▸ Open of `.pptx`,
  `.ppsx` and `.potx`: one wasm call (`importPptx`; `slide_js_bg.wasm` is 5.33 MiB, with paged.sheet's workbook engine for live charts) returns the package and a report; the host opens the package, and the source deck and the report are kept as container
  parts.
- **Embedded fonts** (ADR 707). `pptx-fonts` decodes the faces PowerPoint embeds: Embedded
  OpenType (all three header versions, XOR obfuscation) and MicroType Express (LZCOMP and the
  Compact Table Format: `glyf` with its glyph programs, `loca`, `cvt `, `hdmx`, `VDMX`), or a
  bare OpenType part. The licence decides first: installable and editable faces are decoded and
  given to the deck's document through the host's document-font door once it is open (a font the
  machine has wins); preview-and-print, restricted and bitmap-only faces are not used, and the
  import names each with the reason. A deck document opened again gets its faces back from the
  source deck it keeps.
- **PPTX export** (M4; `pptx-export`, ADR 704, ADR 711). File ▸ Export as PowerPoint writes the
  deck from the original the importer kept and the document itself (the host's `.paged`
  serialization):
  - **Slides:** in page order. A duplicated slide gets a slide part of its own. A deleted slide
    is dropped with its relationships and notes. Hidden flags and speaker notes are written; a
    notes slide is created from the notes master when a slide gains notes. Sections stay
    contiguous.
  - **Byte identity per slide:** a slide the document did not change keeps its part, its
    relationships and its notes byte for byte, and an unedited document exports the original
    file.
  - **An edited slide** is its original XML with only the edited shapes rewritten, and only the
    edited parts of each:
    - placement (in its group's space), outline (a live preset is written as `a:prstGeom` with
      its adjust values and box, ADR 717; a reshaped one becomes custom geometry), fill and line;
    - text, paragraph by paragraph: an unchanged paragraph keeps its XML, a changed one is
      written as differences from the shape's inherited defaults (list level from `Body Ln`,
      bullets, runs' font, size, bold, italic, underline, colour as a theme colour while it still
      is one, hyperlinks);
    - a picture's crop or image, a table's cell text, column widths and row heights.
  - **Shapes made in the editor** are written whole (shapes, text boxes, ovals, lines, pictures,
    groups); deleted shapes are dropped. Shapes the document never drew (hidden ones, OLE
    objects, content parts) keep their place.
  - **Slides made in the editor** become new slide parts on their layout. Their placeholders are
    written as differences from the layout's.
  - **Links:** text hyperlinks (URL, slide, show action) and shape click actions round-trip, and
    a link to a deleted slide is removed with its relationship.
  - **Reporting:** what cannot round-trip yet is listed in the export's diagnostics, one line per
    shape (see Not built yet). A host that cannot serialize the document gets the deck's slides
    as they were, and the edited pages are reported.
- **Links on import.** A run's `a:hlinkClick` becomes the engine's text hyperlink: a URL, the
  page of the slide it jumps to, or the show action as a `ppaction://` URL. A shape's click
  action is kept in its item metadata, along with its shape key, placeholder and preset.
- **Transition shaders** (ADR 721; `src/show/shaders`). Every PowerPoint transition is a WGSL
  shader over the two slide images: the 20 ECMA-376 effects, the 19 of PowerPoint 2010, the 12
  `p15:prstTrans` presets, with random choosing from a pool and morph playing as a cross-fade.
  One prelude declares the bindings and the `Uniforms` block, and `manifest.json` maps each
  PowerPoint id and its attributes to a shader and its parameters. `createTransitionRenderer`
  draws on the caller's WebGPU device, with lazy pipelines and ping-pong passes. Nine effects are
  marked as 2.5D approximations in the manifest: vortex, honeycomb, ferris, prestige, fracture,
  crush, airplane, origami and drape. Checked by naga (`slide-shaders`) and by the bun tests, and
  in Chrome by `tests/gpu`: every shader compiles with Tint, progress 0 and 1 reproduce the
  slides, golden frames hold at 0.25, 0.5 and 0.75, and every transition takes under 1 ms of
  GPU time per 1080p frame on an M3 Max (most take under 0.2 ms). The show runtime that plays
  them is the next part of M5.
- **Files and output** (ADR 720, editor ADR 308). File ▸ Export… is a view in place of the
  canvas: PDF slides, handouts (1, 2, 3, 4, 6 or 9 a page; three with lines for notes) and notes
  pages, laid out by `slide-output` over the renderer's slide images (150 dpi; notes in
  Helvetica); the outline as RTF (Word's outline levels) or text, read from the document's title
  and body placeholders; Save as template (`.potx`, also File ▸ Save as template… and an
  exporter); a video (720p, 1080p or 4K at 24, 30 or 60 fps, each slide for its recorded time or
  the default seconds, transitions through the WGSL library) encoded with WebCodecs (H.264, else
  VP9) and muxed into MP4 by the bundle's own ISO-BMFF writer, with progress and Cancel. Opening a
  `.potx` makes an untitled presentation and says so. Typed commands run every export.
- **Sections** ride the label of their first slide: imported from `p14:sectionLst`, headed in the
  Slide Sorter (add at the selection, rename, move with their slides, remove), written back from
  the document. **Custom shows** ride the deck label by page: imported from `p:custShowLst`,
  edited in the Custom Shows panel (Slide Show ▸ Custom Shows…), played in their order, written
  back with the slides that are still there.
- **The PowerPoint oracle** (ADR 705). Scripts drive PowerPoint 16.113.3 to export PDF, per-shape
  geometry, first baselines and chart bars (`scripts/ppt-*`). Fixtures authored through PowerPoint:
  geometry, text, placeholders, motion, baselines.

## Verified

| What                                                               | Against                                                                                                                                                                                                                                                          | Result                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shape geometry                                                     | PowerPoint's per-shape geometry, fixtures and corpus                                                                                                                                                                                                             | 412 fixture and 1 504 corpus shapes within 1 pt                                                                                                                                                                                                                                                                  |
| First baseline and line pitch, percentage spacing                  | `baselines` fixture (5 fonts × 3 sizes × 4 spacings)                                                                                                                                                                                                             | within the PDF's 0.96 pt quantum + 1 % of the size                                                                                                                                                                                                                                                               |
| Chart bars                                                         | PowerPoint's PDF, 44 bars in 4 corpus charts                                                                                                                                                                                                                     | within 3 pt (label widths are not measured at import)                                                                                                                                                                                                                                                            |
| Table styles                                                       | `tables` and `tablestyles` fixtures: 150 tables, all 74 built-in styles                                                                                                                                                                                          | every cell's fill within 4 RGB units, text weight and colour exact, every border by colour and width                                                                                                                                                                                                             |
| SmartArt                                                           | `smartart` fixture                                                                                                                                                                                                                                               | every block within 1 pt, text colours exact                                                                                                                                                                                                                                                                      |
| Engine placement                                                   | the published canvas-wasm, headless, all five fixtures                                                                                                                                                                                                           | a page per slide; every drawn item within 0.5 pt of the import                                                                                                                                                                                                                                                   |
| Live charts                                                        | `charts` fixture (PowerPoint-saved: column, line, pie and scatter charts with workbooks, a column chart without one), Rust and headless on the real engine; corpus decks' 44 bars                                                                                | workbooks read and made; a cell entered redraws the chart (one undo step) and exports; the exported deck re-imports with the same cells; an untouched deck exports its own bytes; slide-chart from the cells within 3 pt of every PowerPoint bar (paged.sheet's geometry: up to 19 pt off)                       |
| Edited charts open in PowerPoint                                   | PowerPoint 16.114.1 opening and saving as PDF the decks the Rust tests write (an edited embedded workbook; a made workbook embedded)                                                                                                                             | no repair prompt; the edited values and series name drawn                                                                                                                                                                                                                                                        |
| Export of slide order, duplicates, deletions, hidden slides, notes | PowerPoint 16.113.3 opening the written decks (a fixture and a corpus deck)                                                                                                                                                                                      | opens without a repair prompt; every page pixel-identical to the expected original slide, in the planned order; notes read back by PowerPoint, line breaks kept                                                                                                                                                  |
| Embedded fonts, whole faces                                        | `fonts-full` fixture: PowerPoint embedding Lato (4 styles) and Gloria Hallelujah                                                                                                                                                                                 | every glyph's outline and program, every advance and every other table identical to the source fonts                                                                                                                                                                                                             |
| Embedded fonts, subsets                                            | `fonts` fixture: PowerPoint's default subsets, Caveat added                                                                                                                                                                                                      | every glyph a subset holds is the source's; each holds every character of the deck's text                                                                                                                                                                                                                        |
| Embedded fonts in the wild                                         | 350 faces from 29 real-world decks (PowerPoint for Windows and Mac; TrueType and CFF; subsets and whole)                                                                                                                                                         | all decode and parse back; 12 faces matched to installed originals: 17 761 glyphs identical, `cvt `/`fpgm`/`prep`/`VDMX` identical, `hdmx` identical for every glyph a subset holds                                                                                                                              |
| Embedded fonts in the engine                                       | the published canvas-wasm and SDK 0.2.55-canary.0, headless                                                                                                                                                                                                      | before: every embedded family missing; after the faces go through the document-font door: none, each style served as the deck's face; File ▸ Open of the deck opens it with nothing missing                                                                                                                      |
| Export of an unedited deck                                         | four fixtures (Rust), the importer→exporter path headless and in the editor                                                                                                                                                                                      | byte-identical to the original                                                                                                                                                                                                                                                                                   |
| Export, per-slide identity and regeneration (ADR 711)              | eight fixtures (Rust): the unedited document; moving the first, a middle and the last shape of every slide; hiding each slide                                                                                                                                    | unedited: the original bytes; each edit changes that slide part alone, and the shape reads back moved by exactly the edit, the same size                                                                                                                                                                         |
| Export of text, tables, new slides, new shapes, links              | fixtures (Rust) and the importer→editor→exporter path on the real engine, headless                                                                                                                                                                               | rewritten text reads back with the level, alignment, indents, bullets, size, font, weight and colour import drew; edits, new slides and links read back as the document held them                                                                                                                                |
| Regenerated decks open in PowerPoint                               | PowerPoint 16 opening and saving as PDF the decks the Rust tests write (`PAGED_SLIDE_EXPORT_DIR`): text edit, resize, delete, table cell, new slide, new shape, text and slide links                                                                             | all eight open without a repair prompt, with every slide; the edited cell, the new slide's placeholders (title, five list levels) drawn on its layout                                                                                                                                                            |
| Live presets and connectors (ADR 717)                              | the `connectors` fixture (PowerPoint moved a glued shape and resized a rounded rectangle on slide 2), Rust and headless on the real engine                                                                                                                       | our edit of slide 1 exports the same `a:xfrm` as PowerPoint's slide 2 for the moved shape, its three re-routed connectors and the rectangle (still `roundRect`, `adj` 30000), within 130 EMU; each follow is in the edit's undo step; the three exported decks open in PowerPoint 16.114 without a repair prompt |
| Pictures in every format, SVG, SmartArt text (ADR 717, 2026-10-28) | PowerPoint 16 opening and saving as PDF the decks the headless tests and `pptx-export/tests/smartart.rs` write: a PNG, JPEG, GIF, BMP, TIFF, WebP, PSD, TGA, QOI, ICO and SVG picture each; a SmartArt point edited in a shape of its own and in a shape of five | all fourteen open without a repair prompt, with every slide; the SVG drawn from its `asvg:svgBlip`; the edited points' text drawn, the other points unchanged                                                                                                                                                    |
| Pictures, format painter, text pane on the real engine             | headless (canvas-wasm) and DOM tests                                                                                                                                                                                                                             | each format inserted at its size and exported with its content type, the host-rendered PNGs written for the others; the painter's fill, line and text size in one undo step; a point's edit keeps the run's 55 pt and undoes in one step                                                                         |
| Comments, import                                                   | `comments` fixture (PowerPoint-saved: a thread with a reply, a resolved shape-anchored comment, a converted legacy one) and a legacy deck (Rust)                                                                                                                 | every comment's text, author, date, status, position (EMU and 1/8 pt confirmed by PowerPoint's own conversion), anchor and replies read                                                                                                                                                                          |
| Comments, export                                                   | Rust fixtures and the importer→editor→exporter path headless and in the editor (journey): unchanged; added, replied, resolved, deleted; duplicate; legacy; new slide                                                                                             | unchanged: the original bytes; changed: only that slide's comment part and relationships, re-imported equal to what the document held                                                                                                                                                                            |
| Comment decks open in PowerPoint                                   | PowerPoint 16.113.3 opening and re-saving the six comment decks the Rust tests write                                                                                                                                                                             | no repair prompt; the re-saved decks read back with the same comments (PowerPoint drops the milliseconds of the date)                                                                                                                                                                                            |
| Sections, custom shows, `.potx` (ADR 720)                          | PowerPoint 16 opening and saving as PDF the decks `pptx-export/tests/output.rs` writes; re-saving two as `.pptx`                                                                                                                                                 | no repair prompt, every slide; the re-saved decks keep both custom shows and both sections by name; the `.potx` opens as a new untitled presentation                                                                                                                                                             |
| MP4 video (ADR 720, editor ADR 308)                                | Chromium's `<video>` (journey), bundled Chromium and Chrome with WebGPU                                                                                                                                                                                          | H.264 720p24, 89 frames: the duration the element reports within 0.1 s of the runner's, a frame decodes; the fade drawn on WebGPU in Chrome                                                                                                                                                                      |

Rendering against PowerPoint's PDF (local tool `scripts/fidelity-local.py`: the engine's CPU
renderer with the fonts PowerPoint used, 48 dpi, SSIM per slide):

| Corpus deck                  | Slides | Median SSIM | Worst slide |
| ---------------------------- | ------ | ----------- | ----------- |
| animation pitch deck         | 20     | 0.941       | 0.908       |
| black-pink business proposal | 20     | 0.917       | 0.878       |
| creative agency profile      | 20     | 0.939       | 0.900       |
| green minimalist proposal    | 20     | 0.882       | 0.818       |
| orange creative pitch deck   | 20     | 0.942       | 0.898       |
| white company profile        | 20     | 0.910       | 0.826       |
| white-lime education         | 4      | 0.995       | 0.995       |

These figures use an engine with master items painted in stacking order and radial gradients
placed by `GradientFillStart`; both ship in canvas-wasm 0.70.0.

## Open in M1

- **Fonts.** A deck's own fonts reach the document only when it embeds them. Fonts it names but
  does not embed must be on the machine; otherwise they render with substitutes. The green deck's
  Antonio is missing on the oracle machine too, and PowerPoint breaks its long title mid-word,
  which the engine does not.
- **Embedded fonts.** The bundle needs the document-font door (plugin-sdk ADR 328, published in
  0.2.55-canary.0); an editor pinned to an older SDK has no backend for it, and the import says
  the host cannot give the document the deck's fonts. On a host with `assets.documentFont@2`
  (plugin-sdk ADR 330) a face goes with its document, as editable embedding asks; on an older
  host it lives for the editing session, so another document opened later in that session can
  resolve it.
  Preview-and-print faces wait for a read-only view (the slideshow).
- **SmartArt layouts in fixtures.** PowerPoint draws a seeded diagram with its default layout
  only, so the fixture covers the drawing's lowering, not other layouts' shapes.
- **Editor wiring.** The editor loads the bundle on a branch, through a local link, and a
  journey opens a PowerPoint-authored deck there (ten 960 × 540 pt pages, the title slide drawn)
  and drives the Slides and Notes panels.
  It merges once `@paged-media/slide` is published: the first version by hand (trusted
  publishing cannot create a package), then the publish workflow takes over.

## Not built yet

- Editing layouts (master spreads) from the plugin, and layouts no slide uses (they are not
  imported).
- PPTX export of what the native model cannot say yet, or what export does not write yet:
  effect changes (shadow, opacity on its own), edits inside SmartArt other than its points'
  text (shapes, formatting, added or removed points), a chart's formatting
  (only its data is live), added, removed or
  merged table rows and columns, cell fills and borders, font styles other than bold and italic,
  palette edits (a swatch's new colour does not mark its shapes edited), a picture frame's
  reshaped outline, placeholders other than text ones on a slide made in the editor. Each is
  reported in the export's diagnostics, and the shape is written as the deck had it. A notes
  master for a deck that has none. Transitions, timing, masters and layouts are still copied, not
  regenerated (later waves of ADR 711).
- Animations in the show (per-item layers, wave 5), ink saved as annotations.
- Live charts (ADR 715): a chart inside a PowerPoint group is drawn and its data exported, but
  not redrawn on the page after an edit; a duplicated slide's chart shares its chart part (an
  edit redraws both); the workbook edit itself is not on the undo stack (undo restores the old
  drawing); a chart's formatting is not editable; the data sheet edits values and formulas, not
  rows, columns or the series' ranges.
- Vector handouts and notes pages (they are 150 dpi images until the host offers a door for
  imposed PDF pages); notes text outside Windows-1252 in the PDF (printed as `?`); audio in
  videos (media items, wave 4); a video runner in a worker.

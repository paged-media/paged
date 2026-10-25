# paged.slide — status

Read from the code on 2026-10-24.

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
- **Geometry** (`slide-geom`). All 187 ECMA-376 preset shapes and custom geometry, as Bézier
  outlines.
- **Charts** (`slide-chart`). Clustered, stacked and percent bars in both directions, lines
  (smoothed), areas, pies and doughnuts, gridlines, axis lines, tick and data labels, legends;
  Excel's automatic value scale; Office's default chart-style paints. Drawn as groups of native
  shapes.
- **Tables and table styles.** All 74 built-in table styles (eleven families, plain or per
  accent) and a deck's own styles, resolved cell by cell in PowerPoint's layer order and written
  as native table styles (region cell styles, alternating fills) with local values only where
  the native cascade differs. A table without a known style is drawn as No Style, Table Grid.
- **SmartArt.** Each diagram's drawing (the shapes PowerPoint laid out) becomes a group of
  native shapes; text boxes and style text colours as PowerPoint draws them.
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
- **The importer** (`packages/slide-bundle`, `@paged-media/slide`). File ▸ Open of `.pptx`,
  `.ppsx` and `.potx`: one wasm call (`importPptx`, 1.3 MB, 373 KB gzipped) returns the package and
  a report; the host opens the package, and the source deck and the report are kept as container
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
    - placement (in its group's space), outline (a resized preset stays a preset, a reshaped one
      becomes custom geometry), fill and line;
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
- **The PowerPoint oracle** (ADR 705). Scripts drive PowerPoint 16.113.3 to export PDF, per-shape
  geometry, first baselines and chart bars (`scripts/ppt-*`). Fixtures authored through PowerPoint:
  geometry, text, placeholders, motion, baselines.

## Verified

| What                                                               | Against                                                                                                                                                                              | Result                                                                                                                                                                                      |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shape geometry                                                     | PowerPoint's per-shape geometry, fixtures and corpus                                                                                                                                 | 412 fixture and 1 504 corpus shapes within 1 pt                                                                                                                                             |
| First baseline and line pitch, percentage spacing                  | `baselines` fixture (5 fonts × 3 sizes × 4 spacings)                                                                                                                                 | within the PDF's 0.96 pt quantum + 1 % of the size                                                                                                                                          |
| Chart bars                                                         | PowerPoint's PDF, 44 bars in 4 corpus charts                                                                                                                                         | within 3 pt (label widths are not measured at import)                                                                                                                                       |
| Table styles                                                       | `tables` and `tablestyles` fixtures: 150 tables, all 74 built-in styles                                                                                                              | every cell's fill within 4 RGB units, text weight and colour exact, every border by colour and width                                                                                        |
| SmartArt                                                           | `smartart` fixture                                                                                                                                                                   | every block within 1 pt, text colours exact                                                                                                                                                 |
| Engine placement                                                   | the published canvas-wasm, headless, all five fixtures                                                                                                                               | a page per slide; every drawn item within 0.5 pt of the import                                                                                                                              |
| Export of slide order, duplicates, deletions, hidden slides, notes | PowerPoint 16.113.3 opening the written decks (a fixture and a corpus deck)                                                                                                          | opens without a repair prompt; every page pixel-identical to the expected original slide, in the planned order; notes read back by PowerPoint, line breaks kept                             |
| Embedded fonts, whole faces                                        | `fonts-full` fixture: PowerPoint embedding Lato (4 styles) and Gloria Hallelujah                                                                                                     | every glyph's outline and program, every advance and every other table identical to the source fonts                                                                                        |
| Embedded fonts, subsets                                            | `fonts` fixture: PowerPoint's default subsets, Caveat added                                                                                                                          | every glyph a subset holds is the source's; each holds every character of the deck's text                                                                                                   |
| Embedded fonts in the wild                                         | 350 faces from 29 real-world decks (PowerPoint for Windows and Mac; TrueType and CFF; subsets and whole)                                                                             | all decode and parse back; 12 faces matched to installed originals: 17 761 glyphs identical, `cvt `/`fpgm`/`prep`/`VDMX` identical, `hdmx` identical for every glyph a subset holds         |
| Embedded fonts in the engine                                       | the published canvas-wasm and SDK 0.2.55-canary.0, headless                                                                                                                          | before: every embedded family missing; after the faces go through the document-font door: none, each style served as the deck's face; File ▸ Open of the deck opens it with nothing missing |
| Export of an unedited deck                                         | four fixtures (Rust), the importer→exporter path headless and in the editor                                                                                                          | byte-identical to the original                                                                                                                                                              |
| Export, per-slide identity and regeneration (ADR 711)              | eight fixtures (Rust): the unedited document; moving the first, a middle and the last shape of every slide; hiding each slide                                                        | unedited: the original bytes; each edit changes that slide part alone, and the shape reads back moved by exactly the edit, the same size                                                    |
| Export of text, tables, new slides, new shapes, links              | fixtures (Rust) and the importer→editor→exporter path on the real engine, headless                                                                                                   | rewritten text reads back with the level, alignment, indents, bullets, size, font, weight and colour import drew; edits, new slides and links read back as the document held them           |
| Regenerated decks open in PowerPoint                               | PowerPoint 16 opening and saving as PDF the decks the Rust tests write (`PAGED_SLIDE_EXPORT_DIR`): text edit, resize, delete, table cell, new slide, new shape, text and slide links | all eight open without a repair prompt, with every slide; the edited cell, the new slide's placeholders (title, five list levels) drawn on its layout                                       |

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
- Thumbnails show the editor's missing-font highlight; the slideshow needs snapshots without it.
- PPTX export of what the native model cannot say yet, or what export does not write yet:
  effect changes (shadow, opacity on its own), edits inside charts and SmartArt, added, removed or
  merged table rows and columns, cell fills and borders, font styles other than bold and italic,
  palette edits (a swatch's new colour does not mark its shapes edited), a picture frame's
  reshaped outline, placeholders other than text ones on a slide made in the editor. Each is
  reported in the export's diagnostics, and the shape is written as the deck had it. A notes
  master for a deck that has none. Transitions, timing, masters and layouts are still copied, not
  regenerated (later waves of ADR 711).
- Slideshow and presenter view (M5); transitions are decided (ADR 706).

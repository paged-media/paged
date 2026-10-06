# paged.slide — status

Read from the code on 2026-10-05.

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
- **IDML writing** (`slide-idml`, ADR 700). A flattened master spread per used layout, a page per
  slide, every item, story and picture; tables; text frames that grow from their anchored edge;
  PowerPoint's first baseline for percentage line spacing; unwrapped text; gradient feathers for
  translucent gradients; slide numbers as page-number markers.
- **The importer** (`packages/slide-bundle`, `@paged-media/slide`). File ▸ Open of `.pptx`,
  `.ppsx` and `.potx`: one wasm call (`importPptx`, 1.3 MB, 373 KB gzipped) returns the package and
  a report; the host opens the package, and the source deck and the report are kept as container
  parts.
- **The PowerPoint oracle** (ADR 705). Scripts drive PowerPoint 16.113.3 to export PDF, per-shape
  geometry, first baselines and chart bars (`scripts/ppt-*`). Fixtures authored through PowerPoint:
  geometry, text, placeholders, motion, baselines.

## Verified

| What | Against | Result |
|---|---|---|
| Shape geometry | PowerPoint's per-shape geometry, fixtures and corpus | 412 fixture and 1 504 corpus shapes within 1 pt |
| First baseline and line pitch, percentage spacing | `baselines` fixture (5 fonts × 3 sizes × 4 spacings) | within the PDF's 0.96 pt quantum + 1 % of the size |
| Chart bars | PowerPoint's PDF, 44 bars in 4 corpus charts | within 3 pt (label widths are not measured at import) |
| Table styles | `tables` and `tablestyles` fixtures: 150 tables, all 74 built-in styles | every cell's fill within 4 RGB units, text weight and colour exact, every border by colour and width |
| SmartArt | `smartart` fixture | every block within 1 pt, text colours exact |
| Engine placement | the published canvas-wasm, headless, all five fixtures | a page per slide; every drawn item within 0.5 pt of the import |

Rendering against PowerPoint's PDF (local tool `scripts/fidelity-local.py`: the engine's CPU
renderer with the fonts PowerPoint used, 48 dpi, SSIM per slide):

| Corpus deck | Slides | Median SSIM | Worst slide |
|---|---|---|---|
| animation pitch deck | 20 | 0.941 | 0.908 |
| black-pink business proposal | 20 | 0.917 | 0.878 |
| creative agency profile | 20 | 0.939 | 0.900 |
| green minimalist proposal | 20 | 0.882 | 0.818 |
| orange creative pitch deck | 20 | 0.805 | 0.649 |
| white company profile | 20 | 0.910 | 0.826 |
| white-lime education | 4 | 0.995 | 0.995 |

These figures use an engine build that includes the master-paint-order fix below; the published
engine (0.67.0) does not draw a master's pictures yet.

## Open in M1

- **Engine: master items.** The renderer painted master items grouped by kind and never drew a
  master's placed pictures. Fixed on a core branch (paint in stacking order, with pictures); ships
  with the next engine release.
- **Engine: radial gradient placement.** IDML's `GradientFillStart` is not read and a radial
  gradient always sits at the default centre, so PowerPoint's centred radial glows (orange deck)
  render off-centre. Needs the parser in the IDML adapter, a model field and the renderer; planned
  for the M2 engine batch.
- **Engine: table cell indents.** `LeftIndent` inside table cells is ignored.
- **Engine: double cell borders.** A cell edge's stroke type is not read, so a double line
  (some styles' total-row top) draws as a solid line of the same weight.
- **Fonts.** Plugins cannot register fonts with the host yet (planned SDK door, M2). Decks whose
  fonts the host lacks render with substitutes; the green deck's Antonio is missing on the oracle
  machine too, and PowerPoint breaks its long title mid-word, which the engine does not.
- **Embedded fonts.** No corpus deck embeds fonts and PowerPoint's scripting cannot embed them; a
  hand-authored fixture is needed before extraction is built.
- **SmartArt layouts in fixtures.** PowerPoint draws a seeded diagram with its default layout
  only, so the fixture covers the drawing's lowering, not other layouts' shapes.
- **Editor wiring.** The editor loads the bundle on a branch, through a local link, and a
  journey opens a PowerPoint-authored deck there (ten 960 × 540 pt pages, the title slide drawn).
  It merges once `@paged-media/slide` is published: the first version by hand (trusted
  publishing cannot create a package), then the publish workflow takes over.

## Not built yet

- Engine protocol batch and the host doors (M2).
- Native editing surfaces: slide sorter, notes, layouts (M3).
- PPTX export (M4).
- Slideshow and presenter view (M5); transitions are decided (ADR 706).

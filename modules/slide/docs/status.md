# paged.slide — status

Read from the code on 2026-10-05.

## Built

- **Package reading.** `pptx-import` reads a `.pptx` into the `pptx-core` IR: slide size, slides in
  order, slide masters with their text styles and colour map, layouts, themes (colour scheme, font
  scheme, fill/line/effect/background styles), shapes (shapes, pictures, groups, connectors, tables,
  chart and SmartArt references), text (body properties, list styles, paragraphs, runs, fields),
  backgrounds, speaker notes, transitions (with their original XML), animation timing (verbatim),
  sections and embedded font references. All seven corpus decks read without error.
- **The PowerPoint oracle.** Scripts drive PowerPoint 16.113.3 to export PDF and per-shape geometry
  (`scripts/ppt-*`). The seven corpus decks are recorded in the private corpus repository; four
  feature fixtures (geometry, text, placeholders, motion) were authored through PowerPoint and are
  recorded under `slide-conformance/fixtures`.
- **wasm.** `slide-js` builds the reader to a 474 KB release wasm (before optimisation).

## Not built yet

- Inheritance resolution, preset geometry, IDML writing and the importer (M1).
- Engine protocol 68 and the host doors (M2).
- Native editing surfaces: slide sorter, notes, layouts (M3).
- PPTX export (M4).
- Slideshow and presenter view (M5).

# paged.slide — concept

paged.slide makes presentations a document type of the paged engine: slides are native pages,
built from native frames, text, images and tables, laid out and rendered by the engine. It reads
PowerPoint `.pptx` files into that native form, writes `.pptx` back out, and presents a deck as a
slideshow with a presenter view in the editor.

## What a deck is, natively

- One slide is one single-page spread at the deck's slide size (16:9 is 960 × 540 pt).
- A slide layout is a master spread. PowerPoint's slide master is flattened into each of its
  layouts at import, because the engine has one master level ([ADR 700](adr/700-pptx-opens-as-a-generated-idml-package.md)).
- Placeholders are ordinary frames whose position and text style were resolved from the layout
  and master; their identity is kept so "New slide" and export can treat them as placeholders.
- List levels are paragraph styles (`Body L1` … `Body L9`).
- Theme colours become a colour group of named swatches.
- Notes, transitions and animation timing are plugin metadata on pages and items
  ([ADR 703](adr/703-slide-data-storage.md)).

## Reading PPTX

Rust reads the package into a format-level IR (`pptx-core`) that keeps the file's units and leaves
inheritance unresolved ([ADR 702](adr/702-drawingml-is-read-as-an-element-tree.md)). A resolver
applies PowerPoint's rules, and a writer produces a complete IDML package that the host opens.
PowerPoint is the oracle for every rule ([ADR 705](adr/705-powerpoint-is-the-oracle.md)).

## Writing PPTX

An unedited deck exports as its original bytes. An edited deck is regenerated: masters, layouts
and themes are carried from the source when unchanged, slides are written from the native
document ([ADR 704](adr/704-pptx-export-regenerates-slides.md)).

## Presenting

The slideshow renders each slide (and each build step) with the engine and plays transitions
between the rendered frames; the presenter view shows the current and next slide, notes and a
timer. Supported effects are fade, push, wipe and cut transitions and appear and fade builds; every
other effect is kept for export and played as the nearest supported one.

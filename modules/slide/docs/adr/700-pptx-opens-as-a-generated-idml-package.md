# ADR 700 — A PPTX opens as a generated IDML package, with inheritance resolved at import

- **Status:** Accepted 2026-10-05.
- **Scope:** `pptx-import`, `slide-resolve`, `slide-geom`, `slide-idml`, the importer in `packages/slide-bundle`

## Context

A slide deck has four levels of inheritance: theme, slide master, slide layout and slide, plus
placeholders that inherit position, size and text formatting by `type` and `idx`. The engine has
one master level (a page applies a master spread; master items render under page items, and a
page can hide master items through its override list).

Masters cannot be created over the host's mutation door: there is no operation that creates a
master spread or places an item on one. A deck's masters therefore have to arrive inside the
package the host opens.

Two routes exist in sibling plugins. One builds the engine's native document with the engine's
own crates and wraps it as a `.paged` package; that needs a source dependency on the engine,
which the plugin isolation contract forbids (`deny.toml` denies git sources). The other writes
an IDML package itself and opens it with `host.nativeDocument.open`; the Word plugin does this
for its skeleton.

## Decision

The plugin writes a **complete** IDML package for the deck and opens it with
`host.nativeDocument.open`. Nothing is poured afterwards through mutations.

- Inheritance is resolved in Rust at import, never at render time (`slide-resolve`).
- Every used layout becomes one master spread: the slide master's background and shapes (when the
  layout shows master shapes), then the layout's background and shapes. Master and layout
  placeholders that are empty are not drawn; their resolved geometry and text styles are kept
  in the layout map part for "New slide from layout" and for export.
- Each slide becomes one single-page spread at the deck's slide size, applying its layout's
  master spread. A slide placeholder is an ordinary page item with geometry and text resolved
  slide → layout → master.
- Colours are resolved to absolute values. The theme's twelve slots also become a colour group of
  named swatches, and items still painted with an unmodified theme colour reference that swatch.
- List levels are paragraph styles (`Title`, `Body L1`…`Body L9`, `Other L1`…`Other L9` per master),
  so a paragraph's level is its applied style.
- Preset geometries are evaluated to Bézier paths by the plugin (`slide-geom`); the preset name
  and adjust values are kept as item metadata for export.

## Consequences

- Opening is one atomic step with no undo history to clean up, and it can be tested headlessly
  against the real engine.
- Editing a slide master does not propagate to its layouts, because each layout's master spread
  is a flattened copy. Export merges them back through the layout map (ADR 704).
- The IDML writer must emit every construct a deck uses; anything it cannot is reported as a
  diagnostic and, where possible, kept as a preserved part.

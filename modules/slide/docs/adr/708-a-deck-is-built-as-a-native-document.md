# ADR 708 — A deck is built as a native document with the engine's model crates

- **Status:** Accepted 2026-10-19. Amends [ADR 700](700-pptx-opens-as-a-generated-idml-package.md)
  (how the package is written) and the engine-dependency rule in `CLAUDE.md`.
- **Scope:** `slide-native` (replaces `slide-idml`), `slide-js` (`Imported.paged`),
  `packages/slide-bundle` (`engine.ts`, `activate.ts`), `Cargo.toml`, `deny.toml`, `moon.yml`,
  `scripts/fidelity-local.py`

## Context

A deck opens as one package that the host opens as the document (ADR 700). `slide-idml` wrote
that package as IDML with string templates, about 1,400 lines: masters, spreads, groups,
polygons, pictures with inline base64 bytes, text frames, tables with table and cell styles,
stories, swatches, gradients, gradient feathers and drop shadows, plugin labels. ADR 700 had
rejected building the engine's document with the engine's own crates because, in a separate
repository, that meant a git dependency the isolation contract forbade.

In the monorepo the module builds from the same commit as the engine (PM-0002, PM-0005). The
PDF mapper and, since doc ADR 606, the Word module's skeleton build their documents with the
engine's model crates and package them with core's one `.paged` writer. The plan's wave C item
C4 asks the same of this module.

## Decision

- `slide-native` builds the resolved deck as a `paged_scene::Document` and packages it with
  `paged_store::package::wrap_document`. `slide-js` hands the bundle the `.paged` bytes
  (`Imported.paged`, was `idml`); the bundle opens them as before. The engine reads the model
  part and parses no IDML; pictures travel as the container's image blobs, not as base64
  inside a spread.
- The builder follows the writer construct for construct (same ids, same order, same values),
  so a deck opens to the document it opened to before: lengths keep the thousandth of a point
  the IDML text carried, names lose their line breaks as the XML attributes did, a style colour
  of the None swatch is no colour, an outline with no point is no item. Before `slide-idml` was
  deleted, a test compared the two (the model part, and the report beside it: stories by item,
  elements by item, diagnostics) on all 10 PowerPoint-authored fixtures and on the 7 decks of
  the pptx corpus lane: equal on every one. The test is in the history at the commit that
  added `slide-native`.
- The derived caches of the document are left empty; the engine rebuilds them on open.
- The dependency is the engine's model crates only (`paged-model`, `paged-scene`,
  `paged-store`), as path dependencies on `engine/core/crates`. Notes, transitions, layouts
  and parts still reach the document as before (page and item labels, container parts).
- `scripts/fidelity-local.py` converts with the `pptx2paged` example; `paged-inspect` opens a
  `.paged` container through the engine's own open path (`container::open_document`).

## Consequences

- A model change that breaks the deck is a compile error here, not a field the IDML importer
  silently drops; a container change in core reaches the deck in the same commit.
- `slide_js_bg.wasm` grows by the serializer of the engine model (the model part is JSON) and
  the content hash of image blobs, less the IDML writer and the base64 encoder. Measured with
  the CI build (wasm-release, `wasm-bindgen --target web`, `wasm-opt -Oz`): see
  `docs/migration/shared-foundations.md` (C4) for the numbers. Merging the doc, slide and PDF
  mapper binaries would carry one serializer instead of three (deferred in the plan).
- The model part writes the spread's id-keyed maps (labels, item names) in the order the map
  holds them, so two imports of a deck are the same document but not always the same bytes.
  The IDML writer's output was byte-stable. Nothing compares the opened bytes (an unedited
  deck exports as its original bytes, ADR 704); making the model part's maps sorted is a
  change in core.

## Related

- [ADR 700](700-pptx-opens-as-a-generated-idml-package.md) — one package, inheritance resolved at
  import
- [ADR 703](703-slide-data-storage.md) — where slide-only data lives
- [ADR 704](704-pptx-export-regenerates-slides.md) — export reads the native document
- doc ADR 606 — the Word module's skeleton, built the same way
- PM-0002 (built-ins and extensions), PM-0005 (workspace policy)

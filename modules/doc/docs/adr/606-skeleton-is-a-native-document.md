# ADR 606 — The standalone-open skeleton is a native document built with the engine's model crates

- **Status:** Accepted 2026-10-19. Amends [ADR 603](603-two-entry-points.md) (how the skeleton
  is written) and the isolation rule in `CLAUDE.md`.
- **Scope:** `docx-skeleton`, `docx-js` (`skeleton_paged`), `packages/doc-bundle`
  (`engine.ts`, `open.ts`), `Cargo.toml`, `deny.toml`, `moon.yml`

## Context

Standalone open loads a page skeleton as the document and pours the Word document into it
(ADR 603). `docx-skeleton` wrote that skeleton as a minimal IDML package with `zip` and string
templates, because the plugin was not allowed an engine crate: in a separate repository the
dependency would have been a git pin across repositories, and the isolation contract
forbade it (`dc65ac9` replaced an earlier skeleton built with the engine's crates for exactly
that reason).

Since the monorepo (PM-0002, PM-0005) a built-in module is built from the same commit as the
engine, and the PDF mapper (`modules/publish/crates/pdf-import`) already builds its document with
the engine's model crates and packages it with core's one `.paged` writer. The plan's wave C
item C4 asks the Word and PowerPoint modules to do the same and retire their hand-written IDML
writers.

## Decision

- `docx-skeleton` builds the skeleton as a `paged_scene::Document` (`docx-skeleton/src/native.rs`)
  and packages it with `paged_store::package::wrap_document`. The bundle opens the `.paged`
  bytes through `host.nativeDocument.open`; the engine reads the model part
  (`paged/core/model/document.pgm`) and parses no IDML. The wasm entry is `skeleton_paged`
  (was `skeleton_idml`), the facade `DocEngine.skeletonPaged`.
- The document is the one the engine's IDML importer made of the old package, field for field:
  the same spreads, pages, margins, frames, empty stories, swatches, root styles, part paths
  and manifest. Before the IDML writer was deleted, a test compared the two models (serialised
  as the model part) on every committed fixture (30 conformance builders, `annual-report.docx`,
  the bundle's `merge-letter.docx`) and on the docx corpus lane (273 of 292 files import), each
  with both lowerings (span/split columns on and off): equal everywhere but one field (see
  below). The test is in the history at the commit that added the builder.
- The derived caches of the document (`frame_for_story`, `text_frame_index`, the anchor table)
  are left empty: they are not part of the model part, and the engine rebuilds them on open.
- The dependency is the engine's model crates only (`paged-model`, `paged-scene`,
  `paged-store`), as path dependencies on `engine/core/crates`. No other crate of this
  workspace reaches the engine; the pour, styles, grow rules and save-back are unchanged and
  still go through the host.
- The model crates build at `opt-level = "z"` in `wasm-release`: the skeleton is built and
  serialised once per open.

## Consequences

- One `.paged` writer for every module that produces documents (pdf-import, doc, slide): a
  container change in core reaches the skeleton in the same commit, and a model change that
  breaks the skeleton is a compile error here.
- The old path kept an escaped document name: idml-import reads the designmap's `Name`
  attribute raw, so a Word file named `a&b.docx` opened as a document named `a&amp;b.docx`.
  The native document carries the name itself (the one difference the comparison found, on
  one corpus file).
- `docx_js_bg.wasm` grows: it now carries the serializer of the engine model (the model part is
  JSON) and the content hash of image blobs. Measured with the CI build (wasm-release,
  `wasm-bindgen --target web`, `wasm-opt -Oz`): 6,660,701 bytes before, 6,834,216 after
  (+173,515). Without the `opt-level = "z"` override and with the caches rebuilt it was
  +209,903. The app-wide budget (100 MB) has room for it; merging the doc, slide and PDF
  mapper binaries would carry one serializer instead of three (deferred in the plan).
- IDML still cannot carry the grow rule, but the model can (`Story::grow`). The bundle still
  sets it on the wire after the open, so an engine that refuses it is still reported; writing
  it into the skeleton is possible now and not done.
- The `skeleton_idml` example (writing the skeleton for InDesign to check) is gone: there is
  no IDML skeleton to check. The engine's IDML export writes one from the opened document.

## Related

- [ADR 603](603-two-entry-points.md) — the two entry points; the skeleton's place in the open
- [ADR 600](600-docx-lowered-onto-native-model.md) — the lowering the pour applies
- slide ADR 708 — the PowerPoint module's deck, built the same way
- PM-0002 (built-ins and extensions), PM-0005 (workspace policy)

# ADR 1058 — Type layers stay on the fontations stack; the stack is pinned once

- **Status:** Accepted 2026-11-08.
- **Scope:** `image-js` (`src/text.rs`), `paged-text`, `pptx-fonts`; the engine workspace's
  `[workspace.dependencies]`. No wire change. Closes the "image-js has its own harfrust, skrifa and
  ab_glyph beside paged-text" line of the capability register's *Text and fonts* section as far
  as it can be closed without changing pixels.

## Context

The register named three font stacks: `paged-text` (harfrust shaping, ttf-parser metrics and
outlines), `image-js` (harfrust, skrifa, ab_glyph_rasterizer) and `pptx-fonts` (skrifa in tests).
The proposal was to put raster type on `paged-text`.

## Decision

1. **Raster type does not take a dependency on `paged-text`.** The crate carries the document
   model, the scene and the composer (`paged-model`, `paged-scene`, `paged-flow`,
   `paged-composition`); image-js is a bundle wasm whose graph holds pixel crates only. And the
   shaping entry point (`shape_run`) rounds each advance to 1/64 pt against a paragraph pen, where
   a raster run keeps exact float advances: moving onto it would change glyph positions, so it
   is not pixel-identical and the image goldens would be re-recorded for nothing.
2. **The family is fontations.** harfrust and skrifa share `read-fonts`; `ttf-parser` is the odd
   one out, kept in `paged-text`, the renderer and the exporters for table and outline reads that
   are tied to their goldens. A later move of those onto skrifa is a separate, golden-by-golden
   slice and is not started here.
3. **The pin is one.** `harfrust` and `skrifa` are `[workspace.dependencies]` of the engine
   workspace and the three crates inherit them, so a bump moves all users together.

## Consequences

- `image-js` keeps its shaping and outline code; `ab_glyph_rasterizer` goes with the one
  coverage-rasterizer consolidation (capability register, *Raster, kernels, blend*).
- Nothing renders differently.

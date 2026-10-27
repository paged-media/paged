# ADR 468 — A type layer's text lives in the image; the engine lays it out and the GPU warps it

- **Status:** Accepted 2026-10-27.
- **Scope:** `image-js/src/layers/type_layer.rs` (`TypeSource`, `TypeLayer`, `TypeRender`, the
  PSD conversion), `LayerKind::Type` and its verbs (`layers.rs`, `layers/verbs.rs`), the session
  manifest v5 (`layers_persist.rs`), the PSD read and write (`layers.rs`, `saveback.rs`), the
  wasm exports `layers_add_type`, `layers_set_type`, `layers_type_source`;
  `image-kernels/src/families/warp.rs` (`geom.warp_mesh`); `glue/src/type-layer.ts`,
  `type-tool.ts`, `type-overlay.tsx` and the session's type verbs. The engine halves:
  `paged-psd`'s `text_layer`, `engine_data` and `descriptor_write`; `paged-warp`'s `envelope`;
  core ADR 10XX and extensions ADR 349. Plan WP5.10, gap I-67.

## Context

The image module painted type as pixels (the raster type of `image-js/src/text.rs`): the text
was gone once painted, there was no wrapping, and a PSD's text layers opened as pixels.
Photoshop keeps type editable, wraps paragraph type, bends it with Warp Text, and writes it into
the PSD as a `TySh` block.

## Decision

- **A type layer is a layer kind** whose pixels are a cached render of a `TypeSource`: the text,
  character runs, paragraph settings, a point or box frame, Warp Text. It composites as pixels,
  like a fill layer; it is re-rendered when its source changes.
- **The engine lays the text out** (`host.render.story`): the bundle draws the source at the
  image's resolution (one canvas pixel per engine point, scaled when a frame is large) and hands
  image-js the pixels. Nothing in the module shapes a type layer's text.
- **Warp Text is a GPU warp of the render**: `paged-warp` builds the 4×4 Bézier mesh of the
  style (Photoshop's fifteen, with bend and both distortions) around the render's box, and the
  `geom.warp_mesh` kernel inverts it per texel (Newton on the patch, bilinear on associated
  alpha). No CPU path ships (ADR 450).
- **Editing is one undo step per session**: the type tool's click (point type) or drag (box
  type) makes a layer and opens an on-canvas text field over it; every write of that session
  shares a merge key. The Character and Paragraph panels restyle the active type layer as a
  whole.
- **A PSD's type layers open as type**: `TySh` is parsed (descriptor, text engine data) into a
  source, the pixels stay Photoshop's render and the block is kept; an unedited layer writes its
  own block back byte for byte, an edited one writes a new block from its source.
- **What a type layer cannot follow becomes pixels**: a canvas rotation, flip or straighten
  rasterizes it (upright text cannot follow); a crop or Canvas Size moves its frame; Image Size
  scales its source and re-renders it. Painting on it is refused until Layer ▸ Rasterize.
- **Raster type stays** as Type ▸ Paint text into layer.

## Consequences

- An edited PSD type layer loses the engine settings the source does not model (kerning pairs,
  OpenType features, a stroke on the glyphs, a rotated transform).
- Point type's frame is an estimate wide enough not to wrap; its anchor sits on the first
  baseline through the fixed first-baseline offset.
- Type on a path waits for the image's Paths panel (WP5.11).
- The warp styles are this module's closed forms, recorded against Photoshop as a convention,
  not claimed to be Photoshop's meshes.

## Evidence

- `image-js/src/layers/type_tests.rs`, `type_layer.rs` tests; `image-conformance/tests/it/
  psd_text_layers.rs` (Photoshop's text layers open as type; written back as type);
  `family_warp.rs` (gpu↔ref parity for every style); `glue/test/type-layers.spec.ts`.

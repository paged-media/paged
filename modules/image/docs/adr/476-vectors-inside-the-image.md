# ADR 476 — Vectors inside the image: one path geometry, drawn by the vector-mask rasterizer, edited by draw's machines

- **Status:** Accepted, 2026-10-28. Amends [ADR 470](470-selection-and-masking.md) (the document's
  paths gain operations and a work path; Make Work Path makes the work path) and the PM-0002 lint
  boundary for this module (it imports draw's geometry and tool machines).
- **Scope:** `image-js/src/vectors.rs`, `image-js/src/layers/vector_ops.rs`, the vector doors of
  `image-js/src/lib.rs`, the PSD read and write of vector masks, shape layers and paths
  (`layers.rs` import, `psd_layer_ext.rs`, `saveback.rs`, `engine/core/crates/paged-psd`
  `vector_mask.rs` and `model/resources.rs`), `glue/src/vector-{engine,session,tools,shapes,contrib}.ts`,
  the Paths and Vector mask sections of `glue/src/panels/sections/masking-section.tsx`, the
  Photoshop probe `vector-paths.jsx` and its replay
  `image-conformance/tests/it/psd_vector_paths_photoshop.rs`.

## Context

Photoshop's vector features inside a raster document were missing (gaps I-24, I-34, I-68 and X-4 of
the 2026-10-23 report): the Pen and its siblings, the shape tools with their three modes, a Paths
panel that fills and strokes, editable vector masks and shape layers, and the PSD records that carry
them. WP5.5 had stored paths in the session (ADR 470) and the import already drew PSD vector masks
with a rasterizer fitted to Photoshop's own renders — but only to bake them into the layer mask.
Four questions needed a decision:

1. What a path IS, given that the Paths panel, a vector mask and a shape layer all hold one.
2. How it becomes pixels, given that four features draw it (mask, shape, selection, fill).
3. Who owns the editing gestures, given that draw already has a tested Pen and Direct Selection.
4. What survives a PSD round trip.

## Decision

- **One geometry.** A path is a list of subpaths in image px, each carrying how it joins the shape:
  the PSD length record's operation (exclude, combine, subtract, intersect; `0xFFFF` continues the
  component before it) and fill rule (`masking::SubOp`). The document's paths (`DocPath`, now with a
  `work` flag) and a layer's vector mask (`LayerVectorMask`, in `LayerExt`) hold the same `SubPath`s,
  so every tool edits either alike. A new subpath combines, even-odd — what Photoshop 27 writes for
  the default path operation ([OBS], its own files).
- **One rasterizer.** Every drawing of that geometry — a vector mask, a shape layer's shape, a path
  loaded as a selection, Fill Path and the shape tools' Pixels mode — goes through
  `psd_vector_mask::rasterize` (17 × 15 samples, per-sample booleans), the one fitted to Photoshop.
  Loading a path as a selection therefore now honours its operations (it used to fill every subpath
  non-zero at 4 × 4 samples). Drawing coverage geometry is mask preparation and stays on the CPU;
  the fills and the composite remain GPU kernels.
- **A vector mask multiplies in live.** `Layer::live_mask` is the user mask times the vector mask's
  drawing when the vector mask is enabled; the drawing is made once per edit and the product once
  per user mask (the same allocation is handed back, so the fold's upload cache stays warm). A
  linked vector mask moves with its layer and follows every canvas operation exactly (its points
  are mapped, then drawn again).
- **A shape layer is a fill layer with a vector mask**, as in Photoshop: the fill renders over the
  canvas and the mask cuts the shape. A Photoshop shape layer (`SoCo`/`GdFl` with `vmsk`/`vsms`)
  opens editable that way; its stored render (the shape already cut) is not kept, since it would be
  cut twice. A STROKED shape (`vscg`, or `vstk` with the stroke on or the fill off) still opens as the
  pixels Photoshop stored: strokes are not drawn yet.
- **The tools are draw's machines.** The Pen (`PenMachine`), Direct Selection
  (`DirectSelectMachine`) and the Freeform Pen (the Pencil's `PencilMachine`) are IMPORTED from
  `@paged-media/draw-tools`; the shapes come from `@paged-media/draw-geometry` (rectangle, ellipse,
  polygon, star, SVG path data). The machines' pointer space is the page and their inner space the
  image, with the frame fit as the affine between them, so a plan comes back in image px and is
  applied with draw's own `applyPathOps`. The image glue's lint boundary allows exactly these two
  packages (not the draw bundle) until Phase 11's C15 moves them to `platform/shared`.
- **What the tools edit** is the session's vector TARGET: the path chosen in the Paths panel, or a
  layer's vector mask. Without one the Pen and the shape tools (Path mode) start a new WORK PATH,
  which becomes the target. Shape mode makes a shape layer of the foreground colour; Pixels mode
  fills the active layer through the shape. Every commit is one undo step.
- **Stroke Path is one stroke.** The brush strokes every subpath inside one stroke session, with a
  pen-up between them (`StrokeSession::lift`), so it is one undo step whatever the path.
- **PSD.** The layered save writes a vector mask as `vmsk` (on a shape layer beside its fill
  content), a pixel layer's lone vector mask also as its cached render in channel −2 (flag bit 3,
  Photoshop's layout), a shape layer's pixels as the fill cut by its path, and the paths as image
  resources 2000… (saved, by name) and 1025 (the work path). `paged-psd` gained the writers
  (`VectorMask::encode`, `encode_path_records`) and a constructed resource block; every `vmsk` and
  path resource Photoshop wrote in the recordings re-encodes byte for byte. A layered open reads the
  PSD's paths into the Paths panel. Path names are written as legacy Pascal strings (non-ASCII names
  are not round-tripped exactly).
- **Keys.** The shortcut registers are full (INV-REG-1): the nine tools take no key, in three rail
  slots of their own (pen, path selection, shape).

## Consequences

- Make Work Path (no name) now makes or replaces THE work path, as Photoshop does; renaming the work
  path saves it.
- The layer manifest's parity block carries the vector mask (appended; older readers stop before
  it); the masking block is version 2 (operations and the work flag; version 1 still reads).
- Recorded against Photoshop 27.10 (`vector-paths.jsx`): its paths read as its DOM reports them,
  its shape layer opens editable and folds to its composite, and the PSD paged writes opens in
  Photoshop with the same paths, a solid-fill shape layer and the same composite.
- Not built: live shape properties (`vogk`), shape strokes, the Curvature and anchor-point pen
  variants inside the image, vector masks on groups, Custom Shape libraries beyond the five built-in
  shapes (no `.csh` reader), and a vector mask's feather / density as live parameters (they stay
  drawn into the user mask on import).

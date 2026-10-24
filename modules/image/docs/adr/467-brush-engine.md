# ADR 467 — The brush engine: Brush Settings as a seeded dab planner over the one accumulator

- **Status:** Accepted, 2026-10-24.
- **Scope:** `image-gpu/src/{dynamics.rs, brush.rs, dab.rs, stroke.rs}`, `image-js/src/stroke.rs` and
  `image-js/src/stroke/engine.rs`, the `brush_*` / `magic_erase` wasm doors, the `band.keep_alpha`
  kernel, the `.abr` writer (`paged-psd/src/abr/write.rs`), and the bundle's
  `brush-dynamics.ts`, `brush-presets.ts`, `abr-preset.ts`, the Brush Settings and Brush Presets
  panels and the seven tools they serve.

## Context

The paint lane stamped a round tip at a fixed spacing into a coverage accumulator and composited
the dirty rectangle from the base in one registered dispatch chain (ADR 450). Photoshop's brush
engine adds a dozen panes of per-dab variation, bitmap tips, textures, a second tip, symmetry,
smoothing, and tools whose every dab reads the one before (smudge, mixer). Strokes must stay
replayable from a recorded sample list (spec §6.3), and painting stays GPU-only.

## Decision

1. **A planner, not a second paint path.** Brush Settings is `image_gpu::dynamics::BrushDynamics`.
   The arc-length walk emits dabs; a `DabPlanner` turns each into stamps (size, angle, roundness,
   flips, scatter and count, per-dab flow and an opacity *ceiling*, colour, texture depth, brush
   pose, symmetry copies). Stamps go into the existing accumulator through an oriented tip
   (`brush::OrientedTip`, computed ellipse or bitmap). A stroke with every pane off never enters
   the planner and is byte-for-byte the earlier stroke.
2. **Determinism by a seed.** Every stroke carries a seed (SplitMix64). Each dab draws the same
   numbers in the same order whether a pane is on or not, so a stroke replays bit-identically and
   enabling one pane does not reshuffle another. The dual tip draws from its own stream.
3. **Everything that is not a stamp is mask preparation.** The dual tip, a whole-stroke texture,
   wet edges and noise shape the accumulated coverage on its way to the mask (`brush::Lowering`);
   colour dynamics build a per-pixel colour field that becomes the paint layer of the existing
   `Sample` composite. No new blend kernel; one new point kernel, `band.keep_alpha`, implements
   Lock Transparent Pixels for every tool.
4. **Wet tools composite dab by dab.** Smudge and the mixer brush read the working pixels; each dab
   is a `compose.normal` dispatch under its own mask, and the carried paint's pickup is the same
   kernel under a uniform mask. The CPU only moves windows.
5. **The wire is by name.** `brush_dynamics_keys` publishes the ordered key list; the bundle packs a
   Float32Array by key (`DYNAMICS_FIELDS`), so a key added on one side never shifts another.
6. **Conventions recorded against Photoshop** (`scripts/photoshop/probes/brush-strokes.jsx`,
   `image-js/tests/it/brush_photoshop.rs`): angles are counter-clockwise on screen, a bitmap tip is
   mirrored, then squashed, then rotated; dabs sit on the path from its start at `spacing × full
   diameter`. The hardness falloff stays this engine's plateau + smoothstep; Photoshop's is a bell
   that reaches past the radius. Recorded as a convention, not changed here.
7. **History sources** until snapshots exist: the layer as opened (before its first edit this
   session) and before its newest edit (`LayerStack::history_source`).

## Consequences

- The `.abr` reader's dynamics are applied (`abr-preset.ts`), and presets export as `.abr` v6.2 or
  as the session's own JSON (which keeps what `.abr` cannot: symmetry, lock, the dual bitmap).
- A dual accumulator doubles a stroke's coverage memory while the dual pane is on.
- The barrel rotation and stylus wheel controls work on recorded samples; the host does not yet
  forward `twist` / `tangentialPressure` on `CanvasPointerEvent`.

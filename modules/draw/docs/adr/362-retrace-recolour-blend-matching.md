# ADR 362 — A trace keeps its options and re-traces in one step; blends match structure; recolouring re-points

- **Status:** Accepted 2026-10-24.
- **Scope:** `packages/draw-bundle/src/commands/image-trace.ts` (`applyRetraceImage`,
  `traceGenerationOf`), `commands/image-trace-live.ts`, `commands/trace-presets.ts`,
  `crates/draw-trace` (`centerline`, `palette`), `commands/blend.ts` (`blendPlanFor`,
  `blendKeysOfSelection`), `commands/recolor.ts`, `packages/draw-geometry/src/blend-match.ts`
  and `color-harmony.ts`. Work packages WP6.5 and WP6.6 of the image/draw plan.

## Context

Three Illustrator rows were missing or refused: Image Trace was one-shot (no presets, no
centreline, no re-trace), a blend refused keys whose anchor or contour counts differed and
knew nothing of groups or gradients, and there was no Recolor Artwork or Color Guide. Each
could have been built as a new live object with an engine node. None needs one: the trace and
the blend already keep a recipe beside ordinary artwork (ADRs 356, 360), and a recolour is a
change of paint references.

## Decision

- **A trace keeps its options; Re-trace replaces the result in one batch.** The source's record
  keeps the resolved options, the preset id and a `live` flag. Re-trace reads them, applies the
  payload over them, and builds ONE batch: insert the new regions, dissolve the previous
  result's group, delete its regions (found by their `tracedRegion.of` marker, ADR 360), then
  finish and group the new ones — the engine's rebuild order. One undo step brings the previous
  trace back.
- **Presets are option sets, not modes.** Illustrator's names map onto the kernel's options;
  the colour counts are a deterministic k-means pre-pass in the kernel (`maxColors`,
  `grayscale`), the line-art presets the CENTRELINE mode: threshold, Zhang–Suen thinning,
  skeleton walk, RDP and Catmull–Rom lowering, open strokes at the ink's mean width.
- **A live trace re-runs inside the edit's step.** It rides the recipe auto-update's step amend
  (engine ADR 1004) through `runInStep`. It watches the `links` row AND a fingerprint of the live
  source's bytes, because `replaceImageBytes` leaves the row unchanged.
- **A blend MATCHES structures instead of refusing them.** The run with fewer anchors is split
  on its longest segments (the curve does not change), a closed run whose count differed is
  aligned to the least-movement start and direction, and missing contours grow from a point.
  Runs that already matched keep the drawn correspondence, so every earlier blend is unchanged
  (the InDesign round-trip recording pins it). Two groups blend member to member by order,
  along the line between the groups' centres; gradient keys blend stop for stop into a new
  gradient per intermediate. What cannot be matched exactly is refused with its reason.
- **Recolouring re-points; it never edits a swatch in place.** The new colours become new
  swatches (a spot's replacement a spot) and new gradients where stops change, and the
  selection's references are re-pointed in one batch. Artwork outside the selection keeps its
  colours, and an element's tint stays a tint of the replacement.

## Consequences

- No wire, protocol or contract change: every write is an existing mutation.
- A re-trace and a blend update give their artwork new ids, as every rebuild here does.
- A traced stroke has one width; a variable-width centreline is not reconstructed.
- Live Paint gap detection and edge stroking stay out: they need the engine arrangement's
  tolerance and edge ids (WP2.4).

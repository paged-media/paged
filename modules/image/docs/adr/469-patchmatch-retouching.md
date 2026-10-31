# ADR 469 — Retouching searches with multi-resolution PatchMatch; the vote is a kernel with a CPU twin

- **Status:** Accepted, 2026-10-24. Amends [ADR 450](450-gpu-only-kernels.md) for one kernel's
  twin (below). Work package WP5.8 (gaps I-50, I-51 and the classical half of I-49).
- **Scope:** `image-js/src/patchmatch.rs` (search, vote, sampling areas), `content_aware.rs`
  (Content-Aware Fill workspace, Content-Aware Move, Remove, spot healing types),
  `clone_source.rs` (sample modes, the source transform, the overlay), `heal.rs`
  (`correction_field_diffused`), the doors in `retouch_doors.rs`, the kernel `geom.patch_vote`
  (`image-kernels/src/families/geom.rs`) and the gather lane `image_gpu::execute_gather_once*`;
  the bundle's `retouch*.ts`, `ml-inpaint.ts` and the retouching panels.

## Context

Content-aware fill searched a 96-px window around each patch of a Criminisi-order fill
(`inpaint.rs`). That window was its stated limit: material further away could not be found,
and a fixed fill order could not revise an early bad choice. Photoshop's retouching set also
asks for what one exemplar search cannot express: a sampling area the user paints, rotated,
scaled and mirrored source patches, a colour adaptation, a moved object whose seam is
re-synthesised, and a Remove brush.

## Decision

1. **One search for all of it: multi-resolution PatchMatch.** An EM over a nearest-neighbour
   field (Wexler, Shechtman & Irani, IEEE TPAMI 2007) found by PatchMatch (Barnes et al.,
   SIGGRAPH 2009; generalised to rotation, scale and reflection, ECCV 2010): coarse to fine,
   propagation from the scan neighbours, a random search whose radius starts at the whole
   level, one global restart per patch. The sampling area is a mask (automatic band,
   rectangle, or painted). Colour adaptation is a clamped per-patch bias, and High / Very High
   add a gradient-domain blend of the boundary (the membrane solve of `heal.rs`).
2. **Deterministic.** Every random draw comes from one SplitMix64 stream seeded by the caller
   and consumed in scan order; the same input and seed give the same bytes.
3. **The search is CPU; the final vote is the kernel `geom.patch_vote`.** Propagation reads the
   neighbour updated a moment earlier, so the search is sequential and is input preparation,
   like the membrane solve. The vote is a gather over a packed field (three rgba16float texels
   per entry: split source centre, 2×2 transform, weight and bias) and dispatches on the GPU
   through a new, additive gather lane (inputs of their own sizes; the ABI's bindings are
   unchanged). Its scalar twin `patchmatch::vote_packed` reads the same packed field and is
   held to the kernel's tolerance (8 f16 ULPs) on a real adapter.
4. **The twin ships** (the amendment to ADR 450). Without a device the twin votes, so
   Content-Aware Fill, Move and Remove work in a GPU-less realm on a one-layer image; the
   EM's intermediate votes run on the CPU anyway, inside the search.
5. **Every result is one undo step**: the active layer journaled over the changed box, or a
   new / duplicated layer added with its pixels as one structure step.
6. **Remove has a pluggable provider.** An `ml.inpaint` provider (WP8.2) is asked first when
   one is installed; by default there is none and the classical fill answers.

## Consequences

- No search window: tests prove a fill finds material 250 px away, beyond the old 96 px.
- Quality is measured, not asserted by eye: mean colour error and seam excess against the
  ground truth of an object removed from a known background, stripes continued through a hole,
  a rotated source found only with rotation adaptation (`patchmatch.rs` tests).
- Photoshop's content-aware results are not reproducible numerically, so there is no
  Photoshop oracle for them; the conventions are recorded in `status.md`.
- The Criminisi exemplar search remains only as the spot healing brush's Proximity Match.

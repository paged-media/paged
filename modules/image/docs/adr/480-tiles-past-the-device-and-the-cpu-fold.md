# ADR 480 — The fold tile by tile past the device's limits, and on the CPU without one

- **Status:** Accepted, 2026-10-29 (WP5.13, second part; amends 450, 454 and 465).
- **Scope:** `image-js/src/layers/fold/tiled.rs` (the tiled fold, its halo, the damage
  between composites), `layers/fold/cpu.rs` (the CPU fold), `layers/fold.rs` (`Frame`,
  `run_steps` at a frame), `layers/styles.rs` (effects drawn in canvas coordinates),
  `layers/fill_render.rs` (fill layers rendered in bands), `region_filter.rs`
  (`adjust_f16_cpu`), `image-kernels/src/compose_twin.rs` (the compose family's twins, moved
  from `image-conformance`), `style.colorize`'s origin, `image-gpu`'s device limits, and the
  `composite_runs_without_gpu` check of the canvas and reopen doors.

## Context

ADR 479 left three things of the master plan's WP5.13 to the next record; this is the first.
The layer fold kept whole-canvas accumulators (`rgba16float` textures of the canvas's size) and
read the finished canvas back through one buffer. So the largest image it could composite was
the device's texture limit (16384 px on Apple silicon, 8192 on many others) — and, less
visibly, its buffer limit: the readback is `w · h · 8` bytes, and the device is opened with
wgpu's default `max_buffer_size` of 256 MiB, which a 5800 px square already exceeds. A
layered document past either could not be composited at all.

Without a device nothing was composited either: `composite` refused every stack but a single
plain layer ("compositing layers is GPU-only"), so a headless template (the Node CLI, a server
render) could open a layered PSD and not show it.

## Decision

**Past the device's limits the fold runs per tile, and every tile is the whole fold's.** When
the canvas is wider than `max_texture_dim()` or its readback larger than `max_buffer_size()`,
`composite_px` folds tiles of 2048 px (`fold/tiled.rs`):

1. The plan is made once, at canvas size (`plan_fold`; its steps hold CPU pixels).
2. Each tile is widened by the plan's HALO: how far a step reads around a texel — a style's
   blur, shift and distance field (twice its size, distance and softening), an adjustment
   layer's blur (24 px) and sharpen (5 px) — SUMMED over the steps, because a step reads what
   the steps below it made. Every step is cut to that window (`Step::window`): its plates, its
   masks, a bounded plate's rectangle (a bounded plate the window misses drops out: it is the
   identity there).
3. The window folds through the same `run_steps` the whole canvas does, with a `Frame` that
   says where the window lies on the canvas. What is drawn in canvas coordinates reads it:
   the gradient and pattern kernels take the frame's origin (`ox`, `oy`, which `gen.*` always
   had), a style's noise hashes canvas coordinates (`style.colorize` turns its two pad words
   into `ox`, `oy`), the jump flood takes the canvas's longest side, a pattern's tile is
   uploaded at its own size instead of padded to the window.
4. Only the tile's own texels are read back.

When an adjustment layer blurs or sharpens, windows start on Engine A's 256 px tile grid, so
the chain sees the tiles the whole canvas does. A tiled composite is byte-equal to the whole
one: `image-conformance/tests/it/prop_tiled_fold.rs` folds random stacks — pixel, bounded,
styled (every effect, with noise), adjustment (with blur and sharpen) and gradient-fill layers,
masks, groups, clipping, blend modes, paint dabs — both ways in tiles of 16 and 32 px on a
70 × 45 canvas, 300 cases with no byte different, and fails when the halo is taken away. A
canvas 300 px wider than the device's limit composites, against the blend's arithmetic within
one level, and a gradient fill layer across it renders without a seam.

**Fill layers render in bands** past the limits (`render_fill`), each band in canvas
coordinates.

**Between composites the tiled fold keeps its result and refolds only damaged tiles.** When
only pixels and masks changed since the last composite (a brush sample, a mask stroke, a filter
over a region), the damage is where they changed, widened by the halo, and only the tiles it
touches fold again; anything else refolds every tile. That is Engine B's evaluation model
(ADR 454) — persistent tiles, damage, recompute only the invalid ones — applied to the fold.
Engine B's `BufferGraph` itself (single-kernel op nodes over a source) is not the vehicle: a
fold is a program of steps over many sources, not a kernel, and its tiles are cut from the
layer stack, not from a graph source. The graph's op-node evaluation stays test-only.

**Without a device the fold runs on the CPU** (`fold/cpu.rs`), through the same tiled fold
(512 px tiles, so a large canvas costs a tile's memory): the same plan, each step executed
with the kernels' shipped scalar twins, every intermediate stored as f16 and every mask read
as the r16float texel the device reads. It covers pixel layers (every blend mode, opacity, fill
opacity, Blend If, knockout, a text layer's gamma), bounded layers, masks, isolated and
pass-through groups, clipping groups and adjustment layers built from the chain (the chain's
twins of ADR 465, `adjust_f16_cpu`). A LAYER STYLE and the direct adjustments (Gradient Map,
Selective Color, Color Lookup) are refused by name: their kernels have no shipped twin. A fill
layer whose render is stale needs the device for its `gen.*` render. The canvas and reopen
doors ask `composite_runs_without_gpu` instead of "is the stack trivial".

This is the third exception to ADR 450's GPU-only rule, after ADR 465 (the chain's twins) and
469 (the PatchMatch vote). The compose family's twins were the test-only reference and the PSD
flatten oracle (`image-conformance`'s `compose_ref`); they move into `image-kernels` as
`compose_twin` (features `reference` or `cpu`), and `compose_ref` re-exports them, so the
oracle and the shipped path are one body. The `cast.*`, `band.*` and `math.*` twins the fold
uses already compiled under `cpu` (`kernel_family!`).

The CPU fold agrees with the GPU fold within two premultiplied levels at 99 % of the texels,
and four at most (`prop_tiled_fold.rs`, 1000 cases), except where a blend divides: Divide, the
dodges and burns, Vivid Light and the non-separable four magnify an ulp without bound as their
divisor nears zero (measured: 9 levels on 4 texels of 3150), and the three THRESHOLD modes —
Hard Mix, Darker and Lighter Color — put a texel within an ulp of the threshold on either side
(120 levels on texels a sharpen put there), as two GPUs may. Those are held to the 99 % only,
or left to the compose parity tests.

## Evidence

- `image-conformance/tests/it/prop_tiled_fold.rs`: tiled = whole after every edit (byte-equal);
  a dab refolds one or two of sixteen tiles; a canvas past the texture limit; the CPU fold
  against the GPU fold; the CPU fold without a device, refusing a style by name.
- The existing suites, unchanged: the resident fold against the reference fold
  (`prop_layer_cache.rs`), the compose parity and PSD flatten lanes (now on `compose_twin`),
  the layer-style replays against Photoshop (`psd_layer_styles.rs`, with the colorize origin).

## Consequences

- A layered image of any size the wasm heap holds composites; past the limits the composite
  costs one fold per tile (the halo is extra work in proportion to the styles' reach).
- A headless realm composites layered documents without styles; the CLI and server renders no
  longer need a device for them.
- The plate cache and the checkpoint of the resident fold do not apply to the tiled fold; the
  tiled fold's own cache is its last result.
- The scalar compose twins now ship in the compute wasm (feature `cpu`, already on): it grows
  from 8,393,037 bytes (ADR 479) to 8,440,812 (+47,775), within the 9 MiB cap.

## Deferred

- **The residency manager's third tier** (scratch storage for tiles evicted from the heap). The
  host now has a blob store (`host.blob`, OPFS), but it is asynchronous and the layer pixels
  are read synchronously by every verb; spilling them needs a fault-in path across the wasm
  boundary. The heap remains the limit of what a session holds.
- **A CPU path for the layer styles** and the direct adjustments: their kernels need twins.

## Related

- [ADR 450](450-gpu-only-kernels.md), [ADR 465](465-cpu-twins-for-region-filters.md),
  [ADR 469](469-patchmatch-retouching.md) — the GPU-only rule and its other exceptions
- [ADR 454](454-two-evaluation-engines.md) — the engines whose model the tiled fold takes
- [ADR 464](464-layers-at-their-own-bounds.md) — bounded plates, which a window cuts
- [ADR 472](472-layer-styles.md) — the effects drawn in canvas coordinates
- [ADR 479](479-depth-and-colour-modes.md) — the first part of WP5.13

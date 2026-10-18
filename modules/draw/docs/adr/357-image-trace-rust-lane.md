# ADR 357 — Image Trace is the one Rust lane

- **Status:** Accepted. Recorded retroactively on 2026-10-02 from the code at `0d12bf8`.
- **Scope:** `crates/draw-trace`, `crates/trace-js`, `packages/draw-bundle/wasm/`,
  `packages/draw-bundle/src/trace-engine.ts`, `scripts/build-wasm.sh`

## Context

Everything else in the repo is TypeScript on purpose ([ADR 350](350-three-typescript-layers.md)).
The workspace manifest calls Image Trace the
"one capability whose kernel is not path algebra but computer vision" (`Cargo.toml:5`): colour
clustering over a raster, boundary walking and curve fitting. The `visioncortex` crate is that
kernel, and a TypeScript re-implementation would be a worse tracer that this repo would have to
maintain (`Cargo.toml:7-9`). `CLAUDE.md:456`: "The Rust half is the EXCEPTION, not the new normal."

Two more pressures shaped the boundary. A fresh checkout has to test and typecheck with no Rust
toolchain (`.gitignore:5-8`). And a sibling plugin had shipped its wasm artifact in two places
that drifted apart (`scripts/build-wasm.sh:5-11`).

## Decision

Rust was added for Image Trace only, as two crates and one committed artifact.

- `crates/draw-trace` is the kernel adapter over `visioncortex` 0.9.1: RGBA8 pixels in, regions
  of cubic contours out, in pixel space. It has no wasm dependency. A raster over 4096 px on an
  edge or 4,194,304 px in area is refused, never truncated.
- `crates/trace-js` is the wasm-bindgen surface: `traceInit`, `traceLimits` and `traceRgba`.
  Options and results cross as JSON strings. Because the artifact is built with `panic = "abort"`,
  refusals are returned as `Result<String, String>`.
- Two things stay outside the kernel. Decoding uses the browser's `createImageBitmap` and
  `OffscreenCanvas` on the bytes that `host.assets.getPlacedImage` serves. Hole orientation is
  done by `makeCompoundTable` in `draw-geometry`, the same code the compound-path command uses.
- `scripts/build-wasm.sh` builds with wasm-bindgen `--target web` into
  `packages/draw-bundle/wasm/`, which is both the path the manifest declares under
  `capabilities.wasm[]` and the path the bundle imports. The artifact is committed. The
  `wasm-bindgen` crate is pinned with `=`, and the script refuses a CLI of another version.
- The bundle instantiates the module itself, in one facade, `packages/draw-bundle/src/trace-engine.ts`,
  and not through the host's `loadBundleWasm`. The call is synchronous on the calling thread.
- The traced regions are lowered to native Polygons, colour swatches and a group
  ([ADR 351](351-shapes-are-native-page-items.md)).

## Evidence

- `Cargo.toml:3-17`, `:30-58` — why Rust; `visioncortex = "0.9.1"`, the note on its transitive
  `flo_curves` 0.3, `wasm-bindgen = "=0.2.122"`
- `crates/draw-trace/Cargo.toml:13-16`, `crates/draw-trace/src/options.rs:36`, `:44` — three
  dependencies, none of them wasm; the two caps
- `crates/trace-js/src/lib.rs:19-36`, `:47-85` — why JSON, why errors and not panics; the three
  exported functions
- `packages/draw-bundle/src/trace-engine.ts:35-46`, `:251-287` — one directory, the bundle realm,
  why the module stays at `src/` depth 1; the Node and browser load paths
- `packages/draw-bundle/src/io/raster-decode.ts:22-40` — decoding by the platform, and its cost
- `packages/draw-bundle/src/commands/image-trace.ts:40-64` — pixels through the asset door, holes
  through `makeCompoundTable`, two batches
- `scripts/build-wasm.sh:5-16`, `:33-45`; `packages/draw-bundle/manifest.json:23-30` — one copy,
  committed; the pin check; the declared wasm entry
- `.github/workflows/rust.yml:5-11` — CI rebuilds and validates; it does not compare bytes

## Alternatives considered

- A tracer in TypeScript: rejected in `Cargo.toml:7-9` and in commit `c4c26bc`.
- Codecs inside the wasm: rejected, because they would duplicate what the host realm has and
  still not cover PSD (`packages/draw-bundle/src/io/raster-decode.ts:22-28`).
- A second winding implementation in Rust: rejected (`CLAUDE.md:459-463`).
- A typed or flat-buffer boundary: left for a later version with a measurement behind it
  (`crates/trace-js/src/lib.rs:22-29`).
- Running the trace in a host worker: named as the next step, not built
  (`packages/draw-bundle/src/trace-engine.ts:66-68`).

## Consequences

The repo carries a second toolchain (Rust 1.93.0 with the wasm32 target, `rust-toolchain.toml:3-5`)
and a CI workflow of its own (`.github/workflows/rust.yml`). A bump of `visioncortex` has to
re-check the `flo_curves` note.

- The trace blocks the UI thread and cannot be interrupted. The measured worst case was 41 s for
  a noisy photo at 2048×2048, so the default decode budget is 1 MP
  (`packages/draw-bundle/src/trace-engine.ts:48-68`, `:119-122`).
- The tracer sees only what the browser decodes; a PSD or CMYK TIFF it refuses is a refusal
  here. Node has no decoder, so the headless tests drive the kernel with synthetic pixels.
- The trace is one-shot and fills only, and it is fitted to the frame's bounds: an image's own
  transform inside its frame is not readable (`packages/draw-bundle/src/commands/image-trace.ts:66-74`).
- The size numbers disagree. The manifest declares `maxBytes: 2097152`; the build script checks
  `BUDGET=$((100 * 1000 * 1000))` under a comment that says to keep the two in step
  (`scripts/build-wasm.sh:25-29`). The committed `.wasm` is 173,402 bytes.

## Related

- [ADR 308](https://github.com/paged-media/plugin-sdk/blob/main/docs/adr/308-plugin-wasm.md), [ADR 314](https://github.com/paged-media/plugin-sdk/blob/main/docs/adr/314-plugin-shape.md) — plugin wasm as a declared capability under one size budget; the general plugin shape
- [ADR 318](https://github.com/paged-media/plugin-sdk/blob/main/docs/adr/318-host-spawned-workers.md) — the worker door this lane does not use yet
- [ADR 353](353-path-algebra-runs-in-the-engine.md), [ADR 356](356-live-constructs-are-recipes.md) — the one winding implementation; one-shot results as artwork

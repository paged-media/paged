# ADR 466 — The engine's raster crates are shared: the module's Rust may depend on them

- **Status:** Accepted 2026-10-24. Amends the isolation contract: `CLAUDE.md` ("ISOLATION
  CONTRACT"), [`concept.md` §2.1](../concept.md) and [ADR 456](456-codecs.md). Follows from
  [PM-0014](../../../../docs/adr/PM-0014-capability-layering.md).
- **Scope:** the module's Rust workspace (`Cargo.toml`, `deny.toml`, `moon.yml`), `image-core`,
  `image-psd`, `image-codecs`, `image-cms`, `image-kernels`; the guards in
  `.github/workflows/image-ci.yml`

## Context

The isolation contract says "zero core contact": no imports from the engine or the editor, and
the only `@paged-media/*` dependencies are the contract packages. It was written when the module
lived in a repository of its own, where an engine dependency meant a git pin across
repositories. In TypeScript the contract-import lint rule (PM-0003) enforces it. In Rust nothing
does: `deny.toml` denies unknown registries and git sources but does not look at path
dependencies, and no `cargo tree` guard names the engine.

Meanwhile the engine needs what this module has. A PSD placed in a document does not decode in
the renderer; its TIFF decode loses ICC, CMYK and 16-bit; and its blend modes and effects have
their own code beside this module's one kernel definition ([ADR 451](451-one-kernel-definition.md)).
Two colour wrappers exist, `paged-color` in the engine and `image-cms` here. The doc and slide
modules already path-depend on the engine's model crates (doc ADR 606, slide ADR 708).

## Decision

- **Rust: the module may path-depend on `engine/core` crates** for raster codecs, PSD, pixel
  types, colour management and kernels. The dependency is a `path` dependency on
  `engine/core/crates`, from the same revision (PM-0014). Nothing else in the engine, and nothing
  in the editor, is a dependency.
- **TypeScript: unchanged.** The glue and the manifest depend on the contract packages only,
  checked by the lint rule; the plugin-SDK-only rule holds.
- **The crates move down, with their history** (planned, work package WP1.2): `image-core`
  becomes `paged-pixel` and `image-psd` becomes `paged-psd` in `engine/core/crates`, by `git mv`.
  The module keeps their old names through `package = "…"` aliases, so `use image_psd::…`
  compiles unchanged until a mechanical rename. The codecs follow into `paged-raster`,
  `image-cms`'s backends into `paged-color`, and `image-kernels` into `paged-kernels` (core
  ADR 1013), each with its own record.
- **The guards move with the crates.** The `cargo tree` invariants that hold for a moved crate
  (kernels reach no GPU crate; the wasm32 tree carries no conformance code and no `reference`
  feature) run in the engine's CI.
- **The preservation rule is unchanged** ([ADR 458](458-psd-preservation.md)): wherever the PSD
  parser lives, an unmodelled block is kept and re-emitted verbatim.

## Consequences

- **Done in WP1.2 (2026-10-24).** `image-core` and `image-psd` moved by `git mv` to
  `engine/core/crates/paged-pixel` and `engine/core/crates/paged-psd`, members of the
  engine's workspace, their tests and the `annual-layers.psd` fixture with them (the fixtures
  `image-conformance` reads stay in that crate). `Cargo.toml` names them `image-core` and
  `image-psd` through `package` aliases in `[workspace.dependencies]`; no source line of the
  module changed. `moon.yml` depends on `core`, and its Rust inputs include the two crates.
  The leaf rule both crates had here (plain data, no engine or module crate) is a
  `cargo tree` guard in `core-ci.yml`, beside one that keeps `image-conformance` and
  `proptest` out of the canvas wasm; image-ci's guards on `image-kernels` and `image-js` stay
  where they are. The engine draws a placed PSD's merged composite through `paged-psd`
  (core ADR 1005, amendment of 2026-10-24).

- `moon.yml` gains a dependency on the `core` project when the first engine crate is used, and a
  change to a shared engine crate runs this module's gates.
- The codec rules of ADR 456 (pure Rust, no vendored C, licences on the allow list, I/O-free
  sources and targets) apply to the shared crates, which the engine's `deny.toml` checks.
- A capability visible on a page item belongs in the engine (PM-0014); this module keeps the
  pixel-editing workflow, its session, its GPU pipeline and its panels.

## Related

- [PM-0014](../../../../docs/adr/PM-0014-capability-layering.md) — the layering this applies
- [ADR 456](456-codecs.md), [ADR 458](458-psd-preservation.md), [ADR 451](451-one-kernel-definition.md) — the codecs, PSD and kernels that move
- [ADR 315](../../../../platform/extensions/docs/adr/315-isolation-contract.md) — the contract extensions keep

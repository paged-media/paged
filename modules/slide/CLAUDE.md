# CLAUDE.md — paged-media/plugin-slide

paged.slide: presentations on the paged engine, a `.pptx` reader and writer, and an editor
slideshow. Dual-licensed AGPL-3.0-only OR PMEL (And The Next GmbH), `vendor/paged-ooxml`
included.

Read first: [docs/concept.md](docs/concept.md), [docs/architecture.md](docs/architecture.md),
[docs/status.md](docs/status.md), [docs/adr/](docs/adr/README.md) (range 700–749).

## Hard rules

- **All PPTX semantics live in Rust** (`pptx-*`, `slide-*` crates, one wasm module). TypeScript
  packages are glue: bundle lifecycle, panels, file input, slideshow UI.
- **The engine at runtime only through the host contract.** One crate builds on the engine's
  model: `slide-native` (`paged-model`, `paged-scene`, `paged-store`, path dependencies on
  `engine/core/crates` at the same commit, ADR 708). No other engine crate, no other module,
  no git dependency; `deny.toml` denies git sources.
- **`vendor/paged-ooxml` is read-only here** (ADR 701). Change it in plugin-doc, then run
  `scripts/sync-ooxml.sh <plugin-doc>`; CI runs `--check`.
- **PowerPoint is the oracle** (ADR 705). Fixtures are authored and recorded through PowerPoint;
  do not hand-write expected answers.
- Every source file carries the licence header; copy it from any `.rs` file.
- Commit as Dietmar Rietsch <dietmar.rietsch@andthenext.at>.

## Commands

```bash
moon run slide:test     # Rust (nextest + doctests), then wasm + bun test, from anywhere
cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace  # the Rust tests without Moon
PAGED_CORPUS_DIR=<corpus root> PAGED_REQUIRE_CORPUS=1 cargo nextest run --profile corpus --run-ignored only
scripts/sync-ooxml.sh --check
```

## Feature registry

Features and their tests are recorded in the cockpit (`~/paged/cockpit`, chapter `plugin-slide`).
A new capability gets a feature row; a new test links to one (a test name containing
`[plugin-slide.<id>]`, or an entry in the cockpit test map).

# CLAUDE.md — paged-media/plugin-slide

paged.slide: presentations on the paged engine, a `.pptx` reader and writer, and an editor
slideshow. Dual-licensed AGPL-3.0-only OR PMEL (And The Next GmbH).

Read first: [docs/concept.md](docs/concept.md), [docs/architecture.md](docs/architecture.md),
[docs/status.md](docs/status.md), [docs/adr/](docs/adr/README.md) (range 700–749).

## Hard rules

- **All PPTX semantics live in Rust** (`pptx-*`, `slide-*` crates, one wasm module). TypeScript
  packages are glue: bundle lifecycle, panels, file input, slideshow UI.
- **The engine at runtime only through the host contract.** Two crates build on the engine's
  model (`paged-model`, `paged-scene`, `paged-store`, path dependencies on `engine/core/crates`
  at the same commit): `slide-native` writes the deck (ADR 708), `pptx-export` reads the
  document back (ADR 711). No other engine crate, no other module,
  no git dependency; `deny.toml` denies git sources.
- **The OOXML foundation is shared** (`platform/shared/ooxml`, doc ADR 607): the package
  read and its memory budget, rels, the XML helpers and DrawingML colour. Change it there;
  doc and sheet build and test against the same crate.
- **DrawingML paint is read and mapped once** (ADR 722): `paged_ooxml::drawingml` reads and
  resolves fills, lines and effects; `platform/shared/dml-native` lowers them onto the engine
  model and reports what it cannot hold. A new paint or effect mapping goes there, not into
  `slide-native`. (`slide-native` and `pptx-export` therefore also build on `dml-native`.)
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
```

## Feature registry

Features and their tests are recorded in the cockpit (`~/paged/cockpit`, chapter `plugin-slide`).
A new capability gets a feature row; a new test links to one (a test name containing
`[plugin-slide.<id>]`, or an entry in the cockpit test map).

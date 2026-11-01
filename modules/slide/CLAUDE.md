# CLAUDE.md — paged-media/plugin-slide

paged.slide: presentations on the paged engine, a `.pptx` reader and writer, and an editor
slideshow. Dual-licensed AGPL-3.0-only OR PMEL (And The Next GmbH).

Read first: [docs/concept.md](docs/concept.md), [docs/architecture.md](docs/architecture.md),
[docs/status.md](docs/status.md), [docs/adr/](docs/adr/README.md) (range 700–749).

## Hard rules

- **All PPTX semantics live in Rust** (`pptx-*`, `slide-*` crates, one wasm module). TypeScript
  packages are glue: bundle lifecycle, panels, file input, slideshow UI.
- **BUILT-IN, PART OF THE CORE (PM-0017).** The Rust crates may path-depend on the engine
  (`engine/core/crates`), on `platform/shared/*` and on other built-ins, at the same commit and
  without cycles (declared in `moon.yml`); there is no git dependency (`deny.toml` denies git
  sources). Today `slide-native` writes the deck with the engine's model crates (`paged-model`,
  `paged-scene`, `paged-store`; ADR 708), `pptx-export` reads the document back (ADR 711), and
  paged.sheet is reached by path for its number formats (chart labels, ADR 710) and its workbook
  engine (live charts, `slide-sheet`, ADR 715). At runtime the open document is reached through
  the host (`host.document`, `host.nativeDocument`); the TypeScript packages import only
  `plugin-api`, `plugin-sdk` and `platform/shared/*` (the lint rule in `/bunfig.toml`, PM-0003).
  A capability another module or the engine also needs belongs in the engine or in
  `platform/shared`, not here (PM-0014, PM-0017); the register is
  `docs/development/capability-register.md`.
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

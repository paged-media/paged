# ADR 317 — Function and kernel dispatch is generated from a registry, with a coverage gate

- **Status:** Accepted. Recorded retroactively on 2026-10-02 from the code at `d90f727`;
  plugin repositories at plugin-sheets `71f37d7`, plugin-data `6b96ce5`, plugin-image `f7d21e5`,
  plugin-doc `76e1d06`.
- **Scope:** the Rust engines of plugin-sheets, plugin-data and plugin-image. Nothing in
  this repository takes part; the record is kept here because three plugins share it.

## Context

Three plugin engines each have a set of named operations: spreadsheet functions,
expression functions and pixel kernels. Each keeps one YAML row per operation in a
`registry/` directory at the repository root. A row names the operation, the Rust symbol
that implements it, its status, a provenance note and the tests that cover it.

The repositories state what the registry is for as an invariant, not as a comparison with
another design: "An unregistered function has no row, hence no `FuncId`, hence no dispatch
— uncallable by construction" (`plugin-sheets: sheet-core/build.rs:37-38`), and, for the
gate, "*every `implemented` row → real tests on disk*"
(`plugin-sheets: sheet-conformance/src/bin/coverage_gate.rs:35-36`). Why a registry was
chosen over a hand-written table is not argued. The repository does not record why.

plugin-image records what its gate was written to stop: six kernels "were written,
compiled, and passed the whole suite while absent from the registry"
(`plugin-image: image-conformance/tests/registry_drift.rs:24-27`).

## Decision

The dispatch table of an engine is generated at build time from its registry, and a gate in
the test suite ties the registry to the code. The three implementations share no code.
plugin-sheets and plugin-data are the same design, close to word for word; plugin-image
differs in both halves.

| | plugin-sheets | plugin-data | plugin-image |
|---|---|---|---|
| Registry | `registry/functions/*.yaml`, 224 rows in 18 files | `registry/functions/*.yaml`, 42 rows in 5 files | `registry/kernels.yaml`, 128 rows |
| Generated | a name-to-id table (`sheet-core`) and a dispatch `match` (`sheet-fn`), both sorted by row id so the indices agree | the same pair (`data-core`, `data-expr`) | one table of references to kernel definitions (`image-kernels`) |
| Reach of the table | the parser resolves a name through the table, so an unknown name is a parse error; evaluation goes through the generated `match` | the same | `lookup` and `registry` exist; the engines name kernel definitions by their Rust path and do not call `lookup` |
| Gate | a `coverage-gate` binary: every row with `status: implemented` must name a test file that exists and, for Rust tests, contains a function with the given prefix | the same binary, written separately | tests that the ids in the registry and the ids defined in code are the same set, in both directions |
| Where it runs | a CI step after the tests | a CI step after the tests | inside `cargo test --workspace` |

- In plugin-sheets and plugin-data a row with `status: planned` gets a dispatch arm that
  returns the engine's name error, and an arity violation returns its value error.
- The two `coverage-gate` binaries also read `registry/features/*.yaml` (162 rows in 24
  files in plugin-sheets, 73 rows in 16 files in plugin-data) and apply the same rule.
- plugin-image parses its YAML by hand in both the build script and the gate. The gate
  gives the reason: "a dependency added for a drift test would be a dependency the
  production crates carry forever".

The other plugin repositories do not have this. plugin-doc has a `registry/` directory that
holds only a placeholder file and no build script. plugin-draw, plugin-web and
plugin-publish have no registry.

## Evidence

- `plugin-sheets: sheet-core/build.rs:33-38`, `plugin-sheets: sheet-fn/build.rs:33-41`,
  `plugin-sheets: sheet-parser/src/pratt.rs:322-324` — the two generators, the id sort, the
  parse-time lookup
- `plugin-data: data-core/build.rs:33-39`, `plugin-data: data-expr/build.rs:33-40`,
  `plugin-data: data-expr/src/parser.rs:33-37` — the same in plugin-data
- `plugin-sheets: sheet-conformance/src/bin/coverage_gate.rs:33-55`,
  `plugin-data: data-conformance/src/bin/coverage_gate.rs:33-49` — the gate's rules
- `plugin-sheets: .github/workflows/rust.yml:51-52`,
  `plugin-data: .github/workflows/rust.yml:42-45` — the gate as a CI step
- `plugin-image: image-kernels/build.rs:33-42`, `:54-65`;
  `plugin-image: image-kernels/src/lib.rs:131-139` — the generated table and `lookup`
- `plugin-image: image-kernels/src/lib.rs:155-166`,
  `plugin-image: image-conformance/tests/registry_drift.rs:79-116`, `:34-37`,
  `plugin-image: .github/workflows/ci.yml:60-61` — the set equality tests; why no YAML
  crate; the test step
- `plugin-image: image-js/src/lib.rs:1738`, `plugin-image: image-js/src/stroke.rs:155-164`,
  `plugin-image: image-js/src/lib.rs:84-86` — kernels named by Rust path or taken from a
  family list; the one use of `registry()` outside `image-kernels` and the tests, a count
- `plugin-sheets: CLAUDE.md:95-102`, `plugin-data: CLAUDE.md:110-117`,
  `plugin-image: CLAUDE.md:76-78` — the rule as each repository states it

## Alternatives considered

None recorded in the repository.

## Consequences

Adding a function to plugin-sheets or plugin-data means adding a row; without one the
function has no id and no dispatch arm. The two build scripts in each repository must sort
rows the same way; the dispatch generators say so.

The gate proves that a test is named and present, not that it passes. It finds a Rust test
by searching the named file for `fn <prefix>`. Passing is the test run's job, and in
plugin-data's workflow that step ends in `|| true`
(`plugin-data: .github/workflows/rust.yml:43`).

In plugin-image the rule "No row, no dispatch" holds for the generated table only. Because the
engines reach kernels by Rust path, a kernel without a row would still run; what stops that
is the equality test, which fails when code and registry differ. No Rust source in
plugin-image reads a row's `tests` field.

Only function dispatch is generated. plugin-sheets says the same principle is "queued for
XLSX part handlers and lowering rules" (`plugin-sheets: CLAUDE.md:99-100`), and plugin-data
says it applies to "source adapters, binding kinds, and lowering rules"
(`plugin-data: CLAUDE.md:114-115`); in both, the build scripts read `registry/functions`
only, and the feature rows are read by the gate.

The row format is copied, not shared: three registries with no common schema or code.

## Related

- [ADR 314](314-plugin-shape.md) — the Rust engines this applies to
- [ADR 507](https://github.com/paged-media/plugin-sheets/blob/main/docs/adr/507-golden-corpora-coverage-gate.md), [ADR 500](https://github.com/paged-media/plugin-sheets/blob/main/docs/adr/500-own-calculation-engine.md) — the sheet engine's verification and its function library
- [ADR 550](https://github.com/paged-media/plugin-data/blob/main/docs/adr/550-own-binding-language.md) — the expression language whose functions the data registry lists
- [ADR 450](https://github.com/paged-media/plugin-image/blob/main/docs/adr/450-gpu-only-kernels.md), [ADR 451](https://github.com/paged-media/plugin-image/blob/main/docs/adr/451-one-kernel-definition.md) — the kernels the image registry lists

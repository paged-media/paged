# CLAUDE.md — paged-media/plugin-data

Orientation for Claude sessions in **paged-media/plugin-data** — the
paged.data external-data + automation subsystem, delivered as a Paged plugin
(public; dual-licensed AGPL-3.0 OR PMEL, And The Next GmbH).

## What this is

A Rust/WASM data-binding engine that makes Paged capable of **database
publishing** — the EasyCatalog category: variable replacement, dynamic tables,
image placeholders, record flow across pages, data-driven formatting, and batch
generation. The thesis: a publication is a _projection of governed data_, not a
hand-assembled artifact. Bound content is COMPILED to native Paged content via
committed Operations (the content-space / lowering model proven in
plugin-sheet), so frame ops (scale/rotate/skew/crop/reposition) are honored for
free. The **query/ingest engine is the store inside the data engine**: Turso
(`turso_core`, MIT, a Rust SQLite), compiled into `data-js` (`data-store`,
ADR 561), every file read in Rust, query rows read straight into a
`RecordSet` — the swappable seam.

Spec (the authority): [`docs/concept.md`](./docs/concept.md).
SDK gap tracker: the cross-repo RFI `thoughts/docs/paged/plugin-platform/rfi-core-sdk-gaps.md` (D-NN ids in §6; per-plugin BREAKAGE_LOG retired 2026-06-12).

Rust crates (spec §4). Since PM-0015 the engine-level ones are
`engine/core/crates/paged-data-*` in the ENGINE's Cargo workspace (library names
unchanged: `data_core`, …); this workspace keeps `data-js` (a wasm shim over
`paged-data-session`'s `DataSession`), `data-cli`, `data-script` and
`data-conformance`, which reach them by path: `data-core` (frozen
types + Expr AST), `data-expr` (the binding DSL), `data-sources`, `data-query`,
`data-bind` (resolution/sync engine), `data-lower`, `data-store` (the query
store and the file readers), `data-xlsx`, `data-js` (wasm-bindgen surface),
`data-conformance` (TEST-ONLY), plus the §10 automation lane —
`data-automation` (batch plan/run), `data-cli` (headless native CLI), and
`data-script` (sandboxed Boa surface). TS packages (`packages/*`, in the root Bun workspace):
`data-host-model` (pure LoweredContent→Mutation translation) + `data-bundle`
(manifest + `activate(host)` + panels + commands + the handle on the engine's
store, `src/query/store.ts`). ONE wasm artifact, `bin/data_js_bg.wasm` (the store
inside it, ~11 MiB), first asked of the host's module door (plugin-sdk ADR 326,
`hostWasm` in `src/bin-url.ts`): an editor may serve it from the first-party
module host, with integrity; no door or no answer → `bin/`. The spike behind
the engine is `spikes/turso/` (its own workspace, not built by the module).

**State (the live ledger is the Cockpit feature registry and `docs/status.md`,
not this prose; the 2026-10-05 analysis is `docs/design/analysis-2026-10-05.md`).**
The ENGINE is far ahead of what a user can reach from the panels:

- The binding-expression DSL is SHIPPED — its own publishing grammar (not
  Excel's), ~42 functions across format/logic/text/math/temporal, registry-
  driven FnId-parity dispatch (no row → no dispatch → uncallable).
- The binding + sync engine is SHIPPED (resolution graph + Linked/Pinned/
  Overridden/Stale/Error states + record-identity diff); record flow /
  pagination (multi-level nested grouping, per-group SUM/AVG/MIN/MAX footers,
  parent path on spill) landed in the lowering lane.
- Print automation is SHIPPED end-to-end (per-record / per-group / one-catalog
  batch plan + RUN executor + the data-cli + the data-script Boa surface).
- The D-09 data-provider contract is SHIPPED (register a provider, publish a
  RecordSet to other consumers; never knows its consumers, §7.1). The
  governed-catalog KERNEL is built (schema + column-metadata sidecar), but
  nothing reads a sidecar from a source location yet (PARTIAL).
- PERSISTENCE + REACHABILITY (wave 4, 2026-10-05): the session (sources,
  queries, bindings, data sets, imported CSV) is saved as the `session`
  container part and restored on open (`src/persist.ts`, `load_payload`); the
  Bindings panel defines every binding kind, over `SELECT *`. MERGE (wave 5):
  InDesign-style Data Merge (`data-lower/src/merge.rs` planner + `src/merge.ts`
  writer) matches all 8 InDesign recordings on real core; record flow writes
  frames (`src/flow-writer.ts`); tables/barcodes re-lower in place
  (`src/relower.ts`). SOURCES + QUERY (wave 6): local import of CSV/TSV/JSON/Parquet/XLSX
  (all read in Rust by `data-store`; XLSX via `data-xlsx`/calamine), saved with
  the document; a Data query panel (SQL + builders + preview); every query
  passes a lexer allow-list guard (`src/query/sql.ts`: one SELECT over source
  tables, no file/URL reads, no PRAGMA/ATTACH; asks the engine nothing) and runs
  on the store's `query_only` connection; `test/store-browser.spec.ts` is the
  real-browser lane (`REQUIRE_REAL_BROWSER=1`); refresh policies act (`src/refresh.ts`).
  Remote sources fetch only consented origins AND only origins the editor
  build lists (editor ADR 218, `PAGED_DATA_ORIGINS`; RFI D-03 residual).
  Still not built: DB-attach execution (`attach_plan` describes one; the
  store could `ATTACH` a SQLite file now), a worker-hosted engine. Merge to a
  NEW document ships through the host's documents door (editor ADR 219).
- DIRECTION (PM-0015, 2026-10-24): data becomes a platform layer — bindings
  in the engine model, the `data-*` crates moving to `engine/core/crates`, a
  `data@1` door, transforms and asset actions in the engine's Boa
  interpreter. The engine swap shipped (ADR 561: Turso replaced DuckDB-WASM);
  records 562–563 are reserved here.

## Project State & Feature Matrix (cockpit)

The feature inventory, test linkage and live status for ALL Paged repos are derived by
[Cockpit](https://github.com/drietsch/cockpit) from `~/paged/cockpit/` (`cockpit.toml` with
`root = ".."`; features in `cockpit/docs/features/<chapter>/<id>.md`). There is NO feature
matrix in this repo; do not create one.

Rules for every code change in this repo:

1. NEW CAPABILITY → feature file. If your change adds or completes a feature, add or update
   `cockpit/docs/features/<chapter>/<id>.md` (separate commit in `paged/cockpit`, referenced
   from this one). Feature ids are immutable; rename with `superseded_by`.
2. EVERY NEW TEST → feature link. Playwright: `{ tag: ['@feat:<id>'] }`. Rust: a test name
   ending in `__feat__<id_with_underscores>` or containing `[<id>]`. Otherwise an entry in
   `cockpit/test-map.yaml`.
3. STATUS CHANGE → `claims:` in the feature file, never prose. "X is now shipped/partial" is a
   claim edit; whether it _works_ is computed from evidence and cannot be written.
4. BEFORE claiming a feature done: `cockpit feature <id> --json` (or its page in
   `cockpit serve`) — done means the linked tests are green and were produced after the
   latest implementation commit.
5. `cockpit validate --strict` is the gate (references resolve, required evidence present and
   fresh). `cockpit pull` fetches the newest CI artifacts; `cockpit status` is the summary.
6. FOUND A BUG while working? If a test exposes it, let it fail and push — the failure shows
   up as attention on its feature. Never commit `.cockpit/`.

## Hard rules (this repo's constitution — spec §1/§2/§3/§11)

- **ALL BINDING/EXPRESSION/SYNC/LOWERING SEMANTICS LIVE IN RUST.** Expression
  parsing + evaluation, the function library, formatting, binding resolution,
  sync-state machinery, record-identity diffing, and lowering geometry are the
  `data-*` crates compiled to ONE wasm module (`data-js`). The TS packages are
  thin glue: bundle lifecycle, panels, the handle on the engine's query store,
  file input, and translating the engine's already-computed output into host
  mutations. **Never implement a binding/expression operation in TypeScript** —
  if the bundle seems to need one, the missing piece is a `data-js` API.
- **ISOLATION CONTRACT, superset (§2.1).** Zero core contact AND zero
  inter-plugin contact: the only `@paged-media/*` dependencies are `plugin-api`,
  `plugin-sdk`, and published package contracts — never `plugin-image`,
  `plugin-sheet`, or any other plugin, not at build time, runtime, or via side
  channels, even co-installed. Overlaps resolve through CORE SDK surfaces
  (image placeholders → the core asset mechanism; dynamic tables → the core
  native table contract via OUR OWN lowering code; charts → `paged.draw`),
  never a sibling plugin. The §7.1 data-provider role is a CORE SDK contract —
  `paged.data` registers a provider and never knows its consumers. TS guard: the
  contract-import lint rule (`/bunfig.toml`, PM-0003); Rust guard: `deny.toml` [sources] + the
  cargo-tree CI guards. SDK gaps become RFI §6 entries /
  plugin-platform RFCs — NEVER core modifications from this project.
- **LICENSE-BOUNDARY GATE (§3 — unique to this plugin, decisive).** NO
  source-available / ELv2 / SSPL / proprietary data engine is ever embedded,
  linked, or redistributed. Such tools are integrated, if at all, ONLY by
  consuming their data _outputs_ (tables + optional metadata sidecars) through
  the standard source adapters (§7) — touching zero engine code. The ONE
  data engine is **MIT Turso** (`turso_core`, compiled into `data-js`, ADR 561;
  a Turso upgrade moves only with the SQLite oracle replayed).
  `deny.toml` [licenses] enforces the permissive-only allow-list; any dependency
  pulling in a non-allow-listed license fails the build (the §16 license-boundary
  gate). Arrow / ADBC / `parquet` (Apache-2.0) are permitted.
- **REGISTRY-DRIVEN DISPATCH (§12.2).** The expression function table is
  generated at build time from `engine/core/crates/paged-data-core/functions/*.yaml`
  (`data-core/build.rs` emits the name→id table; `data-expr/build.rs` emits the
  dispatch match, FnId parity). No row → no dispatch entry → **an unregistered
  function is uncallable by construction**. Same principle for source adapters,
  binding kinds, and lowering rules (registry-listed). The coverage gate
  (`cargo run -p data-conformance --bin coverage-gate`) fails when an
  `implemented` row names no test that exists on disk; with
  `-- --junit target/nextest/ci/junit.xml` (as CI runs it, after nextest) it
  also fails when a named test did not run (ignored, filtered) or failed.
- **PURE KERNELS.** `data-expr` functions are pure
  `fn(&[Value], &EvalCtx) -> Value` — they never see the resolution graph, the
  scheduler, or the SDK (spec §4 rule 1). `data-lower` is pure model→IR.
  `data-host-model` (TS) is pure data→Mutation[]. Every behavior change lands
  with a test.
- **CAPABILITY-GATED DATA ACCESS + THREAT MODEL (§11 — the largest surface in
  the suite).** Network and filesystem reach are capability-gated and
  user-consented; a data-source manifest shows every origin/file a document
  touches; documents carrying queries are treated as carrying code (no
  auto-fetch on open — inert until consented). Credentials are NEVER serialized
  into the document payload. The capability/consent gate +
  `data.security.*` hard gates (no resolution of remote sources pre-consent;
  round-trip test: save→inspect→assert credentials absent). `network` reach is
  declared `origins: "consent"`: a remote source is fetched only for an origin
  the host reports as consented — never silently.
- **The bundle touches host surfaces + React only.** No `@paged-media/shell` /
  `client` imports — writes via `host.document.mutate`, binding payload via
  `setPluginMetadata` (namespace `x-paged:media.paged.data`), persistence honesty
  (binding defs + source manifests in the document payload; resolved values are
  committed content — the panel says what is and isn't persisted). Panels are
  factories closing over `BundleHost`; styling = the token layer (`--pg-*`,
  `--status-*`, `--font-mono`, `--space-*`, `--radius-*`).
- **Reserved seams stay honest.** What the engine can do but a user cannot
  reach (DB-attach execution, a worker-hosted engine) is said so in the manifest,
  the UI, `docs/status.md` and the RFI. Never fake it, and never leave a
  "not yet" message standing after the door exists.
- **CLEAN-ROOM (§3).** `references/` (any reference engine, IF ever mounted) is
  read-only, analyst-only, gitignored, excluded from all artifacts; implementers
  never read it. EasyCatalog is studied as a PRODUCT (features/UX), never as
  code. **M0: references/ is NOT mounted** — implementation derives from SQL
  standards, Arrow, public docs, and golden corpora.
- **LICENSE.** The whole repo is dual AGPL-3.0-only OR PMEL (like the editor,
  core and the SDK; ADR PM-0001). Every `.rs` carries the AGPL/PMEL
  header (copy from `data-core/src/lib.rs`). TS
  files (`packages/`, `scripts/`) carry NO header (private-side convention, like
  plugin-sheets/plugin-draw/plugin-web).
- **Interface freeze.** `data-core` types, the `Expr` AST, the `data-expr`
  calling convention (`Value`/`EvalCtx`), the `SourceAdapter` trait, the
  capability/consent model, and the registry YAML schema are FROZEN (M0 phase
  0). Changes go through the orchestrator as versioned amendments, never
  drive-by edits.

## Two-registry split

- `~/paged/cockpit/docs/features/data/<id>.md` (Cockpit, chapter `data`) — the STATUS
  ledger (component `plugin.data`; `claims:` planned/partial/shipped, health from evidence).
- `registry/` (here) and `engine/core/crates/paged-data-core/functions/*.yaml`
  — build-consumed metadata: the function rows (one per expression function:
  family, arity, provenance, test pointers — drives codegen; with the crate in
  the engine since PM-0015) and `features/*.yaml` (source/query/bind/lower/security/...
  rulings + test pointers). The ids mirror the Cockpit `data.*` ids so the
  registries join by id.

## Commands

```bash
# Everything (Rust nextest + doctests, then wasm + bun test), from anywhere:
moon run data:test
# Rust (the engine) without Moon. CARGO_INCREMENTAL=0 keeps target/ small.
cargo build --workspace
cargo nextest run --workspace --profile ci --no-fail-fast   # writes target/nextest/ci/junit.xml
cargo clippy --workspace --all-targets -- -D warnings
# The engine-level crates test in the engine's workspace; the gate takes both reports:
(cd ../../engine/core && cargo nextest run --profile ci -p 'paged-data-*')
cargo run -p data-conformance --bin coverage-gate -- --junit target/nextest/ci/junit.xml \
  --junit ../../engine/core/target/nextest/ci/junit.xml   # the §12.2 gate

# Dependency guards (CI runs these; run before claiming green)
(cd ../../engine/core && cargo tree -p paged-data-expr --edges normal | grep -E 'paged-data-(sources|query|bind|lower|store)' && echo LEAK)
cargo tree -p data-js --target wasm32-unknown-unknown | grep -E 'data-conformance|proptest' && echo LEAK
cargo deny check

# wasm artifact (100 MB app wasm budget; lands in packages/data-bundle/bin/).
# Rebuild after ANY Rust change: test/wasm-fresh.spec.ts fails on a wasm built
# from other sources (tooling/js/source-hash.mjs, stamped as bin/SOURCE_HASH).
bash scripts/build-wasm.sh

# TS (the bundle). The contract comes from the workspace (workspace:*, checked
# repo-wide by tooling/js/check-workspace-deps.mjs); CI runs with
# REQUIRE_REAL_ENGINE=1 (REQUIRE_REAL_BROWSER=1 for the browser lane).
bun install && bun run typecheck && bun run test
bun run validate:manifest

# The bundle is a private workspace package, built into the editor and never
# published on its own (PM-0008).

# Oracles (docs/design/oracles.md): replays run in the suites above
# (data-conformance oracle.rs / oracle_props.rs; data-store sqlite_oracle.rs;
# bun test indesign-merge-store). Re-recording is local only:
SQLITE3=/path/to/sqlite3 node ../../engine/core/crates/paged-data-store/tests/sqlite-sql/record.mjs
bash conformance/indesign-merge/record.sh   # drives InDesign 2025
```

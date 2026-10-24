# ADR 561 — Turso is the data engine

- **Status:** Accepted 2026-10-24. Supersedes [ADR 015](015-duckdb-wasm-vendored.md).
- **Decided by:** [PM-0015](../../../../docs/adr/PM-0015-data-and-actions-are-platform-layers.md),
  on the numbers of [`../design/turso-spike-2026-10.md`](../design/turso-spike-2026-10.md).
- **Scope:** `data-store` (the store, its readers, its clock), `DataSession::store_*` and the
  wasm `store_*` methods in `data-js`; `packages/data-bundle/src/query/store.ts`,
  `src/query/import.ts`, `src/query/sql.ts`, `src/query/builder.ts`, `src/session.ts`;
  `conformance/sqlite-sql`; the editor's dev server and build (`apps/editor`), the Node CLI's
  shims (`apps/cli/src/node-shims.ts`); CI (`data-vitest.yml`, the module-wasm action).

## Context

DuckDB-WASM 1.29.0 was the query engine (ADR 015): vendored as a prebuilt artifact, booted
by TypeScript in its own worker, answering in Arrow, which `src/query/recordset.ts` converted
into the engine's `RecordSet`. It cost:
- 40.1 MB of files (engine, worker, JS API, the json and parquet extensions) against 1.5 MB
  for the whole Rust data engine;
- a second engine the native command line did not have (`data-cli` took materialised
  results);
- no writes (nothing could edit a table in place) and no SQLite files;
- a guard against its extension autoloading, a configuration lock, an extension repository
  served from `bin/`, and an Arrow decoder, each with its own browser lane.

## Decision

The sources live in a store inside the data engine: an in-memory Turso database
(`turso_core` 0.8.3, MIT, a Rust implementation of SQLite), compiled into `data-js`.

- **Reading files is the engine's.** `data-store::read` turns CSV/TSV, JSON, Parquet and XLSX
  into typed tables in Rust:
  - **CSV.** The delimiter is sniffed. Each column is typed from its fields: integer, a decimal
    of fixed scale, real, boolean, date, timestamp, else text. A leading zero or a `+` keeps a
    column text. The file is also kept as written, every column text, for Data Merge.
  - **JSON.** Keys are kept in file order; a nested value is kept as its JSON text.
  - **Parquet.** Read through the `parquet` crate's row reader: snappy, gzip, brotli and lz4,
    not zstd, which binds C.
  - **XLSX.** Read through `data-xlsx`, with its per-column types.
- **Types SQLite lacks are declared.** A DATE or TIMESTAMP is stored as ISO text, a BOOLEAN as
  0/1, a decimal as a REAL declared `DECIMAL_S<scale>`. Turso drops a declared type's
  parameters (`DECIMAL(18,2)` reads back as `DECIMAL`), so the scale is in the name. A query
  reading such a column gets `Value::Date` / `DateTime` / `Bool` and the field's `scale` back.
- **A query's rows never leave the wasm.** `store_ingest(query, sql)` runs the SQL and hands
  the `RecordSet` to the binding session. A re-delivery of the same data is recognised by
  its content hash. The column door (`ingestColumnBatch`) stays for hosts that materialise
  rows themselves.
- **Two connections.** Imports write on one connection. Every user query runs on a second, in
  `query_only` mode, after the bundle's lexer guard. The guard still refuses PRAGMA, ATTACH and
  VACUUM, because a reader can lift `query_only` with a PRAGMA (pinned in the spike).
- **The store outlives a recipe reload.** `load_payload` (an undo naming another session
  version) keeps the store's tables, as DuckDB kept its own.
- **The clock comes from JavaScript.** Turso reads the clock through its `IO` trait; on
  `wasm32-unknown-unknown` `std::time` panics. The store's IO wraps `MemoryIO` with
  `performance.now` and `Date.now` (`data-store/src/clock.rs`).
- **One dialect.** SQL is SQLite's: the builders write `instr`/`substr` instead of
  `contains`/`starts_with`, and the guard allows `generate_series`, `json_each` and `json_tree`.
  `conformance/sqlite-sql` replays 25 cases recorded with the `sqlite3` CLI. 24 agree; the
  ordered aggregate (`group_concat(… ORDER BY …)`) is a pinned gap.

DuckDB, its worker, its extensions, `apache-arrow`, `scripts/vendor-duckdb.sh` and
`vendor/duckdb-wasm` are removed. The `QueryEngine` seam the spike recommended is the
`RecordSet`: a columnar engine could come back behind it, lazily loaded for sources above a
size threshold, if a measured need appears.

## Evidence

- **Size.** `bin/data_js_bg.wasm` is 11,399,018 B with the store, the four readers and
  Parquet's codecs, against 1,512,350 B + 40,145,773 B before. The manifest declares one
  artifact at most 16 MiB; `data_source_one_engine_artifact` checks it.
- **Speed.** At 1M rows, ingest is about 10× DuckDB's and a grouped query about 20× (the
  spike, §2). At catalogue scale (10k–100k rows) both are under a few hundred milliseconds.
  `SELECT *` into the engine is faster than DuckDB's column door was. The perf budgets: a
  refresh is one store statement and no column-door calls (W1 9 → 4 wasm calls, W5 26 → 21).
- **Fidelity.** The InDesign Data Merge CSVs agree on 89 of 90 records over the typed read
  (DuckDB's sniffer: 81). The one left is DM-5, the record flow's. They agree on 89 of 90 over
  the as-written read too. 261 of 261 fields keep their text as written
  (`indesign_merge_csvs_read_as_written`).
- **The browser.** `test/store-browser.spec.ts` imports CSV, JSON, Parquet and XLSX and runs
  the guard matrix in headless Chromium under the editor's headers, with no off-origin
  request.

## Consequences

- The engine wasm is the whole data module, so the same queries run in the editor, `paged`,
  `paged-node` and the server, and the native CLI can run SQL itself once it is given the
  store (PM-0015's order, step 4).
- A store that can be written is the ground for sheet editing and manual record order
  (PM-0015, step 7).
- A Turso release moves only with the SQLite oracle replayed (Renovate holds `turso_core` for
  approval). A gap that closes fails its pin.
- 200 crates in the wasm tree, against 82 before: ICU collation, AES and AEGIS come with Turso
  even with encryption off. `cargo deny` checks them with the module's allow-list.

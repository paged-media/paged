# Turso spike, 2026-10-24

**Measured, not read.** [PM-0015](../../../../docs/adr/PM-0015-data-and-actions-are-platform-layers.md)
replaces DuckDB-WASM with Turso. This spike puts Turso's core (`turso_core` 0.8.3, MIT) behind
the data engine's own seam and measures it against the DuckDB-WASM baseline
([`perf-baseline-2026-10-05.md`](perf-baseline-2026-10-05.md)). The code is
[`../../spikes/turso`](../../spikes/turso). It is its own Cargo workspace: the module's build
and CI never compile it, and supply-chain CI checks its dependencies with its own `deny.toml`.

## What the spike is

`data-store-spike` holds one in-memory database per `Store`, with two connections:

- **Writer.** Imports a CSV, read in Rust by the `csv` crate. Every field can stay text, as
  Data Merge reads it, or each column is typed INTEGER, REAL or TEXT from its values.
- **Reader.** Runs in `query_only` mode and returns every query as a `data_core::RecordSet`,
  the type the binding engine already consumes. No Arrow and no TypeScript are involved.

|           |                                                                                               |
| --------- | --------------------------------------------------------------------------------------------- |
| Run       | `cargo test --release` (the 1M lanes with `PERF_TURSO_1M=1`)                                  |
| wasm lane | `bun bench/wasm-1m.mjs <wasm-bindgen out dir>`                                                |
| Machine   | Apple silicon, Bun 1.4.3, Rust 1.99.1, release profile (`opt-level = "s"`, LTO), as `data-js` |

## Results

### 1. Build

- **Native and wasm.** It builds for `wasm32-unknown-unknown`.
- **Features.** Two features can't be turned off: 0.8.3 does not compile without `fs` (core
  paths call `Database::open_file`) or `uuid` (`incremental/dbsp.rs`). The store stays
  in-memory with them on.
- **The clock on wasm.** `MemoryIO` reads the clock through `std::time`, which panics on
  `wasm32-unknown-unknown` ("time not implemented on this platform"). The spike wraps it with
  a clock read from JavaScript (`performance.now`, `Date.now`), about 60 lines in `src/lib.rs`.
  Turso's own browser package solves the same problem with its own IO. Native builds use
  `MemoryIO` as is.
- **Wasm size, store alone.** 8,452,727 B after `wasm-bindgen --target web` and
  `wasm-opt -Oz --strip-debug`; 3,046,385 B gzipped. That includes `data-core`, `csv` and the
  clock.
- **Compared with DuckDB.** 35,659,694 B for `duckdb-engine.wasm`, plus 760,530 B for the
  worker, 225,361 B for the JS API, and 3,500,188 B for the json and parquet extensions:
  40,145,773 B in all. Turso is about 31.7 MB smaller. The data engine itself
  (`data_js_bg.wasm`) is 1,512,350 B and would grow by about the store's size.
- **Dependencies.** 200 crates in the wasm tree, against 82 for `data-js`. They include ICU
  collation, AES and AEGIS (built in even with encryption off) and chrono.
- **Licences.** `cargo deny check` passes: advisories, bans, licences and sources are all ok
  under the module's allow-list.

### 2. Ingest and query, 1M rows

The CSV of the baseline: 36,233,799 B; 1,000,000 rows × 4 columns (`sku, name, price, cat`,
100 categories). Grouped query:
`SELECT cat, count(*) AS n, sum(price) AS total FROM big GROUP BY cat ORDER BY cat`.

| Step                         | DuckDB-WASM (baseline) |   Turso, native | Turso, wasm under Bun |
| ---------------------------- | ---------------------: | --------------: | --------------------: |
| Ingest (parse, type, load)   |            326, 326 ms | 2,980, 3,046 ms |     5,126, 3,145 ms ¹ |
| Grouped query                |              42, 42 ms |   1,214, 963 ms |         834, 1,050 ms |
| CSV to grouped record set    |            369, 367 ms |     about 4.0 s |       about 4.2–6.0 s |
| `SELECT *` into the engine ² |             204–267 ms |     186, 182 ms |           194, 292 ms |

¹ The wasm ingest also generates the CSV text inside the module.

² For DuckDB, the column door (`arrowToColumns` and `ingestColumnBatch`). For Turso, the
query straight into a `RecordSet` in Rust, with no boundary to cross.

Where the ingest time goes (native), and the two obvious levers:

| Measurement                                                      |                                              ms |
| ---------------------------------------------------------------- | ----------------------------------------------: |
| CSV parse alone (`csv` crate, 1M records)                        |                                             352 |
| Prepared single-row INSERT in one transaction (the store's path) |                        about 2,600 of the 3,000 |
| Multi-row INSERT, 500 rows per statement                         | 4,073 (slower: the cost moves into SQL parsing) |
| Grouped query without an index                                   |                                             942 |
| `CREATE INDEX` on `cat`                                          |                                           3,832 |
| Grouped query with that index                                    |  2,875 (slower: an index scan with row lookups) |

**Reading.** Turso is a row store, so a million-row aggregation is where a columnar engine
wins:

- **Large tables.** At 1M rows, ingest is about 10× DuckDB's and the grouped query about 20×.
- **Catalogue scale.** Most catalogues are 10k–100k rows. Times scale about linearly with
  rows, so ingest is about 30–300 ms and the grouped query 10–100 ms. The binding engine's own
  resolve of a 10k-row table is 8.1 ms.
- **Results in the engine.** `SELECT *` lands in the engine faster than DuckDB's column door,
  because no boundary is crossed.

### 3. The SQL oracle (`conformance/duckdb-sql`)

All 18 cases, run as written against tables imported from the same CSVs:

| Result                   | Cases                                                                                                                                                                               |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run as written (5)       | `types-bool-varchar`, `order-text-binary`, `order-ties-secondary-key`, `csv-quoting`, `csv-type-detection`                                                                          |
| DuckDB syntax (11)       | `::` casts and typed literals (`DATE '…'`, `INTERVAL 3 DAY`) in the 8 `types-*`/`nulls-*` and `aggregate-decimal-sum` cases; the `t(v)` column alias in the 2 `order-nulls-*` cases |
| DuckDB-only function (1) | `strlen` (`utf8-roundtrip`)                                                                                                                                                         |
| Turso gap (1)            | `string_agg(… ORDER BY …)`: "ORDER BY clause is not supported yet in aggregate functions" (`aggregate-group-order`)                                                                 |

The cases test DuckDB's type system, which a SQLite engine does not have: no DECIMAL, DATE,
TIME, INTERVAL, UUID or HUGEINT storage classes. A SQLite oracle replaces them; it is recorded
with the `sqlite3` CLI the way `record.mjs` records DuckDB.

### 4. The InDesign merge CSVs (`conformance/indesign-merge/csv`)

The 8 recorded CSVs hold 261 fields.

| Import              | Fields that keep their text |
| ------------------- | --------------------------: |
| As written          |                  261 of 261 |
| With inferred types |                  250 of 261 |

The 11 fields that change are numbers with trailing zeros (`1234.50` → `1234.5`), the DM-8
pattern DuckDB's sniffer shows (81 of 90 records agree there). An as-written column, typed
when queried, keeps Data Merge exact.

### 5. The query guard

`PRAGMA query_only = 1` on the reader refuses INSERT, DELETE, CREATE and DROP. The reader can
still run `PRAGMA query_only = 0`, which is not a write, and then INSERT succeeds (pinned in
`tests/spike.rs`). So the lexer guard (`src/query/sql.ts`) stays and must refuse `PRAGMA`,
`ATTACH`, `VACUUM` and `DETACH`, as it refuses every other statement keyword. With an
in-memory IO an `ATTACH` reaches no file, but the guard does not rely on that.

### 6. Browser

The in-tree wasm runs under Bun's JavaScriptCore with the JS clock; the numbers are in §2.
OPFS persistence through `@tursodatabase/database-wasm` was not taken further. The store
persists the way the session does today: tables as the imported bytes in the `session` part,
re-imported on open. A Turso database file in a container part is an option for a later
record.

## Decision input for record 561

- **Wins.**
  - About 31.7 MB less wasm.
  - One engine in the editor, `paged`, `paged-node` and the server.
  - Results straight into a `RecordSet`.
  - A writable store: sheet editing, overrides, manual order.
  - No worker, no extension repository, no `lock_configuration` workaround.
- **Costs.**
  - About 10× ingest and 20× aggregation at 1M rows.
  - Two features that can't be turned off, and a clock shim on wasm.
  - A 200-crate tree.
  - A SQLite-dialect oracle, and the dialect changes to the query builders and diagnostics.
- **What record 561 should keep.** The `QueryEngine` seam, so a columnar adapter (DuckDB) can
  come back, lazily loaded, for sources over a size threshold, if users bring them. Imported
  tables stay as written, and types apply at query time, so Data Merge stays exact.

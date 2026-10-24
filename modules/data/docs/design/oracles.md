# paged.data — correctness oracles

**v1.0 · 2026-10-05**

Three lanes check `paged.data` against something other than itself:

- native SQLite, for queries (the store is Turso, a Rust implementation of SQLite);
- Adobe InDesign Data Merge, for merging records into pages;
- generated inputs with independent decoders, for the engine's invariants.

Each lane records its answers once, commits them, and replays them in CI without the
reference tool. Where we disagree with the reference today, the test pins the disagreement as
a numbered defect. A pinned defect stays green while the defect exists and fails the day the
behaviour changes, so the fix and the pin change land in the same commit.

| Lane       | Reference                            | Recorded in                                                                  | Replayed by                                                                                     |
| ---------- | ------------------------------------ | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| SQLite SQL | `sqlite3` CLI 3.51.0                 | `engine/core/crates/paged-data-store/tests/sqlite-sql/recorded/results.json` | `data-store/tests/sqlite_oracle.rs`                                                             |
| Data Merge | InDesign 2025 (20.0.1)               | `conformance/indesign-merge/recorded/*.json`                                 | `data-conformance/tests/it/oracle.rs`, `packages/data-bundle/test/indesign-merge-store.spec.ts` |
| Properties | generated inputs, `rqrr`, GS1 tables | (nothing to record)                                                          | `data-conformance/tests/it/oracle_props.rs`                                                     |

## 1. SQLite SQL lane

**Question.** Does a query the store runs (ADR 561: Turso, compiled into the engine) give the
answer SQLite gives? The store's path is `data-store` `Store::query` → `data_core::RecordSet`,
the result every binding reads.

**Fixtures.** `engine/core/crates/paged-data-store/tests/sqlite-sql/cases.json`: a setup (two tables, one of UTF-8 names and
cities, one of prices with NULLs) and 25 queries:

- Types and values: integers, integer division and modulo, floats with 1e300 and rounding,
  text with UTF-8, padding, tabs and the empty string, `typeof`, casts (`'12abc'` to an
  integer, a float truncated), NULL handling (`coalesce`, `nullif`, `ifnull`).
- Ordering: SQLite's default NULLS FIRST, `NULLS LAST`, `DESC NULLS FIRST`, binary text order,
  ties broken by a second key.
- Text functions: `length`, `upper` and `lower` (ASCII only, as SQLite has them), `LIKE`
  case-insensitivity, `substr`, `instr`, `replace`, `trim`, `printf`.
- Aggregates and grouping: `count`, `sum`, `total`, `avg`, `min`, `max`, `group_concat`.
- Queries: a CTE, `WITH RECURSIVE`, window functions (`row_number`, `lag`), `CASE` and `iif`,
  JSON (`json_extract`, `->>`, `json_array_length`, `json_object`), dates (`date` with
  modifiers, `strftime`, `julianday`), `generate_series`.

**Recording.** `record.mjs` runs the setup and each case through the `sqlite3` CLI in JSON
mode (`-json`) and records the rows as JSON values.

**Comparison.** A cell agrees when the store's value is the JSON value: the same string, null,
or a number within 1e-12 relative (the CLI prints 1e300 as `9.999999999999999e+299`).

**Agreement today:** 24 of 25 cases agree in full. One is a pinned gap:

- **SQ-1.** `group_concat(… ORDER BY …)`, an ordered aggregate, is not supported by Turso
  0.8.3 ("ORDER BY clause is not supported yet in aggregate functions"). The case is marked
  `gap`; the replay fails the day Turso answers it, and the pin goes in that commit.

Turso's own compatibility list names `WITH RECURSIVE` and `lag` as unsupported; 0.8.3 answers
both as SQLite does, and the lane pins that.

**Re-recording.** Any recent `sqlite3` (the one macOS ships is enough; Turso tracks SQLite
3.50's dialect):

```sh
SQLITE3=/path/to/sqlite3 node ../../engine/core/crates/paged-data-store/tests/sqlite-sql/record.mjs
```

A Turso upgrade is replayed against the recording; a changed answer is a finding to read, not
a recording to refresh (Renovate holds `turso_core` for approval).

The DuckDB SQL lane this replaced (`conformance/duckdb-sql`, 18 cases against DuckDB v1.1.1)
tested DuckDB's own type system — HUGEINT, DECIMAL widths, TIME, INTERVAL, LIST, STRUCT —
which a SQLite engine does not have; it went with DuckDB (PM-0015).

## 2. InDesign Data Merge lane

**Question.** When InDesign merges a template and a CSV, what pages, frames and text does it
produce, and how close is our record flow?

**Fixtures.** The fixtures are `conformance/indesign-merge/fixtures.json` together with
`csv/<id>.csv` and `images/`. The page is US Letter with 36 pt margins, set in Minion Pro
10/12.

| Fixture               | Checks                                                                    |
| --------------------- | ------------------------------------------------------------------------- |
| `single-record`       | one record per page                                                       |
| `multi-record-column` | Multiple Records, one column, 12 pt row spacing, 12 records over 2 pages  |
| `multi-record-grid`   | two columns, rows first                                                   |
| `long-record-set`     | 57 records in no column's sort order, two columns, columns first, 3 pages |
| `empty-field-lines`   | Remove Blank Lines for Empty Fields                                       |
| `overset`             | a record whose text does not fit its frame                                |
| `number-text`         | en/de numbers, leading zeros, signs, exponents                            |
| `image-field`         | an `@photo` image field, fitted proportionally and centred                |

**Recording.** `record.sh` drives the local InDesign through `record.jsx`. The script builds
each template from the fixture spec, then turns every `<<field>>` into a real Data Merge text
placeholder and each image frame into an image placeholder. It saves the template as
`templates/<id>.idml`, which InDesign wrote itself, so that Step 5 can open it. It then runs
`mergeRecords()` and writes `recorded/<id>.json`: page count, and for every page each text
frame (bounds, the frame's own text, line count, overset) and each rectangle (bounds, placed
image name and bounds). The script stages files in the fixed directory
`/tmp/paged-data-merge-stage`, so the IDML's data-source path is the same on every
re-recording. It also turns user interaction off and closes every document without saving.
Two complete recordings produced byte-identical JSON.

```sh
bash conformance/indesign-merge/record.sh                      # all fixtures
PAGED_DM_ONLY=overset bash conformance/indesign-merge/record.sh # one fixture
```

Re-record one fixture at a time when one answer is in doubt. A recording is evidence, and
rewriting all of them at once hides which answer changed.

**Replay** (`oracle.rs`, no InDesign) runs three checks.

1. **The rule.** This closed form reproduces all 8 recordings exactly:
   - records per column = ⌊(H + row spacing) / (h + row spacing)⌋;
   - columns = ⌊(W + column spacing) / (w + column spacing)⌋;
   - record _k_ goes on page ⌊_k_ / (rows·columns)⌋, in CSV order, placed rows first or
     columns first;
   - each frame sits at margin + (column·(w + column spacing), row·(h + row spacing)).

   H and W are the margin box, h and w the template frame. Single Record mode gives each record
   its own page at the template position. Remove Blank Lines drops a line only when the line
   holds nothing but fields and every one of them is empty. Field text is inserted verbatim.
   This is the rule the Step 5 merge writer implements.

2. **The merge planner** (Step 5). `DataSession::plan_merge` (`data-lower/src/merge.rs`) plans
   the merge from the fixture's template frames over the same text ingest. Every planned text
   frame is put on the grid from its bounds, as InDesign's frames are.

   **The record flow** (reference lane). `DataSession` resolves a record-flow binding whose template comes from the
   fixture lines. It ingests the CSV with every field as text, as Data Merge reads it, and with
   empty fields as null. `paginate_flow` packs the records into the
   natural chain: one frame per page of the template frame's height for Single Record, and one
   frame per column of the margin-box height for Multiple Records.

3. **The paginator at InDesign's pitch.** `paginate_flow` alone, given CSV order and records
   of frame height + row spacing.

**Comparison and tolerances.**

- InDesign frames are placed on the record grid from their bounds. The bounds must sit on the
  grid, and match the template frame's size, within **±0.5 pt**.
- Text is compared exactly after normalisation: `\r` becomes `\n`, and U+FEFF is removed (InDesign
  leaves these marks where an empty placeholder was).
- InDesign's text for an overset frame is only the part that fits, so ours must _start with_
  it.
- The score reports:
  - pages, ours against InDesign's;
  - placements that agree, meaning the same page, row, column and text;
  - texts that agree wherever they sit;
  - overset flags that agree;
  - image names that agree.

  Every lane's score is pinned per fixture.

**Agreement today.** The merge planner agrees with all 8 recordings in pages, placements, texts
and images. The one exception is the overset flag of `overset` (1 of 2): the planner does not
measure text. The host writer measures it, and the writer lane below agrees in full.

The record flow and the paginator are reference lanes (flow / paginator, placements agreeing out
of records). The record flow is EasyCatalog-style continuous flow, not Data Merge, so its
divergences are what it is:

| Fixture             | Pages (ours/InDesign) | Placements    | Texts                            |
| ------------------- | --------------------- | ------------- | -------------------------------- |
| single-record       | 2/3 · 3/3             | 0 · 3 of 3    | 3 · 3                            |
| multi-record-column | 1/2 · 2/2             | 10 · 12 of 12 | 12 · 12                          |
| multi-record-grid   | 1/1 · 1/1             | 1 · 1 of 7    | 7 · 7                            |
| long-record-set     | 2/3 · 3/3             | 0 · 57 of 57  | 57 · 57                          |
| empty-field-lines   | 2/3 · 3/3             | 1 · 3 of 3    | 2 · 3                            |
| overset             | 2/2 · 2/2             | 0 · 2 of 2    | 2 · 2 (overset flag 1/2 in both) |
| number-text         | 2/3 · 3/3             | 1 · 3 of 3    | 3 · 3                            |
| image-field         | 2/3 · 3/3             | 0 · 3 of 3    | 3 · 3 (images 0/3)               |

Over the text ingest, the engine's record texts agree with InDesign's except where blank-line
removal (DM-5) applies. Its placement agrees only by accident. The paginator's packing
arithmetic agrees for every columns-first layout.

`indesign-merge-store.spec.ts` runs the same CSVs the way a user's file goes, into the engine's
query store (types inferred) and through the `data-js` record flow, and compares texts only.
89 of 90 records agree (DuckDB's sniffer agreed on 81): a decimal column keeps its written
scale and a column of codes (leading zeros, a `+`) stays text. The one left is DM-5.

**The writer lane** (`packages/data-bundle/test/merge-real-core.spec.ts`, real core and the
real data-js wasm). It opens each `templates/<id>.idml`, reads the template off the page
(`src/merge.ts` `readMergeTemplate`), merges the CSV into the document with the template page
consumed, and reads the result back through the host, independently of the plan:

- page count;
- text frames per page;
- at each recorded frame's centre, our frame's page-local bounds (±0.5 pt) and story text;
- the overset flag of every record;
- the placed image names per page.

All 8 fixtures agree in full. Undoing the merge's mutates (one, or two when pages are added)
restores the template.

One core defect is pinned there (`it.fails`): the IDML import moves a paragraph mark that sits
between two adjacent `HyperlinkTextSource` elements two characters into the second one. Every
Data Merge placeholder is such a source, so `<<name>>¶<<subtitle>>` reads back as
`<<name>><<¶subtitle>>`. This affects `empty-field-lines` and `overset`. Their writer check uses
the template text InDesign holds.

**Defects** (DM-1 to DM-7 are closed for Data Merge by the planner and writer; the record-flow
lane still shows them, by design):

- **DM-1.** There is no Single Record mode: the flow packs as many records as fit into a frame.
- **DM-2.** The record flow re-sorts records by full row content (`stabilize`). Data Merge keeps
  data-source order, so `long-record-set` places 0 of 57.
- **DM-3.** The record pitch is lines × leading, where Data Merge uses frame height + row
  spacing. As a result 20 records land per page where InDesign places 10.
- **DM-4.** The chain fills column by column, and there is no rows-first arrangement.
- **DM-5.** There is no Remove Blank Lines for Empty Fields.
- **DM-6.** A record-flow template has no image field.
- **DM-7.** The record height is not measured text, so an overset record is not flagged.
- **DM-8.** A CSV column read as a float loses its trailing zeros (`1234.50` prints as
  `1234.5`). Data Merge prints the field text. FIXED. A decimal column carries its scale
  (`Field.scale`), and the store types a column of fixed decimals as one (`DECIMAL_S2`,
  ADR 561), so a bare reference displays `1234.50`; a column of codes (`0007`, `+12`) stays
  text. Data Merge also reads as written (since 2026-10-20): the store keeps every CSV twice,
  typed and as written (every column text), and a merge (`session.ts`, `asWritten`) runs its
  query over the as-written tables, so a field is the text as written (`9.90`, `1234.50`,
  `01/02/2026`); a value is typed only where the query asks for one (a `CAST`, a computation).
  A query that does not run over text (arithmetic without a `CAST`) merges the typed values and
  says so. `indesign-merge-store.spec.ts` runs both reads; both agree with every InDesign text
  except the record flow's own DM-5. A sort over the as-written table is a text sort:
  `ORDER BY CAST(price AS REAL)` sorts numbers.

## 3. Property lane

`oracle_props.rs` uses proptest with 256 cases per property.

| Property                                                                                                      | Feature                   |
| ------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `stabilize` gives the same result for any shuffle of mixed-kind rows (NaN, ±0, ±∞, text, dates), keyed or not | `data.query.seam`         |
| `stabilize` returns a permutation, is idempotent, and follows value order within a kind                       | `data.query.seam`         |
| `diff(old, new)` applied to old yields new                                                                    | `data.bind.engine`        |
| the payload survives save → JSON → load → save unchanged                                                      | `data.plugin.bundle`      |
| a second resolve and a second change report without a data change are no-ops                                  | `data.bind.change-report` |
| EAN-13 (every first digit) and UPC-A decode back with independent GS1 tables                                  | `data.barcode.symbology`  |
| Code-128 (printable ASCII and digit runs that switch B↔C) decodes back                                        | `data.barcode.symbology`  |
| QR (byte mode, level M, 1–213 bytes, so versions 1–10) decodes back with `rqrr`                               | `data.barcode.symbology`  |

QR is decoded with `rqrr`, an independent decoder (MIT OR Apache-2.0, a dev-dependency only).
The harness was first validated on a reference matrix from python `qrcode`. Code-128 has no
small, permissive, pure-Rust decoder, so the test carries its own. It reads the bar and space
widths, looks them up in the published ISO/IEC 15417 width table (a different form from the
encoder's module strings), checks the mod-103 check symbol, and runs code sets A, B and C. The
published "Wikipedia" vector anchors it, and it rejects a symbol with one module flipped.

**Defects pinned** as `defect_*` tests:

- **DB-1 (fixed).** EAN-13 G-parity symbols were written inverted: digit 0 came out as
  `1011000`, not `0100111`, so every EAN-13 whose first digit is not 0 was unscannable. G is now
  R reversed, per the GS1 table. The EAN-13 property draws every first digit, and
  `data_db1_*` keeps the GS1 worked example as a regression.
- **DB-2 (fixed).** QR symbols did not decode. Their data modules matched a reference encoder
  with the same version, level and mask, but the format information was written bit-reversed
  and the dark module was cleared. Versions 7–10 also lacked their version information. All
  three now follow ISO/IEC 18004. The QR property decodes every payload with `rqrr`. A data-barcode
  unit test decodes every version (1–10) under every mask (0–7), and the matrices match python
  `qrcode` module for module (checked once, 80 of 80).
- **DP-1.** FIXED (Step 2): dates and times before 1970 stabilized after later ones, because of
  big-endian two's-complement byte keys. The sort key now flips the sign bit.
- **DP-2 (fixed).** An f64 in the payload drifted by one ulp through serde_json, which was built
  without `float_roundtrip`. The workspace now enables it (+8 bytes of wasm). The payload
  property draws any finite f64. The wasm boundary was always exact.
- **DP-3.** FIXED (Step 2): `RowDelta.removed` held internal key encodings (`"3:k2\u{1f}"`), so a
  change report could not name the rows it removed. It now holds their indices in `old`.
- **DP-4.** FIXED (Step 2): a variable binding followed the delivery order, so the same rows
  delivered in another order reported a change. Record N is now record N of the stabilized
  order, for every per-record kind.

## Feature links

- **Rust:** test names end in `__feat__<id>`.
- **Vitest:** the describe titles carry `[data.query.seam]` or `[data.lower.content]`.

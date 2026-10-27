# ADR PM-0015 — Data and actions are platform layers

- **Status:** Accepted 2026-10-24.
- **Amends:** [PM-0002](PM-0002-built-ins-and-extensions.md) (built-ins and extensions reach data
  and actions through two doors) and applies [PM-0014](PM-0014-capability-layering.md) to data
  binding and to computed steps over assets and tables.
- **Scope:** `modules/data` (its crates, its query engine and its bundle), `engine/core` (model,
  script bridge, the planned `paged-data-*` and `paged-action` crates), `platform/extensions`
  (the `data@1` and `actions@1` doors), `apps/editor` (the Data panel, the bind popover, field
  markers), `modules/sheet`, `modules/image`, `modules/draw`, `apps/cli`.

## Context

paged.data is a module (L4) behind an isolation contract. Everything else that wants data
reaches it sideways:
- **Data providers.** sheet and web consume the data-provider contract (`host.dataProviders`),
  and sheet also publishes ranges through it.
- **Template fields.** The engine's template policy names a `Data` field kind
  (`engine/core/crates/paged-template/src/policy.rs`).
- **The editor.** Its property fields offer "Bind to data…" by invoking paged.data's command
  (`apps/editor/packages/shell/src/catalog/property-field-model.ts`).

A binding is paged.data's private recipe, kept in its session and labels. No other lane
evaluates it: export, the headless host and the other modules see only the content it wrote.

Property bindings already reach any property `host.objects` describes (data ADR 558, proposed):
core objects and the object kinds doc, sheet, slide, draw, image, web and data contribute
(extensions ADR 329).

The query engine is DuckDB-WASM (data ADR 015), and its costs are measured:
- **Size.** 35.7 MB of wasm plus 3.5 MB of extensions, against 1.5 MB for the whole Rust data
  engine. The data module is 40.6 MB of the app's 94.7 MB.
- **Language boundary.** It lives only in TypeScript, so the native command line has no SQL
  (`data-cli` takes materialised results).
- **Read-only.** Nothing can edit a table in place.
- **No SQLite.** SQLite files can't be read (`sqlite_scanner` can't see DuckDB-WASM's registered
  files).

Computed steps over assets and tables have no common home either:
- the image module's filter stacks and the draw module's generators are reachable only inside
  those modules;
- data's batch scripts run in a second Boa interpreter (`modules/data/data-script`) beside the
  engine's (`engine/core/crates/paged-script`).

A data row that names an image by URL has no way to fetch it, fit it or convert it before it
is placed.

## Decision

### Data is layered like every other capability

| Layer | What lives here |
|---|---|
| **L1 Engine model** | A binding is part of the document model: a node or property path, the expression, and the record context it resolves in. It is exported to IDML labels as paged.data writes them today, so InDesign keeps it. |
| **L2 Engine crates** | `paged-data-*`, moved from `modules/data` with their history: the binding language, the sync engine, lowering, the store, and the readers for CSV, JSON, Parquet and XLSX. |
| **L3 Host and door** | `data@1` in plugin-sdk: records of a query, change subscription, bind and unbind a target, writing rows, transforms. The host's Data panel, the bind popover on every property field, the field markers on the canvas. |
| **L4 Module** | paged.data keeps its workflows: Data Merge, catalogues, record flow and pagination rules, record templates, batch. paged.sheet edits a data table through `data@1`. |

A module or an extension that needs records or bindings uses `data@1`, announced by
`supports("data@1")`. The data-provider contract stays as it is until `data@1` replaces it, and
is then kept as a compatibility path.

### Third parties get the same reach as built-ins

`data@1` and `actions@1` are part of the public contract, in plugin-sdk (with plugin-api, its
`./api`), not a door for built-ins only.
- **Extensions.** A community extension can read records, bind its own object kinds'
  properties, write rows, and register and run actions exactly as a built-in does. It depends
  on nothing private.
- **The SDK test harness.** `fake-editor.ts`, `harness.ts` and `testing.ts` implement both
  doors over an in-memory store, so an extension's tests need neither the editor nor paged.data.
  `paged-plugin` scaffolds and validates manifests that declare them.
- **The command lines.** The `paged` CLI (Rust) and `paged-node` (`@paged-media/paged`) expose
  the same operations as verbs: query, bind, apply, merge, generate, and run an action, with
  their MCP tools. The `paged-node` verbs, which today drive paged.data's typed commands
  (`apps/cli/src/data.ts`), are moved onto `data@1`, so a third-party module's data and actions
  are reachable from scripts and CI too.
- **One semantics.** Each operation is checked against the same goldens and conformance
  layers as the rest of the surface (`docs/development/testing-cli-and-scripting.md`), so
  editor, SDK and CLI cannot drift.

### Turso replaces DuckDB as the one data engine

The store is Turso (`turso_core`, MIT, a Rust implementation of SQLite). It is compiled with
the data engine, so the same engine answers in the editor, in `paged`, in `paged-node` and on
the server.
- It is writable, which gives sheet editing, manual record order and overrides in the store.
- Its change data capture (CDC) drives sync states and refresh.
- Files are read in Rust: CSV, JSON, Parquet and XLSX (the last already is, `data-xlsx`).

DuckDB is removed from the bundle. It comes back only as an optional, lazily loaded adapter
behind the same seam, and only if a measured need appears. The decision is carried out after a
measured spike, recorded in `modules/data/docs/design/`. Data ADR 561 records the engine once
the code exists, and supersedes ADR 015.

### An action is a platform concept

An action is a named, typed, pure step: an input (an asset, a table, a snapshot of a selection)
and parameters produce an output.
- **Caching.** Its result is cached under the hash of the input and the hash of the action
  chain with its parameters, so running it again computes nothing.
- **Actions versus commands.** A command (extensions ADR 329) changes the document; an action
  only computes. A command may apply an action's result in one undo step.
- **Registration.** Built-ins and extensions register actions through `actions@1`. The
  registry, the chain runner and the cache key live in an engine crate, `paged-action` (L2).
- **What is registered.**
  - The image module registers its filter stacks, fit, crop, colour conversion and sharpening,
    reached through the engine crates PM-0014 plans (`paged-raster`, `paged-kernels`,
    `paged-color`).
  - Draw registers tracing and recolouring, and the host's ML service registers background
    removal.
  - Data registers transforms over tables.
  - Publish registers preflight fixes.
- **Asset columns.** A data column that names assets by URL or path is an asset column. Each
  asset is fetched through the existing consent and origin gate, kept by content hash in the
  host's blob store, and run through the column's action chain before it is placed. A missing
  asset is shown as missing, never skipped.

### One script interpreter

Transforms and actions written in JavaScript run in the engine's Boa interpreter, the one that
already runs `paged.*` scripts: in the editor's worker, in `paged`, and on the server. The
interpreter gains `paged.data.*` and `paged.actions.*`.
- **`paged-node`** (Bun) runs the same sources for batch and server jobs. An action that needs
  npm runs only there and is marked as headless-only.
- **No second semantics.** A transform gives the same result wherever it runs.
- **data-script.** paged.data's own interpreter merges into the engine's.

## Reserved records

| Record | Topic |
|---|---|
| data 561 | Turso is the data engine; the `QueryEngine` seam; supersedes 015 |
| data 562 | Transforms: JavaScript over tables, stored in the document, run in the engine's interpreter |
| data 563 | Asset columns: fetch, content-addressed cache, action chains per column |
| core 1014 | Bindings are part of the document model ([accepted](../../engine/core/docs/adr/1014-bindings-live-in-labels-and-the-engine-applies-them.md) as: they live in labels, and the engine reads and applies them) |
| core 1015 | `paged-action`: the action registry, chain runner and cache key; `paged.actions.*` in the interpreter |
| extensions 343 | The `data@1` door, public, with its harness fake and CLI verbs |
| extensions 344 | The `actions@1` door, public, with its harness fake and CLI verbs |
| editor 291 | The Data panel: the record grid, sync status, drag to place, record templates |
| editor 292 | The bind popover: field, rules, map or expression on any property field |

## Order

1. **Spike.** Turso inside the data engine, measured: build for wasm, ingest and query time
   against the DuckDB baseline, the SQL and InDesign merge oracles, the query guard, and the
   browser.
2. **Engine swap.** In `modules/data` (561).
3. **Move down.** The crates move into `engine/core/crates` (PM-0014 rules: `git mv`, aliases,
   guards move along); bindings join the model (1014).
4. **Doors.** `data@1` and `actions@1` (343, 344) in the public SDK, with harness support;
   paged.data, paged.sheet and the `paged-node` data verbs move onto them.
5. **Editor.** The Data panel and the bind popover (291, 292).
6. **Actions.** Transforms, actions and asset columns (1015, 562, 563), with image and draw
   actions after `paged-raster` and `paged-kernels` land.
7. **Sheet editing.** Write-back through `data@1`.

## Consequences

- Bindings are evaluated by the engine, so export, the headless host and every module see the
  same resolved content, and a template's `Data` field no longer depends on one module being
  loaded.
- The editor's wasm shrinks by the DuckDB artefact once the engine swap ships.
- SQL becomes available on the command line and the server.
- paged.data's "one bundled engine is MIT DuckDB-WASM" rule (data ADR 015 and its `CLAUDE.md`)
  is replaced by "one engine, Turso, compiled in". The licence gate is unchanged: Turso and its
  dependencies must pass `deny.toml`.
- **Headless image actions** need either a GPU-capable host or the CPU twins of the kernels
  promoted to a supported backend. That is decided with `paged-kernels` (core 1013).
- **The `plugin-sdk` version** gains a minor step for each of the two doors.

## Amendment (2026-10-25): headless image actions

The open point on headless image actions is settled by image
[ADR 467](../../modules/image/docs/adr/467-cpu-resample-for-headless-actions.md), ahead of
`paged-kernels`: a CPU resample (the leaf engine crate `paged-resample`) is a supported backend
for the headless and batch actions, and the GPU kernels stay the editor's interactive path. The
image module's `resize`, `fit` and straightened `crop` run on it in every realm, so an action's
result does not depend on whether the realm has a device; the two backends agree within one
8-bit level on opaque pixels. The adjustment chain already ran without a device on its CPU
twins (image ADR 465). Neither needs a GPU-capable host.

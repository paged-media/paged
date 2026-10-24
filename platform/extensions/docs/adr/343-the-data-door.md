# ADR 343 — The data door: one bundle serves the document's data, any bundle reads, writes and binds it

- **Status:** Accepted 2026-10-24.
- **Scope:** `DataSurface`, `DataService` and their types in `packages/plugin-api/src/host.ts`;
  `capabilities.data` (`manifest.ts`, `manifest.schema.json`, `bin/paged-plugin.mjs`);
  `packages/plugin-sdk/src/doors-data-actions.ts` (`createDataRegistry`, the gated surface),
  `host-impl.ts` (`options.data`, the `data@1` flag), `harness.ts` (a shared backend by default),
  `testing.ts` (`fakeDataService`). Served by paged.data (`modules/data/packages/data-bundle/src/
  data-door.ts`); the editor injects the backend (`apps/editor/apps/canvas/src/
  plugin-host-options.ts`). Decided by
  [PM-0015](../../../../docs/adr/PM-0015-data-and-actions-are-platform-layers.md) (record
  "extensions 343").

## Context

The document's data lived inside one module. Another bundle could reach it only through the
data-provider registry (D-09, `dataProviders@1`), and only as published snapshots. It could not:

- list the tables;
- read a window of one;
- write a row (paged.sheet as the data editor needs to);
- bind one of its own objects' properties.

PM-0015 makes data a platform layer, and requires that a third-party module reach it as a
built-in does.

## Decision

**A door in the public contract.** `host.data` (`data@1`) has three sides:

- **Serve.** One bundle serves the document's data: `serve(service)`, gated on
  `capabilities.data.serve`. One service at a time: a second `serve` while one is live throws.
  paged.data serves in the editor.
- **Read, write, bind.** Every other bundle reads, writes and binds through the host, gated on
  `capabilities.data.{read, write, bind}`:
  - `tables()`: the source tables and the queries, each with its schema, row count, revision and
    whether it is writable;
  - `records(table, {offset, limit})`;
  - `query(sql)`;
  - `write(table, edits)`: set, insert and delete rows of a source table;
  - `bind`, `unbind` and `bindings`: a property binding (ADR 558) on any address or selector;
  - `evaluate`, `status` and `refresh` (amended 2026-10-24, editor ADRs 291 and 292): an
    expression's value at a record, each binding's sync state, and an update of the document;
  - `placements` (amended 2026-10-24, read role): each page item a binding places content in,
    by ADR 131 address, with the binding's sync state (the editor's canvas field markers);
  - `place(target, query, field)` (amended 2026-10-24, bind role): a query's field placed on
    one page item (editor ADR 291's drag to place); the service picks how (paged.data: a
    variable in a text frame's story, a graphic frame's picture) and refuses what it cannot;
  - `onDidChange`: a table and its new revision.
- **Routing only.** The host routes calls and fans out changes; no bundle names another.

**The record shape is the provider shape.** `records` and `query` answer a `ProviderRecordSet`
(`{schema: {fields: [{name, ty}]}, columns, rowCount}`). A consumer of `dataProviders@1` reads
`data@1` with the same code. paged.data's answers come from the engine's store:

- `store_records`, a window in the table's order;
- `store_query_records`, after the query guard, the same guard the engine's CLI uses (core ADR
  1014);
- `store_edit`, one transaction. The as-written twin follows, so Data Merge reads what was
  written.

**Honest absence.** The surface is always present.

- Without a backend, every call rejects and `supports("data@1")` is false.
- With a backend but no live service, calls reject saying no bundle serves the data.
- A member the service leaves out (a read-only service without `write`) is refused with that
  reason.
- A role used without its capability is a `PluginCapabilityError`.

**Testable without the editor.** The harness injects a shared backend into every host it builds.
`fakeDataService(tables)` is an in-memory service: it reads and writes rows, records bindings and
answers `SELECT * FROM <table>`. It refuses other SQL rather than imitating it.

**The data-provider registry stays.** `dataProviders@1` remains as it is, as the compatibility
path PM-0015 names.

## Consequences

- paged.sheet can edit a table in place (PM-0015 step 7), and an extension can bind its objects'
  properties to data without depending on paged.data.
- A bundle's tests run against `fakeDataService`, or against the real paged.data through the
  headless harness (`data-door-real-core.spec.ts`).
- The command lines reach the door. `paged-node data <doc>` reads it as any bundle does: the
  tables, a window of one (`--table`, `--offset`, `--limit`), a guarded `--query`, after an
  optional `--data` import. `apply`, `merge` and `generate` keep paged.data's typed commands for
  what the door has no member for (Data Merge, batch plans). The engine's `paged data` verbs
  (core ADR 1014) read and apply a document's bindings without the module.
- plugin-sdk and plugin-api 0.74.3-canary.18.

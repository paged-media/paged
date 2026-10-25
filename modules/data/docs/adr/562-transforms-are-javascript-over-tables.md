# ADR 562 — Transforms are JavaScript over tables, stored in the document, run in the sandboxed interpreter

- **Status:** Accepted 2026-10-24.
- **Scope:** `TransformDef`, `DocumentPayload::transforms`, `DataSession::{define_transform,
  remove_transform, transforms, run_transforms}` (`engine/core/crates/paged-data-session`); the
  wasm `define_transform`, `remove_transform`, `transforms`, `run_transforms` (`data-js`); the
  bundle's `defineTransform`, `removeTransform`, `listTransforms`, the refresh order
  (`src/session.ts`) and the data door's derived tables (`src/data-door.ts`). Decided by
  [PM-0015](../../../../docs/adr/PM-0015-data-and-actions-are-platform-layers.md); runs on core
  [ADR 1015](../../../../engine/core/docs/adr/1015-paged-action-the-action-registry.md).

## Context

SQL is the first tool for shaping data, and it covers joins, filters, grouping and computed
columns. Some reshaping is clumsy or impossible in it:

- a lookup with fallbacks;
- text built by rules;
- a nested JSON field spread into columns;
- a catalogue's row order computed from several tables.

PM-0015 asks for the scripting layer to transform and combine data before it is placed, with one
interpreter and no second semantics.

## Decision

**A transform is a function over tables.** A `TransformDef` has four parts:

- `id`, the name of the table it gives;
- `inputs`, source tables or earlier transforms;
- `source`, a function expression `(tables, params) => rows`;
- `params`.

`tables[name]` is the rows of each input as objects; `rows` is an array of objects. The keys'
order is the column order, and the types are inferred as an import infers them: the output goes
through the store's JSON reader. A transform returns JSON text from inside the interpreter
(`JSON.stringify`), so key order survives the crossing.

**It is part of the recipe.** Transforms are saved with the session payload (`transforms`,
omitted when empty, so a recipe without them is byte-identical). A document carrying one carries
code, so it runs sandboxed. It runs as a `paged-action` JS action:

- no host function: no fetch, no file, no `paged`;
- a loop and a recursion budget;
- a fixed clock.

It can compute and nothing else.

**The refresh order.** Sources are imported, transforms run in order, then queries refresh. Each
transform replaces its table in the store, where queries, bindings and the data door read it.
The door lists it as a read-only, derived table: `write` is refused and points at the source
tables. A failure is reported, never skipped silently, and the transform's table is left out:

- a reference error (`fetch is not defined`);
- a missing input;
- a result that is not an array of rows.

A later transform that reads the missing table fails in turn, saying so.

**Names are compared as SQL compares them.** The store keeps a quoted table name folded
(`lowStock` is listed as `lowstock`). `Store::records` and `Store::edit` compare names
case-insensitively, as SQL does, so a mixed-case transform or source is found.

## Consequences

- The same transform gives the same table in the editor, `paged`, `paged-node` and the server:
  one implementation (`paged-data-session` over `paged-action`).
- The data engine wasm grows by Boa (+3.25 MiB, ADR 1015).
- The pipeline view (source → SQL → transform → output, each step previewable) is the Data panel's
  (editor ADR 291).
- The refresh makes one engine call more: the perf budgets W1 4 → 5 and W5 21 → 22 wasm calls.
- Amended 2026-10-24: the pipeline view is built. The data door serves `pipeline()`,
  `defineTransform` and `removeTransform` (plugin-sdk 0.74.3-canary.24): the steps in refresh
  order with what each reads, its rows or its error at the last run; a refused definition
  throws the session's reason (the name, the source, an input that is neither a source nor an
  earlier transform, the parameters). A transform defined through the door runs at once; the
  queries reading it see its rows at the next refresh.

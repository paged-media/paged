# ADR 332 — One property row shape: the engine publishes the contract's rows, the SDK adds none

- **Status:** Accepted 2026-10-20.
- **Scope:** `packages/plugin-api/src/object-model.ts` (`PropertySchema`, `IdmlSpelling`), the
  vendored `catalog.json` (`objectSchemas`), `packages/plugin-sdk/src/core-schema.ts`
  (`coreSchema71`, `CORE_OBJECT_SCHEMAS`), `core-objects-v71.ts`; in the engine,
  `paged-introspect` (`object_schema.rs`, `DERIVED_PATHS`, the `content` row), the `paged.schema`
  script function and the `RequestGet` / `Set` arms for the new rows. Amends
  [ADR 329](329-plugins-contribute-a-typed-object-model.md) (where core's rows come from) and
  the engine's ADR 132 (which rows the catalog publishes).

## Context

Finding PAR-3: `paged.schema(kind)` and `host.objects.schema(kind)` described the same objects
in two shapes. The script function answered the engine catalog's `propertySchemas` rows (a flat
`type` with `unit: "degrees"`, `of: "length"`, `members` on numbers; `wire`, `idml`, `access`;
the engine's address kinds). `host.objects.schema` and `editor.schema` answered the plugin
SDK's normalised rows: the contract's nested `ValueType`, `since: 71` on every core row,
`access` left out when read-write, no `wire` or `idml`, and about twenty rows the SDK added from
other reads (`swatchKind`, `pageCount`, `index`, the story counts, `content`, `basedOn`,
`label`, the whole `labels` map, `documentName`, `dirty`) plus the four table counts it typed
from its own table. The engine could not reproduce those rows, so no fix on either side alone
made the two agree.

Two ways out: the contract adopts the engine's flat row, or the engine emits the contract's.
The contract's `ValueType` is what every panel field, binding, `validateValue` and plugin
schema is written against; moving it to the engine's spelling would change every plugin. The
engine's row has consumers too (the CLI, the docs generator, the agent catalog), which read
its flat `type` and its full IDML list.

## Decision

1. **The engine publishes the contract's rows.** The catalog gains `objectSchemas`: every value
   row of `propertySchemas` in the contract's `PropertySchema` shape, keyed by **object kind**
   (`frame` holds every page item's rows and the `group` row, `story` its `storyRange` rows,
   `style` every family's definitions once with `appliesTo` naming the families; one family's
   rows are the `style` rows whose `appliesTo` names it). The engine does the translation the
   SDK used to do (`unit: "count"` is `integer: true`, `degrees` is `deg`, a number's `members`
   are `keywords`, a list's `of` is a value type, a struct is open), names indexed rows `[]`
   and aliased paths by their wire name, and drops the operation rows, which are not values.
   `propertySchemas` stays as it was for the engine's own consumers.
2. **The rows carry no SDK stamp.** No `since` on core rows (it stays for plugin rows); `access`
   is always present; core rows keep `wire` and `idml`, which the contract now types
   (`wire?: string`, `idml?: IdmlSpelling[]`, a list: a property has one spelling per element).
3. **The SDK serves the rows verbatim and adds none.** `coreSchema71` is a lookup over
   `objectSchemas`; `host.objects.schema(kind)` is that list. `paged.schema(kind)` returns the
   same list from the engine. The editor's own stopgap rows (`withEngineRows`) are removed.
4. **The rows the SDK added become engine rows where they are properties**, read by
   `RequestGet` like every other row, and refused by `Set` as read-only:
   `swatch` `swatchKind`; `doc` `pageCount`; `page` `index`; `spread` and `master`
   `label`, `pageCount`; `story` `characterCount`, `paragraphCount`, `overset`; `style`
   `basedOn` (per family); `table` `tableRowCount`, `tableColumnCount`, `tableHeaderRowCount`,
   `tableFooterRowCount`. The reserved `content` path is a `storyRange` row (heavy, multiline
   text) the engine reads and writes: a write is one `deleteRange` and one `insertText` in one
   batch, one undo step, the same as the SDK planned before.
5. **What is not a property is not a row.** `documentName` is the editor's tab name (the engine
   always answered `""`) and `dirty` is the edit session's state (whether the undo log holds an
   edit), not the document's: both are dropped from `doc` (`documentMeta` still answers them). The whole `labels` map is the read of the
   `labels[]` row with no key; no wire value carries a map, so the SDK keeps answering it from
   the old seam, and it is not listed.

## Consequences

- Finding PAR-3 is fixed: the parity suite's `paged.schema` read agrees on every door.
- `host.objects.schema` changes visibly: `storyRange` and `group` rows keep the engine's ADR 131
  `addressKind`; style rows name their families in `appliesTo` (the editor's "More" rows for a
  style family now list them); `labels`, `documentName`, `dirty` and `since` are gone; `access`, `wire`
  and `idml` are present. `getAll` still reads `labels` through `get`.
- The catalog is larger (`objectSchemas` beside `propertySchemas`). The SDK keeps importing
  `propertySchemas` for `CORE_CATALOG_ROWS` and the operation paths.
- `normalizeCoreType` stays in the SDK as the reference: an SDK test holds every
  `objectSchemas` type to it, so a change to the engine's translation shows up there.
- A contract change: plugin-sdk and plugin-api move together, with the wire and catalog resync.

# ADR 291 — The Data panel: the document's data as a grid, over the data door

- **Status:** Accepted 2026-10-24.
- **Scope:** `apps/canvas/src/panels/data-panel.tsx` and `data-grid-model.ts` (panel
  `paged.data`, registered in `built-in-panels.tsx`); `packages/shell/src/state/data-door.ts`
  (`setDataDoorSource`, `useDataService`, `useDataRevision`); `apps/canvas/src/app/mount.tsx`
  (the editor scope pointed at the shared data backend). Decided by
  [PM-0015](../../../../docs/adr/PM-0015-data-and-actions-are-platform-layers.md) (record
  "editor 291"); reads extensions
  [ADR 343](../../../../platform/extensions/docs/adr/343-the-data-door.md).

## Context

The document's data was visible only inside paged.data's own panels: a source list, a query
editor with a text preview. Data publishing tools that work show the data as the thing being
published. The record list is the centre of the workspace: sort, filter, group, the records a
page shows, what is placed and what changed. Those surfaces belong to the editor, not to one
module, once data is a platform layer.

## Decision

**A host panel over `data@1`.** The editor's own Data panel reads whatever bundle serves the
document's data, through the same shared backend every bundle host gets. The app points the
editor's scope at it (`setDataDoorSource(scope, backend)`); the panel and the bind popover (ADR
292) read it through `useSyncExternalStore`. Per editor scope, so two editors on a page have
two data doors. A service starting, stopping, or announcing a changed table re-renders them.

**What it shows.**
- One tab per table: the sources, the transforms' derived tables (marked derived), the queries.
- The record count, and a windowed grid: 22 px rows, the rows in view fetched 200 at a time.
- Each header names its field and type. A field a binding reads is marked (an approved-status
  underline, "read by n bindings" in its tooltip), from the service's bindings.
- A header click sorts; again reverses; shift-click adds a sub-sort, with the key's place shown.
- A filter builder: field, operator (is, is not, <, ≤, >, ≥, contains, is empty, is not empty),
  value, rows matched all or any.
- Grouping by a field: a header row per group with its count, each one closing and opening.
- Columns shown or hidden.

**The service does the work.** Sorting and filtering are SQL the panel writes
(`gridSql`: quoted identifiers, SQL literals) and the service runs after its query guard: a
count, the group field's column, then `LIMIT/OFFSET` windows. A 100 000-row table is sorted where
it lives and only the visible rows cross. The panel computes nothing about the data itself but
the grouping of the sorted rows it holds.

**First run.** With no service: why (no module serves the document's data). With a service and
no table: three steps, each with its door: import a source (opens Sources), write a query (opens
Query), bind (right-click any property).

## Consequences

- paged.sheet's data tables (its Edit in sheet) and this grid read the same tables, and any
  bundle serving `data@1` gets the panel.
- Amended 2026-10-24: `data@1` gained `status()` (each binding with its sync state and the
  fields its expressions read) and `refresh()` (plugin-sdk 0.74.3-canary.21). A header is
  underlined in the worst state of the bindings reading its field: in step, changed in the data
  (or kept as placed), failed. A status line counts the bindings by state, and **Update
  document** reads the data again and updates every placed field, table and image.
- Not part of this record, and not built yet:
  - per-record status (a record new or deleted in the source) and the canvas field markers,
    which need the service to report placed instances per record;
  - drag to place, which needs a canvas drop target for a field;
  - double-click to jump to a record's instances.

  Each needs a door member it does not have today, and the panel says nothing it cannot back.
- Amended 2026-10-24: record templates and their library, and the pagination inspector, are
  built, as paged.data's own panels (PM-0015 L4: they are the module's workflows, not the
  host's). **Record templates** lists the document's templates with the record flows using
  each, makes one from the selected text frames (lines written as for Data Merge, `<<field>>`
  a field), renames (the flows follow) and deletes (refused while a flow uses it), and
  previews a template filled with record N of a query. **Record flow pagination** sets a
  flow's options the engine implements (its template and line height, group by, repeated and
  continued group headers, a group footer with a count and a sum, average, minimum or
  maximum) inline, and shows what the paginator makes of it over the start page's margin box:
  records placed, records per page, repeated headers, overflow, a record taller than a page.
  They reach this panel only when `data@1` gains members for them; until then the Data panel
  does not show them.

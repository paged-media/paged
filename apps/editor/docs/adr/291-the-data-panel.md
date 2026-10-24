# ADR 291 — The Data panel: the document's data as a grid, over the data door

- **Status:** Accepted 2026-10-24.
- **Scope:** `apps/canvas/src/panels/data-panel.tsx` and `data-grid-model.ts` (panel
  `paged.data`, registered in `built-in-panels.tsx`); `packages/shell/src/state/data-door.ts`
  (`setDataDoorSource`, `useDataService`, `useDataRevision`, the drop handler);
  `apps/canvas/src/data-drop.ts`; `apps/canvas/src/app/mount.tsx`
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
Query), place (drag a field header onto a frame, or right-click any property).

## Consequences

- paged.sheet's data tables (its Edit in sheet) and this grid read the same tables, and any
  bundle serving `data@1` gets the panel.
- Amended 2026-10-24: `data@1` gained `status()` (each binding with its sync state and the
  fields its expressions read) and `refresh()` (plugin-sdk 0.74.3-canary.21). A header is
  underlined in the worst state of the bindings reading its field: in step, changed in the data
  (or kept as placed), failed. A status line counts the bindings by state, and **Update
  document** reads the data again and updates every placed field, table and image.
- Amended 2026-10-24: `data@1` gained `placements()` (each page item a binding places content
  in, by ADR 131 address, with the binding's sync state; read role). paged.data answers it from
  the session's hosts (image, barcode and visibility frames, the frame a table or record flow was
  lowered into, the frame a variable's or rule's story starts in, the element a property binding
  is carried by) and resolves a property binding's selector through `host.objects`. Built on it:
  - **Canvas field markers.** View ▸ Show data markers (off by default, `dataMarkers` view
    toggle, `paged.view.toggleDataMarkers`) draws non-printing corner brackets on every placed
    frame, in its binding's state: in step green (`--status-approved`), changed in the data,
    kept as placed or not resolved yet amber (`--status-review`), failed red (`--status-error`);
    a frame several bindings place into takes the worst. The overlay is
    `packages/shell/src/overlays/data-markers.tsx`; it reads nothing while off.
  - **Jump to a field's instances.** Double-clicking a bound field's header selects the page
    items the bindings reading that field are placed in (the second click of the double-click
    does not reverse the sort).
- Amended 2026-10-24: `data@1` gained `place(target, query, field)` (bind role; plugin-sdk
  0.74.3-canary.23). **Drag to place:** a query's field header drags out of the grid (drag type
  `application/x-paged-data-field`, `{query, field}`); the canvas column accepts it while the
  app has a drop handler (`setDataDropHandler`, `useDataFieldDrop` in the shell's data-door
  store), and the app (`apps/canvas/src/data-drop.ts`) hit-tests the drop point as the context
  menu does and hands the page item's address to the service. paged.data places the field as a
  variable at the start of a text frame's story, or as the picture of a rectangle, oval or
  polygon (an image binding, lowered at once); on anything else, or with no item under the
  point, the refusal and its reason reach Problems. A source table's headers do not drag (a
  binding reads a query).
- Not part of this record, and not built yet:
  - per-record status (a record new or deleted in the source) and markers per record, which
    need the service to report which record each instance shows;
  - a record dropped onto a grouped design, and a range dropped as a table;
  - double-click to jump to one record's instances (the field's instances are selectable).

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
- Amended 2026-10-24: **the pipeline** (data ADR 562). With a service that has `pipeline()`,
  a Pipeline switch beside the table tabs shows how the data is made, in the order a refresh
  runs it: sources → transforms → queries, each step with the tables it reads and its rows, or
  its error, at the last run. Selecting a step shows its table in the grid. With
  `defineTransform`, a transform is edited in place (its table name, the tables it reads, its
  parameters as JSON and its source in the code editor) and applied; the service's refusal is
  shown inline. **New transform** makes one, and Remove (with `removeTransform`) drops it. The
  view is `apps/canvas/src/panels/data-pipeline.tsx`.
- Amended 2026-10-24: **picture columns** (data ADR 563). When the service offers
  `assetColumns` and `setAssetColumn`, a query table's toolbar has "Picture column…" and a
  right-click on a field header opens it for that field (`apps/canvas/src/panels/data-asset-column.tsx`).
  It sets the base URL a relative reference resolves against and builds the column's chain from
  the registered actions (`actions@1`, extensions ADR 344) that take an asset and give one: add,
  reorder, remove, and each step's parameters as fields over the action's defaults, or as a JSON
  object when it declares none. An action in a saved chain that is not registered now is kept
  and said so. Save hands the column to the service, which refuses an unknown query or field;
  Clear undeclares it; an asset column's header carries a "picture" mark with its step count.
  The editor's surfaces read the action registry through the shell's actions store
  (`setRegisteredActionsSource`, `useRegisteredActions`), which the app points at the one shared
  registry. The registry announces no registrations, so the store reads the list at each render
  and keeps it while it is unchanged. The pipeline view stays for later.

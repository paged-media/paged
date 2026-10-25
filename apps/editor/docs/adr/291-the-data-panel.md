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
- Amended 2026-10-24: `data@1` gained `issues()` (read role; plugin-sdk 0.74.3-canary.24):
  what may be wrong with the placed content, each named where it is (data ADR 564). Below the
  status line, an **issues line** sums them up by kind, worst first ("1 picture missing · 2
  texts do not fit"), in the worst severity's tone, each message (which says what to do) in its
  tooltip; a click selects the page items concerned. It is read again when the data changes and
  on the pushes that change the document, so a frame grown to fit clears its issue; a service
  without `issues` shows no line. The UI is `apps/canvas/src/panels/data-issues.tsx`. The field
  markers draw a frame named by a warning or an error in the error red. paged.data also
  publishes the issues to Problems.
- Amended 2026-10-24: `data@1` gained `placeTable(target, query, fields?)`,
  `placeRecord(target, query, record)` and `loadSample()` (plugin-sdk 0.74.3-canary.24). The
  shell's drop is general now: `setDataDropHandler` takes a `DataDrop` (`{kind: "field" |
"table" | "record", …}`) and `useDataDrop` reads whichever Data panel drag type the drag
  carries (`application/x-paged-data-field`, `-table`, `-record`).
  - **A query dropped as a table.** The grid's **Drag as table** handle drags the query with
    its shown columns, in the grid's order (`{query, fields}`). Dropped on a text frame,
    paged.data defines a table binding of those columns and puts the table in that frame's own
    story; an update swaps it there and never deletes the user's frame (`targets.tableIn` in
    the saved session keeps the frame, and its table when known, across a reopen).
  - **A record dropped on a design.** A grid row drags as one record (`{query, record}`), while
    the grid shows the query's own order (no sort, filter or grouping: only then is a row's
    place its record number). The drop fills the group under the point (the outermost, as a
    click selects it), else the item: every `<<field>>` written in its text frames, as Data
    Merge reads them, is replaced by a variable showing that record's field, in one undo step,
    and a rectangle, oval or polygon named `<<@field>>` (or `<<field>>`) gets that record's
    picture. The engine finds the placeholders (data-js `placeholder_spans`, data-lower's
    merge reader) and resolves each binding at that record (`resolve_lowered_at`); the record
    is saved with the session (`targets.record`), so a refresh keeps the design at it. A
    design without a `<<field>>` is refused with the reason, and nothing is defined.
  - **Sample data.** The first-run guide offers **Try it with sample data** when the service
    has `loadSample`: paged.data loads a small made-up product list (sku, name, category,
    price; no pictures, nothing fetched) as the source `sample_products` with the query
    `sample` over it, and the panel shows that query's tab.
- Amended 2026-10-24: `data@1` gained `recordStatus(query)` (the records new, changed and
  placed, and how many placed records are gone) and a placement's `record` (plugin-sdk
  0.74.3-canary.24). The engine decides (paged-data-session `record_status.rs`): it keeps each
  query's result as of the last time the document was written from it (Update document, a
  field refresh, a Data Merge) and matches the current result against it by record identity:
  the key chosen in the Sync panel, else the first column whose values are present and unique
  in both results (an id, a SKU), else the whole row, with which a changed record reads as one
  removed and one added. Placed are a table's records, the record a single-record binding
  shows (the first, or the record dropped on its design), and the records the page items carry in their labels: a merged record's
  frames and a record-flow frame's records (the paginator names each instance's row). Before
  the first write in a session there is nothing to compare with, and no record is new or
  changed. Built on it:
  - **Rows by status.** A query's grid numbers its rows as delivered (`row_number()`, so a
    sorted or filtered row keeps its record) and tints a new row approved green and a changed
    one review amber; a placed row has an info-blue bar at its start; "n placed records are
    gone from the data" sits next to the count (`data-record-status.ts`).
  - **Jump to one record's instances.** Double-clicking a placed row selects the page items
    that show that record: the placements naming it, of a binding over the query or of its
    Data Merge (`merge-<query>`).
  - The door's `query` reads a query by its name as a table (the query rides along as a CTE),
    which the grid of a query's tab needs.

  Not built: a record stepped to in the record preview is not tracked as placed (the first
  record is).
- Amended 2026-10-25: **the per-record status survives reopening**, and **the canvas markers
  show the record**.
  - The snapshot is saved with the session: the engine payload (paged.data's `session` part)
    gains `applied`, per query the result the document was last written from, in a compact
    form (`AppliedSnapshot`): the key fields used (the first column present and unique in
    the result, else none, the whole row) and, per record in result order, a 64-bit FNV-1a
    hash of its key and one of its content (every cell, typed), as 32 hex digits (16 with the
    whole row as the key). No values are stored: about 35 bytes a record, whatever the row's
    width, so 10 000 records add about 350 KB to the part. The status compares these: a record
    whose key hash the snapshot lacks is new, one whose content hash differs changed; placed
    records and instances are carried by key hash as before. A saved snapshot cannot be keyed
    again, so asked with another key than its own (or when its key no longer identifies the
    records now) it matches by the whole row. Within a session the full result is still held
    and keyed as asked. A payload without `applied` loads with no snapshot (the additive
    rule); the document label's recipe never carries it (it is state, and grows with the
    data), so the labels path (`restore_from_labels`) is unchanged. Undo that reloads a session
    version brings that version's snapshot. The snapshot is taken before the write that applies
    the data (Lower, a field refresh, a merge), so the label that write carries names the
    version holding it: a reopened document names the version it was saved with. The Sync panel's row diff keeps its in-memory
    snapshot only: it shows the values before, which the saved form does not keep.
  - The field markers label a frame's top-left bracket with the record its placements name
    (`DataPlacement.record`, counted from 1 as the grid and Data Merge count: `#3`, `#2 #5`
    for a frame showing several), in the bracket's tone, a constant size on screen. Only a
    placement that names a record is labelled. Overlay chrome: it never prints or exports.
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

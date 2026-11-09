# ADR 1102 — The workbook door: one bundle edits the workbook another bundle keeps

- **Status:** Accepted 2026-11-09.
- **Scope:** `packages/plugin-api/src/workbooks.ts` (the types), `host.workbooks` and
  `ContributionSurface.workbookEditor` in `host.ts`; `packages/plugin-sdk/src/doors-workbooks.ts`
  (`createWorkbookEditorRegistry`, `createWorkbooksSurface`), `host-impl.ts`
  (`options.workbookEditors`, the flags), `harness.ts` (a shared registry by default), `testing.ts`
  (`fakeWorkbookEditor`); `test/workbooks-door.spec.ts`. The editor injects the registry
  (`apps/editor/apps/canvas/src/plugin-host-options.ts`). Offered by paged.sheet
  (`modules/sheet/packages/sheet-bundle/src/workbook-editor.ts`), used by paged.slide's chart data
  sheet (slide ADR 724 amendment 1). Decided under
  [PM-0017](../../../../docs/adr/PM-0017-built-ins-are-part-of-the-core.md): built-ins reach each
  other through the public doors.

## Context

A chart's data is a workbook: PowerPoint and Word embed one per chart, and paged.slide keeps it as
a container part. Slide edited it on a grid of its own (`chart-surface.tsx`) over a second copy of
paged.sheet's engine compiled into the slide wasm (`slide-sheet`). That is a second spreadsheet UI
with fewer features (no formula bar, completion, fill, paste, find) that has to be kept in step with
the first. Using paged.sheet's grid instead needs one bundle to show another bundle's surface on
data the first owns. A TypeScript bundle may not import another (PM-0002), and no door handed one
bundle another's surface or engine (slide ADR 724, section 2).

## Decision

**A door in the public contract with two sides.**

- **Offer.** `host.contribute.workbookEditor({ id, open(request) })` registers an editor in a
  registry the host shares between bundles. The id is namespaced under the bundle's id and taken
  once. Without a shared registry the contribution is a no-op.
- **Open.** `host.workbooks.open({ xlsx, name?, ranges? })` opens a workbook in the editor that
  registered first and answers a `WorkbookEditSession`:
  - `Surface`, a React component taking `{ width, height }` (CSS px): the consumer mounts it in its
    own UI (a frame surface, a panel, a dialog). React in the host's realm, the same accepted
    exception panels and frame surfaces are (ADR 334);
  - `changed()`, `xlsx()` (the workbook now, as XLSX bytes), `onDidChange(listener)` (after each
    edit), `close()`.
  - `ranges` are blocks of cells the consumer reads, with a role (`name`, `category`, `value`); the
    editor shows them tinted, as Office tints a chart's series, and opens on the first one's sheet.
- `available()` says whether an editor is registered now; `onDidChangeAvailability` fires when one
  comes or goes.
- **Probes.** `workbooks@1` and `contribute.workbookEditor@1`: the host shares a registry. They
  say nothing about whether a bundle offers an editor; that is `available()`.

**The workbook never enters the document through the door.** The consumer owns where its bytes
live. It writes the edited bytes itself, in its own undo step, and decides what an edit means (slide
redraws the chart and marks it edited for export). The editor must not persist, subscribe to the
document, or touch the document's comments for such a workbook.

**Guarantees the SDK holds for every editor.** The surface wraps each session the editor answers:

- while nothing changed, `xlsx()` answers the request's own bytes (the same object), so a consumer
  that only looked writes nothing and stays byte-identical;
- the editor gets a copy of the request's bytes, never the consumer's array;
- `close()` runs the editor's close once; after it `xlsx()` and `changed()` keep their last
  answers.

**Honest absence.** Without a shared registry both flags are false, `available()` is false and
`open` rejects saying so. With a registry and no editor, `open` rejects ("no bundle offers a
workbook editor"). An editor that cannot read the bytes rejects the open.

**Testable without the editor.** The harness shares one registry between every bundle host it
builds (`HeadlessHost.workbookEditors`). `fakeWorkbookEditor(id)` keeps the bytes it is given,
renders nothing, and changes only when a test calls `edit(bytes)` on one of its `sessions`; it
refuses bytes that do not start like a ZIP.

## paged.sheet's editor

Each open is a workbook session of its own (`createWorkbookSession(host, { detached: true })`): the
same engine, cell journal, formula bar and grid as the sheet's own workbook, without the parts that
belong to the document (no container part or blob is written, no document change, save, undo or
comment thread is followed). The surface is the grid panel's view sized to the consumer's box,
without its find section and notes, with sheet tabs and the consumer's ranges tinted. `xlsx()` is
the engine's preservation-first save.

## Consequences

- paged.slide edits chart data on paged.sheet's grid and engine; `chart-surface.tsx` is gone. The
  slide wasm keeps `slide-sheet`: it still reads the workbook to recalculate and draw the chart,
  writes the chart part on export and synthesizes a workbook for a chart without one (slide ADR 724
  amendment 1).
- A Word chart (doc) can use the same door when doc edits chart data.
- An editor in an isolate needs the surface as a transferred canvas, like a frame surface (ADR 334);
  recorded, not built.
- plugin-sdk and plugin-api 0.74.3-canary.82.

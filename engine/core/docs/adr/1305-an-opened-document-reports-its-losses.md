# ADR 1305 — An opened document reports its losses

- **Status:** Accepted 2026-11-13.
- **Scope:** protocol v80. `paged-canvas` (`import_losses.rs`: `CanvasModel::import_losses`;
  `DocumentHandle.losses`), `paged-model` (`report::LossLog` re-exported), the editor's client
  (`CanvasClient.exportIdml` answers `{ bytes, lost, links }`; `DocumentHandle.losses` on
  `loadDocument`), `modules/publish` (the IDML export's diagnostics carry each loss's items and
  page). Implements `UXI-FIL-002` of the editor's interaction contract (editor ADR 1200), task
  EN6 of `apps/editor/docs/interaction-plan.md`; the engine half of `UXI-T66`, whose report UI is
  task DF4.

## Context

The IDML export has reported what the package does not carry since v58, as `LossEntry` rows
since v78 (engine ADR 1097), but the editor's client returned the bytes alone and dropped them.
On the way in, nothing reported what an opened IDML does not carry or show as its source did:
the reader's own loss (frames nested in a way it cannot hold are left out,
`Spread::skipped_nested_frames`) was a counter no reply named, and what the first build could
not draw (a substituted font, a missing link, an EPS without an interpreter) was spread over the
collections (`fonts.isMissing`, `links.status`) with no import report to read.

## Decision

**The load's reply carries the import's losses, and the export's reach the caller.**

- `DocumentHandle.losses` (additive, `LossEntry[]`) is `CanvasModel::import_losses`: one entry
  per code and message, counted, with the items (page-item `Self` ids) and 0-based pages each
  stood on. Codes are `idml.import.<what>`:
  - `nestedFrame` (dropped) — frames the reader left out;
  - `fontSubstituted` (approximated) — a face served by a substitute;
  - `linkMissing`, `imageUndecoded` (dropped) — a link that resolves to nothing or does not
    decode;
  - `contentUnrenderable` (dropped) — content with no interpreter, drawn as its frame only;
  - `drawnFromPreview`, `clippingPath` (approximated) — art drawn from its preview, a clipping
    path not applied;
  - `pageNumbering` (info) — page numbers computed by a fallback rule.

  Layout states the source has too (overset text, a footnote that does not fit) are the
  document's, not the import's, and are not listed. Every `DocumentLoaded` carries the field —
  a load, a new blank document — and an empty list is left off the wire.
- The client's `exportIdml({ linkBase? })` answers `{ bytes, lost, links }`; `lost` is the
  export's `LossEntry[]`.
- The publish module's IDML export diagnostics carry each loss's first page (1-based) and its
  items, so a report can go to the objects.

DOCX, PPTX, PSD, SVG and PDF imports report through their own doors, not the load's reply:
`PsdPlacePlan.losses`, `SvgImportPlan.report.losses`, and the doc, slide and publish modules'
import results.

## Consequences

- The import report (task DF4) reads `handle.losses` after a load and the modules' reports after
  theirs, and navigates by the items; the compatibility report of an IDML save reads `lost`.
- A lossy IDML open or save is never silent at the client.
- The entries are recomputed from the build: a host that wants the losses of the document as it
  stands after edits reads them again from a fresh handle; the load's are the import report.

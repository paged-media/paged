# ADR 1222 — Compatibility report

- **Status:** Accepted 2026-11-13.
- **Scope:** `apps/canvas/src/panels/compatibility-report.ts` (new: areas, wording, summary,
  round-trip risk, pure), `compatibility-report-store.ts` (new: one store per editor, recorded and
  derived reports, the summary said once), `import-report-panel.tsx` (new: the panel
  `paged.import-report`), `reveal-targets.ts` (new: go to a page, select and fit items),
  `problems-panel.tsx` (a bundle's loss rows are one row), `svg-commands.ts` and
  `clipboard-commands.ts` (the SVG import's and paste's losses), `app/mount.tsx` (the load's and
  the IDML export's losses, protocol 80), paged.publish (`exportIdmlWithLosses`; the exporter's
  losses on the diagnostics channel), paged.pdf (the vectors' losses carry their entry), and the
  contract's `Diagnostic.loss` with the SDK's `lossDiagnostics`
  ([extensions ADR 1107](../../../../platform/extensions/docs/adr/1107-host-notify.md)).
  `UXI-FIL-001`, `UXI-FIL-002` of the interaction specification
  ([ADR 1200](1200-the-interaction-contract-is-adopted.md)); the UX strategy's §6.4; task DF4 of
  [`interaction-plan.md`](../interaction-plan.md).

## Context

Every importer, exporter and mapper answers with the engine's one loss report (engine ADR 1097),
and protocol 80 puts it on the IDML load (`DocumentHandle.losses`) and on the IDML export
(`exportIdml` → `{ bytes, lost }`, engine ADR 1305). The editor dropped most of it: the SVG import
listed sentences in Problems, the modules' losses were Problems rows without their codes, the
IDML export's `lost` went nowhere, and an import said nothing about what it converted. Nothing
said what a code meant, where it stood or whether a round trip would bring it back.

## Decision

1. **One report per operation**, `{ direction, format, name, losses, source, made? }`, from two
   doors. Recorded: the document load's losses (`onDocumentLoadLosses`, a `.paged` reporting what
   its IDML half did not carry), Save As IDML's `lost`, the editor's SVG import (with what it
   made) and an SVG paste. Derived: a bundle's keyed diagnostics whose rows carry `loss` (the SDK's
   `lossDiagnostics` sets it) are one report each, its direction and format read from the bundle
   and key (paged.slide's import and export, paged.doc's placement, paged.pdf's vectors,
   paged.publish's IDML export).
2. **Each entry explained.** Its code is read into an area (fonts, effects, colour and paint,
   pictures and links, text and tables, pages and objects) from the producer's own vocabulary
   (`idml.*`, `dml.*`, `pptx.*`, `eps.*`, `xlsx.*`, an SVG construct, a Photoshop effect, a PDF
   mapper code), its severity worded (left out, converted, note), its sentence the producer's own,
   else the area's. The code itself shows only on demand. Its pages go to the page, its items are
   selected and the view fitted to them (`revealItems`, which records the jump for Back).
3. **The summary, once.** A new or changed report says "Imported deck.pptx · 2 font
   substitutions · 1 unsupported effect · 3 converted objects" as a prominent result with View
   report ([ADR 1219](1219-operation-feedback.md)); the Problems list shows a bundle's loss rows as
   one row, "N differences from the source file", that opens the report.
4. **Round-trip risk per format**, said plainly in each report: IDML writes what InDesign reads
   and reports what it could not; PowerPoint, Word and Excel write back what they can map;
   Photoshop flattens what is listed; a PDF is never edited in place; SVG writes a new drawing;
   any other format's round trip is not verified.
5. **A failed open changes nothing** (`UXI-FIL-001`, ADR 1205): the report of the open document
   stays as it was, and the failure is listed as ADR 1219 says.

## Consequences

- Tests: `apps/canvas/test/unit/panels/compatibility-report.test.ts`,
  `test/panels/import-report-panel.dom.test.tsx`, `test/panels/problems-panel.dom.test.tsx` (one
  row per report), and `UXI-T66` in `apps/canvas/tests/e2e/uxi-import-report.spec.ts` (the report
  lists exactly the engine's losses; a damaged file leaves the document and the history as they
  were).

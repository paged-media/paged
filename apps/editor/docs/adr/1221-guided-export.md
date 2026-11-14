# ADR 1221 — Guided export

- **Status:** Accepted 2026-11-13.
- **Scope:** `packages/shell/src/chrome/ExportPdfDialog.tsx` (the guided flow, presets, the
  result), `packages/shell/src/lib/export-readiness.ts` (new: the readiness check and the
  preview facts, pure), `packages/ui/src/inputs/KitCheckbox.tsx` (new: the kit checkbox),
  `apps/canvas/src/panels/cockpit/export-center-panel.tsx`, `export-views.tsx` and
  `export-targets.ts` (the Export Center and its inspector), `preflight-findings.ts` (a dialog
  export is a run), `apps/canvas/src/cockpit-menus.ts` (Layout). The UX strategy's §6.6;
  `UXI-FIL-004`, `UXI-FIL-005`, `UXI-FBK-003` and `UXI-FBK-004` of the interaction
  specification ([ADR 1200](1200-the-interaction-contract-is-adopted.md)); task DF6 of
  [`interaction-plan.md`](../interaction-plan.md). Builds on
  [ADR 238](238-the-default-pdf-is-one-the-document-can-meet.md) and
  [ADR 266](266-one-source-for-the-print-output-facts.md); amends
  [ADR 272](272-a-finished-export-closes-its-dialog.md). Closes UX audit F-12 and F-15.

## Context

File ▸ Export PDF… was a form with the platform's own selects and checkboxes (F-12), a page
range that was a checkbox and two fields, and one validation: PDF/X-4 without an output
intent. Everything else the export would meet was found out after it ran: the Preflight
panel's findings come from an export, and the notice at the window's foot named the file and
the findings only once it was written. A custom bleed that was no number went out as 0. The
dialog said "Exporting page n / N" whether it was preparing, writing pages or finishing. The
Export Center's "Fix issues first" and "Save preset" were disabled buttons with nothing behind
them, and the Layout menu called three working features "soon" while Window ▸ Structure had
their panels (F-15).

## Decision

1. **One dialog, read as the flow it is:** Output, Readiness, What the file will be, then
   Export. The destination (the browser's downloads, with the file's name) is stated before
   the export runs.
2. **The readiness check runs before anything starts** (`pdfReadiness`, pure, from the
   options and what the document says about itself: its meta through the print-output facts,
   its pages, fonts and links collections, its stats). A **blocker** refuses the export with
   its reason and, where there is one, the panel that fixes it: no document; PDF/X-4 without
   an output intent profile (ADR 238: an impossible standard is never written as if it were
   met, `UXI-FIL-004`); a page range outside the document; a custom bleed that is no length.
   A **warning** is said and the export may go ahead: missing fonts (a substitute is
   embedded), missing links, pictures below 150 ppi, overset text. The engine is asked only
   for what it already reports; nothing new crosses the wire. A headless test holds the check
   to the engine's own answer (X-4 refused at begin, PDF 1.7 written).
3. **The preview states the file's facts as the exporter makes them** (`paged-export-pdf`):
   the pages (all, the page in view, or a range), the page size in pt and mm, the bleed, the
   standard with its output intent and colour policy, the fonts (embedded as subsets, how many
   substituted), transparency (kept live, never flattened), images (passed through, or
   downsampled to the chosen ppi) and the destination.
4. **Progress names its stage** (`UXI-FBK-004`): preparing, writing page n of N (the one
   stage with a measure, a determinate bar), finishing. Nothing shows a percent it does not
   have. Cancel aborts between pages; the engine drops its session and the dialog says the
   export was canceled and nothing changed.
5. **A result is only claimed for a PDF** (`UXI-FIL-005`): bytes that do not begin `%PDF-`
   are a failure. A finished export closes the dialog (ADR 272) and the editor's one feedback
   channel (editor ADR 1219) names the file, its pages, where it went ("in your downloads")
   and the number of findings, with the findings behind Details and Show findings opening
   Preflight, which now counts a dialog export as its last run. A failure stays in the dialog,
   worded as the action, the reason and "Nothing changed." The notice of ADR 272 is that
   toast now.
6. **Kit controls** (F-12): `KitSelect` for every choice (a native select underneath, so the
   keyboard and the tests' `selectOption` stay), `KitCheckbox` (new in `@paged-media/ui`: the
   kit's box and check glyph over a real checkbox), segments for the page scope, the shell's
   input for numbers.
7. **Presets.** Three built in (press quality, high-quality print, smallest file) and the
   user's own, saved by name (`paged.exportPdf.presets.v1`, read entry by entry with the
   form's shape check, ADR 247). A preset sets everything but the pages and the profile, which
   belong to the document at hand. The Export Center's disabled "Save preset" is gone: presets
   live where the options are.
8. **The Export Center uses the same check.** "Fix issues first" lights when the document has
   issues and opens Publication health, which leads to each. A plugin exporter's run and the
   page images report how they ended through the one feedback channel (an exporter that
   answers no bytes delivered no file). The Web bundle, Social crops and Print package outputs
   stay visible "soon" seams: nothing in the editor can produce them yet.
9. **F-15.** Layout ▸ Margins and columns…, Ruler guides… and Numbering and section options…
   raise their panels (Margins and Columns, Guides, Section Options). Create guides… (rows and
   columns of guides in one step) has no capability behind it and stays an honest seam, as do
   File ▸ Package… and Print….

## Consequences

- F-12 and F-15 close.
- `paged.exportPdf.options.v1` gains `pageScope` (`all`, `current`, `range`); a form stored
  with `allPages: false` reads as a range.
- Tests: `packages/shell/test/lib/export-readiness.test.ts`,
  `packages/shell/test/chrome/export-pdf-guided.dom.test.tsx`,
  `packages/shell/test/settings/export-pdf-options.dom.test.tsx`,
  `apps/canvas/test/panels/cockpit-export-center-panel.dom.test.tsx`,
  `apps/canvas/tests/headless/export-readiness.test.ts`, and `UXI-T68` in
  `apps/canvas/tests/e2e/uxi-export.spec.ts` (PDF/X-4 without an output intent is refused
  before anything starts, nothing is written and the model and history are unchanged; PDF 1.7
  shows its page stage and a result naming the file and where it went).

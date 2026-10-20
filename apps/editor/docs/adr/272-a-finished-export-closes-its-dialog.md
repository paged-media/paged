# ADR 272 — A finished export closes its dialog

- **Status:** Accepted 2026-10-20.
- **Scope:** `packages/shell/src/chrome/ExportPdfDialog.tsx`. Builds on
  [ADR 266](266-one-source-for-the-print-output-facts.md).

## Context

The Export PDF dialog stayed open after the download, with nothing left to do in it but Close.
The film had to close it by hand, and a user who did not see the browser's download bar could not
tell from the editor what had been written. The other export surface, the Export Center's page
images, reports what it wrote in place ("Exported 3 PNGs.").

## Decision

- **Success:** the dialog closes. A notice at the window's foot (`role="status"`) names the file
  and its pages ("Exported brochure.pdf · 2 pages") and closes after six seconds or on its ✕. The
  engine's findings, when there are any, travel in the notice, which then stays until it is
  closed.
- **Failure:** the dialog stays open with the error beside the options that produced it, so one
  can be changed and the export run again. No notice.
- **Cancel during an export:** the export aborts and the dialog stays open, as before.

InDesign closes its Export Adobe PDF dialog when the export starts and reports problems
afterwards; here the export runs inside the dialog (its progress bar), so it closes when the
export ends.

## Consequences

`packages/shell/test/settings/export-pdf-options.dom.test.tsx` covers success, findings and
failure; `tests/export-pdf.spec.ts` expects the dialog gone and the notice naming the download.

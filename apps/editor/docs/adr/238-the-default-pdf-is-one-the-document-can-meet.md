# ADR 238 — The default PDF is one the document can meet

- **Status:** Accepted 2026-10-19.
- **Scope:** `packages/shell/src/chrome/ExportPdfDialog.tsx`,
  `apps/canvas/src/panels/cockpit/export-targets.ts` (`exportReadiness`), the Export Center
  and the export inspector.

## Context

Export PDF… opened on PDF/X-4, which needs an output intent; every document without one,
every new document included, opened the dialog on an error with Export disabled, and the
Export Center's one PDF output read as a warning (UX audit F-11, finding PN-305).

## Decision

The print PDF is the strictest standard the document can meet: PDF/X-4 when the working
space has an output intent (or the dialog has a profile chosen), PDF 1.7 otherwise. The
dialog opens on that standard on every open, without persisting it, and X-4 stays a choice
in its menu with its explanation. The Export Center's and the export inspector's PDF row
read "Ready · X-4" or "Ready · PDF 1.7", both ready; its title is "Print PDF".

## Consequences

PN-305 closes. A user who wants X-4 on a document with no intent chooses it and sees why it
cannot export, as before; the default no longer starts there.

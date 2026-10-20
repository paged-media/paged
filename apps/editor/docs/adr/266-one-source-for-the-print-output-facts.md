# ADR 266 — One source for the print-output facts

- **Status:** Accepted 2026-10-20.
- **Scope:** `packages/shell/src/lib/print-output.ts` (new), `chrome/ExportPdfDialog.tsx`,
  `components/cockpit/kit.tsx` (`StatusPill` title); in `apps/canvas`, the Prepress bar
  (`cockpit/toolbars.tsx`), the PDF/X-4 checklist (`panels/cockpit/mode-inspectors.tsx`),
  Publication health, the Document Map's health footer, `export-targets.ts`
  (`exportReadiness`), the Export Center and the export views. Builds on
  [ADR 238](238-the-default-pdf-is-one-the-document-can-meet.md).

## Context

The document meta carries two colour facts: `cmykProfileName`, the working space the document
names (set in Color settings, else declared by the file's `CMYKProfile`), and
`cmykProfileActive`, true only when real ICC bytes back it. Six surfaces read them each in
their own words, and two pairs contradicted each other on the same document:

- The Prepress bar showed the bare name ("Coated FOGRA39") with a small amber dot, while the
  PDF/X-4 checklist failed "CMYK working space active". The file named a profile the editor
  had no bytes for; the bar showed the declaration as if it were the working space.
- Publication health and the Document Map warned "PDF/X-4 · No output intent", while the
  Export Center read "Ready · PDF 1.7" for the same Print PDF output. Since ADR 238 the print
  PDF exports PDF 1.7 when there is no output intent, so the warning described an export
  nobody would get.

## Decision

1. **One derivation.** `printOutputFacts(meta)` returns the four facts every surface reads:
   `profileName` (what the document names), `profileActive` (bytes back it: the only
   meaning of "CMYK working space active"), `outputIntent` (what a Print PDF embeds unless the
   dialog picks another registered profile: the active profile, else none) and `standard`
   (PDF/X-4 with an output intent, PDF 1.7 without, per ADR 238). No surface reads the two
   meta fields directly any more.
2. **A name without bytes is said as such.** `workingProfileLabel` reads the name when the
   profile is active, "‹name› · not loaded" when the document only declares it, and "No CMYK
   profile" when there is none. The Prepress bar's chip, the checklist row's detail and the
   export dialog's "Document working space (…)" choice all show it. The checklist still fails
   the row for a declared profile: without bytes there is no working space to convert with
   and no output intent to embed.
3. **Health speaks for the export the user will get.** Publication health and the Document
   Map show the Export Center's own Print PDF pill (`exportReadiness`): "Ready · X-4" or
   "Ready · PDF 1.7", both ready, with a tooltip saying why it is not X-4 when it is not.
   The PDF/X-4 checklist (Prepress mode's Output readiness) stays the place that checks X-4
   specifically, and the export dialog still shows the X-4 error when the user chooses X-4
   without an output intent.

InDesign keeps the same split: the output intent is set on the PDF export preset's Output
page (Output Intent Profile, "Document CMYK" by default), so whether an export is PDF/X is a
property of the preset chosen, not a warning on the document.

## Consequences

The surfaces cannot disagree: they format one value. A profile registered after load still
becomes the working space only through Color settings (`setColorSettings`), as before; the
surfaces then all switch together, because they read the same refreshed meta. The pills'
test ids changed with their meaning (`x4-readiness` → `print-readiness`, `map-x4-readiness`
→ `map-print-readiness`).

# ADR 267 — Margins and columns are drawn on the page

- **Status:** Accepted 2026-10-20.
- **Scope:** `packages/shell/src/overlays/margin-guides.tsx`, `apps/canvas/src/main.tsx`.

## Context

The Margins and Columns panel (ADR 323 of the extensions range, schema-driven) writes a page's
margins, column count and gutter, and the Document Map lists them ("M 48 pt · 2 col"), but the
canvas drew none of it. A designer setting up a new document saw an empty white page after
typing every value, with nothing to place frames against. InDesign draws the margin box and the
column gutters on every page as non-printing guides, and so do the layouts its users expect.

## Decision

- A canvas overlay draws each page's margin box and both edges of every column gutter, read
  from the pages collection (the same fields the panel writes, refetched on every change).
- They take the guide colour (`--overlay-guide`) at reduced opacity, under the ruler guides and
  every selection cue, as one-pixel non-scaling lines.
- A page without margins or columns draws nothing. Like the other non-printing chrome they show
  in the Normal screen mode only, so Preview, Bleed and Slug hide them.

## Consequences

- The geometry is a pure function (`marginGuides`) with its own tests
  (`packages/shell/test/overlays/margin-guides.test.ts`); the overlay marks each page with
  `data-margin-guides` for the end-to-end and film specs.
- Snapping to margin and column guides is not part of this record.

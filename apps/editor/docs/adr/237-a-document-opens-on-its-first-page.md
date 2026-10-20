# ADR 237 — A document opens on its first page

- **Status:** Accepted 2026-10-19.
- **Scope:** `apps/canvas/src/ui/layout.ts` (`openingView`), `apps/canvas/src/ui/ViewportCanvas.tsx`
  (the fit when the canvas attaches and when the document changes).

## Context

A document opened fitted whole: a 19-page document at 3.8 % with every page a sliver and
the page indicator on the page nearest the centre (UX audit F-32). Home already fitted page 1.
InDesign opens a document where it was saved, and a new one on its first spread fitted.

## Decision

The open fits page 1 to the window (`openingView`, the view Home gives), so the indicator
reads 1. Fit whole document stays on Cmd+0 / View ▸ Fit. Adding or removing pages still keeps
the user's view. The saved view of a document (InDesign's) is not read yet; when it is, it
takes precedence.

## Consequences

F-32 closes (`tests/e2e/ux-audit-gestures.spec.ts`). Specs that read the camera after an open
see page 1 fitted.

## Amendment 2026-10-20

Fit whole document is on Alt+Shift+Cmd+0 now; Cmd+0 fits the page, as in InDesign
([ADR 257](257-indesigns-fits-and-page-keys.md)).

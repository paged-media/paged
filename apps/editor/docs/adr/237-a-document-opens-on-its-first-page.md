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

## Amendment 2026-11-13

The open now reports its stages while it runs — recognized, geometry (the pages outlined where
they will be), first paint, refining — in words and real counts on the canvas and in the header,
never a percentage (UXI-PRF-003, UX audit F-53). The fit is unchanged: page 1, fitted, once the
canvas attaches; a later change of the canvas's size keeps the document point at the centre
instead of fitting again
([ADR 1205](1205-docks-are-resizable-and-the-workspace-adapts.md)).

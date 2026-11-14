# ADR 1223 — Publication health on the page

- **Status:** Accepted 2026-11-13.
- **Scope:** `packages/shell/src/state/publication-issues.ts` (new: the issues, the active one,
  the view to return to, per editor), `overlays/issue-markers.tsx` (new: the markers), the view
  toggle `issueMarkers`; `apps/canvas/src/publication-issues.ts` (new: the issues gathered from
  what the engine reports, and going to one), `issue-fixes.ts` (new: each issue's fixes),
  `panels/cockpit/issues-section.tsx` (new: the page overview, the list and the fixes, in
  Publication health), `panels/cockpit/page-lenses.tsx` (the Issues lens reads the same issues),
  `app-commands.ts` (View ▸ Show issue markers). The UX strategy's Concept B;
  `UXI-T55` of the interaction specification; task DF7 of
  [`interaction-plan.md`](../interaction-plan.md). Closes UX audit F-09.

## Context

Publication health counted missing links, low-resolution pictures, missing fonts, overset stories
and the last preflight's findings; the Problems list named the links and fonts (PN-350). Neither
said where on the page a problem was, the Issues lens of the document map ([ADR 1213](1213-page-lenses-and-semantic-zoom.md))
located some of them with its own reads, and nothing offered to fix one.

## Decision

1. **One gathering of the publication's issues per editor**, from what the engine already
   reports: a missing link (error), a picture below 150 effective ppi (warning), an RGB picture in
   a CMYK document (note), each on the frame that holds it; an overset story on the last frame of
   its chain; a missing font as the document's; the last export's preflight findings on their
   pages; what an import left out or converted on its pages ([ADR 1222](1222-compatibility-report.md));
   paged.data's issues as the document's. Each placed issue carries its page and its box. The
   markers, the page overview, Publication health and the Issues lens read this one set.
2. **Markers on the page, when asked** (View ▸ Show issue markers, or the switch in Publication
   health; off by default, never printed): one per item at its top-right corner, one per page for
   a page's issues, coloured by the worst severity, a count when several share it.
3. **A page overview**, "1 2 3! 4 5 6!", in Publication health: a page with issues is a button to
   its worst issue.
4. **Going to an issue** (a marker, a row, a page): the view left is kept to return to ("Return
   to the previous view"), the jump is recorded for Back ([ADR 1211](1211-navigation-history-and-one-current-page.md)),
   the item is selected and the view fitted to it, and its fixes show. Going there and back
   changes neither the document nor the history.
5. **Targeted fixes, each saying what it will do before it runs.** An overset frame that is not
   rotated: Expand frame (to its page's bottom margin; "Extends the frame 148 pt down"), one undo
   step, a result toast with Undo. Where the engine has no operation — a document link cannot be
   relinked by the engine yet — the fix is the panel that handles it (Links, Fonts, Preflight, the
   compatibility report, Data, Stories), never a button that pretends.

## Consequences

- F-09 closes: the issues are where they are, from the page, the list and the lens alike; the
  notice after opening that F-09 asked for is the compatibility report's summary and the failed
  open's toast.
- Tests: `apps/canvas/test/panels/publication-issues.dom.test.tsx`,
  `test/panels/cockpit-publication-health-panel.dom.test.tsx`, and `UXI-T55` in
  `apps/canvas/tests/e2e/uxi-issues.spec.ts` (go, select, return with the model and the history
  untouched; markers and overview; Expand frame is one undo step).

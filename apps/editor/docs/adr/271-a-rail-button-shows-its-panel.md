# ADR 271 — A rail button shows its panel

- **Status:** Accepted 2026-10-20.
- **Scope:** `packages/shell/src/chrome/PanelRail.tsx`, `PagedShell.tsx`. Amends
  [ADR 240](240-react-19-features.md) for the rail.

## Context

Filming the home film, the right rail's Swatches button did nothing once many panels were open.
Two things in the rail could make a press invisible:

- Shift+Tab hides the panels and keeps the rail (Concept 1). A rail button then switched the
  active tab of a dock nobody could see, and on the panel already active it closed it.
- The switch ran as a view transition (ADR 240). A transition yields to every other update, and
  with every open tab's panel kept mounted (ADR 240's Activity) the switch could commit long after
  the press, or appear not to happen while the film moved on.

InDesign's panel icons show their panel whatever state the panels are in; a click collapses only
a panel that is open on screen.

## Decision

- A rail button with the panels hidden shows them again, with its panel active. It never closes
  a panel the user cannot see.
- On visible panels the rail keeps its toggle: the active panel's button closes it, any other
  opens and activates its panel.
- The rail opens its panel as an ordinary update, not a transition: the press lands in the
  same frame. The tab strip's own switches (a tab click, the arrows, the More panels menu) keep
  their directional view transition.

## Consequences

`apps/canvas/test/panels/panel-rail.dom.test.tsx` covers the three cases (many tabs and an
overflowing strip, hidden panels, hidden panels with the panel already active). The rail's
switch no longer slides; the strip's still does.

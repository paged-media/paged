# ADR 265 — The dock's tabs fit the dock

- **Status:** Accepted 2026-10-20.
- **Scope:** `packages/shell/src/cockpit/RightDock.tsx`.

## Context

UX audit F-20: with a module panel open beside Properties and Swatches, the right dock's tab
strip ran wider than the dock. Tabs never shrank, so the strip scrolled sideways with no
affordance and the first tab was cut in half ("perties"). InDesign's panel groups shrink their
tabs as the dock narrows and keep every tab reachable.

## Decision

- The active tab keeps its whole label. Every other tab shrinks down to its icon and an
  ellipsis (40 px, 52 px without an icon), and its title is its tooltip.
- When even the shrunk tabs do not fit, a "More panels" button at the strip's end lists every
  open tab, the active one in bold; choosing one opens it. The button shows only while the
  strip overflows, measured on every resize and every change of the open tabs.
- The strip still scrolls with the wheel and still brings the active tab into view, and the
  tablist keys of ADR 259 still apply.

## Consequences

- F-20 closes (`apps/canvas/test/panels/right-dock.dom.test.tsx`).
- The overflow menu is a Radix dropdown, like the zoom menu, so it has the arrow keys and
  Escape.

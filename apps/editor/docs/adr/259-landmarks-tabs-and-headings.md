# ADR 259 — Landmarks, the dock's tabs and panel headings

- **Status:** Accepted 2026-10-20.
- **Scope:** `packages/shell/src/cockpit/CockpitLayout.tsx` (landmarks),
  `cockpit/RightDock.tsx` (the tablist), `components/cockpit/kit.tsx` (`PanelHeader`),
  `chrome/MenuBar.tsx` (F10).

## Context

UX audit F-50, after ADR 233 and ADR 234: the menu bar was a `menubar` with arrow navigation,
but there was no F10 route into it; the right dock's tab strip had no `tablist` or `tab` roles;
the page had no `main` landmark for the canvas, no `complementary` for the docks, and no
headings (panel titles were styled text).

## Decision

- **F10** (no modifiers) focuses the menu bar's first menu; the arrows then walk the bar.
  Shift+F10 stays the context-menu key.
- **The canvas column is `main`** ("Document"); **the left and right docks are
  `complementary`** ("Left panels", "Panels").
- **The dock's strip is a WAI-ARIA tablist** with automatic activation: each tab is a `tab`
  with `aria-selected` and `aria-controls`, the active tab is the one tab stop, ArrowLeft and
  ArrowRight (wrapping), Home and End move to a tab and open it, Delete closes it. The panel is
  the `tabpanel` its tab labels. With one tab open there is no strip and no tabpanel role.
- **A panel's title is an `h2`** (the kit's `PanelHeader`), so a heading list names every open
  panel.

## Consequences

- F-50's remaining items close (`apps/canvas/test/panels/right-dock.dom.test.tsx`,
  `tests/e2e/keyboard-focus.spec.ts`).
- The close control inside a tab is still a nested clickable span; Delete is its keyboard
  route.

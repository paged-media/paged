# ADR 306 — Module views replace the canvas

- **Status:** Accepted 2026-10-25.
- **Scope:** `packages/shell/src/registries/view.ts` (`createViewRegistry`),
  `packages/shell/src/cockpit/ModuleViewHost.tsx`, the canvas column of
  `packages/shell/src/cockpit/CockpitLayout.tsx`. The editor half of extensions ADR 345 (C5).

## Context

PowerPoint's Slide Sorter, Outline and Notes Page views replace the slide in the middle of the
window while the menus, the ribbon and the document stay. The cockpit already replaces the
document viewport with a panel for export-style workflow modes (a mode's `canvas: "panel:<id>"`
slot), keeping the viewport mounted and hidden (ADR 240).

## Decision

- **A view registry.** `views` holds the bundles' views and which one is shown (`show(id)`,
  `show(null)`, `active()`). A view that is disposed while shown gives the canvas back.
- **The canvas column renders it.** When a view is shown, the cockpit layout renders it in the
  viewport's place (`ModuleViewHost`, a region labelled with the view's title,
  `data-paged-module-view`), exactly as it renders a mode's canvas panel: no rulers, filmstrip or
  status bar around it, the viewport hidden in an `<Activity>` and kept mounted. A shown view wins
  over the mode's panel.
- **Everything else stays.** Menus, panels, the right dock and the document are untouched; the
  view's own `close()` (or the bundle's `showView(null)`) gives the canvas back.
- **Probe.** The registry makes the SDK report `shell.views@1`.

## Consequences

- paged.slide's Slide Sorter is the first view (slide ADR 716); Outline and Notes Page follow in
  wave 3.
- A view is React in the host realm, like panels.

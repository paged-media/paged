# ADR 298 — Control-bar groups and status items follow the edit context

- **Status:** Accepted 2026-10-24.
- **Scope:** `packages/shell/src/registries/context-bar.ts`,
  `packages/shell/src/chrome/{ContributedBarItems,ContextToolbar}.tsx`,
  `packages/shell/src/cockpit/CockpitLayout.tsx`, `packages/shell/src/state/paged-editor.tsx`
  (`documentContext`), `apps/canvas/src/cockpit/control-bar.tsx`,
  `apps/canvas/src/plugin-host-options.ts`. Contract: extensions ADR 348 (C1, C3). Amends ADR
  024's open question (may a context contribute toolbar segments?): yes, through this slot.

## Context

ADR 024 made the context toolbar state where you are and which tools apply, and left open
whether a context may contribute its own segment. paged.doc needs it: inside a Word document the
bar must carry Word's Home group, and a status bar must show pages and words. A Word document
opened as the whole document has no frame-level context at all.

## Decision

- **Registries.** `controlBarGroups` and `statusItems` (scoped item registries: ordered by
  `order`, filtered by context) and the `documentContext` store join the shell registries.
- **Which context.** `activeScopeContext(paged)`: the active frame-level edit context, else the
  document context a bundle holds. `PagedEditor.documentContext` carries the latter; the shell
  drops it on every `documentLoaded`.
- **Control bar.** A frame context's segment (`ContextSegment`) renders its groups after its
  label and tools. With a document context and no frame context, the Design control bar shows
  the groups in place of the text and document controls (`data-control-bar="contributed"`);
  selected page items keep the object controls.
- **Status bar.** `StatusBar` under the canvas column shows the active context's items,
  start-aligned left and end-aligned right; it is not rendered when no item applies, so other
  documents keep the canvas column as it was.
- **Isolation.** Every contribution renders in its own error boundary.

## Consequences

- The bar above the canvas and the status bar below it follow the content, not the workflow
  mode, as ADR 024 asked of the tool rail.
- Contributed groups replace the host's text controls only for a document context; inside a
  frame context they extend the context segment, which already replaced the mode's segment.

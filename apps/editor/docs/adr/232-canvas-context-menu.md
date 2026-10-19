# ADR 232 — The canvas context menu is made of commands

- **Status:** Accepted 2026-10-19.
- **Scope:** `packages/shell/src/chrome/CanvasContextMenu.tsx`, `apps/canvas/src/canvas-context-menu.tsx`,
  `packages/shell/src/registries/keybinding.ts` (Alt chords by physical key).

## Context

A right-click on the canvas opened no editor menu; a browser showed its own page menu (UX audit
F-27). The audit asks for the frequent commands at the pointer, fed by the command registry and
the same `when` predicates as the menus.

## Decision

1. **Rows are commands.** Each row names a command id; the menu shows its title, greys it by its
   own `when` against the live editor, and shows its chord from the keybinding registry. A row
   whose command is not registered is left out. The canvas rows: Cut, Copy, Paste, Paste in
   place · Duplicate · Bring to front, Bring forward, Send backward, Send to back · Group,
   Ungroup · Delete · Select all.
2. **A right-click selects first**, as in InDesign: the menu acts on the item under the pointer
   when it is not already selected; on empty canvas the selection stays. Right-clicks outside
   the viewport keep the browser's menu.
3. **Keyboard:** Shift+F10 and the context-menu key run `paged.edit.contextMenu`, which opens the
   menu at the selection's centre (or the view's). Radix's menu gives roles, focus, arrows,
   Enter, Escape and typeahead.
4. **Alt chords match the physical key** for letters and digits: Option changes `event.key` on a
   Mac, so ⌥⇧⌘V and ⌥⇧⌘D would never have matched.

## Consequences

- Lock and Hide rows came with object lock (F-41, ADR 251); Fitting and Effects rows wait for
  commands that open them. No module contributes a context menu today (none existed inside raster frames
  either); a contribution type for plugin rows is a later, contract-level decision.
- Panel row context menus are not added: the audit asks for the canvas one.

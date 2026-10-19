# ADR 251 — Object lock and hide

- **Status:** Accepted 2026-10-19.
- **Scope:** `apps/canvas/src/object-commands.ts` (`paged.object.lock`, `.unlockAllOnSpread`,
  `.hide`, `.showAllOnSpread`, their Object-menu rows and Cmd+L),
  `apps/canvas/src/canvas-context-menu.tsx`, `apps/canvas/src/main.tsx` (`pageInView`), the
  engine's hit test (`crates/paged-canvas/src/hit.rs`).

## Context

The Object menu had no Lock, Unlock all on spread, Hide or Show all on spread, and Cmd+L did
nothing (UX audit F-41); only layers could be locked or hidden. The engine already carried
IDML's `Locked` and `Visible` on page items (`elementLocked`, `elementVisible`), refused to
move, reshape, restack or remove a locked item, and did not draw a hidden one, but a hidden
item could still be clicked.

## Decision

1. **Four commands, as in InDesign.** Lock and Hide act on the selection; Unlock all on spread
   and Show all on spread act on the spread the selection is on, else the spread of the page
   in view. A group is locked or hidden through its members (the engine keeps both flags on
   page items, as IDML does). Each command is one batch, one undo step; an "all" command with
   nothing to change sends nothing.
2. **Hide deselects** what it hid. A locked item stays selectable and its attributes stay
   editable, as InDesign allows by default; moving it is refused by the engine.
3. **A hidden item cannot be hit.** The hit test and the marquee leave out page items with
   `Visible="false"`.
4. **Keys.** Cmd+L (Ctrl+L) locks. Unlock all (Cmd+Alt+L), Hide (Cmd+3) and Show all
   (Cmd+Alt+3) stay on the menu, the palette and the canvas context menu: Option rewrites
   `event.key` to a layout-dependent glyph, and Cmd+3 is the browser's switch to tab 3 (the
   same reason the clipping-mask pair has no keys).

## Consequences

- F-41 closes (`object-commands.test.ts`, `tests/headless/commands-object.test.ts`).
- Per-object lock icons on the canvas and a lock column in the Layers panel are not part of
  this; the Attributes panel already shows both flags.

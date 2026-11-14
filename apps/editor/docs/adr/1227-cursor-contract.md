# ADR 1227 — Cursor contract

- **Status:** Accepted 2026-11-14 (plan task IC9 of [`interaction-plan.md`](../interaction-plan.md)).
- **Scope:** `packages/shell/src/tools/cursor.ts` (the controller, `writeCursor`, `holdCursor`);
  `apps/canvas/src/ui/ViewportCanvas.tsx` (the canvas's layers); `gestures/use-scrub-gesture.ts`,
  `cockpit/canvas-frame/ThreadingController.tsx`, `state/pending-placement.ts` (their writes);
  the single-owner rule `cursor-write` in `tooling/single-owner.json`. Builds on
  [ADR 1210](1210-the-interaction-coordinator.md) (the session that holds the pointer) and the
  cursor vocabulary of [ADR 226](226-contribution-types-have-one-definition.md) (`CursorSpec`).

## Context

The canvas's cursor had four writers that did not know about each other: React's `style` prop
(the tool's base cursor), the pointer-move handler (a handler's `cursorAt`, a bundle handle's
cursor, each written straight onto the element and remembered in a `data-` flag), the scrub
fields, and the two modes that own every press (a loaded thread, an armed placement), which set
the editor root's cursor with `!important`. The last write won: a re-render put the tool's cursor
back over a handle's, a drag that left the handle showed the canvas's cursor while it resized,
and nothing said which source should win (`UXI-OVR-010`, the specification's §14.3).

## Decision

1. **One controller per editor** (`CURSOR_CONTROLLER`, `useCursorController`) holds the canvas's
   cursor as four layers, the first set wins: **session** (the press that holds the pointer: the
   handle's cursor for the whole of a resize or a rotate, `grabbing` for a pan), **modifier** (a
   held key that changes what the drag does: `copy` for an Alt move that duplicates), **hover**
   (what is under the pointer: a handler's `cursorAt`, a bundle handle's cursor) and **tool** (the
   tool's base cursor). Without any, the canvas's open hand. The canvas sets its layers; a layer
   is cleared when its cause ends (the session's end, the key's release, the pointer leaving).
2. **Two writes, one file**: `writeCursor(element, css, important?)` and `holdCursor(element,
   css)` (a mode's cursor over everything until the returned function restores what was there)
   are the only places that write an element's cursor. The controller writes through the first;
   the scrub fields through the first; the loaded thread and the armed placement through the
   second. React no longer sets the canvas's cursor.
3. **The rule is enforced**: the single-owner rule `cursor-write` (`.style.cursor =`,
   `style.setProperty("cursor"`, `style.removeProperty("cursor"`) has `tools/cursor.ts` as its
   owner; its baseline holds paged.slide's ink layer (a built-in that sees only the contract,
   not the shell), and the pending-placement test that sets a cursor to see it restored is
   allowed.

## Consequences

- A resize keeps its handle's cursor when the pointer outruns the handle; a pan shows the
  closed hand; an Alt move shows the copy cursor while Alt is held.
- `UXI-OVR-010` is proven by `tests/e2e/uxi-cursor.spec.ts` and the controller's unit test
  (`packages/shell/test/tools/cursor-controller.test.ts`).
- The modifier hints (IC10) read the same layers' causes: the session and the keys held.

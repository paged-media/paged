# ADR 1210 — The interaction coordinator

- **Status:** Accepted 2026-11-13: IC1 (the coordinator) and IC2 (the terminal events), behind the
  `coordinator` debug flag. Amended as IC3 and IC4 land; what ships is in
  [`status.md`](../status.md).
- **Scope:** `packages/shell/src/interaction/` (`coordinator.ts`, `owners.ts`, `epochs.ts`,
  `trace.ts`, `interaction-provider.tsx`); the document, camera and tool contexts that feed it;
  `apps/canvas/src/ui/ViewportCanvas.tsx` (the canvas's pointer sessions); the client's
  `onFatal` and `failure`; `chrome/EngineFailureNotice.tsx`; the page entry's `__interaction`
  handle and the `failNext` / `failWorker` of `__chaos`; the `uxi-coordinator` Playwright
  project. Plan tasks IC1–IC4 of [`interaction-plan.md`](../interaction-plan.md); builds on
  ADR 1200 (the contract), ADR 1201 (its decisions) and ADR 1202 (the inventory whose owner
  names `owners.ts` mirrors).

## Context

The interaction specification (§3.2, `UXI-STATE-001`) asks for one framework-independent
coordinator that arbitrates input, owns gesture sessions, sequences their transitions and
cancels them. The editor had none. The canvas kept six gesture refs of its own, and their
precedence was the order of `if`s in `ViewportCanvas`. Nothing ended a gesture when the pointer
capture was lost, the page was hidden, the canvas unmounted, the document was replaced or the
tool switched: a gesture the engine still held made the next drag's begin fail with
`alreadyActive`, and the canvas then turned that drag into a pan. Escape mid-move cancelled the
engine gesture and also turned the rest of the drag into a pan; it did not cancel a marquee or
a press waiting for its hit test. A worker that failed left a press waiting forever, and nothing
said so.

## Decision

1. **One coordinator per editor**, an editor-scope store (`INTERACTION_COORDINATOR`), so two
   editors on one page never share a session (ADR 277). It holds:
   - **Sessions** `{id, owner, kind, toolId, pointerId, pointerType, mutating, epochs, phase,
     signal}`. `begin` opens one; a second claim on the pointer is refused (`UXI-INV-001`)
     unless the claimant ranks higher in §3.4 (`owners.ts` keeps the priority as data) or
     preempts explicitly (a pinch over a pending press, `UXI-CAM-012`). `transition` moves a
     session along the legal edges of §3.3 only (`UXI-STATE-002`). `end` is the owner ending
     its own session; `cancel` and `abortAll` end sessions from outside and call the owner's
     `onAbort` first, to roll back. Each ends a session exactly once (`UXI-INV-002`,
     `UXI-GST-007`). A released session whose commit is still in flight (`committing`) has let
     the pointer go: the next press begins beside it.
   - **Epochs** (`epochs.ts`): `doc` (a load, a replacement, a close), `context` (an edit context
     entered or left), `input` (every new press) and `camera`. A request records a **token**;
     `isCurrent` and `guard` apply its answer only while the epochs it was asked under hold and
     its session was not aborted, and otherwise trace `stale <label> discarded` and resolve to
     `STALE`.
   - **A trace** (`trace.ts`): a ring buffer of begin, phase, end, refusal, abort, stale and
     epoch entries with ids, owner names, tool ids, pointer types, results, fixed reasons and
     latencies. No field can carry user text (`UXI-OBS-001`, `UXI-OBS-002`). Development and
     demo builds fill it; the page entry shows it as `__interaction`.
   - `whenIdle()`, for whoever must wait until no session is open.
2. **The terminal events end sessions where they are seen** (§7.2, `UXI-INV-014`):
   `InteractionProvider` (in `PagedShell`, inside `EditorRoot`) on a window blur, a hidden page,
   a worker that can no longer answer (the client's new `onFatal`) and unmount; the document
   context on a load, a replacement or a close, before the document epoch moves on
   (`UXI-INV-015`); the tool context before a permanent tool switch (`UXI-OWN-012`; a
   spring-load push or pop is not a switch); the canvas on a lost pointer capture (a new
   `lostpointercapture` handler, never for a pinch's lifted finger), `pointercancel` and its
   own unmount.
3. **The canvas's pointer sequences are sessions.** Every press `ViewportCanvas` takes opens one,
   with the inventory's owner: `canvas-select` for a press, a marquee and a click,
   `canvas-transform` for a move, a handle drag and a bundle's handle, `canvas-path` for path
   edit, `frame-content` for a context's content pointer, `canvas-camera` for a pan and a
   pinch, `canvas-text` for the Type tool, and a registered tool's owner (`ownerOfTool`). Each
   has its own roll-back; a move past the click threshold makes it `previewing`; a release ends
   it or hands it to the commit in flight.
4. **No fallback turns a drag into something else.** A begin the engine refuses (a locked item, a
   gesture it still holds, a failed worker) ends the session as aborted, with no mutation; the
   rest of the drag is inert until the pointer is let go. It never becomes a pan. Escape
   cancels the canvas's own session that holds the pointer — a move, a handle drag, a marquee or
   a press waiting for its hit (§12.1, case 3) — and the rest of the drag is inert; a registered
   tool's drag is cancelled by its handler and the canvas lets go of it. Where the press went
   wrong it says so: a failed worker shows `EngineFailureNotice` (what happened, that nothing
   more can change, Reload to get the recovery copy back, ADR 1204).
5. **Behind a flag first** (`UXI-MIG-003`). With `?debug=coordinator` the canvas's sessions are
   the editor coordinator's, and points 2 and 4 apply. Without it the canvas keeps its sessions
   in a coordinator of its own that nothing outside ends, and behaves as before. The
   `uxi-coordinator` Playwright project runs every `e2e/uxi-*.spec.ts` with the flag on (the
   project's `metadata.debugFlags`, which `openCanvas` adds to the page's query), in the editor
   tests' shards: the baseline and the `UXI-MIG-001` tapes come out the same under it.

## Consequences

- Tests (`tests/e2e/uxi-coordinator.spec.ts`): `UXI-T10` (a tool switch mid-move and mid-draw),
  `UXI-T61` (the worker failing after the press), a lost capture and a hidden page (T08, T09
  with `@uxi:UXI-INV-014`), Escape on a marquee and mid-move (T07 with `@uxi:UXI-ESC-001`), a
  document opened mid-drag (`@uxi:UXI-INV-015`), the trace (`@uxi:UXI-OBS-001`); the unit layer
  in `packages/shell/test/interaction/coordinator.test.ts`.
- The inventory's owner names are code now: its guard checks that `owners.ts` names every one.
- Every later task builds on these sessions: the stale guards (IC3), the adapters that replace
  the canvas's refs and join the Escape arbiter (IC4), the cursor controller (IC9) and the
  modifier hints (IC10) read the session that holds the pointer.
- A production build creates the coordinator too (it is cheap) and records no trace.

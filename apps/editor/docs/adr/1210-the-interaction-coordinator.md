# ADR 1210 — The interaction coordinator

- **Status:** Accepted 2026-11-13: IC1 (the coordinator), IC2 (the terminal events), IC3 (the
  stale guards), IC4 (the adapters; the coordinator is the default since, with
  `?debug=legacy-pointer` keeping the old path until IC6 removes it) and IC5 (the press in one
  call). What ships is in [`status.md`](../status.md).
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
5. **Behind a flag first** (`UXI-MIG-003`). With `?debug=coordinator` the canvas's sessions were
   the editor coordinator's, and points 2 and 4 applied; without it the canvas kept its sessions
   in a coordinator of its own that nothing outside ends, and behaved as before. A Playwright
   project ran the `e2e/uxi-*.spec.ts` with the flag on (its `metadata.debugFlags`, which
   `openCanvas` adds to the page's query). Amendment 2 makes the coordinator the default.

## Amendment 1 (2026-11-13): the stale guards (IC3)

The answers that came back whenever they came now carry a token and are applied only while it is
current (`UXI-OWN-008`, `UXI-ASY-002`, `UXI-INV-005`): a click's hit test (`hit-test`), the
press's hit test that decides between a move and a marquee (`press-hit`, tied to its session),
each step of a double-click's chain (`double-click`: the sub-context offer, the hit test, the
owned-content offer, the image probe) and the context menu's select-under-the-pointer
(`context-menu`, `apps/canvas/src/canvas-context-menu.tsx`). A newer press, a document opened or
closed, or an edit context entered or left in between makes the answer stale: it is dropped and
traced (`confirm`), and a press released before its stale hit ends its session as aborted. The
client's `seq` already correlates each reply with its request; no engine change was needed. The
canvas's guards follow the flag; the context menu's checks the document and context epochs
without it too. Tests: `tests/e2e/uxi-async.spec.ts` over fixture H's reply gate (`UXI-T57`, a
click answered after a newer click and a context menu answered after a newer press; `UXI-T59`, a
click answered after a new document and a double-click chain answered after a newer press).

## Amendment 2 (2026-11-13): the adapters at the arbitration boundary (IC4)

The spec's §24.2 adapters, at the boundary and without a rewrite:

- **One arbitration decision.** `apps/canvas/src/ui/press-route.ts` decides what a press is, once,
  at pointerdown (`UXI-OWN-001`, §4.2): a second touch is a pinch; the active edit context's frame
  takes its content pointer; a registered tool takes the primary button (the Type tool keeps the
  click for the caret); a bundle's handle, then path edit (Selection tool); the middle button,
  the Hand, the Zoom tool and a filler's finger are the camera's; otherwise the Selection or Type
  tool's legacy path. The canvas's six refs (the legacy drag, a tool's drag, a bundle's handle
  drag, path edit, a content gesture, a pinch) are one record owned by the coordinator's session,
  and the move, the release and the cancel go to its route; the precedence is that table, not the
  order of `if`s in four handlers. A session ended from outside rolls its record back.
- **LegacySelectionAdapter**: the Selection and Type tools' press, marquee, move, handles and
  click run as before inside that route; the Type tool's drag that starts over text now selects
  text (`UXI-TXT-011`), where it did nothing (the `UXI-MIG-001` tape `type-drag-text` records
  it; `type-drag` keeps the frame pulled out on empty canvas).
- **RegisteredGestureAdapter**: the gesture spine keeps a stack of handlers a spring-load
  suspended and resumes the same one, with what it was building (a Pen path between two clicks);
  a permanent switch ends them all. The Rectangle tool clears its preview while suspended. A
  handler may say it holds a transient state (`busy()`, shell-side; the Pen), which answers Escape
  in the arbiter's transient tier.
- **CameraNavigationAdapter**: D-09 — a spring-load (Space, Cmd, Cmd+Space) held while a
  document-changing session holds the pointer waits until it settles, then takes effect if the
  key is still down (`UXI-OWN-011`); held during a press or a marquee it turns the rest of the
  drag into a pan (the live `forcePan`). The wheel, a pan, a pinch and a zoom click are camera
  input (`cameraInput`): a camera animation in flight stops instead of pulling the view back
  (`UXI-CAM-004`, `UXI-T52`). A second touch preempts the first finger's pending press, rolled
  back, its late hit dropped (`UXI-T71`).
- **ContentContextAdapter**: the canvas's one double-click path is the shell's
  (`enterByDoubleClick` in `state/use-edit-context-entry.tsx`): a sub-context, then text first,
  group descent, an owned image, the edit-context registry; each step checks the token.
- **OverlayRevisionAdapter**: the marquee and the snap lines are written under the session that
  held the pointer then and drawn only while it is open (`state/overlay-signals-context.tsx`, the
  store every transient overlay of the overlay host reads); the canvas also drops a snap-line
  notify that arrives after its gesture (`UXI-GST-006`, `UXI-SNP-006`).
- **Sessions outside the canvas**: the guide drag (`ruler-guide`), the loaded thread cursor and an
  armed placement (both `transient`: a mode that never holds the pointer and that a blur or a
  hidden page leaves alone) are coordinator sessions, ended by a document or tool switch and
  unmount.
- **Escape**: the canvas's gesture handler (gesture tier), the spine's transient handler and path
  edit's (transient tier) are handlers of the Escape arbiter (ADR 1207); the single-owner rule
  `escape-listener` has an empty baseline.
- **The default flips**: the coordinator is on; `?debug=legacy-pointer` keeps the old path and its
  behaviour (`UXI-MIG-003`) until IC6 removes it. The `uxi-legacy-pointer` Playwright project
  runs the `UXI-MIG-001` tapes and the baseline with it, in the editor tests' shards; the
  inventory's interactions answered here are `migrated`.

Tests: `tests/e2e/uxi-adapters.spec.ts` (`UXI-T06` the Alt-drag copy, `UXI-T52` a wheel during an
animation, `UXI-T71` a pinch over a pending press, `UXI-T10` with `@uxi:UXI-OWN-011` the
deferred Hand, a Pen path resumed after a Space pan, a Type drag over text), the unit table in
`apps/canvas/test/unit/ui/press-route.test.ts`; `UXI-T01`, `UXI-T02` and `UXI-T05` (the baseline)
pass on the new path.

## Amendment 3 (2026-11-13): the press in one call (IC5)

A plain Selection-tool press off the selection asks the engine once (protocol 80,
`beginGestureAt`, engine ADR 1303): the hit, the selection it makes by the click's group rule
(`target`: the outermost group; inside an entered group its member; with Direct Selection the
leaf) and the move begun from the press point (`UXI-OWN-006`, `UXI-OWN-007`). Moves that come
before the answer are kept as deltas from the press point, so the move starts where the pointer
went down and never jumps (`UXI-T58`); a release before the answer commits that delta, a click
only selects (the move is cancelled), a press on nothing is a marquee, and a press the engine
takes but will not move (a lock) is inert. A stale answer (a newer press, another document, a
pinch taking over) is undone: its move cancelled, the engine's selection put back to the
canvas's. A Shift press keeps the two-step path (hit, select, begin) until IC6's selection
model. The canvas mirrors the selection through `pressAt.onSelected` (`canvas-panel.tsx`).

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

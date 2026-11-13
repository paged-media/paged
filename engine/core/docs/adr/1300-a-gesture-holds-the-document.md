# ADR 1300 — A gesture holds the document

- **Status:** Accepted 2026-11-13.
- **Scope:** protocol v79. `paged-canvas` (`WorkerError::GestureInProgress`,
  `CanvasModel::refuse_during_gesture`, the guards in `apply_mutation`, `apply_operation`,
  `undo`, `redo`, `undo_to`, `redo_to`, `restore_to`), `paged-canvas-wasm` (the dispatch arms of
  `Mutate`, `AmendMutation`, `Undo`, `Redo`, `ExecuteScript`, `HostObjectsResult`; `UndoTo`,
  `RedoTo`, `RestoreTo` through the model), the editor's client (`GestureInProgressError`,
  `gestureInProgressOf`, `CanvasClient.gestureActive`, `CanvasClient.whenGestureIdle`).
  Implements `UXI-INV-008`, `UXI-GST-012` to `UXI-GST-014`, `UXI-MUT-007` and `UXI-MUT-012` of
  the editor's interaction contract (editor ADR 1200), task EN1 of
  `apps/editor/docs/interaction-plan.md`; proven by `UXI-T60`.

## Context

A gesture (ADR 110's spine, `gesture.rs`) snapshots the items it moves at its beginning, writes
its preview into the scene on every update, and at its commit puts the snapshot back and applies
one canonical operation. Between the beginning and the commit the scene is a preview.

Nothing stopped another channel from writing in that window. A panel field committing on blur,
a plugin's `host.document.mutate`, a script, an undo: each was applied to the previewed scene.
The commit then restored the snapshot over it, so a write to a moved item was lost without a
word, its undo step reverted a geometry the user never saw, and a script read the
half-previewed geometry as if it were the document (`UXI-GST-014`). An undo during a drag
interleaved two histories (`UXI-MUT-007`).

## Decision

**While a gesture is active it holds the document.** From `BeginGesture` until its commit or
cancel, every document write that arrives through another door is refused whole, before any of
it runs, with the typed `WorkerError::GestureInProgress { handle }` (a `MutationFailed` on the
wire):

- a mutation (`Mutate`, and `SetTemplateFields` and `OpenAsTemplate`, which lower to one) and
  an amend (`AmendMutation`);
- the history: `Undo`, `Redo`, `UndoTo`, `RedoTo`, `RestoreTo`;
- a script: `ExecuteScript` is refused before it starts, and a script suspended on the host is
  not resumed — its `HostObjectsResult` is refused and its session kept, so the same answers
  resume it after the gesture.

The model enforces it at its write entries (`apply_mutation`, `apply_operation`, `undo_to`,
`redo_to`, `restore_to`; `undo` and `redo` answer nothing), so every door that reaches them —
the CLI session, the Boa bridge, the MCP server — holds too; the dispatch checks first, so the
reply is typed and nothing (not even the review clock) moves. The gesture's own doors stay
open: `UpdateGesture` (and the shared-memory update), `CommitGesture`, `CancelGesture`. The
commit takes the session before it applies its operation, so its own write passes.

**Not held:** what is not the document's content or history — selection, settings (snap, view,
session policy), fonts and colour profiles, ephemeral scene and pixel layers, resource tiles,
paged parts (plugin data outside the undo history), reads and hit tests. A document load
replaces the model, and the gesture goes with it.

**Refusal, not a queue, at the engine.** The engine has no notion of who is waiting; it answers
at once and the host decides. The editor's client orders its own writes: a write it sends while
a gesture it began is still live (`gestureActive`: a begin in flight, or a begun gesture whose
commit or cancel has not answered) waits for that gesture to settle (`whenGestureIdle`), at most
30 s, then is sent and refused if the document is still held. A script waits the same way, and
a refused resume of a suspended script waits and resends. `whenGestureIdle({ signal, timeoutMs
})` is the door the editor's interaction coordinator uses (`coordinator.whenIdle()`).
`GestureInProgressError` and `gestureInProgressOf(reply)` name the refusal for callers.

## Consequences

- A write never lands between a gesture's preview and its commit (`UXI-MUT-012`); a panel edit
  made as a drag starts (a field committing on the blur the press causes) is applied after the
  drag, to the committed geometry, instead of being overwritten by it.
- A gesture that is never committed or cancelled (a lost pointer capture the host does not
  handle) now blocks writes as well as later gestures. Ending every gesture on every terminal
  event is the editor's task IC2 (`UXI-INV-014`); the client's bounded wait keeps such a host
  responsive with a typed refusal rather than a hang.
- The refusal is all-or-nothing by construction: the check runs before anything else of the
  request.

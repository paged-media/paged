# ADR 1303 — A press is one call

- **Status:** Accepted 2026-11-13.
- **Scope:** protocol v80. `paged-canvas` (`press.rs`: `CanvasModel::begin_gesture_at`,
  `GesturePress`, `PressSelect`, `PressTarget`, `PressOutcome`; `channel.rs`: `BeginGestureAt`,
  `GestureBegunAt`, `From<HitTestResult> for HitResult`), `paged-canvas-wasm` (its dispatch
  arm), the editor's client (`CanvasClient.beginGestureAt`, `GesturePressResult`). Implements
  `UXI-OWN-006` and `UXI-OWN-007` of the editor's interaction contract (editor ADR 1200), task
  EN7 of `apps/editor/docs/interaction-plan.md`; proven by `UXI-T58`.

## Context

A press-drag on an item took three round trips: a hit test, a selection update and a gesture
begin. The host kept the press's point, camera, modifiers and identity across all three, buffered
the pointer meanwhile, and could still apply a late answer to a newer state. A drag that started
before the hit answered either waited or jumped to where the pointer had gone (`UXI-T58`: motion
must start from the original down point).

## Decision

**The engine answers a press in one call against one document state.** `BeginGestureAt(press)`
takes the press — the page and the page-local point, the modifiers held, how it selects
(`select`), which item a press on a group member takes (`target`), the active context's root
(`scope`), the gesture (`translate` by default), the hit filter and the camera scale — and:

1. hit-tests the point (as `HitTest` does);
2. with nothing hit, answers `marquee` and changes nothing: the marquee's release decides the
   selection;
3. takes the item by `target`: `outermost` (the outermost group holding the hit item, as a click
   on the canvas does), `leaf` (direct selection) or `inGroup { id }` (inside the entered group
   the item itself, outside it the outermost group);
4. with a `scope`, answers `outOfScope` and changes nothing when the item lies outside the scope
   of engine ADR 1301;
5. changes the selection by `select`: `replace` makes an item not selected the selection and
   keeps a selection the press lands in (so the drag moves all of it, `UXI-SEL-004`); `toggle`
   adds an item not selected (a drag never takes an item out: deselecting is the click's, D-01);
   `keep` keeps the selection whatever was hit (a press inside the selection's box), and is
   `replace` when nothing is selected;
6. begins the gesture on the selection, anchored at the press point, with the press's modifiers
   (engine ADR 193, amendment 1).

The reply `GestureBegunAt { hit, target, selection, selectionChanged, handle, marquee,
outOfScope, refused }` carries all of it. `refused` is the typed `GestureFailure` when the press
took an item but no gesture began — a lock (the selection change stands: a locked item is
selectable, D-08), a template permission, a copy refused (engine ADR 1302). A press while a
gesture is active changes nothing and is refused `alreadyActive`.

The gesture's updates are deltas from the press point, so moves made before the answer arrive as
one delta from the down point. `HitTest`, `SetElementSelection` and `BeginGesture` keep working.

## Consequences

- The editor's press-drag (task IC5) needs one round trip, keeps no hit-test state of its own,
  and starts the drag from the down point however late the answer is.
- The engine's selection is the one the press made; the reply carries it so the host's view of
  the selection follows without a second request.
- The client counts a press's gesture as live from the send (`gestureActive`), as it counts
  `beginGesture`'s, so writes it sends meanwhile wait for the gesture (engine ADR 1300).

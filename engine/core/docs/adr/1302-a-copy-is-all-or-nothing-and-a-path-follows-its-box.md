# ADR 1302 — A copy is all or nothing, and a path follows its box

- **Status:** Accepted 2026-11-13.
- **Scope:** protocol v80. `paged-canvas` (`gesture.rs`: `alt_duplicate_ops`,
  `duplicate_ops_on_spread`, `DuplicateRefusal`, `GestureError::DuplicateRefused`,
  `GestureSession::duplicate_check`, `NodeMutation::Reshape`, `map_path_into`;
  `channel.rs`: `GestureFailure::DuplicateRefused`, `GestureUpdated.duplicateRefused`,
  `GestureSnapLines.duplicateRefused`), `paged-canvas-wasm` (`GestureRawOutcome`). Implements
  `UXI-SEL-007` and decision D-16 of editor ADR 1201; amends engine ADR 193 (amendment 1, the live
  duplicate preview). Found by the gesture fuzzer at `PAGED_GESTURE_FUZZ_N=200` (seeds 31, 48,
  141 and 155 of the `targets` fixture).

## Context

Two findings of the gesture fuzzer after protocol 79.

**A copy across spreads failed at the release (seeds 48, 141, 155).** An Alt-drag copies the
selection as one snippet (ADR 193), and a snippet holds the items of one spread, its coordinate
space; `extract_snippet` refuses items on two spreads. The preview showed the originals at rest,
and the commit failed with an untyped `other` error after the user had dragged: an unexplained
failure at the end of a gesture, which `UXI-SEL-007` forbids for a multi-object duplicate.

**A pasted copy of a resized path moved on save → load (seed 31).** A handle resize writes the
item's box (`FrameBounds`). An item drawn from its path — a pen path, a line, a many-anchored
rectangle, a shaped text frame (C-78) — paints its anchors, which the box write left where they
were: the drawing did not follow the handles, and the box no longer described the path. The
original survived the round trip only because the writer carried its `GeometricBounds` through;
a copy, written afresh, took its box from the stale path, 116 pt from where it was.

## Decision

**A copy is all or nothing, and says why when it is nothing.**

- A selection on several spreads is copied spread by spread: one snippet per spread, each pasted
  on the spread its items came from, all moved by the same offset, as one undo step. The copies
  keep the originals' places relative to each other. (One spread keeps ADR 193's routing to the
  spread under the pointer.)
- A selection that cannot be copied whole (an item no snippet carries, such as an item together
  with the container it is pasted into) is refused at the press when Alt is held there:
  `BeginGesture` answers `GestureFailure::DuplicateRefused { id, reason }`, the item that stops
  the copy and the reason in words, and nothing moves.
- Alt pressed during a drag of such a selection keeps the drag a move: the preview moves the
  selection, the commit moves it as the preview showed (engine ADR 193, amendment 1: the commit
  is the last preview), and every update carries `duplicateRefused` — on `GestureUpdated`, and on
  the `gestureSnapLines` notification of the shared-memory path — so the host can say why no copy
  appears. Whether a selection copies is decided once per gesture.

**A resize carries a path into its new box.** The resize of an item drawn from its path writes
the box and the path mapped into it (`FrameBounds`, then `FramePath` with the subpath starts
kept), in the gesture's one step; every point keeps its place relative to the box, and an axis
the old box has no extent along moves with the box's edge. The preview writes the same, and a
cancel puts the anchors back from the snapshot.

## Consequences

- The fuzzer's four seeds replay clean (test-kit `engine-gestures.test.ts`, GF-5 and GF-6).
- A host shows a refused copy at the press (`refused` of `BeginGestureAt`, engine ADR 1303) or
  during the drag, never as a failed release.
- A resized path's box and anchors agree, so its IDML is the same whether the writer carries the
  item through or writes it afresh.

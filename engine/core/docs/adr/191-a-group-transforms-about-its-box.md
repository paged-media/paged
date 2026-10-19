# ADR 191 — A group transforms about its box

- **Status:** Accepted 2026-10-19.
- **Scope:**
  - `crates/paged-canvas/src/gesture.rs`: the default pivot of Rotate, Scale and Shear
    (`CanvasModel::selection_box`), and `Resize` of a selection that holds a group
    (`GestureSession::resize_box`, `SelectionBox::resize_matrix`).
  - `crates/paged-canvas/src/snap.rs`: a group's snapshot is never a snap candidate; a group
    resize snaps the edges of its box.
  - No wire change: the gesture messages and the committed operations (`FrameTransform` on the
    group and on every member, one batch, one undo step) are the ones a group's Scale already
    sent.

## Context

A group paints nothing of its own and has no bounds: its box is derived, the union of its
members' outlines measured in the group's own space and placed by the group's composed transform
(`group_box.rs`, the box the editor draws). The gesture spine treated a group as one more frame:

- **GF-1.** A resize handle wrote `FrameBounds` on the `Group` node, which the apply layer refuses
  ("property FrameBounds is not supported on Group"); the gesture failed at commit.
- **GM-1.** Rotate and Scale turned about the mean of the snapshots' centres. A group's snapshot
  carries a zero-bounds sentinel, so the mean included a phantom point at the group's origin: a
  90° pointer turn gave ~37° about a point that was not the group's centre.

InDesign transforms a group as one object about a reference point on the group's box (the centre
by default), and a handle drag on a group is a scale of the group along its own axes about the
opposite handle: `tools/indesign-export/scale-frame-probe.json`, cases 2–4, measured on InDesign
20.0.1 — a group's box turns with the group, a scale along its axes is composed into the members
(a member turned inside the group comes out sheared, cases 3a and 3b). Several selected items
share a box aligned to the pasteboard (cases 1c–1e).

## Decision

1. **The default pivot is the centre of the selection's box.** One target: its own box (a frame's
   bounds placed by its transform; a group's box from `group_box`). Several targets: the
   axis-aligned box of their boxes' corners. An explicit pivot (`GestureAnchor.pivot_in_page`,
   C-67) still wins. For one frame this is the centre it always used; for a group it is the
   group's centre (GM-1); for several items it moves from the mean of their centres to the centre
   of their box, InDesign's reference point.
2. **A resize of a selection holding a group resizes the box.** The handle delta is taken into the
   box's own space, the box is resized by the frame rule (`apply_resize`: the dragged edges move,
   Alt from the centre, Shift keeps the aspect), and the scale and shift that map the old box onto
   the new one, conjugated by the box's placement, are composed into every leaf's transform; the
   groups keep their own (a leaf's transform is already composed into spread space, so the scale
   is written once). A turned group therefore resizes along its own axes and stays a rectangle.
   Kept off the group's transform, a box collapsed to a sliver does not store a scale of 0.0007
   that the IDML writer's four decimals (GF-4) would turn into a move of every member on save →
   load (the gesture fuzzer's paths fixture, seed 2). A selection of leaves only still resizes
   their bounds.
3. **Strokes scale with the transform.** The engine does not model InDesign's "Adjust Stroke
   Weight when Scaling" or "Apply to Content / Adjust Scaling Percentage" preferences; a group's
   scale lives in the transforms, so its strokes and text scale with it, as InDesign's defaults
   draw it for a uniform scale.
4. **Snapping.** A group's snapshot has no geometry of its own and is skipped as a candidate (its
   zero box snapped the phantom origin point); a group resize snaps the moving edges of its box.

## Consequences

- GF-1 and GM-1 close; `platform/shared/test-kit/test/engine-gestures.test.ts` asserts both, the
  gesture fuzzer no longer counts GF-1, and the gesture matrix's GM-1 cells are ordinary cells.
- A group resized by a handle reads back a box of the new size measured in its unchanged frame:
  the scale is in the members' transforms. Its `frameBounds` (the members' axis-aligned union)
  stays read-only on a group. Scale and Rotate compose into the group's transform as well, as
  before.
- Rotating, scaling or shearing several unequal items without an explicit pivot turns them about
  a different point than before (the centre of their box, not the mean of their centres).

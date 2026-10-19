# ADR 192 — A reflection reads as the flip with the smaller turn

- **Status:** Accepted 2026-10-19.
- **Scope:** `crates/paged-mutate/src/operation.rs`: `decompose_transform`, which the
  `FrameRotationAngle`, `FrameScaleX`, `FrameScaleY`, `FrameFlipH` and `FrameFlipV` reads
  (`element_properties`) and writes (`set_property`) share.

## Context

A transform with a negative determinant mirrors, and one mirror has two readings: a mirror
across the vertical axis turned by θ (flip H) or a mirror across the horizontal axis turned by
θ − 180° (flip V). They are the same matrix. `decompose_transform` always chose flip H, so a
vertical flip written by `FrameFlipV` (`[1 0 0 −1 …]`) read back as flip H turned 180°, and the
editor's Flip V switch snapped off the moment it was turned on (PN-202).

InDesign has no stored flip either. Asked through its DOM
(`tools/indesign-export/flip-probe.json`, InDesign 20.0.1), it folds every reflection into the
vertical scale (`absoluteVerticalScale` −100), reads the rotation off the first axis, and names
the flip by that turn: `absoluteFlip` is vertical when the turn is at most 90° and horizontal when
it is more. Flip Vertical on an unturned item reads 0°, vertical; Flip Horizontal reads 180°,
horizontal; turned 120° first, Flip Vertical reads −120°, horizontal.

## Decision

1. **A reflection reads as the flip that needs the smaller turn**: flip H at θ when |θ| ≤ 90°,
   else flip V at θ ∓ 180°; a tie (exactly 90°) keeps flip H. This names the same flip as
   InDesign's `absoluteFlip` for every matrix the probe measured.
2. **The angle is the turn of that reading.** Where InDesign reads a horizontally flipped,
   unturned item as 180°, the engine reads it as 0° with flip H on: the editor shows flips as two
   switches beside a rotation field, and a switch that is on with the rotation that goes with it
   is what a user set. Flip V on an unturned item reads 0° with flip V on, as in InDesign.
3. **Read and write share the reading**, so a value read can be written back unchanged, and
   turning a switch off undoes it: Flip V on, then off, is the identity again. Both flips at once
   are a 180° turn and read as one.

## Consequences

- PN-202 closes: the Flip V switch reads on after it is turned on, on an item turned up to 90°.
  Past 90° the same matrix is the horizontal flip of an item turned the other way, and reads so,
  as InDesign names it.
- Documents with vertically mirrored items read `frameFlipV = true` and their own turn where they
  read `frameFlipH = true` turned 180° before; their matrices are unchanged.

# ADR 295 — Free Transform: one box, the engine's arms, a destructive distort until envelopes

- **Status:** Accepted 2026-10-24.
- **Scope:** `packages/tools/src/handlers/free-transform-tool.ts` (the tool),
  `packages/tools/src/handlers/transform-tools.ts` (`runWorkerGesture`, the driver it shares with
  Rotate, Scale and Shear), the `paged.tool.freeTransform` row of `built-in-tools.ts`, the handle
  primitive in `packages/shell/src/overlays/tool-preview.tsx`, and the Free Transform segment of
  `apps/canvas/src/cockpit/control-bar.tsx`. The engine's vertical shear is the additive
  `GestureAnchor.shearAxis`; the box's geometry and the bundle door are extensions
  [ADR 339](../../../../platform/extensions/docs/adr/339-handle-sets-and-the-transform-box.md).

## Context

`paged.tool.freeTransform` (`e`) was a `planned` stub: every arm it needs existed engine-side —
translate, scale, rotate and shear gestures, each one undo step — but nothing drew a box that
chose among them, or hit-tested it. Illustrator's and Photoshop's Free Transform also distort a
corner freely and in perspective, which no engine arm does, and the envelope effect that would
hold such a distort live is a later work package (WP3.2).

## Decision

- **One box, the chrome's.** The tool's box is the selection chrome's box (one item's turned
  box, the union box of several), hit-tested from geometry with the chrome's screen metrics:
  handles, then the rotate zone just outside a corner, then inside. The eight handles the user
  sees are the chrome's; the tool draws the reference point (and, while distorting, the live
  quad) with the handle primitive.
- **The arms are the engine's.** A drag inside is the `translate` gesture; a handle the `scale`
  gesture from the opposite handle (Alt from the centre, Shift proportional, the Constrain mode
  always proportional); outside a corner the `rotate` gesture about the reference point (Shift
  15°); Cmd/Ctrl on a side the `shear` gesture about the opposite side (Shift 15°). Each is one
  engine gesture and one undo step, through the same begin / buffer / flush driver as the Rotate,
  Scale and Shear tools (`runWorkerGesture`, factored out of them).
- **Vertical shear is an anchor field.** A side that faces sideways on the page shears along y:
  `GestureAnchor.shearAxis: "y"` (`y' = y + k·(x − pivot.x)`). It is `serde(default)` and absent
  means x, so no protocol bump; an older engine shears along x.
- **Distort and perspective are destructive until envelopes.** Cmd/Ctrl on a corner (or the Free
  Distort mode) moves that corner freely; Cmd/Ctrl+Alt+Shift (or the Perspective mode) moves it
  and mirrors its partner on the dominant edge. On release every anchor and handle of each
  target's path is mapped through the quad — bilinear for Free Distort, projective for
  Perspective — and written as one `framePath` per target in one batch: one undo step. Text
  frames, placed images and groups have no path of their own to rewrite; the tool refuses them
  and says why on the canvas. When the engine has an envelope effect (WP3.2) the distort writes
  that instead and stays editable.
- **The Control bar.** While the tool is active the object controls gain the reference-point
  grid (nine points; it sets the rotate and shear pivot and the numeric shear's), the four modes
  (Free Transform, Constrain, Free Distort, Perspective) and a shear angle field, which drives the
  engine's shear gesture once — one undo step. X, Y, W, H and the angle are the bar's existing
  fields. The settings live in the tool-settings store under the tool's id (`reference`, `mode`).
- **The rail.** The tool is the transform slot's default and its status is no longer `planned`;
  `e` activates it.

## Consequences

- A turned single item shears along the page's axes, not its own (the engine's shear arm works
  in page axes); scale and rotate keep its own axes.
- Alt is read at the press for the scale and shear pivot; toggling it mid-drag does not re-anchor
  as the Selection tool's handles do.
- The image module drives the same box for a layer through `host.transformBox` (extensions ADR
  338) and resamples with `geom.warp_projective`.

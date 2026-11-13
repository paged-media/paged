# ADR 125 — Snapping lives in the engine

- **Status:** Accepted 2026-10-05; amendment 2 2026-11-13 (hysteresis, current zoom, ranking, named targets).
- **Scope:** `crates/paged-canvas/src/snap_point.rs`, `crates/paged-canvas/src/snap.rs`,
  `crates/paged-canvas/src/gesture.rs`, the `requestSnapPoint` and `setSnapSettings` message kinds
  (protocol 67)

## Context

Before protocol 67 there were two snapping implementations with different rules.

The engine snapped one gesture, translate. Its targets were the page's edges and centre lines, ruler
guides and the edges and centres of sibling text frames and rectangles. The tolerance was 4 screen
pixels, and Ctrl bypassed it. Resize and path-point edits did not snap.

Drawing and point-editing tools snapped in TypeScript, in the vector plugin and in the editor's Pen
and Direct Selection. Their targets were the page and the points of the path being drawn or edited.
Every other element's geometry was one wire read per element away, so it was not a target. The
tolerance was 6 screen pixels, and Cmd bypassed it.

So moving an object and placing a point snapped to different targets, at different distances, with
different bypass keys. Neither could see the whole page.

## Decision

The engine owns snapping: its targets, its precedence and its settings. Hosts and plugins ask it.

- **Targets** are built once per document build (`SnapIndex`, keyed by the model's build
  generation). They are:
  - every visible leaf's anchors (for a frame drawn from its box, its corners; for an oval, its
    four quadrant points) and each element's centre;
  - the page's corners and centre;
  - the x and y lines through all of those points;
  - the page's edges and centre lines, ruler guides and the document grid;
  - every element's outline.
- **Precedence**, one resolver for every caller: the nearest point within tolerance wins outright.
  Otherwise each axis snaps on its own to the nearest line. Otherwise the point moves to the nearest
  point on an outline.
- **Settings** are session state (`SetSnapSettings`): a master switch, a tolerance in screen pixels
  and one switch per target family. They survive a document load and are neither saved nor undone.
  Grid snapping is off by default, as in InDesign.
- **Query.** `RequestSnapPoint` snaps one page-local point.
  - It can leave out an element, or the anchors being dragged. With anchors named, that element's
    outline is left out too, because the host is previewing a shape the engine has not seen.
  - It can add points only the caller knows, such as the anchors of a path still being drawn.
  - The reply names what the point landed on and the guide lines to draw.
- **Gestures** use the same index and settings. Translate aligns with all five leaf kinds. Resize
  snaps the edges its handle moves. A path-point edit snaps the dragged point through the resolver.
  The index is taken when the gesture begins and held until it ends, because the preview rebuilds
  the document on every tick.

## Consequences

- One tolerance, one precedence and one set of switches cover every tool. A plugin tool snaps
  exactly like the host's tools.
- A point query costs a scan of one page's targets, with distant elements skipped by their bounding
  boxes. It does not walk the document.
- A host whose tool runs its logic outside the engine pays one round trip per pointer sample. The
  editor's Direct Selection snaps locally at once and applies the engine's answer when it arrives
  for the position the drag is still at.
- The plugin-side snapper stays as a fallback for hosts whose engine predates protocol 67.
  (Amended 2026-10-19: the engine and the tools now ship at one revision, so the fallback is
  gone; the host's Pen and paged.draw's Curvature share one snapper over this query,
  `modules/draw` ADR 358.)
- Not built: snapping to text baselines or the baseline grid, snapping a rotated frame's edges
  during translate or resize (rotated members still pass through), and per-target tolerances.

## Amendment 2 (2026-11-13): a held target, the current zoom, a fixed ranking, named targets

Protocol 79; the editor's interaction contract (editor ADR 1200), task EN3: `UXI-SNP-001` to
`UXI-SNP-004`, proven by `UXI-T12`.

- **Hysteresis.** A gesture acquires a target within the tolerance (`SNAP_TOLERANCE_CSS_PX`,
  4 px) and, once it holds it, keeps it until the pointer is beyond the release tolerance
  (`SNAP_RELEASE_CSS_PX`, 6 px; a session tolerance other than 4 scales both alike), unless
  another target within the acquire tolerance is strictly nearer. The held target per axis
  (an angle for a rotate) lives on the gesture session (`SnapHold`), so the snap no longer
  flickers on and off at the edge of reach. Translate, resize, scale and rotate hold; a path
  point's drag goes through the stateless point resolver and does not. The Ctrl bypass drops
  what is held.
- **The current zoom.** The tolerances are screen pixels at the camera scale the host shows
  NOW: every `UpdateGesture` may carry `cameraScale` (the shared-memory update reads it from
  the camera buffer), replacing the scale the gesture began with. A zoom made during a drag
  retunes the reach.
- **Ranking.** Targets at the same distance (within 1e-4 pt) rank by kind — ruler guide,
  margin, column, page edge, page centre, grid, baseline, another item's edge, its centre, an
  anchor point, equal spacing, angle, a caller's point, a whole pixel — then by position,
  adjustment and page, a total order, so one document, camera, pointer and history always
  snap the same way.
- **Named targets.** Every `SnapLine` carries `targetKind` (`SnapTargetKind`), on the gesture
  lines and on `RequestSnapPoint`'s; the overlay labels the line with it. Where two kinds share
  a line, it names the better-ranked one; the winning line names the winner's.
- **Margins and columns** are targets, with the ruler guides (`guides` switch): a page's
  margins on both axes and the edges of its margin box's columns, as the editor draws them,
  for gestures and the point resolver alike (`SnapSource` gains `margin` and `column`).
- `SnapTargetKind::Baseline` is part of the label set; no target produces it yet (text
  baselines and the baseline grid stay on the list of what is not built).

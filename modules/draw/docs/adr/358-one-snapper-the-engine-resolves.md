# ADR 358 — One snapper for the point-placing tools; the engine resolves

- **Status:** Accepted 2026-10-19.
- **Scope:** `packages/draw-tools/src/snapper.ts`, `packages/draw-bundle/src/handlers/curvature.ts`,
  `packages/draw-geometry/src/snap.ts`; in the editor `packages/tools/src/handlers/snapper.ts`
  and the Pen

## Context

Two tools place points with snapping: the host's Pen and this bundle's Curvature. Each had its own
snapper, `createHostSnapper` in the editor's `packages/tools` and `createSnapper` in
`draw-bundle/src/handlers/snapping.ts`. They were the same code with a different transport. Both
asked the engine first (`requestSnapPoint`, protocol 67, engine ADR 125) and fell back to a
TypeScript resolver, `snapPoint` in `draw-geometry`, over the page's corners, edges and centre
lines and the tool's own points. To build the fallback's targets, each tool read the `pages`
collection once per run.

Engine ADR 125 kept that fallback "for hosts whose engine predates protocol 67". Since the
monorepo, the engine, the editor and this bundle ship at one revision (protocol 74 at the time of
writing), so no such host exists for them. The fallback ran only when the engine did not answer,
and then it snapped to fewer targets than the engine would have.

## Decision

- **One snapper.** `createSnapper(query)` in `draw-tools` is the one client of
  `requestSnapPoint` for the point-placing tools. It is host-agnostic: the host passes the
  transport (the editor's wire through `engineSnapPoint`, or a bundle's
  `host.document.snapPoint`) and says when the snap is bypassed. The editor's
  `createHostSnapper` and the Curvature handler are thin adapters over it. The editor already
  consumes the draw machines through `@paged-media/draw/machines` (ADR 350), so this adds no new
  dependency edge.
- **The engine resolves; there is no TypeScript fallback.** An unanswered query (no reply, or
  `tolerancePt: 0`) leaves the point where the pointer put it. The tools no longer read the page
  for fallback targets. `pageTargets` is deleted.
- **What stays local.** The editor's Direct Selection snaps a dragged anchor to the path's other
  anchors on the drag sample itself and applies the engine's answer when it arrives (the latency
  case ADR 125 names), so `snapPoint` and `anchorTargets` stay in `draw-geometry`. The Measure
  tool's origin snap to the nearest point on a hit path is a different query and is not touched.
- **Bypass is the host's.** The host's Pen bypasses on Cmd, on a Shift constraint and with View ▸
  Snap to points off; Curvature bypasses on Cmd, as before. The View toggle is editor state that a
  bundle cannot read.

## Consequences

- One query shape (page, point, zoom as `cameraScale`, the tool's own points) and one rule for an
  unanswered query cover both tools. The unit tests are in `draw-tools/test/snapper.spec.ts`;
  the engine-backed ones in `draw-bundle/test/headless/snapping.spec.ts`, which now also asserts
  that a Curvature run reads no page geometry.
- A host whose engine does not answer gets unsnapped points rather than page-only snapping. No
  in-tree host is one.
- Not done: View ▸ Snap to points is editor state, so a bundle tool ignores it. Driving the
  engine's own snap switches (`setSnapSettings`) from that toggle would make every caller honour
  it; that changes the move and resize gestures too and is a separate decision.

## Related

- Engine ADR 125 — snapping lives in the engine
- [ADR 350](350-three-typescript-layers.md) — geometry, host-agnostic machines, the bundle
- [ADR 352](352-basic-operations-belong-to-the-host.md) — what the host owns

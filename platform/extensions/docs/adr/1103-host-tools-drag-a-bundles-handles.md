# ADR 1103 — The host's Selection tools drag a bundle's handles

- **Status:** Accepted 2026-11-09.
- **Scope:** `OverlayHandleSet.onHostDrag`, `OverlayHandleDrag` and `OverlayHandleDragListener` in
  `packages/plugin-api/src/host.ts`; `HostHandleRouter` and the optional
  `PagedEditor.overlaySignals.setHandleRouter` in `packages/plugin-api/src/editor.ts`; the router
  in `packages/plugin-sdk/src/overlay-handles.ts`; the harness's `dragWithSelectionTool` and
  `selectionToolHandleAt`; the flag `overlay.handles.hostDrag@1`. The editor half is the
  overlay-signals registry (`packages/shell/src/state/overlay-signals-context.tsx`) and the
  Selection tools' pointer path (`apps/canvas/src/ui/ViewportCanvas.tsx`) in `apps/editor`.
  Amends [ADR 339](339-handle-sets-and-the-transform-box.md).

## Context

ADR 339 gave a bundle handle sets the host draws and hit-tests, but a hit reaches only the
bundle's OWN tools (`hitHandle` on their pointer events). A bundle whose handles sit on the host's
selection has no tool to receive them: paged.slide's adjust handles (the yellow handles of a
selected preset, slide ADR 717) are shown while the host's Selection tool is in hand, and a press
on one must change the preset's adjust values instead of moving the shape or starting a marquee.
So slide drew them through `contribute.overlay` with its own DOM pointer handling and its own
screen metrics: the duplicate ADR 339 was written to remove. The two ways out were slide shipping
a selection tool of its own (losing the host's move, marquee and resize) or the host's Selection
tools routing a handle hit to the owning bundle. This is the second, at its smallest.

## Decision

- **A set can hear the host's tools: `set.onHostDrag(listener)`.** While a set has a listener, a
  primary press of the host's Selection or Direct Selection tool on one of its handles is the
  bundle's drag. The host does nothing of its own with it (no move, resize, marquee or path
  edit) and calls `onStart`, `onMove` per move, then `onEnd` once on release, or `onCancel` when
  the drag is interrupted (Escape, pointer-capture loss, a window blur). Each call carries the set
  and handle ids, the handle's page, the pointer and the press in that page's local points, and
  the modifiers. The point stays in the press page's space when the pointer leaves the page.
- **One undo step is the bundle's write.** The host writes nothing. The bundle previews from
  `onMove` (an overlay layer) and writes its change in one `document.mutate` call on `onEnd`, so
  a drag is one undo step and a cancelled drag writes nothing.
- **The host sees a router, not the sets.** The SDK builds one `HostHandleRouter` per bundle over
  its sets that have a listener and registers it through `overlaySignals.setHandleRouter(key,
  router)` (key `<manifest id>/handleDrag`) while any set listens. The router answers `hit` (the
  handle's cursor, for the Selection tool's hover) and `down` / `move` / `up` / `cancel` from the
  same geometry and screen-px radii as the sets' `hitTest`. The editor keeps the routers in a ref
  on the overlay-signals provider (registering one re-renders nothing) and asks them on a press
  before its own hit test: a bundle's handle wins over the selection's resize handles and body.
- **Sets without a listener are unchanged.** They draw and hit as before and answer only the
  bundle's own tools; one listener per set, a second replaces the first, and disposing the set or
  the listener cancels a drag in flight and drops the router when no set listens.
- **Flag.** `overlay.handles.hostDrag@1` is dynamic: true when the editor handle carries
  `setHandleRouter`. Without it the listener is kept and never called; a bundle that has no other
  way to drag its handles should not show them then.
- **The harness plays the tool.** `createHeadlessHost` wires the router, and
  `dragWithSelectionTool(pageId, from, to, { steps, modifiers, cancel })` plays a Selection-tool
  drag through it (true when a handle took the press), with `selectionToolHandleAt` for the hover.

## Consequences

- paged.slide's adjust handles are a handle set (`host.overlay.handles("adjust")`, round handles
  in the host's selection look) dragged by the host's Selection tool, with the preview outline on
  an overlay layer; its `contribute.overlay` contribution and its DOM pointer code are gone. The
  handles take the host's handle look, not PowerPoint's yellow: the handle primitive has no colour
  of its own, and a tone for it would be a contract change of its own.
- Any bundle can put handles on the host's selection (a gradient's ends, a crop on an image frame)
  without a tool, and without reading the camera.
- The Free Transform box (`host.transformBox`) still needs the bundle's own tool; it takes every
  press near it, which the host's Selection tool should not give up.

## Related

- [ADR 339](339-handle-sets-and-the-transform-box.md) — the handle sets and the handle primitive.
- Editor ADR 310 — the host's own live-shape widgets, which stay host overlays.
- Slide ADR 717 — the adjust handles.

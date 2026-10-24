# ADR 339 — Handle sets and a host-drawn transform box

- **Status:** Accepted 2026-10-24.
- **Scope:** `ToolPreviewHandle` and `CanvasPointerEvent.hitHandle` in
  `packages/plugin-api/src/editor.ts`; `OverlaySurface.handles`, `OverlayHandleSet`,
  `OverlayHandleSpec`, `OverlayHandleSpace`, `TransformBoxSurface` and its types, and
  `BundleHost.transformBox` in `packages/plugin-api/src/host.ts`; `overlay-handles.ts` and
  `transform-box.ts` in `packages/plugin-sdk/src` (the router, the doors and the box's geometry);
  the tool door of `host-impl.ts`; the flags `overlay.handles@1` and `host.transformBox@1`. The
  editor half is editor [ADR 293](../../../../apps/editor/docs/adr/293-free-transform.md).

## Context

The overlay doors drew shapes in page points: a rectangle, a polyline, a cubic path, a label.
A bundle that wanted handles (the image module's crop box, a gradient's end points) drew small
rectangles whose size followed the zoom, and hit-tested them itself from the camera scale it
read through the editor handle, each bundle with its own metrics. A transform box (eight handles,
the rotate zones outside the corners, a reference point, Shift / Alt / Cmd and the distort modes)
is the same work again, and the host's own Free Transform tool already does it. The image module
needs it for a layer and a selection in its raster context, where the pixels are its own and the
host must not touch them.

## Decision

- **A handle primitive.** `ToolPreviewHandle` (`kind: "handle"`) is a marker at a constant screen
  size, centred on a page-local point: `square`, `round`, `centre` (a reference point) or
  `rotateZone` (drawn as nothing; a hit area). The editor renders it in the tool-preview slot and
  in overlay layers, in its selection chrome's look.
- **Handle sets: `host.overlay.handles(id?)`.** A retained set of handles the host draws on the
  overlay-layer channel and hit-tests in screen pixels: `set(space, handles)`, `clear()`,
  `hitTest(pageId, pagePoint)`. Positions are in a page's space or in a frame's content space
  (`{ element }`, through the frame's geometry). Every pointer event of the bundle's own tools
  carries `hitHandle: { set, id }` when the pointer is over a handle, and a handle's cursor
  becomes the tool's cursor unless the tool answers `cursorAt` itself. Earlier handles win an
  overlap; sets stack in creation order and go with the bundle.
- **The transform box: `host.transformBox.open(options)`.** The host draws a box over a quad the
  bundle names (page-local, NW NE SE SW), takes the pointer of the bundle's tools while the box is
  open, does the gesture math and reports `{ matrix, quad, reference, mode, operation }` on every
  move (`onChange`) and on commit (`onCommit`); Escape cancels (`onCancel`). `matrix` is a 3×3
  projective matrix, row-major, from the box as opened to the box now: affine after a move, scale,
  rotate or shear, projective after a distort or a perspective drag. The modes are Illustrator's
  touch widget (`freeTransform`, `constrain`, `freeDistort`, `perspective`); `freeTransform` reads
  the modifiers like the host tool (Shift proportional / 15°, Alt from the centre, Cmd/Ctrl on a
  side shears and on a corner distorts, Cmd/Ctrl+Alt+Shift on a corner is perspective). A press
  outside the box beyond the rotate zones reaches the tool. One box per bundle: opening a second
  cancels the first. `toolId`, when given, names one of the bundle's tools the host makes the
  active tool while the box is open, so a command can open a box whatever tool is in hand.
- **An open box is a sub-edit.** While a box is open the SDK reports the bundle's edit context
  dirty, and the editor's context controller then leaves Esc and Enter to the tool in hand (a
  context without `onContentKey` does not claim them): they end the box, not the context.
- **The bundle applies the matrix.** The host never changes the bundle's content: the image module
  resamples its layer with the matrix, a vector bundle maps its anchors.
- **One geometry.** The hit order, the metrics and the drag arms are `transform-box.ts`, exported
  from the SDK root (`hitTestBox`, `operationFor`, `dragBox`, `homographyFromQuads`, `quadMap`,
  …). The host's Free Transform tool runs on it too, so a bundle's box and the host's box behave
  the same.
- **Routing goes through the tool door.** `contribute.tool` wraps each gesture handler the
  bundle's factory makes: the open box takes the events it wants first, every other event reaches
  the handler with `hitHandle` stamped. A bundle's handler sees nothing new unless it reads the
  field.
- **Flags.** `overlay.handles@1` and `host.transformBox@1` are dynamic, true when the host renders
  overlay layers (the handle primitive ships in the same host release as this SDK). Without them
  both doors still answer hits, route and report, and draw nothing. Both are gated on
  `capabilities.rendering` ∋ `"overlay"`.

## Consequences

- A bundle no longer reads the camera to size or hit its handles; the image module's crop box can
  move onto a handle set.
- The box does not show the bundle's content moving while it is dragged; a bundle that wants a
  live preview renders one from `onChange` (the image module previews the quad only).
- An edit context's content-pointer events (`onContentPointerDown`, frame-content points) do not
  carry `hitHandle` yet; a context that edits by pointer through a tool gets it.

## Related

- [ADR 305](305-doors-always-present.md) — the doors always exist; the flags say whether they draw.
- Plugin-api §4.5d (`host.overlay.layer`) — the channel the sets and the box draw on.

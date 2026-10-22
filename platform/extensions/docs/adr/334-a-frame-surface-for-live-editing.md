# ADR 334 — A frame surface: a bundle's live DOM editing surface over its frame

- **Status:** Accepted 2026-10-22.
- **Scope:** `packages/plugin-api/src/editor.ts` (`FrameSurfaceContribution`,
  `FrameSurfaceProps`, `FrameSurfaceRegistry`, `ShellRegistries.frameSurfaces`),
  `packages/plugin-api/src/host.ts` (`contribute.frameSurface`, `shell.exitEditContext`),
  `packages/plugin-sdk/src/host-impl.ts`. The editor side is editor ADR 281.

## Context

A plugin that edits content in place had two drawing channels. A scene layer (C-1) draws inside
the frame through the render worker, colour-managed and print-correct, but every change is a
round trip that rebuilds the document model and re-encodes the page, so a spreadsheet grid that
repaints on every keystroke and scroll step cannot feel immediate. It also takes no input: the
edit context receives raw key events and content points, so there is no caret, no input-method
composition, no hover, no right click and no pointer capture past the frame's edge. The React
overlay (`contribute.overlay`) is camera-transformed SVG with pointer events off. The sheet
plugin's goal, a spreadsheet that works like Excel inside its frame, needs all of these.

## Decision

A bundle may contribute a FRAME SURFACE for one of its edit contexts: a React component the host
mounts as DOM exactly over the frame's content box while that context is active on the frame.

- **Placement.** The host sets the surface's CSS transform to camera ∘ page origin ∘ the frame's
  ItemTransform ∘ the content-box origin, so one CSS pixel inside it is one point of frame
  content, through pan, zoom, rotation and skew. `pxPerPt` tells the component how many screen
  pixels a point covers, so a canvas can size its backing store for crisp drawing.
- **Input.** Events inside the surface are the surface's: the host does not run its tools on
  them, and keys typed while focus is inside it are not handled by the canvas. The component
  uses native DOM input, including its own text field for a caret and input methods.
  `toContentPt(clientX, clientY)` maps a client position into content points (it honours
  rotation, which a bounding rect does not). Cmd/Ctrl-wheel still zooms the canvas.
- **Lifetime.** The surface borrows its edit context: `contextType` must be declared in
  `contributes.editContexts[]` and registered by the same bundle. It mounts on enter and
  unmounts on exit; while mounted it paints over the frame's page content.
- **Leaving.** `exit({ commit })` in the props, and `host.shell.exitEditContext({ commit })` for
  code outside the component, end the bundle's own active context, running `onCommit` or
  `onCancel` first. A bundle can never end another bundle's context.
- **Presentation.** `presentation` is `"frame"` or `"fullscreen"`; `requestPresentation` asks
  for full screen, which a host may refuse (probe `editContext.frameSurface.fullscreen@1`).
- **Probes.** `contribute.frameSurface@1` (the door exists), `editContext.frameSurface@1` (the
  host wires a registry and will mount surfaces), `shell.exitEditContext@1`.

## Consequences

- The surface is React in the host's realm, the same accepted exception React panels are
  (DESIGN.md §6). Its isolate form is a transferred `OffscreenCanvas` plus a plain-data input
  stream and the host's input-method proxy; that is recorded, not built.
- Print parity is the bundle's job: what it draws live must match the document content it
  writes when the context ends (the sheet plugin uses the document's own font bytes and one
  track computation for both, sheet ADR 510).
- The scene layer stays for content that must render through the engine while not edited.

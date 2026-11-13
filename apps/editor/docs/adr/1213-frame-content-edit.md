# ADR 1213 — Frame, content, edit: a picture frame enters its content first; the trail stays in a fixed bar

- **Status:** Accepted 2026-11-13.
- **Scope:** `packages/shell/src/state/frame-content.ts` (the levels, the picture frame's
  content level `paged.imageContent`), `state/use-edit-context-entry.tsx` (the picture-frame
  lane, `enterFrameLevel`), `chrome/FrameLevelControl.tsx`, `chrome/ContextToolbar.tsx`,
  `chrome/EditContextBreadcrumb.tsx` (`ContextTrail`), `state/edit-context-controller.tsx`
  (Enter on the content level); paged.image's context (`editsPlacedImages`, its `onEnter` takes
  the picture in) and every module's `label` (extensions ADR 1106). Task CM3 of
  [`interaction-plan.md`](../interaction-plan.md); D-05 of [ADR 1201](1201-interaction-decisions.md);
  the UX strategy's §3.2. Amends [ADR 282](282-enter-enters-owned-content.md) and
  [ADR 284](284-the-breadcrumb-stays-under-the-title-bar.md).

## Context

A picture frame has three things to edit: the frame, where the picture sits inside it, and the
picture's pixels. A double-click on a frame paged.image had marked entered the raster context
(its brushes and layers) directly; a placed picture it had not marked entered nothing; moving
the picture inside the frame was a Cmd-drag nobody saw. The breadcrumb and the context toolbar
named contexts by their type (`rasterImage` became "Raster image", `sheet` "Sheet"), not by what
the user edits (F-45). The breadcrumb was a 28 px row inserted under the title bar while a
context was entered, so the canvas, the rulers and the docks jumped down and back (F-48).

## Decision

1. **Levels.** A selected frame offers Frame, then Content when it holds a picture, then Edit:
   the context that declares `editsPlacedImages` for a picture ("Edit image"), or the context of
   the plugin that owns the frame by its metadata, named as the plugin names it. A frame with
   one level shows no control.
2. **Content is a host context** (`paged.imageContent`) on the edit-context stack, entered on
   the frame: a drag inside the frame moves the picture, Alt scales it, Shift rotates it (the
   content grabber's gestures without Cmd), one engine gesture and one undo step each; the frame
   never moves. The drag follows the pointer past the frame's edge; Escape during it puts the
   picture back. It declares `commit-if-safe`: nothing is in flight between drags, so leaving
   never asks (ADR 1212).
3. **D-05: Content first, Edit explicitly.** A double-click on a picture frame enters Content.
   Edit image is entered by the level control, by Enter (on the selected frame, as ADR 282
   decides for owned content, and on the Content level), or by a second double-click on the
   Content level. Content another plugin owns by an object type (a lowered sheet, a web frame)
   is unchanged. `tryEnterEditContext` decides all of it, so the canvas's double-click needs no
   picture check of its own: track IC's content adapter calls it for every double-click.
4. **paged.image takes the picture in on entry** when its session does not hold that frame yet
   (no marker of its own), as Adjust image does, so Edit image works on any placed picture.
5. **Labels name the content** (UXI-CTX-005): the breadcrumb, the context toolbar and the level
   control show the module's `label` in the editor's language ("Spreadsheet", "Web frame",
   "Image", "Chart"), else the type as words.
6. **The trail lives in the context toolbar** (UXI-CTX-008, F-48): the toolbar's height is fixed,
   and it carries the trail — the entered groups and contexts, the last one the context's name,
   then the Frame / Content / Edit control — while a context or a group is entered. Where a
   profile shows no context toolbar the trail floats over the top of the work area and takes no
   row. Entering or leaving a level never moves the page or resizes the canvas; zooming to the
   content stays a separate, visible navigation (UXI-CTX-009).

## Consequences

- `UXI-T36` and `UXI-T51` (`tests/e2e/uxi-module-conformance.spec.ts`): a double-click on fixture
  E's picture frame enters Content, a drag there moves the picture and not the frame (one undo
  step), the camera and the canvas box stay; Edit image enters paged.image.
- InDesign users find its own order: the first double-click on a picture is the content grabber.
- `ViewportCanvas.tsx` keeps its Cmd-drag grabber on the Frame level; its own `holdsImage` check
  before `tryEnterOwnedContent` becomes redundant when IC routes the double-click through
  `tryEnterEditContext`.
- The UX audit's F-45 (context labels; the control bar's selection label follows the same
  `label`) and F-48 close; F-43 is helped (one level control, the image tools only on Edit).

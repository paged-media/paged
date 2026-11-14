# ADR 1308 — Relinking a picture keeps its frame and its size

- **Status:** Accepted 2026-11-14.
- **Scope:** protocol v81. `paged-wire` (`Mutation::RelinkImage`), `paged-mutate`
  (`Operation::RelinkImage`, `apply/relink_image.rs`, the permit classes), `paged-canvas` (the
  lowering, `relinked_image_transform`), `paged-canvas-wasm` (the binary bytes lane fills a
  relink's bytes), `paged-script` (`paged.relinkImage`), `paged-introspect` (the catalog), the
  editor (`apps/canvas/src/relink.ts`, Publication health's Relink fix, the Links panel's Relink…).
  Closes the gap editor ADR 1223 recorded ("a document link cannot be relinked by the engine
  yet").

## Context

A placed picture's source could be set (`placeImage`, a link URI) or replaced by bytes
(`replaceImageBytes`, the inline lane), but nothing replaced a link's source as InDesign's Relink
does: one step that points the frame at a new file and keeps everything else — the frame, its
fitting, where the picture sits in it and the size it has on the page. Publication health's fix for
a missing link could only open the Links panel, whose Relink was a seam.

## Decision

**`relinkImage { elementId, uri, bytes? }` is one undoable step.** The graphic frame (a Rectangle,
Oval or Polygon) takes `uri` as its link source (`LinkResourceURI`; a file the editor picked is
`file:///<name>`) and `bytes`, when given, as the new source's contents — embedded in the inline
lane, because the editor holds a picked file the engine cannot fetch; absent, the inline bytes are
cleared and the link draws through the asset resolver. The frame's box, path and fitting are not
touched. The picture's transform inside the frame is kept, scaled so the new picture covers the
box the old one did when both sources' pixel sizes are known (InDesign's "Preserve image
dimensions when relinking", its default); an old source that never drew keeps the transform as
it was. The old source's recorded colour space and ppi (`image_metadata`) are dropped: they
described the old file.

A picture anchored in the text (ADR 208) keeps its link and its transform on the story and has
no embedded-bytes lane: it is relinked to a source the engine can read (a URI without bytes), and
a relink with bytes is refused with that reason.

The canonical operation, `Operation::RelinkImage`, SETS all of these — the link, the bytes, the
transform, the metadata and the frame's image flag — so its inverse is the same operation with the
values it replaced, and undo and redo restore them exactly. It is permitted as `replaceImageBytes`
and `placeImage` are (`ImageReplace`); its undo step is named "Relink". `mutateWithBytes` fills an
empty `bytes` of a `relinkImage` as it does a `replaceImageBytes`, so a picked file crosses to the
worker without a `number[]`; scripts call `paged.relinkImage(frameId, uri, bytes?)`.

## Consequences

- Publication health offers Relink… on a missing, low-resolution or wrong-colour-space picture
  (a file picker, then one undo step), with Open Links beside it; the Links panel's Relink…
  relinks the picked row.
- The Links panel names the new source and its status follows the build ("ok" once it draws).
- Tests: `paged-canvas` `it::relink_and_facing` (a missing link relinked and undone, the size
  kept), `paged-mutate` serialization, `paged-script` `script_surface`, the Links panel DOM test,
  and the editor's `issue-fixes` behaviour through the publication health tests.

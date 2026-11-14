# ADR 1312 — An anchored picture has an embedded lane, and an embedded picture is a link

- **Status:** Accepted 2026-11-14.
- **Scope:** protocol v83. `paged-model` (`AnchoredFrame.image_bytes`), `idml-import` (an anchored
  `<Image>`'s `<Contents>`), `idml-export` (`inline_objects.rs` writes them), `paged-renderer`
  (`pipeline/anchored.rs` draws them), `paged-mutate` (`apply/relink_image.rs`), `paged-canvas`
  (`links()`, `LinkSummary.embedded`), the editor (the Links panel, Publication health, the
  document map). Amends engine ADR 1308; closes the rest of UX audit F-43.

## Context

Engine ADR 1308 relinked a picture anchored in the text (ADR 208) only to a source the engine can
read, a URI without bytes: an anchored frame had no embedded-bytes lane, so a file the editor picked
— which it holds as bytes the engine cannot fetch — was refused for it. And `links()` listed a
picture only by its link URI, so a picture placed from bytes (the editor's Place, a pixel edit, a
picked file) was in no Links panel and no count: Publication health said "0 Placed links" with a
picture on the page (F-43).

## Decision

1. **An anchored frame carries its picture's bytes**, `AnchoredFrame.image_bytes`, the twin of a
   free frame's `image_bytes`: the renderer draws them in place of the link (bytes win, as on a free
   frame, Q-03), the IDML export writes them as the `<Image>`'s `<Properties><Contents>` with a
   `<Link StoredState="Embedded">` (a frame with bytes and no link is named from its id and the
   bytes' format), and the importer reads them back. Absent from the serialised model while unset,
   so an anchored frame without them serialises and hashes as before.
2. **A relink with bytes succeeds on an anchored picture**: `RelinkImage` sets the link, the bytes
   and the transform together and its inverse restores all three, as ADR 1308 does for a free frame.
   A save writes the relinked picture: the story writer's patch lane passed an anchored object's
   source bytes through unless its look changed, so a relink (by URI too, since ADR 1308) never
   reached the IDML; its picture — link, transform, bytes — now counts as a change of the object
   and the story part is written fresh.
3. **An embedded picture is a placed link.** `links()` lists every frame that holds a picture's
   bytes, free or anchored, with `embedded: true`; one with no link source of its own is listed as
   `inline:<host id>`. The editor counts them under Placed links ("3 · 1 embedded"), and the Links
   panel names a source-less one "Embedded picture" with an "embedded" badge, InDesign's word.

## Consequences

- F-43 is closed: one tool set (paged.image ADR 487), embedded pictures counted and named, one
  spelling (the UI's US English "color", F-17).
- `LinkSummary` gains `embedded`; a consumer that grouped links by URI sees `inline:` entries for
  pictures that have no file.
- Tests: `paged-canvas` `it::relink_and_facing` (an anchored picture relinked by bytes draws them,
  is embedded, saves and reads back its `<Contents>`, undoes to the canonical hash; a picture placed
  from bytes is listed as `inline:<frame>`), the Links panel DOM test.

# ADR 207 — An undecoded link is not a missing link

- **Status:** Accepted 2026-10-20.
- **Scope:** `RenderDiagnostics::{missing_image_frame_ids, undecoded_image_frame_ids}`
  (`crates/paged-renderer/src/diagnostics.rs`) and `LinkSummary.status`
  (`crates/paged-canvas/src/{model,channel}.rs`), read by the editor's Links, Publication
  health, Document map, Problems and readiness panels.

## Context

A placed image ends its build in one of three ways: its bytes decode and it is drawn; its link
resolves to nothing and the frame draws the grey missing-image placeholder
(`ImageLinkMissing`); or its link resolves, the bytes are there, and no decoder reads them
(`ImageDecodeFailed`) — an EPS (there is no PostScript interpreter, by declaration) or a payload
the raster decoders reject. The renderer already treats the third case as content that exists:
the frame paints its own fill instead of a "missing image" badge over it (Q-14).

`missing_image_frame_ids` folded the second and third cases together, so `LinkSummary.status`
said `"missing"` for both. A document with one placed EPS reported a missing link in the
Publication health panel and in the assistant's suggestions while the file was right where the
link said it was. InDesign reports such a link as OK.

## Decision

1. `missing_image_frame_ids` holds the frames whose link resolved to nothing
   (`ImageLinkMissing`) — the frames that draw the placeholder.
2. `undecoded_image_frame_ids` holds the frames whose link resolved to bytes no decoder reads
   (`ImageDecodeFailed`).
3. `LinkSummary.status` is `"missing"`, `"undecoded"` or `"ok"`. The wire shape is unchanged
   (the field is a string), so the protocol version does not move.
4. The editor counts only `"missing"` as a missing link. The Links panel marks an
   `"undecoded"` link "not drawn", so the fact that this engine does not paint it stays
   visible where the links are listed.

## Consequences

- A placed EPS no longer reads as a missing link; a link to nothing still does.
- A reader that treated every status other than `"ok"` as broken has to learn the third value;
  the editor's readers compare against `"missing"` and need no change beyond the Links panel's
  badge.

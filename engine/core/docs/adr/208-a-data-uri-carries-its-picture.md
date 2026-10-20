# ADR 208 — A data URI carries its picture; a picture in the text is a listed link

- **Status:** Accepted 2026-10-20.
- **Scope:** `resolve_image_id` / `data_uri_bytes` (`crates/paged-renderer/src/pipeline/images.rs`)
  and `CanvasModel::links` (`crates/paged-canvas/src/model.rs`). Follows
  [ADR 207](207-an-undecoded-link-is-not-a-missing-link.md).

## Context

paged.doc lowers a Word document's embedded picture to an anchored Rectangle whose link is a
`data:image/png;base64,…` URI: the bytes travel in the link. The renderer handed every link to
the host's asset resolver, which has no file for a data URI, so the picture drew the grey
missing-image placeholder.

That placeholder was also invisible to every report. `CanvasModel::links` listed the pictures
of spread-level Rectangles, Ovals and Polygons only; a picture anchored in the text (inline or
anchored, in a paragraph or a table cell, at any depth of an anchored Group) was never listed,
although the build reported its `ImageLinkMissing` under the frame's own id. A document could
paint a placeholder in its text while the Links and Publication health panels read clean.

## Decision

1. A link that is a `data:<mime>;base64,<payload>` URI resolves to its decoded payload; no
   resolver is asked. Any other link, and a data URI that is not base64, is resolved as before.
2. `CanvasModel::links` lists every picture anchored in a story — paragraphs and table cells,
   anchored Groups recursively — with the status the build gave it (`ok`, `missing`,
   `undecoded`), its host kind `Rectangle`.

## Consequences

- A placed Word document's picture paints.
- A broken link on a picture in the text is counted where every other broken link is.

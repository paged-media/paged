# ADR 10XX — A snapshot can draw a story the document does not hold

- **Status:** Accepted 2026-10-27.
- **Scope:** protocol v76 (additive; no bump). `paged-canvas`: `RequestSnapshot.story`,
  `SnapshotPng.story`, `SnapshotStory` / `SnapshotParagraph` / `SnapshotRun`
  (`snapshot.rs`), `CanvasModel::build_page_with_story` (`snapshot_story.rs`),
  `build_page_filtered_in` (`model.rs`). The SDK half is extensions ADR 349.

## Context

paged.image's type layers need text laid out exactly as a text frame lays it out, at an image's
resolution, without the text becoming a page item (extensions ADR 349).

## Decision

- A `RequestSnapshot` may carry a `story`: paragraphs of styled runs and a frame `bounds` on the
  request's page. The model clones its scene, inserts a text frame and its story through the
  operation layer's own `InsertNode` (so the frame is what `insertTextFrame` makes), fills the
  story's paragraphs from the request, and builds the page with nothing else visible
  (`build_page_filtered_in` with `only` = that frame). Colours are added to the copy's palette as
  RGB swatches. The frame has no inset and ignores text wrap; `firstBaseline` sets InDesign's
  Fixed first baseline offset.
- An absent `clip` draws the frame's box; `trim`, `format` and `background` behave as for any
  snapshot. The reply sets `story: true`.
- The document, its history, its id counters and its layout cache are untouched.

## Consequences

- One document build per call, the cost of ADR 338's `only`.
- A story's line breaks, justification, hyphenation and fonts are the page's own.

## Evidence

- `crates/paged-canvas/tests/it/snapshot_story.rs` — drawn alone with the run's colour and the
  document unchanged; wrapping and alignment; forced breaks and paragraphs; the fixed first
  baseline; a story without an area refused.

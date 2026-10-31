# ADR 342 — A story the document does not hold

- **Status:** Accepted 2026-10-27.
- **Scope:** `RenderSurface.story`, `RenderStory`, `RenderStoryParagraph`, `RenderStoryRun` and
  `RenderStoryOptions` in `packages/plugin-api/src/host.ts`; the `story` door and `wireStory`
  in `packages/plugin-sdk/src/host-impl.ts`; the flag `render.story@1`. The engine half is
  `RequestSnapshot.story` and `SnapshotPng.story`, additive on protocol 76 (core ADR 1035).
  Builds on [ADR 338](338-items-render-to-pixels.md).

## Context

paged.image's type layers (plan WP5.10) keep editable text inside an image: a layer whose pixels
are a render of its text. The text must be laid out by the engine — the composer, justification,
hyphenation and the document's fonts — not by a second shaper in the module (PM-0014). ADR 338
draws items the document holds. A type layer's text is not a page item: putting a hidden frame
into the document for each one would add items, undo steps and IDML content the user never made,
and the image's edit context owns undo while it is active (image ADR 463).

## Decision

- **`host.render.story(pageId, story, options)`** lays out `story` in a frame at `story.bounds`
  (page pt) on `pageId` and draws it alone, on a transparent ground, at `dpi` (default 72),
  cropped to what it draws within `marginPt` of the frame (default 0; `trim: false` keeps the
  frame's box). The engine inserts the story into a COPY of the document; the document is not
  changed.
- **The story is plain data**: paragraphs (IDML justification names, indents, space before and
  after, hyphenation, composer) of runs (text, family, style, size, leading, an sRGB fill,
  tracking, baseline shift, scales, skew, underline, strikethrough, ligatures, capitalization,
  position). A `\n` in a run is a forced line break. `firstBaseline` fixes the first baseline's
  distance from the frame's top (point type sits on its anchor).
- **The SDK sends only the contract's fields**, each checked (`wireStory`), and answers `null`
  unless the reply carries `story: true` and a region: an engine that does not know the field
  draws the page instead, which must never be handed out as the story.
- **Static flag** `render.story@1`, like `render.snapshot@2`.

## Consequences

- paged.image draws type layers through it, at the image's resolution (image ADR 474).
- A story drawn this way gets no text wrap from the page's items and no IDML; the bundle that
  owns the text owns its persistence.
- Each call builds the document once, as ADR 338's `only` does.

## Related

- [ADR 338](338-items-render-to-pixels.md) — items render to pixels.
- Image [ADR 474](../../../../modules/image/docs/adr/474-type-layers.md) — type layers.

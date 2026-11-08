# ADR 1058 — One PDF page reader for the placed PDF and place-as-vectors

- **Status:** Accepted 2026-11-08; built (slice 1 of W9).
- **Scope:** `paged-pdf-page` (new), `paged-renderer` (`pipeline/placed_pdf.rs`), paged.publish's `pdf-import`
  (`vectors/`). Part of the capability layering of PM-0014 and PM-0017.

## Context

The engine drove hayro twice: a placed PDF draws into the display list (`placed_pdf.rs`, ADR 154) and
paged.publish's place-as-vectors collects a page into the bundle's vector IR (`pdf-import/vectors`). The page
box geometry (crop, media, trim, bleed, art, rotation, the media-box intersection and the empty-box fallback,
ADR 1003) and the table of PDF blend modes existed twice; the second copy said it was "kept in step" with the
first.

## Decision

`paged-pdf-page` is a pure leaf crate over `hayro-interpret` (no features, so the renderer's native embedded
fonts do not unify into the bundle) and `kurbo` 0.13. It owns `geometry(page, PageBox)` and the `Blend` enum
(`from_hayro`, `idml_name`). Both consumers map their own box enum onto it and keep their own `Device`.

The two devices stay two: they write different targets (display-list commands in linear light with patterns as a
stand-in grey, against IR items with shadings, masks and losses), and a shared device would be a trait with two
implementations of every method. What a device cannot decide, which box is shown and what a blend mode is, is
decided once.

## Consequences

- Behaviour is bit-identical: the geometry code and both blend tables moved without change (the renderer's
  `Normal` fallback for an unnamed mode is `Blend::Normal`). The placed-PDF tests and goldens and the
  `pdf-import` vector tests are the proof.
- A third PDF reader (a handout import, a PDF/X check) takes the crate, not a third copy.

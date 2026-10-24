# ADR 704 — PPTX export regenerates slides and carries masters, layouts and themes

- **Status:** Accepted 2026-10-05.
- **Scope:** `pptx-export`, `packages/slide-host-model`, the exporter in `packages/slide-bundle`

## Context

Once a deck is native, edits land on the engine's model. Patching them back into the original
XML (the Word plugin's approach) would need a mapping from every native edit to a byte range;
for slides, where shapes are created, moved, regrouped and restyled freely, that mapping is most
of an exporter anyway.

## Decision

- An **unedited** deck (its fingerprint equals the one recorded at import) exports as the original
  bytes.
- Otherwise slides are **regenerated** from a read model of the native document. Slide masters,
  layouts and themes are copied from the original package through the layout map whenever the
  master spread they came from is unchanged; an edited or new master spread becomes a new layout.
- Placeholder-tagged items become placeholders again, writing only what differs from the layout.
  Shapes whose geometry still matches their stored preset become preset geometry. Paragraph
  styles `Body Ln` become list level n. Notes, transitions and timing come from plugin metadata.
- What cannot round-trip is listed in the export dialog.

## Consequences

- Any native edit can be exported; fidelity depends on the read model, not on a patch mapping.
- Byte-level identity holds only for unedited decks.

## Amendment (2026-10-24): identity per slide

[ADR 711](711-powerpoint-parity-program.md): byte identity holds per slide. A slide the
document did not change keeps its part, its relationships and its notes byte for byte, even when
other slides were edited. Within an edited slide, an unchanged shape keeps its original XML.
Export reads the document through `host.documents.exportPaged`.

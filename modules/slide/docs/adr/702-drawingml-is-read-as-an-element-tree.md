# ADR 702 — PresentationML and DrawingML are read as an element tree

- **Status:** Accepted 2026-10-05.
- **Scope:** `pptx-import`

## Context

`ooxmlsdk` provides typed structs for every PresentationML and DrawingML element. DrawingML is
deep and almost entirely optional: a shape may or may not have a transform; a fill is one of six
choices; text properties inherit field by field across five levels. Reading it through the typed
structs means unwrapping a nested option or choice at almost every step, and a typed parse fails
on content the schema does not expect.

## Decision

`pptx-import` reads parts with a small namespace-aware element tree over `quick-xml`
(`pptx-import/src/xml.rs`), matching elements by namespace and local name. An element it does
not know is skipped and, where it matters, reported as a diagnostic. `paged-ooxml` is used for
the package and relationships. The format-level result is the `pptx-core` IR, which keeps the
file's units (EMU, 60 000ths of a degree, 1 000ths of a percent) and leaves inheritance
unresolved.

Export (ADR 704) may use the typed structs where writing benefits from them.

## Consequences

- The reader is short and tolerant of real-world files: all corpus decks read with no error.
- Correctness against the schema is checked by tests and the PowerPoint oracle (ADR 705), not by
  the type system.

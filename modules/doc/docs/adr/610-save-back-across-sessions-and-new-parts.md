# ADR 610 — Save-back across sessions and new parts

- **Status:** Accepted 2026-10-24.
- **Amends:** [ADR 602](602-save-back-is-a-byte-splice.md) (save-back is a byte splice).
- **Scope:** `docx-export` (`styles.rs`, `overlay.rs`, `diff.rs`, `splice.rs`,
  `apply_style_plan`), `docx-js/src/core.rs` (`save_edited_full`, `style_tokens`), the bundle's
  exporter (`activate.ts`, `save-styles.ts`, `doc-state.ts`).

## Context

ADR 602 left four gaps that the Word-parity plan (wave W1) closes on the plugin side:

1. Only `word/document.xml` was ever changed. A Word style modified in paged, or a style made
   in paged and applied to text, did not reach the file.
2. The overlay parsed the paragraph style read back from the canvas and dropped it: a style
   applied on the canvas was not saved.
3. An edited run with a drawing, a field character or a note reference *between* two of its
   texts was refused; a paragraph added in a table cell took its neighbour's `w:pPr`.
4. ADR 602 recorded that save-back worked only in the importing session.

## Decision

- **Reopen-then-splice.** The original `.docx` is a container part of the document
  (`host.parts`, the label's `part`, content-addressed `sources/<sha256>.docx` once the object
  model writes it), and its lowering is cached beside it (`lowered/<sha256>.json`). An export
  with no import record in the session (a document opened from a saved `.paged`, or after a
  reload) finds the document by its label, reads the part back through `host.parts.read`
  (contract `storage.parts@1`), lowers it again where the cache is missing, reads the
  stories, and splices exactly as in the importing session. The importing session takes the
  same path whenever the label is found. ADR 602's "works only in the session that imported
  the file" no longer holds.
- **The paragraph style read back is applied.** A read-back paragraph takes the paragraph
  style the canvas reports when the lowering knows it (a Word style token or one the lowering
  synthesized) or it is a style made in paged that this save writes; the engine's own default
  style, or anything else unknown, leaves the paragraph's style as it was. The differ then
  writes `w:pStyle` (and drops direct properties the canvas no longer shows) through the
  existing paragraph-format edit, which keeps numbering, borders, line spacing and `sectPr`.
- **`styles.xml` is a splice target.** The bundle reads each of the document's Word styles
  and every paragraph or character style made in paged with `document.styleProperties`
  (their OWN values: `""` / `null` where a style inherits) and hands them to the engine
  (`styles`). The engine compares a Word style's own properties with what the lowering gave
  it, on the properties the import maps (font family and style, size, colour, underline,
  strike, position, case, baseline shift, tracking; alignment, indents, space before and
  after, keep lines), and writes only what changed: the style's `w:rPr` through `merge_rpr`
  and its `w:pPr` through `merge_ppr` keeping its tabs, `keepNext` and page break, each new
  element at its schema place. Every other style and byte of the part stays. A style made in
  paged is appended as `<w:style w:customStyle="1">` with a Word id from its name (letters and
  digits, unique), its `w:basedOn` when its parent is a Word style or another new one, and
  its own properties. Paragraphs and runs in it name it (`w:pStyle`, `w:rStyle`).
- **Atomic content inside a run's text keeps its place.** An edited run is written around
  the children between its texts: the new text is cut where the edit leaves each child (one
  before the changed span keeps its offset, one after it moves with the text after it, one
  inside it goes after the inserted text), each piece written where that stretch's first
  text was. A split run gives each such child to the piece its place falls in (at a boundary,
  the piece before: a note reference follows its word).
- **A paragraph added in a cell takes its own paragraph style.** The copy of the neighbour's
  `w:pPr` is rewritten to the new paragraph's style and direct properties (keeping what that
  look does not own), so Enter in a heading cell gives Word the next style, as the canvas
  shows.
- **Numbering is not touched.** No save writes `numbering.xml`; list levels arrive with the
  engine's list definitions later.

## Consequences

- The zero-edit save stays byte-identical per part, `styles.xml` included: a style whose own
  properties read back as the lowering made them is not addressed.
- A change to a style property the import does not map (leading, kerning, hyphenation, next
  style, …) is not written; Word keeps its own value.
- The headers, footers, notes, comments and numbering parts are still carried verbatim; W2
  and W3 add them as splice targets, with content types and relationships for new parts.

## Related

- [ADR 602](602-save-back-is-a-byte-splice.md), [ADR 603](603-two-entry-points.md) — the splice
  this extends; where the stored source part comes from.
- [ADR 609](609-styles-and-theme.md) — theme references written back.

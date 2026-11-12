# ADR 1098 — A cell's text takes direct properties

- **Status:** Accepted 2026-11-12.
- **Scope:** `paged-wire` (`ElementId::StoryRange`, `Address::StoryRange`), `paged-mutate`
  (`NodeId::StoryRange`), `paged-canvas` (the conversion and the property read), the wire
  schema and the contract's vendored `wire.d.ts`; paged.sheet's table lowering and paged.doc's
  table cells (their consumers).

## Context

A table cell's text is a paragraph stream of its own (`TableCell::paragraphs`), not part of the
story's body offsets. The text ops reach it through a cell qualifier (`TextCellAddr`, v35 for
`insertText` and `deleteRange`, v55 for `applyStyle`). The property door did not:
`setElementProperty` addresses text through the `storyRange` element id, which named only the
body. So the one way to format a cell's text was to apply a named style, and the modules minted
styles to carry what is direct formatting in the source:

- paged.sheet minted a character style per distinct cell format (`CharacterStyle/paged.sheet
  <hash>`) and paragraph styles for alignment, indent and repeat fill (`ParagraphStyle/paged.sheet
  align right`, …);
- paged.doc applied the lowering's synthesized `docx-auto-*` styles inside cells.

Those styles were not the source's: they showed in the style lists, InDesign received them as
document styles, and every refresh had to read the catalogue before minting.

## Decision

1. **The story range takes the same cell qualifier.** `ElementId::StoryRange` and
   `NodeId::StoryRange` gain `cell: Option<TextCellAddr>` (`CellAddr` in `paged-mutate`), absent
   on the wire for the body (`#[serde(default, skip_serializing_if = "Option::is_none")]`), so
   every body address is byte-identical to before. `Some` makes `[start, end)` a cell-local range
   of that cell's own paragraphs, the offsets `applyStyle` with a cell uses.
2. **One apply path.** `SetProperty` on a story range runs the character and paragraph splitters
   that `applyStyle` already ran for cells (`apply_character_property_in`,
   `apply_paragraph_property_in`); the body-only wrappers are gone. Their per-run inverses carry
   the cell, and so does a tracked format change (`format_scope`).
3. **Reads answer the same address.** A property read (`element_properties`,
   `element_read_properties`) of a cell-qualified range walks that cell's paragraphs. The
   virtual `text` path of a story range stays body-only; a cell's text is read and written with
   the cell ops.
4. **The address grammar names the cell between story and range:**
   `storyRange:<storyId>@<tableId>/<row>,<col>@<start>..<end>`, with `@` and `/` escaped in the
   table id. It needs no document (the story rides it), so `ElementId::parse` reads it.
5. **Protocol.** A rider on v78: the field is additive, an older engine ignores it, and the
   editor and its worker ship as one build.

## Consequences

- paged.sheet and paged.doc write a cell's direct formatting as direct properties and no longer
  mint styles for it (sheet ADR 518 and doc ADR 600 amendments). A document style the source
  names (a Word style, a document's own character or paragraph style) is still applied as a
  style. paged.doc still mints its synthesized `docx-auto-*` styles for what is not a cell: the
  body blocks its native build defers to the old pour, headers, footers and text boxes, and a
  tracked format change's "before" look, which a change names by a style.
  (Superseded by the amendment below: those are direct properties too.)
- IDML export writes a cell's direct properties as local overrides on its
  `CharacterStyleRange` / `ParagraphStyleRange`, as InDesign writes them; the same writer as the
  body's.
- docx export reads a cell's runs back as direct properties (the body's path) and saves an unedited
  document byte-identical (docx-conformance `save_back`). xlsx export writes from the workbook's
  style records, never from the engine's cell runs, so it is unchanged.

## Amendment (2026-11-12): a caret names its paragraph; a tracked look is properties

Two places still needed a style where a module had direct formatting to write:

- **A blank line and a table's own paragraph.** A caret (`start == end`) writes the paragraph the
  contiguous offset falls in; consecutive empty paragraphs share one offset, so a caret wrote all
  of them (and refused when they differed), and a table's paragraph, which holds no character, was
  not reachable at all. `applyStyle` solved this in v65 with a paragraph index, so a style could
  name one; a direct property could not. `ElementId::StoryRange` and `NodeId::StoryRange` gain
  `paragraph: Option<u32>` (absent on the wire when `None`, so every address is byte-identical to
  before): with `start == end` a paragraph path writes, reads and undoes exactly paragraph `i` of
  the stream (the body, or `cell`'s own), as `applyStyle.paragraph` does. A range and character
  paths ignore it. The address grammar ends such a caret in `#<paragraph>`
  (`storyRange:Story/u1@4..4#2`).
- **A tracked change's look before.** `recordChange`'s `ChangeSpec` named the look before a
  format or paragraph-property change by a style alone and took the other properties from the run
  as it is now, so an importer whose source keeps that look as direct formatting (Word's
  `w:rPrChange`, `w:pPrChange`) had to mint a style for it. `before_character_properties` and
  `before_paragraph_properties` (`LookProperty { path, value }`, the pair `SetProperty` takes) make
  the look before the named style and those properties alone, written through the same field
  setters as a range write; absent, the old meaning holds.

Protocol: a rider on v78, additive; the editor and its worker ship as one build. Evidence:
`paged-canvas/tests/it/caret_names_its_paragraph.rs` (two blank lines at one offset take their own
spacing, the read answers the named paragraph, undo and redo are exact, an index past the story is
refused, the grammar round-trips, and both tracked looks are recorded as style plus properties).
paged.doc's pour and placement batch use both, so no `docx-auto-*` style is minted for a blank line,
a table's alignment or a tracked look (doc ADR 600, amendment 2026-11-12b).

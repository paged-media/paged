# ADR 1050 — Anchored floats: wrap, behind-text, overlap; anchored text frames; tables and objects in table cells

- **Status:** Accepted 2026-10-30.
- **Scope:** protocol v78 rider (every addition is optional on the wire and skipped in the model
  when unset). Part of the paged.doc Word-parity program (doc wave W4, doc ADR 614's residuals).
  - `paged-model`: `AnchoredFrame.layout` (`AnchoredLayout`: `text_wrap`, `wrap_polygon`,
    `behind_text`, `allow_overlap`, `inset_spacing`, `vertical_justification`); the lookups
    `anchored_frame_in(_mut)`, `table_in(_mut)`, `cell_paragraphs_in(_mut)`,
    `nested_table_host`, which reach table cells and nested tables at any depth;
    `TextWrap` is `PartialEq`.
  - `paged-mutate`: `Operation::InsertAnchoredFrame` gains `frame_kind`
    (`AnchoredFrameInsertKind`), `frame_story`, `layout` (`AnchoredLayoutSpec`,
    `AnchoredWrapSpec`), `cell` and the inverse-only `restore`; `NodeSpec::Table.cell`;
    table, cell and anchored-frame lookups search nested tables; the `frameTextWrap*` paths
    and the `anchored*` paths reach anchored frames in cells.
  - `paged-wire`: `insertAnchoredFrame` gains `kind`, `layout`, `cell`; `insertTable` gains
    `cell`; every `TextCellAddr.tableId` may name a nested table.
  - `paged-canvas`: the translation mints a text frame's story; a batch handle bound to an
    anchored text frame names its story in a `storyId` position.
  - `paged-renderer`: `pipeline/anchored.rs` (`FloatState`, `place_wrapping_objects`,
    `apply_behind_text`, `emit_cell_floats`), `pipeline/geom.rs`
    (`WrapShape::from_polygon`), `pipeline/tables.rs` (pictures and floats in cells).
- **Builds on:** ADRs 139 / 143 / 151 (text wrap, anchored objects with custom positions, wrap
  sides), 176 (nested tables), 1016 (Word's first-fit). Doc ADR 614 maps Word onto it.

## Context

Doc ADR 614 placed Word's floats and text boxes as page items wherever the lowering knows the
page, and found what the wire could not make elsewhere: an anchored object that wraps text, an
anchored text frame, a table inside a cell, a picture inside a cell. The model already allowed
most of these (an `AnchoredFrame` of kind `TextFrame` with a `parent_story`, a cell paragraph
holding a `table` or `anchored_frames`); the renderer and the wire did not.

## Decision

**An anchored object's layout is a separate, optional block** (`AnchoredFrame.layout`). Nothing
an IDML import reads sets it, so InDesign's anchored objects lay out exactly as before; the
rules below apply to an object whose layout is set (a Word float).

**Wrap.** A custom-positioned (`Anchored`) object with an active wrap is placed BEFORE its
paragraph's lines are composed, against the paragraph's first line in the frame the paragraph
starts in, and its zone joins that frame's wrap obstacles for the rest of the story. So the
lines of its own paragraph and of every later one wrap around it, as Word wraps a float: a
bounding box narrows them (with the offsets as distances and `TextWrapSide` as Word's
`wrapText`), a jump object moves them below it, a contour follows `wrap_polygon` (points from
the frame's top-left, Word's `wp:wrapPolygon`) or the frame's box. It is drawn at the
paragraph's end where it was placed. An object anchored in an EMPTY paragraph (Word anchors many
floats there) is drawn too. Only the story that holds the object wraps around it.

**Behind the text.** `behind_text` moves the object's commands to the start of its frame's
command range once the story is emitted (beside the column-rule splice), so the frame's text
paints over it; a behind-text object's picture goes under everything on its page.

**Overlap.** `allow_overlap: Some(false)` moves the object down, clear of the story's floats
already placed on the page (Word moves a non-overlapping float below the one it would meet).

**Anchored text frames.** `insertAnchoredFrame { kind: "text" }` makes an anchored `TextFrame`
with a story of its own (minted with the frame; created empty when absent, removed by the
insert's inverse; a removal's inverse re-attaches the story, text and all, and restores the
whole frame from its capture). A batch handle bound to the frame names its story in a
`storyId` position, so a text box is created and poured in one batch. Its `inset_spacing` and
`vertical_justification` are the synthetic frame's its story flows in; its lines are recorded
as its story's, so a caret can stand in them.

**Tables in cells.** `insertTable { cell }` makes a table in a cell: in the cell's last
paragraph when that is empty (a fresh cell's), else in a new paragraph after its content; the
inverse puts the story back as it was. Every table address (`tableId`, `TextCellAddr`, the
table and cell ops, removal and its capture) names a nested table by its own id. The renderer
already drew nested tables (ADR 176); their cells still take no caret addresses.

**Objects in cells.** `insertAnchoredFrame { cell }` anchors a frame in a cell's paragraphs (a
fresh cell gets its first paragraph). An inline object in a cell is a character of its line,
as in the body: the cell paragraph composes with a placeholder of the object's width, its line
moves down to hold the object (a first line stands at least the object's rise below the
paragraph's top; a later one the rise and a fifth of the size below the line above, under
auto leading or Word's first-fit), the row grows with it, and the object is drawn where its
character landed. A custom-positioned object in a cell stands against the cell (Word's
`layoutInCell`): the cell's inner box for the column and text-frame references, the page and
its margins for theirs, the paragraph's first line for the line references. It takes no wrap
and does not grow its row.

## Consequences

- IDML is untouched: no import sets a layout, and the cell and nested-table lookups find
  exactly what the top-level lookups did when there is no nesting.
- Residuals: a wrapping float is placed against its paragraph's first line, not against the
  line holding its anchor character; the inspector's property reads do not list an anchored
  object's wrap; an IDML export writes no `TextWrapPreference` for an anchored object; nested
  cells take no caret addresses.

## Evidence

`paged-canvas/tests/it/anchored_floats.rs`: wrap around a float (bounding box, jump object,
none without a layout), non-overlapping floats stacked, a text box created and poured in one
batch and undone with its story, a nested table made and filled through its own id, a picture in
a cell growing its row.

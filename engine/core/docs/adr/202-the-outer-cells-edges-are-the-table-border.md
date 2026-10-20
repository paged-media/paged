# ADR 202 — A table's outer cells' edges are its border

- **Status:** Accepted 2026-10-20.
- **Scope:** the table border pass in `crates/paged-renderer/src/pipeline/tables.rs`
  (`side_stated_by_cells`).

## Context

The renderer drew a table's border from the `<Table>`'s `*BorderStroke*` attributes, else from
its table style's, and drew every cell's own edges as well. `[Basic Table]` is based on
`[No Table Style]`, whose border is 1 pt black, so a table that states no border of its own
took that one.

InDesign keeps one stroke per outer edge: Table Setup's border writes the outer edges of the
outer cells, and its IDML writes all four edges of every cell. A vendor form whose cells all
say `…EdgeStrokeWeight="0"` shows no line in InDesign's PDF; the renderer boxed both of its
tables in black (worst page SSIM 0.883 against its 0.89 budget; 0.902 without the boxes).

## Decision

A side of the table whose outer cells all state that edge's weight inline is drawn by those
cells; the table's border (direct or from its style) draws nothing on that side. A side with
any cell that states nothing keeps the table's border.

## Consequences

- InDesign-written tables draw exactly their cells' edges.
- Hand-written or generated IDML whose cells carry no edge attributes keeps the style's border.
- `tests/it/tables.rs::the_outer_cells_own_edges_replace_the_table_styles_border`.

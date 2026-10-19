# ADR 194 — Deleting a style moves its text to the root style

- **Status:** Accepted 2026-10-19.
- **Scope:** `crates/paged-mutate/src/apply/layer.rs` (`style_crud!`'s delete,
  `style_reference_moves`). No wire change: `deleteParagraphStyle` and
  `deleteCharacterStyle` keep their shape and stay one undo step.

## Context

Deleting a paragraph or character style removed its definition and nothing else. Text that
carried the style kept pointing at the deleted id (finding PN-150), and since a new style's id
is minted from the collection's size, the next New took that id, so text that never received
the new style read as carrying it (PN-151).

InDesign's Delete Style asks what to replace the style with and offers the family's root,
"[No paragraph style]" or "[None]", as the default; the text keeps its look as local
formatting where it differs.

## Decision

1. **The text goes to the root.** Before the definition is removed, every paragraph (for a
   paragraph style) or run (for a character style) that carries it, in the story body and in
   each table cell's own stream, is moved to `ParagraphStyle/$ID/[No paragraph style]` or
   `CharacterStyle/$ID/[No character style]` with the `ApplyStyle` it would take from a panel.
   The moves and the delete are one batch, so one undo step restores the style and puts the
   text back on it; redo moves it again.
2. **No replacement choice yet.** The editor's Delete has no "replace with" question; the root
   is InDesign's default answer. A later replace-with is the same batch with another target.
3. **Ids are still minted from the collection's size.** With no text left on a deleted id, a
   reused id is a new, unapplied style.

Object, cell and table styles keep the old behaviour (their references live on frames and
tables, not in the text streams); that is recorded, not decided.

## Consequences

- PN-150 and PN-151 close; `deleting_an_applied_style_moves_its_text_to_the_root_style`
  (`paged-mutate`) and the Paragraph Styles panel's two finding tests hold it.
- A delete of a widely used style costs one `ApplyStyle` per carrying paragraph or run.

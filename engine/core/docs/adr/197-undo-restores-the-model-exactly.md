# ADR 197 — Undo restores the model exactly

- **Status:** Accepted 2026-10-19.
- **Scope:** `Operation::RestoreParagraphs` (`crates/paged-mutate/src/apply/story.rs`), the
  character-range splitter (`apply/character.rs`), `InsertHyperlink` (`apply/hyperlink.rs`),
  `SetGroupTransform`'s `leaves` (`apply/layer.rs`), the table line restore
  (`RemovedTableLine.positions`, `apply/path_topology.rs`), the fitting writers
  (`FrameFittingOption::is_empty`). Wire: the `Operation` union carries the new variant and
  field (resynced into the contract).

## Context

Root R5 of the conformance findings: an undo step existed, but the model after it differed
from the one before. A range edit (a character property or style, a hyperlink) split the
story's runs and its inverse only put the values back, so the splits stayed (SH-204,
SCR-10). A group move rebased its members by the inverse delta, so an explicit identity
transform came back absent and a turn came back rounded (SH-203). Undoing a row or column
delete appended the cells instead of putting them back in place (SCR-7). Undoing a fit on a
frame that had none left an empty fitting option (SCR-5). An IDML saved after such an undo
differed from one saved before, and the whole-model state hash (ADR 195) said so.

## Decision

An inverse records the state it undoes, not a recomputation of it:

1. **Range edits restore their paragraphs.** Before it splits runs, a range edit captures the
   paragraphs it touches; its inverse is `RestoreParagraphs { story_id, cell, first, count,
   paragraphs_json }`, which puts them back whole. Its own inverse carries what it replaced,
   so redo is exact too. Only the touched paragraphs are kept, not the story.
   `InsertHyperlink`'s inverse removes the link and restores the paragraphs in one batch.
2. **A group move restores its members' stored transforms.** `SetGroupTransform`'s inverse
   carries `leaves`, every descendant leaf's stored `ItemTransform` from before the move in
   walk order; applied, they are put back verbatim instead of rebased.
3. **A table line goes back where it stood.** A deleted row or column records each cell's
   index in the cell list (`positions`); the restore inserts each cell at its index. A blob
   without positions appends, as before.
4. **No empty fitting option.** A write that clears the last fitting knob removes the
   `<FrameFittingOption>`, which is how a frame without one reads.

## Consequences

- SH-203, SH-204, SCR-5, SCR-7 and SCR-10 close; the Rust tests assert the before-state.
- Undoing a character property on a run that inherited a default (`ligatures_on: None`)
  restores `None`, not the effective value written explicitly.
- A range edit's undo record holds a copy of the paragraphs it touched: one paragraph for
  the common edit, every paragraph for a range that spans the story.

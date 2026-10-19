# ADR 253 — One user action is one batch

- **Status:** Accepted 2026-10-19.
- **Scope:** `packages/shell/src/catalog/binding-hook.ts` (`sendAsOne`, `plan`), the Fill and
  Stroke cluster's Swap and Default, `apps/canvas/src/insert-commands.ts` (Insert table),
  the schema demo's Stroke command; in the modules, draw's `oneBatchFor`, data's property
  lane (`alongside`), doc's placement and sheet's command writes.

## Context

Root R4 of the conformance findings: an action the user did once was sent as several
mutations, so one Undo left the document half changed. A multi-selection field commit sent
one write per object; Swap fill and stroke sent the fill and the stroke apart (SH-205);
Insert table without a caret could not address the story its new frame minted, so it sent
two mutations (SH-202); the module commands split their writes the same way (DRW-1 to
DRW-6, DAT-2, DOC-1, MNU-2), and a sheet replace that changed nothing still wrote an undo
step (SHT-2).

## Decision

1. **A command sends one mutation per invocation**: the write itself, or one batch of its
   writes. The engine applies a batch atomically and records one undo step.
2. **Batch handles address what the batch mints.** A later child names an earlier child's
   element or story with `bindCreated` and `$h:<name>` (engine C-15), as Insert table's
   `insertTable { storyId: "$h:frame" }` and the doc placement do.
3. **Field bindings plan their writes.** A resolved binding carries `plan(next)`, the
   mutations its `onCommit(next)` would send; a caller that commits several fields at once
   (Swap, Default) joins the plans into one batch. A multi-target commit is one batch.
4. **No change, no step.** A command whose write changed nothing records nothing.

## Consequences

- SH-202, SH-205, PN-356, DAT-2, DOC-1, SHT-2, DRW-1 to DRW-4 and MNU-2 close.
- A batch is all or nothing: one refused child refuses the whole action (draw's Close path
  falls back to one element at a time).
- DRW-5 and DRW-6 stay two steps until a batch handle resolves inside metadata text.

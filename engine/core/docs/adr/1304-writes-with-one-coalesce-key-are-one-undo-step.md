# ADR 1304 — Writes with one coalesce key are one undo step

- **Status:** Accepted 2026-11-13.
- **Scope:** protocol v80. `paged-canvas` (`CanvasModel::coalesce_base`, `note_coalesced`,
  `end_coalesce`, `coalesce_run`, `restore_coalesce_run`; `channel.rs`: `MutateCoalesced`,
  `EndCoalesce`, `CoalesceEnded`), `paged-canvas-wasm` (the dispatch arms; a plain `Mutate`
  ends the run), the editor's client (`CanvasClient.mutate(mutation, { coalesce, label })`,
  `CanvasClient.endCoalesce`). Implements the history table of the editor's interaction contract
  (`§17.2`: a single inspector numeric scrub is one step despite many preview updates) and
  `UXI-MUT-005`, task EN8 of `apps/editor/docs/interaction-plan.md`. Builds on engine ADR 1004
  (amending writes).

## Context

An inspector scrub writes a value on every pointer move so the canvas shows it, and each write
was a step of its own: one scrub filled the undo history with dozens of steps. The client's undo
group (ADR 1004's `amendMutation` chain) joins writes into one step, but it is opened and closed
by one caller around a known batch; a field that writes as the pointer moves, and must stop
joining as soon as anything else touches the document, needs the engine to decide where the run
ends.

## Decision

**A write may carry a coalesce key; consecutive writes with one key are one undo step.**
`MutateCoalesced { coalesce, mutation, label? }` applies the mutation as `Mutate` does. The first
write of a run is a step of its own; each following write with the same key joins that step
through ADR 1004's fold, so one undo returns to the state before the first write and one redo to
the state after the last. The run ends at:

- a write with another key, or a write with none (`Mutate`, and what lowers to it);
- anything that makes a step or moves the history: a gesture's commit, an amend, an undo, a
  redo, a history jump, a restore, a script's write (the run's step is then no longer the
  amendable top of the history, ADR 1004);
- `EndCoalesce { coalesce? }` (only the run with that key, when one is named), answered
  `CoalesceEnded { appliedSeq }` with the step the run ended in;
- a document load.

A keyed write the engine refuses changes nothing and leaves the run as it was. While a gesture
holds the document a keyed write is refused like any write (engine ADR 1300). The reply is
`Mutate`'s; its `appliedSeq` names the run's step from then on. `label` names the step (ADR 1030).

The rule of editor ADR 253 — one user action, one batch — holds per action: each write of a run
is one action's batch; the key joins the batches of one gesture of the user's hand.

## Consequences

- An inspector field scrubs with one key per scrub (`mutate(op, { coalesce })`) and ends the run
  on release (`endCoalesce`): one undo step per scrub (task FI1).
- The run's step keeps every write it joined (ADR 1004's composite), so its undo and redo are
  exact; a scrub's memory is its writes, as before.
- A coalesced write is outside the client's undo group: the group's amend chain applies to plain
  `mutate` only.

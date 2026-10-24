# ADR 1004 — A follow-up write can join the undo step that provoked it

- **Status:** Accepted 2026-10-23.
- **Scope:** protocol v76 (unreleased; additive, no bump). `paged-canvas` (`CanvasModel::
  check_amend`, `fold_amend`, `apply_mutation_amending`; `MainToWorkerKind::AmendMutation`;
  `WorkerError::NotAmendable`), `paged-canvas-wasm` (the dispatch arm). Builds on the unified
  undo log (`LoggedMutation::Composite`, the one-batch-one-step rule) and on the script fold of
  protocol 71 (`group_undo_runs_since`).

## Context

Some writes are provoked by an edit rather than asked for: a vector module rebuilds the
artwork a repeat, a blend or a pattern generates when one of its source paths changes. The
engine reports a change only after it committed it, so such a rebuild arrives as a second
mutation and became a second undo step. That is wrong three ways: the rebuild clears the redo
stack, an undo of the edit leaves the rebuilt artwork behind (its own undo is the next step),
and a listener that rebuilds on every change rebuilds again after that undo. A batch cannot
help, because the follow-up is computed from the committed result, and the protocol 71 fold
is for a script whose writes the engine is waiting on.

## Decision

**A mutation can be applied into an existing undo step.** `AmendMutation { appliedSeq,
mutation }` names the step by the `appliedSeq` of the reply that committed it
(`MutationApplied`, `GestureCommitted`). The worker applies the mutation as `Mutate` does
(same checks, same reply, same repaint) and folds what it logged into that step: the step and
the new records become one `Composite`, so one undo reverts both and one redo replays both,
in order. The folded step takes the amending write's `appliedSeq`; the reply's number is the
step's name from then on, and a further write amends that number.

**Only the last step, and only before history moves.** The model keeps the seq of the entry
the last forward write put on the undo log (`amend_anchor`); an undo and a redo clear it. An
amend is refused with `WorkerError::NotAmendable { appliedSeq, reason }`, and nothing is
applied, when the log is empty, when the named step is not the top of the log (a newer step
came after it, or an undo uncovered an older one), or when the history moved since (a redo
put the step back). A write that is not logged (selection, app state with no undo form) does
not move the anchor, so it does not stand between an edit and its follow-up.

**Who is amending is the caller's business.** The engine checks only the step. The plugin
contract exposes the option as `document.mutate(m, { amend })` and reports each change's
`appliedSeq` on `onDidChange` (`supports("document.mutate.amend@1")`); a change of kind
`undoApplied` / `redoApplied` carries none, which is how a listener tells a history move from
an edit and leaves it alone.

## Consequences

- An automatic rebuild is one undo step with the edit that caused it and leaves the redo stack
  as the edit left it (the draw module's recipe update is the first consumer).
- A follow-up that loses the race — the user committed something else before it wrote — is
  refused rather than attached to an unrelated step; the caller falls back to an explicit
  command.
- A write that is not undoable on its own (a container part) stays outside the step, as it is
  outside every step.
- `undoneSeq` of an undo of an amended step is the amending write's seq, not the edit's.

## Amendment — 2026-10-23: scripts and the binary lane

Additive on protocol v76 (unreleased; no bump).

**A script run is one undo step, and its reply names it.** A run's own records (its core writes
and the host commits it reported in `HostObjectsResult.committed`) fold into one `Composite`
whether or not it wrote through the host; before, only a run that suspended on the host was
folded, and a synchronous run of several writes was several steps. `ScriptResult.appliedSeq` is
the seq of that step when a follow-up write may still join it (`CanvasModel::sole_step_since`):
it is the only entry logged since the run began, it is the top of the log, the amend anchor
points at it, and no undo or redo ran during the run (`CanvasModel::history_moves`). Absent for
a read-only run, a run that called `paged.undo()` / `paged.redo()`, and a run a foreign edit
split. A listener amends it exactly as it amends a `MutationApplied`.

**An amended step keeps its old numbers.** A host commit made while a script waits is reported
to the script by the seq its reply carried; a follow-up write that amends that commit before
the script resumes renumbers the step. The model remembers each renumbering
(`amend_origins`, the newest 256; `amend_lineage`), and the script fold claims a step by any
number it was known by, so the amended commit stays inside the script's one step.

**The binary lane amends too.** `amendWithBytesDirect(seq, appliedSeq, mutationJson, bytes)`
(`WorkerCore::amend_with_bytes`) is `mutateWithBytesDirect` applied as an `AmendMutation`: the
same slot rule, the same `NotAmendable` refusal with nothing applied.

### Consequences

- A rebuild provoked by a script's edit joins the script's step; one undo reverts the script and
  the rebuild.
- `paged.set(a); paged.set(b)` in one run is one undo step (it was two).
- `ScriptResult.writes` still counts the writes; the steps they make are now one.

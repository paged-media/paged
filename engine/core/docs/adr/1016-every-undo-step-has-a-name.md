# ADR 1016 — Every undo step has a name, and the timeline is readable

- **Status:** Accepted 2026-10-24.
- **Scope:** protocol v77. `paged-canvas` (`AppliedRecord.label`, the `undo_label` module,
  `CanvasModel::{apply_mutation_labeled, set_step_label, undo_log, undo_to, redo_to,
  restore_to, set_history_depth}`, `LoggedMutation::Reverted`; the message kinds
  `LabelStep` → `StepLabeled`, `RequestUndoLog` → `UndoLog`, `UndoTo`, `RedoTo`, `RestoreTo`,
  `SetHistoryDepth` → `HistoryDepthApplied`; the additive `AmendMutation.label`,
  `CommitGesture.label`, `UndoApplied.steps`, `RedoApplied.steps`), `paged-canvas-wasm` (the
  dispatch arms). Builds on the one undo timeline of ADR 110 and the amend of ADR 1004.

## Context

The undo log held what each step did and the seq that named it, but not what to call it. The
Edit menu could only say "Undo", a host History panel had nothing to list, and the only way to
reach a step ten back was ten `Undo` messages, ten rebuilds and ten replies. A plugin that
names its writes (`host.objects.batch(ops, { label })`) had its name dropped at the wire.

## Decision

**A step carries a label.** `AppliedRecord.label` is the caller's words when it gave some, and
otherwise the engine's default, derived from what the step did:

- a wire mutation by its op (`Move`, `Resize`, `Insert text frame`, `Typing`, `Delete text`);
  a property write (`set`, `setElementProperty`) as `Change <property>` (`Change fill`,
  `Change stroke weight`); a batch as the label its children share, else `Multiple changes`;
- a gesture by its kind (`Move`, `Resize`, `Rotate`, `Scale`, `Shear`, `Edit path`; Alt held
  on a move: `Duplicate`), not by the property ops it lowered to;
- a record with no label of its own (an operation-level caller) by its logged form: every
  `paged_mutate::Operation` has a name, through an exhaustive match, so a new operation does
  not compile unnamed; a script run's fold is `Run script`.

The outermost entry point names the step last, so a `Set` reads as the property it wrote and
a batch as its children. Defaults are English; each carries a `key` (`moveFrame`,
`set:frame.fillColor`, `gesture:rotate`, `batch`, `script`) that a host translates when it
knows it. A caller's label has no key.

**Callers name steps on the wire.** `LabelStep { appliedSeq, label }` names the step a write
just made, while it is still the top of the undo log (`StepLabeled { labeled }` says whether it
took). A separate message rather than a labelled `Mutate`: every write keeps the one message
its lanes, recorders and test kits already know (the JSON `mutate`, the binary
`mutateWithBytesDirect`, a gesture's commit, a script), and one door names a step made by any
of them. The cost is a race: a write that lands between keeps the step its default name, which
is a name, not a wrong one. `AmendMutation.label` renames the amended step, which
otherwise keeps its name (the follow-up is a consequence of the edit, not a new edit).
`CommitGesture.label` names a gesture's step. A blank label keeps the default; a label is cut
at 120 characters. Undo and redo keep a step's label.

**The timeline is readable in one message.** `RequestUndoLog { limit }` answers `UndoLog`:
the newest `limit` undo steps oldest first (the last is what an undo reverts) and redo steps
next-redo first, each `{ appliedSeq, label, key }`, with the logs' lengths and the depth.

**Several steps move in one message.** `UndoTo { appliedSeq }` undoes down to and including
that step, `RedoTo` redoes up to and including it; the reply is the `UndoApplied` /
`RedoApplied` a single step answers, with `steps` (how many), `pageIds` the union and the page
table diffed across the whole walk. One message rather than repeated `Undo`: the host's
History panel moves on one click, and nothing can interleave between the steps. A seq that is
not on the log is refused with nothing moved. The steps still rebuild one by one (each inverse
runs against the state its predecessor left); one round trip, not one rebuild.

**A snapshot restore is one new step.** `RestoreTo { appliedSeq, label }` makes the document
what it was right after that step (`0`: before the oldest step on the undo log) as ONE new
undo step, default label `Restore`. Back in time, the steps it walks over stay on the undo
log as they were, and the restore is a `LoggedMutation::Reverted` step on top of them: applying
it reverts them, undoing it replays them. The history stays whole, as a library restore keeps
the version it replaces (editor ADR 180). Forward (a step on the redo log), the replayed steps
are logged as one step. Either way the redo log is cleared, as by any new step, and the restore
is not amendable. The reply is `MutationApplied`.

**The depth is settable.** `SetHistoryDepth { depth }` keeps at most `depth` steps (clamped to
1..=10,000, the cap of ADR 110), evicting the oldest now; the worker holds it across loads.

## Consequences

- Protocol 77: the new message kinds bump it once; the label, `steps` and the additive fields
  ride the same number.
- The plugin contract exposes `document.undoLog()`, `undoTo`, `redoTo` and the `label` option
  of `mutate` and `host.objects.set/batch` (`supports("document.undoLog@1")`); the editor's
  History panel (editor ADR 285) and Edit menu read the labels.
- A snapshot of the opened document (`RestoreTo { appliedSeq: 0 }`) is exact only while no step
  was evicted by the depth; the host says so rather than restoring a later state silently.

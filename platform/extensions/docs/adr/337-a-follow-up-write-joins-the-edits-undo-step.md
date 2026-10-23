# ADR 337 — A follow-up write joins the edit's undo step

- **Status:** Accepted 2026-10-23.
- **Scope:** `MutateOptions` and `DocumentSurface.mutate`'s second argument, and
  `DocumentChangeEvent.appliedSeq`, in `packages/plugin-api/src/host.ts`; the `mutate` door in
  `packages/plugin-sdk/src/host-impl.ts`; `document-change.ts`; the fake editor; the flag
  `document.mutate.amend@1`. The engine half is core
  [ADR 1004](../../../../engine/core/docs/adr/1004-a-follow-up-write-can-join-the-step-that-provoked-it.md).

## Context

A bundle that keeps derived artwork in step with its sources (paged.draw's patterns, repeats,
blends, objects on a path and live paint) can only react to an edit after the engine committed
it ([ADR 327](327-every-committed-change-is-reported.md)). Its rebuild was a second undo step:
it cleared the redo stack, an undo of the edit left the rebuilt artwork behind, and a listener
that rebuilds on every change rebuilt again after the undo. The bundle therefore offered only
an explicit update command.

## Decision

- **`mutate(mutation, { amend })`** applies the mutation into the undo step `amend` names, as
  the engine's `amendMutation` does: one undo reverts both, one redo replays both. `amend` is
  an `appliedSeq`, the number the change event or a previous outcome carried. The outcome's
  `appliedSeq` names the amended step from then on, so a rebuild of several writes amends each
  with the number the previous one answered.
- **A refusal is an outcome.** When the step is no longer the last one, or an undo or a redo
  ran since, the engine applies nothing and the outcome is `applied: false` with the engine's
  `mutationFailed` payload, `{ error: { kind: "notAmendable", details } }`. The door never throws, as every write door ([ADR 310](310-one-write-door.md)).
- **The change event carries the step.** `DocumentChangeEvent.appliedSeq` is present on a
  `mutationApplied` and a `gestureCommitted`. An undo, a redo and a script run carry none: a
  listener that rebuilds on edits leaves them alone, because the history move already restored
  the derived artwork with its sources.
- **`document.mutate.amend@1`** says the host does both. It is static: the worker handshake
  refuses an engine older than the pinned protocol. An older SDK ignores the option and would
  apply the mutation as a step of its own, so a bundle probes before it relies on it.
- **The headless host and the fake editor behave like the editor.** The headless client sends
  `amendMutation` and broadcasts its reply; the fake keeps the step count unchanged on an amend
  and refuses as the engine does.

## Consequences

- paged.draw rebuilds a recipe whose sources an edit changed inside that edit's step, and keeps
  `updateLinkedRecipes` for a host without the flag and for a rebuild that lost the race.
- A write that is not an engine mutation (a container part) is outside every undo step, an
  amended one included.

## Related

- [ADR 305](305-doors-always-present.md) — the flag is how a bundle learns the option is there.
- [ADR 012](012-k1-modal-session-undo-coalescing.md) — coalescing a modal session's writes, the
  other way several writes become one step.

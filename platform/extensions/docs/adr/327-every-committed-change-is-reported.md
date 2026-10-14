# ADR 327 — Every committed change to the document is reported

- **Status:** Accepted, 2026-10-14.
- **Scope:** `DocumentChangeEvent` and `DocumentSurface.onDidChange` in
  `packages/plugin-api/src/host.ts`; `packages/plugin-sdk/src/document-change.ts`; the parent
  index in `host-impl.ts`, the core object model's cache in `core-objects-v70.ts`, the headless
  client's `send` in `harness.ts`; the flag `document.onDidChange@2`.

## Context

`document.onDidChange` reported the engine's `mutationApplied`, `undoApplied` and
`redoApplied`. The editor changes the document two more ways, and neither answers with a
mutation:

- **A canvas gesture.** A frame dragged, resized or rotated by its handles is begun, updated
  and committed on the engine. The commit answers `gestureCommitted`, with its own undo step.
- **A script run.** A `paged.*` script writes through the model and answers `scriptResult`.
  The reply names no pages and does not say whether anything was written.

A bundle that follows the document missed both. paged.web kept a frame resized by its handles
at its old, clipped render; paged.draw's link index went stale after a drag. Both worked
around it by reading the raw client broadcast through `host.editor`. The host's own derived
state missed them too: the parent index behind `document.parentOf` survived a script that
regrouped, and the core object model's cache and its `objects.onDidChange` (what a panel bound
to a frame's position follows) survived a drag and a script.

The editor's client hands every reply to its subscribers and already counts these five replies
as edits. The headless harness handed only `mutate`, `undo` and `redo` replies to them.

## Decision

- **One definition.** `document-change.ts` maps a client message to a `DocumentChangeEvent` or
  nothing. The five replies that commit a change are changes: `mutationApplied`,
  `undoApplied`, `redoApplied`, `gestureCommitted` and `scriptResult`. A gesture in flight, a
  cancelled or failed gesture and a script suspended on the host's objects are not.
- **The event says what committed the change.** `kind` is the engine's reply kind. A script
  run carries `pageIds: []` and `pagesUnknown: true`, because the engine does not say which
  pages it touched. `reflow` stays on `mutationApplied` only: the engine reports it for a
  `resizeFrame`, not for a resize by the handles.
- **Everything the host derives follows the same set.** `onDidChange`, the parent index and the
  core object model all use the one definition, so nothing the host derives is fresher or
  staler than what a bundle is told.
- **The headless client broadcasts what the editor's does** for these replies: a `send` whose
  reply is a change reaches the subscribers. Pure reads still do not.
- **`document.onDidChange@2`** says the host reports the full set. A host without it reports
  the first three kinds only.

## Consequences

- paged.web and paged.draw can drop their raw-client listeners for `gestureCommitted` once they
  require a host with `document.onDidChange@2`.
- A consumer that branches on `kind` sees two new values. One that treats everything other than
  `mutationApplied` as an undo or redo should treat `gestureCommitted` and `scriptResult` as
  edits.
- A read-only script also reports a change. The engine's reply cannot tell the two apart; a
  consumer re-reads and finds nothing new.
- A resize by the handles still carries no `reflow`. A pagination consumer that re-splits only
  on `reflow` does not re-split after it; reporting the content box on the gesture commit is a
  change in the engine.

## Related

- [ADR 310](310-one-write-door.md) — one write door, engine-owned history: these are the history's
  steps.
- [ADR 305](305-doors-always-present.md) — a host reports what it can through `supports()`.

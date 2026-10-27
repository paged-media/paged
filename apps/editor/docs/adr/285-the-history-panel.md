# ADR 285 — The History panel lists every step by name, and a snapshot restore is one step

- **Status:** Accepted 2026-10-24.
- **Scope:** `apps/canvas/src/panels/history-panel.tsx`, `history-store.ts` (the `paged.history`
  panel, registered in `built-in-panels.tsx`), `apps/canvas/src/app-commands.ts` (Edit ▸
  History), `packages/client` (`undoLog`, `undoTo`, `redoTo`, `restoreTo`,
  `setHistoryDepth`). Builds on engine ADR 1030 (named undo steps, protocol 77) and ADR 012
  (an edit context may own undo).

## Context

The editor had one undo timeline (engine ADR 110) and no way to see it: the Edit menu said
"Undo", the image module listed its own pixel journal inside its own panel, and going back
ten steps meant pressing Cmd-Z ten times. Designers coming from Photoshop and Illustrator
expect a History panel: the steps by name, a click to go back to one, and snapshots.

## Decision

- **The list.** `paged.history` shows the engine's timeline (`requestUndoLog`, the newest 500
  steps): a first row for the opened document, the undo steps oldest first with the current
  step marked (`aria-current="step"`), then the redo steps dimmed. The store is one per
  client and reads the log again after every message that changes the document
  (`changesTheDocument`), so the list follows edits, gestures, scripts, undos and redos made
  anywhere.
- **Names.** A step shows the engine's default translated by its key (the common ones:
  Move, Resize, Rotate, Typing, Change fill, Multiple changes, …) or, for any other key and
  for a caller's own label, the label as it came. German strings sit in the editor's locale.
- **A click is one round trip.** A done row undoes down to the step after it (`undoTo`); an
  undone row redoes up to it (`redoTo`). The engine moves several steps per message, so the
  history cannot interleave with another write between them.
- **The edit context's own steps.** While the active edit context contributes
  `historySteps()` (the image module's pixel journal in `rasterImage`), the panel lists that
  history instead, re-read on `onDidChangeHistory`, and a click calls `step(delta)`. The
  document's timeline does not see those steps until the context commits, which is ADR 012's
  boundary, so showing the document's list there would show nothing that changes.
- **Snapshots.** "New snapshot" names the current state (the current step's seq). Restoring a
  snapshot is `restoreTo`: ONE new undo step ("Restore Snapshot 1") on top of the history,
  which stays whole: the steps it went back over are still listed below it, and one undo of
  the restore returns to where the user was. A snapshot whose step left
  the timeline (a new edit after an undo cleared the redo steps, or the depth evicted it) is
  shown disabled with the reason. When the editor keeps the document in the local library
  (ADR 180), "New snapshot" also saves a version there (`Snapshot: <name>`), so the state
  outlives the session; the library panel restores that version.
- **Depth.** A preference (`paged.history.depth` in the editor's storage, 50 to 10,000) sets
  the engine's depth with `setHistoryDepth`; the worker keeps it across document loads.
- **Reach.** Edit ▸ History and the palette's derived `paged.panel.show.paged.history` open
  the panel.

## Consequences

- In-session snapshots are timeline positions, not copies: they cost nothing, and they last
  as long as their step is on the timeline. The durable copy is the library version.
- The opened-document row is disabled once the depth has evicted a step (`UndoLog.evicted`).
- The Edit menu still names only an edit context's steps; naming the document's steps there
  is a later use of the same log.

# ADR 1234 — Named checkpoints

- **Status:** Accepted 2026-11-14.
- **Scope:** `packages/repository/src/library.ts` (the timeline: `checkpoint`, `checkpoints`,
  `removeCheckpoint`, `restoreCheckpoint`; an import is the first checkpoint;
  `checkpointRef`, the bounds), `packages/shell/src/state/library-document.ts` (a blank
  document's first save is no import), `state/open-library-document.ts` (`confirmed`);
  `apps/canvas/src/checkpoints/` (new: `checkpoints.ts` keeping, restoring and the export
  watch, `timeline.tsx` the timeline in the Library panel), `apps/canvas/src/compare/` (new:
  `diff.ts` what differs between two states, `side-engine.ts` a second engine to read a state
  that is not open, `compare-dialog.tsx` Preview and Compare), `panels/library-panel.tsx` (the
  timeline; a restored version keeps the open state first), `app/mount.tsx` (the second engine's
  factory, the dialog, the export watch). The UX strategy's Concept H; task PX7 of
  [`interaction-plan.md`](../interaction-plan.md). Builds on
  [ADR 225](225-the-local-library.md) and [ADR 1204](1204-recovery-journal.md).

## Context

The library (ADR 225) keeps every save of a document as a version and restores one as a new
version, and the recovery journal (ADR 1204) keeps unsaved work against a crash. Neither tells the
story of a publication — imported, the typography pass, the image adjustments, the preflight fixes,
approved — and neither can show a past state without opening it in place of the work at hand. The
strategy asks for named checkpoints rather than continuous screenshots, a preview of a selected
one, a visual comparison with the current state, durable snapshots, and no silent overwrite.

## Decision

1. **A checkpoint is a commit on the document's own repository, never on main.** It keeps the
   open document's state as it is — saved or not — on the person's draft ref
   `drafts/<person>/checkpoints` (the repository accepts main, drafts, agents' runs and releases;
   a checkpoint is a draft of the person's), so keeping one never moves the saved version and is
   never a save (ADR 1204's rule). The timeline is an index beside the repository,
   `repos/<id>/checkpoints.json` (name, kind, the commit, when, the page count), shape-checked on
   read. Parts shared with other versions are stored once (the repository is content-addressed).
2. **Named and automatic.** Save checkpoint… in the Library panel names the open state. The
   editor keeps one by itself at an import (the first version: "annual.idml"; a blank document's
   first save is no import), after every export the editor reports as done (the guided PDF
   export, an exporter's file, the page images: "Exported annual.pdf"), before an operation that
   replaces the open document ("Before restoring …" for a checkpoint or a library version, "Before
   promoting …" for a variant), and when the publication contract is approved ("Approved").
3. **Bounded by the recovery journal's rules.** A state over 256 MB is not kept; automatic
   checkpoints beyond 20 leave the timeline, oldest first; a named one beyond 100 is refused with
   its reason. Removing a checkpoint takes it off the timeline; its version stays in the
   repository's history, which never rewinds (ADR 225). The library has no compaction yet, so a
   pruned checkpoint's parts are kept with the history (recorded below).
4. **The timeline, read-only previews and a visual comparison.** The Library panel shows the
   timeline oldest first (Imported → Typography pass → … → Current); a selected checkpoint offers
   Preview (its pages), Compare with current, Restore as new version and Remove. Preview and
   Compare load the checkpoint's state into a **second engine** (its own worker, made per use and
   disposed after) and render its pages there; the open document is only read (its own pages
   rendered by its own engine). The comparison boxes the regions whose pixels differ, cell by
   cell, on both renders, and lists what changed as each state's engine reports it (a `.paged`
   keeps the open model in its own part, so the model, not the package's XML, is the reader):
   frames by id moved, resized or reshaped, restyled (their fill, stroke, opacity, object
   style), added or removed; pictures substituted (a link that points elsewhere); each story's
   text, or only its formatting (paragraph styles and the runs' type); the paragraph and
   character style definitions. Deterministic, and nothing new on the wire.
5. **Restore is a new state.** Restore as new version asks once, keeps the open document as
   "Before restoring <name>", makes the checkpoint's state main's newest version ("Restore …")
   and opens it: the versions after it stay in the history, the open work is on the timeline, and
   the toast says both. The Library panel's own Restore of a version keeps the open state first
   too.

## Consequences

- A timeline travels with the library document, not with the file; Export with history carries
  the commits (the draft ref) but not the timeline's names.
- A pruned automatic checkpoint frees no storage until the library compacts its packs (no
  compaction exists yet; the repository has `gc`, which the library does not run).
- The second engine costs one worker while a preview or a comparison is open.
- Tests: `packages/repository/test/library.test.ts` (an import is the first checkpoint;
  checkpoints never move main; a state equal to the last one makes no commit; restore is a new
  version; the bounds; removing one), `apps/canvas/test/unit/checkpoints/checkpoints.test.ts` (a
  checkpoint needs a library document; a refusal in words; an export keeps one, nothing else
  does), `apps/canvas/test/unit/compare/diff.test.ts` (items, pictures, text, formatting and
  styles from the engine's facts; pixel regions), `apps/canvas/tests/e2e/px-checkpoints.spec.ts` (the import on the
  timeline; Save checkpoint… keeps an unsaved state without a new version; Preview and Compare
  change neither the model nor the history and show the moved frame; Restore is a new version
  with the open state kept first and nothing to undo).

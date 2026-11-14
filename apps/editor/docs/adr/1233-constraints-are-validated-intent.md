# ADR 1233 — Constraints are validated intent

- **Status:** Accepted 2026-11-14.
- **Scope:** `apps/canvas/src/constraints/` (new: `model.ts` the records and their label,
  `evaluate.ts` the evaluation, `measure.ts` what it reads, `source.ts` when it runs and the
  issues it publishes, `store.ts` the results and the fix preview, `describe.ts` the words,
  `fixes.ts` a fix applied, `overlay.tsx` the glyphs and the fix preview, `add-constraint.tsx`
  Object ▸ Add constraint… and its dialog), `panels/constraints-panel.tsx` (new: Design
  constraints), `issue-fixes.ts` (a constraint's fixes, a fix's ghost boxes, advice-only fixes),
  `panels/cockpit/issues-section.tsx` (a fix previews on hover and focus),
  `canvas-context-menu.tsx`, `view-commands.ts`, `app/mount.tsx`, `panels/built-in-panels.tsx`,
  `panels/window-categories.ts`; `packages/shell/src/state/publication-issues.ts` (issues by
  source; the kinds `constraint` and `contract`), `state/view-toggles.ts` and
  `state/editing-aids.ts` (the aid Design constraints). The UX strategy's Concept C and §15
  ("don't over-automate"); the interaction specification's §25.1 ("constraint suggestions …
  no silent layout rewriting"); task PX3 of [`interaction-plan.md`](../interaction-plan.md).
  Feeds [ADR 1223](1223-publication-health-on-the-page.md).

## Context

A page stores where things are, not why. A designer who keeps four product shots evenly spaced, a
caption on its picture's left edge, a headline within three lines or a logo on the outer margin
holds that intent in their head; an edit to one item, a longer product name from data or a
swapped picture breaks it silently. Layout tools that store such intent tend to solve it, moving
items on their own — which an IDML document cannot carry and a professional does not want: the
strategy asks for validation and suggested fixes first, determinism for imported and printed
documents, and no surprise mutations.

## Decision

1. **A constraint is a record in the document, never a solver.** Six kinds: *align* (left,
   right, top, bottom, either centre, or the first baselines of text frames; the first member is
   the key object, D-07), *equal spacing* (across or down, three or more items on one page),
   *minimum gap* (two items or groups), *maximum lines* (a text frame), *must fit* (a text frame
   whose story does not run over) and *align to margin* (outer, inner, or a side; outer and
   inner follow the page's spine). Evaluating one reads the document and changes nothing.

2. **The records live in the document's own label `x-paged:constraints`.** One envelope
   (`{ v: 1, data: { constraints } }`, ASCII-only) on the document, written by
   `setDocumentMetadata`: undoable, in a `.paged` file, and kept by an `.idml` export as a
   `Properties/Label` entry on the designmap's Document, which InDesign preserves (protocol 70,
   PM-0018's carrier). A document label rather than a label on each item: a constraint relates
   several items, belongs to none of them, and has to be found without walking every item. Its
   members are page item ids, which IDML keeps as `Self`, so they resolve after a round trip. A
   record that cannot be read is left out, never repaired; a member that is gone leaves its
   constraint *unknown*, listed and reported, never dropped silently. At most 200 per document,
   inside the engine's 64 KiB label cap.

3. **Evaluated continuously, deterministically, viewport first.** After any change to the
   document (an edit, an undo, a gesture's commit, a load) and a 150 ms pause, one batched
   `elementGeometry` read places every member; the constraints standing on the pages in view are
   measured and published first, the rest when the editor is idle. Nothing new crosses the wire:
   boxes come from the geometry (an oriented frame's bounding box on its page), lines and the
   foot of a frame's first line from `selectionGeometry` over its story (one box per line, each
   naming its frame), overset from the stories collection, margins and the spine from the pages
   collection. The same facts give the same answer to the hundredth of a point, whatever the
   zoom or the order of the reads; the tolerance is 0.5 pt.

4. **What does not hold is an issue of the publication** (ADR 1223), with its suggested fix.
   The issue store now keeps one set per source (the publication's own reads, the constraints,
   the publication contract) and shows them as one. A broken constraint is a warning on its
   first member; one whose member is gone is a note. Its fix says what it will do before it runs
   ("Align to the key object — Moves 1 item by 108 pt. Nothing else changes."), **previews**
   where it will put things (dashed boxes on the canvas while the fix has the pointer or the
   focus; nothing is sent to the engine) and **applies as one undo step**: the planned moves go
   through the one translation path the nudge and the Transform panel use (`translationPlan`), as
   one batch. *Must fit* offers Expand frame; *maximum lines* offers no change ("Fewer lines take
   other words or other type; Paged never changes the text itself"), shown as advice, never as a
   button that pretends. Expand frame on an overset issue previews its new box the same way.

5. **Made from the selection, shown on the page, kept in a panel.** Object ▸ Add constraint…
   and the canvas context menu's row open a dialog with the kinds the selection can take and the
   one parameter each needs; it says that Paged checks the rule and never moves anything by
   itself; Add is one undo step. The glyphs — a hairline along an aligned edge, an equals sign in
   each gap of an even spacing, a bracket across a minimum gap, a tag on a frame's lines or fit,
   a tick from an edge to its margin, faint while it holds and in the review colour while it
   does not — are an editing aid, View ▸ Editing aids ▸ Design constraints (on by default,
   remembered with the other aids, hidden in Proof view, never printed). Window ▸ Output ▸ Design
   constraints lists them with their state, selects their items and removes one (one undo step).

## Consequences

- Nothing moves unless the user applies a fix: imported IDML and print composition stay exactly
  as the engine lays them out. A constraint is intent the document carries; a solver, if one is
  ever wanted, would be a separate decision.
- The first baseline is measured at the foot of the first line's box: the engine reports a
  line's box, not its baseline. First lines of one size and font align exactly; mixed sizes
  differ by their descents. A frame's first baseline on the wire would make it exact (an engine
  gap, recorded here).
- An InDesign user's edits keep the label but InDesign does not evaluate it; the next open in
  Paged does.
- Tests: `apps/canvas/test/unit/constraints/evaluate.test.ts` (each kind, determinism, the label
  round trip and its shape check, the kinds a selection takes, a pass that reads and publishes
  and never writes), `apps/canvas/tests/e2e/px-constraints.spec.ts` (Add constraint… is one undo
  step and evaluation never moves anything — model and history unchanged; the glyphs as an
  editing aid; the fix's words, its preview that changes nothing, its one undo step and Undo;
  the label through a `.paged` save and an IDML export).

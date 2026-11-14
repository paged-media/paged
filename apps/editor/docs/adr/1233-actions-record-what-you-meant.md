# ADR 1233 — Actions record what you meant

- **Status:** Accepted 2026-11-14.
- **Scope:** `packages/shell/src/actions/` — `intent.ts` (new: selection tokens, object
  references, parameters), `run-plan.ts` (new: the plan, its refusals, the undo statement),
  `document-store.ts` (new: the document's actions), `actions-door.ts` (new: `actions@1` and the
  `paged.*` script), `model.ts`, `player.ts`, `actions-context.tsx`; `registries/command.ts`
  (`history`); `state/preview-targets.ts` and `overlays/preview-targets.tsx` (new, shared with
  [ADR 1234](1234-the-assistant-proposes-you-approve.md)); `apps/canvas/src/panels/actions-panel.tsx`,
  `actions-preview.tsx` (new); `app/mount.tsx` (the overlay, the door). Implements
  `UXI-MUT-004`, `UXI-MUT-013` and `UXI-MUT-014` of the interaction specification
  ([ADR 1200](1200-the-interaction-contract-is-adopted.md)) and the history table's "reusable
  action automation" row (§17.2); task PX4 of [`interaction-plan.md`](../interaction-plan.md),
  the strategy's Concept F. Builds on WP4.11's recorder and player and on the `actions@1` door
  ([PM-0015](../../../../docs/adr/PM-0015-data-and-actions-are-platform-layers.md), extensions
  ADR 344). Relates to [ADR 1218](1218-commands-say-why-they-do-not-apply.md) (applicability)
  and [ADR 1219](1219-operation-feedback.md) (feedback).

## Context

Actions recorded command invocations and replayed them in one undo group. Three things kept them
from being automation a designer could trust:

- **A payload held the recorded document's ids.** Align, the clipboard and every typed command
  name their targets as addresses. A recorded "align these" therefore carried two frame ids of
  the recorded document; it was classified document-bound and skipped everywhere else. What the
  user meant — align *the selection* — was not recorded at all (`UXI-MUT-013`).
- **Field edits were not recorded.** A font size, a style or a colour set from a panel went to
  `host.objects` directly; the recorder only counted it as an uncaptured direct edit, so the
  strategy's example ("match widths → align centres → distribute → apply Caption style") could
  not be recorded.
- **A replay targeted whatever was there.** The registry answers an inapplicable command with a
  silent no-op, so a step that did not apply was skipped without a word; a missing object, a
  different edit context or a template filler's session were found out by failing, half way
  (`UXI-MUT-014`). The undo cost was reported after the run, not said before it
  (`UXI-MUT-004`).

## Decision

1. **A step records its selection as an intent.** Where a payload names exactly what was
   selected — a list of the selected items' addresses, the one selected item, the text
   selection's range — the recorder writes a token (`{"$selection": "elements" | "element" |
   "text"}`) instead; a replay resolves it to its own selection. Every other address stays an
   **object reference**. A step also keeps the **edit context** it ran in (`context`, null on the
   page).
2. **A field's commit is a step.** The provider re-provides the object model to the panels it
   wraps, and a `set` or `batch` a field commits records as one `paged.object.setProperty` step
   per path and value (`{ targets, path, value }`, the targets tokenised as above); a scrub (one
   coalesce key) records once, its last value. The player writes it through `host.objects` as
   one batch — inside the run's undo group. It is not a registered command (it would sit in the
   palette needing arguments); like an inserted stop it is the player's.
3. **Parameters.** Any scalar value of a step's payload can be made a parameter (`params`: id,
   label, step, path, value); the panel lists them with their values, and a run applies them
   before it sends the payload. The command's declared args (ADR 323) check the result.
4. **A run is planned before it runs, and refused precisely.** `planRun` works out, from the
   commands on offer, the selection, the edit context, the session role and which recorded
   objects the document holds: the steps with their payloads as they will be sent, the objects
   each acts on, and the **refusals** — no document; a role that may only fill a template; the
   first step's context is not the current one; a command this editor does not have or does not
   offer; a recorded object not in this document; a selection a step needs and that is not
   there; a value the command's args refuse. Each names its step ("Step 2 “Align centres” needs a
   selection, and nothing is selected."). Any refusal means nothing runs — an action never
   targets something else instead. Selections are checked up to the first step that may change
   one; the player asks again **right before each step** (the context, the selection, the
   command's applicability, ADR 1218). A step refused there ends the run, and the run's writes,
   which are one undo step, are undone (D-16, all or none); a run whose chain was broken keeps
   what ran and says so.
5. **The undo cost is said before the run.** The plan's statement is one undo step when the
   client groups the writes (WP4.11); "up to *n* undo steps: … make their own" when a step's
   command declares `history: "own-step"` (a script run) or runs in a context that owns its undo;
   "each write is its own undo step" without a group. A run that is not one step runs only from
   its preview: the palette's entry reports why and leaves the preview open.
6. **The preview.** Preview shows the plan in the panel and outlines every target on the canvas
   (`overlays/preview-targets.tsx`, the review colour; pointing at a target in the list draws it
   stronger); Run is offered only when nothing refuses. It changes neither the document nor the
   selection. The overlay and its store are shared with the assistant's proposals (ADR 1234).
7. **Kept for the user or in the document.** An action's `scope` is `user` (the browser's
   settings store, as before) or `document`: the label `x-paged:actions` on `doc`, the envelope
   `{"v": 1, "data": <library>}`. It travels with the file through `.paged` and IDML; moving an
   action into or out of a document is an ordinary write, one named undo step. A label larger
   than 60 000 bytes is refused, by name.
8. **On the platform's door.** Each saved action is registered on `actions@1` as
   `paged.actions/<id>`: input `selection` (a snapshot of addresses), output `value` — what the
   action would invoke over that selection (each step's command and payload, parameters applied,
   the selection resolved, the selections it lacks). It computes and never edits, as PM-0015
   asks; the editor's command applies it in one undo step. Its parameter defaults carry the
   action's revision, so the door's content cache never answers for an older recording.
9. **Palette and script.** Every saved action is a palette entry, "Run action: <name>"
   (`paged.actions.run:<id>`, not recordable). Its `paged.*` script writes each property step as
   `paged.batch` over `paged.selection()` (or the text selection) — exact, runnable in the Script
   panel and the command lines — and words a step that is an editor command (Align, Group) as
   one a script cannot run, rather than pretend. The editor-command projection (`editor.runCommand`)
   stays.

## Consequences

- An action recorded in one document runs in another on that document's selection; a step that
  names an object of the recorded document is refused there by name, unless the user pins it
  (document-bound steps stay off by default).
- Canvas gestures and typing are still not recorded; the recorder counts them, as before.
- The registry's silent no-op for an inapplicable command no longer reaches a replay.
- Tests: `packages/shell/test/actions/intent-plan.test.ts` (tokens, parameters, the plan's
  refusals and undo statement, the player's refusal and rollback, the door's projection, the
  script); `apps/canvas/test/panels/actions-panel.dom.test.tsx` (preview, parameters, refusal);
  `tests/e2e/actions-automation.spec.ts` (a recorded align and field edit replayed on another
  selection is one undo step, its preview outlines exactly the targets and changes nothing, a
  missing object is refused with the model and the history unchanged).

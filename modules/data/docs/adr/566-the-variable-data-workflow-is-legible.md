# ADR 566 — The variable-data workflow is legible: six steps, a record scrubber, an outlier finder, badges as an editing aid

- **Status:** Accepted, 2026-11-14.
- **Scope:** `data-bundle/src/workflow.ts` (new: the steps' states), `src/outliers.ts` (new: the
  ranking), `src/panels/data-workflow.tsx` (new: `WorkflowSteps`, `RecordScrubber`,
  `OutlierFinder`, `measureImageRatio`), `src/panels/bindings-panel.tsx`, `src/session.ts`
  (`boundFields`, `evaluateAt`), `src/messages.ts` (the Bindings panel's words, F-46),
  `src/panels/pagination-panel.tsx` and `src/panels/sources-panel.tsx` (the host's numeric
  field); the editor's editing aids (`dataMarkers` joins them: `packages/shell/src/state/
  view-toggles.ts`, `editing-aids.ts`, `apps/canvas/src/view-commands.ts`, `app-commands.ts`).
  Task CM5 of the editor's interaction plan; the UX strategy's §7.5; the UX audit's F-46.

## Context

Variable-data publishing is a sequence — connect a source, choose the records, bind the fields,
look at the variants, check them, publish — but the Bindings panel showed it as a column of
controls in no order, so a new user could not tell what to do next or what was done. The preview
was a stepper ("preview record: ‹ prev –/– next ›", "jump to:") that walks one record at a time;
finding the record that breaks a layout (the longest title, a missing picture, an odd crop) meant
paging through all of them. The binding badges on the page (the data markers) had a View menu row
of their own, apart from the other nonprinting aids. The panel spoke the engine's words in lower
case ("bindings:", "Lower to document", "field (column name)") with the operating system's
checkboxes (F-46).

## Decision

1. **Six steps.** The Bindings panel opens with **Connect source → Choose records → Bind fields
   → Preview variants → Validate → Publish**, each a button that says its state, read from the
   session as it is: done (✓), the step to do next (`aria-current="step"`), to come, or — for
   Validate — attention when the outlier finder found something (⚠). A step's button goes there:
   the Sources panel, the Query panel, the field-mapping wizard, the scrubber, a scan for outliers,
   the merge.
2. **The record scrubber** replaces the stepper: Previous and Next, a slider over every record
   that previews the record it settles on (140 ms after the last move: each preview writes the
   document through the same lanes a batch run uses), the host's numeric field for a record
   number, and "Record 3 of 120". Its keys are the slider's (the arrows, Home, End).
3. **The outlier finder.** **Find outliers** reads every bound field of the picked query (a
   variable field, an image, a barcode: `boundFields`) over the records, at most 500, as the
   fields show them (`evaluateAt`, the engine's `evaluate_at`; reading writes nothing), and
   ranks: a missing value; a text value at least 1.5 times the field's median length and 8
   characters longer (the three longest per field); a picture whose proportions differ from the
   field's median by more than 35 % (read by the browser from a URL it can load; a path it cannot
   resolve is not measured). **Check for overflow** previews the records with the longest values
   one by one, notes those after which more stories overset than before, and returns to the
   record shown; they lead the list. A row is a button: it previews its record. The ranking is
   pure (`outliers.ts`); what a value is stays the engine's.
4. **Badges as an editing aid.** The data markers become the editing aid **Data bindings**
   (View ▸ Editing aids ▸ Data bindings and the bottom bar's control, editor ADR 1212),
   remembered with the others and hidden in Proof view; the command keeps its id
   (`paged.view.toggleDataMarkers`). View ▸ Show data markers left the feature ids with a
   deprecation window, 0.80 to 0.82 (`apps/canvas/deprecated-ids.json`). The panel says where the
   switch is.
5. **Words (F-46).** The Bindings panel's labels are sentence case in product language: "Place on
   page" (was "Lower to document"), "Column" (was "field (column name)"), "Bindings", "Sync
   states", "None", the binding kinds and sync states capitalised, "Needs a manual expression";
   its checkboxes take the editor's accent. "Data query…" and the Data query panel stay one entry
   in the menu bar (editor ADR on F-18: the dialog row stands for the panel's row).
6. **One numeric field.** The merge's row and column spacing (lengths), a format's decimals, the
   record-flow line height (a length in points) and a source's refresh interval are the host's
   `NumericField`; the three files leave the `raw-number-input` baseline.

## Conformance (interaction specification §21.3)

| Item | How |
|---|---|
| Owner and focus | Panel controls; the slider and the number field own their keys. |
| Preview, commit, cancel | A scrubbed record previews where the slider settles; a typed record on Enter or leaving the field. |
| Undo | A preview is the document's step, as before; reading values and ranking outliers write nothing. Check for overflow writes previews and returns to the record shown. |
| Permission refusal | Every preview is a document write the engine's role policy refuses. |
| Keyboard alternative | Every step, record and outlier is a button or a field; the slider moves by the arrows. |

## Consequences

- `test/workflow-outliers.spec.ts` (the steps' states; the ranking of missing, long, odd ratio
  and overflowing records), `test/data-workflow.dom.test.tsx` (the parts rendered), the data
  preview journey (the scrubber's position and buttons; Find outliers writes nothing and Validate
  is done), the editor's editing-aid tests (`dataMarkers` remembered, its row in the submenu).
- The data journeys and showcase pages press **Place on page**.
- Locale-specific overflow (a German text longer than the English) is found by previewing in that
  locale and checking for overflow; the finder does not switch locales on its own.

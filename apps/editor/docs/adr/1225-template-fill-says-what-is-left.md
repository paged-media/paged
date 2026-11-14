# ADR 1225 — Template fill says what is left: required and optional, progress, the next field, Finish

- **Status:** Accepted 2026-11-14.
- **Scope:** `apps/canvas/src/panels/template/progress.ts` (new: a filler's progress),
  `panels/template/form-panel.tsx` (the progress bar, the field's Required / Optional, the missing
  value's message, Next field, Finish and its confirmation, the docked form and the phone sheet
  alike), `panels/template/messages.ts`; the `template-fill` profile of
  `apps/canvas/src/profiles/presets.ts` is unchanged. Task CM5 of
  [`interaction-plan.md`](../interaction-plan.md); the UX strategy's §7.8; the interaction
  specification's §13.3 (`UXI-CAM-013`), §19.3 (`UXI-A11Y-011`), §21.2 and `UXI-T73`. Builds on
  [ADR 294](294-the-fill-presets-on-phones-and-tablets.md) (the field sheet on a phone).

## Context

A person filling a template sees its fields, their labels and help, a count of characters and a
warning when text oversets. The form did not say which fields were required (an asterisk only),
how far the filler had come, which field to fill next, or when the work was done; a required
field left empty was refused only when written, and nothing offered a predictable end — export
or save — beside the form.

## Decision

1. **Required or optional, in words.** Every field's label is followed by **Required** or
   **Optional** (`data-field-required`).
2. **Progress.** The form opens with "3 of 5 fields filled", a progress bar
   (`role="progressbar"`) and "1 required field is empty"; **Next field** goes to the next field
   that still needs a value — required ones first, round the form — puts the caret in its control
   and selects its frame, so on a phone the sheet shows it (ADR 294). A field holds a value when
   its text is not blank, its picture is placed, or it has any other value (`progress.ts`, read
   from the engine's `templateFields`).
3. **Missing content.** **Finish…** checks the form: with a required field empty, it says how many
   (`role="alert"`), every empty required field shows "Required: fill this in.", and the caret
   goes to the first; text that does not fit its frame holds Finish back the same way. With
   everything in place it confirms — "All required fields are filled. The page shows what will be
   published." — and offers **Export PDF**, **Save** and **Back to the form** (the registered
   commands; a profile that hides them leaves the button inert).
4. **The page is the live preview.** Every value is written to the document as it is committed;
   the page beside (or above, on a phone) shows the publication as it will print.
5. **Authority stays with the engine.** The form's state is a reading of the engine's fields; a
   write a role may not make is refused by the engine's policy, whatever the form shows
   (`UXI-PLG-007`, `UXI-T45`, `UXI-T46`).
6. **Phones.** The progress, Next field and Finish appear in the phone's field sheet too, at touch
   size (44 px), with the one-finger pan and two-finger pinch of ADR 294 (`UXI-CAM-013`,
   `UXI-A11Y-011`).

## Consequences

- `test/panels/template-progress.test.ts` (what is filled, the next field, overset),
  `test/panels/template-form-panel.dom.test.tsx` (Required and Optional, the progress, a blocked
  Finish and its messages, the confirmation after the field is filled, the engine's value), and
  `tests/journey/focused/mobile-fill.journey.spec.ts`, now `UXI-T73`: on a Pixel 7, a tapped field
  opens in the sheet with the progress and touch-sized buttons, a typed value is one undo step
  (undo and redo on the header), the photo comes from the camera, one finger pans, the zoom
  buttons and a pinch zoom.

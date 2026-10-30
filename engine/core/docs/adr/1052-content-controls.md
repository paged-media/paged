# ADR 1052 — Content controls

- **Status:** Accepted 2026-10-30.
- **Scope:** protocol v78 (a rider: new mutations and optional fields). Part of engine wave W4
  of the paged.doc Word-parity program; Word's `w:sdt` mapping is paged.doc work (doc ADR 614).
  - `paged-model`: module `content_control` (`ContentControl`, `ContentControlKind`,
    `ListItem`); `CharacterRun.control`.
  - `paged-mutate`: operations `SetContentControlValue` and the inverse-only
    `RestoreContentControl` (`apply/content_control.rs`); the property path
    `characterContentControl`; `OperationError::InvalidControlValue`.
  - `paged-wire`: `setContentControlValue`, `toggleContentControl`,
    `chooseContentControlItem`.
  - `paged-canvas`: their lowering and undo labels; the story read's `RunContent.control`
    (`ContentControlContent`, `ContentControlItem`).

## Context

A Word form is text with fields in it: a checkbox, a drop-down, a date, a plain or rich text
range (Word's inline content controls, `w:sdt`). The engine had no form field of any kind, so
paged.doc showed a control's content as plain text and could not change it as Word does.

## Decision

**A control is a range of runs.** `CharacterRun.control` names the control a run is text of;
every run of one control carries it, contiguous in one paragraph. The control says what the
text means: `PlainText` (one run; a new line becomes a space unless it is multi-line),
`RichText` (its runs keep their own formatting), `Checkbox` (checked or not, each state's glyph
and the glyph's font — Word's `w14:checkbox`, ☒ / ☐ in MS Gothic by default), `DropDown`
(items with display text and value, the chosen value; `combo` also takes free text) and `Date`
(a value `YYYY-MM-DD` and a Word date picture). It also carries its tag, title, lock, and
whether its text is the placeholder (with the character style the placeholder is drawn in).

**Drawing needs nothing new.** The control's text is its runs': a checkbox draws its glyph in
the glyph's font, a drop-down its item's display text, a date its value formatted with its
picture (`format_word_date`, engine ADR 1022), a placeholder in its own character style.

**One value set is one undo step.** `SetContentControlValue { storyId, controlId, value }`
replaces the control's runs with ONE run formatted as its first run, holding the value's text:
free text for plain and rich text, an item (by value or display text) for a drop-down (a combo
box also any text), `YYYY-MM-DD` for a date, `true` / `false` / `toggle` for a checkbox (whose
run takes the new glyph's font). The first value ends the placeholder: the flag clears and the
placeholder's character style comes off the run. A content-locked control (`contentLocked`,
`sdtContentLocked`) and a value the kind does not take are refused (`InvalidControlValue`),
the model untouched. The inverse, `RestoreContentControl`, puts the control's runs back
exactly as they were (their JSON), so undo restores the model hash.

**On the wire**, each Word gesture is one mutation and one undo step:
`setContentControlValue`, `toggleContentControl` (the checkbox flips) and
`chooseContentControlItem { index }` (the item's value). `characterContentControl` (a
property path, `Value::Text` of the control's JSON, `""` for none) makes a range a control, so
an importer pours a control onto its runs with the ordinary range write and its exact undo.
The story read reports each run's control: its id, kind, tag, title, lock, placeholder flag,
checkbox state, items, chosen value and date picture.

**Not in this wave:** block-level controls (a control around paragraphs or a table) stay the
importer's (paged.doc shows their content and keeps the `w:sdt` in the source); PDF AcroForm
fields; data binding (`w:dataBinding`); a picture control.

## Evidence

- `crates/paged-model/src/content_control.rs` tests: each kind's values and refusals, the
  JSON shape.
- `crates/paged-mutate/src/apply/content_control.rs` through
  `crates/paged-canvas/tests/it/content_controls.rs`: a checkbox toggles its glyph and font, a
  drop-down takes an item, a date its formatted value, a plain text control a text (its
  placeholder style dropped); each one undo step, all undone back to the start hash; the
  story read reports each control; a bad item, a bad date, a missing control, a toggle of a
  drop-down and a locked control are refused with the model untouched.

## Consequences

- paged.doc reads Word's inline `w:sdt` onto these controls, edits them from a panel the caret
  opens and writes a changed value back into the control's `w:sdt` (doc ADR 614).
- The editor can show and edit any document's controls through the three mutations.

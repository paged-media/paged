# ADR 1017 — A text field takes the styles and breaks its author allows; alternates choose a frame

- **Status:** Accepted 2026-10-24.
- **Scope:** `crates/paged-template` (`Constraints::allowed_styles`, `Constraints::breaks`,
  `TextBreaks`, `TemplateFieldKind::Alternates`, `FieldDef::members`,
  `DocumentPolicy::alternates`, the index's member grants, `allowed_character_style`,
  `alternate_members`, preflight, the derive attributes), `crates/paged-mutate/src/apply/permit.rs`
  (a character style a field allows, `check_breaks`), `crates/paged-canvas/src/template.rs`
  (`FieldValue::Runs`, `FieldValue::Alternate`, `StyledRun`, `RunBreak`,
  `TemplateFieldSummary::members`). Protocol 76, additive. Decisions 5–7 of the editor's
  `docs/composable-editor.md` §12 ("Decided on 2026-10-24").

## Context

A text field swapped plain text and kept the frame's styles ([ADR 1000](1000-a-template-policy-lives-in-labels.md),
[ADR 1001](1001-the-session-has-a-role-and-refusals-are-typed.md)). Real forms want a little
more: a name in bold inside a sentence, an address on three lines, and a choice among several
designed variants of a part of the layout (a photo left or right, a badge or none). Granting
`text.style` opens every style and every property of the text, and a visibility field per variant
lets a filler show none or all of them.

## Decision

**A text field lists the character styles its value may use.** `constraints.allowedStyles` names
them by style id (`CharacterStyle/Bold`) or name (`Bold`); `constraints.breaks` is `none`, `line`
or `paragraph`, each taking the ones before it, and absent means any. A value may be plain text
or **styled runs**: `{ kind: "runs", runs: [{ text, style? } | { break: "line" | "paragraph" }] }`.
A run without a style is in the frame's own style (the first run's, as a plain value is); a run
with one is written by `ApplyStyle` at character scope in the same batch. A style the field does
not list, a style the document does not define, or a break the field does not take refuses the
whole set with a problem (`the field does not allow this character style`, `the field takes no
line breaks`, `the field takes no paragraph breaks`). Such a field reads back as runs, in the
field's own spelling of each style, so `template check` refills a submission exactly.

**The policy grants only that.** A character-scope `ApplyStyle` on a body range is satisfied by
`text.edit` when the story's text field allows that style; any other style still needs
`text.style`. Typed text is checked too: an `InsertText` that holds a break the field does not
take is refused as `NotPermitted` of `text.edit`, its target naming the break. Nothing else
opens: paragraph styles, direct formatting and other character styles stay closed to a filler.

**Alternates are a choice among items.** An `alternates` field lives in the document's policy
(`alternates`, by field name) and lists its `members` by item name, the handle that survives an
InDesign save. Its value is `{ kind: "alternate", member }`: the engine sets the visibility of
every member, the chosen one shown and the rest hidden, in one batch and one undo step. A member
is granted `item.visibility` and nothing else; it counts as a field's item, so renaming it is the
author's. The `templateFields` row lists the members with their items and visibility and carries
the shown member's item, which a canvas outlines. In IDML the members are ordinary page items,
the ones not chosen hidden (`Visible="false"`), and the policy rides in the document's label.

**Preflight** adds `styleUnknown`, `stylesOnNonText`, `alternatesTooFew`, `alternateMissing` and
`alternateNotOne`. Derive reads `allowedStyles` (comma-separated) and `breaks` attributes from a
tagged element, and `field_attributes` writes them.

**Placeholder runs are the range mechanism** (decision 5): a field limited to part of a story is
a `textRun` field on a placeholder run (ADR 1002). This record adds no second mechanism; a run
field takes plain text.

## Evidence

- `crates/paged-canvas/tests/it/template_styled_alternates.rs`: a styled value in one undo step
  and read back; refused styles and breaks; a filler typing and styling inside the field; picking
  an alternate in one step and undoing it; a member granted visibility only; alternates and styled
  values through IDML export and import; the preflight findings.
- `crates/paged-template` unit tests: the derive attributes.

## Consequences

The value vocabulary of `setTemplateFields` grows by two kinds; an engine without them refuses
them as a value that does not fit the field's kind. A filler can still show two members through
`item.visibility` by hand; `template check` and `alternateNotOne` report it, and the form never
does it. `textRun` fields take no styles.

## Related

- [ADR 1000](1000-a-template-policy-lives-in-labels.md), [ADR 1001](1001-the-session-has-a-role-and-refusals-are-typed.md),
  [ADR 1002](1002-xml-tags-carry-template-fields.md)

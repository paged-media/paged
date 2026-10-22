# ADR 276 — Filling a template

- **Status:** Accepted 2026-10-22.
- **Scope:** the profile's `role` (`packages/shell/src/profile/`),
  `packages/shell/src/state/session-role.tsx` (`SessionPolicyProvider`, `useSessionRole`) and
  `PagedShell`'s `sessionPolicy` prop; `apps/canvas/src/panels/template/form-panel.tsx`
  (`paged.template.form`); the `template-fill` and `viewer` presets
  (`apps/canvas/src/profiles/presets.ts`). Follows [ADR 274](274-the-editor-profile-is-runtime-data.md)
  and engine ADRs 1000 and 1001. Task D of [the composable editor's plan](../composable-editor-plan.md)
  (D1, D2, D5).

## Context

The engine enforces a template's policy for a session's role and exposes the fields as a
collection and a message (engine ADRs 1000, 1001). The editor had no way to say who a session
is, nothing to fill fields with, and no shape for an editor whose user only fills in a template.

## Decision

**The role is part of the profile.** An editor profile may name a `role` (`author`, `editor`,
`filler`, `viewer`; default `editor`), resolved through its preset chain and shape-checked.
`PagedShell` takes a `sessionPolicy`, hands it to the engine whenever it changes (the worker
keeps it across document loads), and publishes the role through `useSessionRole` for the UI.

**The template form is a host panel.** `paged.template.form` lists the `templateFields`
collection in the author's order and groups, with a control per kind: a text input (with a
counter when the field has a maximum length) that commits on Enter or blur, a Replace button
for a picture (the bytes go through `replaceImageBytes`, which the engine checks as
`image.replace` on the item), a checkbox for a visibility field. Text and visibility values go
through `setTemplateFields`, so they are one undo step and refused when the template does not
permit them; a refusal or a constraint problem shows under the field in words. Kinds the engine
cannot set yet say so.

**Two presets.** `template-fill`: a filler session; a header with Undo, Redo and Save; a short
tool rail (select, type, hand, zoom); the canvas without rulers or title bar; the form as the
inspector; no menu bar, context toolbar, panel rail, mode bar, palette or canvas context menu.
`viewer`: a viewer session; the canvas and its thumbnails, a hand and zoom rail, nothing else.

## Evidence

- `apps/canvas/test/panels/template-form-panel.dom.test.tsx`: no fields; a filler fills a text
  field through its input and the engine holds the value; a visibility field toggles.
- `apps/canvas/tests/journey/focused/template-fill.journey.spec.ts`: the fill preset boots
  without menus, rulers or search; an author makes a field, a filler fills it through the form,
  and moving its frame is refused as `notPermitted`; the viewer preset shows the canvas alone.
- `packages/shell/test/profile/profile.test.ts`: the role through the chain and the shape check.

## Consequences

The field outlines on the canvas, the Replace affordance on an image field and a fill edit
context (plan tasks D3, D4) are still to come; until then a filler fills through the form and
can type into a text field on the canvas with the type tool. A picture replaced through the form
keeps the frame's previous fit. The journey is tagged with the solo-mode feature until the feature
registry has a row for template fill.

## Related

- [ADR 274](274-the-editor-profile-is-runtime-data.md) — the profile and its presets
- [ADR 275](275-features-gate-what-is-offered.md) — the features the fill preset switches off

## Amendment — 2026-10-22: outlines and the Replace button (D3); no separate fill context (D4)

The overlay `paged.template-fields` (`apps/canvas/src/overlays/template-fields.tsx`) outlines
every field of the template, dashed, with its label, for an author and a filler; a picture
field carries a Replace button, the overlay's one interactive part (the bytes go through
`replaceImageBytes`, checked by the engine). An editor and a viewer see the document as it
prints. The label and button keep their size on screen at any zoom. Evidence:
`apps/canvas/test/panels/template-field-outlines.dom.test.tsx`.

The plan's fill edit context (D4) is not built as an edit context: the `template-fill` preset
registers only the select, type, hand and zoom tools and removes the context toolbar, and the
engine refuses what the template does not permit (engine ADR 1001), so an edit context would
restate both. The Consequences above are updated accordingly.

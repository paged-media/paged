# ADR 1001 — The session has a role; permissions are checked at three doors; refusals are typed

- **Status:** Accepted 2026-10-22.
- **Scope:** protocol v75 (`crates/paged-canvas/src/channel.rs`: `SetSessionPolicy`,
  `SessionPolicyApplied`, `WorkerError::NotPermitted`, `WorkerError::Locked`,
  `GestureFailure::NotPermitted`); `crates/paged-canvas/src/model.rs` (the session policy,
  `apply_operation` through `apply_checked`, `refuse_unpermitted`, `selectability`,
  `frame_mutation_error`); `crates/paged-canvas/src/gesture.rs` (the check at a gesture's
  beginning); `crates/paged-canvas/src/hit.rs` (point and marquee hits);
  `crates/paged-canvas-wasm/src/dispatch.rs` (the policy kept across loads);
  `paged-mutate`'s `permit::check_requirements`. Follows
  [ADR 1000](1000-a-template-policy-lives-in-labels.md). Tasks C2, C5 and C6 of the editor's
  composable-editor plan.

## Context

ADR 1000 put the template policy in the document and the check in `paged-mutate`, but nothing
told the engine who the session is, and not every write becomes an `Operation`: text
insertion and deletion are applied as text operations, several document settings return before
any operation exists, and a drag moves its preview before its commit is checked. A refusal also
needs a form a host can act on: `Locked` reached the wire as a sentence inside `NotImplemented`.

## Decision

**The role is session state on the wire.** `SetSessionPolicy { policy }` sets the role and the
host's overrides and is answered with `SessionPolicyApplied`. The worker keeps it across document
loads, as it keeps the snap settings; it is not saved and not undoable. The CLI's session and
the wasm worker share it through `WorkerCore`.

**Three doors check it.**

1. Every edit that becomes an `Operation` goes through `CanvasModel::apply_operation`, which now
   applies with `apply_checked` (a batch's children included, before anything applies).
2. `apply_mutation` refuses, before it routes, the writes that never become an operation: text
   insertion and deletion need `text.edit` on the story's frame; document defaults, colour
   settings, ink settings and the Lab-for-spots switch need `document.styles`. The soft-proof
   setup is view state and stays free.
3. A gesture is refused at its beginning when the session may not commit it (`item.move` for a
   translate, `item.rotate`, `image.crop` for the content gestures, `item.resize` otherwise),
   as a locked item already is.

Undo, redo and rollback stay unchecked (ADR 1000).

**A session that may not select an item does not hit it.** The point hit test and the marquee
skip such items, so a filler's click passes through scenery to the field beneath and a viewer
selects nothing. The UI needs no filter of its own for this.

**Refusals are typed.** `WorkerError::NotPermitted { permission, target }` and
`WorkerError::Locked { node, action }` replace the sentence in `NotImplemented`; a batch's
refusal is its child's. The gesture failure is `NotPermitted { id, permission }`. The editor's
shared `refusalText` says each in words.

## Evidence

- `crates/paged-canvas/tests/it/template_policy_wire.rs`: only an author writes the policy; a
  filler types into a field and not into scenery and cannot change document defaults; a drag is
  refused at its beginning; a click passes through scenery to the field and a viewer hits
  nothing; a locked item's refusal is `Locked`.
- `crates/paged-canvas/tests/it/element_lock_wire.rs`: the lock's refusals are typed.
- `platform/shared/panel-kit/test/kit.test.tsx`: the two sentences.

## Consequences

A new message kind an older worker cannot answer: protocol 75. The contract's vendored wire
types (`plugin-api/src/wire.d.ts`) are synced, which moves plugin-sdk's canary. The editor's
`CanvasClient.setSessionPolicy` sets the role; the presets and the fill UI use it (task D).
The policy index is built from the labels on each check of a filler session; a cache keyed on
the document's revision is the next step if it shows in a profile.

## Related

- [ADR 1000](1000-a-template-policy-lives-in-labels.md) — the policy and the operation-level check

## Amendment — 2026-10-22: fields as a read and write surface

Protocol 75 also carries the template's fields (task C8, `crates/paged-canvas/src/template.rs`):

- The `templateFields` collection lists them in the policy's form order, each with its
  definition, its target (the page item or text variable), the story a text field edits, its
  current value (`text`, `image` by URI, `visible`) and whether its story is overset.
- `SetTemplateFields { values }` checks each value against its field (the kind, `required`,
  `maxLength`) and lowers all of them to ONE batch of ordinary mutations, applied as a
  `Mutate` would be: one undo step, the reply and repaint of a mutation, every write checked
  at the doors above. A value that does not fit refuses them all with
  `TemplateFieldsRefused { problems }`. A text field's new text is inserted before the old and
  the old deleted, so it takes the first run's style (content, not design). `textRun`, `choice`
  and `data` fields are listed but cannot be set yet; `pattern`, `maxLines`, `minPpi` and the
  overflow rule are carried and not yet checked.
- A message rather than a wire `Mutation`, so the schema, the plugin SDK's generated core
  commands and the scripting surface do not grow a second way to write what existing mutations
  already write; the CLI and the server send the same message.

Evidence: `crates/paged-canvas/tests/it/template_fields.rs` (form order and values; a filler
fills the form in one undo step; unfit values refuse everything; replaced text keeps its
style; the template survives IDML and `.paged` round trips) and the dispatch test
`the_session_policy_survives_a_load_and_unfit_field_values_are_refused`.

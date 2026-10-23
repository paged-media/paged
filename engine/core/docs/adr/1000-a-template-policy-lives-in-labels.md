# ADR 1000 — A template policy lives in labels, and operations are checked against it

- **Status:** Accepted 2026-10-22.
- **Scope:** the new crate `crates/paged-template` (permissions, roles, the session's policy,
  the stored document and item policies, their resolution); `crates/paged-mutate/src/apply/permit.rs`
  (which permission each operation needs, and the check), `apply_checked` in
  `crates/paged-mutate/src/apply/mod.rs`, `OperationError::NotPermitted`. No wire or protocol
  change yet. The first record of the range PM-0012 gives the engine. Tasks C1, C3 and C4 of the
  editor's composable-editor plan (`apps/editor/docs/composable-editor-plan.md`).

## Context

An embedding product shows its users a template they fill in: type into the open fields,
replace a picture, nothing else (`apps/editor/docs/composable-editor.md` §7). Hiding controls
in a UI does not hold that line, since a script, a plugin or the automation surface reach the
engine directly. The object lock (C-77) is the nearest rule the engine enforces, and it guards
geometry only; a locked layer guards only the pointer.

A template must also survive what documents go through: `.paged` save and load, IDML export and
import, and an InDesign open and save.

## Decision

**The policy is document data, in labels.** The document's policy is the `x-paged:template`
pair of `DesignMap.labels`; an item's is the `x-paged:template` pair of `Spread::labels` for
its `Self` id. Both use the `{ "v": n, "data": … }` envelope every `x-paged:` label uses, so the
plugin metadata gate accepts them and they round-trip wherever labels do. An item policy may
make the item a **field** (`text`, `textRun`, `variable`, `image`, `choice`, `visibility`,
`data`, with constraints) and grant or deny permissions; the document's policy lists what a
filler may do everywhere (nothing, by default), the form order, and the variable fields.

**A role is session state.** `Role` is `author`, `editor`, `filler` or `viewer`; a host
sets it with overrides (`allow`, `deny`, `defer` per permission). Only a filler is bound by the
policy: an author may do everything, an editor everything but write the policy, a viewer
nothing. The default session is an editor without overrides, so an engine that is never told a
role behaves as it always did, except that it will not rewrite a template's policy.

**Resolution** for a filler is the role's defaults, then the document's defaults, the grants
of the item's field (a text field grants `select` and `text.edit`, an image field `select` and
`image.replace`), the item's allow, minus its deny; then the session's overrides, which are
final. For the other roles it does not depend on the document.

**Every operation names what it needs.** `permit::required` maps each `Operation` to
permissions on targets (an item, a story decided by the frame that hosts it, a text variable,
the document). The match has no wildcard, so a new operation does not compile until someone
decides. Attribute writes are classed by property; anything on a parent page is page setup;
the template's own label and the name of a field's item need `template.author`.

**The check comes before apply.** `apply_checked` checks the whole operation, every child of a
batch included, and then applies it; a refused batch never half-applies. The refusal is
`OperationError::NotPermitted { permission, target }`. Undo, redo and a batch's rollback go
through `apply` and are not checked: an inverse restores a state that was permitted when it
was made, and the role may have changed since.

## Evidence

- `crates/paged-template/src/resolve.rs` tests: resolution per role, overrides, envelopes.
- `crates/paged-mutate/tests/it/template_policy.rs`: a filler replaces and crops a field and is
  refused moving, deleting and replacing scenery; a batch is refused whole and leaves the
  document as it was; the policy refuses its own rewrite to a filler and an editor; an editor
  and an author are not bound and a viewer changes nothing; overrides; undo is exempt; parent
  pages are page setup.

## Consequences

The canvas model still calls `apply`; it moves to `apply_checked` with the session's policy
when the role reaches the wire (C2). Text insertion and deletion and the settings writes that
never become an `Operation` need the same check where they apply (`paged-canvas`, C5), and a
gesture is refused at its beginning as a locked item is. The checks build the policy index from
the labels when a filler session asks; a cache keyed on the document's revision is the obvious
next step if that ever shows in a profile.

## Related

- [ADR 005](005-wire-recipe.md) — every operation self-describing and invertible
- [ADR 131](131-one-address-grammar-and-selectors.md) — item names, which address fields

## Amendment — 2026-10-22

The canvas model applies through `apply_checked`, with the session's role on the wire, the
text and settings writes checked, gestures refused at their beginning and refusals typed:
[ADR 1001](1001-the-session-has-a-role-and-refusals-are-typed.md).

## Amendment — 2026-10-23: module fields

A template may open a part of a module's content (a sheet's cell, a doc's block, an edited
image's picture). Such a field has the kind `module`, and its `module` names the module's field
kind (`media.paged.sheet.cell`), the module's definition (a cell reference, an anchor) and the
permissions filling it takes beyond selecting the item and writing the module's label on it
(`select` and `document.metadata`, which the kind grants). `template.author` is never granted
this way. The engine lists a module field in `templateFields` without a value and refuses one in
`setTemplateFields` ("a module field is set through its module"): the module reads and writes
it through `host.objects` (extensions [ADR 335](../../../../platform/extensions/docs/adr/335-modules-contribute-template-field-kinds.md)),
and the engine checks the module's writes against the session's role like any other.

## Amendment — 2026-10-23: a page's own policy

Removing a page (`RemovePage`) and duplicating one (`DuplicatePage`) ask for `document.pages`
on that page instead of on the document. A page's policy is its `x-paged:template` label, kept
on its spread under the page's id, which the policy index already reads like an item's: the
document's defaults still apply, and a page that allows `document.pages` lets a filler copy it
and remove it. A copy carries its source's labels, so the copies of an open page are open too;
inserting a page still needs the document's grant. This is how a data catalogue lets a filler
change its product pages and nothing else (data
[ADR 560](../../../../modules/data/docs/adr/560-template-fields-are-binding-targets.md)).
Evidence: `crates/paged-mutate/tests/it/template_policy.rs`
`a_page_policy_opens_that_page_and_its_copies_and_no_other`.

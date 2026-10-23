# ADR 560 — Template fields are binding targets

- **Status:** Accepted 2026-10-23.
- **Scope:** `data-bind/src/catalogue.rs` (`resolve_catalogue`), `DataSession::plan_catalogue`
  and the wasm `plan_catalogue` in `data-js`; `packages/data-host-model/src/catalogue.ts`;
  `packages/data-bundle/src/catalogue.ts`, the session part's `catalogue` entry
  (`src/persist.ts`), the Bindings panel's "Template fields" section
  (`src/panels/template-fields-section.tsx`) and the typed commands
  `media.paged.data.templateFieldTargets`, `media.paged.data.bindTemplateField` and
  `media.paged.data.runCatalogue`; in the engine, the target of `RemovePage` and
  `DuplicatePage` in `engine/core/crates/paged-mutate/src/apply/permit.rs`. Task F8 of the
  editor's composable-editor plan (`apps/editor/docs/composable-editor-plan.md`).

## Context

A template is a document whose open parts are fields (engine ADRs 1000 and 1001): a text
frame, a picture, an item's visibility, each named, with constraints (`required`,
`maxLength`, a picture's fit). The engine lists them in the `templateFields` collection and
fills them with `setTemplateFields`, which checks each value against its field and writes
the values as one batch of ordinary mutations. The data module already fills a template *by*
data through its own field kinds (`record`, `bindingValue`, `dataSet`, `variable`; extensions
ADR 335). A catalogue is the other direction: the template's own fields are what the data
fills, and the template is repeated once per product.

Three facts shaped the decision:

- `setTemplateFields` is a worker message, not a `Mutation`, and the plugin contract has no
  door for it. It also names a field by its name, and the copies of a page carry the same
  field names as the page, so it could only ever reach the first copy.
- ADR 554's record flow lays out text blocks in a frame chain, with a modelled height per
  record. A template page is laid out by its designer: what repeats is the page, and its
  capacity is one record (or one group), not a number of points.
- A filler may not add or remove pages (`document.pages` is withheld by default), yet "change
  the product list" is a filler's task in an embedding product: the pages of the catalogue
  must follow the data, and every other page must stay as the author made it.

## Decision

**A binding may target a template field by name.** A template-field binding is
`{ field, query, expr, invert? }`: the field's name, the query and the expression (a column
is the simplest one). Text, picture and visibility fields can be targets; module fields
belong to their modules, and the engine cannot set `choice`, `textRun` or `data` fields yet.
`bindTemplateField` checks that the template has the field, that the query exists and that
the expression works on it. The bindings are kept with the session (`catalogue.fields` in
the session part); they are not engine bindings, so no other lane writes them.

**The engine decides every value.** `plan_catalogue(query, { fields, mode, by? })` returns,
per instance, the value each field takes: a text (the value's display), a picture (its URI
or path; an empty one leaves the template's picture), a visibility (truthiness, flipped by
`invert`; a null or non-boolean value hides), `leave`, or a refusal. The template's
constraints travel with each field (`required`, `maxLength`), and the engine refuses a value
they forbid with the rules of `setTemplateFields` (`required`, "longer than the field
allows"), as well as an expression that evaluates to an error value. A refusal anywhere
refuses the whole catalogue before anything is written.

**The values are written as the template form writes them.** `data-host-model`
`catalogueFillOps` lowers them the way the engine's `lower_template_fields` does: the new
text inserted before the old and the old deleted after it (so it keeps the first run's
style), `placeImage` with the field's fit, `elementVisible`. Each copy's fields are named by
their own ids, read from `templateFields` and placed on their pages through
`elementGeometry`. Every write is an ordinary mutation through `host.document.mutate`, so the
engine's three doors check it against the session's role.

**A catalogue repeats the template's page.** `runCatalogue({ query?, template?, mode, by? })`
plans the instances (`perRecord`: one per record, in the record numbering the preview,
tables, record flows and batch plans share; `perGroup`: one per group of `by`, in the order a
record flow's sections take, filled from the group's first record), marks the template page
with this plugin's page label `{ catalogue: <page id> }`, removes the copies of the last run,
and duplicates the template page once per further instance; then it fills the template page
and every copy. The template page holds the first instance. Copies inherit the label (a
duplicated page keeps its labels), so a later run, by anyone, finds and replaces exactly the
catalogue's pages. The pages and the fill are two undo steps (the copies' fields have ids the
first write mints); a run that changes no page is one.

**The filler's permission is the template's, page by page.** The engine asks for
`document.pages` on the page itself when a page is removed or duplicated, instead of on the
document. A page's policy is its own `x-paged:template` label, read like an item's, so an
author who gives the template page `{ "allow": ["document.pages"] }` lets a filler copy that
page and remove its copies, and nothing else: inserting a page anywhere still needs the
document's grant, and every other page stays closed. The copies carry the grant because they
carry the page's labels. The data module never writes a template policy (a bundle writes only
its own label key, and the policy needs `template.author`); the grant is the author's, and the
first catalogue is made by an author, who marks the template page. A filler who runs a
catalogue on an unmarked page is told that an author makes it first.

## Alternatives considered

- **A host door for `setTemplateFields`.** It would hand values to the engine's own checker,
  but it names fields by name, so it cannot address the copies; a target per value would be a
  wire change. The engine's rules are short (`required`, `maxLength`, kind) and the catalogue
  applies them in Rust, where the module's semantics live. When the engine checks `pattern`,
  `maxLines` or overset, this choice is to be revisited (see Consequences).
- **The record flow's paginator.** Packing modelled heights into frames has nothing to pack
  here: one page is one instance. The catalogue keeps what ADR 554 settled that matters to a
  catalogue — the shared record numbering, the grouping order of sections, the writer that
  replaces its own previous output — without the frame chain.
- **A session override for `document.pages` limited to flow pages.** An override is the
  host's and holds for the whole document; scoping it to some pages would make the session
  carry page lists the document already carries. A page policy is document data, travels with
  the template, and needed one change in the engine's permission map.
- **Running the catalogue in an author session and handing the result to the filler.** A
  host can do that today, but the filler then cannot change the product list in their own
  session, which is the task.

## Evidence

- `data-conformance/tests/it/catalogue.rs`: per record with typed values, per group from the
  first record, inverted and non-boolean visibility, constraint refusals, no result, the JSON
  shapes.
- `engine/core/crates/paged-mutate/tests/it/template_policy.rs`
  `a_page_policy_opens_that_page_and_its_copies_and_no_other`.
- `packages/data-host-model/src/__tests__/catalogue.test.ts`: the writes per kind.
- `packages/data-bundle/test/headless/catalogue.headless.test.ts` (real canvas engine, data
  engine and DuckDB): three filled pages, a second run per group replacing the copies, two
  undo steps, a refused value writing nothing, and the filler refused on closed pages and
  changing the list on open ones while a new page stays refused.
- `packages/data-bundle/test/catalogue.spec.ts` (fake editor),
  `test/template-fields-section.dom.test.tsx` (the panel section),
  `apps/cli/test/cli-data-catalogue.spec.ts` (`paged invoke … runCatalogue`).

## Consequences

- The catalogue's constraint check repeats the engine's rules for the constraints the engine
  checks today. A new constraint the engine enforces at `setTemplateFields` (a pattern, a line
  count, overset) must be added to `resolve_catalogue` as well, or the catalogue moves to an
  engine door that takes a target per value.
- The template form of a filled catalogue lists each field once per page, under the same
  name; `setTemplateFields` by name reaches the first one. Filling one product by hand in the
  form is therefore not addressed by this record.
- `duplicatePage` refuses a page whose stories hold a table, an anchored object or a footnote
  (they have ids of their own); such a template cannot be repeated yet, and the run says why.
- The editor's Template panel has no control for a page's policy yet; an author writes the
  page grant through the template message or a host. A filler's catalogue therefore needs an
  author's template that opened its page.

## Related

- [ADR 554](554-record-flow-pagination.md) — the record numbering and grouping a catalogue shares
- [ADR 555](555-batch-reuses-the-engine.md) — per-record and per-group units
- [ADR 557](557-variables-and-data-sets.md) — filling by data, the other direction
- Engine ADRs 1000 and 1001 (`engine/core/docs/adr/`) — the policy, the role and the doors
- Extensions [ADR 335](../../../../platform/extensions/docs/adr/335-modules-contribute-template-field-kinds.md) — module field kinds

# ADR 186 — A mutation names the pages it created

- **Status:** Accepted 2026-10-18.
- **Scope:**
  - `crates/paged-canvas/src/channel.rs`: `MutationApplied.created_pages`.
  - `crates/paged-canvas/src/model.rs`: `MutationOutcome.created_pages`, filled by the
    translated lane (from the applied operation's inverse) and by the sequential batch lane
    (from each child's outcome, which is also where a `bindCreated` page handle now comes from).
  - `crates/paged-canvas-wasm/src/dispatch.rs` threads it onto the reply.
  - No protocol change: the field is new and optional (governance rule 1), on protocol 74.

## Context

A mutation's reply names the elements it created: `created_id` for a single creation, `minted`
for every creation of a batch, each with its `bindCreated` handle. A page is not an element
(`ElementId` has no page variant), so a reply never named a page an `insertPage` or a
`duplicatePage` made. [ADR 128](128-pages-a-merge-can-make.md) let a batch bind such a page to a
handle for its own later children, and kept it out of the reply.

Every caller that needed the new page read the page list again after the mutation:

- the plugin SDK's typed commands (`core.insertPage`, `core.duplicatePage`) and its object
  model's `create page` read it before and after, and took the ids that were new;
- the slide plugin's new slide did the same, in both its panel and its command;
- the data plugin's record flow takes the pages that follow its start page, by position.

That costs two reads of the page list per write, and the answer comes in document order. When
one batch inserts two pages, and the second lands before the first, document order hands each
insert the other one's page.

## Decision

1. **`MutationApplied.created_pages`** lists the body pages a mutation created, in creation order:
   an `insertPage`'s page and a `duplicatePage`'s copy, on their own or inside a `batch`. A page
   the same batch deleted again is not listed. The field is omitted when no page was created.
2. **The translated lane reads the ids off the applied operation's inverse.** An `InsertPage` is
   undone by `RemovePage` of the page it minted, a `DuplicatePage` by `RemovePageClone` of its
   copy, and a batch's inverse is its children's inverses newest first. The forward operation
   cannot say: a fresh `InsertPage` carries the ids its caller gave (none), and a batch echoes its
   children as they were sent.
3. **The sequential lane collects each child's `created_pages`.** A `bindCreated` after a
   page-creating child binds the last page of that child's outcome. Before, the lane compared the
   scene's page ids before and after the child.
4. **Consumers read the field.** The plugin contract carries it as
   `MutationOutcome.createdPages`; the typed core commands share it out in op order, the slide
   plugin takes its new slide from it, and the editor's Pages panel selects the page that New and
   Duplicate made.

## Consequences

- A host learns what a write created from the write's own reply, as it does for elements.
- Creation order is the contract, so a batch of page inserts assigns each insert its own page.
- Not covered: the layers a `layerInsert` creates (the typed commands still diff the layer list),
  the object model's `create page` (it still diffs, and with two page creates in one batch both
  name the first new page in document order), and the data plugin's record flow.

# ADR 1301 — An edit scope is the document's own nesting

- **Status:** Accepted 2026-11-13.
- **Scope:** protocol v80. `paged-canvas` (`scope.rs`: `CanvasModel::scope_subtree`,
  `scope_contains`, `document_revision`, `ScopeSubtree`), `paged-canvas-wasm` (the dispatch arm
  of `RequestScopeContains`), the editor's client (`CanvasClient.scopeContains`,
  `CanvasClient.editScope`, `EditScope`). Implements `UXI-CTX-010` and `UXI-CTX-011` of the
  editor's interaction contract (editor ADR 1200), task EN5 of
  `apps/editor/docs/interaction-plan.md`; proven by `UXI-T44`.

## Context

An edit context (a group entered by a double-click, a module's frame) restricts what a click may
select to the subtree it was entered on. The editor's context stack could only say whether an
id *was* the entered root (`isInScope` in `edit-context-stack.tsx`), so a member of the entered
group, a frame pasted into the entered container or an object anchored in the entered frame's
text read as out of scope — or a host had to rebuild the document's nesting from the scene tree
itself and keep it current. `UXI-CTX-011` asks for an authoritative member query instead of root
equality.

## Decision

**The engine answers the scope of an element from the document's own nesting**, the nesting the
scene tree shows, walked recursively:

- a group's members, nested groups and their members included;
- a container's pasted-in children (`nested_children`, ADR 1010);
- a text frame's story — a story range, a table or a cell in it is in scope — and the objects
  anchored in that story, an anchored group's children and an anchored text frame's story
  included;
- the story of a text path, for the rectangle, polygon or line that carries it.

The root is in its own scope. A story address as the root scopes that story. A module frame is a
page item like any other: its scope is whatever of the above it holds. An id that names nothing
answers `found: false` and an empty scope. Body and master spreads are searched, then the
stories for an object anchored in text.

`RequestScopeContains { root, ids, members }` answers `ScopeContains { root, found, contains,
members?, stories?, revision }`: one boolean per id, and with `members` the scope itself (every
page item below the root and the stories in it). It is a read. `revision` is the model's rebuild
count (`document_revision`): every change of the document rebuilds it, so an answer cached under
a revision is current while the revision stands; a load starts a new document with a new
`docId`.

The client offers `scopeContains(root, ids)` and `editScope(root)`, which answers the whole scope
with a synchronous `contains(id)` and caches it per root until a reply changes the document
(`changesTheDocument`). The context stack's `isInScope` is wired to it by task CM1.

## Consequences

- A press inside an entered context can be checked against the scope before it selects anything;
  the press of engine ADR 1303 takes the root as `scope` and refuses an out-of-scope hit itself.
- The scope is a selection-level guard (`UXI-CTX-010`). It does not authorise writes: an engine
  refusal of a mutation addressed outside a scope remains a separate decision (`UXI-CTX-012`).
- The walk is linear in the subtree and touches no layout, so a host may ask on every press; the
  client's cache makes a context's checks free between edits.

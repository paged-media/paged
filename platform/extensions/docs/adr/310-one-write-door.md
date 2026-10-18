# ADR 310 — One write door: `document.mutate`, engine-owned history, failures as outcomes

- **Status:** Accepted. Recorded retroactively on 2026-10-02 from the code at `d90f727`.
- **Scope:** `DocumentSurface` in `packages/plugin-api/src/host.ts`, `MutationInput` in
  `packages/plugin-api/src/mutations.ts`, `document` in `packages/plugin-sdk/src/host-impl.ts`

## Context

A plugin edits a document that the engine owns. The engine's write vocabulary reaches this
repo as `Mutation`, a closed union discriminated by `op` and vendored from the published
engine package ([ADR 302](302-vendored-wire-types.md)).

`DESIGN.md` states the rule and the reasons. Section 4.3 is headed "read broadly, write
through one door" and says of `mutate`: "Undo/validation/collab semantics stay
engine-owned" (`DESIGN.md:130-132`). Tenet 5 reads "Expected failures are results, not
throws", "mirroring the editor's mutate-never-throws convention and keeping
undo/validation semantics in one place (the engine)" (`DESIGN.md:55-58`).

## Decision

A bundle changes the document model by passing an engine `Mutation` to
`host.document.mutate`, which resolves to a `MutationOutcome`. History belongs to the
engine: `host.document.undo()` and `redo()` step the one shared history, and the SDK keeps
no undo stack and no mutation queue of its own.

- `MutationOutcome` is `{ applied: true; createdId; pageIds }` or
  `{ applied: false; error }`.
- The adapter returns the non-applied form in four cases: the manifest does not declare
  `capabilities.document.write` (in the default `enforce` mode); the mutation, or a child
  of a `batch`, sets plugin metadata under a key other than this plugin's; the engine's
  reply is not `mutationApplied`; the client call throws.
- `setMetadata` builds a `setPluginMetadata` mutation and sends it through `mutate`.
- `undo` and `redo` forward to the client. They need the same `write` declaration; because
  they return nothing, a missing declaration throws in `enforce` mode and is logged in
  `warn` mode.
- A `batch` mutation carries a list of mutations. `bindCreated` exists so that a later
  child of a batch can address an id an earlier child created, which the type's comment
  says "collapses a two-batch flow into ONE undo step".
- Reads are separate members that return snapshots (`collection`, `tree`, `hitTest`,
  `elementGeometry`, …). Changes are announced through `onDidChange` with the kinds
  `mutationApplied`, `undoApplied` and `redoApplied`.

## Evidence

- `packages/plugin-api/src/host.ts:720-728`, `:865-872` — `MutationOutcome` and the change
  event kinds; "The single write door", `undo`, `redo`
- `packages/plugin-sdk/src/host-impl.ts:1713-1754` — `mutate`: the four non-applied returns
- `packages/plugin-sdk/src/host-impl.ts:1636-1647`, `:1974-1991` — the foreign-key check,
  recursive over `batch`; `setMetadata` through `this.mutate`
- `packages/plugin-sdk/src/host-impl.ts:1755-1773`, `:2014-2021` — `undo` / `redo`; the
  change events
- `packages/plugin-api/src/mutations.ts:315-341`, `:362-365` — `bindCreated`; `MutationInput`
- `DESIGN.md:50-58`, `:130-146`, `:712-715` — the tenets, the section, the rejections

## Alternatives considered

`DESIGN.md:708-715` rejects two. A plugin-side mutation queue with local undo: "two
histories is how collaborative editing dies; the engine owns history". And exposing the
shell registries or the engine client directly, which "freezes 100+ members by accident;
kills the namespace/capability chokepoints".

## Consequences

Anything a plugin wants undoable has to be expressible as engine mutations. A missing
operation is an engine change followed by a wire re-sync, not something the SDK can add.
`MutationInput = Mutation | PendingMutation` is the provision for operations the published
wire does not have yet; at this commit every member of `PendingMutation` is already in
`Mutation`, and a type-level check holds that (`packages/plugin-api/src/mutations.ts:394-397`).

One exception exists. An active edit context that declares `onUndo` / `onRedo` receives
the undo keys in place of the document history (`packages/plugin-api/src/host.ts:217-234`;
[ADR 012](012-k1-modal-session-undo-coalescing.md)).

`mutate` is the write door for the document model, not for everything in the file.
`host.parts.write` sends its own `writePagedPart` message and throws on failure
(`packages/plugin-sdk/src/host-impl.ts:2674-2708`). `host.nativeDocument.open` replaces the
active document through a backend the editor injects
(`packages/plugin-sdk/src/host-impl.ts:2755-2764`).

The raw handle bypasses the door. `host.editor` is the "marked escape hatch"
(`packages/plugin-api/src/host.ts:1673-1679`); a bundle holding it can call the client
without the capability check or the metadata-key check.

Two texts are out of date: `DESIGN.md:144-146` says v0 "enforces namespace only", while
`mutate` also enforces the `write` capability; and the comment at
`packages/plugin-sdk/src/host-impl.ts:1729-1735` still names protocol 51 and a pending
re-sync for a wire that is now stamped 0.64.0.

## Related

- [ADR 012](012-k1-modal-session-undo-coalescing.md), [ADR 010](010-raw-mutate-gate-capability-enforcement.md) — the modal-session exception; the gate at this door and its limit
- [ADR 302](302-vendored-wire-types.md), [ADR 305](305-doors-always-present.md) — where `Mutation` comes from; results instead of throws elsewhere
- [ADR 110](https://github.com/paged-media/core/blob/main/docs/adr/110-one-undo-timeline.md), [ADR 116](https://github.com/paged-media/core/blob/main/docs/adr/116-mutations-lowered-onto-operations.md) — the engine's single undo timeline and how a mutation becomes invertible

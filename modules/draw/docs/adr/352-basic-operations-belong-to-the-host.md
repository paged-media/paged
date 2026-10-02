# ADR 352 — Basic object operations belong to the host

- **Status:** Accepted. Recorded retroactively on 2026-10-02 from the code at `0d12bf8`.
- **Scope:** `packages/draw-bundle` (tools, commands, binding provider, edit context, manifest)

## Context

paged.draw at first contributed a Pen tool, group commands and a Layers panel of its own (see
Alternatives). The code names what was wrong with two of them.

- Group commands: `packages/draw-bundle/src/commands/group.ts:22-25` says the three commands were
  paged.draw's, so that a "user without the vector plugin loaded could not group", although
  `createGroup` and `dissolveGroup` were engine wire ops all along.
- Layers: `packages/draw-bundle/src/activate.ts:200-204` says the bundle's panel carried its own
  copy of the seven `layer*` ops, and that the result was the panel
  "existing three times across two repos".

For the Pen, the code and the commit that removed it (`fb63e14`) state the division of labour
but not the reason for it. The repository does not record why.

## Decision

A basic object operation is the host's; the bundle contributes only what sits above it. The
bundle gave a capability back three times.

1. **Pen** (2026-06-06, `fb63e14`). The tool that authors a new path with the pen gesture is an
   editor built-in. The bundle's pen handler was deleted; the bundle contributes Add, Delete and
   Convert anchor tools into the same rail slot (`group: "pen"`).
2. **Group, Ungroup, Select parent group** (2026-08-05, `4ab9ee8`). The three commands were
   deleted and are host commands (`paged.object.group`, `paged.object.ungroup`,
   `paged.object.selectParentGroup`). The bundle keeps what its own features compose inside
   larger batches: the builders `groupMutationFor` and `ungroupMutationFor`, and the tree walk
   `parentGroupOf`.
3. **Layers** (2026-08-05, `2339bce`). The React Layers panel was deleted. The bundle registers
   a binding provider for its `vectorGraphic` edit context instead. While that context is active,
   the provider serves the host's one Layers panel with the object stack of the entered path, in
   the engine's own row shape for layers. It is registered only when the host has the door and
   reports `bindings.provider@1`.

Tests assert that the retired Layers panel and group commands are absent.

## Evidence

- `packages/draw-bundle/src/tools.ts:21-23`, `:121-155` — the Pen is built in; three anchor tools
  with `group: "pen"`
- `packages/draw-bundle/src/commands/group.ts:22-37`, `:72-79`;
  `packages/draw-bundle/src/commands/parentage.ts:22-29` — no commands contributed; what stays
- `packages/draw-bundle/src/activate.ts:197-216`, `:348-353`, `:515-535` — the Layers panel is
  gone; no group commands; the edit context, then the provider
- `packages/draw-bundle/src/binding-provider/layers-provider.ts:32-43` — what the provider serves
- `packages/draw-bundle/src/binding-provider/adr023-seam.ts:104-115` — the two-part probe
- `packages/draw-bundle/test/activate.spec.ts:184-189`, `:340-345`;
  `packages/draw-bundle/test/headless-conformance.spec.ts:153-156`, `:191-197` — absence asserted
- `editor: apps/canvas/src/object-commands.ts:82-85`,
  `editor: packages/tools/src/built-in-tools.ts:172-188` — the host commands; the built-in Pen

## Alternatives considered

Each earlier state is in the history: a bundle Pen (`packages/draw-bundle/src/handlers/pen.ts`,
added in `9123152`, removed in `fb63e14`); bundle group commands (added in `49ac0f8`, removed in
`4ab9ee8`); a bundle Layers panel (added in `efe17df`, removed in `2339bce`). The provider's
header also rejects serving the document's own layers through the provider: the host panel would
show the same content whether paged.draw was active or not
(`packages/draw-bundle/src/binding-provider/layers-provider.ts:22-30`).

## Consequences

The editor has to ship the Pen, the `paged.object.*` commands and the one Layers panel; grouping
no longer depends on this plugin. `CLAUDE.md:195-196` forbids adding a plugin-side Group command
again. The shell owns the edit-context stack, its chrome and the write scope; the bundle declares
the claim and its tool and panel sets (`packages/draw-bundle/src/edit-context.ts:31-33`).
The division is not complete, and some files lag behind it:

- While the provider is active the host panel cannot rename a row or change its printable flag,
  because the provider does not declare those paths
  (`packages/draw-bundle/src/binding-provider/layers-provider.ts:45-54`).
- The bundle still contributes tools that author new paths (Curvature and Pencil,
  `packages/draw-bundle/src/tools.ts:156-157`), and a Pencil exists on both sides
  (`packages/draw-bundle/manifest.json:38`; `editor: packages/tools/src/built-in-tools.ts:190`).
  The repository does not record why.
- `PenMachine` stays in `draw-tools` with no consumer except its own test, and
  `panels/layers.panel.json` stays in the repo root as a prototype of the retired panel.
- `packages/draw-bundle/src/binding-provider/adr023-seam.ts:20-45` still describes local mirrors
  and casts toward an unpublished contract; the code below imports the published types.

## Related

- [ADR 023](https://github.com/paged-media/editor/blob/main/docs/adr/023-shared-panels-binding-providers.md), [ADR 024](https://github.com/paged-media/editor/blob/main/docs/adr/024-context-sensitivity-is-a-core-concept.md) — the host owns the panel; edit contexts
- [ADR 208](https://github.com/paged-media/editor/blob/main/docs/adr/208-tools-are-data-plus-gesture-handler.md), [ADR 209](https://github.com/paged-media/editor/blob/main/docs/adr/209-command-is-the-action-primitive.md), [ADR 305](https://github.com/paged-media/plugin-sdk/blob/main/docs/adr/305-doors-always-present.md) — host tools and commands; probing a door with `supports()`
- [ADR 350](350-three-typescript-layers.md), [ADR 351](351-shapes-are-native-page-items.md) — the layers of this repo; what the bundle writes

# ADR 350 — Three TypeScript layers: geometry, host-agnostic tool machines, host-bound bundle

- **Status:** Accepted. Recorded retroactively on 2026-10-02 from the code at `0d12bf8`.
- **Scope:** `packages/draw-geometry`, `packages/draw-tools`, `packages/draw-bundle`,
  `scripts/check-contract-imports.mjs`

## Context

The repo was scaffolded on 2026-06-06 as three workspace packages (commit `a0367d6`). Its message
says the path simplifier was lifted "from the editor's pencil handler".

The pen machine's header gives the reasons for keeping tool logic free of host state: the
modifier matrix lives in the machine so that it is "unit-testable without a browser" and can move
to an isolated realm unchanged (`packages/draw-tools/src/pen-machine.ts:24-26`). `CLAUDE.md:438-440`
states the rule: if a machine seems to need host state, an event or option is missing on its API.

A plugin must not import editor internals; the commit that added the import lint (`4fc102a`)
says "lint IS the no-private-backdoors guarantee". The host's panel schema binds scalar values
and has no expression language (`packages/draw-bundle/src/commands/dash.ts:23-25`,
`packages/draw-bundle/src/panels/stroke-panel.ts:53-55`), so a rule for the UI form was needed.

## Decision

The TypeScript code was cut into three packages with one direction of dependency:
`draw-geometry` ← `draw-tools` ← `draw-bundle`.

- `draw-geometry` is path math. It has no runtime dependency and no non-relative import.
- `draw-tools` holds tool state machines and planners: events with page-local points (pt) in,
  snapshots, plans and commits out. Tolerances arrive as options in pt. Its source imports only
  `draw-geometry` and, with `import type`, `@paged-media/plugin-api`.
- `draw-bundle` is the only package that receives a `BundleHost`. A gesture handler is a factory
  closed over `host`: it feeds pointer events to a machine, shows the snapshot with
  `host.overlay.setToolPreview`, and turns the plan or commit into a `Mutation` sent through
  `host.document.mutate`.

Two checks hold the boundary. `scripts/check-contract-imports.mjs` runs first in the root `test`
script and fails on a static `import … from` or `export … from` in `packages/*/src` whose specifier
is non-relative and outside `@paged-media/plugin-api`, `@paged-media/plugin-sdk`,
`@paged-media/draw-` and `react`. `packages/draw-tools/src/wire-compat.ts` asserts at type level
that machine output is assignable to the engine wire types.

Inside the bundle the UI form follows the shape of the value. Scalar properties go in two schema
panels (stroke, fill) that are data only; their gates are booleans the bundle computes and
publishes with `host.bindings.publish`. Vector-valued and multi-mutation edits (dash arrays,
gradient assignment) are commands. Lists of named records with per-row actions are eight React
panels registered with `host.contribute.panel`.

## Evidence

- `packages/draw-geometry/package.json:1-24`, `packages/draw-tools/package.json:17-20` — no
  `dependencies` block in the first; exactly `draw-geometry` and `plugin-api` in the second
- `packages/draw-tools/src/index.ts:19-20` — "host-agnostic tool state machines." and
  "Events in (page-local pt), intents/previews/commits out."
- `packages/draw-tools/src/wire-compat.ts:26-44` — the type-only import, two `Assert` aliases
- `packages/draw-bundle/src/handlers/anchors.ts:62-113`, `:126-162` — plan to `Mutation`
  (`mutationFor`); the handler factory, its px tolerance converted by `host.viewport.pxToPt`;
  `packages/draw-bundle/src/handlers/pencil.ts:57-73` — machine, preview and `mutate` in one shim
- `scripts/check-contract-imports.mjs:21-34`, `:51-61`; `package.json:11` — allow-list, walk, wiring
- `packages/draw-bundle/src/activate.ts:193-196`, `:220-222`, `:343-347` — two schema panels with
  binding drivers; why a list is a React panel; dash presets as commands;
  `packages/draw-bundle/src/panels/stroke-panel.ts:25-35` — pure data, gates are published bindings

## Alternatives considered

Tool logic inside the editor's gesture handlers is the earlier state named in `a0367d6`. A
conditional language in the panel schema is refused in the code ("NOT the rejected `visibleWhen`",
`packages/draw-bundle/src/panels/stroke-panel.ts:34`); the general rule is ADR 312.

## Consequences

A new tool is a machine in `draw-tools` with vitest cases plus a shim in `draw-bundle`. The
editor's built-in Pen and Pencil import the same geometry through the published
`@paged-media/draw/geometry` entry (`editor: packages/tools/src/handlers/pen-tool.ts:64`,
`editor: packages/tools/src/handlers/pencil-tool.ts:48`); `draw-tools` has no published entry
(`packages/draw-bundle/package.json:9-13`). Limits and contradictions at this commit:

- Four handlers import nothing from `draw-tools`: `packages/draw-bundle/src/handlers/lasso.ts`,
  `packages/draw-bundle/src/handlers/gradient-annotator.ts`,
  `packages/draw-bundle/src/handlers/text-on-path.ts` and
  `packages/draw-bundle/src/handlers/eyedropper.ts`. `PenMachine` is used only by its own test
  ([ADR 352](352-basic-operations-belong-to-the-host.md)).
- One read goes past the facades: `packages/draw-bundle/src/handlers/measure.ts:168-173` calls
  `host.editor.client.send`, marked there as an escape hatch.
- The lint has one allow-list for all three packages, so it alone does not keep React out of
  `draw-tools` (`scripts/check-contract-imports.mjs:29-32`), and it does not see dynamic `import()`
  (`:48`): `packages/draw-bundle/src/trace-engine.ts:262-264` loads three `node:` modules that way.
  No file in `.github/workflows` runs it.
- `README.md:8-34` and `CLAUDE.md:13-15`, `:455` still describe a `link:` install chain and an
  editor that wraps the machines. `panels/*.panel.json` are prototypes; no code loads them.

## Related

- [ADR 352](352-basic-operations-belong-to-the-host.md), [ADR 353](353-path-algebra-runs-in-the-engine.md) — what is left to the host and to the engine
- [ADR 315](https://github.com/paged-media/plugin-sdk/blob/main/docs/adr/315-isolation-contract.md), [ADR 312](https://github.com/paged-media/plugin-sdk/blob/main/docs/adr/312-panels-as-data.md) — the contract-only rule; panels as data
- [ADR 314](https://github.com/paged-media/plugin-sdk/blob/main/docs/adr/314-plugin-shape.md), [ADR 307](https://github.com/paged-media/plugin-sdk/blob/main/docs/adr/307-contract-as-peer-dependency.md), [ADR 208](https://github.com/paged-media/editor/blob/main/docs/adr/208-tools-are-data-plus-gesture-handler.md) — one published package; the contract as a peer; the host's tool model

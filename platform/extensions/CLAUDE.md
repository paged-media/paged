# CLAUDE.md

Orientation for Claude sessions in **paged-media/sdk** — the plugin
contract + tooling workspace. Private for now; `plugin-api` is destined to
become public at API-v1 freeze.

## What this is

pnpm workspace with three packages (see README for the tier table):
`packages/plugin-api` (the contract, **type-only**), `packages/plugin-sdk`
(the runtime: in-process `BundleHost` adapter, loader, gesture kit),
`packages/plugin-cli` (zero-dep ESM CLI, no build step). **`DESIGN.md` is
the deliberation record** — when code and DESIGN.md disagree, fix one of
them in the same change.

## Hard rules

- **`plugin-api` is type-only.** Every export is `export type`. A value
  export would drag host code (React, the wasm loader) into bundle module
  graphs and break host-free unit testing in plugin repos. Values reach
  bundles via `BundleHost` at activation.
- **No speculative surface.** A type joins the façade when a real bundle
  (paged.draw first) needs it. Gaps are recorded in
  `plugin-draw/BREAKAGE_LOG.md`, not pre-emptively "fixed" here.
- **This package OWNS its types (since the M1.1(a) vendoring pass,
  2026-06-06):** hand-written editor-contract shapes in
  `plugin-api/src/editor.ts` (handles NARROW, contributions 1:1) and
  the engine wire types VENDORED in `src/wire.d.ts` — synced from the
  editor's generated tsify output via `scripts/sync-wire.mjs`
  (`--check` in CI). The EDITOR asserts compat through its dev link
  (`apps/canvas/src/plugin-api-compat.ts`) — widen a handle type only
  with API review. The workspace builds STANDALONE; sibling checkouts
  are a dev-time luxury.
- **Naming:** the plugin runtime is `@paged-media/plugin-sdk`;
  `@paged-media/sdk` is the core repo's WebGPU `ViewerSession` and must
  not be claimed here.
- **CLI stays dependency-free.** `paged-plugin.mjs` hand-mirrors
  `manifest.schema.json`; change them together.
- **The host adapter lives HERE, not in the editor.**
  `plugin-sdk/src/host-impl.ts` implements `BundleHost` as a pure
  function over `() => PagedEditor`; the editor's only job is one
  `loadBundle()` call per bundle. The isolate migration is a second
  implementation of the same interface (RPC proxy), never an editor
  refactor. Keep `HOST_FEATURES` in sync with what's actually
  implemented — `supports()` answers from it.
- **Reserved members throw `PluginApiNotImplemented`** with a pointer —
  visible seams, never fake-interactive (the brand honesty rule applied
  to API design).

## Commands

```bash
pnpm install && pnpm -r typecheck
node packages/plugin-cli/bin/paged-plugin.mjs validate <manifest.json>
```

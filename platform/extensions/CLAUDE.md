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
- **Source-of-truth direction (incubation):** editor → this façade →
  plugin repos. `plugin-api` re-exports from `@paged-media/shell` /
  `@paged-media/client` via pnpm `link:` deps into the sibling
  `~/paged/editor` checkout (which must be `pnpm install`ed first). Do not
  hand-copy type declarations — re-export. The direction flips at v1
  freeze (façade becomes the contract; Decision B publishing starts).
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

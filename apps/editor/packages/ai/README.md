# @paged-media/ai — vendored copy

This directory is a **temporary copy** of `@paged-media/ai`, whose home is
[`platform/extensions/packages/ai`](../../../../platform/extensions/packages/ai) in this
repository (formerly paged-media/plugin-sdk; ADR 325 there; ADR 221 here). It is vendored because the package's first npm
publish has not happened yet, and the editor must build from its own repository.

- Source: plugin-sdk `df58d0e`, `packages/ai/src/*.ts`, byte for byte, except
  `engine-catalog.ts`, which imports `./catalog.json` (plugin-api's vendored
  catalog, synced from `@paged-media/canvas-wasm@0.71.2` — the engine this
  editor pins) instead of reaching into a sibling package.
- Licence: AGPL-3.0-only OR PMEL, as upstream (the file headers say so).
- **Do not edit here.** Change plugin-sdk, then re-copy.
- Package name: `@paged-media/ai-vendored`. The root Bun workspace cannot hold
  two packages named `@paged-media/ai`, so this copy is renamed, and
  `packages/shell` and `apps/canvas` depend on it by path
  (`"@paged-media/ai": "file:../ai"` and `"file:../../packages/ai"`), which
  links this directory under the import name `@paged-media/ai`.

## Removing it

Once `@paged-media/ai` is on npm:

1. delete `packages/ai/`;
2. in `packages/shell/package.json` and `apps/canvas/package.json`, replace
   the `"@paged-media/ai": "file:…"` dependency with the published version (or
   `workspace:*`, the in-tree `platform/extensions/packages/ai`);
3. `bun install` at the repository root, then the editor checks.

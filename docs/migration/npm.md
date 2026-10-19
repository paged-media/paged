# npm: 25 packages → 4

The decision is [PM-0008](../adr/PM-0008-npm-packages-and-release.md). This page is the
inventory it acts on (taken from the registry on 2026-10-18) and the exact commands for the
package owner.

## On npm today

| Package | Versions | dist-tags | After the migration |
|---|---|---|---|
| `@paged-media/idml-viewer` | 54 | latest 0.73.4, canary 0.1.0-canary.0 | **public**, absorbs `sdk` as `/session` |
| `@paged-media/canvas-wasm` | 54 | latest 0.73.4 | **public**, absorbs `introspect-wasm` (`./introspect`) and `repo-wasm` (`./repo`) |
| `@paged-media/plugin-api` | 60 | latest **0.2.8-canary.0** (June), canary 0.2.63-canary.0 | **public**, type-only |
| `@paged-media/plugin-sdk` | 61 | latest **0.2.8-canary.0** (June), canary 0.2.63-canary.0 | **public**, absorbs `plugin-cli` (`paged-plugin` bin) |
| `@paged-media/sdk` | 54 | latest 0.73.4, canary 0.1.0-canary.0 | deprecate → `@paged-media/idml-viewer/session` |
| `@paged-media/introspect-wasm` | 54 | latest 0.73.4 | deprecate → `@paged-media/canvas-wasm/introspect` |
| `@paged-media/plugin-cli` | 7 | latest 0.1.2-canary.0, canary 0.1.6 | deprecate → the `paged-plugin` bin of `@paged-media/plugin-sdk` |
| `@paged-media/data`, `draw`, `image`, `pdf`, `publish`, `sheet`, `web` | 1–22 each | | deprecate: built into the editor |
| `@paged-media/data-bundle`, `draw-bundle`, `image-glue`, `sheet-bundle`, `web-bundle` | | | deprecate: earlier names of the bundles |
| `@paged-media/data-host-model`, `draw-geometry`, `draw-tools`, `image-manifest`, `sheet-host-model`, `web-model` | 1 each | | deprecate: internal packages |

`@paged-media/repo-wasm` 0.74.0 was never published. `doc`, `slide`, `client`, `ai` and `cli`
were never on npm, and stay private workspace packages.

## In the repository (wave D, 2026-10-18)

- `@paged-media/canvas-wasm` carries the canvas at its root and the `./introspect` (with
  `./introspect/catalog.json`) and `./repo` entries; `engine/core/packages/{introspect-wasm,repo-wasm,sdk}`
  are deleted. `@paged-media/idml-viewer` carries the session as `./session`, built into
  `engine/core/web/idml-viewer/wasm/`.
- `@paged-media/plugin-sdk` ships the `paged-plugin` bin; `platform/extensions/packages/plugin-cli`
  is deleted. `plugin-api`'s relative imports name `.js`, so the contract resolves under
  `nodenext`.
- Every other workspace package is `private: true` with no `publishConfig`.
- `.github/workflows/release.yml` is the only workflow that publishes; `core-publish-wasm.yml`,
  `extensions-publish.yml`, `editor-playground.yml` (now its `deploy` job) and the eight module
  `*-publish.yml` are deleted.
- The four packages, packed at a test version and installed in a clean room (`tooling/release/`),
  install, import and typecheck under Node (npm) and Bun, with `nodenext` and `bundler`.

## For the package owner

The steps, in order (trusted publishers, the first tag, the token, the dist-tags, the
deprecations) and the changes the consumers outside this repository need are in
[the npm release runbook](npm-release-runbook.md).

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

## For the package owner (npm account `dietz`)

Run from any directory with `npm whoami` printing `dietz`. Deprecating keeps every version
installable; it only shows the message.

```sh
moved="Built into the paged editor; no longer published separately. Source: https://github.com/paged-media/paged"
for p in data draw image pdf publish sheet web \
         data-bundle draw-bundle image-glue sheet-bundle web-bundle \
         data-host-model draw-geometry draw-tools image-manifest sheet-host-model web-model; do
  npm deprecate "@paged-media/$p" "$moved"
done
npm deprecate @paged-media/sdk "Use @paged-media/idml-viewer/session (same API). Source: https://github.com/paged-media/paged"
npm deprecate @paged-media/introspect-wasm "Use @paged-media/canvas-wasm/introspect. Source: https://github.com/paged-media/paged"
npm deprecate @paged-media/plugin-cli "Use the paged-plugin bin of @paged-media/plugin-sdk. Source: https://github.com/paged-media/paged"
```

After the first release from this repository:

```sh
# plugin-api and plugin-sdk still serve June's 0.2.8-canary.0 as latest.
npm dist-tag add @paged-media/plugin-api@<released version> latest
npm dist-tag add @paged-media/plugin-sdk@<released version> latest
npm dist-tag rm @paged-media/plugin-api canary
npm dist-tag rm @paged-media/plugin-sdk canary
npm dist-tag rm @paged-media/idml-viewer canary
```

Trusted publishing: for each of the four public packages, add a trusted publisher on npmjs.com
(package → Settings → Trusted publishing) for repository `paged-media/paged`, workflow
`release.yml`. Once the first OIDC publish succeeds, delete the `NPM_TOKEN` secret.

# One root Bun workspace (migration step B1)

The JavaScript side of this repository was ten pnpm workspaces, each with its
own `pnpm-workspace.yaml` and `pnpm-lock.yaml` (`apps/editor` on pnpm 9.0.0;
`platform/extensions` and `modules/{data,doc,draw,image,publish,sheet,slide,web}`
on pnpm 10), plus `engine/core/web/idml-viewer`, which installed with npm and had
no lockfile. This step makes them one Bun workspace at the repository root, with
the same resolution, so behaviour stays the same. The first-party packages still
consume each other as published canaries at their exact pins; switching those to
`workspace:*` is step B3.

| Was | Is now |
| --- | --- |
| 10 × `pnpm-workspace.yaml` + `pnpm-lock.yaml`, npm for the viewer | `/package.json` `workspaces`, one text `/bun.lock`, `/bunfig.toml` |
| `pnpm install --frozen-lockfile` in each component | `bun install --frozen-lockfile` once, at the root (from any directory) |
| `pnpm <script>`, `pnpm -r run X` | `bun run <script>`, `bun run --filter './packages/*' X` |
| `pnpm --filter P exec vitest` | `cd <P's directory> && bunx vitest` |
| `pnpm pack` | `node tooling/js/pack.mjs <dir> <dest>` (see Publishing) |
| `packageManager: pnpm@…` in apps/editor and modules/slide | `packageManager: bun@1.4.3` in `/package.json` only |

Bun 1.4.3 and Node 24.22.0 come from `/.prototools` (proto). Node stays for
what Bun does not run: Playwright's runner, wrangler, `npm publish`, and the
`node` commands inside package scripts (`bun run` runs scripts with the
binaries' own shebangs, so vitest and tsc run on Node as before).

## The workspace

`/package.json` lists every JavaScript package root:

```
apps/editor, apps/editor/apps/*, apps/editor/packages/*,
platform/extensions, platform/extensions/packages/*,
modules/*, modules/*/packages/*, modules/image/glue, modules/image/manifest,
engine/core/web/idml-viewer
```

All 40 tracked `package.json` files are members (41 with the root). Nothing is
excluded: there are no fixture or template manifests. Two directories match a
glob without having a `package.json` and are skipped by Bun: `modules/publish`
(its packages are under `packages/`; it never had a component manifest) and
`modules/web/packages/web-render` (a Cargo workspace).

`/bunfig.toml`:

- `linker = "isolated"`: every package gets a `node_modules` with exactly what
  it declares, linked into one store (`node_modules/.bun/`), as with pnpm. An
  undeclared import fails (gate b).
- `linkWorkspacePackages = false`: only a `workspace:` specifier links a
  workspace package. Bun's default links a workspace package whenever its
  version satisfies the range, and even an `npm:` alias does not escape that.
  Six of the editor's exact canary pins equal the version in the tree today
  (`@paged-media/draw@0.1.0-canary.20`, `image@0.1.0-canary.21`,
  `data@0.1.0-canary.17`, `sheet@0.1.0-canary.24`, `web@0.1.0-canary.18`,
  `slide@0.1.0-canary.1`), so without this setting the editor would have run
  the in-tree sources instead of the published packages (`src/*.ts` rather
  than the published `dist/`, and without the engine wasm where a module's is
  a gitignored build output). pnpm's default
  (`link-workspace-packages=false`) behaved like this.

### Translated pnpm settings

| pnpm | Bun |
| --- | --- |
| apps/editor `pnpm.overrides`: `esbuild@>=0.27.3 <0.28.1: ^0.28.1` | root `overrides`: `{"tsx": {"esbuild": "^0.28.1"}}`. Bun 1.4.3 supports both range-keyed and nested overrides; the nested form keeps the override where it applied (in the editor only tsx resolved esbuild in that range). As a root range key it would also move the modules' tsup from esbuild 0.27.7 to 0.28, which their pnpm locks never had. |
| apps/editor `pnpm.overrides`: `@paged-media/doc` / `@paged-media/slide` → `link:../../modules/<m>/packages/<m>-bundle` | apps/canvas depends on `"@paged-media/doc": "workspace:*"` and `"@paged-media/slide": "workspace:*"`: the same in-tree bundles. (Bun's `link:` means a package registered with `bun link`, not a path.) |
| `pnpm.onlyBuiltDependencies` | none existed. `bun pm untrusted` reports no blocked lifecycle scripts (esbuild's is in Bun's default trust list), so there is no `trustedDependencies`. |
| `workspace:*` between the editor's packages and the vendored `@paged-media/ai` | One workspace cannot hold two packages named `@paged-media/ai` (the install fails), and the vendored copy in apps/editor/packages/ai differs from platform/extensions/packages/ai (its `engine-catalog.ts`). It is renamed `@paged-media/ai-vendored`; packages/shell and apps/canvas depend on it by path (`"file:../ai"`, `"file:../../packages/ai"`), which links that directory under the import name `@paged-media/ai`. A `workspace:@paged-media/ai-vendored@*` alias does not work: Bun resolves an alias whose name is another workspace member's to that member. platform/extensions/packages/cli keeps `workspace:*` and gets the platform package. |

## Resolution

`bun.lock` was not resolved from scratch. A fresh resolution picked newer
versions inside the ranges (39 direct dependencies differed, e.g. the editor's
Radix packages 1.1 → 1.3, vite 6.4.3 → 6.4.4, @playwright/test 1.63.0 →
1.64.1). Instead the ten pnpm locks were merged into one root `pnpm-lock.yaml`
(snapshot links re-rooted, importer specifiers taken from the new manifests)
and `bun install` migrated it. The result, compared with the union of the ten
pnpm locks:

- 655 package versions, every one of them a version the pnpm locks had; none
  is new.
- 30 versions of the pnpm locks are gone, all cross-component duplicates Bun
  deduplicated to a version another component already used: rollup 4.64.0 and
  its 25 platform packages, acorn 8.17.0 and 8.19.0,
  @jridgewell/sourcemap-codec 1.5.5, jszip 3.10.1.
- Direct dependencies of 286 importer edges: 280 resolve as before. The six
  that moved: postcss 8.5.28 → 8.5.29 (apps/canvas, apps/devtools,
  packages/shell; another component had 8.5.29), jszip 3.10.1 → 3.10.2
  (pdf-bundle), @types/node 20.19.43 → 20.19.39 (doc-bundle, slide-bundle: the
  catalog, below).
- esbuild resolves as before: 0.28.2 under tsx (the override), 0.25.12 under
  vite 6, 0.27.7 under tsup, 0.21.5 under vitest 2's vite 5.

### Catalog

`workspaces.catalog` holds the most common version of each listed dependency;
two named catalogs keep the cross-major outliers on their major, so no package
changes a major version.

| Dependency | `catalog:` | Named catalog | Specifier changes |
| --- | --- | --- | --- |
| react, react-dom | `^18.3.1` | | none |
| @types/react | `^18.3.31` | | none |
| @types/react-dom | `^18.3.7` | | none |
| vite | `^6.4.3` | | none |
| typescript | `^5.9.3` | | modules/publish/packages/pdf-bundle and publish-bundle `^5.6.3` → `^5.9.3`; engine/core/web/idml-viewer `^5.6.0` → `^5.9.3` (all three resolved 5.9.3 before and after) |
| vitest | `^2.1.9` | `vitest3`: `^3.2.7` (pdf-bundle, publish-bundle, idml-viewer) | idml-viewer `^3.0.0` → `^3.2.7` |
| @types/node | `20.19.39` | `node25`: `^25.9.6` (apps/canvas, apps/devtools) | doc-bundle and slide-bundle `^20.19.43` → `20.19.39` (resolved 20.19.43 → 20.19.39) |

Peer ranges (`react: ^18.3.0`, the plugin contract `>=…`) stay ranges.

### Hoisting: the headless engine

Bun's isolated linker, like pnpm's, also links every store package into one
hidden directory (`node_modules/.bun/node_modules`, pnpm's
`node_modules/.pnpm/node_modules`), which is where a package's own undeclared
requires end up. plugin-sdk's `createHeadlessHost` resolves
`@paged-media/canvas-wasm` from `resolveFrom` and otherwise from its own
install location, which falls through to that directory. Per component, pnpm's
held the one canvas-wasm the component pins (0.71.1 in doc, image, publish,
slide and web); the root store holds five versions and exposes 0.73.4 there.
The specs of those five modules that called `createHeadlessHost()` without an
anchor silently ran engine 0.73.4; web's fonts-door specs failed on it (3
tests). They now pass the test directory as `resolveFrom`, so they resolve the
package's own devDependency, as draw, data and sheet already did; the counts
are the baseline's again (gate c).

## Publishing

`pnpm pack` did more than pack: it moved `publishConfig`'s manifest fields
(`main`, `types`, `exports`, …: the repository points them at `src/*.ts`, the
published package at `dist/`) to the top level, dropped the prepublish-only
scripts, copied the workspace root's LICENSE files into a package that has
none, and replaced `workspace:` specifiers. `bun pm pack` only does the last
(and `catalog:`). `tooling/js/pack.mjs` does the rest first and restores
`package.json` afterwards. Checked against `pnpm pack` tarballs made on the
parent commit for draw, image, plugin-sdk and cli: the same files and the same
manifest (`dist/` aside, which the parent commit had built and the check did
not). The publish workflows still upload with `npm publish <tgz>` for OIDC.

`doc-publish` and `slide-publish` published the package directory with `npm
publish`, which never applied their `publishConfig`; they now publish the
packed tarball like the other bundles. `core-publish-wasm` publishes the
viewer's tarball (its devDependencies are `catalog:` now) and writes the token
userconfig that `setup-node`'s `registry-url` used to write.

## CI

Every job that ran `pnpm/action-setup` + `actions/setup-node` now runs
`moonrepo/setup-toolchain@v0.6.4` (proto 0.63.1, Bun and Node from
`/.prototools`, as `moon.yml` already did) and `bun install --frozen-lockfile`
once, at the root. Where `setup-node` cached the pnpm store, `actions/cache`
keeps `~/.bun/install/cache` keyed on `bun.lock`. These jobs move from Node
20/22 to 24.22.0. `pnpm -r --no-bail exec vitest run <flags>` became each
package's `test` script with the flags (`bun run --filter` runs every match and
fails if any failed); `pnpm exec` became `bunx --no-install`. The
`plugin-*-from-source` actions no longer install their module; the callers
install the root first.
JS workflows with path filters also trigger on `bun.lock`, `bunfig.toml` and
`/package.json`. `actionlint` reports only the existing core-gpu SC2012.

## Moon

`.moon/toolchains.yml` sets `javascript.packageManager: bun` and configures the
`bun` toolchain (version from `.prototools`, `--frozen-lockfile`); the sync
settings stay off. JS tasks run `bun run …`. The editor's pnpm 9 override and
the viewer's npm install task are gone. modules/publish names its JS
toolchains (`javascript`, `bun`, `node`): with neither a `package.json` nor a
lockfile in its root, Moon no longer detects them. `moon query projects` lists
the 14 projects; a `moon run doc:js-lint core-idml-viewer:js-test
publish:js-check` installs the root once and leaves `git status` unchanged.

## Gate

Measured on this machine (macOS, arm64) while Rust builds ran in parallel
(load averages 20–100), so wall times are noisy. The parent commit ran in a
temporary worktree (`paged-b1-base`), the branch in a fresh checkout of its
tip (`paged-b1-gate`); both were removed afterwards.

### (a) Clean install

Exit 0 in every round. Old: the ten per-component `pnpm install
--frozen-lockfile` (pnpm 10.28.0; the editor's pnpm 9.0.0 through corepack)
plus the viewer's `npm install`, summed. New: one `bun install
--frozen-lockfile` at the root. The rounds alternate old/new so both see the
same load; each starts with every `node_modules` removed. Warm uses the
machine's pnpm store, npm cache and Bun cache; cold uses empty scratch
store/cache directories (the real ones untouched).

| Round | Old (s) | New (s) | Load average (1 min), old / new |
| --- | --- | --- | --- |
| warm 1 | 32.36 | 8.21 | 98 / 90 |
| warm 2 | 29.50 | 13.56 | 73 / 70 |
| warm 3 | 25.52 | 8.80 | 61 / 52 |
| **warm, median** | **29.50** | **8.80** | |
| cold | 149.33 | 55.98 | 28 / 23 |

Earlier single runs on the same machine: the old installs at the start of the
work (lower load) took 36.48 s and then 14.74 s warm (pnpm 19.04 s and 12.09 s
of that, the viewer's npm 17.44 s and 2.65 s); the first install of a fresh
branch checkout took 75.48 s under load 48 with the cache warm, then 5.37 s,
and 58.72 s cold. The cold rounds show what one workspace saves: pnpm 9 cannot
reuse pnpm 10's store, so the editor alone downloaded its 356 packages again
(58.9 s). Bun's cache is larger than pnpm's store (700 MB vs 285 MB here).
The fresh checkout's `git status` was empty after the install and after the
test pass.

### (b) An undeclared import fails

Scratch file `modules/draw/packages/draw-geometry/src/__undeclared_probe.ts`
importing `react` and `vite` (draw-geometry declares neither; both are
installed for other packages), then removed:

- `tsc --noEmit -p tsconfig.json`: exit 2, `TS2307: Cannot find module 'react'`
  and `… 'vite'`.
- `node -e 'await import("react")'` in that package: `ERR_MODULE_NOT_FOUND`.
- `bun -e 'require("vite")'`: `Cannot find package 'vite'`.
- In draw-bundle, which declares react, the same import resolves.

### (c) Typecheck and tests, before → after

The same commands per component (pnpm on the parent commit, 9.0.0 in
apps/editor and 10.28.0 elsewhere; Bun on the branch; for example `pnpm run test` → `bun run test`, `pnpm -r --filter './packages/*'
run test` → `bun run --filter './packages/*' test`). Exit codes and vitest /
node:test summaries are identical everywhere; only the idml-viewer typecheck,
which fails before and after, reports fewer errors (5 → 2, see the notes). The
failures are the baseline's, caused by build outputs a clean checkout does not
have (gitignored wasm and DuckDB artifacts, a committed image wasm whose
`SOURCE_HASH` predates the current sources, the viewer's missing
`@types/node`).

| Component | Command (before → after) | Exit | Summary (identical before and after unless noted) |
| --- | --- | --- | --- |
| modules/data | `pnpm run typecheck` → `bun run typecheck` | 0 → 0 | — |
| modules/data | `pnpm run test` → `bun run test` | 1 → 1 | data-bundle: files 1 failed \| 37 passed \| 23 skipped (61); tests 4 failed \| 246 passed \| 150 skipped (400)<br>data-host-model: files 7 passed (7); tests 53 passed (53) |
| modules/doc | `pnpm run typecheck` → `bun run typecheck` | 0 → 0 | — |
| modules/doc | `pnpm run test` → `bun run test` | 0 → 0 | doc-bundle: files 7 passed \| 2 skipped (9); tests 29 passed \| 12 skipped (41)<br>doc-host-model: files 5 passed (5); tests 44 passed (44) |
| modules/draw | `pnpm run typecheck` → `bun run typecheck` | 0 → 0 | — |
| modules/draw | `pnpm run test` → `bun run test` | 0 → 0 | draw-bundle: files 98 passed \| 2 skipped (100); tests 1650 passed \| 34 skipped (1684)<br>draw-geometry: files 41 passed (41); tests 681 passed (681)<br>draw-tools: files 19 passed (19); tests 337 passed (337) |
| modules/image | `pnpm run typecheck` → `bun run typecheck` | 0 → 0 | — |
| modules/image | `pnpm run test` → `bun run test` | 1 → 1 | glue: files 1 failed \| 39 passed \| 1 skipped (41); tests 1 failed \| 349 passed \| 3 skipped (353) |
| modules/sheet | `pnpm run typecheck` → `bun run typecheck` | 2 → 2 | sheet-bundle: TS errors: 1 |
| modules/sheet | `pnpm run test` → `bun run test` | 0 → 0 | sheet-bundle: files 27 passed \| 14 skipped (41); tests 215 passed \| 134 skipped (349)<br>sheet-host-model: files 14 passed (14); tests 193 passed (193) |
| modules/slide | `pnpm run typecheck` → `bun run typecheck` | 0 → 0 | — |
| modules/slide | `pnpm run test` → `bun run test` | 1 → 1 | slide-bundle: files 8 failed (8); tests 46 failed \| 13 passed (59) |
| modules/web | `pnpm run typecheck` → `bun run typecheck` | 0 → 0 | — |
| modules/web | `pnpm run test` → `bun run test` | 0 → 0 | web-bundle: files 34 passed \| 12 skipped (46); tests 253 passed \| 86 skipped (339)<br>web-conformance: files 2 passed (2); tests 98 passed \| 5 skipped (103)<br>web-model: files 16 passed \| 1 skipped (17); tests 290 passed \| 9 skipped (299) |
| modules/publish | `pnpm -r --filter './packages/*' run typecheck` → `bun run --filter './packages/*' typecheck` | 0 → 0 | — |
| modules/publish | `pnpm -r --filter './packages/*' run test` → `bun run --filter './packages/*' test` | 0 → 0 | pdf-bundle: files 3 passed (3); tests 26 passed (26)<br>publish-bundle: files 1 passed (1); tests 13 passed (13) |
| platform/extensions | `pnpm run typecheck` → `bun run typecheck` | 0 → 0 | — |
| platform/extensions | `pnpm -r run build` → `bun run --filter './packages/*' build` | 0 → 0 | — |
| platform/extensions | `pnpm run test` → `bun run test` | 0 → 0 | ai: files 4 passed (4); tests 31 passed (31)<br>cli: files 8 passed (8); tests 54 passed \| 1 skipped (55)<br>plugin-sdk: files 67 passed (67); tests 712 passed (712) |
| engine/core/web/idml-viewer | `npm run typecheck` → `bun run typecheck` | 2 → 2 | TS errors: 5 → 2 (see the notes) |
| engine/core/web/idml-viewer | `npm run test` → `bun run test` | 0 → 0 | files 3 passed (3); tests 27 passed (27) |
| apps/editor | `pnpm run typecheck` → `bun run typecheck` (apps/*) | 0 → 0 | — |
| apps/editor | `pnpm --filter ./apps/canvas run typecheck:tests` → `bun run --filter ./apps/canvas typecheck:tests` | 0 → 0 | — |
| apps/editor | `pnpm --filter ./apps/canvas run typecheck:showcase` → `bun run --filter ./apps/canvas typecheck:showcase` | 0 → 0 | — |
| apps/editor | `pnpm --filter ./apps/canvas run lint` → `bun run --filter ./apps/canvas lint` | 0 → 0 | — |
| apps/editor | `pnpm run lint` → `bun run lint` | 0 → 0 | — |
| apps/editor | `pnpm run lint:boundaries-selftest` → `bun run lint:boundaries-selftest` | 0 → 0 | — |
| apps/editor | `pnpm run test:boot-coi` → `bun run test:boot-coi` | 0 → 0 | node:test: 5 tests, 5 pass |
| apps/editor | `pnpm run test:network-policy` → `bun run test:network-policy` | 0 → 0 | node:test: 6 tests, 6 pass |
| apps/editor | `pnpm run test:modules` → `bun run test:modules` | 0 → 0 | node:test: 4 tests, 4 pass |
| apps/editor | `pnpm run test:spread-pages` → `bun run test:spread-pages` | 0 → 0 | node:test: 8 tests, 8 pass |
| apps/editor | `pnpm run test:thresholds` → `bun run test:thresholds` | 0 → 0 | — |
| apps/editor | `pnpm run test:wasm-budget` → `bun run test:wasm-budget` | 0 → 0 | — |
| apps/editor | `pnpm run test:surface-coverage` → `bun run test:surface-coverage` | 0 → 0 | — |
| apps/editor | `pnpm run test:seam-guard` → `bun run test:seam-guard` | 0 → 0 | — |
| apps/editor | `pnpm run test:applicability` → `bun run test:applicability` | 0 → 0 | — |
| apps/editor | `pnpm run test:solo-profiles` → `bun run test:solo-profiles` | 0 → 0 | — |
| apps/editor | `pnpm run test:feat-vocabulary` → `bun run test:feat-vocabulary` | 0 → 0 | — |
| apps/editor | `pnpm run test:client-catalog` → `bun run test:client-catalog` | 0 → 0 | — |

Not run here, as before: Playwright, the wasm builds, the Rust lanes.

## Notes and open points

- **A global Bun on PATH breaks Moon locally.** proto's Bun plugin puts Bun's
  globals directory `~/.bun/bin` on the PATH of Moon's commands. On a machine
  that also has Bun from the official installer there, Moon's `bun install`
  runs that Bun instead of 1.4.3 (here 1.3.14, which cannot read a v3
  `bun.lock`). Removing `~/.bun/bin/bun` (Bun itself comes from proto) fixes
  it; the gate's Moon run used a scratch `HOME` without `~/.bun` instead. CI
  is unaffected: proto installs Bun there and nothing else does.
- **`.protolock` after a first Moon run.** Moon 2.6.2 installs its own proto
  (0.62.2) and proto records it in `.protolock`; on the parent commit the same
  first run recorded pnpm 10.28.0. It is pre-existing and happens once per
  machine; afterwards Moon runs leave `git status` clean.
- **Peer warnings.** `bun install` warns that `>=0.2.44-canary.0` (the
  published pdf/publish canaries' plugin-api/plugin-sdk peers) has no matching
  version; under semver a prerelease range only admits prereleases of 0.2.44.
  The peers resolve to the editor's 0.2.62-canary.0, as with pnpm.
- **idml-viewer typecheck** still fails, now with 2 errors instead of 5 (it
  is not a CI gate; CI runs its vitest). The three `node:*` imports resolve now
  because vite's optional `@types/node` peer is satisfied in the root
  workspace; npm's standalone install had no `@types/node`.
- The module publish workflows are `workflow_dispatch`-only references until
  wave D, so their port is reviewed, not run.
- `pnpm` remains in ADRs, history and design documents, deliberately, and in
  about forty code comments and Playwright skip reasons (for example "run
  `pnpm --filter paged-canvas test:journeys:gpu`") that execute nothing; a
  wording sweep for those can ride on B3.

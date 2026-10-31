# ADR PM-0013 — A fourth public package: `@paged-media/editor`

- **Status:** Accepted 2026-10-23.
- **Amends:** [PM-0008](PM-0008-npm-packages-and-release.md) (three public packages since its
  amendment 3; four from here).
- **Scope:** `apps/editor/packages/editor`, `tooling/release/*`, `.github/workflows/release.yml`
  (the `npm` job), `.github/workflows/editor-tests.yml` (the package's build check),
  `engine/core/scripts/check-wasm-package-versions.mjs`.

## Context

The editor can be embedded: `createEditor(element, config)` mounts it into any element and
resolves to a handle (`apps/canvas/src/embed`, editor ADRs 277–279), and `connectEditor(iframe,
config)` drives one in a frame. Both exist only inside the editor application, which is a Vite
app over private workspace packages consumed as source: the shell, the client, the UI, the
tools, the catalog, the module bundles, the shared packages. Nothing a host can install carries
them. PM-0008 keeps every one of those packages private and forbids a public package to depend on
a private one, and its release scripts named exactly three public packages.

The engine is already on npm as `@paged-media/paged` (its wasm is 28 MiB). The editor runs it in a
worker, and it is useless without it.

## Decision

1. **`@paged-media/editor` is a fourth public package**, built from `apps/editor/packages/editor`,
   under `AGPL-3.0-only OR LicenseRef-PMEL` like the others.

   | Entry | What it is |
   |---|---|
   | `.` | `createEditor`, `mountEditor` and every public type. Small: the editor loads on the first call. |
   | `./iframe` | `connectEditor` and `BRIDGED_METHODS`: the host side of the frame bridge, no React, no engine. |
   | `./presets` | `PRESETS`, the preset profiles as data, for host-side tooling. |
   | `./style.css` | the editor's stylesheet, imported by the host. |
   | `./feature-ids.json`, `./theme-tokens.json` | the feature ids a profile names and the design tokens `setTheme` takes. |

2. **The package is a build target over the editor's sources, not a copy.** The embedding API stays
   in `apps/canvas/src/embed`; the package's build (`vite.config.lib.ts`) compiles it, with every
   private package it reaches **bundled**: the shell, UI, client, tools and catalog, the module
   bundles and the shared packages, and plugin-sdk, which hosts the bundles inside the editor (a
   copy the editor owns; no extension crosses this package's boundary). The React Compiler
   compiles the bundled code as it does the app's (`tooling/js/react-compiler.mjs`).

3. **The engine is a dependency, not a copy.** `@paged-media/editor` depends on
   `@paged-media/paged` at exactly its own version, so npm carries one copy of the engine and one
   version to keep in step. The worker bundles the engine's wasm-bindgen glue (generated with the
   wasm, so the two must match, which the exact version guarantees) and is told the wasm's URL in
   its first message (`worker.ts`, `engineWasm`). The package entry names it as
   `new URL("../../paged/paged_canvas_wasm_bg.wasm", import.meta.url)`: the dependency beside the
   package, where npm's flat tree and the isolated stores of pnpm and Bun all put it. A host's
   bundler copies it from there; `engineWasm` or `assetBase` overrides it.

4. **React and react-dom are peer dependencies, `>=19.3`**, as for extensions (PM-0008,
   amendment 2): the editor renders with the host's React.

5. **Files are found relative to the module that names them.** The build is an application build
   with script entries, not Vite's library mode, which inlines every asset as base64. Its output
   writes every file reference as `new URL("./file", import.meta.url)` and every worker as
   `new Worker(new URL("./file", import.meta.url), { type: "module" })`, the forms bundlers read,
   so a host that bundles the package (Vite, webpack 5, Rollup with an asset plugin) copies the
   chunks, workers, module wasm and fonts into its own output, and a host that serves the package
   as it is finds them beside the modules. `assetBase`, a URL where the host serves a copy of
   `dist/`, overrides the engine's wasm, the default faces, paged.data's `bin/` and the locales,
   for hosts whose bundler does not copy files.

6. **paged.data's engines are hosted, not shipped.** The data engine and DuckDB (36 MiB) come from
   the module host through the module door (editor ADRs 220 and 223), and only when a profile
   activates paged.data. The package ships the bundle's JavaScript, DuckDB's worker and its
   extensions in `dist/bin/`, found beside the data chunk or under `assetBase`. The release hosts
   the two engines (`scripts/host-modules.mjs`) before it publishes the package that names them.
   Every other bundle's wasm ships in `dist/assets/`: it is small enough, and a host without the
   module host still works.

7. **The public types are written out.** `src/types.ts` is the whole contract, and the published
   declarations import nothing but it and `@paged-media/paged`'s wire types, so no private package
   name reaches a host's type checker. `test/conformance.ts` checks at typecheck that the
   implementation's handle, config, events, presets and bridge fit those types, so the two cannot
   drift silently.

8. **The version is held to the protocol** like the engine's: `0.<protocol>.0-dev` in the tree
   (`check-wasm-package-versions.mjs`), the tag's version at release (`stage.mjs`).

9. **What stays private:** every package the editor bundles, the editor application itself
   (`paged-canvas`), and the local library (the repository wasm and its worker are left out of the
   package: an embedded editor runs with `library: false`).

## Release

`stage.mjs` packs four packages (the editor after `paged`, which it depends on), and
`verify-tarballs.mjs` checks the editor's tarball: dependencies exactly `@paged-media/paged` at the
release version, React a peer, and the package's own `scripts/check-dist.mjs` over the packed
`dist/` (no private `@paged-media/*` import, every named file present, workers in the bundler
form, no engine wasm, no paged.data engine, no source map, no path of the build machine, and the
size budget: 72 MiB for `dist/` (amendment 3), 16 KiB for the `.` entry and for `./iframe` with what it
imports). `consumer-test.sh` installs it with React in clean projects under npm and Bun,
imports `.` and `./iframe`, finds the engine's wasm where the package points, type-checks an
embedder under `nodenext` and `bundler` with TypeScript 7 and 5.9, and builds a host page with
Vite that must carry the engine's wasm from `@paged-media/paged`, the faces, the stylesheet and
the workers. `release.yml` builds the module wasm the editor compiles, builds the package, hosts
paged.data's engines, and publishes four packages. `editor-tests.yml` builds the package and runs
the same check on every change to the editor.

At `0.75.0-rc.1` (2026-10-23) the tarball was 17.5 MiB packed, 51.6 MiB unpacked, 758 files; the
largest are the module wasm (web 9.1 MB, doc 6.8 MB, pdfium 5.2 MB, image 3.5 MB, sheet 2.7 MB,
slide 1.7 MB).

## The first publish

npm takes a Trusted Publisher entry only for a package that exists, so the release that first
carries `@paged-media/editor` publishes it with a token, as PM-0008's amendment 3 did for `paged`
and `viewer` ([the runbook](../migration/npm-release-runbook.md), step 1a): the owner sets a
short-lived granular `NPM_TOKEN` (read and write on `@paged-media`), cuts the tag, and once the
package is on npm registers its Trusted Publisher on npmjs.com (organization `paged-media`,
repository `paged`, workflow `release.yml`, no environment), then deletes the secret and revokes
the token. The three existing packages keep publishing through OIDC in that run.

## Consequences

- A host embeds the editor with `npm i @paged-media/editor react react-dom`, an import of
  `style.css`, and a cross-origin isolated page (COOP `same-origin`, COEP `credentialless` or
  `require-corp`: the engine shares memory with its worker). A host that cannot isolate its page
  uses `./iframe`.
- A change to the embedding API changes `src/types.ts` in the same commit, or the editor's
  typecheck fails.
- The release now builds the module wasm and needs the module host's credentials in its `npm` job.
- A layout that does not put `@paged-media/paged` beside the package (npm nesting it under a
  conflicting version, Yarn Plug'n'Play) needs `engineWasm` or `assetBase`; `consumer-test.sh`
  checks the npm and Bun layouts.

## Amendment (2026-10-24): one data engine

paged.data's engine is one wasm (data ADR 561, [PM-0015](PM-0015-data-and-actions-are-platform-layers.md)):
there is no DuckDB, no worker and no extension directory in `dist/bin/`. The data engine is
still hosted, as item 6 says.

## Amendment 2 (2026-10-24): no degraded mode, and ids leave through a deprecation window

Two of the composable editor's open questions were decided on 2026-10-24
([concept §12](../../apps/editor/docs/composable-editor.md), items 1 and 2). Both are promises of
this package to its hosts.

### No degraded mode without cross-origin isolation

`createEditor` and `mountEditor` on a page that is not cross-origin isolated
(`crossOriginIsolated !== true`) load nothing, mount nothing and reject with an `EditorError`
whose `code` is `notCrossOriginIsolated`. Its message names both ways out: the page's own headers
(COOP `same-origin`, COEP `credentialless` or `require-corp`), and the iframe path
(`connectEditor` from `./iframe`, the editor's `embed.html` on its own deployment, which sends its
own headers; the host page sends COOP `same-origin` and COEP `credentialless`, which asks nothing
of the page's other resources, and the iframe allows `cross-origin-isolated`). `connectEditor`
rejects with the same code when the frame cannot be isolated. There is no single-threaded
fallback: the engine shares memory with its worker. `isEditorError(value)` tells the error apart
structurally, so it holds for one that crossed a frame. The check is in the editor
(`apps/canvas/src/embed/errors.ts`), and the package's entry runs it before it loads the editor.

### Ids leave through a deprecation window

`feature-ids.json` is the public list of the ids a profile and `handle.features` name (commands,
panels, tools, menus, keybindings, chrome). An id leaves it only through a deprecation:

1. **An alias for a window.** `apps/editor/apps/canvas/deprecated-ids.json` lists each old id with
   its replacement (or null when nothing replaces it), the release that deprecated it
   (`deprecatedIn`) and the first release without the alias (`removeIn`), at least two minor
   releases later. The package's `feature-ids.json` mirrors the list as `deprecated`.
2. **An old id keeps working.** The editor reads an old id in a host's profile (its feature
   switches, panels, regions and region edits, and its modes' slots) and in `handle.features` as
   its replacement; one with no replacement is ignored. It reports each old id once per editor:
   a console warning and an `idDeprecated` event on the handle, delivered to every listener, also
   for ids met before it subscribed.
3. **A guard holds it.** `apps/editor/scripts/feature-ids.mjs` treats the committed
   `feature-ids.json` as the ledger. Writing or checking it fails when an id disappears without a
   deprecation entry; when an entry is removed before its window ends; when an entry outlives its
   window (the tree's version, `0.<protocol>.0-dev`, names the release it builds, and that
   release is `removeIn` or later: the alias goes in the release `removeIn` names, no later);
   and when an old id is still live, a replacement is not, or a window is shorter than two minor
   releases. The release runs the same check against the tag's version
   (`--check --release <version>`).
4. **The release notes list them.** `bun apps/editor/scripts/feature-ids.mjs --release-notes`
   prints the deprecations as a Markdown table; a release's notes carry it, with the aliases that
   release removes ([the runbook](../migration/npm-release-runbook.md)). The package README says
   where a host finds them.

Presets are the editor's own and never name an old id (`profile-presets-guard.mjs`).

## Amendment 3 (2026-10-28): a 72 MiB budget for `dist/`

The budget for `dist/` goes from 64 to 72 MiB. Two features of 2026-10-28 grew the module wasm the
package carries: placing a PDF or Illustrator page as native vectors brings the engine's PDF
interpreter into the PDF bundle (3.75 MB, from 0.56; publish ADR 658), and slide's output work
brings MP4 export (5.5 MB, from 3.1; slide ADR 720). `dist/` measured 65.0 MiB. The budget catches
an accidental gain, so it sits about a tenth above what the package measures; a feature that
passes it raises it here, with its size. The entry budgets stay at 16 KiB.

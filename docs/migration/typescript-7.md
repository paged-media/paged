# TypeScript 7

The workspace compiles with TypeScript 7 (wave U4). This page records what moved, how each
user of the old JavaScript compiler API was handled, what the published declarations look like
before and after, and how long the builds take.

## What moved

- **The catalog.** `typescript` is `^7.0.2`, npm's `latest` and the Go compiler. Every package
  that devDepends on `typescript: catalog:` gets it, so every `tsc` in the workspace is
  TypeScript 7. Type checking was already `bun check`, which has TypeScript 7 semantics.
- **No JavaScript compiler API.** The `typescript` 7 package exports only its version and
  `typescript/unstable/*`; `ts.createSourceFile`, `ts.createProgram`, `SyntaxKind` and the rest
  are gone. The 6.x API is published as `@typescript/typescript6` (6.0.2, which re-exports
  `typescript@6.0.3` under the alias `@typescript/old`).
- **`rootDir`.** TypeScript 6 and later require it when the common source directory is not the
  directory of the tsconfig (TS5011). The declaration builds set `"rootDir": "src"`.
- **tsup leaves the workspace**, and with it every bundled `.d.ts` build (its `dts` runs
  rollup-plugin-dts on the JavaScript API). See [Builds](#builds).

## Users of the JavaScript API

| User | What it did | Now |
|---|---|---|
| `platform/extensions/scripts/gen-core-commands.mjs` | reads the vendored wire with `ts.createSourceFile` | reads the engine's JSON Schema of the wire, `engine/core/crates/paged-wire/schema/mutation.schema.json` ([engine ADR 187](../../engine/core/docs/adr/187-the-wire-describes-itself-as-json-schema.md)), and parses no TypeScript; its output is byte-identical. The bridge it used until then, `@typescript/typescript6` as a devDependency of `platform/extensions`, is removed. |
| `dts-bundle-generator` 9.5.1 | nothing: declared in `platform/extensions` since June for publish builds that never used it | removed |
| `tsup` 8.5.1 (`dts`, `--dts`) | bundled declarations for 20 builds | removed with tsup; see [Builds](#builds) |
| `typescript-eslint` 8.60.1 (peer `>=4.8.4 <6.1.0`) | the editor's ESLint parser | needed no alias while it was here: Bun resolved its peer to `typescript@6.0.3` (installed for `@typescript/typescript6`), never to the catalog's 7, and ESLint passed. It has since left the workspace with ESLint (`bun lint`, PM-0003). |
| esbuild through tsup | paged.data's DuckDB re-bundling (`scripts/bundle-duckdb-api.mjs`, `test/browser-lane.ts`) reached esbuild through tsup's dependency | `esbuild` `^0.27.7` is a devDependency of `modules/data`, the version tsup had installed |

## Builds

Every workspace package's `exports` point at `src/*.ts`; the editor compiles the sources with
Vite. The `dist/` builds existed only for npm tarballs, and [PM-0008](../adr/PM-0008-npm-packages-and-release.md)
keeps four public packages.

| Package | npm | Before | After |
|---|---|---|---|
| `@paged-media/plugin-api` | public | `tsc` 5.9 declarations | `tsc` 7 declarations, plus `isolatedDeclarations` |
| `@paged-media/idml-viewer` | public | `tsc` 5.9, JavaScript and declarations | `tsc` 7, JavaScript and declarations, plus `isolatedDeclarations` |
| `@paged-media/plugin-sdk` | public | tsup: esbuild at `--target es2020` and a bundled `index.d.ts` | `bun build` (one ESM file) and `tsc` 7 `--emitDeclarationOnly` (one `.d.ts` per module) |
| `@paged-media/canvas-wasm` | public | wasm-bindgen's `.d.ts`, no `tsc` | unchanged |
| `@paged-media/cli` | private | tsup: `dist/bin.js`, `dist/index.js` and a bundled `index.d.ts` | `bun build` of `dist/bin.js` only, the plain-Node bin of ADR 324 (its spec runs it); no declarations |
| `@paged-media/ai` | private | tsup with declarations | no build |
| the nine bundles (`data`, `doc`, `draw`, `image`, `pdf`, `publish`, `sheet`, `slide`, `web`) | private | tsup with declarations | no build; `private: true`, no `publishConfig` |
| host models, draw's geometry and tools, web's model | private | tsup with declarations | no build |

- **Why no build for the private packages.** Nothing reads their `dist/`: the editor builds
  them from source (including the code-split bundles of ADR 222), the module upload sends the
  declared wasm from `bin/`/`wasm/`, and publish-ci's bundle job now typechecks and validates the
  manifests without building. Their `files` lists stay: the editor's wasm budget
  (`scripts/wasm-budget.mjs`) reads them to know what a package ships.
- **Why idml-viewer stays on `tsc` alone.** It never used the JavaScript API, and TypeScript 7
  emits its JavaScript and declarations byte for byte as 5.9 did, in one pass. `bun build` would
  add a bundling step that a package with one export does not need.
- **plugin-sdk's top-level-await gate** ([ADR 313](../../platform/extensions/docs/adr/313-no-react-at-load.md))
  was tsup's `--target es2020`: esbuild refuses to emit a top-level await there. `bun build` has
  no syntax target, so the gate moved to the declaration compile: `tsconfig.build.json` sets
  `"module": "ES2020"`, where TypeScript rejects a top-level await (TS1378). The spec asserts
  that setting.
- **Moon.** `js-build` is defined only by the projects that build (extensions, idml-viewer, the
  editor) and no longer inherited by every `node` project; the aggregate `build` task already
  treats it as optional.

## The published packages, before and after

Compared by packing each package with `tooling/js/pack.mjs` (the release path) before (5.9 and
tsup) and after, plus `npm pack --dry-run`, and by dumping the consumer-visible type surface:
every export of the package, its type and every member, printed by the TypeScript 6 checker from
a consumer project that installs the tarballs.

- **plugin-api**: same 19 files; every `.d.ts` byte-identical.
- **idml-viewer**: same 18 files; JavaScript and `.d.ts` byte-identical.
- **plugin-sdk**: 5 files before, 37 after. `dist/index.d.ts` is now an entry that re-exports one
  `.d.ts` per source module (33 files) instead of a single bundled file.
  - The type surface is identical under `moduleResolution: "bundler"` (1,262 lines, no
    difference).
  - Under `node16`/`nodenext` it has the same exports and the same types (unions print in
    another member order). That holds because the sources' relative imports now name `.js`;
    without it the per-module declarations would not resolve there.
  - Under `nodenext`, plugin-api's own extensionless relative imports fail (TS2834) before and
    after, so types plugin-sdk borrows from plugin-api are unresolved there in both. Unchanged.
  - JavaScript: the same 93 exports and the same top-level declarations. Bun keeps the native
    class fields where esbuild, at ES2020, wrote `__publicField` helpers, and keeps `node:`
    prefixes on the Node built-ins the headless host imports. Vite 6's dependency optimiser
    (esbuild 0.25 at `chrome87, edge88, es2020, firefox78, safari14`) pre-bundles both artifacts
    without an error.
- The packed `package.json` differs in the version (0.2.71-canary.0), the build script and the
  `typescript` devDependency range.

## Timings

`tsc` alone on the two declaration builds, median of 7 runs:

| Build | `tsc` 5.9.3 | `tsc` 7.0.2 |
|---|---|---|
| plugin-api | 0.82 s | 0.15 s |
| idml-viewer | 0.64 s | 0.13 s |

A second run under a heavier load gave 2.52 s / 0.44 s and 3.78 s / 0.57 s: about five times
faster either way.

Every build script, median of 3 runs (`bun run build` in the package):

| Build | Before | After |
|---|---|---|
| plugin-api | 0.40 s (`tsc` 5.9) | 0.25 s (`tsc` 7) |
| idml-viewer | 3.75 s (`tsc` 5.9) | 1.08 s (`tsc` 7) |
| plugin-sdk | 4.41 s (tsup) | 0.95 s (`bun build` + `tsc` 7) |
| cli | 5.35 s (tsup) | 0.04 s (`bun build`) |
| ai | 2.12 s (tsup) | no build |
| the 14 module builds measured (bundles, host models, draw's geometry and tools, web's model; pdf's needs its mapper wasm) | 37.32 s in total (tsup) | no build |
| **all** | **53.35 s** | **2.32 s** |

The machine was shared with other builds while these ran; read them as ratios.

## `tsc` 7 and `bun check`

`tsc --noEmit -p` (TypeScript 7) and `bun check -p` agree on all 33 project tsconfigs in the
workspace: both pass with no errors on every one.

## Editors

TypeScript 7 ships no `tsserver`. VS Code's built-in TypeScript uses its own bundled version
(the workspace sets no `typescript.tsdk`); the TypeScript Native Preview extension gives
TypeScript 7 semantics. Serena installs its own typescript-language-server and `typescript`.

## Left for wave D

- The per-module `*-publish.yml` workflows (dispatch-only since the monorepo import) still run
  `bun run --filter './packages/*' build`, which now fails: no bundle has a build script. They go
  with the npm deprecations, together with paged.data's `scripts/pubcheck.*` and the
  `scripts/package-hash.mjs` of data, sheet and web (which still list `tsup.config.ts`).
- `extensions-publish.yml` publishes plugin-api, plugin-sdk and plugin-cli; ai and cli are
  private.
- `isolatedDeclarations` holds for plugin-api and idml-viewer without a change and is on for
  both. plugin-sdk would need explicit types at nine places in four files (the `as const`
  budget objects, a `Set` and a `RegExp`); not done.
- plugin-api's relative imports could name `.js` too, so the contract resolves under
  `node16`/`nodenext` for the first time (46 specifiers in 12 files).
- `apps/editor`'s `test:object-model` (not run in CI) fails before and after: Node's loader needs
  `with { type: "json" }` for plugin-api's `catalog.json`, and its resolve hook maps only
  extensionless specifiers.

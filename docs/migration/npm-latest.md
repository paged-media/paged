# npm to latest (U4) and React 19 (U4a)

Wave U4 moves every npm dependency of the root Bun workspace to its current release; U4a moves
React from 18.3 to 19.3.1. This page records what moved, the breaking changes of each major as
they touch this repository, the dependencies held back and why, and the gates before and after.
Each major is its own commit, with its changelog summary in the commit message.

## What moved

Direct dependencies (every workspace manifest and the root catalog), resolved in `bun.lock`:

| Package | Before | After | Kind |
|---|---|---|---|
| `vite` (catalog) | 6.4.3 | 8.3.4 | major ×2 (7, then 8) |
| `@vitejs/plugin-react` | 4.7.0 | 6.1.2 | major ×2 (5, then 6) |
| `react`, `react-dom` (catalog) | 18.3.1 | 19.3.1 | major (U4a) |
| `@types/react`, `@types/react-dom` (catalog) | 18.3.31, 18.3.7 | 19.3.0 | major (U4a) |
| `react-test-renderer`, `@types/react-test-renderer` | 18.3.1 | 19.3.1, 19.3.0 | major (U4a) |
| `@types/node` (catalog) | 20.19.39 and 25.9.6 (`node25`) | 24.19.2 | one entry, Node 24's types |
| `@playwright/test`, `playwright`, `playwright-core` | 1.63.0 | 1.64.1 | browser revision 1243 → 1248 |
| `@anthropic-ai/sdk` | 0.128.0 | 0.135.0 | 0.x minor (breaking by semver) |
| `esbuild` (modules/data) | 0.27.7 | 0.28.2 | 0.x minor (breaking by semver) |
| `wrangler` (`npx -y wrangler@…`: release.yml, modules-sync.mjs, `paged-plugin modules-upload`) | 3 | 4 | major |
| `@radix-ui/react-dialog`, `-popover` | 1.1.23 | 1.3.1 | minor |
| `@radix-ui/react-dropdown-menu` | 2.1.24 | 2.2.1 | minor |
| `@radix-ui/react-tooltip` | 1.2.16 | 1.4.1 | minor |
| `@radix-ui/react-slider` | 1.4.7 | 1.6.1 | minor |
| `@radix-ui/react-slot` | 1.3.3 | 1.5.0 | minor |
| `@radix-ui/react-tabs` | 1.1.21 | 1.2.1 | minor |
| `@radix-ui/react-separator` | 1.1.15 | 1.2.0 | minor |
| `tailwind-merge` | 3.6.0 | 3.7.0 | minor |
| `autoprefixer` | 10.5.5 | 10.6.1 | minor |
| `postcss` | 8.5.29 | 8.5.31 | patch |
| `tsx` | 4.23.13 | 4.23.15 | patch |
| `jszip` (pdf-bundle specifier) | ^3.10.1 (resolved 3.10.2) | ^3.10.2 | specifier only |

Removed: apps/editor/apps/devtools declared 21 dependencies it never imports (eleven Radix
primitives, `class-variance-authority`, `clsx`, `cmdk`, `lucide-react`,
`react-resizable-panels`, `tailwind-merge`, `tw-animate-css`, `tailwindcss`, `postcss`,
`autoprefixer`); they are gone, and with them the only use of `lucide-react` (0.460, whose
current major is 1.x).

Already current, unchanged: `typescript` 7.0.2, `@types/bun` 1.4.3 (the Bun runtime's
version), `happy-dom` and `@happy-dom/global-registrator` 21.0.3, `@testing-library/dom`
10.4.2, `@testing-library/react` 16.3.3, `@testing-library/user-event` 14.6.8, `fast-check`
4.10.2, `mitata` 1.0.34, `pngjs` 7.0.0, `@types/pngjs` 6.0.5, `cmdk` 1.1.1, `clsx` 2.1.1,
`class-variance-authority` 0.7.1, the `@fontsource` faces 5.3.0, `tailwindcss-animate` 1.0.7.

Transitive dependencies were then resolved from scratch with the manifests unchanged (the lock
had been migrated from the component locks and kept their transitive versions): 27 packages
move within their ranges, nothing is added or removed. cmdk's Radix dialog 1.1.23 and its
primitives join the shell's 1.3 line, browserslist and caniuse-lite move to current data.

## The majors

**Vite 6 → 7.** Node 20.19+ / 22.12+; `build.target` defaults to 'baseline-widely-available';
some built-in middlewares (CORS, host check) run before `configureServer` hooks, which the
canvas's COOP/COEP/CORP and connect-src middlewares do not depend on; `transformIndexHtml`
hook objects lose `enforce`/`transform` (the connect-src plugin uses the function form);
splitVendorChunkPlugin and the Sass legacy API are gone (unused).

**Vite 7 → 8.** Rolldown replaces esbuild and Rollup, Oxc does the transforms and
minification, Lightning CSS minifies CSS. Neither app config sets `esbuild`,
`optimizeDeps.esbuildOptions` or `build.rollupOptions`; the canvas plugins' virtual modules are
JavaScript already; the CommonJS default-import rule leaves the packages the editor imports
as they were. The canvas build writes the same output within noise (423 JS files, 44.6 MB;
14 wasm files, 99.3 MB; CSS 56.9 → 54.5 kB). Vite now warns that the canvas config's
`__dirname` and an extensionless import will need changing once its native config loader is
the default.

**@vitejs/plugin-react 4 → 5 → 6.** 5.x accepts Vite 4–8, so Vite moved under it; it stopped
adding react/react-dom to `resolve.dedupe` (the canvas lists both itself). 6.x requires Vite 8
and drops Babel: React Refresh runs in Oxc, and Babel plugins (the React Compiler among them,
R0) go through `@rolldown/plugin-babel` and `reactCompilerPreset`. 32 packages, @babel/core and
react-refresh among them, leave the lock.

**Playwright 1.63 → 1.64.** Chromium 153 → 156.0.8078.4 (chromium-1248, headless shell 1248).
Device descriptors now forward `screen` (the editor reads no `screen`); JSX in test files
follows tsconfig (no spec is .tsx); `--update-snapshots=missing` passes; elements in hidden
iframes count as hidden (no spec drives an iframe).

**wrangler 3 → 4.** `r2 object put` now targets the local simulator unless given `--remote`,
which both module uploads (`apps/canvas/scripts/modules-sync.mjs` and plugin-sdk's
`paged-plugin modules-upload`) now pass; Pages Functions
bundle with esbuild 0.24+ (functions/api/ai has no wildcard dynamic import, and
`wrangler@4 pages functions build` compiles it); Node 16/18 are gone.

**@anthropic-ai/sdk 0.128 → 0.135.** New API surface; client-side compaction control removed
from the tool runner (the agent loop is our own); the SDK now depends on @opentelemetry/api,
which records nothing without a registered tracer provider.

**esbuild 0.27 → 0.28** (paged.data's DuckDB re-bundle): install-side integrity checks, Go 1.26.
`scripts/bundle-duckdb-api.mjs` writes a byte-identical `duckdb-browser.mjs`.

**@types/node.** One catalog entry, ^24.19.2, for Node 24.22.0 (`.prototools`); the `node25`
named catalog is gone.

## Held back

| Package | Stays at | Latest | Why |
|---|---|---|---|
| `@duckdb/duckdb-wasm` | 1.29.0 (engine v1.1.1) | 1.32.0 (engine v1.4.x; npm's `latest` tag is a dev build) | Vendored on purpose (`modules/data/scripts/vendor-duckdb.sh`, ADR 015). A bump changes the engine, so the json/parquet extensions need new SHA-256 pins and manifest paths, and the SQL oracle (`conformance/duckdb-sql`) must be re-recorded with the matching native `duckdb` CLI (`record.mjs` refuses any other engine). That CLI is not on this machine. |
| `apache-arrow` | 17.0.0 | 21.2.0 | DuckDB-WASM's own dependency is `apache-arrow ^17` in every release up to 1.32.0, and the editor resolves DuckDB's bare `apache-arrow` import onto this copy. It moves when DuckDB-WASM does. |
| pdfium (`modules/publish/packages/pdf-bundle/bin/pdfium.esm.*`) | the committed prebuilt | n/a | A third-party prebuilt, not an npm package; ADR 655 records that its upstream release is not known, so there is nothing to compare against. |
| `@types/node` | 24.19.2 | 26.6.5 | Its major follows Node's; the repository runs Node 24. It moves with the `.prototools` pin. |
| `tailwindcss` | 3.4.19 | 4.3.3 | See [Tailwind](#tailwind). |
| `@babel/parser` (apps/editor, exact) | 7.29.8 | 8.0.7 | Added by the surface-conformance work (`scripts/surface/static-eval.mjs`) while this series ran; 8 is a new major of the AST it walks, so it moves with that script. |
| `dom-accessibility-api` (canvas) | ^0.5.16 | 0.7.1 | Added with the panel DOM lane; `@testing-library/dom` 10.4.2 (current) depends on `^0.5.9`, so 0.5 keeps one copy. |

## React 19

The workspace has one React, 19.3.1, from the root catalog (`bun.lock` holds a single react and
react-dom).

- **Codemods.** The React 19 migration recipe (`codemod run react/19/migration-recipe`:
  ReactDOM.render, string refs, act from react-dom/test-utils, useFormState, PropTypes) would
  modify 0 of 10 033 files. types-react-codemod 3.5.3 `preset-19`: its eleven required
  transforms change nothing; the optional `react-element-default-any-props` would rewrite 38
  `ReactElement` return annotations to `ReactElement<any>` in 15 files, which React 19's types
  do not need, so it was not applied. `bun check` passes on React 19's types without a change.
- **forwardRef → ref as a prop.** All 29 `forwardRef` components (28 shadcn primitives in the
  shell, web-bundle's FallbackCodeEditor) are plain functions; the ref travels in the props
  (`React.ComponentProps<…>`), and the displayName assignments are gone.
- **react-test-renderer** stays for the sheet and web panel specs and warns that it is
  deprecated; moving those specs to Testing Library in the happy-dom lane is a follow-up.
- **The contract** ([PM-0008](../adr/PM-0008-npm-packages-and-release.md), amendment 2):
  `plugin-api` depends on `@types/react` ^19.3; React peers (plugin-sdk's optional one, the
  seven bundles that render React, the editor's catalog, shell, tools and ui) are `>=19.3`;
  `plugin-api` and `plugin-sdk` moved to the next canary together (0.2.79-canary.0). The
  extension authors' note
  is in [platform/extensions/README.md](../../platform/extensions/README.md#react-19).
- **Lint.** `bun lint` (the Rules of React as errors, the suppressions ratchet) reports the same
  as before: no new finding, no new suppression.

## Tailwind

Tailwind stays on 3.4.19 in this series. 4.x is a rewrite of how the editor is styled, not a
version bump:

- the configuration moves from `tailwind.config.ts` (shell's shadcn tokens, extended by the
  canvas) to CSS (`@import "tailwindcss"`, `@theme`, `@source` for the shell, ui and canvas
  sources, which Tailwind 4 no longer finds through the canvas config's `content`), and the
  PostCSS plugin to `@tailwindcss/postcss` or `@tailwindcss/vite`;
- `tailwindcss-animate` (a v3 plugin) gives way to `tw-animate-css`;
- utilities are renamed across the 790 `className`s of the shell, ui and canvas (`shadow-sm` →
  `shadow-xs`, `rounded-sm` → `rounded-xs`, `outline-none` → `outline-hidden`, `ring` →
  `ring-3`, `[--var]` → `(--var)`, …), and defaults change (ring width and colour, border and
  placeholder colours, button cursor, `space-*` selectors, hover only where the device hovers).

The upgrade tool (`@tailwindcss/upgrade`) does most of the rewriting, but the result changes
pixels in every panel, and the committed visual baselines cover twelve journey shots. It needs
its own commit series with a before/after review of each panel archetype. It is also the only
route out of the two advisories `bun audit` still reports, both under Tailwind 3 (`braces` via
micromatch, `postcss-selector-parser` 6 via postcss-nested), which have no fixed release inside
Tailwind 3's ranges.

## Gates

Before is origin/main at the last merge (`c2b3a933f`), after is the merged tree; both run with
the same engine and module wasm, built from the same Rust sources. The machine was shared with
other builds, so a few tests ran into their own timeouts; those were run again, alone, and the
re-run is what the table shows. Main's own reds at that commit are listed as such: they are the
same before and after.

| Gate | Before | After |
|---|---|---|
| `bun install --frozen-lockfile` | ok | ok |
| `bun run --filter '*' typecheck` | 2 errors (main: `tests/headless/script-automation.test.ts` imports two names its module does not export) | the same 2 |
| canvas `typecheck:tests` | 0 errors | 0 errors |
| canvas `typecheck:showcase` | 17 errors (the e2e harness reaches `.tsx` and `.ts`-suffixed imports the showcase tsconfig did not allow) | 0 errors, 313 files (fixed in this series) |
| `bun run lint` | 0 problems | 0 problems, 2 371 files |
| `bun run lint:selftest` | 293 expectations met | 293 expectations met |
| `tooling/js/fmt.sh --check` | 1 file (main: `tests/headless/commands-document.test.ts`) | the same 1 |
| builds: plugin-api, plugin-sdk, idml-viewer, cli, devtools | ok | ok |
| canvas `vite build` | ok, 101–129 s (Vite 6, busy machine) | ok, 6–7 s (Vite 8) |
| wasm budget | 99.3 MB of 100 MB, 14 artifacts | 99.3 MB of 100 MB, 14 artifacts |
| seam guard, applicability, feat vocabulary, solo profiles, client-api-catalog `--check`, workspace deps | ok | ok |
| surface coverage | fails (main: two `covers!` calls in `paged-cli/tests/it/golden.rs` the gate cannot read) | the same |
| contract guard, untyped-shrinks | ok | ok (plugin-api, plugin-sdk bumped) |
| `bun audit` | 4 advisories (2 high, 1 moderate, 1 low) | 2 (1 high, 1 moderate), both under Tailwind 3 |

`bun test`, per package (pass + skipped):

| Package | Before | After |
|---|---|---|
| apps/editor/apps/canvas (DOM) | 1 077 | 1 077 |
| apps/editor/apps/canvas contracts / unit | 21 / 120 | 21 / 120 |
| apps/editor/apps/canvas headless | 1 601, 2 failed (main: the committed matrix) | the same |
| apps/editor/packages/repository | 8 + 2 skipped | 8 + 2 skipped |
| apps/editor/packages/shell, (DOM) | 196, 95 | 196, 95 |
| apps/editor/packages/tools | 133 | 133 |
| engine/core/web/idml-viewer | 29 | 29 |
| modules/data/packages/data-bundle, (DOM) | 427 + 2 skipped, 5 | 427 + 2 skipped, 5 |
| modules/data/packages/data-host-model | 53 | 53 |
| modules/doc/packages/doc-bundle, (DOM) | 54, 6 | 54, 6 |
| modules/doc/packages/doc-host-model | 44 | 44 |
| modules/draw/packages/draw-bundle | 1 774 + 34 skipped, 8 failed (main: the InDesign round-trip and Illustrator outline-stroke lanes) | the same (re-run) |
| modules/draw/packages/draw-bundle (DOM) | 168 | 168 |
| modules/draw/packages/draw-geometry | 681 | 681 |
| modules/draw/packages/draw-tools | 337 | 337 |
| modules/image/glue, (DOM) | 477, 5 | 477, 5 (the DOM lane needed a React 19 fix, below) |
| modules/publish/packages/pdf-bundle | 36 | 36 |
| modules/publish/packages/publish-bundle | 31 | 31 |
| modules/sheet/packages/sheet-bundle, (DOM) | 404 + 1 skipped, 7 | 404 + 1 skipped, 7 |
| modules/sheet/packages/sheet-host-model | 193 | 193 |
| modules/slide/packages/slide-bundle, (DOM) | 69, 13 | 69, 13 |
| modules/web/packages/web-bundle, (DOM) | 346, 5 | 346, 5 |
| modules/web/packages/web-conformance | 103 | 103 |
| modules/web/packages/web-model | 290 + 9 skipped | 290 + 9 skipped |
| platform/extensions/packages/ai | 31 | 31 |
| platform/extensions/packages/cli | 77 + 1 skipped | 77 + 1 skipped |
| platform/extensions/packages/plugin-sdk | 752 | 752 (re-run) |
| platform/shared/test-kit | 64 | 64 |
| editor scripts (boot-coi 5, network-policy 6, modules 5, spread-pages 8, thresholds 3, journal 39, object-model 38) | 104 | 104 |
| editor surface-coverage tests | 12 | 12 |

Two things the gates found that the upgrade itself caused, both fixed in this series:

- **image's panel DOM lane under React 19.** The spec hides `window` while image-js boots (its
  loader takes the Node path then). React 19 reads `window.event` when its scheduler runs work;
  React 18 did not. The spec now lets pending work run first and hides `window` inside `act()`.
- **paged-plugin `modules-upload`** (the bin that moved into plugin-sdk) also ran
  `wrangler@3 r2 object put`; it moves to wrangler 4 with `--remote`, and its golden transcripts
  with it.

## Playwright

`@level:smoke` on the chromium and journeys projects, and the plugin journeys
(`--project=journeys tests/journey/plugins/`), against the Vite dev server (started with Node),
headless Chromium without a WebGPU adapter (the CPU path). Before: Playwright 1.63 (Chromium
153) on origin/main `c2b3a933f`; after: Playwright 1.64.1 (Chromium 156) on the merged tree.

| Run | Before | After |
|---|---|---|
| smoke (`@level:smoke`) | 63 passed | 63 passed |
| plugin journeys | 74 passed, 21 skipped | 74 passed, 21 skipped |

The same two runs on intermediate commits: after Vite 8 and plugin-react 6, smoke 63 passed;
after React 19, smoke 63 passed and the plugin journeys 74 passed, 21 skipped.

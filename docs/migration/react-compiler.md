# R0 — The React Compiler, everywhere

Every first-party React source now ships compiled by the React Compiler. This page records how
it is set up, what the first compiled runs found and how it was fixed, the coverage ratchet, how
the code is tested both ways, and the measurements. The decision record is
[apps/editor ADR 228](../../apps/editor/docs/adr/228-react-compiler.md).

## Commands

```bash
bun tooling/js/react-compiler-coverage.mjs            # the ratchet (CI: lint / React Compiler coverage)
bun tooling/js/react-compiler-coverage.mjs --write    # after fixing a bailout or adding a component
(cd apps/editor/apps/canvas && bun run test:dom:compiled)    # the panel DOM lane, compiled
(cd apps/editor/packages/shell && bun run test:dom:compiled) # the shell's DOM lane, compiled
bun test --preload <lane preloads> --preload tooling/js/bun-react-compiler.ts …  # any lane, compiled
(cd apps/editor/apps/canvas && bun run test:render-counts)   # re-render counts, as written vs compiled
PAGED_REACT_COMPILER=0 bunx --bun vite build          # a build (or dev server) without the compiler
```

The latency probe, against the production build:

```bash
cd apps/editor/apps/canvas
node node_modules/vite/bin/vite.js build --mode demo --outDir dist-demo
node node_modules/vite/bin/vite.js preview --outDir dist-demo --port 5195 --strictPort --host 127.0.0.1 &
IDML_CANVAS_TEST_PORT=5195 PAGED_PERF_OUT=perf.json \
  node node_modules/@playwright/test/cli.js test --project=perf
```

## Setup

- **Packages.** In the root catalog: `@babel/core` ^7.29.7, `babel-plugin-react-compiler` ^1.0.0,
  `@rolldown/plugin-babel` ^0.2.4, `@types/babel__core` ^7.20.5. Babel 7, not 8: the compiler
  1.0.0 is built against `@babel/types` 7 and walks Babel 7's AST. The canvas app and devtools
  use all four; the root (for the ratchet and the test preload) and plugin-sdk (for its library
  build) use Babel and the compiler.
- **The Vite builds** (canvas, devtools) add `...reactCompiler({ reactCompilerPreset, babel })`
  after `react()`: plugin-react's preset, run by `@rolldown/plugin-babel` with `enforce: "pre"`,
  so the compiler sees TypeScript and JSX before Oxc transforms them. The preset is limited to the
  first-party `src` trees by an id filter, so Babel never parses the wasm-bindgen glue or the
  vendored DuckDB dist. The dev server compiles the same way.
- **The options** (`tooling/js/react-compiler.mjs`): `target: "19"` (React 19.3 ships
  `react/compiler-runtime`; no `react-compiler-runtime` package), `compilationMode: "infer"`,
  `panicThreshold: "none"`, `environment.enableFunctionOutlining: false` (below).
- **plugin-sdk** builds with `bun scripts/build.mjs`: the compiler over its sources, then
  `bun build`, then tsc. It compiles nothing today, the output is byte-identical to the previous
  `bun build`, and the build fails if the output imports React statically (React is an optional
  peer there and must stay optional at runtime).

### What `bun lint --doctor` says

All 17 Rules-of-React rules of eslint-plugin-react-hooks 7.1.1's `recommended-latest` set run
natively in `bun lint` (82 rules on: 60 eslint, 17 react-hooks, 5 @typescript-eslint), and the
doctor names no package to load, so nothing comes from npm under `[lint] plugins`.
`eslint-plugin-react-hooks@latest` is 7.1.1, the version bun lint implements.

## What the compiled runs found

The DOM lanes were run on compiled code for the first time with the preload. Before any fix:

| Lane | As written | Compiled, first run |
|---|---|---|
| canvas DOM | 1,077 pass | 1,069 pass, 8 fail |
| shell DOM | 95 pass | 90 pass, 5 fail |
| draw DOM | 168 pass | 160 pass, 8 fail |
| slide DOM | 13 pass | 7 pass, 6 fail |
| doc DOM | 6 pass | 4 pass, 2 fail |
| data (hook-store harness) | 265 pass | 229 pass, 36 fail |
| image glue (hook-store harness) | 477 pass | 427 pass, 50 fail |

The data and image failures were the harness: those specs call a component as a plain function
outside React, and a compiled component calls `useMemoCache`. The preload gives such a call a
fresh cache (compute everything, as the uncompiled function does); inside a render the cache is
React's. Every other failure was a real behaviour change, and each fell into one of four shapes
(the ADR has them). The fixes:

| Where | What it read during render | Now |
|---|---|---|
| shell: menu bar, command palette, tool rail, mode switcher, context toolbar, zoom menu, dock (panel host, right dock, cockpit layout, title bar) | the registries (`menus.list()`, `modes.get()`, …), with version counters as unread memo deps | `useRegistryView(registry)` |
| shell: command and keybinding registries | had no change event | `onChange`, like the other registries |
| shell: schema panel renderer (every schema panel's gates) | `bindings.get()` after a tick | a live view of the bindings, passed down |
| shell: tool options popover | `settings.getValue()` from a stable accessor | `useSyncExternalStore` on the store |
| shell: demo box and spotlight | module `let`s after a forced render | `useSyncExternalStore` (the spotlight's box as a string snapshot) |
| canvas: journal panel | `journal.entries()` beside an unread revision (`void version`) | the snapshot itself from the store |
| canvas: keyboard shortcuts, export outputs, canvas panel | registries | `useRegistryView` |
| devtools | `client.tree()` on a client whose document changes | the tree in state, read where it changes |
| slide: slides and notes panels, thumbnails | the store after a forced render | `useLive(store, subscribeOf)` |
| doc: outline panel | the store after a forced render | `useLive(store, subscribeOf)` |
| sheet: format and names sections | `session.formatTarget()` etc. on the session prop | `useLive(session, onDidChangeOf)` |
| draw: every panel built in a factory | (compiler defect) handlers outlined to module scope, where `host` is undefined | `enableFunctionOutlining: false` |

The compiled runs also passed two expected-failure tests of the panel conformance programme:
PN-308 (an exporter registered while the Outputs nav is open did not show) and PN-351 (a binding
registered while the shortcuts panel is open did not show). They are ordinary tests now.

`@paged-media/react-live` (`platform/shared/react-live`, internal) is the shared mechanism:
`useLive(source, listen)` returns a view of the source (a proxy that reads through to it, methods
bound to it) that is replaced after every change the source reports. It listens from the first
read, so a change between a render and React's subscription still produces a new view. The
editor and the modules may import it (the lint allow-lists name it).

### How the remaining hazards were looked for

The DOM lanes only see what a test renders, so the compiled output was also scanned (a throwaway
script over every compiled function): memo blocks that call a method on a long-lived object they
are keyed on, or that read module-level mutable state. After the fixes above it lists only
values that are rebuilt on change (a page-rect map, a context value rebuilt from state) and
static ones (the catalog registry, `host.supports`).

## Coverage

`compiler-coverage.json` per package; `bun tooling/js/react-compiler-coverage.mjs` prints the
table (this is the state the ratchet starts from):

| Package | Compiled | Bailouts | Not compiled | Coverage |
|---|---:|---:|---:|---:|
| apps/editor/apps/canvas | 186 | 32 | 0 | 85.3% |
| apps/editor/apps/devtools | 10 | 0 | 0 | 100.0% |
| apps/editor/packages/shell | 228 | 32 | 0 | 87.7% |
| apps/editor/packages/ui | 8 | 4 | 0 | 66.7% |
| modules/data/packages/data-bundle | 4 | 0 | 4 | 50.0% |
| modules/doc/packages/doc-bundle | 5 | 0 | 0 | 100.0% |
| modules/draw/packages/draw-bundle | 10 | 6 | 0 | 62.5% |
| modules/image/glue | 23 | 1 | 1 | 92.0% |
| modules/sheet/packages/sheet-bundle | 5 | 0 | 3 | 62.5% |
| modules/slide/packages/slide-bundle | 4 | 0 | 0 | 100.0% |
| modules/web/packages/web-bundle | 8 | 1 | 1 | 80.0% |
| **all** | **491** | **76** | **9** | **85.2%** |

The 76 bailouts by the compiler's reason: Todo 28 (syntax it does not lower yet: `try` with
`finally`, a conditional or optional chain inside `try`, `||=`, a computed object key), Refs 22
(a ref read or written during render), Suppression 19 (the function disables a Rules-of-React
lint rule), PreserveManualMemo 3, Immutability 2, Hooks 2. The 9 not compiled are module panels
returned by their factory as `return function Panel()`. A run takes 9 s here (268 files).

The production build reports the same from the bundle's side: 474 components and hooks compiled
in 204 modules, 76 skipped, in the eight chunks that hold first-party React code, all of them
reaching `react/compiler-runtime` in the entry chunk.

## Testing both ways

`bun test` runs the sources as written; the same lanes run compiled with the preload. After the
fixes, both ways, every lane:

| Lane | As written | Compiled |
|---|---|---|
| canvas DOM | 1,077 | 1,077 |
| canvas unit / contracts / headless | 120 / 21 / 1,671 | 120 / 21 / 1,671 |
| shell / shell DOM / tools | 196 / 95 / 133 | 196 / 95 / 133 |
| data-bundle (+ DOM) | 265 + 173 skipped (0 + 5 skipped) | the same |
| doc-bundle (+ DOM) | 54 (6) | 54 (6) |
| draw-bundle DOM | 168 | 168 |
| image glue (+ DOM) | 477 (5) | 477 (5) |
| sheet-bundle (+ DOM) | 404 + 1 skipped (7) | the same |
| slide-bundle (+ DOM) | 69 (13) | 69 (13) |
| web-bundle (+ DOM) | 346 (5) | 346 (5) |
| plugin-sdk | 752 | 752 |

(The data-bundle's 173 skipped are its DuckDB lanes, unavailable on this machine; they skip the
same way before and after.)

CI runs the shell's and the canvas app's DOM lanes compiled (`editor / tests`, job `checks`),
next to the production build with its compiler check.

### Playwright

`@level:smoke` (chromium and journeys projects) and the plugin journeys, on the Vite dev server,
headless Chromium without a WebGPU adapter. Before: origin/main at the base of this work
(`5cfadb02b`), no compiler. After: this branch, compiler on (the dev server compiles like the
build).

| Run | Before | After |
|---|---|---|
| smoke | 63 passed | 63 passed |
| plugin journeys | 73 passed, 1 flaky, 21 skipped | (pending) |

## Measurements

(pending)

# R0 — The React Compiler, everywhere

Every first-party React source now ships compiled by the React Compiler. This page records how
it is set up, what the first compiled runs found and how it was fixed, the coverage ratchet, how
the code is tested both ways, and the measurements. The decision record is
[apps/editor ADR 229](../../apps/editor/docs/adr/229-react-compiler.md).

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
table. The first compiled run: 491 compiled, 76 bailouts, 9 not compiled (85.2%). Now:

| Package | Compiled | Bailouts | Not compiled | Coverage |
|---|---:|---:|---:|---:|
| apps/editor/apps/canvas | 203 | 15 | 0 | 93.1% |
| apps/editor/apps/devtools | 10 | 0 | 0 | 100.0% |
| apps/editor/packages/shell | 249 | 12 | 0 | 95.4% |
| apps/editor/packages/ui | 9 | 3 | 0 | 75.0% |
| modules/data/packages/data-bundle | 5 | 2 | 0 | 71.4% |
| modules/doc/packages/doc-bundle | 5 | 0 | 0 | 100.0% |
| modules/draw/packages/draw-bundle | 15 | 1 | 0 | 93.8% |
| modules/image/glue | 25 | 0 | 0 | 100.0% |
| modules/sheet/packages/sheet-bundle | 7 | 1 | 0 | 87.5% |
| modules/slide/packages/slide-bundle | 4 | 0 | 0 | 100.0% |
| modules/web/packages/web-bundle | 8 | 1 | 1 | 80.0% |
| platform/shared/react-live | 1 | 0 | 0 | 100.0% |
| **all** | **541** | **35** | **1** | **93.8%** |

A run takes 7 s here (270 files).

What the 76 first bailouts were, and what was done:

| Reason | First run | Now | The change |
|---|---:|---:|---|
| Todo | 28 | 2 | a `try` the compiler does not lower (a `finally`; a conditional, optional chain or `??` inside it) moved to a module function returning its outcome, or became a promise chain; `\|\|=`, `??=` and computed template keys written out |
| Refs | 22 | 9 | a "latest value" ref written during render is written in a layout effect; the properties panel's steer pin is state; the dev handle (`__canvas`) is published from a layout effect |
| Suppression | 19 | 19 | none yet (below) |
| PreserveManualMemo | 3 | 1 | the dependency arrays the compiler could not match were completed (two were missing a dependency) |
| Immutability | 2 | 2 | none yet |
| Hooks | 2 | 2 | none yet |

The 9 not compiled were module panels returned by their factory as `return function Panel()`;
the compiler names a component only from a declaration, a variable, an assignment or an object
key. They are declarations now and read their session through `useLive`. Eight compile (image
adjustments, sheet's workbook and datasets panels, data's query and sources panels) or are
recorded bailouts (data's bindings and dataset panels, sheet's grid); web's source panel is
still returned from a factory.

What is left, and why:

- **Suppression (19)**: a function that disables a Rules-of-React rule, every one of them
  `exhaustive-deps` on an effect that runs on fewer dependencies than it reads, on purpose (the
  viewport canvas, the gesture spine, path editing, the overlay host, the cockpit state, the
  panel rail, the number input and dial, the three prompt dialogs, ...). Making those effects
  honest changes when they run; each is its own change with its own test.
- **Refs (9)**: providers and hooks that read or write a ref during render deliberately. The
  editor handle and the caret are written during render because children read them while
  rendering (`PagedEditorBinder`, `ContentSelectionProvider`); the edit-context stack, the
  registries provider, the camera animation, text editing, the canvas panel, the schema-list
  demo and the app's integration component read theirs in render.
- **Todo (2)**: data's bindings and dataset panels have a value block inside a `try`.
- **Immutability (2)**, **Hooks (2)**, **PreserveManualMemo (1)**, **not compiled (1)**: the
  app's plugin-bundle host (sets a global test handle during render), draw's path options
  (assigns to its factory's session in a handler), two hooks that call a hook conditionally
  (`useAddressFields`, `useObjectBindings`), sheet's grid (a memo whose dependencies the
  compiler cannot match), web's source panel (returned from its factory).

No `"use no memo"` is in the tree. The ratchet fails CI on a new entry, so these 36 only go
down.

The production build reports the same from the bundle's side: 523 components and hooks
compiled in 231 modules, 35 skipped, in the eight chunks that hold first-party React code, all
of them reaching `react/compiler-runtime` in the entry chunk.

The Rules-of-React lint suppressions (`eslint-suppressions.json`, recorded when the rules were
turned on) went from 194 to 136 on the way (refs 104 to 54).

## Manual memoization

At the start, the first-party sources held 296 `useMemo`/`useCallback` calls (107 and 189,
tests not counted). In a compiled component the compiler memoizes every value on the
dependencies it proves, and its preserve-manual-memoization check (a function whose
hand-written memo it cannot match is a `PreserveManualMemo` bailout, left as written) means a
hand-written memo in a compiled component adds nothing. A call was removed when its component
compiles and the value is used in the component itself or handed to a compiled child that does
not compare it. Six went with the fixes above, 76 in one pass; 214 stay (76 `useMemo`, 138
`useCallback`), each with its reason on the line above:

| Why it stays | Calls |
|---|---:|
| its component or hook is not compiled (a bailout, or not a component the compiler considers) | 83 |
| it keeps an effect's dependency stable | 67 |
| a `useMemo` with a block body (unwrapping it is a rewrite of the component, not a deletion) | 24 |
| its type argument types the value (`useMemo<ActionsApi>(…)`: dropping it loses the contextual type) | 16 |
| a hook's result, which callers may compare | 11 |
| its result is not bound to a plain name (destructured, or used inline) | 7 |
| handed to a hook that compares it | 4 |
| handed to a component that compares it | 2 |

New code adds none: `bun lint`'s `no-restricted-syntax` rejects a `useMemo` or `useCallback`
call (`React.useMemo` included) unless the line above says why
(`// eslint-disable-next-line no-restricted-syntax -- <reason>`); the lint self-test has a case
for each. The root `CLAUDE.md` and the editor's say the same. After the pass the DOM lanes pass
both ways, the Playwright runs below are unchanged, and the render counts and latency are
measured on this state.

## Testing both ways

`bun test` runs the sources as written; the same lanes run compiled with the preload. At the
end of the work, both ways, every lane:

| Lane | As written | Compiled |
|---|---|---|
| canvas DOM | 1,094 | 1,094 |
| canvas unit / contracts / headless | 122 / 21 / 1,683 | 122 / 21 / 1,683 |
| shell / shell DOM / tools | 200 / 95 / 144 | 200 / 95 / 144 |
| data-bundle (+ DOM) | 264 + 173 skipped (0 + 5 skipped) | the same |
| doc-bundle (+ DOM) | 54 (6) | 54 (6) |
| draw-bundle DOM | 168 | 168 |
| image glue (+ DOM) | 476 (5) | 476 (5) |
| sheet-bundle (+ DOM) | 403 + 1 skipped (7) | the same |
| slide-bundle (+ DOM) | 69 (13) | 69 (13) |
| web-bundle (+ DOM) | 345 (5) | 345 (5) |
| plugin-sdk | 755 | 755 |

(The data-bundle's 173 skipped are its DuckDB lanes, unavailable on the measuring machine; they
skip the same way both ways. The data, image, sheet and web lanes also hold the wasm freshness
check, which needs wasm built from the current Rust and is left out of the counts.)

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

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
| apps/editor/packages/shell | 250 | 11 | 0 | 95.8% |
| apps/editor/packages/ui | 9 | 3 | 0 | 75.0% |
| modules/data/packages/data-bundle | 5 | 2 | 0 | 71.4% |
| modules/doc/packages/doc-bundle | 5 | 0 | 0 | 100.0% |
| modules/draw/packages/draw-bundle | 15 | 1 | 0 | 93.8% |
| modules/image/glue | 25 | 0 | 0 | 100.0% |
| modules/sheet/packages/sheet-bundle | 7 | 1 | 0 | 87.5% |
| modules/slide/packages/slide-bundle | 4 | 0 | 0 | 100.0% |
| modules/web/packages/web-bundle | 8 | 1 | 1 | 80.0% |
| platform/shared/react-live | 1 | 0 | 0 | 100.0% |
| **all** | **542** | **34** | **1** | **93.9%** |

A run takes 7 s here (270 files).

What the 76 first bailouts were, and what was done:

| Reason | First run | Now | The change |
|---|---:|---:|---|
| Todo | 28 | 2 | a `try` the compiler does not lower (a `finally`; a conditional, optional chain or `??` inside it) moved to a module function returning its outcome, or became a promise chain; `\|\|=`, `??=` and computed template keys written out |
| Refs | 22 | 9 | a "latest value" ref written during render is written in a layout effect; the properties panel's steer pin is state; the dev handle (`__canvas`) is published from a layout effect |
| Suppression | 19 | 18 | the FPS hook (below); the rest not yet |
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

- **Suppression (18)**: a function that disables a Rules-of-React rule, every one of them
  `exhaustive-deps` on an effect that runs on fewer dependencies than it reads, on purpose (the
  viewport canvas, the gesture spine, path editing, the overlay host, the cockpit state, the
  panel rail, the number input and dial, the three prompt dialogs, ...). Making those effects
  honest changes when they run; each is its own change with its own test. One such
  suppression hid a real bug: the FPS hook's frame loop read the `fps` of the first render (0)
  and, once its sample window was full, a sample count that is always a multiple of 15, so it
  set the state on every frame instead of at 4 Hz, and the whole shell chrome re-rendered with
  it (in the DOM lane, 1,500 to 2,800 commits a second while a shell was mounted). The loop
  keeps its own frame count now and the hook compiles; mounting the shell in a test went from
  about 1,700 commits per settle to 15, and the canvas DOM lane from minutes to under one.
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

No `"use no memo"` is in the tree. The ratchet fails CI on a new entry, so these 35 only go
down.

The production build reported the same from the bundle's side (before the FPS hook's fix): 523
components and hooks compiled in 231 modules, 35 skipped, in the eight chunks that hold first-party React code, all
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
| canvas unit / headless | 122 / 1,458 | 122 / 1,458 |
| shell / shell DOM / tools | 200 / 95 / 144 | 200 / 95 / 144 |
| data-bundle (+ DOM) | 264 + 173 skipped (0 + 5 skipped) | the same |
| doc-bundle (+ DOM) | 54 (6) | 54 (6) |
| draw-bundle DOM | 168 | 168 |
| image glue (+ DOM) | 476 (5) | 476 (5) |
| sheet-bundle (+ DOM) | 403 + 1 skipped (7) | the same |
| slide-bundle (+ DOM) | 69 (13) | 69 (13) |
| web-bundle (+ DOM) | 345 (5) | 345 (5) |
| plugin-sdk | 755 | 755 |
| root tests: contracts / system | 234 / 28 | 234 / 28 |

(The data-bundle's 173 skipped are its DuckDB lanes, unavailable on the measuring machine; they
skip the same way both ways. The data, image, sheet and web lanes also hold the wasm freshness
check, which needs wasm built from the current Rust and is left out of the counts.)

The preload caches what it compiles by content (`node_modules/.cache/paged-react-compiler`,
keyed on the compiler's version and options, the preload's and the configuration's code, the
path and the source). `bun test --parallel` gives every test file a fresh module registry, so
without it each file compiled the whole graph it imports again: run over the canvas app's tests
with two workers, each worker compiled its 450-odd distinct sources 12,000 to 15,000 times in
all, about 30 times each, and the compiled DOM lane on CI took 365 to 394 s against 165 s as
written. The cost landed inside the first test of a file
that imports lazily, which on a loaded runner went past the 30 s per-test timeout (the chrome
toggles' first test, then the two after it, which a timed-out test's leftover work disturbs).
With the cache the lane compiles each file once.

CI runs the shell's and the canvas app's DOM lanes compiled (`editor / tests`, job `checks`),
next to the production build with its compiler check.

### Playwright

`@level:smoke` (chromium and journeys projects) and the plugin journeys, on the Vite dev server,
headless Chromium without a WebGPU adapter. Before: main at the base of this work
(`5cfadb02b`), no compiler. After: the last slice, compiler on (the dev server compiles like
the build), with the hand-written memoization removed.

| Run | Before | After |
|---|---|---|
| smoke | 63 passed | 63 passed |
| plugin journeys | 73 passed, 1 flaky, 21 skipped | 74 passed, 21 skipped |

(The flaky one before was `sheet-edit-persist`, which passed on retry. Under heavy machine load
the draw corner and draw panel journeys timed out once each, compiled and not; they pass on an
idle run.)

## Measurements

Before: main at the base of this work (`5cfadb02b`), no compiler. After: the last slice,
compiled, with the hand-written memoization removed.

### Re-render counts (DOM lane)

`bun run test:render-counts` (canvas app) mounts four heavy panels on the panel lane's harness,
over the real engine, drives the same interactions as written and compiled, and counts React's
commits and the components it rendered (`test/measure`). The as-written figures equal main's
before this work.

| Panel | Interactions | Panel renders, as written → compiled | Commits | Mounted components with a compiler cache |
|---|---:|---|---|---:|
| Layers (select 6 frames, deselect) | 7 | 116 → 67 (−42%) | 10 → 10 | 36 of 46 |
| Pages (jump to 4 pages, add 2) | 6 | 5.0 → 1.0 per commit | (a) | 27 of 37 |
| Properties (select shapes, a group and two; set strokes; deselect) | 7 | 2,306 → 997 (−57%) | 29 → 32 | 25 of 35 |
| Swatches (select, fill from swatches) | 6 | 267 → 88 (−67%) | 14 → 15 | 43 of 59 |

(a) A page jump animates the view, so the number of commits depends on the time it takes; the
panel renders per commit are the comparable figure. The fifth panel, image adjustments, needs
the image module's wasm and a placed image and is measured by the latency probe below.

### Interaction latency (production build)

`tests/perf` (the `perf` Playwright project) against `vite build --mode demo` served by
`vite preview`, headless Chromium without a WebGPU adapter, the same server for both builds.
Each panel is driven 12 times per run; the runs alternated before, after, before, after, and
the table pools both (24 interactions per panel). Next frame: from the input to the first frame
after it (the INP-style figure). Settled: from the input to React's last commit for it, the
render worker's round trips included. Renders: every component React rendered for the
interaction, the whole app.

| Panel | n | Next frame median, ms | Next frame p95, ms | Settled median, ms | Commits | Renders per interaction |
|---|---:|---|---|---|---|---|
| Layers (select a frame) | 24 | 14.0 → 8.6 | 17.6 → 15.6 | 4.1 → 4.3 | 6.3 → 6.7 | 981 → 511 (−48%) |
| Pages (jump to a page) | 24 | 14.0 → 14.3 | 16.2 → 15.2 | 234.8 → 234.4 | 27.3 → 27.1 | 8,510 → 5,865 (−31%) |
| Properties (select a frame) | 24 | 9.4 → 7.9 | 16.2 → 17.7 | 6.4 → 5.6 | 6.9 → 6.9 | 2,106 → 692 (−67%) |
| Swatches (fill from a swatch) | 24 | 16.6 → 8.0 | 34.1 → 22.9 | 318.3 → 321.3 | 17.0 → 16.2 | 5,610 → 2,491 (−56%) |
| Image adjustments (move a slider) | 24 | 9.9 → 10.1 | 14.8 → 16.5 | 0.8 → 0.4 | 2.7 → 2.8 | 823 → 279 (−66%) |

What it says: the compiled build renders a third to two thirds fewer components for the same
interactions with the same commits, and the next frame comes sooner where the re-render was
the work (Layers, Swatches). Where the time after the input is spent outside React's rendering
(the page jump's view animation, the swatch fill's round trip to the engine), settled is
unchanged. Both runs agree on the direction of every renders figure. The next-frame medians of
one build move by up to 10 ms between runs on a shared machine, so only the Layers and Swatches
differences hold up; the rest are unchanged.

Both builds measured here still had the FPS hook's per-frame state update (fixed afterwards,
see Coverage). In headless Chromium the rounded rate rarely changes from one frame to the next,
so it cost little there: a build with the fix, measured the same way, renders 510, 5,954, 690,
2,492 and 268 components per interaction, the figures of the "after" column.

### Memo census (the "Memo ✨" check)

React DevTools marks a component whose fiber holds a compiler cache (`updateQueue.memoCache`)
with "Memo ✨". The probe's census reads the same field on every mounted fiber, with the Layers,
Pages, Properties and Swatches panels open and a frame selected: before, 0 of 518 mounted
function components; after, 288 of 518. The rest are third-party components, the recorded
bailouts and components that need no cache. To see it by hand: open the editor's dev server
with the React DevTools extension, open the Components tab and look for the badge beside the
panel components (`LayersPanel`, `PropertiesPanel`, …); `PAGED_REACT_COMPILER=0` takes it
away.

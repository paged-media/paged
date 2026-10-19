# ADR 229 — The React Compiler compiles every first-party React source

- **Status:** Accepted 2026-10-19.
- **Scope:** `tooling/js/react-compiler.mjs` (the one configuration), `tooling/js/react-compiler-coverage.mjs`
  (the ratchet), `tooling/js/bun-react-compiler.ts` (the compiled test lanes),
  `apps/canvas/vite.config.ts` and `apps/devtools/vite.config.ts`, plugin-sdk's
  `scripts/build.mjs`, `platform/shared/react-live`, every `compiler-coverage.json`,
  `.github/workflows/lint.yml` (job `react-compiler`) and `editor-tests.yml` (job `checks`).
  The record of the rollout, with the numbers: [`docs/migration/react-compiler.md`](../../../../docs/migration/react-compiler.md).

## Context

React 19.3, Vite 8 and `@vitejs/plugin-react` 6 are in the tree (U4, U4a). Plugin-react 6 runs
React Refresh in Oxc and has no Babel of its own; Babel plugins, the React Compiler among them, go
through `@rolldown/plugin-babel`, and the plugin exports `reactCompilerPreset` for it.

The compiler memoizes what a component computes on the values the computation READS, and it
treats every value that comes from props, state, context, a hook or the module scope as
immutable. The editor broke that assumption in four recurring ways, and the first compiled run of
the panel DOM lane found each of them (30 failing tests before any fix):

1. **A mutable object with a stable identity, read during render.** The shell's registries, a
   bundle's published bindings, a module's panel store and its session keep their identity while
   their contents change. `menus.list()` or `bindings.get(name)` was re-read because something
   else re-rendered the component; compiled, it is computed once per registry object, that is,
   once. The menu bar, the command palette, the mode switcher, the dock, the schema panels' gates,
   the slide and notes panels and the Word outline all went stale.
2. **A trigger read as a dependency.** A version counter bumped from an `onChange` effect and
   listed in a `useMemo` dependency array it never read (`[menus, version]`), or read with
   `void version`. The compiler depends on what is read, so the counter is not a dependency.
3. **Module state read during render.** The demo box and spotlight read a module `let` after a
   forced re-render; what they derived from it was kept from the first render.
4. **A factory-scoped value.** Module panels are built by a factory that closes over the
   `BundleHost` and the session (`makeXPanel(host)`). To the compiler those are constants, so
   `session.state()` in render is computed once.

It also has a defect: babel-plugin-react-compiler 1.0.0 moves a closure that captures nothing
reactive to MODULE scope, also when the closure captures a variable of the factory that declares
the component. `onClick={() => run(host)}` became a top-level `function _temp() { return
run(host); }` where `host` does not exist; draw's Symbols and Appearance buttons did nothing.

## Decision

1. **One configuration.** `tooling/js/react-compiler.mjs` holds the compiler's options and the
   set of sources it compiles, and everything that runs the compiler reads it: the two Vite
   builds, plugin-sdk's library build, the coverage ratchet and the compiled test preload.
   - babel-plugin-react-compiler 1.0.0 on `@babel/core` 7.29 (the plugin is built against Babel 7's
     AST); `target: "19"`, so the runtime is React's own `react/compiler-runtime` and no
     `react-compiler-runtime` package is installed; `compilationMode: "infer"`;
     `panicThreshold: "none"` (a function the compiler cannot prove stays as written).
   - `environment.enableFunctionOutlining: false`, for the defect above. Outlining only saves a
     cache slot.
   - The sources: the `src` trees of the editor's apps and packages, of every module package, and
     of plugin-sdk; not tests, not type declarations, not the render worker and not
     `packages/client`.
   - `PAGED_REACT_COMPILER=0` turns it off everywhere, for an A/B measurement or to bisect a
     behaviour change to the compiler.
2. **The editor's build compiles the modules.** The bundles are workspace packages that resolve
   to their sources, so the canvas app's Vite build compiles them with the app. The compiler runs
   in `@rolldown/plugin-babel` (`enforce: "pre"`) before Oxc strips the types and the JSX, as the
   only Babel plugin. The build fails unless every module the compiler memoized imports
   `react/compiler-runtime`, there is one copy of it, and every chunk holding compiled code reaches
   the chunk holding the runtime; it reports how many components and hooks it compiled and skipped
   (`PAGED_REACT_COMPILER_REPORT`).
3. **plugin-sdk is compiled ahead of time**, `target: "19"`, before `bun build` (the library
   guidance: a package is compiled once, before publishing). React is an optional peer of
   plugin-sdk and must stay optional at runtime (`src/react-optional.ts`); a memoized component
   would gain a static import of `react/compiler-runtime`. Today nothing there is compiled (its two
   React-touching modules build elements through the `createElement` react-optional hands over),
   the output is byte-identical to the uncompiled build, and the build fails if the output ever
   imports React statically.
4. **Mutable sources are read through a view.** `@paged-media/react-live`
   (`platform/shared/react-live`) provides `useLive(source, listen)`: a view of the source that
   reads through to it and is replaced after every change it reports, so a memo keyed on it,
   hand-written or compiled, recomputes exactly when the source changed. The shell names its use
   for registries `useRegistryView`; the command and keybinding registries gained the `onChange`
   the others had. Render reads go through the view; effects and handlers keep the source.
   Where the value is small or the store already returns snapshots, `useSyncExternalStore`
   returns the value itself (the journal, the demo box, a tool option). A counter that only
   triggers a render is not used for a value read beside it.
5. **Testing both ways.** `bun test` runs the sources as written. The same lanes run compiled
   with the preload `tooling/js/bun-react-compiler.ts` (put last: Bun gives a file to the first
   matching plugin, so a lane's own source plugin hands its result on), and CI runs the shell's
   and the canvas app's DOM lanes that way. The Playwright suites run on the dev server, which
   compiles like the build. The interaction-latency probe (`tests/perf`) runs against the
   production build.
6. **The coverage ratchet.** `tooling/js/react-compiler-coverage.mjs` compiles every source with
   the build's options and logs each function the compiler considers. Every package with React
   code keeps `compiler-coverage.json`: its bailouts (with the compiler's reason) and the
   component-shaped functions the compiler cannot see (`notCompiled`: it names a function only
   from a declaration, a variable, an assignment or an object key, so `return function Panel()`
   is invisible to it). CI fails on a new entry and on a stale one, so the lists only get
   shorter; the target is zero. A `"use no memo"` needs the issue it waits on and an expiry date
   in the comment above it, and fails CI once the date has passed.

## Consequences

- The production bundle ships compiled components: 474 compiled in 204 modules, 76 left as
  written, across the eight chunks that hold first-party React code. With the editor's main
  panels open, 244 of the 518 mounted function components carry a compiler cache (the rest are
  third-party, bailouts, or need no cache).
- A new component that reads a registry, a store or a host surface during render reads it
  through a view (`useRegistryView`, `useLive`) or a store snapshot. The compiled DOM lanes fail
  on the patterns above when a test renders the component.
- `compiler-coverage.json` changes with the code: fixing a bailout, or adding a component the
  compiler cannot see, means running `bun tooling/js/react-compiler-coverage.mjs --write` in the
  same commit.
- Two expected-failure tests of the panel conformance programme (PN-308, PN-351: a registration
  while the panel is open did not show) pass now and are ordinary tests.

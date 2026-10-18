# B7 — bun test replaces vitest; Bun runs the scripts

Every TypeScript unit suite of the workspace ran under vitest: 497 files in twenty packages. B7
moves them to `bun test`, the runner built into the Bun that already installs the workspace
(B1), and moves the repository's scripts from Node to Bun. Node stays only for Playwright's
runner, wrangler and `npm publish`.

This file is the record: per package, the test count before and after, what changed beyond the
codemod, and why.

## The rule for every package flip

A flip is one commit: the codemod, the shims, the refactors and the CI/Moon change of that
package. It is gated on

- `bun test --parallel` running **the same tests** as vitest did on the base: the same count, the
  same skips and no failures. "The same tests" is checked by id: vitest's JUnit report of the
  base and bun's report of the flip, rewritten into vitest's shape (below), list the identical
  set of `classname > name` ids;
- the package's typecheck staying at 0 errors;
- no `vitest` left in the package.

## How the pieces work

- **Codemod** (`tooling/migration/vitest-to-bun.py`): `from "vitest"` → `from "bun:test"`,
  `.fails` → `.failing`, `.runIf` → `.if`, `vi.setConfig({ testTimeout })` →
  `setDefaultTimeout`, and the four `vi` helpers bun lacks → the test kit. It prints what it
  leaves for a person.
- **Test kit** (`platform/shared/test-kit`, private, runner-agnostic; docs/adr/PM-0002):
  `waitFor`, `stubGlobal`/`unstubAllGlobals`, `importActual`, `advanceTimersByTimeAsync`. The
  public packages under `platform/extensions` do not import it (PM-0002); where one of their
  specs needed a helper, the spec carries it.
- **Matcher types** (`tooling/js/bun-test-matchers.d.ts`): bun-types checks `toBe`/`toEqual`
  against the received value's type; vitest accepted anything. Each flipped package lists the file
  in its tsconfig `include`, which restores vitest's contract for type checking only.
- **JUnit** (`tooling/js/bun-junit.mjs`): bun test nests a `<testsuite>` per describe block and
  keeps the spec path only in a `file` attribute. The script rewrites a report into vitest's
  shape (`classname` = spec path relative to the package, `name` = `describe > … > title`), so
  the CI artifacts keep their names *and* their test ids, and the feature registry's test map,
  which matches on those ids, needs no change.
- **Runner flags:** `bun test --parallel` everywhere (a worker per core; every file gets a fresh
  global object and module registry, which vitest's per-file isolation also gave).

## Per package

| Package | vitest (base) | bun test | Same ids | Notes |
|---|---|---|---|---|
| publish-bundle | 13 | 13 | yes | codemod only |
| pdf-bundle | 26 | 26 | yes | codemod only |
| idml-viewer | 27 | 27 | yes | codemod only |
| slide-bundle | 59 | 59 (60 after main) | yes | `vi.waitFor` → test kit (2 files). Main then added B6's test `slides-model.spec.ts` › "a new slide from a layout › takes the new slide's page from the engine's outcome…" (efa3d9597); it runs under bun test too |
| doc-bundle | 41 | 41 | yes | codemod only (`it.fails` → `it.failing`) |
| doc-host-model | 44 | 44 | yes | codemod only |
| image glue | 343 | 343 | yes | 3 `vi.mock` factories with `importOriginal` → `importActual` + `mock.module`; `waitFor` (+ `clock: vi` under fake timers) and `advanceTimersByTimeAsync` → test kit |
| sheet-host-model | 193 | 193 | yes | codemod only |
| sheet-bundle | 335 + 1 skipped | 335 + 1 skipped | yes | 2 `vi.mock` factories (`importActual`/`importOriginal`) → `importActual` + `mock.module` (perf-budgets: its two dynamic imports move out of the factory); `vi.setConfig` → `setDefaultTimeout`; `stubGlobal`, `waitFor`, `advanceTimersByTimeAsync` → test kit |
| web-model | 290 + 9 skipped | 290 + 9 skipped | yes | codemod only; its garbage-input titles carry NUL and U+FFFF, which bun writes raw into its XML — `bun-junit.mjs` drops them as vitest did |
| web-conformance | 103 | 103 | yes | codemod; tsconfig `types` gains `bun` |
| web-bundle | 330 | 330 | yes | `waitFor`, `advanceTimersByTimeAsync` → test kit; `vi.setConfig` → `setDefaultTimeout`; bake.spec refuses `fetch` in one test (below) |
| data-host-model | 53 | 53 | yes | codemod only |
| data-bundle | 383 + 2 skipped | 383 + 2 skipped | yes | 23 files of `vi.resetModules` + `vi.doMock`, 3 of `vi.mock` with `importOriginal` → `mock.module` re-patching (below); duckdb-browser `ctx.skip()` → `it.skipIf`; real DuckDB resolves `apache-arrow` without NODE_PATH; `--timeout 30000` |
| plugin-sdk | 713 | 715 | yes, + 2 | codemod; `modules.spec` stubs `fetch` by hand (a public package does not import the internal kit, PM-0002). The 2 new ids are B6's tests (efa3d9597), merged from main between the base and the flip |
| ai | 31 | 31 | yes | codemod; tsconfig `types` gains `bun` |
| cli | 54 + 1 skipped | 54 + 1 skipped | yes | `vitest.config.ts` deleted: one file at a time and 120 s timeouts become `bun test --timeout 120000` (no `--parallel`); its `server.deps.inline` was a Vite transform bun does not need. `.runIf` → `.if` (with a boolean). The shipped `node-shims.ts` routes DuckDB's worker in-process under Bun too (below) |
| draw-geometry | 681 | 681 | yes | codemod; one `.each` title: vitest's `$name` quoted strings, bun's does not, so the quotes are in the title; 5 bench files → mitata |
| draw-tools | 337 | 337 | yes | codemod; 1 bench file → mitata |
| draw-bundle | 1645 + 34 skipped | 1480 + 34 skipped (main) + 165 (DOM) | yes, with 12 renamed files | the 12 jsdom specs become `test/panels/*.dom.test.tsx` in the DOM task; 3 conformance files' `ctx.skip()` → load-time probes + `it.skipIf`; `expect.poll` → `waitFor`; 1 bench file → mitata |

## Refactors beyond the codemod

### `vi.mock` is not hoisted; `vi.doMock` and `vi.resetModules` do not exist

vitest hoists `vi.mock` above the imports, and `vi.resetModules` + `vi.doMock` + a dynamic
`import()` give a test a fresh copy of the module graph with a mock inside. bun:test has
`mock.module`, which patches a module **in place**, even one that is already loaded: every
importer's live bindings change, and calling it again re-patches. So:

- a top-level `vi.mock(P, async (importOriginal) => ({ ...(await importOriginal()), … }))`
  becomes `const actualX = await importActual(() => import(P))` (the test kit's plain copy of
  the real exports, taken before anything mocks P) and `mock.module(P, () => ({ ...actualX, … }))`;
- each `vi.resetModules(); vi.doMock(P, …)` in a helper becomes `mock.module(P, …)` in the
  same helper, re-patching the one loaded instance. The helper's `await import(…)` of the module
  under test now loads it once and returns that instance afterwards.

`tooling/migration/vitest-domock-to-bun.py` does this mechanically. It changes one thing: the
module graph under test is no longer fresh per test. That is safe only where those modules keep
no state a test relies on being fresh. data-bundle's `src` keeps three module-level values:
`activate.ts`'s sessions and `text-variables.ts`'s detection cache are WeakMaps keyed by the host
(every test makes its own host), and `datamerge-export.ts`'s CRC table is a pure cache. The
mocked modules (`engine`, `query/duckdb`, `merge`) are replaced wholesale per helper call.

### A test that relied on Node not fetching `file:` URLs

web-bundle `bake.spec.ts` › "publishes the render diagnostic and does not throw" tests the
engine-not-loaded path. Under Node the wasm-bindgen glue's bare-relative `fetch` of its wasm
failed, so the engine never loaded in a unit test. Bun's `fetch` reads `file:` URLs, and the
engine loaded. The test now refuses `fetch` (test kit `stubGlobal`) for its own duration, as a
realm without the sibling asset does: same test, same assertion.

### Runtime skips

vitest's test context (`it("…", (ctx) => { if (…) ctx.skip(); })`) has no bun:test
equivalent; a test function's first parameter is a `done` callback there. data-bundle
`duckdb-browser.spec.ts` started its Chromium lane in a `beforeAll` and skipped each test at run
time when it had not started. The lane now starts while the file loads (top-level `await`), and
the same eight tests are `it.skipIf(NO_LANE)`: they skip exactly when they skipped before.

### Real DuckDB without `NODE_PATH`

The Node build of DuckDB-WASM (`modules/data/vendor/duckdb-wasm/dist/duckdb-node-blocking.cjs`,
never shipped) requires `apache-arrow`. Four helpers rewrote `NODE_PATH` and called Node's
private `Module._initPaths()` so that require resolved from data-bundle's `node_modules`; Bun
ignores both, and 106 real-DuckDB tests skipped. `modules/data` now declares `apache-arrow` as a
devDependency, so the require resolves from the vendored file's own location under either
runtime, and the four helpers are a plain `createRequire`.

### Timeouts

bun's describe takes no options object: data-bundle `protocol71-real-core.spec.ts`'s
`describe(…, { timeout: 30_000 }, …)` became `setDefaultTimeout(30_000)` for its file (one
block). data-bundle's whole suite runs with `--timeout 30000`: its real-engine specs boot the
35 MB DuckDB engine, the data engine and the core per test, and JavaScriptCore compiles and runs
that wasm slower than V8 did (the summed test time is about 3× vitest's), so under a full
parallel run several first-in-file tests passed the 5 s default.

### The CLI's DuckDB worker under Bun

`@paged-media/cli` runs paged.data's DuckDB in-process: `node-shims.ts` installs a global
`Worker` whose DuckDB URL becomes DuckDB's own dispatcher over its Node bindings. It did that
only when there was no global `Worker`, which is true under Node and false under Bun, whose real
`Worker` then failed to run DuckDB's browser worker script (every cli-data test timed out). The
shim now always routes the DuckDB URL in-process and hands any other URL to the runtime's own
`Worker` when there is one. Under Node nothing changes.

### A bun:test defect: `toMatchObject` writes into the value under test

In bun 1.4.3, `expect(x).toMatchObject({ k: expect.arrayContaining([…]) })` (any asymmetric
matcher, at any depth) replaces `x.k` with the matcher object. plugin-sdk
`object-model-v71.spec.ts` asserted on a schema row that way and the next call validated against
the overwritten `members` (`type.members.includes is not a function`). bun's equality also treats
a matcher on the *received* side as a matcher, so a later `toEqual` on the damaged value can still
pass. `tooling/js/bun-test-setup.ts`, which every package's `bun test` preloads, wraps the
matcher: it remembers each property of the received value that the expected object reaches, runs
bun's matcher and puts each one back. The test kit's suite proves the wrapper (it fails without
the preload).

### The DOM split (draw-bundle)

The twelve panel specs that declared `// @vitest-environment jsdom` render React panels against
the real engine. They are now `test/panels/<name>.dom.test.tsx` (the docblock is gone) and run in
a separate task, `bun run test:dom`, which preloads `test/happydom.ts` (happy-dom's
`GlobalRegistrator`). The main `bun test` skips them (`--path-ignore-patterns
'**/*.dom.test.*'`), so no other suite sees a global `window`: code that asks `typeof window`
(the wasm boot paths) still knows it is not in a browser. The engine boots under happy-dom as it
did under jsdom (the harness reads the wasm off disk). Triage of jsdom → happy-dom: no spec
needed a change for happy-dom itself; the one failure was `expect.poll`, which bun:test lacks
(now the test kit's `waitFor`, same defaults). The module's `bun run test` runs both tasks, and
draw-vitest.yml concatenates both reports into `vitest-junit`. The rename changes these 165
tests' classnames (`test/panels/x.spec.tsx` → `test/panels/x.dom.test.tsx`); the feature
registry's map is rewritten for it (see the Cockpit proof).

### Runtime skips in draw-bundle

`create-outlines`, `snapping` and `page-space` skipped five cases at run time when the engine
lacked a door (protocol 66 outlines, protocol 67 snapping, page origins). Each file now probes
its engine once while it loads (a throwaway headless host, the same calls the tests make) and
the cases are `it.skipIf` on the result. The `PAGED_REQUIRE_V66`/`V67` switches still turn the
skip into a failure.

### Benchmarks

The seven `*.bench.ts` files (vitest's `bench`) run on [mitata](https://github.com/evanwashere/mitata):
`describe` → mitata's `group`, `bench` unchanged, `await run()` at the end, and each package's
`bench` script runs the files with `bun`. They stay trended, not gated, and run in no CI lane, as
before.

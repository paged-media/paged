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
| slide-bundle | 59 | 59 | yes | `vi.waitFor` → test kit (2 files) |
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

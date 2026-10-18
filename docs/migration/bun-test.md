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

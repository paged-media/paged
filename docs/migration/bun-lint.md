# B8 — bun lint replaces ESLint (one root config, boundaries and Rules of React enforced)

Before B8, the editor was the only component with a linter (ESLint 9, `apps/editor/eslint.config.mjs`),
and seven modules each checked their imports with a copy of `scripts/check-contract-imports.mjs`.
After B8, one config in `/bunfig.toml` `[lint]` covers the whole repository, and `bun lint` runs it.
Decision record: [PM-0003](../adr/PM-0003-one-lint-config.md).

This file is the record: the parity gate that had to pass before ESLint left, what the new rules
found, the timings, and what is left for later.

## Commands

```bash
bun run lint                       # the whole repository (tooling/js/bun-canary.sh lint --no-script)
bun run lint:fix                   # the same, with --fix
bun run lint:selftest              # every boundary fires, every allowed import stays allowed
tooling/js/bun-canary.sh lint --no-script modules/draw   # one directory
moon run draw:lint                 # Moon's js-lint task, from anywhere
git config core.hooksPath tooling/git/hooks   # opt in to the pre-commit hook (bun lint --staged --fix)
```

After fixing a recorded Rules-of-React finding, prune the record in the same commit:
`tooling/js/bun-canary.sh lint --no-script --prune-suppressions`. CI fails while a recorded finding
no longer occurs, so the file cannot drift.

## The pinned canary

`bun lint` is in Bun's canary builds only, not in the stable 1.4.3 that `.prototools` pins as the
runtime and package manager. `tooling/js/bun-canary.sh` runs `bunx bun@<version>`, with the
version in `tooling/js/bun-canary.version`: `1.4.3-canary.20261018.1`, an exact, immutable npm
version. Bun is not added as a dependency, because `node_modules/.bin/bun` would shadow the
runtime inside every `bun run` script.

- That npm canary reports the revision `1.4.4-canary.1+ed680823c`, the same build as a locally
  installed canary. Its findings on the whole repository are byte-identical to that build's (same
  files, lines, columns, rules and messages).
- `bunx` keeps the package in Bun's cache and writes nothing into the repository.
- A stable Bun 1.4.3 reads the `[lint]` section and ignores it: `bun install`, `bun run` and
  `bun test` behave as before.
- **Switching to stable:** when a stable Bun ships `bun lint` (and `bun fmt`), pin it in
  `.prototools`, replace `tooling/js/bun-canary.sh lint` with `bun lint` in `package.json`,
  `.moon/tasks/node.yml`, `.github/workflows/lint.yml` and `tooling/git/hooks/pre-commit`, and
  delete the wrapper. Then run the self-test again.

## The config

- **No package is loaded to read it.** `bun lint --doctor` reports 82 rules on: 60 eslint, 17
  react-hooks and 5 @typescript-eslint. It names no package as still needed. ESLint, `@eslint/js`,
  `globals` and `typescript-eslint` (with typescript-eslint's parser and plugin) are removed from
  the workspace: 188 lockfile lines.
- **Categories off, rules listed.** Bun turns some rules on by default: the `bun:test/*` rules,
  `no-octal` at warn, `react/jsx-uses-react`. Here everything is explicit.
- **ESLint's option defaults are written out.** Under a bunfig config, bun lint applies its own
  defaults, and some are looser than ESLint's:
  - `no-irregular-whitespace` skips regular expressions, comments and templates;
  - `no-loss-of-precision` skips decimals;
  - `no-empty-pattern` allows `{}` parameters;
  - `no-constant-binary-expression` allows a literal on the left of `&&` or `||`;
  - `no-fallthrough` also accepts "no break" comments.

  The parity runs found the first of these (4 findings ESLint had and bun lint did not). After
  that, the effective config of each zone matches ESLint's rule for rule (`bun lint
  --print-config` against `eslint --print-config`).
- **Four rules use the typescript-eslint version on TypeScript files.** bun lint runs it for
  `no-dupe-class-members`, `no-loss-of-precision`, `no-redeclare` and
  `no-unused-private-class-members`, as typescript-eslint's own config does. The seeded parity
  run gives the same findings for all four.
- **Ignored:**
  - `**/*.jsx`: 78 ExtendScript files that InDesign, Illustrator and Photoshop run. ESLint's
    globs never matched them, and bun lint finds `.jsx` by default.
  - Type declarations (`*.d.ts`, `*.d.mts`, `*.d.cts`).
  - The committed pdfium prebuilt.
  - Build output.

## Parity gate (before ESLint was removed)

The same tree, with ESLint 9.39.4 and the editor's `eslint.config.mjs` against bun lint and
`/bunfig.toml`. Each run compares the set of (file, line, rule) findings, with
`@typescript-eslint/X` read as `X`. The Rules of React are left out of these runs, because ESLint's
config never had them.

Only one package had an ESLint config: `apps/editor`. Its sub-packages' `lint` scripts (`eslint
src`) ran the same config. Both tools list the same 1,040 files.

| Tree | Run | Files | ESLint | bun lint | Same set |
|---|---|---:|---:|---:|---|
| `apps/editor` | as it is | 1,040 | 0 | 0 | yes |
| `apps/editor` | inline config ignored (`--no-inline-config`) | 1,040 | 1 | 1 | yes |
| `apps/editor` | violations seeded into 3 files of each zone (see below) | 30 | 1,299 | 1,299 | yes |
| rest of the repository (ESLint run with the editor's config) | as it is | 1,064 | 4 | 4 | yes |
| rest of the repository | inline config ignored | 1,064 | 10 | 10 | yes |

The clean editor run, per sub-package. Both tools report 0 findings in each:

| Sub-package | Files |
|---|---:|
| `apps/canvas` | 778 |
| `packages/shell` | 177 |
| `packages/tools` | 22 |
| `packages/ui` | 17 |
| `packages/client` | 12 |
| `packages/repository` | 8 |
| `apps/devtools` | 7 |
| `packages/catalog` | 3 |
| the editor's root (scripts, configs) | 16 |

**The seeded run.** Each of 30 real files got an appended block. The files were 3 each from:
- the worker, `packages/client`, `packages/tools` and `packages/shell`;
- `apps/canvas`, `packages/ui`, `packages/catalog` and `apps/devtools`;
- the editor's scripts (`.mjs`) and the Playwright tests.

The block held:
- imports that each zone forbids or allows;
- one violation of each of 27 correctness rules, including the option-sensitive ones: a raw
  NBSP in a regex, a template and a comment; a decimal that loses precision; a `{}` parameter;
  `true && x`; and three fall-through comments in different spellings.

ESLint and bun lint reported the same findings for each rule: `no-restricted-imports` 69,
`no-empty` 210, `no-constant-binary-expression` 90, `no-irregular-whitespace` 90, `no-fallthrough`
60, `no-loss-of-precision` 60, and 30 for each of the other 22. The files were restored afterwards.

**The rest of the repository.** It never had a linter. Its 10 findings, with inline config
ignored, were these:
- 4 `no-irregular-whitespace`: raw U+FEFF or U+00A0 inside a regular expression. They became
  `﻿` and ` `, which is the same expression.
- 4 `no-control-regex`: two ASCII checks in data tests, and the XML sanitiser in
  `tooling/js/bun-junit.mjs`.
- 2 `no-redeclare`: a value and a type that share a name on purpose, in image's `session.ts`.

The last six are deliberate. Each has a disable comment that gives the reason.

**The contract checks.** Each deleted script was run against the new rule, first on the tree as
it is and then with a seeded file in each module's sources. The seeded file had an editor
import, a deep re-export, a type-only third-party import, a contract import and React.

| Module | Script (as it is) | bun lint (as it is) | Script (seeded) | bun lint (seeded) |
|---|---|---|---|---|
| data, doc, draw, image, sheet, slide, web | clean | clean | `@paged-media/shell`, `@paged-media/client/x`, `lodash` | the same three |

The rule sees more than the scripts' regular expression did: side-effect imports (`import "x"`)
and `import x = require()`. The tree has none that it forbids. The allow-lists are the scripts'
own, tightened from a bare prefix to "the package or a subpath" (`react` no longer admits
`reactfoo`), with `react-dom` admitted next to `react`. publish, which had no script, has the
rule too.

## The self-test

`tooling/js/lint-selftest.mjs` replaces `apps/editor/scripts/eslint-boundaries-selftest.mjs`. It
pipes each case into `bun lint --stdin` under a synthetic path, so the real config decides. 293
cases, 137 must fire and 156 must stay silent; 1.2 s on 8 workers.

- **The editor:** the nine cases of the ESLint self-test (fixtures in
  `tooling/js/lint-selftest/`), the shell importing its own internals, and a worker deep import.
- **The modules:** every module's allow-list entries, and what it must not import (the editor's
  packages, another module, look-alike names, third-party), as import, re-export, type-only and
  side-effect import. Its tests and non-`src` files stay exempt.
- **The extensions:** the contract over `plugin-sdk`, `plugin-api`, a test and a script.
- **`platform/shared/*`:** every package, read from disk: allowed in each module, forbidden in
  extensions.
- **The rule set:** the Rules of React (`rules-of-hooks`, `purity`, `exhaustive-deps`) and a
  correctness rule.

Breaking the config fails it. Each of these was tried by hand: a typo in the worker zone's glob
(2 cases fail), a module allow-list without `test-kit` (1), an extension rule that admits
`test-kit` (4).

## Rules of React

The editor registered `react-hooks/exhaustive-deps` as a no-op stub, so no Rules of React ran
anywhere. All 17 rules of eslint-plugin-react-hooks 7.1.1's `recommended-latest` set run natively
in bun lint. That includes the compiler's checks: `purity`, `refs`, `immutability`,
`set-state-in-render`, `set-state-in-effect`, `static-components`, `use-memo` and
`preserve-manual-memoization`. Every rule is an error. Turning them on found:

- **28 of the 33 existing `exhaustive-deps` disable comments suppress a real finding.** 27 are in
  the editor and 1 in web. They stay.
- **5 disable nothing.** They are in the editor's `main.tsx`, the guide-drag and threading
  controllers, doc's outline panel and image's panel. They were removed with
  `--fix --fix-type directive`.
- **194 findings in 73 files.** None is a mechanical fix: each one changes when an effect runs or
  what a component reads during render. So they are recorded in `eslint-suppressions.json` with
  `--suppress-all`, not fixed and not switched off.

| Package | Files | refs | set-state-in-effect | exhaustive-deps | purity | rules-of-hooks | immutability | Total |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `apps/editor/packages/shell` | 31 | 59 | 24 | 7 | 0 | 1 | 0 | 91 |
| `apps/editor/apps/canvas` | 30 | 27 | 22 | 7 | 4 | 1 | 1 | 62 |
| `apps/editor/packages/ui` | 4 | 17 | 1 | 0 | 0 | 0 | 0 | 18 |
| `modules/web/packages/web-bundle` | 1 | 0 | 0 | 14 | 0 | 0 | 0 | 14 |
| `modules/sheet/packages/sheet-bundle` | 2 | 0 | 0 | 4 | 0 | 0 | 0 | 4 |
| `apps/editor/apps/devtools` | 2 | 0 | 2 | 0 | 0 | 0 | 0 | 2 |
| `modules/data/packages/data-bundle` | 1 | 0 | 0 | 1 | 0 | 0 | 0 | 1 |
| `modules/draw/packages/draw-bundle` | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 1 |
| `modules/slide/packages/slide-bundle` | 1 | 0 | 0 | 1 | 0 | 0 | 0 | 1 |
| **all** | **73** | **104** | **49** | **34** | **4** | **2** | **1** | **194** |

**194 is the starting point of the React Compiler ratchet** (wave R, step R0). CI is an error gate
for any new finding. The other packages (doc, image, the extensions, the editor's client, tools,
catalog and repository) have none.

## Timings

The same machine (16 cores) and the same tree; wall time, including bunx's start-up.

| Run | ESLint 9 | bun lint |
|---|---:|---:|
| `apps/editor` (1,040 files), first run | 35.9 s; 67.7 s after a large merge | — |
| `apps/editor`, repeated | 5.3–9.0 s | 0.15–0.18 s |
| whole repository (2,096 files), first run | — | 5.1 s |
| whole repository, repeated | — | 0.2–2.2 s |
| self-test (293 cases) | — | 1.2 s |

Before B8, the step's own measurement on the editor was ESLint 76.8 s against bun lint 2.9 s,
both first runs.

## Type-aware linting (evaluated, not enabled)

`--type-aware` (`typeAware = true`) adds no rule by itself: it runs the type-aware rules that are
turned on, and this config turns none on. It was measured with typescript-eslint's
`recommended-type-checked` rules turned on:

| Rules | First run | Repeated | Peak memory | Findings |
|---|---:|---:|---:|---:|
| all 23 of `recommended-type-checked` | 32.1 s | 0.8–2.2 s | 1.4–1.6 GB | 15,158 in 851 files |
| the promise and correctness subset: `no-floating-promises`, `await-thenable`, `no-misused-promises`, `no-implied-eval`, `only-throw-error`, `no-unsafe-unary-minus`, `no-duplicate-type-constituents`, `no-for-in-array`, `no-array-delete` | — | 1.5 s | 1.5 GB | 109 in 45 files |

- **The full set** is dominated by the `no-unsafe-*` family (`any` flowing through): member-access
  5,260, call 2,931, assignment 2,454, argument 637, return 498. The remaining large counts are
  `no-unnecessary-type-assertion` (1,720) and `require-await` (856).
- **The subset** found `no-floating-promises` 48, `await-thenable` 41, `no-misused-promises` 6,
  `no-implied-eval` 6, `only-throw-error` 4, `no-unsafe-unary-minus` 2 and
  `no-duplicate-type-constituents` 2.

**Why it is not on.** The time is acceptable: a cold CI run would take about 30 s. But the
results depend on build outputs. The engine's wasm packages provide their `.d.ts` only after
`.github/actions/engine-wasm` has built them. Without them those imports are untyped, so the
findings differ between a fresh checkout, a CI job and a developer's tree. The lint job and the
pre-commit hook must not depend on that.

The candidate is a separate CI lane after the engine-wasm build, with the promise subset and its
109 findings recorded. That is its own decision.

## Differences from ESLint worth knowing

- **Comments for rules that are off.** bun lint does not report a disable comment that names a
  rule this config leaves off, or a rule that does not exist. ESLint reports both. 137 such
  comments stay (`no-console` 109, `@typescript-eslint/no-explicit-any` 22, `no-new-func` 5,
  `no-new` 1). They name real rules that are off, and they take effect again if one of those
  rules is turned on. A comment for a rule that is on, but that disables nothing, is an error.
- **A nested ESLint config wins.** An `eslint.config.*` in the working directory or below takes
  precedence over `bunfig.toml` for the files under it. The repository has none, and the
  self-test would fail if one came back.
- **Test files.** Test files are linted with the same rules, whether they import `vitest` or
  `bun:test`. No test-runner globals are configured, because `no-undef` is off. That held
  through B7's migration on main.

## What was removed

- `apps/editor/eslint.config.mjs`, with its stub plugins, and
  `apps/editor/scripts/eslint-boundaries-selftest.mjs`.
- `modules/{data,doc,draw,image,sheet,slide,web}/scripts/check-contract-imports.mjs`, and:
  - their `lint:contract` scripts and the copies in each module's `test` script;
  - their Moon `js-lint` overrides;
  - 11 CI steps (the module workflows and their publish jobs).
- The editor's devDependencies `eslint`, `@eslint/js`, `globals` and `typescript-eslint`.
- The `lint` scripts of the editor and its seven sub-packages.
- editor-tests' two ESLint steps. `lint.yml` runs the whole repository instead.
- 38 disable comments for the stub rules: 35 `import/no-relative-parent-imports` and 3
  `react/no-array-index-key`. ESLint's `--report-unused-disable-directives` listed all 38 as
  unused.

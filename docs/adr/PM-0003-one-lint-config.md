# PM-0003 — One root lint config: bun lint, with the boundaries enforced

- **Status:** Accepted 2026-10-18.
- **Amends:** apps/editor ADR 206 (the four import zones and their self-test now live in
  `/bunfig.toml` and `tooling/js/lint-selftest.mjs`); platform/extensions ADR 315 and
  modules/draw ADR 350 (the contract-import check is a lint rule, not a script per module).
- **Scope:** `/bunfig.toml` `[lint]`, `/eslint-suppressions.json`, `tooling/js/bun-canary.sh`
  and `bun-canary.version`, `tooling/js/lint-selftest.mjs`, `tooling/git/hooks/pre-commit`,
  `.github/workflows/lint.yml`, the Moon `js-lint` task.

## Context

- **Only the editor had a linter.** It ran ESLint 9 with typescript-eslint's parser and a
  boundaries-only config (ADR 206): ESLint's `recommended` rules and four import zones. Three
  no-op stub plugins kept the tree's disable comments for rules it never ran from erroring:
  `react-hooks/exhaustive-deps`, `import/no-relative-parent-imports` and
  `react/no-array-index-key`. So the Rules of React were checked nowhere.
- **Seven modules each had a copy of `scripts/check-contract-imports.mjs`.** It ran a regular
  expression over the `import … from` lines in `packages/*/src`, with that module's allow-list.
  publish had no copy. `platform/extensions` had no check at all, although PM-0002 says that
  community-facing packages never import built-in internals or `platform/shared/*`.
- **ESLint was slow, and it blocks TypeScript 7.** It took 36–77 s cold (5–9 s warm) on the
  editor's 1,040 files. typescript-eslint needs `typescript <6.1`, and TypeScript 7's package
  has no JavaScript API.
- **bun lint can replace it.** Bun's canary builds (October 2026) have `bun lint`. It runs
  ESLint's core rules, typescript-eslint's rules and eslint-plugin-react-hooks 7.1 natively,
  the React Compiler's checks included. It reads a `[lint]` section in `bunfig.toml` with
  per-directory overrides, and it supports ESLint's bulk suppressions.

## Decision

- **One config, native to bun lint.** `/bunfig.toml` `[lint]` is the lint config for every
  JavaScript and TypeScript file in the repository. No ESLint, typescript-eslint, `@eslint/js`,
  `globals` or plugin package is installed or loaded. Every category is off and every rule is
  listed, so a Bun upgrade cannot turn a rule on. Where Bun's defaults for a rule's options
  differ from ESLint's, ESLint's are written out. The config holds correctness rules and
  import boundaries only; formatting belongs to `bun fmt`.
- **What is checked:**
  - ESLint's `recommended` set, without `no-unused-vars` and `no-undef`, which the
    TypeScript compiler checks;
  - eslint-plugin-react-hooks 7.1's `recommended-latest` set, every rule an error;
  - the editor's four zones, as before (ADR 206);
  - **built-ins:** a module's package sources (tests excluded) import only the extension
    contract, `platform/shared/*`, their own packages, React and the third-party packages
    listed for that module. Every module has this rule, publish included;
  - **extensions:** everything in `platform/extensions`, tests and scripts included, imports
    only the public `@paged-media` packages (`plugin-api`, `plugin-sdk`, `idml-viewer`,
    `canvas-wasm`) and its own packages.
- **Existing findings are recorded, not switched off.** The Rules of React findings that
  existed when the rules were turned on are in `eslint-suppressions.json`. CI fails on a new
  finding. It also fails on a recorded one that no longer occurs, until the file is pruned, so
  the count only goes down.
- **One pinned canary.** `bun lint` is in no stable Bun release yet, so
  `tooling/js/bun-canary.sh` runs `bunx bun@<version>`, with the exact, immutable npm canary
  named in `tooling/js/bun-canary.version`. The runtime and package manager stay on the Bun in
  `.prototools`. Bun is deliberately not a dependency: a `node_modules/.bin/bun` would shadow
  the runtime inside every `bun run` script. When the first stable Bun with `bun lint` (and
  `bun fmt`) is released, pin it in `.prototools`, call `bun lint` directly, and delete the
  wrapper.
- **The boundaries are proven, not trusted.** `tooling/js/lint-selftest.mjs` lints small
  sources under synthetic paths through the real config. Every boundary must fire, and every
  allowed import must stay silent. It reads `platform/shared/*` from disk, so a new shared
  package that the module allow-lists don't name fails it.
- **ESLint left only after a parity gate.** On the same tree, bun lint and ESLint reported the
  same file, line and rule for every finding. The tree was compared as it is, with violations
  seeded into every zone, and with inline config ignored. The tables are in
  `docs/migration/bun-lint.md`.
- **Where it runs:**
  - **CI:** `lint.yml` lints the whole repository (GitHub annotations, plus a JUnit artifact)
    and runs the self-test. It needs no install.
  - **Moon:** a `js-lint` task in every node project.
  - **Pre-commit:** an opt-in hook runs `bun lint --staged --fix`.
- **Type-aware linting is not on.** It was measured and left for a separate decision. Its
  results depend on build outputs (the engine's wasm type declarations) that the lint job does
  not build.

## Consequences

- The whole repository lints in under 3 s when warm (5 s on a first run). The editor takes
  0.2 s, where ESLint took 5–77 s.
- **Two changes that need a config edit:**
  - **A new package under `platform/shared/*`:** add it to the modules' allow-lists. The
    self-test fails until then.
  - **A new module:** add it as an override and as a self-test entry.
- The lint result depends on a canary build, but only on the exact version named in one
  file. A behaviour change arrives only when that version is edited, and the self-test runs
  again then.
- bun lint does not report a disable comment that names a rule this config leaves off. ESLint
  does. The 137 comments of this kind are kept, because they name real rules that are off:
  `no-console` (109), `@typescript-eslint/no-explicit-any` (22), `no-new-func` (5) and
  `no-new` (1). They take effect again if one of those rules is turned on.

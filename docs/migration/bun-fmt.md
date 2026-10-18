# B9 — `bun fmt`

Before B9 nothing in the repository was formatted: no Prettier config, dependency, script or CI
step existed in any of the former repositories, although the editor's ESLint config said
"prettier owns the rest". The editor's `CLAUDE.md` told contributors to "format only files you
touched", because a repository-wide pass rewrote unrelated files. B9 brings in `bun fmt` with
Prettier 3's defaults, an ignore list, a CI check, a pre-commit hook and a script that does the
one-time mass format one component at a time.

## Running it

| | |
|---|---|
| `tooling/js/fmt.sh [path …]` | format (the whole repository by default) |
| `tooling/js/fmt.sh --check [path …]` | check; exit 1 = a file needs formatting, exit 2 = a file could not be formatted |
| `tooling/js/fmt.sh --staged` | format the staged files and stage them again (the pre-commit hook) |
| `moon run <project>:js-fmt` | the check over one project; also part of `moon run <project>:fmt` |
| `.github/workflows/fmt.yml` | the check over the whole repository on every pull request and push to main |
| `git config core.hooksPath tooling/git/hooks` | once per clone: the pre-commit hook |

**Pinned canary.** `bun fmt` is on Bun's main branch but not in a stable release; the repository's
runtime and package manager stay on the proto-pinned Bun 1.4.3. `tooling/js/bun-canary.sh` runs
any command on the canary named in `tooling/js/bun-canary-version` (`1.4.3-canary.20261018.1`,
build `ed680823c`) through `bunx`. An npm canary is an exact, immutable build, so every machine and
CI formats alike. That file is the one place the version is written; `bun lint` (B8) uses the same
runner. `bun` is not a dependency of any package: `node_modules/.bin/bun` would shadow the runtime.
Verified: the npm canary and a locally installed canary of the same build produce byte-identical
output over 1682 changed files. When a stable Bun ships `bun fmt`, pin it in `.prototools`, call
`bun fmt` directly and delete the runner and the version file.

**Why a wrapper.** bun fmt reads `.prettierignore` and the `.gitignore` of the directory it runs
in, not the nested `.gitignore` files. Run directly, it would format the build outputs those
exclude (the wasm-bindgen glue under `engine/core/packages/*`, every module's `bin/` and `wasm/`,
`dist/`): 107 such files in a built tree. Two alternatives were measured and rejected: passing the
nested files with `--ignore-path` applies their unanchored patterns repository-wide (so the `*` in
`engine/core/corpus/fonts/local/.gitignore` would exclude everything), and the `ignorePath` key
replaces the default ignore files instead of adding to them. `fmt.sh` runs from the repository
root and hands bun fmt git's own file list (tracked, plus untracked files no `.gitignore`
excludes); bun fmt still skips a file `.prettierignore` names even when it is named explicitly.
The last section of `.prettierignore` repeats the nested ignores, so a direct run selects the
same 2451 files.

**Fixed point.** bun fmt is not idempotent on every file: on 3 of the 1682 files a first pass
changed (member chains such as `test.info().annotations.push({…})`), a second pass wraps
differently, and a third changes nothing. `fmt.sh` therefore formats until its own `--check`
passes (at most three passes), so what it writes `--check` accepts. `--staged` runs twice.

**Hook.** Moon does not manage git hooks here (`.moon/workspace.yml` `vcs.sync: false`), so the
hook is a tracked script enabled through `core.hooksPath`. It is the one commit-time hook: B8's
`bun lint --staged --fix` goes into the same script, before the formatter. A staged file that also
has unstaged changes stops the commit (bun fmt exit 2) instead of committing the unstaged part;
`git commit --no-verify` skips the hook.

## Config: Prettier 3's defaults

`bunfig.toml` `[fmt]` writes every default out (printWidth 80, tabWidth 2, semi, double quotes,
quoteProps as-needed, trailingComma all, bracketSpacing, arrowParens always, objectWrap preserve,
proseWrap preserve, endOfLine lf, …) so that a later change of a default cannot reformat the
repository without a diff to this file. It formats identically to no config (71 files compared).
Each default was measured against its alternative on the TypeScript and JavaScript of the editor,
the modules, the SDK and the engine's packages (the count of existing lines a format rewrites):

| option | lines rewritten | alternative |
|---|---|---|
| printWidth 80 | 34.5k | 100: 41.4k; 120: 54.9k |
| trailingComma all | 34.5k | es5: 43.8k |
| arrowParens always | 34.5k | avoid: 40.8k |
| objectWrap preserve | 34.5k | collapse: 36.4k |

The code was written to roughly 80 columns (4.5% of lines are longer) with double quotes (7322
imports, none single-quoted), so the defaults fit it best.

`bun fmt --doctor` with this config: 2452 files formatted natively, none through Prettier, none
left unformatted, no plugins, no unsupported options, no packages to add or remove.

## What is not formatted, and why

`/.prettierignore`, by category. `bun fmt --debug-check` (fail if formatting changes what a file
means) passes over every file before the ignore list, so the exclusions are about bytes, owners
and churn, not about broken output — except ExtendScript.

| category | entries | reason |
|---|---|---|
| Generated, byte-checked | plugin-api `src/wire.d.ts`, `src/catalog.json`, `catalog.provenance.json`; plugin-sdk `core-commands.generated.ts`; the editor's `packages/client/api-catalog.json` and vendored `scripts/feat-vocabulary.json`; the viewer's `api-catalog.json`; `paged-cli/cli.json`, `paged-introspect/catalog.json`, `census.json`, `idml-coverage*.json`; image's `object-model/` files and generated schema; web-conformance's InDesign `scripts/` | a check compares them byte for byte with their generator (`sync-wire --check`, `sync-catalog --check`, `gen-core-commands --check`, `client-api-catalog --check`, Rust tests against `serde_json` output, `toBe` on the file) — regenerate them instead |
| Machine-written records | the showcase ledgers and coverage (`apps/editor/apps/canvas/showcase/`), web's `PARITY.md` | a tool rewrites them on every run |
| Test data | `**/fixtures/`, `**/*-fixtures/`, `**/corpus/`, `**/golden/`, `**/recorded/`, `**/recorded-*/`, `**/answers/`, snapshots, `*.baselines.json`, `*baseline*.json`, `*.expected.json`, the modules' conformance JSON, the InDesign probe answers, the showcase's input assets and thresholds | their bytes are the test; several are rewritten by the test that reads them |
| ExtendScript | `**/*.jsx` | every `.jsx` here is an InDesign/Illustrator/Photoshop script (ES3); Prettier writes trailing commas in object literals and calls that ExtendScript may not parse, and nothing in CI runs them. React code is `.tsx` |
| Registries | `modules/*/registry/` | `image-kernels/build.rs` and `registry_drift.rs` parse `kernels.yaml` line by line; the sheet/data build scripts deserialize `functions/*.yaml`; all feed the wasm `SOURCE_HASH`; Prettier would rewrap long flow sequences over four lines |
| Third-party, lockfiles | DuckDB and paged-ooxml `vendor/`, pdfium (`pdf-bundle/bin/`), hyphenation `patterns/`, `bun.lock`, `Cargo.lock`, `.protolock` | not ours to rewrite |
| Legal texts | `LICENSE*`, `NOTICE*`, `CLA.md` | |
| History | `**/docs/adr/`, `docs/migration/`, `tooling/import/` | records are not rewritten |
| TOML | `*.toml` except `/bunfig.toml` | every TOML file belongs to Rust tooling (Cargo.toml, rust-toolchain.toml, .cargo/config.toml, deny.toml, nextest.toml) or a Rust tool's data. A dry run changed 26 of them, whitespace only (4-space arrays to 2, long inline tables wrapped; `--debug-check` passes), but cargo and toml_edit write the 4-space form back, the modules' `source-hash.mjs` read `Cargo.toml` line by line, and the open Rust chains edit those files |
| Build outputs | `dist/`, `target/`, the wasm-bindgen glue, the modules' `bin/` and `wasm/`, … | gitignored by nested `.gitignore` files that bun fmt does not read (see "Why a wrapper") |

Checked and kept in: `tsconfig*.json` stay strict JSON after formatting (bun fmt adds no trailing
commas to them); `wrangler.jsonc` gains trailing commas, which wrangler's JSONC parser accepts; no
source uses `css`/`html`/`graphql`/`markdown` tagged templates, whose content Prettier would
rewrite; there are no text snapshots.

## The mass format

`tooling/js/mass-format.sh <component>` formats one component and commits it alone, with the
fixed subject `fmt: <component> (bun fmt, no other change)`, after `--debug-check` has passed and
on a clean tree only. Components are each directory under `engine/`, `apps/`, `platform/` and
`modules/`, plus `tooling` and `root` (the root files, `docs/`, `.github/`, `.moon/`).
`--record` then appends those commits to `.git-blame-ignore-revs` in a commit of its own (GitHub
reads it; locally `git config blame.ignoreRevsFile .git-blame-ignore-revs`). Run it on the final
main and push the component commits and the record commit together: a rebase changes the hashes,
and the contract guard (below) needs the format commits in the same range. A second run commits
nothing (verified: all 15 components "already formatted", `--record` "already lists every
mass-format commit").

Trial run (2026-10-18, on main `2c033d49a`, the commit that brought B9's infrastructure in;
branch `b9/mass-format-trial`, not pushed):

| component | files | lines + / − | time |
|---|---:|---:|---:|
| engine/core | 37 | 891 / 770 | 1.3 s |
| apps/editor | 737 | 30,035 / 11,625 | 4.2 s |
| apps/server | 4 | 77 / 78 | 0.8 s |
| platform/extensions | 141 | 11,732 / 3,313 | 1.8 s |
| platform/shared | 6 | 117 / 44 | 0.8 s |
| modules/data | 136 | 13,223 / 5,417 | 1.6 s |
| modules/doc | 37 | 2,421 / 1,063 | 0.9 s |
| modules/draw | 275 | 13,343 / 5,243 | 3.6 s |
| modules/image | 82 | 3,884 / 1,429 | 2.0 s |
| modules/publish | 25 | 548 / 201 | 1.8 s |
| modules/sheet | 99 | 8,953 / 4,521 | 1.6 s |
| modules/slide | 30 | 1,627 / 469 | 1.2 s |
| modules/web | 132 | 7,118 / 3,101 | 2.8 s |
| tooling | 4 | 102 / 23 | 1.4 s |
| root | 19 | 196 / 184 | 1.5 s |
| **total** | **1764** | **94,267 / 37,481** | **27.3 s** |

Two earlier trials on main `c533db244` (1761 files) found the problems below, which B9's commits
fix; between them, the only differences were those fixes. After the run above, `fmt.sh --check`
over the whole repository exits 0.

### What the trial found

- **Two checks read source text with layout-dependent patterns** and failed after formatting.
  Both are fixed in B9's commits, so they pass on both layouts: `client-api-catalog.mjs` (the
  `PROTOCOL_VERSION` pattern, and `signatureAt()` cutting `Promise<{ … }>` at the `{`; its
  regenerated catalog is now byte-identical from the unformatted and the formatted sources), and
  plugin-sdk's `object-model-fixups.spec.ts` (a one-line `const ROW_PATH = /…/;`).
- **The contract guard** (`assert-contract-bumped.mjs`) fails a range that changes plugin-api's
  or plugin-sdk's `src/` without a version bump, so the mass format would have forced canaries
  that differ by layout alone. A commit with the mass-format subject, or one listed in
  `.git-blame-ignore-revs`, is now exempt; any other change in the range still needs its bump
  (tested: format-only passes, format plus a real change fails, an unlisted change fails).
- **Not run here:** the editor's Playwright projects. Their source-text readers were checked by
  hand: the icon registry spec extracts the same 160 glyph keys and 44 paints from the formatted
  files; the capability matrix reads the engine's generated `.d.ts` (not formatted); the plugin
  surface specs parse manifests as JSON.
- Two web-model specs (`test/fonts.spec.ts`, `test/transform.spec.ts`) hold literal NUL and
  U+FFFF characters, so git shows their diffs as binary; the format keeps those bytes, in order.
- The modules' `package-hash.mjs` hash the bundles' sources, so the format changes them. Their
  publish workflows are disabled (PM-0008); a module that publishes again needs a version bump
  then.

### Verification (trial)

Same tree, same generated wasm (copied, `SOURCE_HASH` fresh for image, sheet, web and data),
before and after the format:

| check | before | after |
|---|---|---|
| `bun run --filter '*' typecheck` (`bun check`) | 0 errors (50 runs, 5889 files) | same |
| `apps/editor/apps/canvas` `typecheck:tests` | 0 errors | same |
| the packages' test suites (below; `test`, plus draw's `test:dom` and data's `test:e2e`, `test:duckdb`) | 5738 pass, 55 skip, 0 fail | same, suite by suite |
| the editor's script tests (`test:boot-coi`, `network-policy`, `modules`, `spread-pages`, `journal`, `object-model`) | 91 pass, 0 fail; `test:object-model` exits 1 after its 28 pass (Node wants a JSON import attribute; already so on main) | same |
| the editor's guards (`surface-coverage`, `seam-guard`, `applicability`, `feat-vocabulary`, `solo-profiles`, `wasm-budget`, `thresholds`) | pass | same output |
| the modules' `check-contract-imports.mjs` (7) | pass | same |
| `sync-wire.mjs --check`, `sync-catalog.mjs --check`, `gen-core-commands.mjs --check` | pass | same |
| `client-api-catalog.mjs --check` | pass | pass (with the fix above; failed before it) |
| `assert-contract-bumped.mjs`, `assert-untyped-shrinks.mjs` | pass | pass (the format commits are exempt) |
| `check-workspace-deps.mjs`, `check-wasm-package-versions.mjs`, `sync-ooxml.sh --check`, `paged-plugin validate` | pass | same |
| vite build: the editor's canvas and devtools apps | pass | pass |
| `tooling/js/fmt.sh --check`, whole repository | 1764 files need formatting (CI reports the same) | exit 0 |
| excluded or byte-checked files the format touched | | none |

| suite | runner | before = after |
|---|---|---|
| `apps/editor/packages/repository` | node --test | 8 pass, 2 skip, 0 fail |
| `engine/core/web/idml-viewer` | bun test | 27 pass, 0 skip, 0 fail |
| `modules/data/packages/data-bundle` | bun test | 383 pass, 2 skip, 0 fail |
| `modules/data/packages/data-bundle` (`test:duckdb`) | bun test | 7 pass, 0 skip, 0 fail |
| `modules/data/packages/data-bundle` (`test:e2e`) | bun test | 9 pass, 0 skip, 0 fail |
| `modules/data/packages/data-host-model` | bun test | 53 pass, 0 skip, 0 fail |
| `modules/doc/packages/doc-bundle` | bun test | 41 pass, 0 skip, 0 fail |
| `modules/doc/packages/doc-host-model` | bun test | 44 pass, 0 skip, 0 fail |
| `modules/draw/packages/draw-bundle` | bun test | 1480 pass, 34 skip, 0 fail |
| `modules/draw/packages/draw-bundle` (`test:dom`) | bun test | 165 pass, 0 skip, 0 fail |
| `modules/draw/packages/draw-geometry` | bun test | 681 pass, 0 skip, 0 fail |
| `modules/draw/packages/draw-tools` | bun test | 337 pass, 0 skip, 0 fail |
| `modules/image/glue` | bun test | 343 pass, 0 skip, 0 fail |
| `modules/image/manifest` | paged-plugin validate | exit 0 |
| `modules/publish/packages/pdf-bundle` | bun test | 26 pass, 0 skip, 0 fail |
| `modules/publish/packages/publish-bundle` | bun test | 13 pass, 0 skip, 0 fail |
| `modules/sheet/packages/sheet-bundle` | bun test | 335 pass, 1 skip, 0 fail |
| `modules/sheet/packages/sheet-host-model` | bun test | 193 pass, 0 skip, 0 fail |
| `modules/slide/packages/slide-bundle` | bun test | 60 pass, 0 skip, 0 fail |
| `modules/web/packages/web-bundle` | bun test | 330 pass, 0 skip, 0 fail |
| `modules/web/packages/web-conformance` | bun test | 103 pass, 0 skip, 0 fail |
| `modules/web/packages/web-model` | bun test | 290 pass, 9 skip, 0 fail |
| `platform/extensions/packages/ai` | bun test | 31 pass, 0 skip, 0 fail |
| `platform/extensions/packages/cli` | bun test | 50 pass, 7 skip, 0 fail |
| `platform/extensions/packages/plugin-sdk` | bun test | 715 pass, 0 skip, 0 fail |
| `platform/shared/test-kit` | bun test | 14 pass, 0 skip, 0 fail |

## Follow-ups

- After the mass format is on main: delete `continue-on-error: true` in `.github/workflows/fmt.yml`
  (one line) and drop the "until the mass format" sentence from the editor's `CLAUDE.md` and
  `CONTRIBUTING.md`.
- Switch from the canary to the first stable Bun that ships `bun fmt` (see "Pinned canary").
- `bun lint`'s `bun/format` rule stays off while this separate check exists.

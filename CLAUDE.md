# CLAUDE.md — paged monorepo

One repository, one revision: engine, built-in modules, extension SDK, editor
and server. Each component keeps its own `CLAUDE.md` and `docs/`; read the one
next to the code you change. This file holds only what crosses components.

## Layout

- `engine/core` — Rust engine (own Cargo workspace and `rust-toolchain.toml`).
- `modules/<name>` — built-in modules; each keeps its own Cargo workspace for now.
- JavaScript: ONE Bun workspace at the root (`package.json` `workspaces`, `bun.lock`,
  `bunfig.toml`; Bun from `.prototools`). `bun install` at the root installs every
  package; component scripts run with `bun run <script>` in the component's directory.
  The isolated linker makes an undeclared import fail; only `workspace:` links a
  workspace package (the editor's exact canary pins resolve from npm).
- `platform/extensions` — the extension contract (`plugin-api`, private) and the
  public SDK (`plugin-sdk`, which ships the contract as its `./api` entry).
  Built-in-only code must not leak into it: community extensions consume it.
- `apps/editor`, `apps/server`, `apps/cli` (`paged-node`) — applications.
- `packages/paged` — the published `@paged-media/paged`, assembled from the engine's
  `canvas-wasm` and the bundled CLI (its `paged` bin); see npm packages below.
- `platform/shared/*` — internal code of the built-ins and the editor (PM-0002):
  `ai`, `fmt`, `helpers`, `panel-kit`, `react-live`, `test-kit`, `test-resources`,
  `wasm-boot`, and the Rust crates `ooxml` (`paged-ooxml`, the OOXML foundation of
  doc, slide and sheet) and `dml-chart` (the DrawingML chart reader of sheet and
  slide), each its own Cargo workspace and a path dependency of theirs.
- `tooling/import` — how this repository was assembled; do not edit history-related files by hand.

## Tasks (Moon)

Moon (`.moon/`, version pinned in `.prototools`) runs every component's tasks
from anywhere in the repository. One project per Cargo workspace and JS component root:
`core`, `core-idml-viewer`, `publish`, `image`, `draw`, `sheet`, `data`, `doc`,
`slide`, `web`, `web-render`, `extensions`, `editor`, `server`, `cli`, and the
shared packages (`ai`, `dml-chart`, `fmt`, `helpers`, `ooxml`, `panel-kit`,
`react-live`, `test-kit`, `test-resources`, `wasm-boot`).

- `moon run <project>:test` — also `:fmt`, `:check`, `:lint`, `:build`, and
  `:wasm` where the component ships a wasm artifact. `moon run :lint` runs it
  everywhere. The language halves are `rust-*` and `js-*` (`moon tasks <project>`).
- `moon ci --base origin/main --head HEAD` — only what a change affects.
- The component's own commands (cargo, `bun run`) still work in its directory.
- Formatting: `cargo fmt` for Rust; `tooling/js/fmt.sh` (`bun fmt` on the
  pinned canary, Prettier 3 defaults, `/.prettierignore`) for everything
  else, checked in CI by `.github/workflows/fmt.yml`. Never format a file
  `/.prettierignore` lists; regenerate it instead.
- Moon must not modify tracked files (package.json, lockfiles, tsconfig.json,
  rust-toolchain.toml). A change in `git status` after a Moon run is a bug in `.moon/`.

## Lint

- `bun run lint` (root): `bun lint` over the whole repository with the one config,
  `bunfig.toml` `[lint]` (docs/adr/PM-0003). It runs an exact canary build through
  `tooling/js/bun-canary.sh`; plain `bun` stays at the `.prototools` version. Never add
  ESLint, a per-package lint config or an `eslint.config.*`.
- It holds correctness rules, the import boundaries (the editor's zones; the module and
  extension contracts of PM-0002) and the Rules of React. Formatting is not lint.
- `bun run lint:selftest` proves every boundary fires. A new boundary, module or
  `platform/shared/*` package needs its cases (it fails until the config names a new
  shared package).
- `eslint-suppressions.json` records the Rules-of-React findings that predate the rules.
  Never add to it; fix a finding and run `--prune-suppressions` in the same commit.
  A one-line exception says why: `// eslint-disable-next-line <rule> -- <reason>`.

## React

- Every first-party React source ships compiled by the React Compiler: the editor's
  build compiles the editor and every module bundle from source, plugin-sdk compiles
  ahead of time. One configuration, `tooling/js/react-compiler.mjs`
  (apps/editor/docs/adr/229-react-compiler.md).
- Read a registry, store, session or host surface during render through a view
  (`@paged-media/react-live`'s `useLive`, the shell's `useRegistryView`) or a
  `useSyncExternalStore` snapshot, never on the object itself.
- No new `useMemo` / `useCallback`: the compiler memoizes compiled code. One that stays
  says why in a `no-restricted-syntax` disable comment on the line above (it keeps an
  effect dependency stable, say); `bun lint` enforces it.
- Each package's `compiler-coverage.json` lists what the compiler leaves uncompiled; CI
  fails on a new entry. Fixing a bailout means running the ratchet with `--write` in the
  same commit (`bun tooling/js/react-compiler-coverage.mjs --write`).

## Agent tools (MCP)

`.mcp.json` registers two servers; `.claude/settings.json` allows their read
tools and asks before anything that writes.

- `moon` (`moon mcp`): projects, tasks, changed files. Speaks the stateless MCP
  protocol `2026-07-28`, so it needs a client that does too.
- `serena` (Serena 2.0.0, `.serena/project.yml`): symbol navigation and edits
  for Rust (rust-analyzer, all ten Cargo workspaces via `linkedProjects`) and
  TypeScript/JavaScript. Setup and caveats: `docs/development/code-intelligence.md`.

## npm packages

Three public packages (docs/adr/PM-0008, amendment 3): `@paged-media/viewer`
(`engine/core/web/idml-viewer`), `@paged-media/paged` (`packages/paged`: the
engine of the private `@paged-media/canvas-wasm` plus the `paged` bin, the CLI of
`apps/cli`) and `@paged-media/plugin-sdk` (with the private `plugin-api` inlined as
`./api`). Every other workspace package is private, and a public one depends on
no private one. `.github/workflows/release.yml` publishes the three from a tag.

- Any edit under `platform/extensions/packages/{plugin-api,plugin-sdk}/src`,
  comments included, bumps plugin-sdk's version (the contract's one public
  number), and plugin-api's private version moves with it to the same value
  (`extensions / contract-guard`). Between releases the in-tree number is the next
  release's canary (`0.74.3-canary.N` after `v0.74.2`); a release stamps all three
  packages with the tag's version (`tooling/release/stage.mjs`).

## Invariants

- The public repository builds and passes its gates without private resources
  (corpus, licensed profiles/fonts). Optional resources are reached through env
  vars and report `unavailable`, never a silent pass: in Rust through
  `platform/shared/test-resources` (`skip!`, `PAGED_REQUIRE_<X>=1`,
  `PAGED_CORPUS_DIR`; `docs/development/testing.md`).
- Built-in modules depend on each other through the workspace, never on
  published canaries of each other.
- Commit as `Dietmar Rietsch <dietmar.rietsch@andthenext.at>`.

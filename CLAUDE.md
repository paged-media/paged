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
- `platform/extensions` — the public extension contract (`plugin-api`) and SDK.
  Built-in-only code must not leak into it: community extensions consume it.
- `apps/editor`, `apps/server` — applications.
- `tooling/import` — how this repository was assembled; do not edit history-related files by hand.

## Tasks (Moon)
Moon (`.moon/`, version pinned in `.prototools`) runs every component's tasks
from anywhere in the repository. One project per Cargo workspace and JS component root:
`core`, `core-idml-viewer`, `publish`, `image`, `draw`, `sheet`, `data`, `doc`,
`slide`, `web`, `web-render`, `extensions`, `editor`, `server`.
- `moon run <project>:test` — also `:fmt`, `:check`, `:lint`, `:build`, and
  `:wasm` where the component ships a wasm artifact. `moon run :lint` runs it
  everywhere. The language halves are `rust-*` and `js-*` (`moon tasks <project>`).
- `moon ci --base origin/main --head HEAD` — only what a change affects.
- The component's own commands (cargo, `bun run`) still work in its directory.
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

## Agent tools (MCP)
`.mcp.json` registers two servers; `.claude/settings.json` allows their read
tools and asks before anything that writes.
- `moon` (`moon mcp`): projects, tasks, changed files. Speaks the stateless MCP
  protocol `2026-07-28`, so it needs a client that does too.
- `serena` (Serena 2.0.0, `.serena/project.yml`): symbol navigation and edits
  for Rust (rust-analyzer, all ten Cargo workspaces via `linkedProjects`) and
  TypeScript/JavaScript. Setup and caveats: `docs/development/code-intelligence.md`.

## Invariants
- The public repository builds and passes its gates without private resources
  (corpus, licensed profiles/fonts). Optional resources are reached through env
  vars and report `unavailable`, never a silent pass.
- Built-in modules depend on each other through the workspace, never on
  published canaries of each other.
- Commit as `Dietmar Rietsch <dietmar.rietsch@andthenext.at>`.

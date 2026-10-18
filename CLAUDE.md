# CLAUDE.md — paged monorepo

One repository, one revision: engine, built-in modules, extension SDK, editor
and server. Each component keeps its own `CLAUDE.md` and `docs/`; read the one
next to the code you change. This file holds only what crosses components.

## Layout
- `engine/core` — Rust engine (own Cargo workspace and `rust-toolchain.toml`).
- `modules/<name>` — built-in modules; each keeps its own Cargo/JS workspace for now.
- `platform/extensions` — the public extension contract (`plugin-api`) and SDK.
  Built-in-only code must not leak into it: community extensions consume it.
- `apps/editor`, `apps/server` — applications.
- `tooling/import` — how this repository was assembled; do not edit history-related files by hand.

## Tasks (Moon)
Moon (`.moon/`, version pinned in `.prototools`) runs every component's tasks
from anywhere in the repository. One project per Cargo/pnpm workspace:
`core`, `core-idml-viewer`, `publish`, `image`, `draw`, `sheet`, `data`, `doc`,
`slide`, `web`, `web-render`, `extensions`, `editor`, `server`.
- `moon run <project>:test` — also `:fmt`, `:check`, `:lint`, `:build`, and
  `:wasm` where the component ships a wasm artifact. `moon run :lint` runs it
  everywhere. The language halves are `rust-*` and `js-*` (`moon tasks <project>`).
- `moon ci --base origin/main --head HEAD` — only what a change affects.
- The component's own commands (cargo, pnpm) still work in its directory.
- Moon must not modify tracked files (package.json, lockfiles, tsconfig.json,
  rust-toolchain.toml). A change in `git status` after a Moon run is a bug in `.moon/`.

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

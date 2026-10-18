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

## Invariants
- The public repository builds and passes its gates without private resources
  (corpus, licensed profiles/fonts). Optional resources are reached through env
  vars and report `unavailable`, never a silent pass.
- Built-in modules depend on each other through the workspace, never on
  published canaries of each other.
- Commit as `Dietmar Rietsch <dietmar.rietsch@andthenext.at>`.

# PM-0005 — Separate Cargo workspaces, one JS workspace, the IDML crates in the engine

- **Status:** Accepted 2026-10-18.
- **Supersedes:** modules/publish ADR 650 (the IDML adapter and the engine pin each other by git
  revision).
- **Scope:** every `Cargo.toml` workspace root, the root `package.json` workspace, and
  `engine/core/crates/{idml-import,idml-export,idml-coverage}`.

## Context

There are eleven Cargo workspaces: the engine, each Rust module, web's renderer, and the
server. They differ in ways that change their output:
- the `flate2` backend;
- serde_json's `float_roundtrip`;
- optimisation profiles tuned for wasm size;
- web-render's exact Blitz alpha pins.

One Cargo workspace would unify features and versions across all of them, so the engine's
bytes would change with every module's choices.

The engine and the IDML adapter (`idml-import`, `idml-export`, `idml-coverage`, which lived
in plugin-publish) depended on each other: the engine calls the adapter, and the adapter fills
and reads the engine's model. ADR 650 had them pin each other by git revision, which made
every change a two-repository dance.

The JavaScript side had a package manager and lockfile per repository, and first-party
packages reached each other through published npm canaries.

## Decision

- **Cargo workspaces stay separate.** Each keeps its own `Cargo.lock`, `rust-toolchain.toml`,
  profiles and `deny.toml`. A dependency between them is a `path` dependency into the other
  workspace. Cargo reads the dependency's `*.workspace` fields from its own workspace root.
- **The IDML crates move into the engine** (`engine/core/crates/`). The engine owns the
  format's reader and writer, which removes the cycle: modules/publish and the server depend on
  the engine by path, and nothing depends back.
- **A guard keeps the engine's patch honest.** The engine patches `flo_curves`. A workspace that
  depended on `paged-mutate` without that patch would build a different geometry kernel, so
  publish and the server check in CI that `cargo tree -i flo_curves` is empty.
- **One JS workspace:** a root `package.json` with `workspaces` and a `catalog` for shared
  versions, one lockfile, and the isolated linker, so an undeclared import still fails. Every
  first-party package depends on every other through `workspace:*`. Nothing is published for the
  monorepo's own use.
- **Engine wasm packages are workspace packages** (`engine/core/packages/*`), filled by a build
  task. Their version is `0.<protocol>.0-dev`, read from the protocol constant.

## Consequences

- A change to the engine's model, the adapter and a module is one commit and one review.
- A module's `-D warnings` now lints the engine crates it builds.
- Editor development needs Rust, because the engine's wasm is built, not downloaded. A
  prebuilt-artifact fetch is a possible follow-up.

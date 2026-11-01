# ADR PM-0017 — The built-in modules are part of the core: one build, modules stay

- **Status:** Proposed 2026-11-01. The one-workspace spike (below) passed for the engine; the module profiles and four dependency splits remain.
- **Amends:** [PM-0002](PM-0002-built-ins-and-extensions.md) (isolation between built-ins ends),
  [PM-0005](PM-0005-workspace-policy.md) (separate Cargo workspaces, conditional on a spike) and
  [PM-0014](PM-0014-capability-layering.md) (the placement rule is by genericity alone).
- **Scope:** `engine/core`, `modules/*`, `platform/shared/*`, `apps/editor`, `apps/cli`,
  `apps/server`, `platform/extensions` (the doors).

## Context

publish, image, draw, sheet, data, doc, slide and web always ship with the editor, the command
line and the server, and are always built from one revision. Rules from the time they were
separate repositories still shape the code:
- module `CLAUDE.md` files forbid contact with the core or with sibling modules;
- 217 of the 402 `host.supports(…)` checks in the built-ins test flags that are always true;
- "module absent" fallbacks and "older engine" branches cannot trigger;
- each module's Cargo workspace pins its own versions (kurbo 0.11 and 0.13, skrifa 0.42 and
  0.48, quick-xml 0.41 and 0.42) and misses the engine's `flo_curves` patch;
- duplicates were kept to avoid a sibling dependency: a second XLSX reader, a second CSV reader,
  a private lowering IR in doc, slide's own comments model.

Parity programmes against Illustrator, Photoshop, Excel, Word and PowerPoint overlap heavily
(comments, themes, shapes, pictures, charts, hyperlinks, colour, effects, paths, type).

## Decision

- **The built-ins are part of the core.** A capability is placed by who needs it, never by
  whether a module is loaded: the lowest layer every consumer reaches (PM-0014). A copy kept to
  avoid depending on another built-in is a defect.
- **Modules stay.** They keep their folders, ADR ranges, lazily loaded wasm bundles and domain
  workflows. A module may depend on the engine, on `platform/shared/*` and on another built-in;
  the dependency graph stays acyclic and is declared in Moon.
- **Isolation ends for built-ins.** Module `CLAUDE.md` isolation rules, `supports()` probes of
  always-on flags, "module absent" fallbacks and "older engine" branches are removed. The public
  doors keep their `supports("…@N")` flags for third-party extensions; built-ins use the same
  doors where the host provides the service, so the doors stay exercised.
- **One Cargo workspace, gated on a measured spike.** PM-0005 separated the workspaces because a
  single one unifies features and profiles (flate2 backend, serde_json `float_roundtrip`,
  wasm-size profiles, Blitz alpha pins) and could change the engine's bytes. The move is made
  only if the spike shows: the engine wasm is byte-identical or smaller; per-crate features that
  differ (`flate2`, `float_roundtrip`, Blitz) are held by resolver-2 feature scoping or made
  uniform on purpose; each wasm target keeps its own `[profile]` through per-package overrides
  or its build command. If the spike fails, workspaces stay separate and the version pins are
  unified through a shared `[workspace.dependencies]` file and the `flo_curves` patch is
  repeated, with a CI check that the lockfiles agree.
- **A single owner per capability.** `docs/development/capability-register.md` lists each
  capability with its owner; a ratchet in CI fails on a new copy of a registered symbol outside
  its owner.
- **Comments are one engine model** (separate record, engine block 1030–1059), compatible with
  Word, Excel, PowerPoint, InDesign and Acrobat.

## Spike result (2026-11-01, origin/main 1572868c8)

A throwaway root workspace merged the engine, the seven Rust modules and the six `platform/shared`
crates (112 members), seeded with the engine's `Cargo.lock`, and was compared with today's
separate workspaces at the same commit.

- **Resolution.** For the engine's wasm crates (`paged-canvas-wasm`, `paged-repo-wasm`,
  `paged-introspect-wasm`) and its native crates (`paged-cli`, `paged-renderer`, `paged-canvas`,
  `paged-export-pdf`), the resolved crates, versions and features are identical. Cargo unifies
  features only among the packages one build selects, and the engine crates declare their
  dependencies directly, so a module cannot change the engine's features.
- **Size.** `paged-canvas-wasm`, `wasm-release` profile, wasm-bindgen 0.2.129 and `wasm-opt -Oz`,
  both from the pinned 1.99.1 toolchain:

  | | separate workspaces | one workspace | difference |
  |---|---|---|---|
  | `cargo build` output | 58,910,462 B | 58,914,640 B | +4,178 B (+0.007 %) |
  | after wasm-bindgen | 56,417,418 B | 56,414,153 B | −3,265 B |
  | shipped, after `wasm-opt -Oz` | 42,757,852 B | 42,760,836 B | +2,984 B (+0.007 %) |

  The bytes differ (the embedded source paths are longer by `engine/core/`); the size does not.
- **Modules.** Merging the `[workspace.dependencies]` tables must not union features: it gave
  slide's wasm the `zlib-rs` backend of flate2 and `ooxmlsdk` (through `paged-ooxml`'s `dom`
  feature), and `serde_json` `float_roundtrip` to crates that do not use it. Each crate keeps
  the features it names; only versions are shared.
- **Blockers to settle before the move.**
  - Four dependencies cannot share one entry: quick-xml 0.41 / 0.42 (data), getrandom 0.3 / 0.4
    (image), wasm-bindgen `=0.2.129` (draw), zip 9 / 9.0.4. They need one version or an alias.
  - Only the root's `[profile]` applies. draw's `opt-level = "z"` with `panic = "abort"`, the
    `"s"` of sheet, doc, slide and data, and slide's per-package overrides become named
    profiles (`wasm-release-draw`, …) that the module wasm scripts select.
  - `rust-toolchain.toml` and `.cargo/config.toml` must sit at the root.
  - A build that selects engine and module packages together (`--workspace`) unifies their
    features; CI and the wasm scripts build per package.

## Consequences

- Duplicates that existed only because of isolation are removed in waves (see the plan).
- A module's change to a shared crate runs the gates of every module that depends on it.
- Moving to one workspace needs a one-time lockfile and `deny.toml` merge, and a wasm-size
  measurement after each wave (`apps/editor/scripts/wasm-budget.mjs`; the app is at 99.6 of
  100 MB).

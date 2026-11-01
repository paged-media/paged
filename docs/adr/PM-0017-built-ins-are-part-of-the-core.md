# ADR PM-0017 — The built-in modules are part of the core: one build, modules stay

- **Status:** Proposed 2026-11-01.
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

## Consequences

- Duplicates that existed only because of isolation are removed in waves (see the plan).
- A module's change to a shared crate runs the gates of every module that depends on it.
- Moving to one workspace needs a one-time lockfile and `deny.toml` merge, and a wasm-size
  measurement after each wave (`apps/editor/scripts/wasm-budget.mjs`; the app is at 99.6 of
  100 MB).

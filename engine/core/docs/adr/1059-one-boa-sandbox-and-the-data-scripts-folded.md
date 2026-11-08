# ADR 1059 — One Boa sandbox; paged.data's batch runner and script surface live in the engine

- **Status:** Accepted 2026-11-08; built (slice 3 of W9). Amends [ADR 1015](1015-paged-action-the-action-registry.md);
  [data ADR 555](../../../../modules/data/docs/adr/555-batch-reuses-the-engine.md) records the move.
- **Scope:** `paged-action` (`js`), `paged-script`, `paged-data-session` (`batch`, `script`), `paged-cli`
  (`paged data batch`); removed: the module crates `data-script` and `data-cli`.

## Context

Boa was set up twice: `paged-action/js.rs` (JS actions, data transforms, and, through `data-script`, paged.data's
build scripts) and `paged-script/lib.rs` (the editor's scripts). The first built a bare context with the loop and
recursion budget and a clock fixed to the epoch; the second built a context with the same two limits plus a stack
limit, the host's clock off wasm and a fixed clock on wasm. Their default budgets were already the same numbers
(10 000 000 iterations, 512 frames). `data-script` (a 190-line adaptor over `paged_action::js::eval`) and `data-cli`
(a job runner and a binary) were module crates next to an engine CLI that already ran `paged data`.

## Decision

1. `paged_action::js::Sandbox` and `sandbox_context` are the one place a Boa context is made: budget, an optional
   stack limit, and whether the clock is fixed. Actions and build scripts use `Sandbox::pure` (fixed clock, because
   an action is pure and cached by its input). `paged-script` uses the same function with its stack limit and
   `fixed_clock = cfg!(wasm32)`, so a native editor script still sees the real `Date`, as before. The two
   differences that remain are deliberate and are fields of the one struct: determinism, and host functions
   (`paged-script` registers its bridge on the context; an action registers nothing).
2. `data-script` (`eval_spec`, `apply_to_session`) and `data-cli` (`Job`, `run_job`) become the modules `script` and
   `batch` of `paged-data-session`, the crate that owns `DataSession` and already links `paged-action`. They are
   not in `paged-script`: that crate compiles into the canvas wasm and would otherwise take the data session with it
   (the store, parquet, turso). The wasm artifact of `data-js` does not change in behaviour: both modules are plain
   functions nothing in the wasm surface calls.
3. The `paged-data-batch` binary is `paged data batch [JOB.json]` in the engine's CLI (stdin when no file),
   same job, same output JSON, the document count on stderr.

## Consequences

- The scripts' tests moved with the code (`data_automation_script_*`, `data_automation_cli_*`) and the data feature
  registry points at them (`engine:paged-data-session/src/…`).
- The CLI help of `paged data` lists `batch`; its goldens (`usage-no-subcommand`, help) were re-recorded for that
  reason alone, and `data batch` has its own.
- `paged-data-batch` as a name is gone; nothing in the repository ran it. A user who built it from source runs
  `paged data batch` with the same job file.

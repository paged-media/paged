# ADR 1015 — `paged-action`: the action registry, chains, the cache key, and actions in JavaScript

- **Status:** Accepted 2026-10-24.
- **Scope:** the new crate `crates/paged-action` (`registry.rs`, `key.rs`, `value.rs`, `js.rs`,
  `tests/keys.json`); used by `paged-data-session` (transforms, data ADR 562). Decided by
  [PM-0015](../../../../docs/adr/PM-0015-data-and-actions-are-platform-layers.md) (record "core
  1015"); the bundle half is extensions
  [ADR 344](../../../../platform/extensions/docs/adr/344-the-actions-door.md).

## Context

PM-0015 makes an action (a named, typed, pure step) a platform concept. Bundles register and run
them through `actions@1`. The engine needs the same thing for three reasons:

- data transforms run where the store is (the data engine, the CLI, the server);
- the interpreter is to reach actions as `paged.actions.*`;
- a result must be addressed alike wherever it was computed, so a cache can be shared.

## Decision

**The model.** An `ActionValue` is one of:

- `Asset`, bytes with a media type;
- `Table`, the provider record shape;
- `Selection`, addresses;
- `Value`, JSON.

An `Action` declares its input and output kinds and default parameters, and `run`s. `Registry`
registers by id (a taken id is refused). It lists, optionally by input kind, and runs one action
or a chain. A chain's kinds are checked before anything runs (`t/len gives value, t/invert takes
asset`), and a step's declared output kind is held to what it gave.

**One key.** A result is cached under `sha256(canonical(input))[..32] . sha256(canonical(chain))
[..32]`. The chain is each step's id with its parameters merged over its defaults. The canonical
form is what `JSON.stringify` writes with sorted keys, so the Rust writer formats numbers as
JavaScript does (`1.0` is `1`, `1e21` is `1e+21`). Bytes inside an object are written as
`{"$bytes":[…]}`. This is the SDK's `actionKey` exactly; `tests/keys.json` holds four cases
recorded from it, and the SDK's spec replays the same file. The cache keeps 256 results, least
recently used out.

**JavaScript actions.** `js::JsAction` runs a function expression `(input, params) => output` in
a fresh Boa 0.22 context, the interpreter `paged-script` embeds. The context is bare:

- the ECMAScript built-ins and no host function, so `fetch`, `require` and `paged` are reference
  errors;
- a loop-iteration and a recursion limit;
- a fixed clock: `Date.now()` is the epoch. An action is pure and cached by its input, so the time
  must not reach its result; Boa's default clock also panics on `wasm32-unknown-unknown`.

Values cross as JSON. An error is reported as its first line (Boa appends the JS call stack).

## Consequences

- The data engine wasm carries Boa: 11.4 → 14.0 MiB, inside the 16 MiB its manifest declares. The
  editor then holds two Boa copies, the canvas worker's and the data engine's. A transform could
  move to the canvas worker later, at the cost of the store's rows crossing to it.
- Image and draw actions over `paged-raster` and `paged-kernels` build on this registry; they
  are not part of this record.

## Amendment (2026-10-24): `paged.actions.*` in the interpreter

`paged-script` exposes the registry as `paged.actions.register / list / run / runChain`
(`src/actions.rs`). The registry lives as long as the engine, in the editor's worker or for one
CLI run, so a later script runs what an earlier one registered.

`register({ id, title?, input, output, params?, run })` keeps `run`'s source text as a
`JsAction`, so an action runs in the bare sandbox, never in the script that registered it.
Whoever runs it later, it cannot reach `paged`: `paged.pages()` there is a reference error. A
taken id is refused. `run` and `runChain` answer `{ output, key, cached }` with the SDK's key.
paged.data's build scripts (`data-script`) evaluate in the same sandbox (`js::eval`), so the
module no longer embeds an interpreter of its own.

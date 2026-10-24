# ADR 344 — The actions door: named pure steps, registered by any bundle, run and cached by any

- **Status:** Accepted 2026-10-24.
- **Scope:** `ActionsSurface`, `ActionDefinition` and their types in
  `packages/plugin-api/src/host.ts`; `capabilities.actions` (`manifest.ts`,
  `manifest.schema.json`, `bin/paged-plugin.mjs`); `packages/plugin-sdk/src/doors-data-actions.ts`
  (`createActionRegistry`, `actionKey`, the gated surface), `host-impl.ts` (`options.actions`,
  the `actions@1` flag), `harness.ts`; the editor injects one registry
  (`plugin-host-options.ts`). Decided by
  [PM-0015](../../../../docs/adr/PM-0015-data-and-actions-are-platform-layers.md) (record
  "extensions 344").

## Context

Steps that compute without editing the document have no common home. They are reachable only
inside the module that owns them:

- the image module's filter stacks;
- draw's tracing and recolouring;
- data's transforms over tables.

A data row that names an image by URL needs exactly such a step before the image is placed: fetch,
fit, convert. And a script or another module wants to run the same steps.

## Decision

**An action is a named, typed, pure step.** An `ActionDefinition` has:

- an id (`<bundle id>/<name>` by convention) and a title;
- an `input` and an `output` kind: `asset` (bytes with a media type), `table` (a
  `ProviderRecordSet`), `selection` (a snapshot of addresses) or `value` (JSON);
- default parameters;
- `headlessOnly`, for an npm-backed step that runs only in `paged-node`;
- `run(input, params, context)`.

**An action computes; a command edits.** A command may apply an action's result in one undo step;
the action never touches the document.

**A cross-bundle registry.** `host.actions` (`actions@1`):

- `register(definition)`, gated on `capabilities.actions.register`. A taken id throws, naming its
  owner.
- `list(input?)`.
- `run(id, input, params?)` and `runChain(steps, input)`, gated on `capabilities.actions.run`.
  Each step's output is the next step's input, and a chain whose kinds do not meet is refused
  before anything runs.

The editor builds one registry and injects it into every host, and so does the harness.

**Cached by content.** A result is kept under `hash(input) . hash(chain)`, where the chain is
each step's id with its parameters merged over the defaults. Both hashes are SHA-256 of a
canonical form: bytes as they are, anything else as JSON with sorted keys. So running the same
chain over an equal input computes nothing, and a changed parameter or input misses. The cache
is bounded (256 entries, least recently used out). `actionKey` is exported, so a caller can
address a result it keeps itself, such as an asset column's cached bytes (data ADR 563).

**Honest absence.** Without a registry, `register` throws, `list` is empty, `run` rejects and
`supports("actions@1")` is false.

## Consequences

- The engine-side half is core ADR 1015 (`paged-action`): the same registry, chain and key in
  Rust, for the engine's interpreter (`paged.actions.*`) and the command line. Until it lands,
  `actions@1` is the bundles' registry.
- Image and draw register their operations once `paged-raster` and `paged-kernels` give them
  engine-level kernels (PM-0014); data registers transforms (data ADR 562); asset columns run a
  column's chain per asset (data ADR 563).
- plugin-sdk and plugin-api 0.74.3-canary.18.

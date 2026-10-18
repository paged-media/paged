# ADR 318 — Workers are spawned by the host on a declared capability

- **Status:** Accepted. Recorded retroactively on 2026-10-02 from the code at `d90f727`;
  editor at `28dc764`, plugin-image at `f7d21e5`, plugin-data at `6b96ce5`.
- **Scope:** `capabilities.workers` in the manifest schema, types and CLI; `host.workers` in
  `packages/plugin-api/src/host.ts`; its implementation in
  `packages/plugin-sdk/src/host-impl.ts`; the `WorkerBackend` a host application injects.

## Context

A bundle that decodes images or runs queries wants to do that off the main thread.
`DESIGN.md:1246-1253` states the position taken: "A bundle never touches `new Worker()`
directly — the SDK owns the primitive, the manifest gates it, the host budgets + tears it
down (the same posture as every other door)". The contract repeats it where the door is
typed (`packages/plugin-api/src/host.ts:582-590`): the host can budget and tear down, and
tracks every worker for teardown when the bundle is disposed.

The same passage of `DESIGN.md` says the door had been deferred under the rule that nothing
enters the surface without a consumer, and was built once two existed: an image decode pool
and a query-engine worker. It landed in commit `e57cb4e` on 2026-06-13.

## Decision

A bundle asks the host for a worker; it does not construct one. The request is allowed only
if the manifest declares `capabilities.workers`, and the host owns the count, the shared
memory budget and the teardown.

- **Manifest.** `capabilities.workers` is `{ max, sharedMemory?, maxSharedBytes? }`. The
  schema bounds `max` to 1..8 and `maxSharedBytes` to 256 MiB; the CLI repeats both checks.
- **Door.** `host.workers.spawn({ module, name? })` resolves to a `BundleWorker` with
  `post`, `onMessage`, `allocateShared` and `terminate`. `host.workers.concurrency()`
  returns the granted worker count.
- **What the adapter enforces.** An undeclared capability rejects the spawn. The grant is
  `min(declared max, hardwareConcurrency, 8)`, and a slot is reserved before the worker is
  constructed so that a burst of spawns cannot pass the cap. `allocateShared` returns
  `null` unless `sharedMemory` is declared, the page is cross-origin isolated and the
  request fits the bundle's budget, which is the smaller of 256 MiB and the manifest's
  `maxSharedBytes`. Terminating a worker returns its bytes to the budget. Every worker is
  terminated when the bundle is disposed.
- **What the host application does.** It injects a `WorkerBackend` with one method,
  `spawn(pluginId, module, name)`, which turns the bundle-relative `module` into a served
  URL and constructs the worker. Without a backend, `spawn` rejects, `concurrency()` is 0
  and `supports("workers@1")` is false ([ADR 305](305-doors-always-present.md)).

The editor's backend is a table of resolvers keyed by plugin id. It has one entry, for
plugin-image, which maps the path `workers/decode.js` to that package's decode-worker
module; any other plugin id or path is rejected. The worker is an ES-module worker.

One plugin uses the door. plugin-image declares `{ max: 4, sharedMemory: true }` and
builds a decode pool of up to `concurrency()` workers; when `workers@1` is not supported or
the grant is 0 it decodes on the main thread instead. plugin-data, the other bundle that
runs a worker, constructs it itself (see Consequences).

## Evidence

- `packages/plugin-api/src/manifest.schema.json:147-169`,
  `packages/plugin-api/src/manifest.ts:241-256`,
  `packages/plugin-cli/bin/paged-plugin.mjs:72-75`, `:238-268` — the capability, three times
- `packages/plugin-api/src/host.ts:599-659`, `:1644-1651` — `SpawnWorkerOptions`,
  `BundleWorker`, `WorkersSurface`; the member on `BundleHost`
- `packages/plugin-sdk/src/host-impl.ts:340-348`, `:2852-2868` — the budgets; the grant and
  the byte budget
- `packages/plugin-sdk/src/host-impl.ts:2893-2927`, `:2948-2993` — `allocateShared`; `spawn`
  with the gate, the cap, the reserved slot and the teardown registration
- `packages/plugin-sdk/src/host-impl.ts:374-394`, `:3162-3167` — `SpawnedWorker`,
  `WorkerBackend`; the feature flag set only when a backend is injected
- `packages/plugin-sdk/test/workers.spec.ts:129-255` — eleven tests against a mock backend
- `editor: apps/canvas/src/plugin-worker.ts:72-99`, `editor: apps/canvas/src/main.tsx:103-108`,
  `:1177-1180` — the backend and its one resolver
- `plugin-image: glue/manifest.json:23-26`, `plugin-image: glue/src/decode-pool.ts:92-136` —
  the declaration and the pool

## Alternatives considered

Letting the bundle construct its own worker is the alternative `DESIGN.md:1251-1253` rules
out. No other alternative is recorded in the repository.

## Consequences

The host bounds and stops the workers it spawned without the plugin's co-operation, and
the same bundle code runs where no backend exists, by falling back.

The second consumer named in `DESIGN.md:1249-1251` does not use the door. plugin-data
constructs its query-engine worker itself, and its manifest does not declare `workers`. Its
comment gives the state it was written in: "no host worker capability yet; the bundle
spawns the DuckDB worker from the vendored bundle"
(`plugin-data: packages/data-bundle/src/query/duckdb.ts:19-22`, `:96`).

The manifest does not list worker modules. `packages/plugin-api/src/manifest.ts:164-166`
says only modules "listed under a declared path" may be spawned, but `WorkersCapability`
has three fields and none names a module. The adapter passes `module` to the backend
unchecked; which paths resolve is decided by the host application's table.

plugin-image declares `sharedMemory: true` and its source never calls `allocateShared`;
its decode replies move a buffer with a transfer list
(`plugin-image: glue/src/decode-worker.ts:160`).

The door is a budget and a lifecycle, not a sandbox. `DESIGN.md:1284-1290` calls it
"Honesty + accident-prevention, not a security boundary" ([ADR 319](319-trust-line.md)).
A headless host injects no backend (`packages/plugin-sdk/src/host-impl.ts:389-390`), so
there `spawn` rejects and a bundle takes its fallback.

## Related

- [ADR 303](303-manifest-schema.md), [ADR 305](305-doors-always-present.md), [ADR 010](010-raw-mutate-gate-capability-enforcement.md) — the manifest vocabulary; the no-backend answer; the capability gate
- [ADR 308](308-plugin-wasm.md), [ADR 319](319-trust-line.md) — the other declared-artifact lane; what in-process enforcement does and does not mean
- [ADR 201](https://github.com/paged-media/editor/blob/main/docs/adr/201-plugins-as-pinned-packages.md) — how the editor obtains the plugin package whose worker module it resolves

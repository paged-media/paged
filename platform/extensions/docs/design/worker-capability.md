# Design — K-3 worker spawn + SharedArrayBuffer capability (S-07 · I-02)

Design note, written before the implementation. What was built is recorded in
[ADR 318](../adr/318-host-spawned-workers.md) and in `DESIGN.md` §15.

**2026-06-13 · design note · status: FROZEN (the deferral condition is now MET).**
Companion to the C-1 Stage B GPU design
([ADR 018](https://github.com/paged-media/core/blob/main/docs/adr/018-stage-b-gpu-texture-defer-record-only.md)).
K-3 is SDK + editor — NO
core wire change. K-3, S-07 and I-02 are the ids this door carries in
`packages/plugin-api/src/host.ts` and `DESIGN.md` §15.

## Why now (the deferral lifts)

*Status note (2026-10-02): this section predates the implementation; of the two consumers
named here only paged.image declares `capabilities.workers` and spawns through the door
(`plugin-image: glue/src/decode-pool.ts`). paged.data does not: it constructs its DuckDB worker
itself (`plugin-data: packages/data-bundle/src/query/duckdb.ts`).*

K-3 was DEFERRED earlier under the no-speculative-surface rule: no
bundle actually threaded. Two real consumers now exist, so the door
earns its keep:

- **paged.image decode pool** — the ingest lane decodes PSD/JPEG/PNG
  on the main bundle realm; a worker pool parallelises decode + the
  Engine-B tile evaluation that backs the C-6 resource provider (a
  100+ MP composition's tiles are embarrassingly parallel).
- **paged.data DuckDB worker** — DuckDB-WASM (the D-07b `engine`
  artifact) runs queries; moving it to a worker keeps the main flow
  responsive and is the upstream's own recommended deployment.

Both want the SAME primitive: spawn a bundle-owned worker, hand it a
SharedArrayBuffer for zero-copy hand-off, talk over `postMessage`.

## Preconditions (already satisfied)

- **COOP/COEP cross-origin isolation** is LIVE (editor dev server +
  prod `_headers`; `assertCrossOriginIsolated` boot check).
  `SharedArrayBuffer` is therefore constructible — the hard browser gate is open.

## Decision shape

**A capability-gated, host-spawned worker — the bundle never touches
`new Worker()` directly** (mirrors every other host door: the SDK owns
the primitive, the manifest gates it, the host can budget + tear down).

### Manifest capability

*Status note (2026-10-02): this section predates the implementation; the shipped capability
also takes an optional `maxSharedBytes` (`packages/plugin-api/src/manifest.ts`).*

```jsonc
"capabilities": {
  "workers": { "max": 4, "sharedMemory": true }
}
```
- `max` — the worker-count ceiling the host grants (clamped to a hard
  cap, e.g. `min(declared, navigator.hardwareConcurrency, 8)`).
- `sharedMemory` — declares SAB use (gates the `SharedArrayBuffer`
  allocation door; absent ⇒ message-copy only).
Closed vocabulary, validated by the CLI + schema like every capability.

### SDK surface (plugin-api / plugin-sdk)

*Status note (2026-10-02): this section predates the implementation; the shipped surface adds
`host.workers.concurrency()` (the granted worker count), and the manifest carries no list of
worker modules — which module paths resolve is decided by the host's `WorkerBackend`
(`packages/plugin-sdk/src/host-impl.ts`; in the editor a per-bundle resolver,
`editor: apps/canvas/src/plugin-worker.ts`).*

```ts
// host.workers (gated on capabilities.workers)
spawn(opts: {
  // The worker module — a bundle-relative path to a wasm-bindgen worker
  // glue OR a plain JS module (declared-only, like the wasm artifacts).
  module: string;
  name?: string;
}): Promise<BundleWorker>;

interface BundleWorker {
  post(message: unknown, transfer?: Transferable[]): void;
  onMessage(handler: (m: unknown) => void): Disposable;
  // SAB allocation is host-mediated so the host enforces a byte budget
  // (the K-4/D-07b discipline) — a bundle can't allocate unbounded
  // shared memory.
  allocateShared(bytes: number): SharedArrayBuffer | null;
  terminate(): void;            // also runs on bundle dispose
}
```
- `supports("workers@1")` gates feature detection.
- Budget: a per-bundle shared-memory ceiling (default e.g. 256 MiB,
  manifest may tighten) + the worker-count cap. The host facade tracks
  every spawned worker for automatic teardown on `dispose()` — the
  platform-honesty smoke test by construction.
- The worker module is **declared-only** (its path listed in the
  manifest, same as wasm artifacts) — a bundle can't spawn an
  arbitrary URL.

### Editor backend

*Status note (2026-10-02): this section predates the implementation; the shipped backend is
`spawn(pluginId, module, name?)` and only constructs the worker — the `SharedArrayBuffer`
allocation and its budget live in the SDK adapter (`packages/plugin-sdk/src/host-impl.ts`).*

The editor injects a `WorkerBackend` (like `assetSource`/`blobStore`):
`spawn(moduleUrl)` resolves the bundle-relative module through the same
`/@fs/`-allowed sibling-plugin path the wasm artifacts use, constructs
the `Worker`, and wires the SAB allocation through a budget accountant.
Absent backend → `spawn` rejects honestly, `supports("workers@1")`
false.

## Trust line (v1, in-process)

Same posture as the wasm lane: the worker gets NO ambient authority —
no engine/DOM/network handle, only the bundle's already-gated JS talks
to it. SAB is non-shared with the host's own memory (a separate
bundle-owned allocation). This is honesty + accident-prevention, not a
security boundary against malicious code (the isolate migration is the
real boundary — K-3's worker becomes the isolate's worker then).

## Out of scope (pinned)

- Threading the SHEET engine's recalc (a sequential topo loop — a
  major Rust rewrite, not a platform door; sheets stays single-threaded
  until that lands).
- Cross-bundle shared workers (each bundle owns its pool).
- Nested workers.

## Acceptance (SDK/editor)

- Headless/unit: `host.workers.spawn` returns a `BundleWorker`, a
  round-trip `post`→`onMessage` echoes, `allocateShared` honors the
  budget (rejects over-cap), `dispose` terminates every spawned worker.
- A real consumer: paged.image's decode pool spawns N workers, decodes
  a multi-image batch in parallel, and the C-6 tile provider serves
  from worker-evaluated tiles. (Image-side; the platform half is the
  door + budget + teardown.)

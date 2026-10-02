# RFC: core data-provider contract (publish / discover / snapshot / refresh) (D-09)

Design note, written before the implementation. What was built is recorded in
[ADR 014](https://github.com/paged-media/plugin-data/blob/main/docs/adr/014-data-provider-arrow-seam.md)
and in `DESIGN.md` §4.6c.

Sections not relevant outside the original planning context have been removed; numbering is unchanged.

**Shared with the sheets plugin's consumer side** — this contract is the rendezvous point; both
sides build to it, neither to the other. The consumer half is specified in
`plugin-sheets: docs/design/data-provider-consumer.md`.
**Origin:** the paged.data concept paper (`plugin-data: docs/concept.md`) §7.1 ("Acting as a data
provider for other consumers (SDK-mediated)"), §2.1 (the isolation superset — zero
inter-plugin contact), §2.2 (the convergent-RFC list). Section references below (§2.1, §7.1,
§11) are to that paper. D-09 is the id this door carries in `packages/plugin-api/src/host.ts`
and `DESIGN.md` §4.6c; D-03 is the network consent door
([network-consent.md](network-consent.md)).
**Consumes / proves:** the engine side is **already built + tested** —
`DataSession::publish_provider(query, id, category) -> ProviderPublication`
(`plugin-data: data-js/src/core.rs`; `plugin-data: data-conformance/tests/provider.rs`, 3 tests;
registry `data.provider.publish`, coverage-gated). What is missing is the *core SDK door*
to register/discover it.

## Problem

Concept §7.1 calls for a powerful composition: a **sheet sourced from a
governed `paged.data` query** rather than from a static import — a spreadsheet
computing over a live, governed dataset and then lowering to print. The §2.1
isolation superset forbids the obvious shortcut: `paged.data` and the sheets
plugin may have **zero inter-plugin contact** — no import, no runtime discovery
by plugin identity, no message-passing, even co-installed. They must rendezvous
**only at a neutral core contract**.

The platform offers no such contract today. The closest precedent is
`host.bindings` — a *named, reactive value store* (`publish(name, value)` /
`get(name)` / `onDidChange(listener)`): exactly the right *shape* (named,
reactive, decoupled), but scoped to scalar UI bindings, not schema-bearing
tabular datasets pulled on demand. A data provider is `host.bindings` raised to
**datasets**: a schema descriptor cheap enough to enumerate, a row payload
pulled lazily, and a revision token so a consumer re-pulls only on real change.

`paged.data` is ready to publish: `publish_provider` returns a complete,
deterministic publication — `{ id, category, revision, schema, rowCount,
records }` — the records **stabilized** to a permutation-invariant order and the
`revision` an etag over that stabilized content (so a meaningless reorder does
**not** trigger a spurious consumer refresh). It just has nowhere to register it.

## Proposal (three stages)

### Stage 1 — a `dataProviders` capability (manifest)

*Status note (2026-10-02): this section predates the implementation; `host.dataProviders` is
present on every host and each call is checked against the declared role instead — see
[ADR 305](../adr/305-doors-always-present.md) and `DESIGN.md` §4.6c.*

Two roles on a closed-vocabulary capability (additive → an `apiVersion` minor
bump, like D-03's `network`):

```jsonc
"dataProviders": {
  "publish":  ["dataset"],   // categories this bundle MAY register a provider in
  "consume":  ["dataset"]    // categories this bundle MAY discover + read
}
```

`paged.data` declares `publish: ["dataset"]`; the sheets plugin declares
`consume: ["dataset"]`. A bundle that declares neither gets no `host.dataProviders`
surface. Categories are a neutral, open string vocabulary (`"dataset"`,
`"metrics"`, …) — discovery is **by category, never by plugin identity** (§7.1).

### Stage 2 — the `host.dataProviders` surface

*Status note (2026-10-02): this section predates the implementation; the shipped types are in
`packages/plugin-api/src/host.ts`. `DataProviderDescriptor` shipped as
`DataProviderRegistration`, `RecordSet` as `ProviderRecordSet` (`{ schema, columns, rowCount }`),
a schema field is `{ name, ty, nullable? }` (`ty`, not `type`), and `getSnapshot` may also
answer synchronously. The registry behind the surface is one shared instance the host app
creates (`createDataProviderRegistry`) and injects into every bundle host.*

```ts
interface DataProvidersSurface {
  // ── Provider side (paged.data) ──────────────────────────────────────────
  // Register a named provider. `getSnapshot` is lazy — invoked only when a
  // consumer pulls; it runs in the PROVIDER's realm under the provider's own
  // capability/consent (§11). Returns a handle to signal refresh / tear down.
  register(descriptor: DataProviderDescriptor): DataProviderHandle;

  // ── Consumer side (sheets) ──────────────────────────────────────────────
  // Enumerate providers by category — schema + revision only, NO rows.
  discover(category?: string): readonly DataProviderInfo[];
  // Pull a provider's current snapshot (the rows). null if it no longer exists.
  get(id: string): Promise<DataProviderSnapshot | null>;
  // Fire when a provider's revision changes; the consumer re-pulls on its own
  // schedule. Graceful absence: subscribing to an absent id is inert.
  onDidChange(id: string, listener: (revision: string) => void): Disposable;
}

interface DataProviderDescriptor {
  id: string;            // stable, discoverable key (the rendezvous id)
  category: string;      // discovery category
  schema: ProviderSchema;// field names + Arrow-aligned types (the descriptor half)
  revision: string;      // current content etag
  getSnapshot(): Promise<RecordSet>;   // lazy row payload (provider realm)
}
interface DataProviderHandle {
  update(revision: string): void;  // new data resolved → bump revision, notify consumers
  dispose(): void;                 // provider gone → discover() stops listing it
}
interface DataProviderInfo     { id: string; category: string; schema: ProviderSchema; revision: string }
interface DataProviderSnapshot { id: string; revision: string; records: RecordSet }
```

`ProviderSchema` / `RecordSet` are the Arrow-aligned interchange substrate §7.1
already names — the **same shape `paged.data` uses internally**
(`{ fields: { name, type }[] }` + columnar rows). The contract should adopt (or
alias) the existing renderer Arrow seam rather than minting a third shape.

### Stage 3 — `paged.data` wiring (a wiring change, like D-03)

On `paged.data`'s side this is small and already designed for:

```ts
const pub = engine.publish_provider(queryId, providerId, "dataset");
const handle = host.dataProviders.register({
  id: pub.id, category: pub.category, schema: pub.schema, revision: pub.revision,
  getSnapshot: async () => engine.publish_provider(queryId, providerId, "dataset").records,
});
// on every source refresh that moves the bound query:
handle.update(engine.publish_provider(queryId, providerId, "dataset").revision);
```

The revision is permutation-invariant, so `update()` is a no-op-to-consumers
when only the row order changed — the §7.1 "Sync flows through the contract" with
no spurious churn.

## Security notes (§7.1 — enforced by shape, not convention)

- **The contract exposes *data*, not control.** The consumer-facing API
  (`discover`/`get`/`onDidChange`) has **no parameter** by which a consumer can
  hand the provider a query, a source, a parameter, or an origin. A consumer
  reads published results; it **cannot drive `paged.data`'s network/file reach**.
- **The provider's fetch stays governed by §11.** `getSnapshot` runs in the
  provider's realm; it returns the **already-resolved** `RecordSet`. A consumer
  pulling cannot *induce* a network/DuckDB-`httpfs` fetch `paged.data` is not
  authorized (consented) to perform — pulling reads cache, it does not authorize
  reach. This composes with the D-03 consent gate without weakening it.
- **No identity leak.** `DataProviderInfo` carries `id`/`category`/`schema` —
  never the backing plugin's identity. Neither side learns the other exists.

## Graceful absence (§2.1 — both intact)

If `paged.data` is not installed, no provider in its categories exists;
`discover("dataset")` is simply shorter and the sheets plugin degrades (its
provider list omits those entries). Neither plugin hard-depends on the other;
both depend only on the SDK. The isolation superset is fully preserved.

## Why not the alternatives

- **`host.bindings` as-is** — wrong granularity: scalar values, no schema, no
  lazy pull, no per-row revision. A 200k-row catalog dataset is not a UI binding.
  (Right *shape* to imitate; wrong *scope* to reuse.)
- **A shared `@paged-media/*` package both import** — violates §2.1 (build-time
  coupling) and couples release cycles. The whole point is a *neutral* contract.
- **`paged.data` writes a sheet directly** — violates §2.1 (inter-plugin contact)
  and inverts ownership: the sheet should *pull*, on its own schedule, what it
  chooses to consume.

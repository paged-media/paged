# ADR 311 — Plugin state lives only under the plugin's own id

- **Status:** Accepted. Recorded retroactively on 2026-10-02 from the code at `d90f727`.
- **Scope:** the metadata, `parts`, `storage` and `blob` members of `BundleHost`
  (`packages/plugin-api/src/host.ts`, `packages/plugin-sdk/src/host-impl.ts`); `partTypes`

## Context

Several plugins share one document and one host. Each needs somewhere to keep state: some
of it belongs to a page item, some to the document file, some to the user's browser.

The code records two reasons. The metadata key uses "the FULL manifest id (not a
shortname) so third-party ids can never collide"
(`packages/plugin-sdk/src/host-impl.ts:1016-1018`). Part types are declared by the plugin
"so third-party plugins persist namespaced parts WITHOUT central blessing of each data
type" (`packages/plugin-api/src/manifest.ts:370-371`). For the key-value store and the
blob store the code shows the scoping and no reason. The repository does not record why.

## Decision

Every store the contract gives a bundle is addressed by the bundle's full manifest id. The
adapter derives the key, prefix or scope from the manifest; the bundle never passes it.

- **Element metadata.** `document.getMetadata(id)` and `setMetadata(id, envelope)` read
  and write one envelope `{ v, data, engine? }` on a page item under the key
  `x-paged:<manifest.id>`. A write is a `setPluginMetadata` mutation through `mutate`
  ([ADR 310](310-one-write-door.md)).
- **Container parts.** `host.parts.write`, `read` and `list` take paths relative to
  `paged/<manifest.id>/` in the document container and reject `..`. The manifest lists the
  part types under `contributes.partTypes`, each with a role of `spec`, `source` or `derived`.
- **Key-value.** `host.storage` holds JSON values under keys prefixed
  `paged.plugin.<manifest.id>.`, in a backing the host injects or, by default,
  `localStorage` (an in-memory map where there is none).
- **Blobs.** `host.blob` passes `manifest.id` to a store the host injects. It requires
  `capabilities.storage` with `blob: true` and applies a quota of 64 MiB that the
  manifest's `storage.quotaBytes` can lower.

The first two travel with the document; the contract contrasts parts, which "TRAVEL WITH
THE FILE", with the blob store's "per-browser OPFS". A `mutate` that sets plugin metadata
under another key is refused, also inside a `batch`. `document.setMetadata` and
`parts.write` send `caller: manifest.id`, so that the engine checks the namespace as well.

## Evidence

- `packages/plugin-sdk/src/host-impl.ts:1016-1019`, `:1950-1995`, `:1640-1651` — the
  derived key; `getMetadata` and `setMetadata`; the foreign-key refusal
- `packages/plugin-sdk/src/host-impl.ts:2669-2734` — `parts`: the prefix, the `..` check,
  the `caller` field
- `packages/plugin-sdk/src/host-impl.ts:2154-2178`, `:251-274`, `:2606-2658`, `:337-340` —
  `storage` and its default backing; `blob` and its quota
- `packages/plugin-api/src/host.ts:969-1000`, `:1268-1295` — the metadata doors and
  envelope; the parts door
- `packages/plugin-api/src/manifest.ts:363-386` — `partTypes` and the three roles
- `core: crates/paged-canvas/src/channel.rs:1219-1235` — the engine's `caller` on
  `WritePagedPart`

## Alternatives considered

A short plugin name as the metadata key: set aside for the full id in the adapter's
comment, though the contract's comment still describes it (`packages/plugin-api/src/host.ts:972`).
A central registry of part data types: ruled out in the `partTypes` comment quoted above.

## Consequences

Stored state is tied to the manifest id. The metadata key and the part paths are written
into the document, so a bundle that changes its id no longer finds them.

The scoping is done by the adapter. The code says so at the parts door: "a convention is
not a boundary — a bundle reaching the raw handle bypasses it entirely"
(`packages/plugin-sdk/src/host-impl.ts:2687-2689`). The engine's check runs only when the
`caller` field is sent, and the engine comment calls it "not a boundary against a hostile
one, which needs the isolate/RPC host" (`core: crates/paged-canvas/src/channel.rs:1229-1233`).

`host.storage` has no capability gate. `host.parts` is scoped by path: the adapter prefixes
`paged/<manifest.id>/`, rejects `..`, and names the caller to the engine on a write.
`contributes.partTypes` is "Purely DECLARATIVE — no runtime behaviour rides on this"
(`packages/plugin-api/src/manifest.ts:373`): the adapter does not compare a written path
with the declared types. The four doors give a bundle no way to name another plugin's key,
path or scope; data meant for another plugin goes through the separately declared
`host.dataProviders` door (`packages/plugin-sdk/src/host-impl.ts:2243-2249`).

Comments contradict the code. `packages/plugin-api/src/host.ts:972` gives the key with the
manifest "shortname"; the adapter uses the full id. `packages/plugin-api/src/host.ts:1281-1283`
says `supports("storage.parts@1")` is false when no container writer is wired; the adapter
lists the feature statically (`packages/plugin-sdk/src/host-impl.ts:169-172`), so it is
always true.

## Related

- [ADR 310](310-one-write-door.md), [ADR 316](316-native-content-and-baking.md) — metadata writes are ordinary mutations; what the metadata and the parts are used for
- [ADR 010](010-raw-mutate-gate-capability-enforcement.md), [ADR 319](319-trust-line.md) — the namespace gate and where enforcement stops
- [ADR 118](https://github.com/paged-media/core/blob/main/docs/adr/118-paged-file-is-a-valid-idml-package.md), [ADR 014](https://github.com/paged-media/plugin-data/blob/main/docs/adr/014-data-provider-arrow-seam.md) — the container the parts live in; the door for data shared between plugins

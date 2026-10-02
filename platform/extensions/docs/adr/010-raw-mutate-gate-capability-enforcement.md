# ADR 010 — The raw-mutate gate + in-process capability enforcement line

**2026-06-07 · decision record · status: ACCEPTED (records a shipped in-process
gate; the engine-boundary half remains open).**

**Sources:** `packages/plugin-sdk/src/host-impl.ts` —
`createBundleHost` (`:199`), the `foreignMetadataKey` namespace gate at the write
chokepoint (`:351-361`, recursive/batch-aware), read-door capability checks
(`:367`, `capabilities.document.read`), write-door checks (`:383`,
`capabilities.document.write`), `hasRendering`/overlay/hitTest/keybinding doors
(`:245`, `:323`, `:327-332`), `PluginCapabilityError` (`:93`), `capabilityMode:
'enforce'|'warn'` (`:190`, `:237`); [`../reference/trust-gate.md`](../reference/trust-gate.md)
(the IN-PROCESS gate landing; the open ENGINE-boundary half; the two same-realm
debts); the internal gap register's entries for engine-side caller identity
(B-16) and facade bypass.

## The decision

**Manifest capabilities are ENFORCED in-process at the plugin-SDK host, not left
advisory — `createBundleHost` gates declaration↔use at every facade chokepoint —
AND that gate is honestly scoped as accident-prevention, not a trust boundary
against a bundle holding the raw host handle.** This is the in-process landing,
and it deliberately records its own limit.

## What the gate does (the in-process half)

- **Namespace chokepoint at the write door.** A raw `mutate` carrying
  `setPluginMetadata` is recursively (batch-aware) checked: a bundle may only
  write its own `x-paged:<id>` namespace. `foreignMetadataKey` is the guard.
- **Capability doors.** Read doors require `capabilities.document.read`; write
  doors require `capabilities.document.write`; hitTest/overlay/keybinding doors
  require their declared capability (additive `capabilities.keybindings`).
  Contributed ids must be listed in the matching `contributes.*` category.
- **Loud, honest denials.** Violations throw `PluginCapabilityError` (contribution
  + read doors) or return a non-applied `MutationOutcome` (write doors — preserving
  mutate-never-throws), same loud-honesty as the namespace gate. `capabilityMode:
  'enforce' | 'warn'` (default enforce) is the migration hatch. Both first-party
  manifests were already complete — zero undeclared use was caught.

## Why this is honesty, not yet a boundary (the load-bearing limit)

Same-realm bundle execution is **first-party-only policy**
([`../reference/trust-gate.md`](../reference/trust-gate.md)):
every loaded bundle runs in the host realm with the raw `PagedEditor` via
`host.editor`. So the in-process gate is **honesty/accident-prevention** — it
stops a *well-behaved* first-party bundle from accidentally writing another
plugin's namespace or using an undeclared door. It is **not** a barrier against a
bundle that holds the raw handle and calls `paged.client.mutate(...)` directly
(engine-side caller identity, B-16: the engine op checks the `x-paged:` prefix +
cap, not *which* plugin writes; facade bypass: it reaches the raw spine where
facades exist). Those are benign same-realm and load-bearing only at the isolate.

## Consequences

- **The real trust line is the isolate, not this gate.** Engine-boundary caller
  identity — `setPluginMetadata` rejecting foreign keys server-side — only
  matters once `host.editor` is gone, i.e. at `createBundleHostProxy` over a
  per-plugin isolate. With Boa lacking an isolate primitive
  ([ADR 001](https://github.com/paged-media/core/blob/main/docs/adr/001-boa-over-quickjs.md)), that
  becomes a worker-per-plugin boundary.
- This ADR records *why the in-process gate ships now anyway*: it is the half
  that retires accidental violations cheaply and keeps the RPC door a flip, not a
  rewrite. The gate checklist in
  [`../reference/trust-gate.md`](../reference/trust-gate.md) tracks the remaining boxes;
  this gate is the one already checked (manifest capabilities enforced).
- The host-adapter-in-plugin-sdk design keeps the second `BundleHost`
  implementation (RPC/isolate) a drop-in for the same conformance the in-process
  host passes.

## Amendment — 2026-10-02

Checked against the code at `d90f727`. The decision stands: `createBundleHost` checks every
gated door against the manifest, and the gate is accident prevention, not a boundary.
`host.editor` is still on the surface (`packages/plugin-api/src/host.ts:1679`,
`packages/plugin-sdk/src/host-impl.ts:3210-3212`) and no isolate host exists
(`createBundleHostProxy` appears only as a name, in `DESIGN.md:93`). The text above no longer
matches the code in four places.

**1. Line references.** `packages/plugin-sdk/src/host-impl.ts` is now 3221 lines; every line
number in **Sources** is stale. Current locations in that file:

- `:1002` — `createBundleHost`.
- `:1636-1647` — `foreignMetadataKey` (recursive over `batch`); applied in `document.mutate`
  at `:1722-1727`.
- `:1651-1656` — `requireDocRead`, the read-door check on `capabilities.document.read`.
- `:1716-1721` — the write-door check on `capabilities.document.write` (`denyWrite`,
  `:1162-1170`).
- `:1096-1098` — `hasRendering`; the overlay doors at `:1375-1383` and `:2117-2147`,
  `document.hitTest` at `:1788-1801`, `contribute.keybinding` at `:1316-1325`.
- `:210-226` — `PluginCapabilityError`.
- `:993` — the `capabilityMode` option; read at `:1083`.

**2. The gate covers more doors.** "What the gate does" names the read, write, hitTest, overlay
and keybinding doors and the `contributes.*` id lists. The same check (`requireDeclared`,
`packages/plugin-sdk/src/host-impl.ts:1142-1156`) now also guards:

| Door | Manifest declaration required | Lines |
|---|---|---|
| `contribute.schemaPanel` | `contributes.panels[]` lists the id | `:1272-1277` |
| `contribute.menu` | `contributes.commands[]` lists the target command | `:1333-1339` |
| `contribute.editContext`, `contribute.objectType` | `contributes.editContexts[]` / `objectTypes[]` declares the `type` | `:1394-1398`, `:1460-1464` |
| `contribute.bindingProvider` | the edit context's declaration, borrowed | `:1505-1510` |
| `contribute.importer`, `contribute.exporter` | `contributes.importers[]` / `exporters[]` lists the id | `:1561-1566`, `:1572-1577` |
| `contribute.sceneLayer` | `capabilities.rendering` ∋ `"sceneLayer"` | `:1590-1594` |
| `images.claimImageResource` | `capabilities.rendering` ∋ `"resourceProvider"` | `:2507-2511` |
| `assets.getFontFace`, `assets.getPlacedImage` | `capabilities.assets` ∋ `"fonts"` / `"images"` | `:2427-2431`, `:2462-2466` |
| `blob.write` / `read` / `delete` / `keys` / `usage` | `capabilities.storage.blob` | `:2607-2612` |
| `network.requestConsent` | `capabilities.network` | `:2200-2204` |
| `dataProviders.register` / `discover` / `get` | `capabilities.dataProviders.publish` / `consume` | `:2256-2283` |
| `clipboard.read` / `write` | `capabilities.clipboard` is `"full"` or `"vector"` | `:2778-2784` |
| `workers.spawn` | `capabilities.workers` | `:2953-2957` |
| `secrets.set` / `exists` / `forget` | `capabilities.secrets.sources` | `:3008-3035` |
| `nativeDocument.readModel` / `readComposition` / `listParts` | `capabilities.document.readNative` | `:1661-1666`, `:2744-2753` |
| `nativeDocument.open` | `capabilities.document.openNative` | `:1667-1672`, `:2755-2756` |

The sentence "return a non-applied `MutationOutcome` (write doors …)" holds for
`document.mutate` and for `setMetadata`, which calls it. The other doors gated on
`capabilities.document.write` (`document.undo`, `document.redo`, `selection.set`) throw
`PluginCapabilityError` in `enforce` mode (`:1755-1773`, `:2050-2055`).

Not capability-gated: `host.journal` (`:1034-1039`), `host.storage`, `host.viewport`,
`host.text` (`:2083-2089`), `host.diagnostics`, reading the selection (`:2041-2049`) and the
two file doors on `host.shell`. `host.parts` is scoped by path to `paged/<id>/` (`:2657-2672`)
and names the caller on a write (`:2674-2693`). `DESIGN.md:837-845` gives the reasons for
viewport, storage, diagnostics and selection. The chokepoint table at `DESIGN.md:802-821`
does not list the doors in the table above.

**3. First-party trust is asserted in code.** "Why this is honesty" calls same-realm execution a
"first-party-only policy". Since commit `3e1f02e` (2026-06-12) `loadBundle` enforces it:

- `packages/plugin-sdk/src/load.ts:62-71` — `loadBundle` throws when `options.trust` is anything
  other than `"first-party"`.
- `packages/plugin-sdk/src/host-impl.ts:829` — `BundleTrust` has the single member
  `"first-party"`; `:851` is the host option.
- `packages/plugin-sdk/src/load.ts:53-57` — the value is supplied by the host and defaults to
  `"first-party"`; nothing on the bundle is verified.

The decision is recorded in [ADR 319](319-trust-line.md).

**4. Caller identity reaches the engine on three doors.** The header says "the engine-boundary
half remains open", and "Why this is honesty" says the engine op checks "the `x-paged:` prefix +
cap, not *which* plugin writes". The adapter now names the calling plugin on three doors, and
the engine checks it:

- `packages/plugin-sdk/src/host-impl.ts:1974-1990` — `document.setMetadata` sends
  `caller: manifest.id`. `core: crates/paged-mutate/src/apply/layer.rs:555-568` rejects a key
  outside `x-paged:<caller>`.
- `packages/plugin-sdk/src/host-impl.ts:1609-1613` — the scene-layer `submit` passes
  `manifest.id`. `core: crates/paged-canvas/src/model.rs:9004-9017` refuses to replace a layer
  owned by another plugin.
- `packages/plugin-sdk/src/host-impl.ts:2674-2693` — `parts.write` sends `caller: manifest.id`.
  `core: crates/paged-canvas/src/model.rs:4600-4619` confines the write to `paged/<caller>/`.

In all three the field is optional and a request without it is not checked
(`core: crates/paged-wire/src/lib.rs:1152-1167`, `core: crates/paged-canvas/src/channel.rs:1045-1055`,
`core: crates/paged-canvas/src/channel.rs:1215-1232`; core at `9f933f1`). `document.setMetadata`
is the path that adds `caller`; `document.mutate` applies `foreignMetadataKey` to what it is
given and forwards it unchanged (`packages/plugin-sdk/src/host-impl.ts:1722-1736`). The first
Consequences bullet therefore still holds: the engine checks are an aid for a correct caller,
and the boundary is the isolate.

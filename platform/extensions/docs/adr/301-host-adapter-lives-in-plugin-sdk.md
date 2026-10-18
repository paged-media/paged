# ADR 301 — The host adapter lives in plugin-sdk, not in the editor

- **Status:** Accepted. Recorded retroactively on 2026-10-02 from the code at `d90f727`.
- **Scope:** `packages/plugin-sdk/src/host-impl.ts`, `packages/plugin-sdk/src/load.ts`, and the
  handle types in `packages/plugin-api/src/editor.ts`

## Context

`BundleHost` is an interface in the type-only contract package
([ADR 300](300-type-only-contract.md)). Something has to implement it. The host application
is the editor, which lives in another repository.

`DESIGN.md:87-93` calls the placement the "non-obvious move" and gives two reasons: the
whole implementation of the contract stays in this repo ("reviewable, versioned with the
types it implements"), and a later isolate host becomes a second implementation of the same
interface instead of a change to the editor. The header of `host-impl.ts` repeats both.

## Decision

`createBundleHost(getEditor, manifest, options)` in plugin-sdk is the implementation of
`BundleHost`. The editor implements no member of the interface itself; it supplies an editor
handle and a set of backends.

- The adapter is a function over `() => PagedEditor`, called again at each use so that it
  never holds a stale handle. It imports types from plugin-api and three local modules, and
  nothing from the editor's packages.
- It is written against narrow handle types owned by plugin-api: `PagedClient` (ten methods)
  and `PagedEditor`. The editor's richer objects must stay assignable to them.
- What only the host application can provide (dialogs, stores, registries shared between
  bundles, renderers) is injected through `CreateBundleHostOptions`: 22 optional fields.
  Most backend fields document what their door does when the field is absent; `storage`
  carries no comment and `diagnosticsSink` documents only the present case.
- `loadBundle` builds the host and calls `activate`. The headless test harness builds the
  same adapter over an editor handle backed by the engine wasm.
- The function returns `{ host, dispose }`; `dispose` disposes the store in which the
  facades record their registrations ([ADR 304](304-bundle-lifecycle.md)).

## Evidence

- `packages/plugin-sdk/src/host-impl.ts:15-25` — the header: why it lives here; "no imports"
  from the editor's packages at value level; `:27-104` the imports
- `packages/plugin-sdk/src/host-impl.ts:1002-1006` — the signature; `:3184-3220` the object
  literal with all 26 members, and the returned handle
- `packages/plugin-sdk/src/host-impl.ts:843-994` — `CreateBundleHostOptions`
- `packages/plugin-api/src/editor.ts:553-570`, `:573-666` — `PagedClient`, `PagedEditor`;
  `:27-32` widening a handle type is an API addition
- `packages/plugin-sdk/src/load.ts:84-88`, `packages/plugin-sdk/src/harness.ts:584` — the two
  callers in this repo's source
- `editor: apps/canvas/src/main.tsx:1251-1285` — the editor's side: one options object, one
  `loadBundle` call expression used for every bundle
- `editor: apps/canvas/src/plugin-api-compat.ts:61-64` — a type assertion that the editor's
  real handle satisfies `PagedEditor`
- `DESIGN.md:87-93` — the stated reasons

## Alternatives considered

Placing the adapter in the editor repository was rejected because it would make the
contract's "implementation invisible to this repo's review and version it apart" from its
types (`DESIGN.md:718-720`). Handing bundles the editor's registries and engine client
directly was rejected because it would freeze 100+ members by accident and remove the
place where the namespace and capability checks run (`DESIGN.md:712-713`).

## Consequences

Each release of plugin-sdk carries host behaviour. Which doors a bundle gets, and how they
answer, is decided by the plugin-sdk version the editor installs; the editor pins it exactly
(`editor: apps/canvas/package.json:36-37`).

The editor is obliged to keep its handle assignable to `PagedEditor` and to inject the
backends. The adapter's header (`packages/plugin-sdk/src/host-impl.ts:18`) and
`CLAUDE.md:48-49` say the editor's "only job is one `loadBundle()` call per bundle"; at the
pinned editor commit that call is accompanied by 14 shared backends and a per-plugin console
(`editor: apps/canvas/src/main.tsx:1251-1275`).

The adapter is a single function of about 2200 lines
(`packages/plugin-sdk/src/host-impl.ts:1002-3221`).

The second implementation is not built: `createBundleHost` is the only code in this repo
that constructs a `BundleHost`, and `createBundleHostProxy` occurs only in `DESIGN.md:93`.

The adapter also returns the raw editor handle as `host.editor`
(`packages/plugin-sdk/src/host-impl.ts:3210-3212`), which bypasses every facade
([ADR 010](010-raw-mutate-gate-capability-enforcement.md)).

## Related

- [ADR 300](300-type-only-contract.md) — why interface and implementation are separate packages
- [ADR 305](305-doors-always-present.md) — how a door answers when its backend is not injected
- [ADR 309](309-conformance-against-real-engine.md) — the harness that reuses this adapter
- [ADR 010](010-raw-mutate-gate-capability-enforcement.md), [ADR 319](319-trust-line.md) —
  the capability gate inside the adapter; the trust line

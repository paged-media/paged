# ADR 302 — Engine wire types are vendored and re-synced on each protocol bump

- **Status:** Accepted. Recorded retroactively on 2026-10-02 from the code at `d90f727`.
- **Scope:** `packages/plugin-api/src/wire.d.ts`, `catalog.json`, `mutations.ts`, `editor.ts`;
  `scripts/sync-wire.mjs`, `scripts/sync-catalog.mjs`; the gates in `publish.yml`

## Context

The contract names engine types such as `Mutation`. They are generated in the engine
repository and ship as the `.d.ts` of the published `@paged-media/canvas-wasm`.

Until 2026-06-06 plugin-api took its types from two editor packages through `link:`
dependencies, so it could not be published and needed a sibling editor checkout. Commit
`28850c0` removed both; `packages/plugin-api/src/editor.ts:15-21` records it. The first sync
script copied from that checkout and only warned when it was absent. A day later (commit
`60d4687`) it was pointed at the published package and made to fail when the source cannot
be resolved. Its header gives the reason: the copy is a protocol coupling, and a check that
cannot see its source is not a pass.

## Decision

plugin-api owns its types and depends on neither the editor nor the engine. Engine wire
types are a verbatim copy of the published package's `.d.ts`, stamped with the version they
were copied from, and refreshed by a script whose `--check` gates every publish.
Editor-facing shapes are hand-written in `editor.ts`.

- `sync-wire.mjs --check` fails on a content difference, on a stamp that differs from the
  installed version, and on a source it cannot resolve. `publish.yml` installs exactly the
  stamped version into a scratch directory and runs the check against it.
- The engine's capability catalog is vendored the same way from
  `@paged-media/introspect-wasm`. Its check has a third outcome: the copy may lead the
  published package while `catalog.provenance.json` declares the lead, gives a reason and
  targets a higher protocol, and it fails once the published package has caught up.
- An operation the engine has and the vendored wire lacks is never typed by editing the
  vendored file. `mutations.ts` keeps `PendingMutation` and `MutationInput` for that case,
  and the adapter casts once on the mutate path, where it calls `client.mutate`. At this
  commit all 17 members of `PendingMutation` are `Extract<Mutation, …>` aliases, and a
  type-level assertion fails the build if one stops being part of `Mutation`.

## Evidence

- `packages/plugin-api/src/wire.d.ts:1-4` — the generated header and the stamp `0.64.0`
- `scripts/sync-wire.mjs:13-21`, `:149-179` — source resolution; the failure cases
- `.github/workflows/publish.yml:45-55`, `:69-77` — the two gates before the publish step
- `scripts/sync-catalog.mjs:136-227`, `packages/plugin-api/catalog.provenance.json:1-9` — the
  three outcomes; the recorded source revision and `aheadOfPublished: false`
- `packages/plugin-api/src/mutations.ts:343-365`, `:367-397` — the two types and the gate
- `packages/plugin-sdk/src/host-impl.ts:1729-1736` — the cast on the mutate path; `:1868-1878`
  and `:2694-2702` carry the same kind of cast for wire messages
- `packages/plugin-sdk/src/wasm-loader.ts:247-271`, `packages/plugin-sdk/package.json:28` —
  the test harness derives the expected protocol from the stamp and refuses another wasm

## Alternatives considered

- Types re-exported from linked editor packages: removed in `28850c0`. `README.md:22-25`
  still describes that state.
- A check that skips when its source is missing: it left the check "silently inert"
  (`packages/plugin-sdk/test/sync-wire.spec.ts:15-20`).
- Hand-written object types for operations ahead of the wire: replaced on 2026-08-07 by the
  `Extract` aliases, because a hand-written literal that happens to match a generated one is
  a second type (`packages/plugin-api/src/mutations.ts:376-381`).
- Widening the client handle to accept such operations: refused; it would demand more of
  every host than the published wire promises (`DESIGN.md:200-204`).

## Consequences

Following a new engine protocol takes a commit here: re-sync, move the `canvas-wasm`
devDependency, bump the package version ([ADR 306](306-canary-releases.md)). 28 of the
repo's 122 commits touch `wire.d.ts`. The order across repositories is fixed: the engine
publishes, this repo re-syncs, consumers move their pins.

The gate does not force a re-sync: it compares the copy with the version it is stamped
with, not with the newest one. Commit `bb9940d` records the effect of lagging: once the
editor had moved to a newer engine package, its handle was no longer assignable to the
contract's. The vendored wire also cannot lead a published engine; operations needed
earlier wait in `PendingMutation` and cannot ride the wire's `batch` operation until the
re-sync (`DESIGN.md:198-199`).

`catalog.json` is vendored and gated, but no source file in this repo imports it, and the
package's `files` list and build script do not ship it.
Some comments predate the current state. `packages/plugin-api/src/index.ts:25-26` says the
wire is synced from the editor's generated output; `DESIGN.md:152-159` and
`packages/plugin-sdk/src/host-impl.ts:1729-1735` speak of a wire at protocol 51.

## Related

- [ADR 300](300-type-only-contract.md), [ADR 309](309-conformance-against-real-engine.md) —
  why the gate in `mutations.ts` is a type; the harness pinned to the stamp
- [ADR 006](https://github.com/paged-media/core/blob/main/docs/adr/006-protocol-coupled-versioning.md),
  [ADR 019](https://github.com/paged-media/core/blob/main/docs/adr/019-capability-catalog-one-contract.md)
  — the engine's version scheme; the catalog this repo copies

# ADR 307 — Bundles take the contract packages as peer dependencies

- **Status:** Accepted. Recorded retroactively on 2026-10-02 from the code at `d90f727`.
- **Scope:** how a bundle package depends on `@paged-media/plugin-api` and
  `@paged-media/plugin-sdk`. The rule lives in the bundle repositories and the editor.

## Context

`@paged-media/plugin-api` holds only types and `@paged-media/plugin-sdk` holds the values,
among them `loadBundle` and the `BundleHost` implementation
([ADR 300](300-type-only-contract.md), [ADR 301](301-host-adapter-lives-in-plugin-sdk.md)).
The host application builds a `BundleHost` and hands it to a bundle's `activate`, so host
and bundle have to mean the same `BundleHost` type.

Until 2026-08-06 the bundle packages listed both packages under `dependencies`. That day
one commit with one message landed in seven plugin repositories (plugin-draw `53d94c4`,
plugin-web `f0c7a7d`, plugin-image `3832d3a`, plugin-sheets `5c47b62`, plugin-data
`dd8529c`, plugin-doc `d542364`, plugin-publish `8eb54cc`). The message gives the reason: a
regular dependency "made npm install a private copy underneath this bundle, and a second
copy of a type-only contract is not a duplicate — it is a different type. A host on 0.2.29
could not pass its own `BundleHost` to a bundle holding 0.2.25's".

## Decision

Each first-party bundle package lists `@paged-media/plugin-api` and
`@paged-media/plugin-sdk` under `peerDependencies` with the range `>=0.2.29-canary.0`, and
pins an exact canary of each under `devDependencies` for its own build and tests. The host
application depends on both directly at one exact version, and the published bundles
resolve to that copy.

- The range is an open lower bound. The message calls the choice "measured rather than
  reasoned": plain semver matches no canary against `*`, `0.x` or `>=0.2.0-0`, but pnpm
  evaluates peer ranges with prereleases included, so the range accepts later canaries
  without an edit.
- `0.2.29-canary.0` is the first contract release whose vendored wire types come from
  `@paged-media/canvas-wasm` 0.61.0 (commit `6d1d08c` in this repo). The stated intent is
  that the range "still refuses a contract older than the protocol-61 wire".
- The exact `devDependencies` exist so that "each repo builds deterministically standalone".

## Evidence

- `plugin-draw: packages/draw-bundle/package.json:59-62`, `:24-25` — the peer range; the
  exact development pins
- `plugin-web: packages/web-bundle/package.json:19-22`, `plugin-image: glue/package.json:19-22`,
  `plugin-sheets: packages/sheet-bundle/package.json:19-22`,
  `plugin-data: packages/data-bundle/package.json:20-23`,
  `plugin-doc: packages/doc-bundle/package.json:34-37`,
  `plugin-publish: packages/pdf-bundle/package.json:21-24`,
  `plugin-publish: packages/publish-bundle/package.json:17-20` — the same range in the other
  seven bundles
- `editor: apps/canvas/package.json:36-37`, `editor: packages/tools/package.json:18-19` —
  the host's direct dependencies, both packages at `0.2.37-canary.0`
- `editor: pnpm-lock.yaml:951-954`, `:3036-3083` — one version of each contract package in
  the lockfile; every bundle entry is keyed by it
- `packages/plugin-sdk/package.json:16-26` — inside this repo plugin-sdk depends on
  plugin-api as `workspace:*`; its only peer is the optional one on React

## Alternatives considered

Regular dependencies, pinned again in every plugin on each protocol bump, were the earlier
arrangement; the message rejects it ("that manual loop cost six repos and five publishes
earlier today"). An exact peer version was set aside for the range ("not an exact pin").

## Consequences

A bundle's development pin may lag the host. At the pinned commits the bundles build
against `0.2.30-canary.0` (plugin-publish), `0.2.33-canary.0` (plugin-draw, plugin-web,
plugin-image, plugin-sheets, plugin-data) and `0.2.37-canary.0` (plugin-doc); the editor's
lockfile resolves every published bundle against the host's `0.2.37-canary.0`.

The range has no upper bound, so the package manager accepts any later host. Compatibility
across contract versions is checked at load, by the manifest's `apiVersion`
([ADR 304](304-bundle-lifecycle.md)).

This repository neither states nor checks the rule. A search for `peerDependencies` over
scripts, tests and workflows here, in the editor and in the seven plugin repositories
finds only plugin-sdk's check of its own optional React peer.

Two published bundles the editor installs predate the decision: its lockfile records
`@paged-media/pdf@0.2.5-canary.0` and `@paged-media/publish@0.1.0-canary.0` with an exact
peer `0.2.27-canary.0` (`editor: pnpm-lock.yaml:945-949`, `:962-966`), while plugin-publish
carries the range in source under the later versions `0.2.6-canary.0` and `0.1.1-canary.0`.
The editor consumes `@paged-media/doc` through a `link:` override to a sibling checkout,
not as a published package (`editor: package.json:35`).

## Related

- [ADR 300](300-type-only-contract.md), [ADR 301](301-host-adapter-lives-in-plugin-sdk.md) — why one copy of the type matters
- [ADR 302](302-vendored-wire-types.md), [ADR 306](306-canary-releases.md) — what a contract version carries; the canary versions the range is written against
- [ADR 201](https://github.com/paged-media/editor/blob/main/docs/adr/201-plugins-as-pinned-packages.md) — the host side: bundles as pinned published packages

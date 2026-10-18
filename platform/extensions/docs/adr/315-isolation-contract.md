# ADR 315 — The isolation contract: a plugin depends only on the published contract; a gap becomes a host door

- **Status:** Accepted. Recorded retroactively on 2026-10-02 from the code at `d90f727`;
  plugin repositories at plugin-sheets `71f37d7`, plugin-data `6b96ce5`, plugin-doc `76e1d06`,
  plugin-image `f7d21e5`, plugin-web `653a95e`, plugin-draw `0d12bf8`, plugin-publish `6994ad1`.
- **Scope:** what a first-party plugin may depend on, and what happens when the contract
  lacks something it needs.

## Context

`DESIGN.md:21-26` calls this SDK "the narrowest surface that lets both be built out of
repo" and says that "nothing enters the surface speculatively": every member maps to a need
a real plugin had. The plugin repositories hold the matching rule for the plugin's side.

Four plugin repositories state this as a hard rule named the isolation contract: "Zero core
contact AND zero inter-plugin contact: the only `@paged-media/*` dependencies are
`plugin-api`, `plugin-sdk`, and published package contracts"
(`plugin-sheets: CLAUDE.md:85-94`). The same passage says a gap in the SDK is recorded and
never closed by changing the engine from the plugin's side. plugin-image's README gives the
purpose: the plugin "runs under exactly the rules every external plugin runs under, and is
deliberately the heaviest stress test the plugin platform has"
(`plugin-image: README.md:10-12`).

The raw editor handle `host.editor` is the way off the surface. `DESIGN.md:592-598` calls
it "the API-gap detector": a use that no facade covers is a recorded gap, and the member
goes away at the isolate boundary ([ADR 319](319-trust-line.md)).

## Decision

A plugin's shipped code depends on the two published contract packages, on its own packages
and on React for panels; not on engine crates, editor packages or another plugin. A need
the contract does not meet is recorded and answered by a new door in the contract or a new
operation in the engine, which the plugin then consumes as published.

Two guards exist, copied into each repository that has them. In TypeScript,
`scripts/check-contract-imports.mjs` fails on a static `from "…"` import, in a non-test
`.ts`/`.tsx` file under `src/`, whose specifier is neither relative nor starts with an
allowed prefix; the root `test` script runs it first. In Rust, `deny.toml` denies unknown
registries and git sources and allows crates.io only, so that "a path/git reach-around into
core/editor internals cannot land silently" (`plugin-image: deny.toml:4-6`).

| Plugin | Rule stated | TypeScript lint | Rust guard | Departures |
|---|---|---|---|---|
| plugin-sheets | yes | yes, and a CI step | yes, in CI | none found |
| plugin-data | yes | yes, and a CI step; also allows the DuckDB and Arrow packages | yes, in CI | none found |
| plugin-doc | yes | yes, and a CI step | yes, in CI | took engine crates by git in one commit, reverted the same day |
| plugin-image | yes | yes, and a CI step | yes, in CI | none found |
| plugin-web | for the bundle | yes; no workflow runs it | no `deny.toml` | none found |
| plugin-draw | yes, as "the only sanctioned contract import" | yes; no workflow runs it | no `deny.toml` | one call through `host.editor` |
| plugin-publish | no | none | none | Rust crates take engine crates by git revision; IDML export goes through `host.editor` |

With or without the lint, the non-relative `@paged-media/*` imports in all seven
repositories are the two contract packages and the repository's own packages. Gaps met by a
door: plugin-doc needed to create anchored frames and hyperlinks, and both became engine
operations ("`plugin-doc` stays isolation-clean, `core` carries the door");
plugin-draw read planar regions and element properties through `host.editor` until
`host.document.planarRegions` and `elementProperties` were published, and the contract's
comments say each door "Retires" that use; plugin-sheets reads the datasets plugin-data
publishes through `host.dataProviders`. One is still open: plugin-data carries a graph-data
variable without resolving it and asks for "a cross-plugin chart-data contract through the
core SDK … not a dependency".

## Evidence

- `CLAUDE.md` at `plugin-sheets: :85-94`, `plugin-data: :88-99`, `plugin-doc: :63-69`,
  `plugin-image: :58-63` — the rule; narrower at `plugin-draw: :441-444`, `plugin-web: :20-24`
- `plugin-web: scripts/check-contract-imports.mjs:16-21`, `:35-48`, `plugin-web: package.json:11`
  — allow-list, import pattern, relative skip; the `test` script (same line in all six)
- `.github/workflows/vitest.yml` at `plugin-sheets: :65-66`, `plugin-data: :65-66`,
  `plugin-doc: :28-29`; `plugin-image: .github/workflows/ci.yml:182-183` — the lint in CI
- `plugin-doc: deny.toml:44-47`, `plugin-sheets: deny.toml:42-45`,
  `plugin-data: deny.toml:53-56`, `plugin-image: deny.toml:50-53` — the Rust guard
- `plugin-publish: Cargo.toml:20-29`, `plugin-publish: README.md:12-15`,
  `plugin-publish: packages/publish-bundle/src/io/idml.ts:74-84` — engine crates by git
  revision; export through the raw handle, "a transitional bridge"
- `plugin-draw: packages/draw-bundle/src/handlers/measure.ts:168-173`,
  `plugin-draw: packages/draw-bundle/src/handlers/planar-regions.ts:112-131`,
  `packages/plugin-api/src/host.ts:876-887` — the remaining raw call; a retired one
- `plugin-doc: docs/status.md:107-115`, `:131-139`;
  `plugin-sheets: packages/sheet-bundle/src/session.ts:1549-1557`;
  `plugin-data: data-dataset/src/lib.rs:73-83` — gaps met by a door, and one left open

## Alternatives considered

plugin-doc commit `c73381b` (2026-10-01) added three engine crates as git dependencies,
"git-pinned like plugin-publish pins them". Commit `dc65ac9`, the same day, removed them
because that "broke the isolation contract and turned CI's cargo-deny red"; the crate now
writes its package "with `zip` and plain strings" (`plugin-doc: docx-skeleton/src/lib.rs:22-25`).

## Consequences

A feature that needs a new door waits for a release of the engine, of this repository, or
of both. A plugin that needs an engine type keeps its own copy: plugin-doc mirrors a wire
shape "as a plugin-local type" (`plugin-doc: docx-export/src/overlay.rs:26-36`).
plugin-publish is outside the contract on its Rust side: it holds the IDML adapter crates,
and its README says the engine "consumes these adapter crates back across the same git
boundary" ([ADR 650](https://github.com/paged-media/plugin-publish/blob/main/docs/adr/650-mutual-git-revision-pins.md)).

The guards are uneven. plugin-web and plugin-draw have Rust crates and no `deny.toml`, and
their workflows run vitest per package instead of the root `test` script, so their import
lint runs only when someone runs `pnpm test`. Test files are outside the lint everywhere.
Two non-test call sites use `host.editor`, one in plugin-draw and one in plugin-publish
(both under Evidence); each names the missing door in a comment. Five of the six lint scripts
still tell the developer to record a gap in `BREAKAGE_LOG.md`, a file no plugin repository
contains any more (`plugin-draw: CLAUDE.md:440` records its retirement).

## Related

- [ADR 300](300-type-only-contract.md), [ADR 307](307-contract-as-peer-dependency.md), [ADR 305](305-doors-always-present.md), [ADR 314](314-plugin-shape.md), [ADR 319](319-trust-line.md) — the contract packages; how a plugin detects a door; the build shape; what the raw handle means for trust
- [ADR 014](https://github.com/paged-media/plugin-data/blob/main/docs/adr/014-data-provider-arrow-seam.md), [ADR 650](https://github.com/paged-media/plugin-publish/blob/main/docs/adr/650-mutual-git-revision-pins.md) — the cross-plugin data door; the adapter that pins the engine

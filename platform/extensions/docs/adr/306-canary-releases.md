# ADR 306 — Releases: a canary on every push, version-gated, published without tokens

- **Status:** Accepted. Recorded retroactively on 2026-10-02 from the code at `d90f727`.
- **Scope:** `.github/workflows/publish.yml`, `.github/workflows/contract-guard.yml`,
  `scripts/assert-contract-bumped.mjs`, and the `publishConfig` of the three packages

## Context

The editor and the plugin repositories install these packages from npm. Commit `28850c0`
(2026-06-06) introduced publishing as a canary lane that runs on every merge to `main`
instead of on chosen releases. The repository does not record why.

A lane that publishes only new versions is silent when nobody bumps one.
`scripts/assert-contract-bumped.mjs:4-8` records the first case: four contract commits
landed with no version change, and the npm canary "sat two protocols behind contract HEAD".

The first lane authenticated with a token secret. Commit `23e0a98` (2026-06-22) replaced it
with OIDC trusted publishing, to end "the token/2FA/account-ownership saga".

## Decision

One workflow publishes on every push to `main` (and on manual dispatch). A package is
published under the `canary` dist-tag if, and only if, the version in its `package.json` is
not on the registry yet.

- Before the publish step the job runs install, typecheck, build, the tests and the two
  vendoring gates ([ADR 302](302-vendored-wire-types.md)); any failure stops it.
- An unchanged version is skipped with a log line. To release, a commit bumps the version.
- A second workflow, on push and on pull request, fails a commit range that changes
  `packages/plugin-api/src` or `packages/plugin-sdk/src` without changing that package's
  version.
- Publishing is tokenless. `pnpm pack` builds the tarball, because it resolves `workspace:*`
  and applies `publishConfig`; `npm publish` uploads it under the runner's OIDC identity.
- In the repo each `package.json` points `main` and `types` at `src`; `publishConfig` swaps
  in `dist`. plugin-cli has no build and ships `bin`.
- The workflow passes no tag other than `canary` and has no step that moves `latest`.
- Package versions are a line of their own: `0.2.37-canary.0` for plugin-api and plugin-sdk,
  `0.1.4` for plugin-cli. The engine protocol is not part of these version numbers; it
  appears as the stamp in the vendored wire, as plugin-sdk's `canvas-wasm` devDependency
  and in `catalog.provenance.json`.

## Evidence

- `.github/workflows/publish.yml:1-18` — the header and the trigger; `:20-22` `id-token:
  write`; `:37-77` the steps before publishing; `:78-91` the version-gated loop
- `scripts/assert-contract-bumped.mjs:10-14`, `:33` — the rule and the two guarded packages
- `.github/workflows/contract-guard.yml:9-13`, `:28-33` — when the guard runs and its base
- `packages/plugin-api/package.json:7-12`, `:22-34` — development fields and `publishConfig`;
  the same in `packages/plugin-sdk/package.json:5-9`, `:45-56`
- `packages/plugin-cli/package.json:3`, `:10-12`, `:18-21` — version, `files`, `publishConfig`
- `scripts/assert-dist-tags.mjs:4-15` — the stated tag policy

## Alternatives considered

- A token secret: the original lane, replaced as described above.
- Moving `latest` together with `canary`: done in commit `983e495` (2026-06-07) and reversed
  in `3e1f02e` (2026-06-12), because a bare `npm install` resolves `latest` and must not be
  handed a prerelease (`scripts/assert-dist-tags.mjs:9-12`).
- A version without the prerelease suffix: commit `405947f` (2026-06-13) set `0.2.19` and
  called it the first stable release of the contract. The next version in the history,
  the same day, is `0.2.20-canary.0`.

## Consequences

A change reaches consumers only when a commit bumps the version. On direct pushes to `main`
the guard reports afterwards and cannot block (`.github/workflows/contract-guard.yml:5-7`).
The history shows it: eleven consecutive commits of 2026-08-04 and 2026-08-05 change
contract source at version `0.2.27-canary.1`, and the release commit that follows
(`0f792c6`) records that none of them had been published. Commit `bb9940d` records a second
occurrence.

The guard covers `src` of two packages. A change to plugin-cli's `bin` without a version
bump is skipped by the publish loop and reported by nothing.

No workflow in this repo checks the registry after publishing.
`scripts/assert-dist-tags.mjs:24-25` says it runs in CI after publish; nothing invokes it.

plugin-api and plugin-sdk are gated separately and need not carry the same version; the
history has commits where they differ (for example `9f8f9da`).

Statements that no longer hold: `.github/workflows/publish.yml:9` says every version is a
`-canary.N` prerelease, while plugin-cli is `0.1.4`; `README.md:20-22` says nothing is
published yet.

## Related

- [ADR 302](302-vendored-wire-types.md) — the gates that run before a publish, and why a
  wire re-sync needs a version bump here
- [ADR 304](304-bundle-lifecycle.md) — `API_VERSION`, which these package versions do not move
- [ADR 307](307-contract-as-peer-dependency.md) — how bundles depend on the published packages
- [ADR 006](https://github.com/paged-media/core/blob/main/docs/adr/006-protocol-coupled-versioning.md)
  — the engine's protocol-coupled versions, which these packages do not follow

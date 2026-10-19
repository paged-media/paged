# ADR PM-0011 — Dependency updates by Renovate, licences and advisories checked daily

- **Status:** Accepted 2026-10-19.
- **Scope:** `.github/renovate.json5`, `.github/workflows/supply-chain.yml`,
  `.github/workflows/moon.yml` (`continue-on-error`), `tooling/supply-chain/`, every
  `deny.toml`.

## Context

Waves U1–U4 brought every toolchain, crate and npm package to its current release by hand,
one reviewed series at a time ([npm-latest.md](../migration/npm-latest.md)). Nothing keeps it
there. Of the thirteen Cargo lockfiles, six were checked by cargo deny (in their component's
workflow, on pull requests touching that component), two had a `deny.toml` that no workflow
ran, five had none, and none was scanned by cargo audit. Nothing ran `bun audit`, and an
advisory published against a lockfile nobody touched reached no check at all.

Main takes direct pushes and has no required status checks; an update bot opens pull requests.

## Decision

1. **Renovate proposes the updates** (`.github/renovate.json5`). Runtime dependencies are
   grouped per Moon project and language (`rust: <project>`, `js: <project>`); Rust and
   JavaScript never share a PR. Majors, and 0.x minors (breaking by semver), are one PR per
   dependency and open only when approved on the dependency dashboard. Toolchains (Rust, Bun,
   proto, wasm-bindgen with its CLI pin, binaryen) move as one PR each, every pin of the tool
   together. A weekly schedule and the dashboard keep the noise down.
2. **Only development tooling merges itself**: patch and minor updates of dev-dependencies
   (patch only below 1.0), at least 7 days old, and only when every status check on the
   branch is green. Renovate does the waiting (`platformAutomerge: false`), because with no
   required checks GitHub's auto-merge would not. `moon ci` is binding on `renovate/*`
   branches. The byte- and pixel-sensitive crate families and the extension contract's own
   dependencies never merge themselves.
3. **Every Cargo workspace is checked**, found from the tracked `Cargo.lock` files rather than
   listed: cargo deny (licences under PM-0001, advisories, bans, sources) with its own
   `deny.toml`, and cargo audit with that file's ignore list, so an advisory is triaged in one
   place. A workspace without a `deny.toml` fails unless the script exempts it with a reason.
4. **`bun audit` fails on an advisory not on the allowlist**
   (`tooling/supply-chain/bun-audit-allowlist.json`). Every entry has an owner, a reason and
   an expiry; an expired entry fails, and so does an entry for an advisory that is gone.
5. **The supply-chain workflow runs on dependency changes and daily.** The component
   workflows keep their own cargo-deny steps as path-filtered pull-request gates.

## Consequences

- Nothing runs until the Renovate GitHub app is installed on the repository (an owner action);
  the config is validated in CI meanwhile.
- While the editor's Playwright shards are red for want of their secret, no PR touching the
  editor merges itself. That is the safe direction.
- Renovate cannot regenerate `bun.lock` for the Bun catalog (it reads pnpm and Yarn catalogs
  only), so a catalog PR needs `bun install` pushed to its branch; in-range catalog updates
  come with the monthly lock-file maintenance.
- A new advisory turns the daily run red without any change to the code, which is the point:
  it is triaged, fixed or allowlisted with an expiry.

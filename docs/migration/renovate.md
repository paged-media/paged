# Keeping dependencies current (U5)

Wave U4 moved every dependency to its current release by hand. U5 keeps it there: Renovate
proposes the updates, and a supply-chain workflow checks licences and advisories over every
Cargo workspace and the Bun workspace, every day. The decision is
[PM-0011](../adr/PM-0011-dependency-updates-and-supply-chain.md); this page records what is in
place and the numbers before and after.

| File | What it does |
|---|---|
| `.github/renovate.json5` | Renovate: groups, schedule, automerge policy, holds, custom managers |
| `.github/workflows/supply-chain.yml` | `rust`, `js` and `renovate` jobs on dependency changes and daily at 04:17 UTC |
| `tooling/supply-chain/rust-audit.mjs` | cargo deny + cargo audit over every tracked `Cargo.lock` |
| `tooling/supply-chain/bun-audit.mjs` | `bun audit` against an allowlist with expiry dates |
| `tooling/supply-chain/bun-audit-allowlist.json` | the advisories allowed, each with owner, reason and expiry |
| `modules/draw/deny.toml`, `modules/web/packages/web-render/deny.toml`, `platform/shared/test-resources/deny.toml` | the engine's policy for the three workspaces that had none |
| `.github/workflows/moon.yml` | `moon ci` stays advisory, except on `renovate/*` branches, where it is binding |

## Renovate

Renovate is not running yet: the Renovate GitHub app has to be installed on paged-media/paged
(a repository-owner action; see "Enabling it"). Until then the config is validated in CI and
does nothing else.

### Groups

| Group | What it holds |
|---|---|
| `rust: <project>` | non-major updates of one Cargo workspace: core, publish, image, draw, sheet (with its fuzz harness), data, doc, slide, web-render, test-resources, server |
| `js: <project>` | non-major updates of one Moon project's package.json files: core, core-idml-viewer, publish, image, draw, sheet, data, doc, slide, web, platform-shared, extensions, editor, and `js: root and catalog` |
| `js: dev tooling`, `rust: dev tooling` | patch and minor updates of devDependencies / dev-dependencies, across projects: the only groups that merge themselves |
| `rust toolchain` | every `rust-toolchain.toml` and the `toolchain:` pins in workflows, together |
| `bun` | `/.prototools` bun, `packageManager`, `@types/bun` |
| `proto toolchain` | moon and node in `/.prototools`, `proto-version` in workflows |
| `wasm-bindgen` | the wasm-bindgen crates in every Cargo.lock and `WASM_BINDGEN` in `tooling/bootstrap.sh` |
| `binaryen` | `BINARYEN` in `tooling/bootstrap.sh` and every CI download URL |
| `ci cargo tools` | cargo-deny, cargo-audit, cargo-nextest pinned in workflows |
| `github actions` | monthly; actions stay pinned by major tag, as today |
| `rust: web-render (blitz)` | the exact `=0.3.0-alpha.N` Blitz line; only on approval |
| majors, 0.x minors | one PR per dependency, opened only when ticked on the dependency dashboard |

Rust and JavaScript never share a PR. The pixel- and byte-sensitive crate families (vello and
wgpu, harfrust/skrifa/read-fonts, zip/flate2, image/png/zune, tiny-skia, resvg) carry the
`fidelity-gates` label and never merge themselves: they need the core fidelity, export-diff and
text-diff gates, as U3 required. The extension contract's own dependencies (plugin-api,
plugin-sdk) carry `contract` and never merge themselves.

Dev tooling is grouped per language rather than per project: grouped per project, a runtime
update in the same project would hold the dev-tooling update's automerge back, and ten PRs
would each rewrite `bun.lock`.

### Automerge

Main takes direct pushes and has no required status checks, and Renovate opens PRs. GitHub's own
auto-merge would merge such a PR before its checks finish, so `platformAutomerge` is off and
Renovate merges itself: only a PR whose updates are all patch or minor updates of development
tooling (patch only below 1.0), released at least 7 days ago, and only when every status check
on the branch is green. `moon ci` is one of them, and binding on `renovate/*` branches.

Until the `STATE_DISPATCH_TOKEN` secret exists, the editor's Playwright shards are red on every
PR that touches the editor, so a JS dev-tooling PR waits for a person. That is the intended
direction of failure: nothing merges on a red check.

### Noise

A weekly schedule (Monday before 07:00, Europe/Vienna), lock-file maintenance and GitHub Actions
monthly, at most 8 open PRs and 4 new ones an hour, a 3-day minimum release age (7 days for
automerge), and the dependency dashboard as the one place majors and 0.x minors wait. Security
advisories skip the schedule and the release age.

### Held, and why

| Dependency | Rule | Reason |
|---|---|---|
| `@duckdb/duckdb-wasm`, `apache-arrow` | every update needs approval | the SQL oracle must be re-recorded with the native duckdb CLI (npm-latest.md) |
| `@types/node` | `<25` | the typings follow the Node 24 runtime in `/.prototools` |
| `tailwindcss` 4 | a major: approval | its own series with a visual review (npm-latest.md) |
| peerDependencies, engines | disabled | the bundles' peer ranges are the public contract (PM-0008) |
| `@paged-media/*` | disabled | first-party packages resolve through `workspace:` |

### Catalog

Renovate reads pnpm and Yarn catalogs, not Bun's. A JSONata custom manager reports the entries
of `/package.json` `workspaces.catalog`, but Renovate cannot regenerate `bun.lock` for a custom
manager, so a catalog PR fails `bun install --frozen-lockfile` until someone runs
`bun install` on its branch and pushes the lockfile. In-range catalog updates arrive with the
monthly lock-file maintenance instead, which runs `bun install` itself.

### Enabling it

1. Install the Renovate GitHub app on the paged-media organisation, for paged-media/paged only
   (`https://github.com/apps/renovate`, "Configure").
2. Renovate opens an onboarding PR only when it finds no config; it finds
   `.github/renovate.json5` and starts with the dependency dashboard issue.
3. Nothing else: no branch protection or ruleset is needed, because Renovate waits for the
   checks itself.

## cargo deny + cargo audit

`tooling/supply-chain/rust-audit.mjs` finds the workspaces from the tracked `Cargo.lock` files
and runs, in each, `cargo deny --locked check advisories licenses bans sources` (with its own
`deny.toml`) and `cargo audit` (ignoring exactly the `[advisories] ignore` ids of that
`deny.toml`, so an advisory is triaged once). CI pins cargo-deny 0.20.2 and cargo-audit 0.22.2.
A missing tool fails the run; `--allow-missing` reports it as `unavailable` instead.

| Workspace | cargo deny before | after | cargo audit before | after |
|---|---|---|---|---|
| engine/core | core-licenses.yml | + supply chain | none | yes |
| modules/data, doc, sheet, slide | their `*-rust.yml` | + supply chain | none | yes |
| modules/image | image-ci.yml | + supply chain | none | yes |
| modules/publish | none (deny.toml unused) | supply chain | none | yes |
| apps/server/server | none (deny.toml unused) | supply chain | none | yes |
| modules/draw | none, no deny.toml | supply chain | none | yes |
| modules/web/packages/web-render | none, no deny.toml | supply chain | none | yes |
| platform/shared/test-resources | none, no deny.toml | supply chain | none | yes |
| modules/sheet/fuzz | none | exempt (sheet's policy) | none | yes |
| engine/core/spikes/blitz-wasm | none | exempt (never shipped) | none | yes |

So cargo deny went from 6 of 13 lockfiles to 11 (the two exempt ones are satellites of a
checked workspace), and cargo audit from 0 to 13. All 11 pass locally with cargo-deny 0.19.8.
web-render needed the two unmaintained-crate ignores the engine already carries (ttf-parser,
rustybuzz, both via usvg), now that its `deny.toml` checks every feature, the Blitz stack
included. The component workflows keep their own cargo-deny steps: they gate pull requests on
their paths, while this job sees every workspace and runs daily.

## bun audit

`bun audit` reads `/bun.lock` and needs no install. It reports one advisory, only cleared
by Tailwind 4 (held, see npm-latest.md), build-time only (the braces advisory under the same
chain is no longer reported, and its entry is gone):

| Advisory | Package | Severity | Allowed until |
|---|---|---|---|
| GHSA-rj75-hqrm-r3gf | postcss-selector-parser (tailwindcss 3 > postcss-nested) | moderate | 2026-12-31 |

`tooling/supply-chain/bun-audit.mjs` fails on an advisory the list does not name, on a listed
one past its expiry, and on a listed one bun no longer reports (delete the entry in the change
that clears it). It exits 2, not 0, when bun audit could not answer, so a registry outage does
not read as a clean audit.

## Running it locally

```bash
bun tooling/supply-chain/bun-audit.mjs
bun tooling/supply-chain/rust-audit.mjs --allow-missing      # cargo-deny, cargo-audit if installed
bun tooling/supply-chain/rust-audit.mjs --only modules/draw
```

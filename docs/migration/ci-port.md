# CI port: per-component workflows to the repository root

GitHub runs only the workflows in the root `.github/workflows/`. The import
kept every component's own `.github/workflows/` under its prefix, where it was
inert. This step moved them to the root, one file per original workflow, and
adapted them to the monorepo layout without changing what they test: same
commands, toolchains, matrices and gates. The only steps that were removed
existed to wire sibling repositories together.

CI has not run on these files yet. It can only run once the repository is
pushed, so nothing here is evidence that a workflow is green.

## Conventions

- **File and name.** `.github/workflows/<component>-<name>.yml`, with
  `name: <component> / <name>`. Component ids: `core`, `editor`,
  `extensions`, `publish`, `image`, `draw`, `sheet`, `data`, `doc`, `slide`,
  `web`. Every move is a `git mv`, so `git log --follow` reaches the old
  history.
- **Triggers.** `push` (main) and `pull_request` carry `paths:` filters: the
  component prefix plus the workflow file itself. Where a job also builds
  from another prefix, that prefix is in the filter too. Where the old
  `pull_request` filter was narrower than the whole repo, it was kept and
  prefixed. `schedule`, `workflow_dispatch` and `repository_dispatch` are
  unchanged.
- **Working directory.** `defaults.run.working-directory: <prefix>` at
  workflow level. Workflows whose jobs check nothing out (`*-notify-docs`,
  `editor-cf-*`) have no default, because a missing directory fails the step.
  A `run:` step that comes before the checkout (the disabled publish
  workflows' `gh api` poll) sets `working-directory: .`.
- **`uses:` inputs.** `working-directory` does not apply to `uses:` steps, so
  their path inputs carry the prefix explicitly: upload/download-artifact
  `path`, rust-cache `workspaces` (`<prefix> -> target`), setup-node
  `cache-dependency-path`, actions/cache `path` and `hashFiles()`,
  pnpm/action-setup `package_json_file` where the old file relied on a root
  `packageManager`, and cargo-deny-action `manifest-path` (cargo-deny then
  reads the `deny.toml` beside that manifest; checked locally).
- **Caches.** Each rust-cache gets `prefix-key: v0-rust-<component>`. The
  separate repositories had separate caches; in one repository the default
  key (`v0-rust-<job id>-…`) would let e.g. data's `check` job restore doc's
  `check` target dir. This is isolation for equivalence, not a speed change.
- **Concurrency.** Every existing group is prefixed with the component
  (`rust-${{ github.ref }}` becomes `data-rust-${{ github.ref }}`). No new
  groups were added.
- **CLA.** The nine identical per-component `cla.yml` copies (they pointed at
  paged-media/core's CLA.md) were deleted. The root `cla.yml` covers the repo.
- **Publishing.** Built-in module publish workflows are disabled: ported with
  `on: workflow_dispatch` only and the header "Disabled in the monorepo:
  built-in modules are no longer published separately (PM-0008). Kept for
  reference until wave D." `core-publish-wasm.yml` keeps `push: tags: v*`
  (tags stay `v0.<P>.<n>` at the root). `extensions-publish.yml` is
  dispatch-only until npm Trusted Publishers are re-registered.
  _Wave D (2026-10-18): all of these, and `editor-playground.yml`, are deleted;
  `release.yml` publishes the four public packages from a tag and deploys the
  editor ([npm-release-runbook.md](npm-release-runbook.md))._

## File map

| Old repo / workflow | New file | What changed |
|---|---|---|
| core `ci.yml` | `core-ci.yml` | paths `engine/core/**`; default wd `engine/core`; rust-cache ×5 workspaces + prefix-key; nextest + viewer JUnit artifact paths prefixed; viewer step wd `engine/core/web/idml-viewer`; **protocol-tag-guard `CHANNEL` = `engine/core/crates/paged-canvas/src/channel.rs`** (see below) |
| core `fidelity.yml` | `core-fidelity.yml` | push paths added; PR paths `engine/core/crates/**`, `engine/core/corpus/**`; default wd; rust-cache |
| core `gpu.yml` | `core-gpu.yml` | push paths added; PR paths prefixed (paged-gpu, paged-compose, paged-renderer, corpus/generated); default wd; rust-cache; JUnit path |
| core `licenses.yml` | `core-licenses.yml` | paths; cargo-deny `manifest-path: engine/core/Cargo.toml` |
| core `notify-docs.yml` | `core-notify-docs.yml` | path filter → `engine/core/crates/paged-introspect/catalog.json` (still the one file docs consumes; workflow file deliberately not added, so editing the workflow does not ping docs); no checkout, no default wd; payload still says `repo: core` |
| core `perf-nightly.yml` | `core-perf-nightly.yml` | default wd; rust-cache; previous-run lookup `gh run list --workflow core-perf-nightly.yml`; artifact `engine/core/perf-results.json` |
| core `publish-wasm.yml` | `core-publish-wasm.yml` | default wd; trigger unchanged (tags `v*` + dispatch); notice/comments name repo `paged` and workflow `core-publish-wasm.yml` |
| core `cla.yml` | deleted | root `cla.yml` |
| editor `tests.yml` | `editor-tests.yml` | single root checkout (was `editor/` + siblings); **core checkout removed**: paged-gen builds from `engine/core`; corpus checkout kept, now at `apps/editor/corpus`; pnpm/action-setup `package_json_file: apps/editor/package.json` (checks job); cache-dependency-path, actions/cache paths (`engine/core/target`, `modules/doc/target`) and `hashFiles('engine/core/Cargo.lock')`, artifact paths prefixed; composite actions `./.github/actions/...`; paths `apps/editor/**` (PR: old list prefixed) + `modules/doc/**`, `modules/slide/**`, `engine/core/crates/paged-gen/**`, both composite actions |
| editor `playground.yml` | `editor-playground.yml` | root checkout; actions/cache `modules/doc/target`; cache-dependency-path; composite actions; wd `apps/editor[/apps/canvas]`; push paths `apps/editor/**`, `modules/doc/**`, `modules/slide/**`, composite actions |
| editor `showcase-nightly.yml` | `editor-showcase-nightly.yml` | root checkout; **core checkout removed**: regen-fixtures / fetch-profiles run in `engine/core`; rust-cache `engine/core -> target`; composite actions; artifact paths prefixed |
| editor `protocol-version.yml` | `editor-protocol-version.yml` | PR paths prefixed with `apps/editor/`; `package_json_file`; default wd |
| editor `cf-ai-setup.yml` | `editor-cf-ai-setup.yml` | name; dispatches `editor-playground.yml`; message names `-R paged-media/paged` |
| editor `cf-dns.yml`, `cf-setup.yml` | `editor-cf-dns.yml`, `editor-cf-setup.yml` | name only (no checkout) |
| editor `cla.yml` | deleted | root `cla.yml` |
| editor `.github/actions/plugin-doc-from-source` | `.github/actions/plugin-doc-from-source` | **checkout of paged-media/plugin-doc removed**; builds in `modules/doc` |
| editor `.github/actions/plugin-slide-from-source` | `.github/actions/plugin-slide-from-source` | **checkout of paged-media/plugin-slide removed**; builds in `modules/slide` |
| plugin-sdk `vitest.yml` | `extensions-vitest.yml` | paths; default wd `platform/extensions`; cache-dependency-path; JUnit path |
| plugin-sdk `contract-guard.yml` | `extensions-contract-guard.yml` | paths; default wd; **scripts fixed** (see below) |
| plugin-sdk `notify-docs.yml` | `extensions-notify-docs.yml` | path filter → `platform/extensions/packages/plugin-api/src/manifest.schema.json`; payload still `repo: plugin-sdk` |
| plugin-sdk `publish.yml` | `extensions-publish.yml` | **workflow_dispatch only** until Trusted Publishers are re-registered; default wd |
| plugin-sdk `cla.yml` | deleted | root `cla.yml` |
| plugin-publish `ci.yml` | `publish-ci.yml` | paths; default wd `modules/publish`; rust-cache ×2; cache-dependency-path ×2; three artifact paths |
| plugin-publish `publish.yml` | `publish-publish.yml` | **disabled** (dispatch only) |
| plugin-image `ci.yml` | `image-ci.yml` | paths `modules/image/**` + `platform/extensions/packages/plugin-cli/**`; default wd; rust-cache ×4 (keys `gpu-sw`, `gpu-metal`, `wasm` kept); **ts job: plugin-image/ + plugin-sdk/ nested checkouts → one root checkout**; manifest validate uses the in-tree plugin-cli |
| plugin-image `publish-state.yml` | `image-publish-state.yml` | evidence artifacts only, stays enabled; paths; **plugin-sdk checkout removed**; `plugin-image/*/junit.xml` → `./*/junit.xml`; artifact paths |
| plugin-image `publish.yml` | `image-publish.yml` | **disabled** (dispatch only; `workflow_run` on `ci` removed) |
| plugin-image `cla.yml` | deleted | root `cla.yml` |
| plugin-draw `rust.yml` | `draw-rust.yml` | paths `modules/draw/**` + plugin-cli; **paged-media/sdk checkout removed**; manifest validate runs `$GITHUB_WORKSPACE/platform/extensions/packages/plugin-cli/bin/paged-plugin.mjs` (verified locally, needs no install); per-step `working-directory: plugin-draw` → default |
| plugin-draw `vitest.yml` | `draw-vitest.yml` | paths; checkout at root; `--dir plugin-draw` and `plugin-draw/` prefixes → cwd-relative; JUnit path |
| plugin-draw `publish.yml` | `draw-publish.yml` | **disabled** (dispatch only) |
| plugin-draw `cla.yml` | deleted | root `cla.yml` |
| plugin-sheets `rust.yml` | `sheet-rust.yml` | paths; default wd `modules/sheet`; rust-cache ×3; cargo-deny manifest-path; JUnit path |
| plugin-sheets `vitest.yml` | `sheet-vitest.yml` | paths; **paged-media/sdk checkout removed** (nothing read it); `plugin-sheets/` prefixes and `--dir` → cwd-relative; JUnit path |
| plugin-sheets `fuzz.yml` | `sheet-fuzz.yml` | default wd; fuzz step wd `modules/sheet/fuzz`; crash artifact path |
| plugin-sheets `publish.yml` | `sheet-publish.yml` | **disabled** (dispatch only; `workflow_run` removed); polls `sheet-rust.yml` |
| plugin-sheets `cla.yml` | deleted | root `cla.yml` |
| plugin-data `rust.yml` | `data-rust.yml` | paths; default wd `modules/data`; rust-cache ×3; cargo-deny manifest-path; JUnit path |
| plugin-data `vitest.yml` | `data-vitest.yml` | paths; checkout at root (was `plugin-data/`); `plugin-data/` prefixes and `--dir` → cwd-relative; rust-cache; JUnit path |
| plugin-data `publish.yml` | `data-publish.yml` | **disabled** (dispatch only; `workflow_run` removed); polls `data-rust.yml` |
| plugin-data `cla.yml` | deleted | root `cla.yml` |
| plugin-doc `rust.yml` | `doc-rust.yml` | push paths (push-only, as before); default wd; rust-cache ×3; cargo-deny manifest-path; JUnit path |
| plugin-doc `vitest.yml` | `doc-vitest.yml` | push paths (push-only, as before); default wd; JUnit path |
| plugin-doc `publish.yml` | `doc-publish.yml` | **disabled** (dispatch only) |
| plugin-doc `cla.yml` | deleted | root `cla.yml` |
| plugin-slide `bundle.yml` | `slide-bundle.yml` | paths; default wd; rust-cache; `package_json_file: modules/slide/package.json`; JUnit path |
| plugin-slide `rust.yml` | `slide-rust.yml` | paths; default wd; rust-cache ×2; cargo-deny manifest-path; JUnit path |
| plugin-slide `publish.yml` | `slide-publish.yml` | **disabled** header (it was already dispatch-only); `package_json_file` |
| plugin-web `rust.yml` | `web-rust.yml` | paths; default wd `modules/web/packages/web-render` (was `packages/web-render`); rust-cache; JUnit path |
| plugin-web `vitest.yml` | `web-vitest.yml` | paths; default wd `modules/web`; rust-cache `modules/web/packages/web-render`; JUnit path |
| plugin-web `publish.yml` | `web-publish.yml` | **disabled** (dispatch only; `workflow_run` removed); polls `web-rust.yml` |
| plugin-web `cla.yml` | deleted | root `cla.yml` |

`apps/server` has no CI: its old TS-only `ci.yml` was not imported.

## Repository-root-relative git paths

`git show <rev>:<path>` resolves `<path>` from the repository root, not from
the working directory. After the move, every such lookup with a
component-relative path fails quietly:

- **`core-ci.yml` protocol-tag-guard.** With `crates/paged-canvas/src/channel.rs`
  the guard parsed no protocol at HEAD and exited 0 with "skipping" on every
  push. It now uses `engine/core/crates/paged-canvas/src/channel.rs`.
  Checked against this repo: protocol 74 at HEAD, tag `v0.74.0` found. The
  tag-on-bump nudge reads the file from disk, so its relative path still works.
- **`platform/extensions/scripts/assert-contract-bumped.mjs`.** `versionAt()`
  returned null for every package, so the guard could never report a
  violation.
- **`platform/extensions/scripts/assert-untyped-shrinks.mjs`.** It always
  reported "absent at base" and skipped.

Both scripts now use `<rev>:./<path>`, which resolves relative to the git
cwd they already set (the package root) and is correct in either layout.
Verified: an unbumped `plugin-api/src` change fails the guard again.

No other workflow-invoked script uses repository-relative git paths.
(`engine/core/scripts/perf/criterion-summary.py` only reads `rev-parse HEAD`.
`modules/slide/scripts/sync-ooxml.sh` uses `git -C <src>` outside `--check`.)

## Could not be ported faithfully, or depends on another step

1. **Editor link overrides (needs A4).** `apps/editor/package.json` (and its
   lockfile) still say `link:../plugins/plugin-doc/packages/doc-bundle` and
   `link:../plugins/plugin-slide/...`. From `apps/editor` those resolve to
   `apps/plugins/...`, which does not exist. The composite actions now build
   `modules/doc` and `modules/slide` in place, but the editor reaches them
   only once the overrides point at `../../modules/doc/packages/doc-bundle`
   and `../../modules/slide/packages/slide-bundle`. Until then
   `editor-tests` (Playwright), `editor-playground` and
   `editor-showcase-nightly` install a dangling link, and the app does not
   boot.
2. **Image manifest package (needs A4).**
   `modules/image/manifest/package.json` runs
   `node ../../plugin-sdk/packages/plugin-cli/bin/paged-plugin.mjs` for both
   `typecheck` and `test`, and `image-ci`'s ts job runs `pnpm -r typecheck`
   and `pnpm -r test`. The relative path now points at
   `modules/plugin-sdk/...`, which does not exist, so the ts job fails until
   the path is rewired to `platform/extensions/packages/plugin-cli`. The
   `validate:manifest` scripts in `modules/{data,doc,image,sheet,slide}/package.json`
   use the same `../plugin-sdk` path but no workflow calls them.
3. **Showcase harness (needs A4).** `apps/editor/apps/canvas/tests/showcase/chapter.ts`
   (`WORKSPACE`/`CORE`), `chapters/900-assemble.spec.ts` and
   `assets/gen-*.py` look for core at `<editor>/../core` (that is,
   `apps/core`). The workflow prepares `engine/core` (fixtures and CMYK
   profile), but the harness will not find it until those paths are rewired.
4. **Corpus location.** The private `paged-media/corpus` checkout in
   `editor-tests` lands at `apps/editor/corpus`. The vite config resolves
   `<editor>/corpus` first, and that stays a valid fallback after A4 moves
   the default to `<repo root>/corpus`. The checkout needs a secret
   (`STATE_DISPATCH_TOKEN`, falling back to `github.token`), so `editor-tests`
   cannot pass on fork PRs of the public repo. This breaks the "builds
   without private resources" invariant, as it did before the move.
5. **Shared target directory (Rust build-speed step).** Every path assumes
   one `target/` per Cargo workspace, beside the workspace. If a root
   `.cargo/config.toml` introduces a shared `build.target-dir`, these move:
   - rust-cache `workspaces: <prefix> -> target` (all Rust workflows);
   - the `<prefix>/target/nextest/ci/junit.xml` artifact paths (core-ci,
     core-gpu, data/doc/sheet/slide-rust, web-rust, image-publish-state,
     publish-ci);
   - `target/wasm32-unknown-unknown/wasm-release/*.wasm` in core-publish-wasm;
   - `target/wasm32-unknown-unknown/release/image_js.wasm` in image-ci;
   - `./target/release/paged-gen` and the actions/cache paths
     `engine/core/target` and `modules/doc/target` in editor-tests;
   - `modules/doc/target` in editor-playground.
6. **`RUSTFLAGS` set by workflows** (kept exactly as they were):
   `core-ci.yml`, `image-ci.yml` and `publish-ci.yml` set
   `RUSTFLAGS: -Dwarnings` at workflow level. No other workflow or composite
   action sets it.
7. **One cache quota.** The eleven repositories each had a 10 GB Actions
   cache. The monorepo has one 10 GB cache, so eviction will be heavier.
   `prefix-key` keeps the namespaces apart but does not add space. This is
   for the CI-speed step.
8. **Path filters and required checks.** A path-filtered workflow that does
   not run never reports, so a branch-protection rule that requires it would
   leave unrelated PRs pending. Required checks for paged-media/paged must be
   chosen with that in mind (or given an always-run aggregator). Check names
   changed too: workflow names now carry the component prefix.
9. **Evidence consumers.** The state/cockpit pullers fetch artifacts
   (`nextest-junit`, `vitest-junit`, `playwright-results`, `paged-fidelity-*`,
   …) per old repository and workflow file. Those are now one repository,
   paged-media/paged, under new file names. Several workflows upload
   artifacts with the same name (for example `nextest-junit` from core-ci,
   data/doc/sheet/slide/web-rust, image-publish-state and publish-ci), so a
   puller must key on the workflow file, not the artifact name.
10. **Trusted publishing.** `core-publish-wasm` now presents the OIDC claims
    `repository: paged-media/paged`, `workflow: core-publish-wasm.yml`. It
    still authenticates with `NPM_TOKEN`, which must be set on the new
    repository. `extensions-publish` stays dispatch-only until the Trusted
    Publishers of `plugin-api`, `plugin-sdk`, `plugin-cli`, `ai` and `cli`
    are re-registered for paged-media/paged + `extensions-publish.yml` (a
    user action on npmjs.com). After that, restore `push` with a
    `platform/extensions/**` filter.
11. **Cross-repository Cargo git dependencies (unchanged here).** Eleven
    `engine/core` crates git-depend on paged-media/plugin-publish
    (`idml-import`/`idml-export`, pinned rev). `modules/publish` and
    `apps/server/server` git-depend on paged-media/core. CI still fetches
    those over https from the old public repositories. Turning them into
    path dependencies is not a CI change.
12. **Behaviour changes that follow from the layout:**
    - `editor-tests` builds paged-gen from the same revision as the editor.
      Before, it used an unpinned checkout of core's default branch, which
      forced a push-order coupling.
    - core's protocol guards now run only when a push touches `engine/core`.
      That is fine, because only such a push can change `PROTOCOL_VERSION`.
    - `editor-playground` now redeploys when `modules/doc` or `modules/slide`
      changes.
    - On its first run in the new repository, `core-perf-nightly` finds no
      previous run to compare against.
    - `fetch-depth: 0` (the core protocol guards and contract-guard) now
      fetches the whole monorepo history.
13. **Kept as before, could now be simpler** (left for later steps):
    `doc-vitest`, `slide-bundle` and `publish-ci` still validate manifests
    with the published `npx @paged-media/plugin-cli@canary`, not the in-tree
    CLI. `editor-playground` still listens for
    `repository_dispatch: engine-updated`, which no in-tree workflow sends.
    The pnpm versions are unchanged: editor jobs use 9, module jobs use 10 or
    their `packageManager`.
14. **`check-plugin-pins.mjs`** (editor-protocol-version) scans `apps/plugins`
    and `apps/*` for plugin repos, finds none and self-skips, as it did in
    CI before. If A4 points it at `modules/`, it starts comparing pins
    against in-tree versions.

## Validation

- `actionlint` 1.7.12 on all 43 root workflows. The one finding is
  `core-gpu.yml` SC2012 (info: `ls` in the lavapipe ICD lookup), which was
  already in core's `gpu.yml` before the move. A baseline run of actionlint
  over the 42 original (non-CLA) files reports exactly that finding and nothing else.
  The one new finding the port introduced (SC2035 on `cat */junit.xml`) was
  fixed with `./*/junit.xml`.
- A structural check over all workflows found no problems:
  - no `run:` step executes in a directory that only exists after a later
    checkout;
  - no unprefixed `working-directory` or `uses:` path input;
  - every push/pull_request has a path filter that names its own file;
  - workflow names and concurrency groups are unique.
- Leftover grep: the only `repository: paged-media/` is the corpus checkout.
  No `../sdk`, `../core`, `../plugins` or `../editor` remains in a workflow
  or action. `../plugin-sdk` appears only in an explanatory comment in
  `doc-vitest.yml`.

## Secrets and variables per workflow (names only)

| Workflow | Secrets / tokens |
|---|---|
| `cla.yml` (root, unchanged) | `CLA_SIGN_TOKEN`, `GITHUB_TOKEN` |
| `core-notify-docs.yml`, `extensions-notify-docs.yml` | `DOCS_DISPATCH_TOKEN` (unset → skip) |
| `core-perf-nightly.yml` | `github.token` |
| `core-publish-wasm.yml` | `NPM_TOKEN`; OIDC `id-token: write` |
| `editor-tests.yml` | `STATE_DISPATCH_TOKEN` (corpus read; falls back to `github.token`) |
| `editor-playground.yml`, `editor-cf-setup.yml` | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` |
| `editor-cf-ai-setup.yml` | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `ANTHROPIC_API_KEY`, variable `ANTHROPIC_WORKSPACE_ID`, `github.token` |
| `editor-cf-dns.yml` | `CLOUDFLARE_DNS_TOKEN`, `CLOUDFLARE_API_TOKEN` |
| `draw-rust.yml` | `github.token` (setup-binaryen) |
| `data-publish.yml` (disabled) | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `github.token`; OIDC |
| `sheet-publish.yml`, `web-publish.yml` (disabled) | `github.token`; OIDC |
| `doc-`, `draw-`, `image-`, `publish-`, `slide-publish.yml` (disabled), `extensions-publish.yml` | OIDC `id-token: write` only |
| all other workflows | none |

No longer used, because the sibling checkouts are gone:
`STATE_DISPATCH_TOKEN` in draw/rust, sheet/vitest, image/ci and
image/publish-state, and in editor/tests for the core checkout (the corpus
checkout still uses it).

## Timing baseline

The "before" numbers that later CI-speed work will be measured against.
They were collected read-only with `gh run list` and `gh api` GETs on
2026-10-18. Raw data: [`ci-timing-baseline.json`](ci-timing-baseline.json).

**Method.** For every old workflow that runs on push/pull_request, the most
recent successful run on `main` was used. For core `publish-wasm`, which is
tag-triggered, the latest successful tag run was used instead.

- **Job times.** Queue = job `started_at − created_at`; run =
  `completed_at − started_at`.
- **Workflow times.** Wall = first job created to last job completed;
  job minutes = sum of job run times.
- **Step buckets.**
  - *setup*: job set-up and teardown, checkout, toolchains, tool and
    dependency installs.
  - *cache*: rust-cache and actions/cache restore and save.
  - *build/test*: everything that builds or tests. In the editor jobs this
    includes the doc/slide wasm builds of the composite actions.
  - *artifact/report*: uploads, downloads, publish, deploy and summaries.

**Not covered.** These have no successful main run:
`editor/protocol-version.yml` (PR-only) and `plugin-doc/publish.yml` (never
succeeded). Excluded by trigger type: workflow_run publishers, schedule-only
and dispatch-only workflows, and `cla.yml`.

**Caveat.** The org's concurrent-job limit is shared by all repositories.
Several runs queued for a long time (core ci up to 44 min, plugin-publish ci
43 min) behind other repositories' jobs, so wall time is
queue-dominated there. The run-time and job-minute columns are the
comparable numbers.

Total over the 29 workflows with a run: **395.3 job-minutes** for one pass
of each.

### Per workflow

| Repo | Workflow | Run | Wall | Job minutes | Max queue | Jobs (run time, runner) |
|---|---|---|---|---|---|---|
| core | ci.yml | [39103264262](https://github.com/paged-media/core/actions/runs/39103264262) | 106m44s | 105.0 | 44m23s | tag-on-bump nudge 5s (ubuntu-latest); resolve pinned toolchain 5s (ubuntu-latest); protocol-tag-guard 5s (ubuntu-latest); idml-viewer vitest 15s (ubuntu-latest); check + test (ubuntu-latest) 29m29s (ubuntu-latest); pdf export-diff gate 14m52s (ubuntu-latest); nextest evidence 23m01s (ubuntu-latest); wasm test lane (stub, pending W0.8) 2m40s (ubuntu-latest); check + test (macos-latest) 33m42s (macos-latest); wasm-size gate (Spike C) 46s (ubuntu-latest) |
| core | fidelity.yml | [39105589731](https://github.com/paged-media/core/actions/runs/39105589731) | 33m56s | 21.4 | 17m09s | resolve pinned toolchain 6s (ubuntu-latest); corpus diff (macos-latest) 7m20s (macos-latest); corpus diff (ubuntu-latest) 13m59s (ubuntu-latest) |
| core | gpu.yml | [39105589730](https://github.com/paged-media/core/actions/runs/39105589730) | 25m36s | 16.7 | 7m22s | resolve pinned toolchain 6s (ubuntu-latest); vello on lavapipe 16m35s (ubuntu-latest) |
| core | licenses.yml | [39105589903](https://github.com/paged-media/core/actions/runs/39105589903) | 2m30s | 0.8 | 1m44s | cargo-deny 46s (ubuntu-latest) |
| core | notify-docs.yml | [39103298182](https://github.com/paged-media/core/actions/runs/39103298182) | 5m47s | 0.1 | 5m44s | ping 3s (ubuntu-latest) |
| core | publish-wasm.yml | [39103067950](https://github.com/paged-media/core/actions/runs/39103067950) | 21m03s | 17.5 | 3m31s | publish 17m32s (ubuntu-latest) |
| editor | tests.yml | [39096590608](https://github.com/paged-media/editor/actions/runs/39096590608) | 54m58s | 158.7 | 26s | checks (lint + boundaries + boot-coi + thresholds) 54s (ubuntu-latest); playwright (shard 1/3) 53m28s (ubuntu-latest); playwright (shard 3/3) 53m55s (ubuntu-latest); playwright (shard 2/3) 49m50s (ubuntu-latest); merge reports + publish evidence 35s (ubuntu-latest) |
| editor | playground.yml | [39102316682](https://github.com/paged-media/editor/actions/runs/39102316682) | 16m18s | 16.2 | 7s | deploy 16m11s (ubuntu-latest) |
| editor | protocol-version.yml | — | — | — | — | no successful run on main |
| plugin-sdk | vitest.yml | [39104436980](https://github.com/paged-media/plugin-sdk/actions/runs/39104436980) | 4m33s | 0.5 | 4m02s | vitest 31s (ubuntu-latest) |
| plugin-sdk | contract-guard.yml | [39104436961](https://github.com/paged-media/plugin-sdk/actions/runs/39104436961) | 14m12s | 0.2 | 14m02s | bump-on-contract-change 10s (ubuntu-latest) |
| plugin-sdk | notify-docs.yml | [38165204744](https://github.com/paged-media/plugin-sdk/actions/runs/38165204744) | 23s | 0.1 | 20s | ping 3s (ubuntu-latest) |
| plugin-sdk | publish.yml | [37431717890](https://github.com/paged-media/plugin-sdk/actions/runs/37431717890) | 41s | 0.7 | 2s | verify-and-publish 39s (ubuntu-latest) |
| plugin-publish | ci.yml | [39103521764](https://github.com/paged-media/plugin-publish/actions/runs/39103521764) | 44m00s | 3.0 | 43m34s | fmt + clippy + build 1m19s (ubuntu-latest); tests (evidence) 1m24s (ubuntu-latest); bundles typecheck + build + validate 20s (ubuntu-latest) |
| plugin-publish | publish.yml | [31032919544](https://github.com/paged-media/plugin-publish/actions/runs/31032919544) | 25s | 0.3 | 9s | publish 16s (ubuntu-latest) |
| plugin-image | ci.yml | [38389428083](https://github.com/paged-media/plugin-image/actions/runs/38389428083) | 3m55s | 9.9 | 7s | rust GPU tests (Metal) 3m48s (macos-14); rust engine 1m47s (ubuntu-latest); rust GPU tests (lavapipe) 2m39s (ubuntu-24.04); ts bundle 1m39s (ubuntu-latest) |
| plugin-image | publish-state.yml | [38389428020](https://github.com/paged-media/plugin-image/actions/runs/38389428020) | 1m11s | 1.5 | 2s | vitest evidence 23s (ubuntu-latest); nextest evidence 1m09s (ubuntu-latest) |
| plugin-draw | rust.yml | [38870353614](https://github.com/paged-media/plugin-draw/actions/runs/38870353614) | 32s | 0.5 | 2s | rust 30s (ubuntu-latest) |
| plugin-draw | vitest.yml | [38870353446](https://github.com/paged-media/plugin-draw/actions/runs/38870353446) | 1m47s | 1.8 | 2s | vitest 1m45s (ubuntu-latest) |
| plugin-draw | publish.yml | [38870353627](https://github.com/paged-media/plugin-draw/actions/runs/38870353627) | 2m13s | 2.2 | 2s | publish 2m11s (ubuntu-latest) |
| plugin-sheets | rust.yml | [39098219634](https://github.com/paged-media/plugin-sheets/actions/runs/39098219634) | 1m09s | 2.9 | 2s | check 1m00s (ubuntu-latest); test 45s (ubuntu-latest); wasm 1m07s (ubuntu-latest) |
| plugin-sheets | vitest.yml | [39098219635](https://github.com/paged-media/plugin-sheets/actions/runs/39098219635) | 1m45s | 1.7 | 2s | vitest 1m43s (ubuntu-latest) |
| plugin-data | rust.yml | [39013601426](https://github.com/paged-media/plugin-data/actions/runs/39013601426) | 1m09s | 3.1 | 2s | check 59s (ubuntu-latest); test 58s (ubuntu-latest); wasm 1m07s (ubuntu-latest) |
| plugin-data | vitest.yml | [39013601420](https://github.com/paged-media/plugin-data/actions/runs/39013601420) | 2m07s | 2.1 | 1s | vitest 2m06s (ubuntu-latest) |
| plugin-doc | rust.yml | [39052833299](https://github.com/paged-media/plugin-doc/actions/runs/39052833299) | 7m35s | 12.2 | 2s | wasm 7m33s (ubuntu-latest); check 2m02s (ubuntu-latest); test 2m34s (ubuntu-latest) |
| plugin-doc | vitest.yml | [39052833304](https://github.com/paged-media/plugin-doc/actions/runs/39052833304) | 22s | 0.3 | 2s | vitest 20s (ubuntu-latest) |
| plugin-doc | publish.yml | — | — | — | — | no successful run on main |
| plugin-slide | bundle.yml | [39052837993](https://github.com/paged-media/plugin-slide/actions/runs/39052837993) | 4m32s | 4.5 | 2s | bundle 4m30s (ubuntu-latest) |
| plugin-slide | rust.yml | [39052837969](https://github.com/paged-media/plugin-slide/actions/runs/39052837969) | 2m49s | 4.8 | 2s | check 2m02s (ubuntu-latest); test 2m47s (ubuntu-latest) |
| plugin-web | rust.yml | [39012929516](https://github.com/paged-media/plugin-web/actions/runs/39012929516) | 51s | 1.3 | 2s | check 30s (ubuntu-latest); test 49s (ubuntu-latest) |
| plugin-web | vitest.yml | [39012929525](https://github.com/paged-media/plugin-web/actions/runs/39012929525) | 5m18s | 5.3 | 1s | vitest 5m17s (ubuntu-latest) |


### Per job (queue, run, and run time by step bucket)

| Repo / workflow | Job | Queue | Run | Setup | Cache | Build/test | Artifact/report | Dominant step |
|---|---|---|---|---|---|---|---|---|
| core / ci.yml | tag-on-bump nudge | 29m54s | 5s | 3s | 0s | 0s | 0s | Run actions/checkout@v4 (3s) |
| core / ci.yml | resolve pinned toolchain | 31m45s | 5s | 3s | 0s | 0s | 0s | Set up job (1s) |
| core / ci.yml | protocol-tag-guard | 41m01s | 5s | 4s | 0s | 0s | 0s | Run actions/checkout@v4 (3s) |
| core / ci.yml | idml-viewer vitest | 44m23s | 15s | 5s | 0s | 7s | 1s | vitest → JUnit (7s) |
| core / ci.yml | check + test (ubuntu-latest) | 27m25s | 29m29s | 1m36s | 17s | 27m32s | 0s | test (26m19s) |
| core / ci.yml | pdf export-diff gate | 27m30s | 14m52s | 25s | 10s | 14m13s | 0s | export-diff gate (hard; all fixtures minus known drift) (13m56s) |
| core / ci.yml | nextest evidence | 28m55s | 23m01s | 1m57s | 15s | 20m43s | 2s | nextest (workspace) → JUnit (20m28s) |
| core / ci.yml | wasm test lane (stub, pending W0.8) | 29m52s | 2m40s | 16s | 22s | 1m59s | 0s | make test-wasm (1m34s) |
| core / ci.yml | check + test (macos-latest) | 40m25s | 33m42s | 23s | 43s | 32m32s | 0s | test (28m45s) |
| core / ci.yml | wasm-size gate (Spike C) | 1s | 46s | 15s | 4s | 24s | 0s | measure (24s) |
| core / fidelity.yml | resolve pinned toolchain | 9m21s | 6s | 3s | 0s | 0s | 0s | Run actions/checkout@v4 (2s) |
| core / fidelity.yml | corpus diff (macos-latest) | 17m09s | 7m20s | 26s | 22s | 6m29s | 1s | generated-corpus fidelity gate (hard) (4m48s) |
| core / fidelity.yml | corpus diff (ubuntu-latest) | 5m20s | 13m59s | 28s | 23s | 13m02s | 3s | generated-corpus fidelity gate (hard) (10m13s) |
| core / gpu.yml | resolve pinned toolchain | 1m32s | 6s | 4s | 0s | 0s | 0s | Run actions/checkout@v4 (3s) |
| core / gpu.yml | vello on lavapipe | 7m22s | 16m35s | 25s | 25s | 15m39s | 3s | CPU ↔ Vello parity over the generated corpus (15m06s) |
| core / licenses.yml | cargo-deny | 1m44s | 46s | 4s | 0s | 41s | 0s | Run EmbarkStudios/cargo-deny-action@v2 (31s) |
| core / notify-docs.yml | ping | 5m44s | 3s | 0s | 0s | 0s | 0s | Set up job (0s) |
| core / publish-wasm.yml | publish | 3m31s | 17m32s | 1m51s | 0s | 15m23s | 15s | Build @paged-media/canvas-wasm (9m05s) |
| editor / tests.yml | checks (lint + boundaries + boot-coi + thresholds) | 2s | 54s | 31s | 0s | 20s | 1s | Run actions/checkout@v4 (23s) |
| editor / tests.yml | playwright (shard 1/3) | 1s | 53m28s | 53s | 13s | 52m19s | 1s | playwright (lean surface, shard 1) (36m06s) |
| editor / tests.yml | playwright (shard 3/3) | 2s | 53m55s | 1m03s | 12s | 52m36s | 2s | playwright (lean surface, shard 3) (36m17s) |
| editor / tests.yml | playwright (shard 2/3) | 2s | 49m50s | 51s | 17s | 48m40s | 1s | playwright (lean surface, shard 2) (33m11s) |
| editor / tests.yml | merge reports + publish evidence | 26s | 35s | 28s | 0s | 0s | 4s | checkout editor (22s) |
| editor / playground.yml | deploy | 7s | 16m11s | 43s | 8s | 14m49s | 29s | plugin-doc from source (stopgap until @paged-media/doc publishes) (7m13s) |
| plugin-sdk / vitest.yml | vitest | 4m02s | 31s | 8s | 0s | 20s | 1s | vitest → JUnit (14s) |
| plugin-sdk / contract-guard.yml | bump-on-contract-change | 14m02s | 10s | 6s | 0s | 0s | 0s | Run actions/setup-node@v4 (3s) |
| plugin-sdk / notify-docs.yml | ping | 20s | 3s | 0s | 0s | 0s | 0s | Set up job (0s) |
| plugin-sdk / publish.yml | verify-and-publish | 2s | 39s | 10s | 0s | 15s | 11s | publish changed versions via OIDC (canary) (11s) |
| plugin-publish / ci.yml | fmt + clippy + build | 40m50s | 1m19s | 13s | 21s | 42s | 0s | build (native) (28s) |
| plugin-publish / ci.yml | tests (evidence) | 42m36s | 1m24s | 18s | 18s | 45s | 2s | nextest → JUnit (40s) |
| plugin-publish / ci.yml | bundles typecheck + build + validate | 43m34s | 20s | 9s | 0s | 8s | 0s | Run pnpm -r --filter "./packages/*" build (4s) |
| plugin-publish / publish.yml | publish | 9s | 16s | 7s | 0s | 6s | 2s | Run pnpm -r --filter "./packages/*" typecheck (3s) |
| plugin-image / ci.yml | rust GPU tests (Metal) | 7s | 3m48s | 24s | 10s | 3m12s | 0s | test (REQUIRE_GPU=1) (3m12s) |
| plugin-image / ci.yml | rust engine | 2s | 1m47s | 13s | 7s | 1m26s | 0s | test (48s) |
| plugin-image / ci.yml | rust GPU tests (lavapipe) | 2s | 2m39s | 28s | 9s | 1m59s | 0s | test (REQUIRE_GPU=1) (1m59s) |
| plugin-image / ci.yml | ts bundle | 2s | 1m39s | 22s | 4s | 1m09s | 0s | build wasm (57s) |
| plugin-image / publish-state.yml | vitest evidence | 2s | 23s | 9s | 0s | 10s | 1s | vitest (junit per package; red results still publish) (10s) |
| plugin-image / publish-state.yml | nextest evidence | 2s | 1m09s | 12s | 7s | 49s | 0s | nextest (workspace) → JUnit (49s) |
| plugin-draw / rust.yml | rust | 2s | 30s | 22s | 2s | 4s | 0s | toolchain (rust-toolchain.toml pins the channel + target) (9s) |
| plugin-draw / vitest.yml | vitest | 2s | 1m45s | 7s | 0s | 1m34s | 1s | vitest (junit per package; red results still upload) (1m23s) |
| plugin-draw / publish.yml | publish | 2s | 2m11s | 11s | 0s | 1m57s | 1s | Run pnpm test (1m33s) |
| plugin-sheets / rust.yml | check | 2s | 1m00s | 12s | 3s | 42s | 0s | Run EmbarkStudios/cargo-deny-action@v2 (20s) |
| plugin-sheets / rust.yml | test | 2s | 45s | 13s | 4s | 25s | 1s | nextest (junit; red results still publish via !cancelled upload) (22s) |
| plugin-sheets / rust.yml | wasm | 2s | 1m07s | 14s | 3s | 47s | 0s | build + budget gate (100 MB app-wide) (47s) |
| plugin-sheets / vitest.yml | vitest | 2s | 1m43s | 21s | 4s | 1m12s | 2s | build the engine wasm artifact (100 MB app wasm budget gate) (48s) |
| plugin-data / rust.yml | check | 2s | 59s | 11s | 2s | 43s | 0s | Run EmbarkStudios/cargo-deny-action@v2 (22s) |
| plugin-data / rust.yml | test | 2s | 58s | 9s | 7s | 39s | 1s | nextest (junit) (34s) |
| plugin-data / rust.yml | wasm | 2s | 1m07s | 18s | 3s | 43s | 0s | build + budget gate (100 MB app-wide) (43s) |
| plugin-data / vitest.yml | vitest | 1s | 2m06s | 16s | 4s | 1m41s | 1s | vitest (junit per package) (59s) |
| plugin-doc / rust.yml | wasm | 2s | 7m33s | 16s | 13s | 7m01s | 0s | build + budget gate (100 MB app-wide) (7m01s) |
| plugin-doc / rust.yml | check | 2s | 2m02s | 11s | 4s | 1m46s | 0s | Run cargo clippy --workspace --all-targets -- -D warnings (1m16s) |
| plugin-doc / rust.yml | test | 2s | 2m34s | 12s | 14s | 2m05s | 1s | nextest (junit; red results still upload) (2m05s) |
| plugin-doc / vitest.yml | vitest | 2s | 20s | 7s | 0s | 9s | 1s | typecheck (4s) |
| plugin-slide / bundle.yml | bundle | 2s | 4m30s | 15s | 8s | 4m05s | 1s | build the engine wasm (100 MB app-wide budget gate) (3m53s) |
| plugin-slide / rust.yml | check | 2s | 2m02s | 12s | 6s | 1m42s | 0s | Run cargo clippy --workspace --all-targets -- -D warnings (1m10s) |
| plugin-slide / rust.yml | test | 2s | 2m47s | 13s | 16s | 2m14s | 1s | nextest (junit; red results still upload) (2m14s) |
| plugin-web / rust.yml | check | 2s | 30s | 11s | 10s | 6s | 0s | Run dtolnay/rust-toolchain@master (8s) |
| plugin-web / rust.yml | test | 2s | 49s | 12s | 15s | 18s | 1s | cargo nextest (blitz — lowering, capture, flow fragmentation) (11s) |
| plugin-web / vitest.yml | vitest | 1s | 5m17s | 22s | 11s | 4m41s | 0s | build the Blitz ENGINE wasm artifact (manifest maxBytes budget gate; stamps bin/SOURCE_HASH) (4m06s) |


### Top 5 by wall time

1. **core / ci.yml**, 106m44s wall. Up to 44m23s of that is queue (org
   runner contention). Dominant step: `test` in `check + test (macos-latest)`
   at 28m45s (`cargo test --workspace`), with the Linux `test` at 26m19s and
   `nextest evidence` at 20m28s close behind.
2. **editor / tests.yml**, 54m58s wall. Dominant step: the Playwright shards
   (`playwright (lean surface, shard 3)`, 36m17s). Each shard also spends
   about 15 min before the tests on the doc and slide wasm builds of the two
   composite actions (7m41s + 7m40s on shard 3). paged-gen was cached (28s).
3. **plugin-publish / ci.yml**, 44m00s wall, of which 43m34s is queue. The
   jobs themselves run 20s to 1m24s; the longest step is `nextest → JUnit`
   at 40s.
4. **core / fidelity.yml**, 33m56s wall, with 17m09s max queue. Dominant
   step: `generated-corpus fidelity gate (hard)` on ubuntu, 10m13s.
5. **core / gpu.yml**, 25m36s wall, with 7m22s max queue. Dominant step:
   `CPU ↔ Vello parity over the generated corpus`, 15m06s.

### Top 5 by summed job minutes

1. **editor / tests.yml**, 158.7 job-minutes. Three Playwright shards of
   50 to 54 min each. Dominant step: the Playwright run (33 to 36 min per
   shard).
2. **core / ci.yml**, 105.0 job-minutes. Dominant steps: `test` (macOS
   28m45s, Linux 26m19s), `nextest evidence` (20m28s) and the export-diff
   gate (13m56s).
3. **core / fidelity.yml**, 21.4 job-minutes. Dominant step: the
   generated-corpus fidelity gate (10m13s ubuntu, 4m48s macOS).
4. **core / publish-wasm.yml**, 17.5 job-minutes (tag run). Dominant step:
   `Build @paged-media/canvas-wasm` (9m05s, wasm-release with fat LTO).
5. **core / gpu.yml**, 16.7 job-minutes. Dominant step: the CPU ↔ Vello
   parity step (15m06s).

Setup and cache are small next to build/test everywhere. The largest setup
share is about 2 min, in core ci's `check + test (ubuntu)` and
`nextest evidence` (disk clean-up plus toolchain). Cache restore and save
never exceed 45s per job. The time goes to the Rust test suites, the
corpus/parity gates and the Playwright shards, and on core to queueing.

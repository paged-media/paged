# CI speed (step A10)

The monorepo's CI was measured before anything was changed, and each change
below lands with its before and after numbers. Inputs: the per-component
baseline of step A3 ([`ci-timing-baseline.json`](ci-timing-baseline.json)),
the test counts of step A5 ([`parity.md`](parity.md)) and the test inventory
of step T0 ([`test-inventory.md`](test-inventory.md)).

Raw data: [`ci-speed.json`](ci-speed.json), produced by
[`tooling/migration/ci_speed.py`](../../tooling/migration/ci_speed.py) from
read-only GitHub API data (runs, jobs, steps, job logs and the Actions cache
list). **old** is the A3 baseline: the last green run of every workflow in the
per-component repositories, 29 runs. **new** is every monorepo run in the 48
hours up to 2026-10-18 15:30 UTC: 942 runs, which is every run the monorepo
had (the first started at 08:35 that day). The org is on the free plan: at
most 20 jobs run at once, 5 of them on macOS, shared by every repository.

## Summary

| Lever | Before | After | How measured |
|---|---|---|---|
| 1. Run only what is affected | Root Cargo config (`.cargo/config.toml`, `tooling/rust/`) reached no Rust workflow; a dependency or toolchain update skipped the GPU lane; doc's Rust lane never ran on pull requests; a docs-only change ran its component's full CI (2–10 % of component commits) | All 13 Rust workflows watch the root Cargo config; core-gpu watches `Cargo.toml`/`Cargo.lock`/`rust-toolchain.toml`; doc/rust gates pull requests; `docs/**/*.md` under a component triggers nothing | Path filters read from the workflow files; docs-only share from 90 days of git history |
| 2. `concurrency` | 297 superseded runs, 111 of them ran to the end (1,543 job-minutes after a newer run existed); 114 duplicate runs; 143 runs on main cancelled | All 22 pull-request workflows cancel a superseded run; no push to main is cancelled or queued; deploys never cancel | Runs API over the window; the configuration; one demonstration push |
| 3. Rust caching | rust-cache hit rate 20 % (old: 97 %); 0 core caches on main, 12.4 GB of caches against the 10 GB limit, the oldest 30 min old | Pull requests restore main's caches and write none; sccache measured on one job before any switch | rust-cache log lines of 251 + 34 jobs; the Actions cache list; a trial job |
| 4. Job shape | Linux ran core's 3,797 tests twice (`cargo test`, then nextest), 39.8 job-minutes a run; every core job waited for a 10 s toolchain job, median 12m57s | Linux runs them once (nextest + doctests, same counts), about 21 job-minutes; no toolchain hop; wasm-size no longer waits for the macOS leg | Step times and `Finished` lines of 4 paired runs; the jobs API |
| 5. mold | Links core's Linux builds since A8b | No isolated CI number (linking is inside cargo's compile time) | — |
| 6. Docker cache | No workflow builds an image | Not applicable | Workflow files |
| 7. Runner disk | 104 GB free after the clean-up step (145 GB disk) | End-of-job margin recorded by a new step | `df` in the job logs |

The PR's own CI run is in [This pull request's CI run](#this-pull-requests-ci-run).

## The five measurements (before)

### 1. Queue time

Queue is run created to its first job started, and job created to job started.

| Side | Runs | Run queue median / p90 / max | Jobs | Job queue median / p90 / max | macOS job queue median / p90 |
|---|---|---|---|---|---|
| old | 29 | 3s / 9m21s / 40m50s | 59 | 2s / 31m45s / 44m23s | 17m09s / 40m25s |
| new | 942 | 7m38s / 37m07s / 1h27m | 1,289 | 15m40s / 55m23s / 1h53m | 17m47s / 1h00m |

At the peak (1-minute samples) 20 jobs ran and **255 jobs were queued**
(12:42 UTC); 5 macOS jobs ran, the macOS limit. Queue time is now the largest
part of every run's wall time. The old numbers were also queue-bound in places
(core ci 44 min), because the per-component repositories shared the same
limit.

### 2. Cache restore time

From the `Swatinem/rust-cache` steps and their log lines (`Restored from cache
key … full match`, `No cache found.`):

| Side | Jobs with a log | exact / partial / miss | Hit rate | Restore s (sum) | Save s (sum) | Job s (sum) |
|---|---|---|---|---|---|---|
| old | 34 | 20 / 13 / 1 | 97 % | 253 | 133 | 11,668 |
| new | 251 | 31 / 19 / 201 | 20 % | 962 | 1,442 | 99,107 |

A hit is cheap: restoring core's 700–920 MB caches takes 15–24 s, under 2 % of
the job. A miss is what costs. Median job run time on a hit vs on a miss, green
monorepo jobs (one hit sample per job, so read these as an order of magnitude):

| Job | Hit | Miss | Cache MB |
|---|---|---|---|
| core-ci / pdf export-diff gate | 9m05s | 16m50s | 397 |
| core-ci / wasm test lane | 2m42s | 10m24s | 596 |
| core-fidelity / corpus diff (ubuntu) | 11m06s | 19m14s | 559 |
| core-gpu / vello on lavapipe | 16m34s | 21m22s | 669 |
| slide-rust / test | 1m03s | 7m52s | 258 |
| web-rust / test | 41s | 4m15s | 347 |
| data-rust / test | 53s | 4m04s | 302 |

Why the hit rate fell: the Actions cache holds 10 GB per repository, and a
cache written by a pull request can only be read by that pull request (and a
cache on `main` by everyone). At 15:48 UTC the repository held 67 entries,
12.36 GB; the oldest was 30 minutes old, so entries were evicted within half
an hour. **No core cache existed on `main`**: every core cache was scoped to
one pull request (2.96 GB in 7 entries at 15:48; 9.5 GB in 16 entries a
quarter of an hour earlier), because the main runs of core-ci had all been cancelled before they
could save. A new pull request, or the next push to one, found nothing.

| Family | Ref | Entries | MB |
|---|---|---|---|
| core rust-cache | pull request | 7 | 2,957 |
| other rust-cache | main | 29 | 5,843 |
| other rust-cache | pull request | 19 | 3,198 |
| other (bun, proto, node) | main | 4 | 416 |
| other (bun, proto, node) | pull request | 10 | 647 |

### 3. Docker time

No workflow builds a Docker image. `apps/server/server/engine/Dockerfile`
exists, but nothing in CI builds it, so there is no Docker time to measure.

### 4. Compute time per job

Green jobs, minutes per step bucket (the A3 buckets: set-up = job set-up,
checkout, toolchains and installs; cache = rust-cache and actions/cache;
build/test = everything that builds or tests; report = uploads and
summaries):

| Side | Jobs | Run | Set-up | Cache | Build/test | Report |
|---|---|---|---|---|---|---|
| old | 59 | 395.0 | 20.7 (5 %) | 7.3 (2 %) | 363.1 (92 %) | 1.5 |
| new | 1,001 | 5,406.4 | 643.7 (12 %) | 123.0 (2 %) | 4,587.3 (85 %) | 8.3 |

The jobs are compute-bound: build and test are 85 % of job time. Set-up doubled
its share (proto, Bun and the root install in every JS job, the disk clean-up
in the big Rust jobs). Within core's Rust jobs, cargo's `Finished` line splits
compile from test execution:

| Run | Job | Cache | Job | clippy | test compile | test execution | Tests run / skipped |
|---|---|---|---|---|---|---|---|
| old 39103264262 | check + test (ubuntu) | exact | 29m29s | 55s | 6m13s | 20m06s | 2,990 / 8 |
| old 39103264262 | nextest evidence | exact | 23m01s | — | 6m04s | 14m24s | 2,989 / 7 |
| old 39103264262 | check + test (macOS) | miss | 33m42s | 3m07s | 10m48s | 17m57s | 2,990 / 8 |
| new 39136471521 | check + test (ubuntu) | miss | 23m47s | 4m26s | 7m57s | 8m56s | 3,797 / 19 |
| new 39136471521 | nextest evidence | miss | 14m53s | — | 7m42s | 4m17s | 3,796 / 18 |
| new 39136471521 | check + test (macOS) | miss | 25m53s | 5m43s | 9m38s | 8m45s | 3,797 / 19 |

Test execution fell from 14–20 min to 4–9 min with A8b's optimised
dependencies, even though the workspace now has 800 more tests. A cold compile
of the test binaries takes 8–10 min, a warm one 6 min. In the old run test
execution was 76 % of the Linux test step; now it is 53 %.

Jobs under 60 s: 286 of 1,001 green jobs (29 %) but 118.9 of 5,406 minutes
(2.2 %), with 46 % of their time in set-up. Merging them would save little
runner time; the exception is a small job that other jobs wait for (lever 4).

### 5. Wall time and minutes per green run

Medians over green runs (old: the one A3 run):

| Workflow | Old wall | Old job minutes | New green runs | New wall | New queue | New job minutes (median / max) |
|---|---|---|---|---|---|---|
| core ci | 1h46m | 105.0 | 15 | 2h06m | 4m57s | 103.9 / 124.2 |
| core fidelity | 33m56s | 21.4 | 22 | 1h00m | 6m16s | 33.0 / 44.1 |
| core gpu | 25m36s | 16.7 | 19 | 58m51s | 5m24s | 21.1 / 23.8 |
| publish ci | 44m00s | 3.0 | 30 | 22m52s | 5m40s | 4.0 / 6.2 |
| image ci | 3m55s | 9.9 | 22 | 27m01s | 3m02s | 10.8 / 16.5 |
| sheet rust | 1m09s | 2.9 | 19 | 28m36s | 11m07s | 6.1 / 6.8 |
| data rust | 1m09s | 3.1 | 18 | 34m34s | 9m52s | 7.7 / 10.3 |
| moon ci | — | — | 25 | 39m40s | 26m19s | 7.2 / 66.5 |

Editor Playwright has no green monorepo run yet (it stops at the corpus
checkout until its secret is set). Over the whole window the monorepo spent
**6,695 job-minutes**, 606 of them in runs that were cancelled. Wall time
roughly doubled for core and grew 7–30× for the small modules, while their
job minutes grew 1–2.5× (cache misses): the difference is queueing.

## Lever 1: run only what is affected

The path filters were checked against the monorepo layout: which Cargo
workspaces path-depend on which (apps/server and modules/publish on
engine/core crates; nothing else crosses a workspace), which files every Cargo
build reads, and which non-code files tests read (`git grep` for `.md` reads:
none under any `docs/` directory; `modules/sheet` reads its root
`DECIMAL-SPIKE.md`, and core's `idml-coverage` reads JSON under
`engine/core/docs/reference/`, so only `docs/**/*.md` is excluded).

| Gap | Before | After | How measured |
|---|---|---|---|
| Root Cargo config (`.cargo/config.toml`: profiles, linker, rustc wrapper; `tooling/rust/`: the scripts it names) | in no workflow's filter: a change to them (A8b made two) ran no Rust lane | in the filters of all 13 Rust workflows (core ci, fidelity, gpu; data, doc, draw, sheet, slide, web rust; server; image ci and publish-state; publish ci) | workflow files |
| core-gpu pull-request filter | 4 crate directories and the generated corpus: a `wgpu`/`vello` update in `Cargo.lock`, or a toolchain update, did not run the GPU lane | also `engine/core/Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml` | workflow file |
| doc rust | push to main only (ported as it was): a pull request that broke `modules/doc` went red after merging | also on pull requests touching `modules/doc` | workflow file |
| Docs-only changes | `engine/core/docs/x.md` ran core ci (~104 job-minutes) and core licenses on the pull request, plus fidelity and gpu on main; a module's docs ran its Rust and vitest lanes. 2–10 % of each component's commits in the last 90 days touched only its `docs/**/*.md` (core 14 of 816, data 14 of 190, web 14 of 136, image 8 of 207, sheet 7 of 197, editor 10 of 588, extensions 5 of 150) | `!<component>/docs/**/*.md` in every component workflow's push and pull-request filters: those commits run nothing heavy | workflow files; `git log --name-only` over 2026-07-18 – 2026-10-18 |

Left as they are, with reasons:

- **JS consumers of the engine.** On `main` the JS workspaces still consume
  the engine as npm packages; the change to workspace packages, and the engine
  paths in the vitest and editor filters, are B3a's (#14). Its filters should
  also exclude `modules/*/docs/**/*.md` and include `tooling/rust/**`, since
  its editor filter takes all of `modules/**`.
- **doc vitest** stays push-only: B3a rewrites what it builds against.
- **core-fidelity pull-request filter**: U1 (#15) adds `Cargo.toml`,
  `Cargo.lock` and `rust-toolchain.toml`.
- **`moon ci`** runs on every pull request without a path filter, which is
  right: it computes the affected projects itself, from the task inputs in
  `.moon/` (which already exclude `docs/**` and `**/*.md` and include
  `/.cargo/*.toml`). It is advisory and runs every affected task from scratch
  with no Rust cache, so a core pull request runs core's tests a further time:
  46 runs, 497 job-minutes in the window, up to 66.5 job-minutes per run. Two
  gaps: its inputs miss `tooling/rust/**`, and `!**/*.md` also hides
  `modules/sheet/DECIMAL-SPIKE.md`, which a sheet test reads. Making `moon ci`
  the required check, and dropping the per-component workflows it covers, is
  where this lever goes next; until then its duplicate core run is the largest
  avoidable cost left in this lever.

## Lever 2: `concurrency`

Every pull-request workflow now has, directly after its `name:`:

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.run_id }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
```

The group falls back to `github.run_id`, not `github.ref`. GitHub keeps one
running and one pending run per group and cancels any older pending run when a
newer one arrives. With `github.ref`, pushes to `main` would share one group:
they would run one at a time, and in a burst of merges the middle ones would be
cancelled while pending. With the run id every push to `main` (and every
dispatch) has a group of its own and is never cancelled or held back. Pull
requests share a group per pull request, so a newer push cancels the older run,
queued or running.

| Workflow kind | Before | After |
|---|---|---|
| Pull-request workflows (22: core ci, fidelity, gpu, licenses; data, doc, draw, sheet, slide, web lanes; editor tests; extensions vitest and contract guard; image ci; moon; publish ci; server rust) | 16 had `group: <name>-${{ github.ref }}` with `cancel-in-progress: true`, which also cancels pushes to `main`; 6 (the core four, publish ci, contract guard) had none, so superseded runs ran to the end | the block above |
| Push-only lanes with that ref group (doc vitest, image publish-state) | cancelled each other on `main` | the block above (no pull-request trigger, so it never cancels) |
| Deploy (editor playground: push to main, dispatch, `repository_dispatch`) | `cancel-in-progress: true`: a newer deploy cancelled one in progress | one group, `cancel-in-progress: false`: deploys run one at a time and are never cancelled; a newer deploy arriving meanwhile waits, and replaces any older one still waiting (that one would only deploy an older state) |
| Release and publish (core publish-wasm: tags; the module and extension publishers: dispatch only) | no group | unchanged: never cancelled |
| Schedule and dispatch only (core perf-nightly, sheet fuzz, editor showcase-nightly) | showcase-nightly: one group, cancels | unchanged: not pull-request workflows |
| CLA (`pull_request_target`, `issue_comment`) | none | unchanged: it records signatures and must not be cancelled |
| editor protocol-version | none | unchanged here: B3a (#14) deletes the workflow |

No workflow uses `workflow_run`.

**Before**, from the runs API over the window (942 runs):

| Measure | Value |
|---|---|
| Superseded runs (a newer run of the same workflow on the same branch was created before it finished) | 297 |
| … of them ran to the end anyway | 111, with 1,543 job-minutes run after the newer run existed; 1,186 of them in the workflows without a group |
| … of them cancelled | 186 |
| Duplicate runs (same workflow, event and commit; two `pull_request` runs for one force-push of a stacked branch, and re-runs when a base branch was retargeted) | 114, 798 job-minutes |
| Runs on `main` cancelled | 143: 108 in the 19 workflows whose group cancels them by design (18 `github.ref` groups and the playground's), 35 in the others (cancelled by hand) |

Of the 1,186 job-minutes in workflows without a group, core ci ran 755,
fidelity 237, gpu 142, publish ci 43, licenses 7, contract guard 1 and CLA 1.
The other 357 are mostly the pairs of `pull_request` runs GitHub created in
the same second for one force-push of a stacked branch: neither run cancelled
the other although both workflows had a ref group, so the after-state of those
pairs is not predicted here.

**After**: from the configuration, a superseded run of any pull-request
workflow is cancelled when the newer run for the same pull request is
created. Over the window that would have cancelled the 1,186 job-minutes the
groupless workflows ran (18 % of the window's 6,695), and none of the 143
`main` runs would have been cancelled. The demonstration push is in [This pull request's CI
run](#this-pull-requests-ci-run).

## Lever 3: Rust caching

**What the numbers say.** Restore time is not the problem: a hit costs 1–24 s
(median 1–4 s per job, 962 s over 251 jobs, 1 % of their run time), and saves
1–8 min of compiling. The hit rate is: 20 %, down from 97 %, because
pull-request caches evict each other within half an hour and `main` held no
core cache (measurement 2). Switching the backend does not change that: sccache's
GitHub backend writes to the same 10 GB, with the same pull-request scoping.

**Change.** Every rust-cache step in a pull-request workflow (31 steps in 16
workflows; image ci's wasm build is left to B3b, which replaces that step with
the cached `module-wasm` action) gets
`save-if: ${{ github.ref == 'refs/heads/main' }}`. Only `main`
writes caches; a pull request restores `main`'s (a partial match when its
`Cargo.lock` differs) and writes nothing, so pull requests no longer evict
`main`'s caches or each other's. The publish, nightly and `main`-only
workflows already run on `main`.

| Measure | Before | After | How measured |
|---|---|---|---|
| Cache entries written by pull requests | 36 of 67 entries, 6.8 GB (15:48 UTC) | none | Actions cache list |
| Core caches on `main` | 0 | one per core job, written by the first green `main` run | Actions cache list |
| rust-cache hit rate on pull requests | 20 % (201 misses of 251) | expected near 100 % once `main` has a cache; this PR's run shows the first sample | job logs |
| Footprint of `main`'s caches | 5.8 GB of module caches, no core | about 11 GB when every Rust job has one (core ≈ 4.7 GB over 8 jobs, after lever 4 drops one): still above 10 GB, so the least recently used entries (the rarely run lanes) will be evicted | sizes from the cache list |

**sccache, measured on one job.** `.github/workflows/ci-sccache-trial.yml`
builds core's test binaries (the build of core-ci's Linux `check + test` job)
twice through sccache with the GitHub backend: cold, in a namespace of its own,
then warm after deleting `target/`. It runs only when its own file changes or
on dispatch. The comparison is with rust-cache's numbers for the same build: a
miss compiles in 7m42s–10m23s, a hit in about 6 min (old runs: 6m04s–6m13s).
sccache cannot cache what links (test harnesses, build scripts, proc macros),
which is most of a test build. The result is in [This pull request's CI
run](#this-pull-requests-ci-run); nothing switches to sccache unless the warm
build beats rust-cache's hit.

## Lever 4: job shape

**Core's tests run once on Linux.** Before, Linux ran core's tests twice per
push: `cargo test --workspace` in `check + test (ubuntu-latest)` and again
under nextest in `nextest evidence`, for the JUnit file. Now `check + test
(ubuntu-latest)` runs nextest (the gate, and the `nextest-junit` artifact as
before) and `cargo test --workspace --doc` (the doctests nextest does not run),
and the `nextest evidence` job is gone. macOS keeps `cargo test`.

The tests that run are the same, now once on Linux:

| Suite | Before | After |
|---|---|---|
| Linux `cargo test --workspace` (check + test, ubuntu) | 3,797 run / 19 skipped (includes 1 doctest run, 1 ignored) | — |
| Linux nextest (nextest evidence) | 3,796 run / 18 skipped | 3,796 run / 18 skipped (check + test, ubuntu) |
| Linux doctests | inside `cargo test` | 1 run / 1 ignored (check + test, ubuntu) |
| macOS `cargo test --workspace` | 3,797 / 19 | 3,797 / 19 |
| JUnit `nextest-junit` | from nextest evidence | from check + test (ubuntu), same tests |

Counts from the logs of run 39128323274 (nextest's 3,796 + 18 plus the
doctests' 1 + 1 equal `cargo test`'s 3,797 + 19).

| Measure | Before | After | How measured |
|---|---|---|---|
| Linux core test job-minutes per core-ci run | 39.8 (check + test plus nextest evidence, median over 4 runs with both) | about 21.0 (the check job with nextest's test step in place of `cargo test`'s, plus 10 s of doctests) | step times of runs 39114572956, 39130787379, 39135306863, 39136471521 |
| Linux core jobs and rust-cache entries | 2 jobs, 2 entries (810 + 718 MB) | 1 job, 1 entry | jobs API, cache list |
| Linux job vs the macOS leg | — | about 21 min against macOS's 24–30 min: the critical path does not move | step times |

**Does macOS add coverage?** Measured: the two legs run the same tests (3,797 /
19 on both, run 39128323274, and in every run of A5's baseline); core has one
platform-conditional code path (`paged-color`'s installed-profile
directories); and in 47 runs where both legs reached the test step (28 old,
19 new) macOS never failed alone. What macOS checks is the platform itself:
the native arm64 build with its own linker (`tooling/rust/cc-lld`, A8c) and
the Apple-side paths. It stays, once; running it only on `main` would free a
macOS slot (5 for the whole org) and is left as an option.

**No toolchain hop.** core-ci, fidelity and gpu each started with a 10 s job
that read `rust-toolchain.toml`, and every other job `needs:` it. A dependent
job is only created when its dependency finishes, so it joins the back of the
queue a second time:

| Workflow | Runs | Hop (run created → dependent jobs created) median / p90 | Hop minutes (sum) |
|---|---|---|---|
| core ci | 47 | 12m57s / 53m13s | 1,092 |
| core fidelity | 25 | 5m53s / 36m59s | 353 |
| core gpu | 26 | 4m07s / 11m26s | 192 |

Each job now reads the pin itself (`bash scripts/rust-channel.sh`, as the
toolchain job did), so its jobs are queued when the run starts. core-ci's
toolchain job stays for now, needed by nothing and running beside the others,
because U1 (#15) edits its comment; it can be deleted once U1 has merged.
`wasm-size` also no longer `needs: check`: it waited for both check legs
(macOS ~25 min) and then queued again, for a 2 min job.

**Tiny jobs** (under 60 s) were not merged: 2.2 % of runner time (measurement
4); merging the core guards would save under 1 min a run and touch jobs other
open pull requests edit.

## Levers 5–7

**5. mold.** Core's Linux builds link with mold since A8b (`tooling/rust/cc-mold`;
the `mold linked the test binaries` step fails if they don't). Linking is not
separable in cargo's output, so CI has no before/after number for it; the
compile times in measurement 4 include it. The lld-vs-mold link-only
microbenchmark stays open. What CI does show is A8b's other change: test
execution 20m06s → 8m56s (`cargo test`) and 14m24s → 4m17s (nextest), from
dependencies at `opt-level = 2`.

**6. Docker BuildKit cache.** Not applicable: no workflow builds the server
image.

**7. Runner disk.** `ubuntu-latest` has a 145 GB root disk; after the clean-up
step core's Linux jobs have 104 GB free (29 % used), with
`CARGO_PROFILE_DEV_DEBUG=line-tables-only`. The Linux `check + test` job now
builds clippy's and the tests' artifacts in one target directory (as
`check + test` did before), and a new last step records `df -h /` and the
target size, so the margin at the end of the largest job is measured on every
run.

## Runners (user decision)

Larger GitHub runners and third-party runners are billed, so they are not
changed here. The compute-bound jobs that would gain from more cores:

| Job | Run time | What bounds it |
|---|---|---|
| core ci / check + test (ubuntu, macOS) | 21 min / 24–30 min | compiling (8–10 min cold) and test execution, both parallel; one 280 s test is nextest's floor |
| core ci / pdf export-diff gate | 15–18 min | release builds and the page diff loop |
| core fidelity / corpus diff | 11–19 min | the corpus render and diff |
| core gpu / vello on lavapipe | 16–21 min | software Vulkan (CPU rendering) |
| editor tests / Playwright (3 shards) | ~50 min a shard | browser tests, plus the doc and slide wasm builds that B3a moves to a cached action |

Today queueing costs more than compute: the median job waits 15m40s for one of
the 20 slots. On the free plan the levers above (fewer superseded runs, fewer
jobs, cache hits) are what shortens the queue; a paid plan raises the
concurrent-job limit as well, which is the other way to shorten it.

## This pull request's CI run

Pending: filled from the PR's own run (wall time, job minutes, rust-cache
results, the sccache trial, the end-of-job disk margin, and the
demonstration push).

## Reproduce

```sh
# Read-only gh api; the cache can be seeded with test_inventory.py's.
python3 tooling/migration/ci_speed.py fetch --cache DIR
# No network once the cache is filled. --config-rev: the commit whose workflow
# files tell which concurrency groups cancelled main pushes (the "before").
python3 tooling/migration/ci_speed.py report --cache DIR \
    --out docs/migration/ci-speed.json --until 2026-10-18T15:30:00Z --hours 48 \
    --config-rev 5098db5f4 --markdown TABLES.md
```

The cache list (measurement 2) is live state: `fetch` takes one snapshot.

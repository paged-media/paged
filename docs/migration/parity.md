# CI test parity: per-component repositories vs the monorepo

Later steps (crate moves, the relicense, the Bun and test-runner migrations)
have to show that the same tests still run with the same results. This file
is the baseline for that. For every CI test suite it compares the test counts
of the monorepo's CI with the last green run of the same suite in the old
per-component repository. It also records per-suite job time and skip counts,
which are the inputs for wave T's T0.

Raw data: [`parity-baseline.json`](parity-baseline.json). It holds every job,
the counts each log and artifact gives, job and step times, and the JUnit test
ids that were added or removed. It was produced by
[`tooling/migration/parity_counts.py`](../../tooling/migration/parity_counts.py)
from read-only GitHub API data (job logs and test artifacts) on 2026-10-18.

## Summary

- **32 test-bearing jobs.** 25 were measured on both sides. **22 match
  exactly** (every counter equal). **3 differ**: core `check + test` (ubuntu,
  macOS) and core `nextest evidence`. All three differ by the same one test,
  which was added in core between the old green run and the imported commit
  ([D1](#d1-core-one-test-added-before-the-import)). The other **7 are not
  measured yet** ([below](#not-measured-on-the-new-side)): editor Playwright
  (pending: secret `STATE_DISPATCH_TOKEN`), core `gpu`, image Metal, image
  `publish-state` (2 jobs), doc `rust` and doc `vitest`. All of them except
  the Playwright suite are push-only or path-filtered, so PR #3 did not run
  them.
- **58 counters** (log counters, JUnit/report artifacts and engine gates):
  42 identical, 4 differ (all D1), 12 not measured.
- **Test ids.** 13 JUnit artifact sets exist on both sides. Their test ids
  and per-test results are identical, except one: core nextest has one id
  more (D1) and none removed. No test changed status. No measured run reports a
  flaky test (nextest and Playwright count flakes; every count is 0). Skip
  counts are equal everywhere both sides ran.
- **No unexplained difference remains among the measured suites.** Still
  open:
  1. the 7 unmeasured suites;
  2. core's `cargo test` count at exactly `19c16fd` was never measured in the
     old repository, because that run failed clippy before testing. The +1 is
     shown by the nextest reference run at `19c16fd` and by the new test
     binary in the monorepo log.

| Component | Test jobs | Match | Differ (explained) | Not measured |
|---|---|---|---|---|
| core | 10 | 6 | 3 (D1) | 1 (`gpu`) |
| editor | 2 | 1 | 0 | 1 (Playwright, pending secret) |
| extensions | 1 | 1 | 0 | 0 |
| publish | 1 | 1 | 0 | 0 |
| image | 6 | 3 | 0 | 3 (Metal, `publish-state` ×2) |
| draw | 2 | 2 | 0 | 0 |
| sheet | 2 | 2 | 0 | 0 |
| data | 2 | 2 | 0 | 0 |
| doc | 2 | 0 | 0 | 2 (push-only) |
| slide | 2 | 2 | 0 | 0 |
| web | 2 | 2 | 0 | 0 |
| **total** | **32** | **22** | **3** | **7** |

## What was compared

**Old side.** The last successful `main` run of every workflow in
paged-media/{core, editor, plugin-sdk, plugin-publish, plugin-image,
plugin-draw, plugin-sheets, plugin-data, plugin-doc, plugin-slide,
plugin-web}, as listed in the CI port's timing baseline
([`ci-timing-baseline.json`](ci-timing-baseline.json)), with two exceptions:

- **core `ci.yml`.** Its run at the imported commit `19c16fd`
  ([39105589722](https://github.com/paged-media/core/actions/runs/39105589722))
  is red. Clippy failed in `check + test` (both legs) and in the wasm lane,
  so those jobs ran no tests. That lint is fixed in the monorepo (`b9ab20e`).
  The old side is therefore core's last green `ci.yml` run, at `b612da5`
  ([39104676793](https://github.com/paged-media/core/actions/runs/39104676793)).
  `b612da5` is the first parent of `19c16fd`. The red run's `nextest evidence` job did pass,
  and it is used as a reference for what `19c16fd` itself runs. The timing
  baseline lists `afee434` for this workflow because `b612da5`'s run was
  still in progress when that baseline was collected.
- **editor `tests.yml`.** A green run at the imported commit `5497f52`
  ([39111494763](https://github.com/paged-media/editor/actions/runs/39111494763))
  finished after the timing baseline was collected. It replaces the
  baseline's `689f044` run. (That older run had the same Playwright totals:
  1268 tests, 1234 passed, 34 skipped.)

Every other old run, including core's `fidelity.yml`, `gpu.yml` and
`licenses.yml`, is at exactly the imported source SHA
(`tooling/import/import-lock.json`).

**New side.** The paged-media/paged runs on pull request #3, head `b9ab20e`.
`pull_request` runs check out the merge ref (`6120ed5`). Its base,
`a3/ci-port`, is an ancestor of the head, so the merge ref has the same tree
as `b9ab20e` (`fb25619`). Between the import and `b9ab20e`, the monorepo
commits that touch a component are path rewiring (A3/A4), one version bump
and one clippy fix. None of them adds, removes or ignores a test:

| Component | Commits after the import that touch it | Touch tests? |
|---|---|---|
| engine/core | `3cc7e65`, `8bd6d0d` (CI files), `7710d6b` (corpus path in `grid_matrix_corpus.rs`, a comment in `package_folder.rs`, paged-gen sample path), `b9ab20e` (clippy `type_complexity` in `paged-export-pdf`) | paths only |
| apps/editor | `8f32629`, `8bd6d0d`, `78e4140`, `43e425c`, `50838be` | paths only |
| platform/extensions | `052be4a`, `8bd6d0d`, `45145f2`, `66f8151` (0.2.64-canary.0) | no |
| modules/* | the CI move and one path-rewiring commit each, plus the CLA-workflow removal (`8bd6d0d`) in all but publish and slide (`9742b22`, `e199768`, `9eb0063`, `4631911`, `2423389`, `770ad9f`, `51b33da`, `aec1509`) | paths only (corpus / plugin-cli / editor locations) |

**Counting.** One suite is one test counter inside one job. Matrix legs are
separate suites. The three Playwright shards are summed into one suite. The
counters, all parsed from the job log:

- `cargo test`: the sum of every `test result:` line. *run* is passed +
  failed; *skip* is `ignored`. Doc-tests are included.
- `nextest`: the `Summary` line. *skip* is nextest's `skipped` (ignored and
  filtered tests).
- `vitest`: the sum of the `Tests` lines over all invocations in the job.
  *skip* is skipped + todo.
- `node:test`: the `# tests/pass/fail/skipped` blocks.
- Playwright: `Running N tests` plus the final `passed/skipped/flaky/failed`
  lines.
- Engine gates: export-diff pages, fidelity fixtures, Vello parity fixtures,
  wasm size.
- Editor `checks` guards: the result line of each `pnpm test:*` guard step
  (8 steps). They match when every line is identical, numbers included
  (for example "76 members, 52 wire kinds, protocol 73").

Where a workflow uploads JUnit or a report, the artifact is counted too
(`JUnit <artifact>` rows). The artifact also gives the test ids for the
added/removed lists in the JSON. Some jobs print no vitest summary
(`--reporter=junit` only). For those, the JUnit row is the only count: draw
`vitest`, doc `vitest`, image `vitest evidence`. JUnit rows have no
*skipped* for nextest, because nextest does not write skipped tests to
JUnit. A difference between a log row and its JUnit row (for example
extensions 743 vs 712) means the JUnit covers only some of the job's
invocations. It is the same on both sides.

## Results per suite

Counts are run / passed / failed / skipped (definitions above). Runners are the
same labels on both sides. New runs are all at `b9ab20e` (merge ref `6120ed5`).

### core

| Suite (workflow / job / runner / counter) | Old run | Old run/pass/fail/skip | New run | New run/pass/fail/skip | Δ |
|---|---|---|---|---|---|
| `core-ci.yml` / idml-viewer vitest / ubuntu-latest / vitest | [39104676793](https://github.com/paged-media/core/actions/runs/39104676793) `b612da5` | 27 / 27 / 0 / 0 | [39114572956](https://github.com/paged-media/paged/actions/runs/39114572956) `b9ab20e` | 27 / 27 / 0 / 0 | 0 |
| `core-ci.yml` / idml-viewer vitest / ubuntu-latest / JUnit idml-viewer-vitest-junit | [39104676793](https://github.com/paged-media/core/actions/runs/39104676793) `b612da5` | 27 / 27 / 0 / 0 | [39114572956](https://github.com/paged-media/paged/actions/runs/39114572956) `b9ab20e` | 27 / 27 / 0 / 0 | 0 |
| `core-ci.yml` / check + test (ubuntu-latest) / ubuntu-latest / cargo test | [39104676793](https://github.com/paged-media/core/actions/runs/39104676793) `b612da5` | 3031 / 3031 / 0 / 8 | [39114572956](https://github.com/paged-media/paged/actions/runs/39114572956) `b9ab20e` | 3032 / 3032 / 0 / 8 | run +1, passed +1, result lines +1: the +1 test added before the import, see D1 |
| `core-ci.yml` / wasm test lane (stub, pending W0.8) / ubuntu-latest / cargo test | [39104676793](https://github.com/paged-media/core/actions/runs/39104676793) `b612da5` | 6 / 6 / 0 / 0 | [39114572956](https://github.com/paged-media/paged/actions/runs/39114572956) `b9ab20e` | 6 / 6 / 0 / 0 | 0 |
| `core-ci.yml` / pdf export-diff gate / ubuntu-latest / export-diff gate | [39104676793](https://github.com/paged-media/core/actions/runs/39104676793) `b612da5` | hard: 101 fixtures, pages 653 ok; advisory: 1 fixture, pages 1 ok | [39114572956](https://github.com/paged-media/paged/actions/runs/39114572956) `b9ab20e` | hard: 101 fixtures, pages 653 ok; advisory: 1 fixture, pages 1 ok | 0 |
| `core-ci.yml` / check + test (macos-latest) / macos-latest / cargo test | [39104676793](https://github.com/paged-media/core/actions/runs/39104676793) `b612da5` | 3031 / 3031 / 0 / 8 | [39114572956](https://github.com/paged-media/paged/actions/runs/39114572956) `b9ab20e` | 3032 / 3032 / 0 / 8 | run +1, passed +1, result lines +1: the +1 test added before the import, see D1 |
| `core-ci.yml` / nextest evidence / ubuntu-latest / nextest | [39104676793](https://github.com/paged-media/core/actions/runs/39104676793) `b612da5` | 3030 / 3030 / 0 / 7 | [39114572956](https://github.com/paged-media/paged/actions/runs/39114572956) `b9ab20e` | 3031 / 3031 / 0 / 7 | run +1, passed +1, binaries +1: the +1 test added before the import, see D1 |
| `core-ci.yml` / nextest evidence / ubuntu-latest / JUnit nextest-junit | [39104676793](https://github.com/paged-media/core/actions/runs/39104676793) `b612da5` | 3030 / 3030 / 0 / 0 | [39114572956](https://github.com/paged-media/paged/actions/runs/39114572956) `b9ab20e` | 3031 / 3031 / 0 / 0 | run +1, passed +1, total +1: the +1 test added before the import, see D1 |
| `core-ci.yml` / wasm-size gate (Spike C) / ubuntu-latest / wasm-size gate | [39104676793](https://github.com/paged-media/core/actions/runs/39104676793) `b612da5` | 137876 bytes (brotli) | [39114572956](https://github.com/paged-media/paged/actions/runs/39114572956) `b9ab20e` | 137876 bytes (brotli) | 0 |
| `core-fidelity.yml` / corpus diff (macos-latest) / macos-latest / cargo test | [39105589731](https://github.com/paged-media/core/actions/runs/39105589731) `19c16fd` | 1 / 1 / 0 / 0 | [39114573095](https://github.com/paged-media/paged/actions/runs/39114573095) `b9ab20e` | 1 / 1 / 0 / 0 | 0 |
| `core-fidelity.yml` / corpus diff (macos-latest) / macos-latest / fidelity gate (log) | [39105589731](https://github.com/paged-media/core/actions/runs/39105589731) `19c16fd` | 101 fixtures: 16 PASS, 85 FAIL lines | [39114573095](https://github.com/paged-media/paged/actions/runs/39114573095) `b9ab20e` | 101 fixtures: 16 PASS, 85 FAIL lines | 0 |
| `core-fidelity.yml` / corpus diff (macos-latest) / macos-latest / fidelity results | [39105589731](https://github.com/paged-media/core/actions/runs/39105589731) `19c16fd` | 101 fixtures: 101 skipped | [39114573095](https://github.com/paged-media/paged/actions/runs/39114573095) `b9ab20e` | 101 fixtures: 101 skipped | 0 |
| `core-fidelity.yml` / corpus diff (ubuntu-latest) / ubuntu-latest / cargo test | [39105589731](https://github.com/paged-media/core/actions/runs/39105589731) `19c16fd` | 1 / 1 / 0 / 0 | [39114573095](https://github.com/paged-media/paged/actions/runs/39114573095) `b9ab20e` | 1 / 1 / 0 / 0 | 0 |
| `core-fidelity.yml` / corpus diff (ubuntu-latest) / ubuntu-latest / fidelity gate (log) | [39105589731](https://github.com/paged-media/core/actions/runs/39105589731) `19c16fd` | 101 fixtures: 16 PASS, 85 FAIL lines | [39114573095](https://github.com/paged-media/paged/actions/runs/39114573095) `b9ab20e` | 101 fixtures: 16 PASS, 85 FAIL lines | 0 |
| `core-fidelity.yml` / corpus diff (ubuntu-latest) / ubuntu-latest / fidelity results | [39105589731](https://github.com/paged-media/core/actions/runs/39105589731) `19c16fd` | 101 fixtures: 101 skipped | [39114573095](https://github.com/paged-media/paged/actions/runs/39114573095) `b9ab20e` | 101 fixtures: 101 skipped | 0 |
| `core-gpu.yml` / vello on lavapipe / ubuntu-latest / nextest | [39105589730](https://github.com/paged-media/core/actions/runs/39105589730) `19c16fd` | 85 / 85 / 0 / 0 | — | — | not run on the PR, see below |
| `core-gpu.yml` / vello on lavapipe / ubuntu-latest / JUnit vello-junit | [39105589730](https://github.com/paged-media/core/actions/runs/39105589730) `19c16fd` | 85 / 85 / 0 / 0 | — | — | not run on the PR, see below |
| `core-gpu.yml` / vello on lavapipe / ubuntu-latest / vello parity | [39105589730](https://github.com/paged-media/core/actions/runs/39105589730) `19c16fd` | 101 fixtures / 660 pages: 101 passed, 0 failed | — | — | not run on the PR, see below |

### editor

| Suite (workflow / job / runner / counter) | Old run | Old run/pass/fail/skip | New run | New run/pass/fail/skip | Δ |
|---|---|---|---|---|---|
| `editor-tests.yml` / checks (lint + boundaries + boot-coi + thresholds) / ubuntu-latest / node:test | [39111494763](https://github.com/paged-media/editor/actions/runs/39111494763) `5497f52` | 23 / 23 / 0 / 0 | [39114573051](https://github.com/paged-media/paged/actions/runs/39114573051) `b9ab20e` | 23 / 23 / 0 / 0 | 0 |
| `editor-tests.yml` / checks (lint + boundaries + boot-coi + thresholds) / ubuntu-latest / guards | [39111494763](https://github.com/paged-media/editor/actions/runs/39111494763) `5497f52` | 8 guard steps OK | [39114573051](https://github.com/paged-media/paged/actions/runs/39114573051) `b9ab20e` | 8 guard steps OK | 0 |
| `editor-tests.yml` / playwright / ubuntu-latest / playwright | [39111494763](https://github.com/paged-media/editor/actions/runs/39111494763) `5497f52` | 1234 / 1234 / 0 / 34 | [39114573051](https://github.com/paged-media/paged/actions/runs/39114573051) `b9ab20e` | — | pending: secret STATE_DISPATCH_TOKEN (corpus checkout fails before Playwright starts) |
| `editor-tests.yml` / playwright / ubuntu-latest / playwright (report) | [39111494763](https://github.com/paged-media/editor/actions/runs/39111494763) `5497f52` | 1268: 1234 expected, 34 skipped, 0 unexpected, 0 flaky | [39114573051](https://github.com/paged-media/paged/actions/runs/39114573051) `b9ab20e` | — | pending: secret STATE_DISPATCH_TOKEN (corpus checkout fails before Playwright starts) |

### extensions

| Suite (workflow / job / runner / counter) | Old run | Old run/pass/fail/skip | New run | New run/pass/fail/skip | Δ |
|---|---|---|---|---|---|
| `extensions-vitest.yml` / vitest / ubuntu-latest / vitest | [39104436980](https://github.com/paged-media/plugin-sdk/actions/runs/39104436980) `e119ab6` | 743 / 743 / 0 / 0 | [39114573011](https://github.com/paged-media/paged/actions/runs/39114573011) `b9ab20e` | 743 / 743 / 0 / 0 | 0 |
| `extensions-vitest.yml` / vitest / ubuntu-latest / JUnit vitest-junit | [39104436980](https://github.com/paged-media/plugin-sdk/actions/runs/39104436980) `e119ab6` | 712 / 712 / 0 / 0 | [39114573011](https://github.com/paged-media/paged/actions/runs/39114573011) `b9ab20e` | 712 / 712 / 0 / 0 | 0 |

### publish

| Suite (workflow / job / runner / counter) | Old run | Old run/pass/fail/skip | New run | New run/pass/fail/skip | Δ |
|---|---|---|---|---|---|
| `publish-ci.yml` / tests (evidence) / ubuntu-latest / nextest | [39103521764](https://github.com/paged-media/plugin-publish/actions/runs/39103521764) `05c5719` | 768 / 768 / 0 / 11 | [39114573097](https://github.com/paged-media/paged/actions/runs/39114573097) `b9ab20e` | 768 / 768 / 0 / 11 | 0 |
| `publish-ci.yml` / tests (evidence) / ubuntu-latest / vitest | [39103521764](https://github.com/paged-media/plugin-publish/actions/runs/39103521764) `05c5719` | 39 / 39 / 0 / 0 | [39114573097](https://github.com/paged-media/paged/actions/runs/39114573097) `b9ab20e` | 39 / 39 / 0 / 0 | 0 |
| `publish-ci.yml` / tests (evidence) / ubuntu-latest / JUnit nextest-junit | [39103521764](https://github.com/paged-media/plugin-publish/actions/runs/39103521764) `05c5719` | 768 / 768 / 0 / 0 | [39114573097](https://github.com/paged-media/paged/actions/runs/39114573097) `b9ab20e` | 768 / 768 / 0 / 0 | 0 |
| `publish-ci.yml` / tests (evidence) / ubuntu-latest / JUnit vitest-junit-publish-bundle | [39103521764](https://github.com/paged-media/plugin-publish/actions/runs/39103521764) `05c5719` | 13 / 13 / 0 / 0 | [39114573097](https://github.com/paged-media/paged/actions/runs/39114573097) `b9ab20e` | 13 / 13 / 0 / 0 | 0 |
| `publish-ci.yml` / tests (evidence) / ubuntu-latest / JUnit vitest-junit-pdf-bundle | [39103521764](https://github.com/paged-media/plugin-publish/actions/runs/39103521764) `05c5719` | 26 / 26 / 0 / 0 | [39114573097](https://github.com/paged-media/paged/actions/runs/39114573097) `b9ab20e` | 26 / 26 / 0 / 0 | 0 |

### image

| Suite (workflow / job / runner / counter) | Old run | Old run/pass/fail/skip | New run | New run/pass/fail/skip | Δ |
|---|---|---|---|---|---|
| `image-ci.yml` / rust GPU tests (Metal) / macos-14 / cargo test | [38389428083](https://github.com/paged-media/plugin-image/actions/runs/38389428083) `4539363` | 1193 / 1193 / 0 / 21 | [39114572997](https://github.com/paged-media/paged/actions/runs/39114572997) `b9ab20e` | — | not run on the PR, see below |
| `image-ci.yml` / rust engine / ubuntu-latest / cargo test | [38389428083](https://github.com/paged-media/plugin-image/actions/runs/38389428083) `4539363` | 1192 / 1192 / 0 / 21 | [39114572997](https://github.com/paged-media/paged/actions/runs/39114572997) `b9ab20e` | 1192 / 1192 / 0 / 21 | 0 |
| `image-ci.yml` / rust GPU tests (lavapipe) / ubuntu-24.04 / cargo test | [38389428083](https://github.com/paged-media/plugin-image/actions/runs/38389428083) `4539363` | 1193 / 1193 / 0 / 21 | [39114572997](https://github.com/paged-media/paged/actions/runs/39114572997) `b9ab20e` | 1193 / 1193 / 0 / 21 | 0 |
| `image-ci.yml` / ts bundle / ubuntu-latest / vitest | [38389428083](https://github.com/paged-media/plugin-image/actions/runs/38389428083) `4539363` | 353 / 353 / 0 / 0 | [39114572997](https://github.com/paged-media/paged/actions/runs/39114572997) `b9ab20e` | 353 / 353 / 0 / 0 | 0 |
| `image-publish-state.yml` / vitest evidence / ubuntu-latest / JUnit vitest-junit | [38389428020](https://github.com/paged-media/plugin-image/actions/runs/38389428020) `4539363` | 350 / 350 / 0 / 3 | — | — | not run on the PR, see below |
| `image-publish-state.yml` / nextest evidence / ubuntu-latest / nextest | [38389428020](https://github.com/paged-media/plugin-image/actions/runs/38389428020) `4539363` | 1192 / 1192 / 0 / 21 | — | — | not run on the PR, see below |
| `image-publish-state.yml` / nextest evidence / ubuntu-latest / JUnit nextest-junit | [38389428020](https://github.com/paged-media/plugin-image/actions/runs/38389428020) `4539363` | 1192 / 1192 / 0 / 0 | — | — | not run on the PR, see below |

### draw

| Suite (workflow / job / runner / counter) | Old run | Old run/pass/fail/skip | New run | New run/pass/fail/skip | Δ |
|---|---|---|---|---|---|
| `draw-rust.yml` / rust / ubuntu-latest / cargo test | [38870353614](https://github.com/paged-media/plugin-draw/actions/runs/38870353614) `b598a4f` | 26 / 26 / 0 / 0 | [39114572977](https://github.com/paged-media/paged/actions/runs/39114572977) `b9ab20e` | 26 / 26 / 0 / 0 | 0 |
| `draw-vitest.yml` / vitest / ubuntu-latest / JUnit vitest-junit | [38870353446](https://github.com/paged-media/plugin-draw/actions/runs/38870353446) `b598a4f` | 2668 / 2668 / 0 / 34 | [39114573055](https://github.com/paged-media/paged/actions/runs/39114573055) `b9ab20e` | 2668 / 2668 / 0 / 34 | 0 |

### sheet

| Suite (workflow / job / runner / counter) | Old run | Old run/pass/fail/skip | New run | New run/pass/fail/skip | Δ |
|---|---|---|---|---|---|
| `sheet-rust.yml` / test / ubuntu-latest / nextest | [39098219634](https://github.com/paged-media/plugin-sheets/actions/runs/39098219634) `89ae789` | 1496 / 1496 / 0 / 5 | [39114572983](https://github.com/paged-media/paged/actions/runs/39114572983) `b9ab20e` | 1496 / 1496 / 0 / 5 | 0 |
| `sheet-rust.yml` / test / ubuntu-latest / JUnit nextest-junit | [39098219634](https://github.com/paged-media/plugin-sheets/actions/runs/39098219634) `89ae789` | 1496 / 1496 / 0 / 0 | [39114572983](https://github.com/paged-media/paged/actions/runs/39114572983) `b9ab20e` | 1496 / 1496 / 0 / 0 | 0 |
| `sheet-vitest.yml` / vitest / ubuntu-latest / vitest | [39098219635](https://github.com/paged-media/plugin-sheets/actions/runs/39098219635) `89ae789` | 541 / 541 / 0 / 1 | [39114573052](https://github.com/paged-media/paged/actions/runs/39114573052) `b9ab20e` | 541 / 541 / 0 / 1 | 0 |
| `sheet-vitest.yml` / vitest / ubuntu-latest / JUnit vitest-junit | [39098219635](https://github.com/paged-media/plugin-sheets/actions/runs/39098219635) `89ae789` | 541 / 541 / 0 / 1 | [39114573052](https://github.com/paged-media/paged/actions/runs/39114573052) `b9ab20e` | 541 / 541 / 0 / 1 | 0 |

### data

| Suite (workflow / job / runner / counter) | Old run | Old run/pass/fail/skip | New run | New run/pass/fail/skip | Δ |
|---|---|---|---|---|---|
| `data-rust.yml` / test / ubuntu-latest / nextest | [39013601426](https://github.com/paged-media/plugin-data/actions/runs/39013601426) `11799a6` | 317 / 317 / 0 / 0 | [39114572973](https://github.com/paged-media/paged/actions/runs/39114572973) `b9ab20e` | 317 / 317 / 0 / 0 | 0 |
| `data-rust.yml` / test / ubuntu-latest / JUnit nextest-junit | [39013601426](https://github.com/paged-media/plugin-data/actions/runs/39013601426) `11799a6` | 317 / 317 / 0 / 0 | [39114572973](https://github.com/paged-media/paged/actions/runs/39114572973) `b9ab20e` | 317 / 317 / 0 / 0 | 0 |
| `data-vitest.yml` / vitest / ubuntu-latest / vitest | [39013601420](https://github.com/paged-media/plugin-data/actions/runs/39013601420) `11799a6` | 454 / 454 / 0 / 2 | [39114572992](https://github.com/paged-media/paged/actions/runs/39114572992) `b9ab20e` | 454 / 454 / 0 / 2 | 0 |
| `data-vitest.yml` / vitest / ubuntu-latest / JUnit vitest-junit | [39013601420](https://github.com/paged-media/plugin-data/actions/runs/39013601420) `11799a6` | 454 / 454 / 0 / 2 | [39114572992](https://github.com/paged-media/paged/actions/runs/39114572992) `b9ab20e` | 454 / 454 / 0 / 2 | 0 |

### doc

| Suite (workflow / job / runner / counter) | Old run | Old run/pass/fail/skip | New run | New run/pass/fail/skip | Δ |
|---|---|---|---|---|---|
| `doc-rust.yml` / test / ubuntu-latest / nextest | [39052833299](https://github.com/paged-media/plugin-doc/actions/runs/39052833299) `e12353e` | 176 / 176 / 0 / 5 | — | — | not run on the PR, see below |
| `doc-rust.yml` / test / ubuntu-latest / JUnit nextest-junit | [39052833299](https://github.com/paged-media/plugin-doc/actions/runs/39052833299) `e12353e` | 176 / 176 / 0 / 0 | — | — | not run on the PR, see below |
| `doc-vitest.yml` / vitest / ubuntu-latest / JUnit vitest-junit | [39052833304](https://github.com/paged-media/plugin-doc/actions/runs/39052833304) `e12353e` | 73 / 73 / 0 / 12 | — | — | not run on the PR, see below |

### slide

| Suite (workflow / job / runner / counter) | Old run | Old run/pass/fail/skip | New run | New run/pass/fail/skip | Δ |
|---|---|---|---|---|---|
| `slide-bundle.yml` / bundle / ubuntu-latest / vitest | [39052837993](https://github.com/paged-media/plugin-slide/actions/runs/39052837993) `0ff0583` | 59 / 59 / 0 / 0 | [39114573084](https://github.com/paged-media/paged/actions/runs/39114573084) `b9ab20e` | 59 / 59 / 0 / 0 | 0 |
| `slide-bundle.yml` / bundle / ubuntu-latest / JUnit vitest-junit | [39052837993](https://github.com/paged-media/plugin-slide/actions/runs/39052837993) `0ff0583` | 59 / 59 / 0 / 0 | [39114573084](https://github.com/paged-media/paged/actions/runs/39114573084) `b9ab20e` | 59 / 59 / 0 / 0 | 0 |
| `slide-rust.yml` / test / ubuntu-latest / nextest | [39052837969](https://github.com/paged-media/plugin-slide/actions/runs/39052837969) `0ff0583` | 72 / 72 / 0 / 1 | [39114573053](https://github.com/paged-media/paged/actions/runs/39114573053) `b9ab20e` | 72 / 72 / 0 / 1 | 0 |
| `slide-rust.yml` / test / ubuntu-latest / JUnit nextest-junit | [39052837969](https://github.com/paged-media/plugin-slide/actions/runs/39052837969) `0ff0583` | 72 / 72 / 0 / 0 | [39114573053](https://github.com/paged-media/paged/actions/runs/39114573053) `b9ab20e` | 72 / 72 / 0 / 0 | 0 |

### web

| Suite (workflow / job / runner / counter) | Old run | Old run/pass/fail/skip | New run | New run/pass/fail/skip | Δ |
|---|---|---|---|---|---|
| `web-rust.yml` / test / ubuntu-latest / cargo test | [39012929516](https://github.com/paged-media/plugin-web/actions/runs/39012929516) `a6369f7` | 76 / 76 / 0 / 0 | [39114573076](https://github.com/paged-media/paged/actions/runs/39114573076) `b9ab20e` | 76 / 76 / 0 / 0 | 0 |
| `web-rust.yml` / test / ubuntu-latest / nextest | [39012929516](https://github.com/paged-media/plugin-web/actions/runs/39012929516) `a6369f7` | 170 / 170 / 0 / 0 | [39114573076](https://github.com/paged-media/paged/actions/runs/39114573076) `b9ab20e` | 170 / 170 / 0 / 0 | 0 |
| `web-rust.yml` / test / ubuntu-latest / JUnit nextest-junit | [39012929516](https://github.com/paged-media/plugin-web/actions/runs/39012929516) `a6369f7` | 170 / 170 / 0 / 0 | [39114573076](https://github.com/paged-media/paged/actions/runs/39114573076) `b9ab20e` | 170 / 170 / 0 / 0 | 0 |
| `web-vitest.yml` / vitest / ubuntu-latest / vitest | [39012929525](https://github.com/paged-media/plugin-web/actions/runs/39012929525) `a6369f7` | 732 / 732 / 0 / 9 | [39114573021](https://github.com/paged-media/paged/actions/runs/39114573021) `b9ab20e` | 732 / 732 / 0 / 9 | 0 |
| `web-vitest.yml` / vitest / ubuntu-latest / JUnit vitest-junit | [39012929525](https://github.com/paged-media/plugin-web/actions/runs/39012929525) `a6369f7` | 732 / 732 / 0 / 9 | [39114573021](https://github.com/paged-media/paged/actions/runs/39114573021) `b9ab20e` | 732 / 732 / 0 / 9 | 0 |

## Differences

### D1: core, one test added before the import

Affected suites: `core-ci.yml` / `check + test` (ubuntu, macOS) `cargo test`:
3031 → 3032 run, 378 → 379 `test result` lines. `nextest evidence`:
3030 → 3031 run, 350 → 351 binaries, and its JUnit has 3030 → 3031 ids.

- **Cause.** The old side is core's last green `ci.yml` run, at `b612da5`.
  The import took `19c16fd`, the merge of paged-media/core#141, whose commit
  `5f664b4` (`bee6588` in this repository) adds
  `engine/core/crates/paged-export-pdf/tests/tagged_tables.rs` with one test,
  `a_table_is_tagged_as_indesign_tags_it`.
- **Evidence.** The added JUnit id is exactly
  `paged-export-pdf::tagged_tables::a_table_is_tagged_as_indesign_tags_it`.
  No id was removed and no result changed. core's own run at `19c16fd`
  ([39105589722](https://github.com/paged-media/core/actions/runs/39105589722),
  red only on clippy) has a green `nextest evidence` job with 3031 run,
  7 skipped, 351 binaries. Its test-id set equals the monorepo's. In the
  monorepo `cargo test` log, both legs show
  `Running tests/tagged_tables.rs … 1 passed`. Neither old log has that line.
- **Not a migration difference.** The monorepo commits on `engine/core`
  after the import (`7710d6b`, `b9ab20e`) change a test comment, a corpus
  path and one type alias. They add or remove no test.

## Not measured on the new side

| Suite | Old counts | Why no new count | How to get one |
|---|---|---|---|
| `editor-tests.yml` / playwright (3 shards) | 1268 tests: 1234 passed, 0 failed, 34 skipped, 0 flaky | **pending: secret `STATE_DISPATCH_TOKEN`.** Every shard fails at the private corpus checkout (`Not Found`) before Playwright starts, and `merge reports` then finds no `playwright-results.json`. The `checks` job of the same run is green and matches (above). | add the repository secret, re-run the workflow |
| `core-gpu.yml` / vello on lavapipe | nextest 85/85/0/0 on llvmpipe; Vello parity 101 fixtures / 660 pages, all within budget | PR #3's diff does not touch the `pull_request` path filter (paged-gpu, paged-compose, paged-renderer, corpus/generated). The only monorepo run (on `4e8e582`) was cancelled. | the next push to `main` touching `engine/core/**`, or `workflow_dispatch` |
| `doc-rust.yml` / test, `doc-vitest.yml` / vitest | nextest 176/176/0/5; JUnit 85: 73 passed, 12 skipped | push-to-main only, as in the old repository | the merge to `main`, or `workflow_dispatch` |
| `image-publish-state.yml` / nextest evidence, vitest evidence | nextest 1192/1192/0/21; JUnit 353: 350 passed, 3 skipped | push-to-main only, no dispatch trigger | the merge to `main` |
| `image-ci.yml` / rust GPU tests (Metal) | cargo test 1193/1193/0/21 on "Apple Paravirtual device" | `if: github.event_name != 'pull_request'`, unchanged from the old workflow | the merge to `main` |
| `core-ci.yml` / tag-on-bump nudge, protocol-tag-guard | (no test counts) | push-to-main only (`if:`), unchanged | the merge to `main` |

Not compared at all:

- `editor-protocol-version.yml`. It is PR-only and had no green run in the
  old repository to compare with. Its monorepo run on PR #3 is green.
- Schedule-only and dispatch-only workflows: `core-perf-nightly`,
  `editor-showcase-nightly`, `sheet-fuzz`, and the deploy workflows.
- The disabled publish workflows (dispatch-only in the monorepo). Old draw
  `publish.yml` also ran `pnpm test`, and that run is not compared.

## Skips, inconclusive gates, GPU lanes

- **Skip counts** are in the tables (fourth number). Every skip count is
  identical on both sides where both ran.
- **core fidelity gate measures nothing, before and after.** Both legs of
  both runs report all 101 fixtures as `skipped` in
  `paged-results-fidelity.json` ("no FOGRA39 profile on this runner"). The
  16 PASS / 85 FAIL lines in the log are the advisory pixel comparison
  against a reference in another colour space, and they are identical too.
  Only the golden-snapshot `cargo test` (1 test) gates there.
- **GPU lanes ran on a real adapter.** core `vello on lavapipe` (old only):
  `deviceName = llvmpipe`, 85 tests run, none skipped. image
  `rust GPU tests (lavapipe)`: llvmpipe on both sides, 1193 run. image Metal
  (old only): "Apple Paravirtual device". No GPU lane ran 0 tests or skipped
  everything. In the editor's Playwright shards, the browser logs
  `initGpu: no compatible wgpu adapter`, so those tests run without WebGPU
  (old side; the new side has not run yet).

## Job times (T0 input)

Job run time is `completed_at − started_at` of each job, so queue time is
left out. Shards are summed. The table lists every job of the compared
workflows, including those without test counts. Each side is one sample
from 2026-10-18.

- **New side.** The new side ran on a pull request. Its rust caches were
  restored from earlier monorepo PR runs, with full or partial key hits,
  except `wasm test lane`, which found no cache (+3m35s).
- **Old side.** Old core and editor runs queued behind other repositories'
  jobs (see the timing baseline). That does not affect these run times.
- **Not comparable.** A `(failure)` or `skipped` entry on the new side
  cannot be compared. The editor Playwright time on the new side is the
  failed corpus checkout, not a test run.

| Workflow / job | Runner | Old job time | New job time | Δ | Slowest step (old) |
|---|---|---|---|---|---|
| `core-ci.yml` / tag-on-bump nudge | ubuntu-latest | 8s | skipped | — | Run actions/checkout@v4 (3s) |
| `core-ci.yml` / idml-viewer vitest | ubuntu-latest | 21s | 17s | -4s | vitest → JUnit (11s) |
| `core-ci.yml` / protocol-tag-guard | ubuntu-latest | 8s | skipped | — | Run actions/checkout@v4 (3s) |
| `core-ci.yml` / resolve pinned toolchain | ubuntu-latest | 6s | 9s | +3s | Run actions/checkout@v4 (3s) |
| `core-ci.yml` / check + test (ubuntu-latest) | ubuntu-latest | 31m45s | 33m07s | +82s | test (28m07s) |
| `core-ci.yml` / wasm test lane (stub, pending W0.8) | ubuntu-latest | 3m37s | 7m12s | +215s | make test-wasm (2m08s) |
| `core-ci.yml` / pdf export-diff gate | ubuntu-latest | 15m01s | 9m05s | -356s | export-diff gate (hard; all fixtures minus known drift) (14m01s) |
| `core-ci.yml` / check + test (macos-latest) | macos-latest | 31m15s | 30m26s | -49s | test (26m54s) |
| `core-ci.yml` / nextest evidence | ubuntu-latest | 23m31s | 23m51s | +20s | nextest (workspace) → JUnit (21m35s) |
| `core-ci.yml` / wasm-size gate (Spike C) | ubuntu-latest | 1m02s | 2m24s | +82s | measure (32s) |
| `core-fidelity.yml` / resolve pinned toolchain | ubuntu-latest | 6s | 9s | +3s | Run actions/checkout@v4 (2s) |
| `core-fidelity.yml` / corpus diff (macos-latest) | macos-latest | 7m20s | 9m51s | +151s | generated-corpus fidelity gate (hard) (4m48s) |
| `core-fidelity.yml` / corpus diff (ubuntu-latest) | ubuntu-latest | 13m59s | 11m06s | -173s | generated-corpus fidelity gate (hard) (10m13s) |
| `core-gpu.yml` / resolve pinned toolchain | ubuntu-latest | 6s | not run | — | Run actions/checkout@v4 (3s) |
| `core-gpu.yml` / vello on lavapipe | ubuntu-latest | 16m35s | not run | — | CPU ↔ Vello parity over the generated corpus (15m06s) |
| `core-licenses.yml` / cargo-deny | ubuntu-latest | 46s | 50s | +4s | Run EmbarkStudios/cargo-deny-action@v2 (31s) |
| `editor-tests.yml` / checks (lint + boundaries + boot-coi + thresholds) | ubuntu-latest | 1m13s | 34s | -39s | Run actions/checkout@v4 (37s) |
| `editor-tests.yml` / playwright | ubuntu-latest | 158m26s | 2m05s (failure) | — | playwright (lean surface, shard 3) (40m02s) |
| `editor-tests.yml` / merge reports + publish evidence | ubuntu-latest | 34s | 18s (failure) | — | checkout editor (22s) |
| `extensions-vitest.yml` / vitest | ubuntu-latest | 31s | 38s | +7s | vitest → JUnit (14s) |
| `extensions-contract-guard.yml` / bump-on-contract-change | ubuntu-latest | 10s | 11s | +1s | Run actions/setup-node@v4 (3s) |
| `publish-ci.yml` / fmt + clippy + build | ubuntu-latest | 1m19s | 59s | -20s | build (native) (28s) |
| `publish-ci.yml` / tests (evidence) | ubuntu-latest | 1m24s | 1m23s | -1s | nextest → JUnit (40s) |
| `publish-ci.yml` / bundles typecheck + build + validate | ubuntu-latest | 20s | 20s | +0s | Run pnpm -r --filter "./packages/*" build (4s) |
| `image-ci.yml` / rust GPU tests (Metal) | macos-14 | 3m48s | skipped | — | test (REQUIRE_GPU=1) (3m12s) |
| `image-ci.yml` / rust engine | ubuntu-latest | 1m47s | 1m55s | +8s | test (48s) |
| `image-ci.yml` / rust GPU tests (lavapipe) | ubuntu-24.04 | 2m39s | 2m43s | +4s | test (REQUIRE_GPU=1) (1m59s) |
| `image-ci.yml` / ts bundle | ubuntu-latest | 1m39s | 2m03s | +24s | build wasm (57s) |
| `image-publish-state.yml` / vitest evidence | ubuntu-latest | 23s | not run | — | vitest (junit per package; red results still publish) (10s) |
| `image-publish-state.yml` / nextest evidence | ubuntu-latest | 1m09s | not run | — | nextest (workspace) → JUnit (49s) |
| `draw-rust.yml` / rust | ubuntu-latest | 30s | 40s | +10s | toolchain (rust-toolchain.toml pins the channel + target) (9s) |
| `draw-vitest.yml` / vitest | ubuntu-latest | 1m45s | 2m12s | +27s | vitest (junit per package; red results still upload) (1m23s) |
| `sheet-rust.yml` / check | ubuntu-latest | 1m00s | 1m05s | +5s | Run EmbarkStudios/cargo-deny-action@v2 (20s) |
| `sheet-rust.yml` / test | ubuntu-latest | 45s | 57s | +12s | nextest (junit; red results still publish via !cancelled upload) (22s) |
| `sheet-rust.yml` / wasm | ubuntu-latest | 1m07s | 1m15s | +8s | build + budget gate (100 MB app-wide) (47s) |
| `sheet-vitest.yml` / vitest | ubuntu-latest | 1m43s | 1m17s | -26s | build the engine wasm artifact (100 MB app wasm budget gate) (48s) |
| `data-rust.yml` / check | ubuntu-latest | 59s | 58s | -1s | Run EmbarkStudios/cargo-deny-action@v2 (22s) |
| `data-rust.yml` / test | ubuntu-latest | 58s | 53s | -5s | nextest (junit) (34s) |
| `data-rust.yml` / wasm | ubuntu-latest | 1m07s | 44s | -23s | build + budget gate (100 MB app-wide) (43s) |
| `data-vitest.yml` / vitest | ubuntu-latest | 2m06s | 2m39s | +33s | vitest (junit per package) (59s) |
| `doc-rust.yml` / wasm | ubuntu-latest | 7m33s | not run | — | build + budget gate (100 MB app-wide) (7m01s) |
| `doc-rust.yml` / check | ubuntu-latest | 2m02s | not run | — | Run cargo clippy --workspace --all-targets -- -D warnings (1m16s) |
| `doc-rust.yml` / test | ubuntu-latest | 2m34s | not run | — | nextest (junit; red results still upload) (2m05s) |
| `doc-vitest.yml` / vitest | ubuntu-latest | 20s | not run | — | typecheck (4s) |
| `slide-bundle.yml` / bundle | ubuntu-latest | 4m30s | 1m15s | -195s | build the engine wasm (100 MB app-wide budget gate) (3m53s) |
| `slide-rust.yml` / check | ubuntu-latest | 2m02s | 1m10s | -52s | Run cargo clippy --workspace --all-targets -- -D warnings (1m10s) |
| `slide-rust.yml` / test | ubuntu-latest | 2m47s | 1m03s | -104s | nextest (junit; red results still upload) (2m14s) |
| `web-rust.yml` / check | ubuntu-latest | 30s | 35s | +5s | Run dtolnay/rust-toolchain@master (8s) |
| `web-rust.yml` / test | ubuntu-latest | 49s | 41s | -8s | cargo nextest (blitz — lowering, capture, flow fragmentation) (11s) |
| `web-vitest.yml` / vitest | ubuntu-latest | 5m17s | 3m12s | -125s | build the Blitz ENGINE wasm artifact (manifest maxBytes budget gate; stamps bin/SOURCE_HASH) (4m06s) |

### Slowest 10 test suites (old side)

| # | Workflow / job | Runner | Old (sum of jobs) | Old (longest job) | New |
|---|---|---|---|---|---|
| 1 | `editor-tests.yml` / playwright | ubuntu-latest | 158m26s | 57m16s | pending |
| 2 | `core-ci.yml` / check + test (ubuntu-latest) | ubuntu-latest | 31m45s | 31m45s | 33m07s |
| 3 | `core-ci.yml` / check + test (macos-latest) | macos-latest | 31m15s | 31m15s | 30m26s |
| 4 | `core-ci.yml` / nextest evidence | ubuntu-latest | 23m31s | 23m31s | 23m51s |
| 5 | `core-gpu.yml` / vello on lavapipe | ubuntu-latest | 16m35s | 16m35s | not run |
| 6 | `core-ci.yml` / pdf export-diff gate | ubuntu-latest | 15m01s | 15m01s | 9m05s |
| 7 | `core-fidelity.yml` / corpus diff (ubuntu-latest) | ubuntu-latest | 13m59s | 13m59s | 11m06s |
| 8 | `core-fidelity.yml` / corpus diff (macos-latest) | macos-latest | 7m20s | 7m20s | 9m51s |
| 9 | `web-vitest.yml` / vitest | ubuntu-latest | 5m17s | 5m17s | 3m12s |
| 10 | `slide-bundle.yml` / bundle | ubuntu-latest | 4m30s | 4m30s | 1m15s |

The 32 test-bearing jobs took 341m29s of job time on the old side. Editor
Playwright alone took 158m26s of that (46%), in three shards of 49m11s,
51m59s and 57m16s. core's four Rust jobs follow (31m45s, 31m15s, 23m31s,
16m35s). Together those five suites are 77% of the total.

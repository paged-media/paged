# Test inventory (wave T, step T0)

This is the measured starting point for the test restructuring in wave T (T1–T6) and the
"before" for T4, B7 and A10. Every number below comes from CI data or from the source tree;
nothing is estimated.

Raw data: [`test-inventory.json`](test-inventory.json). It was produced by
[`tooling/migration/test_inventory.py`](../../tooling/migration/test_inventory.py) (Python 3
standard library), which reuses `parity_counts.py` for log parsing and its cache layout:

- **Suites, job times, counts:** the A5 runs in [`parity.md`](parity.md) and
  [`parity-baseline.json`](parity-baseline.json): the last green run of each old
  per-component workflow and the monorepo run of the same workflow on PR #3 (`b9ab20e`).
  Step times come from the same runs, split into buckets with the rules of
  [`ci-timing-baseline.json`](ci-timing-baseline.json).
- **Per-test durations:** the JUnit and Playwright artifacts of those runs.
- **Flake history:** the last 30 runs of every test workflow, in the old repositories and in
  the monorepo, with the jobs of every attempt and the logs of failed test steps and of every
  passing Playwright shard. Snapshot: 2026-10-18T13:11:34Z.
- **Skips, fakes, boot helpers:** a scan of this branch's source tree (`a5/baseline`, the pure
  import).
- **Cockpit mapping:** the test ids of the artifacts above, matched against the Cockpit test
  map with the rules of `tooling/migration/test-ids.py` (T4).

## Headline

- **Slowest suites (old side, job time):** editor Playwright 158m (three shards, 49–57m each),
  core `check + test` 32m on Ubuntu and 31m on macOS, core `nextest evidence` 24m, core
  `vello on lavapipe` 17m. Those five are 77% of all test-job time. Core runs the same ~3,030
  tests three times per push: `cargo test` on two operating systems and once more under
  nextest for the JUnit evidence.
- **A handful of tests dominate core:** core's 10 slowest nextest tests take 2,164s, 62% of
  the suite's summed test time, and 74 of its 3,031 tests hold 90%. The slowest single test
  takes 280s of a 912s nextest run, so it sets the critical path.
- **Playwright shards build plugins from source:** each editor shard spends 15 minutes
  building the doc and slide plugins before any test runs (45 minutes of job time per run).
- **Silent skips: 322 tests** pass without testing anything when a resource is missing
  (313 Rust, 9 TypeScript). 232 of them are image GPU tests; in the image `rust engine` lane
  and in the `publish-state` evidence lane, which feeds Cockpit, they report "passed" with no
  adapter (all 232 together take 2.5s there). Another 50 Rust tests are `#[ignore]`d, 40 of
  them opt-in corpus or oracle lanes.
- **Flakes:** no old workflow was re-run in its last 30 runs and no job flipped between red and
  green at the same commit. The flakes hide in Playwright's retry: in 7 of the last 22
  finished editor runs, at least one test failed and then passed on its second attempt. The
  monorepo has one confirmed flake (image lavapipe, `resident_chains_equal_the_per_tile_scheduler…`, run
  39112319446, green on re-run).
- **Duplicated fakes:** 189 hand-rolled fake or host definitions in 136 test files (138 of them
  fake hosts, editors or shells), 22 copies of `mapBacking`, and 172 test files that boot the
  real core engine wasm, 92 of them once per test.
- **Cockpit mapping:** of the 14,291 tests in the CI artifacts, 9,217 are mapped to a feature
  and 5,074 (36%) are not. Core's nextest suite is 79% unmapped (2,404 of 3,031). The
  rewritten map for the merged test binaries maps exactly the same Rust tests.

## 1. Suites: wall time, counts, skips, setup share

**For T1–T6.** The five slowest suites are editor Playwright, core `check + test` (two OSes),
core `nextest evidence` and core `vello on lavapipe`. T4 targets:

- core's triple run of the same tests: one nextest run per OS that also writes the JUnit
  replaces `cargo test` + `nextest evidence`;
- the 15 minutes per Playwright shard that build the doc and slide plugins from source: in the
  monorepo they build once, before the shards;
- the small jobs whose setup is most of their time (draw `rust`: three quarters of its 30–40s),
  which A10 merges.

How to read the table. *Job time* is `completed_at − started_at` of the job (queue time left
out), shards summed. The split uses the step buckets of `ci-timing-baseline.json`: setup
(job set-up, checkout, toolchains, installs) plus cache restore/save, build + test (everything
that compiles, tests or gates), and report (uploads, summaries). *Test runner reports* is the
time the runners print for themselves: nextest's `Summary`, the sum of cargo's
`finished in`, vitest's `Duration`, Playwright's `passed (…)`, node:test's `duration_ms`. The
gap between *build + test* and *test runner reports* is compile time, fixture generation and
gates (export-diff, fidelity, Vello parity). The split is from the monorepo run where one
exists, else the old run.

| Component | Workflow / job | Runner | Tests run / skipped | Job time old → new | Setup + cache | Build + test | Test runner reports | Report/upload |
|---|---|---|---|---|---|---|---|---|
| core | `core-ci.yml` / idml-viewer vitest | ubuntu-latest | vitest: 27 / 0 | 21s → 17s | 7s (41%) | 7s (41%) | 0s | 1s |
| core | `core-ci.yml` / check + test (ubuntu-latest) | ubuntu-latest | cargo test: 3032 / 8 | 31m45s → 33m07s | 2m34s (8%) | 30m30s (92%) | 17m43s | 0s |
| core | `core-ci.yml` / wasm test lane (stub, pending W0.8) | ubuntu-latest | cargo test: 6 / 0 | 3m37s → 7m12s | 2m02s (28%) | 5m08s (71%) | 0s | 0s |
| core | `core-ci.yml` / check + test (macos-latest) | macos-latest | cargo test: 3032 / 8 | 31m15s → 30m26s | 1m06s (4%) | 29m18s (96%) | 16m36s | 0s |
| core | `core-ci.yml` / nextest evidence | ubuntu-latest | nextest: 3031 / 7 | 23m31s → 23m51s | 1m57s (8%) | 21m52s (92%) | 15m12s | 1s |
| core | `core-fidelity.yml` / corpus diff (macos-latest) | macos-latest | cargo test: 1 / 0 | 7m20s → 9m51s | 48s (8%) | 8m57s (91%) | 3s | 2s |
| core | `core-fidelity.yml` / corpus diff (ubuntu-latest) | ubuntu-latest | cargo test: 1 / 0 | 13m59s → 11m06s | 43s (6%) | 10m18s (93%) | 3s | 1s |
| core | `core-gpu.yml` / vello on lavapipe | ubuntu-latest | nextest: 85 / 0 | 16m35s → — | 50s (5%) | 15m39s (94%) | 21s | 3s |
| editor | `editor-tests.yml` / checks (lint + boundaries + boot-coi + thresholds) | ubuntu-latest | node:test: 23 / 0 | 1m13s → 34s | 14s (41%) | 15s (44%) | — | 1s |
| editor | `editor-tests.yml` / playwright | ubuntu-latest | playwright: 1234 / 34 | 2h38m → — | 3m45s (2%) | 2h34m (97%) | 1h48m | 4s |
| extensions | `extensions-vitest.yml` / vitest | ubuntu-latest | vitest: 743 / 0 | 31s → 38s | 15s (39%) | 20s (53%) | 15s | 1s |
| publish | `publish-ci.yml` / tests (evidence) | ubuntu-latest | nextest: 768 / 11; vitest: 39 / 0 | 1m24s → 1m23s | 37s (45%) | 40s (48%) | 9s | 3s |
| image | `image-ci.yml` / rust GPU tests (Metal) | macos-14 | cargo test: 1193 / 21 | 3m48s → — | 34s (15%) | 3m12s (84%) | 2m32s | 0s |
| image | `image-ci.yml` / rust engine | ubuntu-latest | cargo test: 1192 / 21 | 1m47s → 1m55s | 25s (22%) | 1m27s (76%) | 10s | 0s |
| image | `image-ci.yml` / rust GPU tests (lavapipe) | ubuntu-24.04 | cargo test: 1193 / 21 | 2m39s → 2m43s | 33s (20%) | 2m08s (79%) | 1m30s | 0s |
| image | `image-ci.yml` / ts bundle | ubuntu-latest | vitest: 353 / 0 | 1m39s → 2m03s | 37s (30%) | 1m22s (67%) | — | 0s |
| image | `image-publish-state.yml` / nextest evidence | ubuntu-latest | nextest: 1192 / 21 | 1m09s → — | 19s (28%) | 49s (71%) | 10s | 0s |
| draw | `draw-rust.yml` / rust | ubuntu-latest | cargo test: 26 / 0 | 30s → 40s | 30s (75%) | 7s (18%) | — | 0s |
| sheet | `sheet-rust.yml` / test | ubuntu-latest | nextest: 1496 / 5 | 45s → 57s | 21s (37%) | 32s (56%) | 8s | 1s |
| sheet | `sheet-vitest.yml` / vitest | ubuntu-latest | vitest: 541 / 1 | 1m43s → 1m17s | 24s (31%) | 50s (65%) | 14s | 1s |
| data | `data-rust.yml` / test | ubuntu-latest | nextest: 317 / 0 | 58s → 53s | 21s (40%) | 29s (55%) | 8s | 0s |
| data | `data-vitest.yml` / vitest | ubuntu-latest | vitest: 454 / 2 | 2m06s → 2m39s | 30s (19%) | 2m04s (78%) | 1m10s | 1s |
| doc | `doc-rust.yml` / test | ubuntu-latest | nextest: 176 / 5 | 2m34s → — | 26s (17%) | 2m05s (81%) | 1s | 1s |
| slide | `slide-bundle.yml` / bundle | ubuntu-latest | vitest: 59 / 0 | 4m30s → 1m15s | 32s (43%) | 38s (51%) | 10s | 1s |
| slide | `slide-rust.yml` / test | ubuntu-latest | nextest: 72 / 1 | 2m47s → 1m03s | 29s (46%) | 28s (44%) | 14s | 1s |
| web | `web-rust.yml` / test | ubuntu-latest | cargo test: 76 / 0; nextest: 170 / 0 | 49s → 41s | 22s (54%) | 16s (39%) | 3s | 1s |
| web | `web-vitest.yml` / vitest | ubuntu-latest | vitest: 732 / 9 | 5m17s → 3m12s | 27s (14%) | 2m41s (84%) | 34s | 1s |

Workflow wall time over the history (first job start to last job end of green runs):

| Component | Workflow | Old: green runs, median wall | New: green runs, median wall |
|---|---|---|---|
| core | `core-ci.yml` | 24, 38m56s | 5, 1h39m |
| core | `core-fidelity.yml` | 30, 16m17s | 13, 40m15s |
| core | `core-gpu.yml` | 30, 19m33s | 11, 46m03s |
| core | `core-perf-nightly.yml` | 12, 15m02s | 0, — |
| editor | `editor-tests.yml` | 20, 54m21s | 0, — |
| extensions | `extensions-vitest.yml` | 29, 40s | 11, 45s |
| publish | `publish-ci.yml` | 23, 1m49s | 19, 6m27s |
| image | `image-ci.yml` | 28, 1m53s | 17, 16m56s |
| image | `image-publish-state.yml` | 30, 57s | 1, 12m00s |
| draw | `draw-rust.yml` | 30, 31s | 14, 2m29s |
| draw | `draw-vitest.yml` | 30, 2m00s | 13, 2m13s |
| sheet | `sheet-rust.yml` | 26, 1m16s | 13, 9m36s |
| sheet | `sheet-vitest.yml` | 29, 1m39s | 16, 3m17s |
| data | `data-rust.yml` | 26, 1m11s | 10, 14m56s |
| data | `data-vitest.yml` | 28, 2m09s | 15, 4m00s |
| doc | `doc-rust.yml` | 24, 3m03s | 1, 14m53s |
| doc | `doc-vitest.yml` | 29, 20s | 1, 26s |
| slide | `slide-bundle.yml` | 18, 1m09s | 13, 7m50s |
| slide | `slide-rust.yml` | 20, 1m05s | 13, 7m29s |
| web | `web-rust.yml` | 16, 45s | 15, 5m04s |
| web | `web-vitest.yml` | 30, 3m31s | 13, 5m37s |
| server | `server-rust.yml` | 0, — | 11, 1m27s |
| moon | `moon.yml` | 0, — | 9, 17m05s |

**Median pull-request test wall time (the T4 "before").** Over the 26 monorepo pull-request
heads with at least one green test workflow, the slowest green test workflow took a median of
29m53s. The monorepo medians above come from today's migration pull requests: new branches with
cold or partial caches and up to 25 workflows queuing at once. They are A10's "before", not a
like-for-like comparison with the old repositories.

Notes:

- **Core runs its tests three times.** `check + test` (Ubuntu and macOS) run `cargo test`:
  3,032 tests, with cargo reporting 18m (Ubuntu) and 17m (macOS) of sequential test-binary
  time. `nextest evidence` runs 3,031 of the same tests again in 15m of nextest time, for the
  JUnit.
- **Image's three Rust lanes run the same 1,192 tests.** The lavapipe lane needs 90s of test
  time, the Metal lane 152s, the `rust engine` lane 10s. The difference is the GPU tests,
  which return at once without an adapter (section 3).
- **Gate steps are not test-runner time.** core `vello on lavapipe` spends 21s in nextest and
  15m in the CPU ↔ Vello parity step; core `corpus diff` spends 3s in its one test and the
  rest in the fidelity gate.
- **Editor Playwright build.** Of each shard's 49–57 minutes, about 15 go to building the doc
  and slide plugins from source (a stopgap until they publish) and 33–40 to Playwright.

## 2. Per-test durations (JUnit)

**For T1–T6.** Core is the suite where a handful of tests dominate: its 10 slowest tests take
2,164s together (62% of its summed test time), and the slowest alone is 31% of the nextest
run's wall time. T4 targets them first, by splitting the long digest, invalidation and perf
tests or moving them into a named slow lane, since nextest cannot finish before its longest
test does. data, slide and the Vello
lane have the same shape on a small scale (15 of 317, 15 of 72, 13 of 85 tests hold 90% of
their time). Playwright is flat: 974 of 1,234 tests are needed to cover 90% of its time, so
it gets faster only through cheaper per-test setup or more shards.

Sum of test times is the sum of the JUnit `time` of tests that ran. Runners execute in
parallel, so it is not wall time. For vitest, a file's time minus the sum of its tests is
the time spent outside tests (module load, wasm boot, hooks).

| Suite | Run | Tests (ran) | Sum of test times | Top 5 share | Tests holding 90% of the time | Vitest file time not in tests |
|---|---|---|---|---|---|---|
| editor Playwright | old repo | 1268 (1234) | 1h44m | 2% | 974 of 1234 | — |
| core nextest (workspace) | monorepo | 3031 (3031) | 58m11s | 37% | 74 of 3031 | — |
| data vitest | monorepo | 456 (454) | 2m23s | 15% | 50 of 454 | 5s of 2m29s |
| draw vitest | monorepo | 2702 (2668) | 1m59s | 19% | 499 of 2668 | 50s of 2m49s |
| core vello on lavapipe | old repo | 85 (85) | 1m21s | 76% | 13 of 85 | — |
| web vitest | monorepo | 741 (732) | 54s | 21% | 70 of 732 | 3s of 58s |
| image nextest | old repo | 1192 (1192) | 39s | 52% | 589 of 1192 | — |
| sheet nextest | monorepo | 1496 (1496) | 32s | 42% | 756 of 1496 | — |
| slide nextest | monorepo | 72 (72) | 27s | 74% | 15 of 72 | — |
| publish nextest | monorepo | 768 (768) | 25s | 48% | 454 of 768 | — |
| slide vitest | monorepo | 59 (59) | 22s | 35% | 30 of 59 | 0s of 22s |
| data nextest | monorepo | 317 (317) | 22s | 73% | 15 of 317 | — |
| sheet vitest | monorepo | 542 (541) | 22s | 37% | 62 of 541 | 0s of 22s |
| extensions vitest | monorepo | 712 (712) | 15s | 14% | 147 of 712 | 0s of 15s |
| image vitest | old repo | 353 (350) | 7s | 21% | 123 of 350 | 0s of 7s |
| web nextest (web-render) | monorepo | 170 (170) | 6s | 31% | 78 of 170 | — |
| doc nextest | old repo | 176 (176) | 5s | 39% | 107 of 176 | — |
| publish vitest (pdf-bundle) | monorepo | 26 (26) | 1s | 85% | 8 of 26 | 0s of 1s |
| publish vitest (publish-bundle) | monorepo | 13 (13) | 1s | 79% | 9 of 13 | 0s of 1s |
| doc vitest | old repo | 85 (73) | 0s | 26% | 50 of 73 | 0s of 0s |
| core idml-viewer vitest | monorepo | 27 (27) | 0s | 70% | 16 of 27 | — |

### Slowest 30 tests overall

| # | Suite | Test | Time |
|---|---|---|---|
| 1 | core nextest (workspace) | `paged-canvas::digest_gate a_long_docx_story_stays_equal_to_a_cold_build` | 4m40s |
| 2 | core nextest (workspace) | `paged-canvas::virtual_paths every_virtual_row_sets_reads_back_and_undoes` | 4m37s |
| 3 | core nextest (workspace) | `paged-canvas::paint_invalidation a_paint_write_never_leaves_a_stale_text_cache` | 4m20s |
| 4 | core nextest (workspace) | `paged-canvas::digest_gate a_long_widow_controlled_story_stays_equal_to_a_cold_build` | 3m53s |
| 5 | core nextest (workspace) | `paged-perf::perf_budgets an_edit_in_a_growing_story_takes_few_grow_passes` | 3m46s |
| 6 | core nextest (workspace) | `paged-perf::paged_image_blobs saving_again_keeps_the_same_blobs_and_a_replaced_image_swaps_its_blob` | 3m43s |
| 7 | core nextest (workspace) | `paged-cli::repo_digest a_projection_is_the_same_document_to_the_engine` | 3m39s |
| 8 | core nextest (workspace) | `paged-perf::paged_image_blobs a_part_written_before_blobs_still_loads_its_images` | 2m35s |
| 9 | core nextest (workspace) | `paged-canvas::render_effect_sweep every_mutation_renders_what_it_claims_to` | 2m26s |
| 10 | core nextest (workspace) | `paged-perf::perf_budgets a_frame_write_does_no_text_or_image_work` | 2m24s |
| 11 | core nextest (workspace) | `paged-perf::paged_image_blobs a_saved_document_keeps_its_images_as_parts_and_loads_them_back` | 2m19s |
| 12 | core nextest (workspace) | `paged-perf::perf_budgets a_batch_of_edits_rebuilds_once` | 1m42s |
| 13 | core nextest (workspace) | `paged-perf::perf_budgets a_keystroke_does_only_layout_work` | 1m38s |
| 14 | core nextest (workspace) | `paged-perf::perf_budgets loading_hashes_the_fonts_about_once` | 1m37s |
| 15 | editor Playwright | `plugin-surface/draw.spec.ts › plugin surface · paged.draw › no declared command throws when invoked from the …` | 1m11s |
| 16 | core nextest (workspace) | `paged-cli::session_compat run_script_keeps_the_shipped_two_second_budget` | 45s |
| 17 | core nextest (workspace) | `paged-canvas::grow_estimate a_page_adding_paste_grows_like_a_cold_build` | 41s |
| 18 | core nextest (workspace) | `paged-canvas::digest_gate span_columns_stays_equal_to_a_cold_build` | 40s |
| 19 | core nextest (workspace) | `paged-canvas::render_effect_sweep every_property_path_renders_what_it_claims_to` | 40s |
| 20 | core nextest (workspace) | `paged-canvas::virtual_paths null_clears_every_nullable_text_enum_and_ref_row` | 38s |
| 21 | core nextest (workspace) | `paged-canvas::digest_gate docx_pagination_stays_equal_to_a_cold_build` | 30s |
| 22 | editor Playwright | `live-scripts.spec.ts › live script draw-live runs to the end hands-free [chromium]` | 30s |
| 23 | core nextest (workspace) | `paged-canvas::digest_gate variables_stay_equal_to_a_cold_build` | 28s |
| 24 | editor Playwright | `plugin-surface/draw.spec.ts › plugin surface · paged.draw › compound path and the six remaining pathfinder op…` | 21s |
| 25 | core nextest (workspace) | `paged-canvas::digest_gate widow_control_on_a_growing_chain_stays_equal_to_a_cold_build` | 21s |
| 26 | editor Playwright | `e2e/capability-matrix.spec.ts › AC-E2E-CAPS — every wire op's engine support matches the table [chromium]` | 19s |
| 27 | core nextest (workspace) | `paged-canvas::digest_gate reflow_grows_and_stays_equal_to_a_cold_build` | 18s |
| 28 | editor Playwright | `journey/plugins/draw-pathops.journey.spec.ts › journey · paged.draw path ops › a designer runs pathfinder boo…` | 17s |
| 29 | core vello on lavapipe | `paged-gpu vello_rs::tests::a_blend_group_cuts_at_its_bounds_in_both_back_ends` | 17s |
| 30 | core nextest (workspace) | `paged-canvas::grow_estimate lowering_max_pages_drops_the_pages_already_grown` | 16s |

### Slowest 10 per suite

<details><summary>editor Playwright: slowest 10 (1h44m summed)</summary>

| Test | Time |
|---|---|
| `plugin-surface/draw.spec.ts › plugin surface · paged.draw › no declared command throws when invoked from the …` | 70.66s |
| `live-scripts.spec.ts › live script draw-live runs to the end hands-free [chromium]` | 29.53s |
| `plugin-surface/draw.spec.ts › plugin surface · paged.draw › compound path and the six remaining pathfinder op…` | 21.31s |
| `e2e/capability-matrix.spec.ts › AC-E2E-CAPS — every wire op's engine support matches the table [chromium]` | 18.75s |
| `journey/plugins/draw-pathops.journey.spec.ts › journey · paged.draw path ops › a designer runs pathfinder boo…` | 17.14s |
| `journey/plugins/sheet-edit-persist.journey.spec.ts › journey · paged.sheet edit persistence › the edited work…` | 15.47s |
| `plugin-surface/draw.spec.ts › plugin surface · paged.draw › close path, radial gradient, opacity mask and tex…` | 15.23s |
| `e2e/real-doc-smoke.spec.ts › AC-E2E-SMOKE-sample — core op pass lands on the canvas [chromium]` | 15.03s |
| `journey/plugins/sheet-edit-persist.journey.spec.ts › journey · paged.sheet edit persistence › an in-frame edi…` | 14.24s |
| `journey/plugins/web-edit-persist.journey.spec.ts › journey · paged.web edit persistence › a saved source surv…` | 12.97s |

</details>

<details><summary>core nextest (workspace): slowest 10 (58m11s summed)</summary>

| Test | Time |
|---|---|
| `paged-canvas::digest_gate a_long_docx_story_stays_equal_to_a_cold_build` | 279.83s |
| `paged-canvas::virtual_paths every_virtual_row_sets_reads_back_and_undoes` | 277.27s |
| `paged-canvas::paint_invalidation a_paint_write_never_leaves_a_stale_text_cache` | 260.06s |
| `paged-canvas::digest_gate a_long_widow_controlled_story_stays_equal_to_a_cold_build` | 233.24s |
| `paged-perf::perf_budgets an_edit_in_a_growing_story_takes_few_grow_passes` | 226.27s |
| `paged-perf::paged_image_blobs saving_again_keeps_the_same_blobs_and_a_replaced_image_swaps_its_blob` | 222.75s |
| `paged-cli::repo_digest a_projection_is_the_same_document_to_the_engine` | 219.40s |
| `paged-perf::paged_image_blobs a_part_written_before_blobs_still_loads_its_images` | 155.30s |
| `paged-canvas::render_effect_sweep every_mutation_renders_what_it_claims_to` | 146.31s |
| `paged-perf::perf_budgets a_frame_write_does_no_text_or_image_work` | 143.56s |

</details>

<details><summary>data vitest: slowest 10 (2m23s summed)</summary>

| Test | Time |
|---|---|
| `test/sources-persist-real-core.spec.ts > imported files saved with the document, real core + engine + DuckDB …` | 5.39s |
| `test/films-real-core.spec.ts > the films' data scenes, real core + engine + DuckDB [data.plugin.bundle] > DAT…` | 4.45s |
| `test/perf/perf-budgets-boot.spec.ts > perf budgets — boot and reflow [data.perf.gates] > W7 activates without…` | 4.35s |
| `test/persist-real-core.spec.ts > session persistence through a saved .paged, real core + engine + DuckDB [dat…` | 4.17s |
| `test/protocol71-real-core.spec.ts > engine protocol 71: text variables, creates in the batch, cell addresses …` | 3.79s |
| `test/persist-real-core.spec.ts > session persistence through a saved .paged, real core + engine + DuckDB [dat…` | 3.71s |
| `test/persist-real-core.spec.ts > session persistence through a saved .paged, real core + engine + DuckDB [dat…` | 3.64s |
| `test/perf/perf-budgets-merge.spec.ts > perf budgets — Data Merge [data.perf.gates] > W8 merges 57 records, tw…` | 3.54s |
| `test/films-real-core.spec.ts > the films' data scenes, real core + engine + DuckDB [data.plugin.bundle] > DAT…` | 3.51s |
| `test/protocol71-real-core.spec.ts > engine protocol 71: text variables, creates in the batch, cell addresses …` | 3.49s |

| Test file | File time | In tests | Outside tests |
|---|---|---|---|
| `test/property-real-core.spec.ts` | 22.0s | 22.0s | 0.0s |
| `test/persist-real-core.spec.ts` | 18.6s | 18.6s | 0.0s |
| `test/protocol71-real-core.spec.ts` | 13.9s | 13.9s | 0.0s |
| `test/films-real-core.spec.ts` | 11.2s | 11.2s | 0.0s |
| `test/duckdb-browser.spec.ts` | 10.9s | 8.0s | 2.9s |

</details>

<details><summary>draw vitest: slowest 10 (1m59s summed)</summary>

| Test | Time |
|---|---|
| `test/conformance/svg-io.spec.ts > draw conformance — SVG import/export (Phase 8, K-2) > FIXED (C-79): a batch…` | 9.62s |
| `test/perf/perf-budgets-io.spec.ts > perf budgets — interchange > SVG import — a 50-shape file into a 500-shap…` | 4.84s |
| `test/perf/perf-budgets-region.spec.ts > perf budgets — the tools that read as they move > Shape Builder — a 1…` | 4.19s |
| `test/perf/perf-budgets-region.spec.ts > perf budgets — the tools that read as they move > Shape Builder — a 1…` | 1.96s |
| `test/perf/perf-budgets-region.spec.ts > perf budgets — the tools that read as they move > Shape Builder — a 1…` | 1.67s |
| `test/perf/perf-budgets-freehand.spec.ts > perf budgets — the freehand tools > pencil / paintbrush / blob brus…` | 1.31s |
| `test/polygon.spec.ts > flattenAnchorPath + pointInFlatPath > 'a circle and a far square, one table': the flat…` | 1.06s |
| `test/polygon.spec.ts > flattenAnchorPath + pointInFlatPath > 'a circle': the flat form answers exactly what t…` | 0.97s |
| `test/conformance/shape-builder-regions.spec.ts > Shape Builder on a cross-shaped overlap — the regions it doe…` | 0.97s |
| `test/polygon.spec.ts > flattenAnchorPath + pointInFlatPath > 'a circle a million points out': the flat form a…` | 0.96s |

| Test file | File time | In tests | Outside tests |
|---|---|---|---|
| `test/perf/perf-budgets-commands.spec.ts` | 14.0s | 5.0s | 8.9s |
| `test/perf/perf-budgets-region.spec.ts` | 12.0s | 11.0s | 1.0s |
| `test/conformance/svg-io.spec.ts` | 10.6s | 10.1s | 0.4s |
| `test/perf/perf-budgets-freehand.spec.ts` | 8.1s | 6.5s | 1.7s |
| `test/perf/perf-budgets-io.spec.ts` | 5.8s | 5.2s | 0.6s |

</details>

<details><summary>core vello on lavapipe: slowest 10 (1m21s summed)</summary>

| Test | Time |
|---|---|
| `paged-gpu vello_rs::tests::a_blend_group_cuts_at_its_bounds_in_both_back_ends` | 16.93s |
| `paged-gpu vello_rs::tests::dashed_strokes_leave_their_gaps` | 14.89s |
| `paged-gpu vello_rs::tests::drop_shadows_match_the_cpu_lane` | 13.38s |
| `paged-gpu vello_rs::tests::a_blend_group_inside_masked_content_composites_against_the_page` | 12.26s |
| `paged-gpu vello_rs::tests::soft_mask_matches_the_cpu_rasterizer_for_every_mode` | 4.80s |
| `paged-gpu vello_rs::tests::vello_no_overprint_unchanged_vs_baseline` | 2.43s |
| `paged-gpu vello_rs::tests::vello_cmyk_overprint_cyan_on_magenta_produces_blue` | 1.40s |
| `paged-gpu vello_rs::tests::vello_k_overprint_passes_through_rgb_image` | 1.31s |
| `paged-gpu vello_rs::tests::vello_spot_packing_at_5_spots` | 1.29s |
| `paged-gpu vello_rs::tests::vello_spot_on_spot_same_ink_max_tints` | 1.28s |

</details>

<details><summary>web vitest: slowest 10 (54s summed)</summary>

| Test | Time |
|---|---|
| `test/perf/perf-budgets.spec.ts > web perf budgets (real host + real Blitz) > 1000 document changes with the p…` | 3.77s |
| `test/conformance/baked-faces-reopen.spec.ts > web conformance — the faces a bake gave the document come back …` | 2.97s |
| `test/perf/perf-budgets.spec.ts > web perf budgets (real host + real Blitz) > bake a frame of 200 text runs to…` | 1.89s |
| `test/conformance/bake-faces.spec.ts > web conformance — baked text names a face the document can draw > the f…` | 1.48s |
| `test/conformance/baked-faces-reopen.spec.ts > web conformance — the faces a bake gave the document come back …` | 1.46s |
| `test/conformance/scene-faces.spec.ts > web conformance — scene-layer faces (real host + real Blitz) > a CSS f…` | 1.45s |
| `test/conformance/bake.spec.ts > web conformance — bake to native content (real host + real Blitz) > bakes the…` | 1.45s |
| `test/conformance/baked-faces-reopen.spec.ts > web conformance — the faces a bake gave the document come back …` | 1.44s |
| `test/flow-properties.spec.ts > fragmentation conserves text (real engine, fast-check) > paragraphs: frames in…` | 1.40s |
| `test/conformance/bake-faces.spec.ts > web conformance — baked text names a face the document can draw > a flo…` | 1.37s |

| Test file | File time | In tests | Outside tests |
|---|---|---|---|
| `test/perf/perf-budgets.spec.ts` | 6.9s | 6.5s | 0.4s |
| `test/conformance/auto-render.spec.ts` | 6.8s | 6.8s | 0.0s |
| `test/conformance/baked-faces-reopen.spec.ts` | 5.9s | 5.9s | 0.0s |
| `test/conformance/bake-faces.spec.ts` | 5.5s | 5.5s | 0.0s |
| `test/conformance/in-frame-edit.spec.ts` | 4.4s | 4.4s | 0.0s |

</details>

<details><summary>image nextest: slowest 10 (39s summed)</summary>

| Test | Time |
|---|---|
| `image-conformance::oracle_photoshop defects_reach_agreement__feat__image_conformance_harness` | 5.26s |
| `image-conformance::oracle_photoshop every_photoshop_case_holds_its_ledger_row__feat__image_conformance_harness` | 5.23s |
| `image-conformance::psd_cmyk_photoshop a_cmyk_psd_opens_converted_through_its_profile__feat__image_cms_print` | 4.88s |
| `image-conformance::psd_cmyk_photoshop our_ink_transform_matches_photoshops_default_cmyk_view__feat__image_cms…` | 3.49s |
| `image-kernels::conv_shape conv_shape_identity_predicate_is_sound` | 1.23s |
| `image-cms::cmyk_lane image_cms_cmyk_lane_moxcms_lcms2_oracle_per_channel` | 0.94s |
| `image-cms::cmyk_lane image_cms_cmyk_lane_moxcms_intents_not_ignored` | 0.71s |
| `image-kernels::wgsl_validate every_kernel_assembles_to_valid_wgsl` | 0.70s |
| `image-cms::cmyk_lane image_cms_cmyk_lane_moxcms_bpc_documented_inert` | 0.70s |
| `image-conformance::psd_cmyk_photoshop a_transparent_cmyk_composite_is_unmatted_against_paper__feat__image_psd…` | 0.37s |

</details>

<details><summary>sheet nextest: slowest 10 (32s summed)</summary>

| Test | Time |
|---|---|
| `sheet-conformance::zip_container_bytes every_saved_entry_has_the_pinned_headers__feat__sheet_xlsx_roundtrip` | 3.76s |
| `sheet-conformance::xlsx_recalc_corpus xlsx_recalc_matches_excel_cached_values_ci_subset__feat__sheet_calc_eng…` | 3.29s |
| `sheet-calc::perf_budgets perf_running_total_edit_head__feat__sheet_calc_engine` | 2.88s |
| `sheet-conformance::xlsx_roundtrip_prop xlsx_write_read_is_identity__feat__sheet_xlsx_roundtrip` | 1.75s |
| `sheet-calc::perf_budgets perf_running_total_edit_tail__feat__sheet_calc_engine` | 1.57s |
| `sheet-calc::perf_budgets perf_running_total_build__feat__sheet_calc_engine` | 1.54s |
| `sheet-calc::perf_budgets perf_running_total_build_batched__feat__sheet_calc_engine` | 1.51s |
| `sheet-calc::perf_budgets perf_insert_row__feat__sheet_calc_engine` | 0.76s |
| `sheet-calc::perf_budgets perf_vlookup_edit_table__feat__sheet_calc_engine` | 0.71s |
| `sheet-parser tests::prop::structured_ref_parse_print_is_fixpoint` | 0.62s |

</details>

<details><summary>slide nextest: slowest 10 (27s summed)</summary>

| Test | Time |
|---|---|
| `pptx-fonts::fixtures corrupted_parts_fail_cleanly` | 13.65s |
| `pptx-fonts lzcomp::tests::hostile_blocks_fail_without_panicking` | 2.69s |
| `pptx-import::embedded_fonts the_least_restrictive_licence_bit_wins_and_editable_faces_are_used` | 1.96s |
| `pptx-import::embedded_fonts every_face_powerpoint_embedded_is_decoded_for_the_document` | 0.87s |
| `pptx-import::embedded_fonts a_bare_truetype_part_is_used_as_it_is` | 0.65s |
| `slide-resolve::oracle_tables table_style_borders_resolve_as_powerpoint_draws_them` | 0.63s |
| `slide-resolve::oracle_tables built_in_table_styles_resolve_as_powerpoint_draws_them` | 0.56s |
| `pptx-export::roundtrip reorder_duplicate_delete_hide_and_notes_read_back` | 0.54s |
| `pptx-fonts::fixtures subset_faces_hold_their_source_glyphs_for_the_decks_text` | 0.53s |
| `pptx-import::embedded_fonts a_face_that_cannot_be_read_is_named_with_the_reason` | 0.51s |

</details>

<details><summary>publish nextest: slowest 10 (25s summed)</summary>

| Test | Time |
|---|---|
| `idml-export::format_f32_precision the_emitted_spelling_reparses_to_the_same_f32_above_the_wall` | 3.95s |
| `idml-coverage tests::idml_coverage_ratchet` | 3.68s |
| `idml-coverage tests::idml_coverage_json_is_current` | 3.60s |
| `idml-export::indesign_styles_untouched a_text_edit_rewrites_the_story_and_leaves_the_styles_part_untouched` | 0.43s |
| `idml-export::indesign_styles_untouched an_unmutated_save_leaves_the_styles_part_byte_identical` | 0.43s |
| `idml-export::indesign_styles_untouched the_model_reads_the_style_s_tab_stops` | 0.34s |
| `idml-export::indesign_canonical indesigns_own_package_round_trips_every_entry_byte_identically` | 0.25s |
| `idml-export::table_replaced_in_story a_table_swapped_on_its_paragraph_in_a_checkpointed_minted_story_is_the_o…` | 0.24s |
| `idml-export::indesign_canonical a_story_edit_in_indesigns_package_keeps_the_story_tag_inks_and_preferences` | 0.24s |
| `idml-export::zip_layout unmutated_indesign_package_saves_as_with_zip2` | 0.22s |

</details>

<details><summary>slide vitest: slowest 10 (22s summed)</summary>

| Test | Time |
|---|---|
| `test/object-model.spec.ts > [plugin-slide.object-model] slides, layouts, placeholders through host.objects > …` | 2.07s |
| `test/object-model-page-labels.spec.ts > [plugin-slide.object-model] slide data on page labels (protocol 70) >…` | 1.55s |
| `test/conformance.spec.ts > a deck's embedded fonts > fonts-full: its text is set in the faces it embeds, not …` | 1.51s |
| `test/conformance.spec.ts > fixture geometry in the engine > opens a page per slide, each item where the impor…` | 1.40s |
| `test/object-model.spec.ts > [plugin-slide.object-model] slides, layouts, placeholders through host.objects > …` | 1.25s |
| `test/conformance.spec.ts > a deck's embedded fonts > fonts: its text is set in the faces it embeds, not subst…` | 1.07s |
| `test/panels.spec.ts > [plugin-slide.object-model] property rows, headless > activate contributes the five sch…` | 0.99s |
| `test/object-model.spec.ts > [plugin-slide.object-model] slides, layouts, placeholders through host.objects > …` | 0.79s |
| `test/export.spec.ts > PPTX export > writes the original bytes back when nothing changed` | 0.78s |
| `test/slides-model.spec.ts > the slides store on the engine > lists the slides with their transitions` | 0.70s |

| Test file | File time | In tests | Outside tests |
|---|---|---|---|
| `test/object-model.spec.ts` | 6.5s | 6.5s | 0.0s |
| `test/conformance.spec.ts` | 5.4s | 5.3s | 0.0s |
| `test/object-model-page-labels.spec.ts` | 3.8s | 3.8s | 0.0s |
| `test/slides-model.spec.ts` | 2.2s | 2.2s | 0.0s |
| `test/export.spec.ts` | 2.0s | 2.0s | 0.0s |

</details>

<details><summary>data nextest: slowest 10 (22s summed)</summary>

| Test | Time |
|---|---|
| `data-conformance::oracle_props data_prop_qr_decodes_back__feat__data_barcode_symbology` | 7.94s |
| `data-barcode qr::tests::data_barcode_qr_every_version_and_mask_decodes` | 4.89s |
| `data-conformance::perf_props data_perf_prop_incremental_report_equals_full` | 1.53s |
| `data-conformance::properties data_prop_barcode_qr_total_and_deterministic` | 1.32s |
| `data-conformance::perf_props data_perf_prop_record_n_is_delivery_order_free` | 0.70s |
| `data-conformance::perf_props data_perf_prop_group_by_matches_linear_scan` | 0.55s |
| `data-conformance::perf_props data_perf_prop_stabilize_permutation_invariant` | 0.52s |
| `data-conformance::perf_props data_perf_prop_order_rows_matches_reference` | 0.46s |
| `data-conformance::oracle_props data_prop_payload_round_trips__feat__data_plugin_bundle` | 0.40s |
| `data-conformance::oracle_props data_prop_refresh_and_resolve_are_idempotent__feat__data_bind_change_report` | 0.40s |

</details>

<details><summary>sheet vitest: slowest 10 (22s summed)</summary>

| Test | Time |
|---|---|
| `test/engine-real.spec.ts > real engine boot (wasm artifact) > rejects an oversize lowered range and stays usa…` | 2.63s |
| `test/session-document-open.spec.ts > the workbook follows the open document [sheet.plugin.persistence] > an e…` | 1.82s |
| `test/perf/perf-budgets.spec.ts > perf budgets — work counted at the doors > place a 50×20 range as a native t…` | 1.71s |
| `test/perf/perf-budgets.spec.ts > perf budgets — work counted at the doors > place a 50×20 range on a protocol…` | 1.07s |
| `test/host-undo.spec.ts > host undo reaches the workbook [sheet.edit.undo] > a session's edits refresh the pag…` | 0.96s |
| `test/chain-gesture-reflow.spec.ts > a paginated range follows a handle resize [sheet.lower.paginate] > rows m…` | 0.94s |
| `test/object-model.spec.ts > paged.sheet object model [sheet.objects] > contributes the seven kinds, each with…` | 0.75s |
| `test/session-wave9.spec.ts > wave 9 — placed-table refresh > a refresh is ONE document undo step: binding and…` | 0.65s |
| `test/lower-fit.spec.ts > a placed table range is sized to its rows > A1:D7 of the price list shows every row,…` | 0.64s |
| `test/chain-gesture-reflow.spec.ts > a paginated range follows a handle resize [sheet.lower.paginate] > a move…` | 0.52s |

| Test file | File time | In tests | Outside tests |
|---|---|---|---|
| `test/perf/perf-budgets.spec.ts` | 4.6s | 4.6s | 0.0s |
| `test/object-model.spec.ts` | 3.7s | 3.6s | 0.0s |
| `test/engine-real.spec.ts` | 2.8s | 2.8s | 0.0s |
| `test/session-wave9.spec.ts` | 2.6s | 2.6s | 0.0s |
| `test/session-document-open.spec.ts` | 2.4s | 2.4s | 0.0s |

</details>

<details><summary>extensions vitest: slowest 10 (15s summed)</summary>

| Test | Time |
|---|---|
| `test/object-model-fixups.spec.ts > 1 — the plugin-level batch: two kinds, one state > ops on two kinds of one…` | 0.49s |
| `test/object-model-v71.spec.ts > protocol 71 — every core address kind round-trips Set / Get > one representat…` | 0.44s |
| `test/object-model.spec.ts > host.objects — registry over core and a plugin (ADR 323, real engine) > kinds() l…` | 0.42s |
| `test/assets-document-font.spec.ts > host.assets.registerDocumentFont on the real engine (headless harness) > …` | 0.37s |
| `test/documents-measure-doors.spec.ts > headless host — documents + measureStrings over the real engine > expo…` | 0.35s |
| `test/document-metadata.spec.ts > host.document document metadata — against the real engine > is one undoable …` | 0.34s |
| `test/object-model-created.spec.ts > created[] for plugin creates (ADR 323) > a plugin create answers its new …` | 0.32s |
| `test/headless-overset.spec.ts > headless overset needs the default font (D-28) > without a font nothing is la…` | 0.32s |
| `test/object-model-core.spec.ts > core seam — virtual paths over today's ops > story content: set replaces the…` | 0.32s |
| `test/document-font-lifetime.spec.ts > a document face lives as long as its document (ADR 330, headless host) …` | 0.29s |

| Test file | File time | In tests | Outside tests |
|---|---|---|---|
| `test/capability-manifest-cli.spec.ts` | 1.8s | 1.8s | 0.0s |
| `test/harness.spec.ts` | 1.2s | 1.2s | 0.0s |
| `test/object-model-fixups.spec.ts` | 1.1s | 1.1s | 0.0s |
| `test/object-model-v71.spec.ts` | 0.9s | 0.9s | 0.0s |
| `test/object-model.spec.ts` | 0.9s | 0.9s | 0.0s |

</details>

<details><summary>image vitest: slowest 10 (7s summed)</summary>

| Test | Time |
|---|---|
| `test/object-model.spec.ts > the object model on the real plugin, headless > registers five kinds with schemas…` | 0.49s |
| `test/object-model-manifest.spec.ts > the manifest's object model is the registered one > declares every regis…` | 0.27s |
| `test/object-model.spec.ts > the object model on the real plugin, headless > the stored stack reopens from the…` | 0.26s |
| `test/preview.spec.ts > live preview > a slider burst previews on ONE proxy, at most twice, then once at full …` | 0.21s |
| `test/cube.spec.ts > .cube > an identity table of any size resamples to the identity cube` | 0.20s |
| `test/adjust-ext.spec.ts > the save-back lane (real engine wasm) > registers the three save-back exporters` | 0.14s |
| `test/persist.spec.ts > commit to the document, and reopen > stores the layers, bakes the composite into the f…` | 0.13s |
| `test/type.spec.ts > the raster type lane > asks the FACE DOOR for the style, and reports what came back` | 0.13s |
| `test/object-model.spec.ts > the object model on the real plugin, headless > layers, adjustment layers, masks …` | 0.13s |
| `test/object-model.spec.ts > the object model on the real plugin, headless > pixel replacement: bytes, a data:…` | 0.12s |

| Test file | File time | In tests | Outside tests |
|---|---|---|---|
| `test/object-model.spec.ts` | 1.7s | 1.6s | 0.1s |
| `test/adjust-ext.spec.ts` | 0.6s | 0.6s | 0.0s |
| `test/preview.spec.ts` | 0.3s | 0.3s | 0.0s |
| `test/object-model-manifest.spec.ts` | 0.3s | 0.3s | 0.0s |
| `test/persist.spec.ts` | 0.3s | 0.3s | 0.0s |

</details>

<details><summary>web nextest (web-render): slowest 10 (6s summed)</summary>

| Test | Time |
|---|---|
| `web-render::chrome_parity chrome_parity_text__feat__plugin_web_chrome_parity` | 0.45s |
| `web-render::chrome_parity chrome_parity_inline__feat__plugin_web_chrome_parity` | 0.38s |
| `web-render::flow_parity flow_parity_with_chrome_fragmentation__feat__plugin_web_flow_fragmentation` | 0.38s |
| `web-render::chrome_parity chrome_parity_lists__feat__plugin_web_chrome_parity` | 0.28s |
| `web-render::chrome_parity chrome_parity_multicol__feat__plugin_web_chrome_parity` | 0.28s |
| `web-render::chrome_parity chrome_parity_headings__feat__plugin_web_chrome_parity` | 0.26s |
| `web-render::chrome_parity chrome_parity_table__feat__plugin_web_chrome_parity` | 0.23s |
| `web-render::chrome_parity chrome_parity_flex__feat__plugin_web_chrome_parity` | 0.23s |
| `web-render::chrome_parity chrome_parity_blocks__feat__plugin_web_chrome_parity` | 0.23s |
| `web-render::chrome_parity chrome_parity_grid__feat__plugin_web_chrome_parity` | 0.21s |

</details>

<details><summary>doc nextest: slowest 10 (5s summed)</summary>

| Test | Time |
|---|---|
| `docx-conformance::line_spacing an_unmeasured_face_is_named_in_a_diagnostic__feat__plugin_doc_read_path` | 0.59s |
| `docx-conformance::line_spacing the_lowered_pitch_reproduces_words_lines_per_page__feat__plugin_doc_read_path` | 0.59s |
| `docx-conformance::line_spacing every_case_lowers_to_the_pitch_word_laid__feat__plugin_doc_read_path` | 0.58s |
| `docx-skeleton::skeleton continuous_sections_share_the_story_of_the_page_they_continue` | 0.09s |
| `docx-skeleton::skeleton the_package_is_deterministic` | 0.08s |
| `docx-conformance::columns the_lowering_reproduces_words_column_changes__feat__plugin_doc_word_pagination` | 0.07s |
| `docx-conformance::continuous the_lowering_reproduces_words_page_map__feat__plugin_doc_word_pagination` | 0.06s |
| `docx-conformance::columns column_changes_lower_to_span_and_split_columns__feat__plugin_doc_word_pagination` | 0.06s |
| `docx-conformance::headers a_body_edit_leaves_every_header_footer_and_settings_part_byte_identical__feat__plug…` | 0.06s |
| `docx-conformance::columns without_span_columns_each_change_opens_a_page__feat__plugin_doc_word_pagination` | 0.05s |

</details>

<details><summary>publish vitest (pdf-bundle): slowest 10 (1s summed)</summary>

| Test | Time |
|---|---|
| `test/commands.spec.ts > [plugin-pdf.typed-commands] importPdf as a typed command > is listed with the schema …` | 0.30s |
| `test/commands.spec.ts > [plugin-pdf.typed-commands] importPdf as a typed command > opens a PDF as an editable…` | 0.21s |
| `test/commands.spec.ts > [plugin-pdf.typed-commands] importPdf as a typed command > the image path needs a can…` | 0.12s |
| `test/idml-fallback.test.ts > buildIdmlFromRasters > designmap lists one spread per page; one Spreads/*.xml pe…` | 0.05s |
| `test/idml-fallback.test.ts > buildIdmlFromRasters > emits mimetype first, STORED, with exact bytes (OCF conve…` | 0.04s |
| `test/commands.spec.ts > [plugin-pdf.typed-commands] importPdf as a typed command > honours the page cap` | 0.02s |
| `test/commands.spec.ts > [plugin-pdf.typed-commands] partial args: struct defaults and optional fields (SDK 0.…` | 0.02s |
| `test/commands.spec.ts > [plugin-pdf.typed-commands] partial args: struct defaults and optional fields (SDK 0.…` | 0.02s |
| `test/commands.spec.ts > [plugin-pdf.typed-commands] importPdf as a typed command > refuses args outside the s…` | 0.02s |
| `test/commands.spec.ts > [plugin-pdf.typed-commands] partial args: struct defaults and optional fields (SDK 0.…` | 0.02s |

| Test file | File time | In tests | Outside tests |
|---|---|---|---|
| `test/commands.spec.ts` | 0.7s | 0.7s | 0.0s |
| `test/idml-fallback.test.ts` | 0.1s | 0.1s | 0.0s |
| `test/extract.test.ts` | 0.0s | 0.0s | 0.0s |

</details>

<details><summary>publish vitest (publish-bundle): slowest 10 (1s summed)</summary>

| Test | Time |
|---|---|
| `test/commands.spec.ts > [plugin-publish.typed-commands] import and export as typed commands > lists four type…` | 0.24s |
| `test/commands.spec.ts > [plugin-publish.typed-commands] import and export as typed commands > exportIdml and …` | 0.19s |
| `test/commands.spec.ts > [plugin-publish.typed-commands] import and export as typed commands > the File ▸ Expo…` | 0.06s |
| `test/commands.spec.ts > [plugin-publish.typed-commands] partial args: struct defaults and optional fields (SD…` | 0.05s |
| `test/commands.spec.ts > [plugin-publish.typed-commands] import and export as typed commands > importIdml open…` | 0.03s |
| `test/commands.spec.ts > [plugin-publish.typed-commands] import and export as typed commands > exportPdf with …` | 0.02s |
| `test/commands.spec.ts > [plugin-publish.typed-commands] partial args: struct defaults and optional fields (SD…` | 0.02s |
| `test/commands.spec.ts > [plugin-publish.typed-commands] partial args: struct defaults and optional fields (SD…` | 0.02s |
| `test/commands.spec.ts > [plugin-publish.typed-commands] import and export as typed commands > refuses args ou…` | 0.02s |
| `test/commands.spec.ts > [plugin-publish.typed-commands] partial args: struct defaults and optional fields (SD…` | 0.02s |

| Test file | File time | In tests | Outside tests |
|---|---|---|---|
| `test/commands.spec.ts` | 0.7s | 0.7s | 0.0s |

</details>

<details><summary>doc vitest: slowest 10 (0s summed)</summary>

| Test | Time |
|---|---|
| `test/blank-lines.spec.ts > blank lines > are styled by a caret each, after the text, naming their paragraph` | 0.01s |
| `test/columns-fallback.spec.ts > openStandalone and span/split columns > reopens with page breaks when the eng…` | 0.01s |
| `test/columns-fallback.spec.ts > openStandalone and span/split columns > keeps the span/split lowering on an e…` | 0.00s |
| `test/mutations.spec.ts > a table that flows as text > pours its paragraphs with the text around it, and inser…` | 0.00s |
| `test/mutations.spec.ts > buildStyleMutations > emits swatch, then create + setStyleProperty per style, parent…` | 0.00s |
| `test/style-fallback.spec.ts > applyStyleOps > applies the catalog as one batch when the engine takes it` | 0.00s |
| `test/activate.spec.ts > paged.doc — the declared surface (ADR 024) > enters by double-click, like every other…` | 0.00s |
| `test/outline-model.spec.ts > outlineEntries > detects headings by style id AND by style name, tables in order` | 0.00s |
| `test/menu.spec.ts > doc menu entries > every entry points at a command the manifest declares` | 0.00s |
| `test/run-location.spec.ts > bodyRunLocation > counts native paragraphs: segments and table hosts each take one` | 0.00s |

| Test file | File time | In tests | Outside tests |
|---|---|---|---|
| `test/mutations.spec.ts` | 0.0s | 0.0s | 0.0s |
| `test/activate.spec.ts` | 0.0s | 0.0s | 0.0s |
| `test/columns-fallback.spec.ts` | 0.0s | 0.0s | 0.0s |
| `test/grow-rules.spec.ts` | 0.0s | 0.0s | 0.0s |
| `test/menu.spec.ts` | 0.0s | 0.0s | 0.0s |

</details>

<details><summary>core idml-viewer vitest: slowest 10 (0s summed)</summary>

| Test | Time |
|---|---|
| `test/camera.test.ts > zoomAt > keeps the doc point under the anchor fixed (invariance)` | 0.01s |
| `test/api-catalog.test.ts > api-catalog.json > has well-formed members (name + signature + summary)` | 0.01s |
| `test/viewer.test.ts > load > binds, lays out, fits page 0 and emits loaded` | 0.00s |
| `test/viewer.test.ts > load > maps parse failures to ViewerError PARSE_ERROR and emits error` | 0.00s |
| `test/api-catalog.test.ts > api-catalog.json > documents every export of src/index.ts` | 0.00s |
| `test/viewer.test.ts > camera surface > zoomChanged/scrollChanged fire once per change` | 0.00s |
| `test/viewer.test.ts > pages > goToPage scrolls the page into view and emits pageChanged` | 0.00s |
| `test/camera.test.ts > currentPageAt > falls back to the nearest band inside a gap` | 0.00s |
| `test/viewer.test.ts > pages > scrolling continuous mode derives the current page` | 0.00s |
| `test/viewer.test.ts > dispose > detaches input, clears listeners, frees the session` | 0.00s |

| Test file | File time | In tests | Outside tests |
|---|---|---|---|
| `test/api-catalog.test.ts` | 0.0s | 0.0s | 0.0s |
| `test/camera.test.ts` | 0.0s | 0.0s | 0.0s |
| `test/viewer.test.ts` | 0.0s | 0.0s | 0.0s |

</details>

## 3. Skips

**For T3.** Three kinds of skip need different work:

1. **Silent skips (322 tests): T3's first target.** These tests return early and report
   "passed". 232 are image GPU tests: the image `rust engine` lane and the `publish-state`
   nextest evidence (the JUnit Cockpit reads for image) run them on a runner with no adapter.
   In that JUnit the 232 take 2.5s together (median 9ms, max 48ms); the same tests need about
   80s more on the lavapipe lane. The corpus and font cases skip wherever the private corpus
   is not mounted. 215 of the 313 Rust cases print a skip line, which nobody sees, because
   cargo and nextest capture the output of passing tests.
2. **Honest conditional skips** (`describe.skipIf`, `it.runIf`, `ctx.skip`, Playwright
   `test.skip`/`test.fixme`): reported as skipped. The CI skip counts in section 1 are these.
   T3 gives them one `unavailable: <reason>` convention and a `PAGED_REQUIRE_<X>=1` switch.
3. **`#[ignore]` lanes (50 tests):** 40 are opt-in corpus or oracle lanes behind a
   `PAGED_*_CORPUS` variable. T3 turns them into named lanes.

### Silent skips: tests that pass without running

Found by a scan of every `#[test]` function (and every test a `macro_rules!` generates) for a
`return`, a `None => eprintln!(…)` arm or an `if let Some(…) = device()` with no else, whose
guard names a resource. The reason is the first match among GPU / engine wasm / DuckDB / build
output / corpus or fixture / colour profile or font / external tool / env switch. Tests whose
early return is a type guard (`if (!plan.ok) return;` after an `expect`) are not counted; a test
that skips only half of its work (`let have_gpu = …`) is not counted either.

| Module | Missing resource | Tests that pass without running |
|---|---|---|
| apps/server (Rust) | env switch | 6 |
| engine/core (Rust) | GPU adapter | 18 |
| engine/core (Rust) | colour profile / font | 21 |
| engine/core (Rust) | corpus / fixture | 22 |
| engine/core (Rust) | env switch | 3 |
| engine/core (Rust) | external tool | 1 |
| engine/core (Rust) | real engine wasm | 1 |
| modules/image (Rust) | GPU adapter | 232 |
| modules/image (Rust) | build output | 1 |
| modules/image (Rust) | colour profile / font | 2 |
| modules/image (Rust) | env switch | 1 |
| modules/publish (Rust) | env switch | 1 |
| modules/slide (Rust) | corpus / fixture | 4 |
| apps/editor (TS) | colour profile / font | 1 |
| modules/image (TS) | colour profile / font | 2 |
| modules/image (TS) | real engine wasm | 4 |
| platform/extensions (TS) | build output | 2 |

The files with the most silent-skip tests (all files are in the JSON):

| Test file | Silent-skip tests |
|---|---|
| `modules/image/image-conformance/tests/family_adjust.rs` | 30 |
| `modules/image/image-js/src/layers.rs` | 24 |
| `modules/image/image-js/src/stroke.rs` | 19 |
| `engine/core/crates/paged-gpu/src/vello_rs.rs` | 16 |
| `modules/image/image-conformance/tests/family_gen.rs` | 16 |
| `modules/image/image-conformance/tests/family_geom.rs` | 15 |
| `modules/image/image-conformance/tests/brush_stroke.rs` | 14 |
| `modules/image/image-js/tests/ingest.rs` | 13 |
| `modules/image/image-conformance/tests/family_arithmetic.rs` | 9 |
| `modules/image/image-conformance/tests/family_conv.rs` | 9 |
| `modules/image/image-conformance/tests/family_band.rs` | 7 |
| `modules/image/image-conformance/tests/gpu_module_kernels.rs` | 7 |
| `modules/image/image-conformance/tests/family_morph.rs` | 6 |
| `modules/image/image-js/tests/perf_budgets.rs` | 6 |
| `engine/core/crates/paged-canvas/tests/color_settings.rs` | 5 |
| `modules/image/image-conformance/tests/family_minmax.rs` | 5 |
| `engine/core/crates/paged-canvas/tests/font_registry_scan.rs` | 4 |
| `engine/core/crates/paged-export-pdf/tests/export_x4.rs` | 4 |
| `modules/image/image-conformance/tests/selection_mask.rs` | 4 |
| `modules/image/image-conformance/tests/selection_pipeline.rs` | 4 |
| 60 more files | 96 |

Where the resource is missing in CI today:

| Resource | Lanes that run these tests without it | Lanes that have it |
|---|---|---|
| GPU adapter (image) | image `rust engine`, image `publish-state` nextest evidence | image lavapipe and Metal lanes (`REQUIRE_GPU=1`, strict) |
| GPU adapter (core) | none today: the 18 tests compile only with `vello-backend`, which only the lavapipe lane enables, and A5 saw `llvmpipe` there | core `vello on lavapipe`; without an adapter they pass silently (the failure mode of the lane that once "tested nothing") |
| CMYK profile, test font | any lane without the fetched profile or the font file; core CI fetches the profile (`scripts/fetch-profiles.sh`), and a failed fetch degrades to the silent skip with only a warning | core jobs after the fetch |
| Private corpus, source fonts | every Rust and vitest lane | editor Playwright (sparse corpus checkout) |
| env switch (opt-in data) | every lane | none in CI |

### Skipped in CI, and why

The vitest JUnit carries no skip reason; the reason column names the condition in the file.

| Suite | File | Skipped | Reason |
|---|---|---|---|
| editor Playwright | `e2e/character-ops.spec.ts` | 3 | fixme |
| editor Playwright | `e2e/gesture-plan-deferred.spec.ts` | 2 | fixme |
| editor Playwright | `export-family.spec.ts` | 2 | skip |
| editor Playwright | `journey/plugins/image-curves.journey.spec.ts` | 2 | paged.image kernels are GPU-only (no CPU path). This is NOT verified elsewhere in CI: the `journeys-gpu` lane needs rea… |
| editor Playwright | `e2e/export-verification.spec.ts` | 1 | pdftoppm not installed |
| editor Playwright | `e2e/paragraph-ops.spec.ts` | 1 | fixme |
| editor Playwright | `plugin-surface/image.spec.ts` | 1 | paged.image's generators + adjustment bake are GPU-only WGSL (no CPU path); this machine reports no compatible wgpu ada… |
| editor Playwright | `separations-panel.spec.ts` | 1 | no CMYK working profile on this machine — the plate lane has nothing to separate |
| editor Playwright | `text-frame-options-panel.spec.ts` | 1 | column layout ships in the wasm AFTER 0.63.0; the pinned engine cannot render a gutter |
| editor Playwright | `journey/focused/transform-pivot.journey.spec.ts` | 1 | needs a protocol-66 engine (PAGED_REQUIRE_V66=1) |
| editor Playwright | `journey/plugins/data-live-source.journey.spec.ts` | 1 | PAGED_DATA_ORIGINS must list http://localhost:5297 for the dev server (editor ADR 218) |
| editor Playwright | `journey/plugins/image-adjust.journey.spec.ts` | 1 | paged.image kernels are GPU-only (no CPU path). This is NOT verified elsewhere in CI: the `journeys-gpu` lane needs rea… |
| editor Playwright | `journey/plugins/image-color.journey.spec.ts` | 1 | every dab is a WGSL dispatch (no CPU paint path). The picker → foreground half ran on this lane; run `pnpm --filter pag… |
| editor Playwright | `journey/plugins/image-commands.journey.spec.ts` | 1 | the rank filters are GPU kernels (no CPU path); the command→session half ran on this lane. Run `pnpm --filter paged-can… |
| editor Playwright | `journey/plugins/image-commands.journey.spec.ts` | 1 | pattern fill and shape blur are GPU kernels (no CPU path); define + both refusals ran on this lane. Run `pnpm --filter … |
| editor Playwright | `journey/plugins/image-commands.journey.spec.ts` | 1 | hiding the layer is a re-composite and painting the mask is a GPU stroke (no CPU path); the mask + edit-target half ran… |
| editor Playwright | `journey/plugins/image-crop.journey.spec.ts` | 1 | paged.image kernels are GPU-only (no CPU path). This is NOT verified elsewhere in CI: the `journeys-gpu` lane needs rea… |
| editor Playwright | `journey/plugins/image-layers.journey.spec.ts` | 1 | journaling needs a pixel edit and every pixel write is a GPU kernel dispatch (no CPU path), so no entry can be produced… |
| editor Playwright | `journey/plugins/image-layers.journey.spec.ts` | 1 | the composite half is GPU-only (no CPU kernel path). The layer-state half above ran on this lane; run `pnpm --filter pa… |
| editor Playwright | `journey/plugins/image-paint.journey.spec.ts` | 1 | every dab is a WGSL dispatch (no CPU paint path), so a stroke cannot mark pixels on this lane. The tool-registration ha… |
| editor Playwright | `journey/plugins/image-paint.journey.spec.ts` | 1 | a stroke needs GPU dabs to produce a preview at all (no CPU paint path); run `pnpm --filter paged-canvas test:journeys:… |
| editor Playwright | `journey/plugins/image-perf.journey.spec.ts` | 1 | paged.image is GPU-only (no CPU kernel path); this trend lane runs on journeys-gpu (`pnpm --filter paged-canvas test:jo… |
| editor Playwright | `journey/plugins/image-persist.journey.spec.ts` | 1 | a commit bakes the GPU composite and every pixel edit is a WGSL dispatch (no CPU path). Ingest, the marker and the edit… |
| editor Playwright | `journey/plugins/image-retouch-tools.journey.spec.ts` | 1 | all four write pixels through WGSL kernels (no CPU path); arming, frame fit and the gesture→session refusal ran on this… |
| editor Playwright | `journey/plugins/image-retouch-tools.journey.spec.ts` | 1 | toning strokes are GPU dabs (no CPU path); arming, frame fit and the stroke→session refusal ran on this lane. Run `pnpm… |
| editor Playwright | `journey/plugins/image-retouch-tools.journey.spec.ts` | 1 | the brush filters are GPU dabs (no CPU path); arming, frame fit and the stroke→session refusal ran on this lane. Run `p… |
| editor Playwright | `journey/plugins/image-retouch-tools.journey.spec.ts` | 1 | the heal is a GPU composite (no CPU path); arming, frame fit and the stroke→session refusal ran on this lane. Run `pnpm… |
| editor Playwright | `journey/plugins/image-retouch-tools.journey.spec.ts` | 1 | the patch is a GPU kernel (no CPU path); the no-selection refusal, the marquee and the drag→session refusal ran on this… |
| editor Playwright | `journey/plugins/image-selection.journey.spec.ts` | 1 | the masked-render half is GPU-only (no CPU kernel path). The mask/coverage half above ran on this lane; run `pnpm --fil… |
| image vitest | `test/wasm-surface.spec.ts` | 3 | (condition in the file) |
| draw vitest | `test/roundtrip/generate.spec.ts` | 27 | (condition in the file) |
| draw vitest | `test/real-vector-corpus.spec.ts` | 3 | (condition in the file) |
| draw vitest | `test/page-space/page-space.spec.ts` | 3 | (condition in the file) |
| draw vitest | `test/conformance/create-outlines.spec.ts` | 1 | (condition in the file) |
| sheet vitest | `test/engine.spec.ts` | 1 | (condition in the file) |
| data vitest | `test/indesign-binding.spec.ts` | 1 | (condition in the file) |
| data vitest | `test/perf/duckdb-1m.trend.spec.ts` | 1 | (condition in the file) |
| doc vitest | `test/conformance/object-model.spec.ts` | 11 | (condition in the file) |
| doc vitest | `test/conformance/object-model-budget.spec.ts` | 1 | (condition in the file) |
| web vitest | `test/real-html-corpus.spec.ts` | 9 | (condition in the file) |

| Suite | Condition behind the skipped tests |
|---|---|
| draw vitest | `test/roundtrip/generate.spec.ts`: no InDesign round-trip output dir (`PAGED_ROUNDTRIP_WRITE`); `real-vector-corpus`: no SVG corpus; `page-space`: `it.runIf(shape === "page")`; `create-outlines`: `ctx.skip()` on a protocol check |
| web vitest | `real-html-corpus.spec.ts`: no HTML corpus |
| doc vitest | `object-model*.spec.ts`: the docx-js build is not present in that lane (`docxPresent`) |
| image vitest | `wasm-surface.spec.ts`: wasm not built in that lane |
| data vitest | `indesign-binding`: no InDesign recording; `duckdb-1m.trend`: opt-in DuckDB lane |
| sheet vitest | `engine.spec.ts`: the boot-failure path, skipped because the artifact is built (expected) |

### `#[ignore]`d Rust tests

| Module | `#[ignore]` reason | Tests |
|---|---|---|
| engine/core | known gap, kept as a pending assertion | 2 |
| engine/core | no reason given | 3 |
| engine/core | opt-in corpus / oracle lane (`PAGED_*` + a corpus mount) | 1 |
| engine/core | writes inputs for an external lane | 1 |
| modules/doc | opt-in corpus / oracle lane (`PAGED_*` + a corpus mount) | 5 |
| modules/image | no reason given | 3 |
| modules/image | opt-in corpus / oracle lane (`PAGED_*` + a corpus mount) | 18 |
| modules/publish | no reason given | 1 |
| modules/publish | opt-in corpus / oracle lane (`PAGED_*` + a corpus mount) | 10 |
| modules/sheet | opt-in corpus / oracle lane (`PAGED_*` + a corpus mount) | 5 |
| modules/slide | opt-in corpus / oracle lane (`PAGED_*` + a corpus mount) | 1 |

The nextest lists (T4's `test-ids.py dump`) agree: core 18 ignored (7 in core + 11 in the
`idml-*` crates that A6 moves into core), image 21, sheet 5, doc 5, slide 1.

### Conditional skip constructs in TS tests

| Module | Construct | Sites |
|---|---|---|
| apps/editor | `test.fixme` | 10 |
| apps/editor | `test.skip` | 53 |
| modules/data | `ctx.skip` | 8 |
| modules/data | `describe.skipIf` | 35 |
| modules/data | `it.skipIf` | 5 |
| modules/doc | `describe.skipIf` | 2 |
| modules/draw | `ctx.skip` | 5 |
| modules/draw | `describe.skipIf` | 4 |
| modules/draw | `it.runIf` | 4 |
| modules/image | `describe.skip` | 2 |
| modules/image | `describe.skipIf` | 1 |
| modules/sheet | `describe.skipIf` | 46 |
| modules/web | `describe.skipIf` | 18 |
| modules/web | `it.skipIf` | 2 |
| platform/extensions | `describe.runIf` | 1 |
| platform/extensions | `describe.skipIf` | 2 |

### Environment switches read by tests

Test code reads 16 `PAGED_*CORPUS*` variables, 13 `REQUIRE_*`/`PAGED_REQUIRE_*` switches and 39
other `PAGED_*` variables. T3 folds the corpus ones into `PAGED_CORPUS_DIR` and the switches
into `PAGED_REQUIRE_<X>=1`.

| Family | Variables | Test files | Variables (test files) |
|---|---|---|---|
| `PAGED_*CORPUS*` (corpus location / opt-in) | 15 | 23 | `PAGED_CORPUS` (3), `PAGED_PSD_CORPUS` (3), `PAGED_XLSX_CORPUS` (3), `PAGED_ABR_CORPUS` (2), `PAGED_IDML_CORPUS` (2), `PAGED_ABR_CORPUS_DIR` (1), `PAGED_DOCX_CORPUS` (1), `PAGED_DOC_CORPUS` (1), `PAGED_GRID_CORPUS` (1), `PAGED_HTML_CORPUS` (1), `PAGED_JPEG_CORPUS` (1), `PAGED_PNG_CORPUS` (1), `PAGED_RASTER_CORPUS` (1), `PAGED_REPO_CORPUS` (1), `PAGED_SVG_CORPUS` (1) |
| `REQUIRE_*`, `PAGED_REQUIRE_*` (skip becomes failure) | 13 | 50 | `REQUIRE_REAL_ENGINE` (28), `REQUIRE_REAL_DUCKDB` (5), `PAGED_REQUIRE_CORPUS` (3), `PAGED_REQUIRE_V66` (2), `PAGED_REQUIRE_V67` (2), `REQUIRE_REAL_INDESIGN` (2), `REQUIRE_REAL_WASM` (2), `REQUIRE_GPU` (1), `REQUIRE_REAL_BRIDGE` (1), `REQUIRE_REAL_BROWSER` (1), `REQUIRE_REAL_CORE` (1), `REQUIRE_REAL_DOCX` (1), `REQUIRE_REAL_PUBLISH` (1) |
| other `PAGED_*` (paths, lanes, oracles, records) | 39 | 70 | `PAGED_MEDIA_ROOT` (14), `PAGED_SERVER_URL` (7), `PAGED_PSD_ORACLE` (6), `PAGED_CMYK_PROFILE` (5), `PAGED_ENGINE_FROM` (3), `PAGED_FEATURE_REGISTRY` (2), `PAGED_ABR_PNG_DIR` (1), `PAGED_BIN` (1), `PAGED_BOOKMARKS_IDML` (1), `PAGED_BOOL_CASES` (1), `PAGED_BROWSER_LANE` (1), `PAGED_CHROMIUM` (1), `PAGED_DATA_ORIGINS` (1), `PAGED_DIFF_PACKAGE` (1), `PAGED_DIGEST_GATE` (1), `PAGED_DIGEST_GATE_ANNUAL` (1), `PAGED_ENDNOTES_IDML` (1), `PAGED_FILE` (1), `PAGED_FONT_SOURCES` (1), `PAGED_INDESIGN_LANE` (1), `PAGED_INDESIGN_PROBE` (1), `PAGED_INPUT_COLLECTION_SELECT` (1), `PAGED_LANE_REQUIRE_FRESH` (1), `PAGED_LANE_SCENARIOS` (1), `PAGED_LATE_FONTS_ANNUAL` (1), `PAGED_LAYER` (1), `PAGED_PAINT_SWEEP_ALL` (1), `PAGED_PHOTOSHOP_LEDGER` (1), `PAGED_PROPERTY_RUNS` (1), `PAGED_PROPERTY_SEED` (1), `PAGED_PSD_LEDGER` (1), `PAGED_PUBLISH_BUNDLE` (1), `PAGED_RECALC_REPORT` (1), `PAGED_RECORD_INDESIGN_FIXTURES` (1), `PAGED_REFLOW_EXPORT` (1), `PAGED_ROUNDTRIP_WRITE` (1), `PAGED_RT_REEXPORT` (1), `PAGED_TAGGED_PDF` (1), `PAGED_VIPS_TOLERANCE` (1) |

## 4. Flake history

**For T6.** The flake rate the CI shows is close to zero because the editor's Playwright
config retries every test once (`retries: 1`). In the old editor repository, 7 of the last 22
finished `tests.yml` runs (32%) had a test that failed and then passed on its retry. The two
tests in `effects-targets.spec.ts` (global light altitude and angle) appear in 3 of them.
No other suite retries, so its failures are real. T6 quarantines the retried tests with an
owner and an expiry and tracks the retry rate as the flake metric. The red rate of the
monorepo during the migration measures migration breakage, not flakes: the editor shards fail
on the missing corpus secret; core on clippy and on test targets that did not compile on
work-in-progress branches; publish on one pdf-bundle spec (`test/commands.spec.ts`, 7 runs);
sheet and data on their coverage gates.

Per workflow, last 30 runs. *Red rate* is failure / (success + failure); cancelled runs are left
out. *Red jobs by failing step* classifies the step that failed: test (a test runner or gate),
lint/policy (clippy, fmt, cargo-deny, catalog), setup/infra (installs, checkouts, secrets),
build, runner (no failed step). *Confirmed flaky runs* counts runs where a job failed and then
passed on re-run at the same commit, plus runs where Playwright reported a test as flaky.

| Component | Side | Workflow | Completed runs | Green / red / cancelled | Red rate | Red jobs by failing step | Confirmed flaky runs |
|---|---|---|---|---|---|---|---|
| core | old | `ci.yml` | 30 | 24 / 6 / 0 | 20% | test 12, lint / policy 6 | 0 |
| core | new | `core-ci.yml` | 16 | 5 / 11 / 0 | 69% | lint / policy 11, test 8, no failed step (runner) 2 | 0 |
| core | old | `fidelity.yml` | 30 | 30 / 0 / 0 | 0% | — | 0 |
| core | new | `core-fidelity.yml` | 14 | 13 / 0 / 1 | 0% | — | 0 |
| core | old | `gpu.yml` | 30 | 30 / 0 / 0 | 0% | — | 0 |
| core | new | `core-gpu.yml` | 12 | 11 / 0 / 1 | 0% | — | 0 |
| core | old | `perf-nightly.yml` | 12 | 12 / 0 / 0 | 0% | — | 0 |
| core | new | `core-perf-nightly.yml` | 0 | — | — | — | — |
| editor | old | `tests.yml` | 30 | 20 / 2 / 8 | 9% | setup / infra 5, lint / policy 2, test 1 | 7 |
| editor | new | `editor-tests.yml` | 21 | 0 / 11 / 10 | 100% | setup / infra 36, report 11 | 0 |
| editor | old | `showcase-nightly.yml` | 30 | 0 / 28 / 2 | 100% | test 27, setup / infra 1 | 0 |
| editor | new | `editor-showcase-nightly.yml` | 0 | — | — | — | — |
| extensions | old | `vitest.yml` | 30 | 29 / 1 / 0 | 3% | test 1 | 0 |
| extensions | new | `extensions-vitest.yml` | 17 | 13 / 0 / 4 | 0% | — | 0 |
| publish | old | `ci.yml` | 30 | 23 / 7 / 0 | 23% | test 5, lint / policy 2 | 0 |
| publish | new | `publish-ci.yml` | 26 | 19 / 7 / 0 | 27% | test 7 | 0 |
| image | old | `ci.yml` | 30 | 28 / 2 / 0 | 7% | test 4 | 0 |
| image | new | `image-ci.yml` | 27 | 17 / 0 / 10 | 0% | test 1 | 1 |
| image | old | `publish-state.yml` | 30 | 30 / 0 / 0 | 0% | — | 0 |
| image | new | `image-publish-state.yml` | 2 | 1 / 0 / 1 | 0% | — | 0 |
| draw | old | `rust.yml` | 30 | 30 / 0 / 0 | 0% | — | 0 |
| draw | new | `draw-rust.yml` | 21 | 15 / 0 / 6 | 0% | — | 0 |
| draw | old | `vitest.yml` | 30 | 30 / 0 / 0 | 0% | — | 0 |
| draw | new | `draw-vitest.yml` | 22 | 16 / 0 / 6 | 0% | — | 0 |
| sheet | old | `rust.yml` | 30 | 26 / 3 / 1 | 10% | lint / policy 3 | 0 |
| sheet | new | `sheet-rust.yml` | 25 | 13 / 3 / 9 | 19% | test 3 | 0 |
| sheet | old | `vitest.yml` | 30 | 29 / 0 / 1 | 0% | — | 0 |
| sheet | new | `sheet-vitest.yml` | 28 | 19 / 0 / 9 | 0% | — | 0 |
| sheet | old | `fuzz.yml` | 13 | 0 / 13 / 0 | 100% | test 13 | 0 |
| sheet | new | `sheet-fuzz.yml` | 0 | — | — | — | — |
| data | old | `rust.yml` | 30 | 26 / 3 / 1 | 10% | lint / policy 3 | 0 |
| data | new | `data-rust.yml` | 24 | 11 / 3 / 10 | 21% | test 3 | 0 |
| data | old | `vitest.yml` | 30 | 28 / 1 / 1 | 3% | test 1 | 0 |
| data | new | `data-vitest.yml` | 28 | 19 / 0 / 9 | 0% | — | 0 |
| doc | old | `rust.yml` | 30 | 24 / 5 / 1 | 17% | lint / policy 5 | 0 |
| doc | new | `doc-rust.yml` | 2 | 1 / 0 / 1 | 0% | — | 0 |
| doc | old | `vitest.yml` | 30 | 29 / 0 / 1 | 0% | — | 0 |
| doc | new | `doc-vitest.yml` | 2 | 1 / 0 / 1 | 0% | — | 0 |
| slide | old | `bundle.yml` | 21 | 18 / 1 / 2 | 5% | setup / infra 1 | 0 |
| slide | new | `slide-bundle.yml` | 28 | 18 / 0 / 10 | 0% | — | 0 |
| slide | old | `rust.yml` | 22 | 20 / 1 / 1 | 5% | lint / policy 1 | 0 |
| slide | new | `slide-rust.yml` | 23 | 16 / 0 / 7 | 0% | — | 0 |
| web | old | `rust.yml` | 17 | 16 / 1 / 0 | 6% | lint / policy 1, test 1 | 0 |
| web | new | `web-rust.yml` | 22 | 16 / 0 / 6 | 0% | — | 0 |
| web | old | `vitest.yml` | 30 | 30 / 0 / 0 | 0% | — | 0 |
| web | new | `web-vitest.yml` | 23 | 16 / 0 / 7 | 0% | — | 0 |
| server | new | `server-rust.yml` | 20 | 13 / 0 / 7 | 0% | — | 0 |
| moon | new | `moon.yml` | 17 | 9 / 0 / 8 | 0% | moon ci (affected tasks) 6 | 0 |

Confirmed flakes:

| Where | Test | Evidence |
|---|---|---|
| monorepo `image-ci.yml` / `rust GPU tests (lavapipe)` | `resident_chains_equal_the_per_tile_scheduler__feat__image_pipeline_async_sink` | run 39112319446 failed on attempt 1, passed on attempt 2 at `50838be` |
| old `editor/tests.yml` / playwright | `tests/effects-targets.spec.ts › Object ▸ Effects ▸ Global light… (engine 0.71.8) › EFX-GLOBAL-LIGHT-altitude — the document's global light altitude: …` | failed, then passed on retry, in 3 of the last 30 runs |
| old `editor/tests.yml` / playwright | `tests/effects-targets.spec.ts › Object ▸ Effects ▸ Global light… (engine 0.71.8) › EFX-GLOBAL-LIGHT-angle — the document's global light angle: set in…` | failed, then passed on retry, in 3 of the last 30 runs |
| old `editor/tests.yml` / playwright | `tests/object-model-plugin-panels.spec.ts › ADR 323 — plugin object properties through PropertyField › paged.sheet › PP-SHEET-1 — sheet.name set throu…` | failed, then passed on retry, in 1 of the last 30 runs |
| old `editor/tests.yml` / playwright | `tests/e2e/place-and-table.spec.ts › File ▸ Place… (film defects ED-6, IMG-2) › IMG-2 — Place with a .psd mints a frame at the PSD's size and hands th…` | failed, then passed on retry, in 1 of the last 30 runs |
| old `editor/tests.yml` / playwright | `tests/e2e/group-box.spec.ts › a selected group › AC-GROUP-BOX-2 — a body drag moves the group, a corner drag scales both members, one undo each [chro…` | failed, then passed on retry, in 1 of the last 30 runs |
| old `editor/tests.yml` / playwright | `tests/e2e/gesture-cross-cutting.spec.ts › E2E-11 — pointer-capture loss aborts the gesture › AC-E2E-CAPLOSS-1 — pointercancel mid select-drag aborts …` | failed, then passed on retry, in 1 of the last 30 runs |

Always red (not flakes, but they never give a signal):

- old `editor/showcase-nightly.yml`: 28 of 28 completed runs red, in the chaptered build of the
  reference document;
- old `plugin-sheets/fuzz.yml`: 13 of 13 red (`fuzz parse_formula`);
- monorepo `editor-tests.yml`: red on every run at the corpus checkout (missing secret, as in
  A5).

Same-commit flips between a red and a green run of the same job: 0 in every workflow. The
monorepo `moon.yml` job failed 6 times in runs that still ended green: it is advisory
(`continue-on-error`) while A8 settles.

## 5. Duplicated fakes and boot helpers

**For T2.** The test kit replaces these:

- **189 hand-rolled fakes in 136 test files.** 138 are hosts, editors or shells (`fakeHost`
  alone is defined 41 times), 32 engines/wasm/workers, 9 registries/stores, 7 documents.
  The plan's estimate was ~94; the measured count includes every `make…Host`/`…Editor`
  factory, not only the ones named `fake…` (113 of the 189 are named `fake…`, `mock…` or
  `stub…`). 4 more definitions only wrap the shared `createHeadlessHost` and are not counted.
- **22 copies of `mapBacking`**, 12 of them in `platform/extensions`.
- **172 test files boot the real core engine** through `createHeadlessHost` (which reads and
  compiles the canvas wasm), and 39 boot a module's own wasm (`initSync`, `readFileSync(…wasm)`).
  92 files boot inside a test or `beforeEach` (400 call sites), the rest once per file
  (220 sites). Vitest isolates modules per file, so every one of these files compiles the
  engine wasm again; T4's shared compile cache and one boot per worker apply to all of them.
  The plan's estimate was 43 files; this count includes every `createHeadlessHost` caller,
  since each one boots the real engine.
- **23 boot helpers** (functions in test code that boot an engine), 8 of them exported for
  other test files: `openRealHost`, `openHost` (twice), `openDoc`, `bootEngine`,
  `bootCountedEngine`, `perfBoot`, `primeBlitz`.

Counted by a scan of every TS/JS file under a test path: function, arrow-function, object
and class definitions whose name contains `fake`/`mock`/`stub` or ends in `Host`/`Editor`/
`Shell`; `mapBacking` definitions; calls of `createHeadlessHost`/`loadHeadlessEngine`
(core engine) or `initSync`/`readFileSync(…wasm)`/`WebAssembly.instantiate` (module wasm),
directly or through a helper that does it. Per module:

| Module | document / model | engine / wasm / worker | host / editor / shell | other | registry / store | Total | `mapBacking` copies | Files booting an engine (core / module wasm) | of which boot per test |
|---|---|---|---|---|---|---|---|---|---|
| apps/editor | 1 | 0 | 4 | 1 | 1 | 7 | 0 | 2 (2 / 0) | 0 |
| engine/core | 0 | 0 | 2 | 0 | 0 | 2 | 0 | 0 (0 / 0) | 0 |
| modules/data | 1 | 11 | 29 | 0 | 0 | 41 | 0 | 25 (14 / 12) | 20 |
| modules/doc | 0 | 1 | 4 | 0 | 0 | 5 | 0 | 3 (3 / 0) | 1 |
| modules/draw | 0 | 2 | 15 | 0 | 2 | 19 | 2 | 81 (81 / 0) | 7 |
| modules/image | 0 | 3 | 13 | 0 | 1 | 17 | 1 | 15 (9 / 7) | 11 |
| modules/publish | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 2 (2 / 0) | 2 |
| modules/sheet | 3 | 11 | 25 | 1 | 0 | 40 | 2 | 14 (10 / 6) | 13 |
| modules/slide | 0 | 0 | 2 | 0 | 0 | 2 | 0 | 8 (8 / 0) | 4 |
| modules/web | 2 | 2 | 17 | 0 | 2 | 23 | 5 | 22 (18 / 14) | 11 |
| platform/extensions | 0 | 2 | 27 | 1 | 3 | 33 | 12 | 25 (25 / 0) | 23 |

`mapBacking` copies:

- `modules/draw/packages/draw-bundle/test/activate.spec.ts`
- `modules/draw/packages/draw-bundle/test/conformance/host.ts`
- `modules/image/glue/test/helpers.ts`
- `modules/sheet/packages/sheet-bundle/test/lower-chart-fit.spec.ts`
- `modules/sheet/packages/sheet-bundle/test/perf/workload.ts`
- `modules/web/packages/web-bundle/test/activate.spec.ts`
- `modules/web/packages/web-bundle/test/conformance/host.ts`
- `modules/web/packages/web-bundle/test/diagnostics.spec.ts`
- `modules/web/packages/web-bundle/test/fonts.spec.ts`
- `modules/web/packages/web-bundle/test/source-panel.spec.ts`
- `platform/extensions/packages/plugin-sdk/test/asset-store.spec.ts`
- `platform/extensions/packages/plugin-sdk/test/assets-placed-image.spec.ts`
- `platform/extensions/packages/plugin-sdk/test/blob-store.spec.ts`
- `platform/extensions/packages/plugin-sdk/test/gpu.spec.ts`
- `platform/extensions/packages/plugin-sdk/test/harness.spec.ts`
- `platform/extensions/packages/plugin-sdk/test/host-doors.spec.ts`
- `platform/extensions/packages/plugin-sdk/test/host-impl.spec.ts`
- `platform/extensions/packages/plugin-sdk/test/images-resource.spec.ts`
- `platform/extensions/packages/plugin-sdk/test/network-consent.spec.ts`
- `platform/extensions/packages/plugin-sdk/test/parts.spec.ts`
- `platform/extensions/packages/plugin-sdk/test/secrets.spec.ts`
- `platform/extensions/packages/plugin-sdk/test/workers.spec.ts`

## 6. Tests with no Cockpit mapping

**For T1, T4 and T5.** A test move must keep every mapped test mapped; this is the count to
hold. 36% of the CI tests (5,074 of 14,291) are unmapped today, so the gate is "the mapped
count stays the same", not "everything is mapped". The suites with the most unmapped tests are
core nextest (2,404), image nextest (643), publish nextest (634), extensions vitest (468),
sheet vitest (289) and image vitest (203); together they are 91% of the unmapped tests. T5's
search for duplicate assertions starts there. After T4's binary merge, the rewritten map maps
exactly the same Rust tests as before (the last column).

Method: the tests are the ones in the CI artifacts (what Cockpit ingests; each suite is read by
the Cockpit source that reads the same artifact of the old workflow), in Cockpit's shape
(nextest: `crate::binary` + name; vitest: file + `describe > test`; Playwright: spec file +
title + project). A test is mapped when it carries a feature reference that resolves to a
registry id (`@feat:`, `__feat__`, `[id]`), or when a test-map entry with at least one live
feature matches it under `test-ids.py`'s rules (`file` a substring of the source path,
classname or key; `title` of the name or key; `classname` of the classname), scoped by the
entry's `source`. The Cockpit index itself was not used: its last scan predates registry
changes.

| Suite | Tests | Mapped | of which by an explicit tag | Unmapped | Unmapped share | Mapped after the binary merge |
|---|---|---|---|---|---|---|
| core nextest (workspace) | 3031 | 627 | 5 | 2404 | 79% | 627 |
| core idml-viewer vitest | 27 | 5 | 0 | 22 | 81% | — |
| core vello on lavapipe | 85 | 53 | 0 | 32 | 38% | 53 |
| editor Playwright | 1268 | 1189 | 1134 | 79 | 6% | — |
| extensions vitest | 712 | 244 | 0 | 468 | 66% | — |
| publish nextest | 768 | 134 | 0 | 634 | 83% | 134 |
| publish vitest (publish-bundle) | 13 | 13 | 13 | 0 | 0% | — |
| publish vitest (pdf-bundle) | 26 | 22 | 8 | 4 | 15% | — |
| image nextest | 1192 | 549 | 145 | 643 | 54% | 549 |
| image vitest | 353 | 150 | 0 | 203 | 58% | — |
| draw vitest | 2702 | 2609 | 21 | 93 | 3% | — |
| sheet nextest | 1496 | 1418 | 129 | 78 | 5% | 1418 |
| sheet vitest | 542 | 253 | 199 | 289 | 53% | — |
| data nextest | 317 | 316 | 71 | 1 | 0% | 316 |
| data vitest | 456 | 446 | 341 | 10 | 2% | — |
| doc nextest | 176 | 135 | 78 | 41 | 23% | 135 |
| doc vitest | 85 | 81 | 15 | 4 | 5% | — |
| slide nextest | 72 | 52 | 0 | 20 | 28% | 52 |
| slide vitest | 59 | 49 | 27 | 10 | 17% | — |
| web nextest (web-render) | 170 | 170 | 43 | 0 | 0% | 170 |
| web vitest | 741 | 702 | 245 | 39 | 5% | — |

Unmapped tests per suite, by test file (vitest, Playwright) or test binary (nextest):

| Suite | Unmapped tests by test file or binary (up to 12) |
|---|---|
| core nextest (workspace) (2404) | `paged-renderer` 295, `paged-canvas` 219, `paged-mutate` 204, `paged-text` 132, `paged-compose` 74, `paged-canvas-wasm::dispatch` 54, `paged-gen::snapshot` 43, `paged-wire` 40, `paged-canvas::idml_export_saveback` 36, `paged-script::script_basics` 32, `paged-scene` 29, `paged-canvas::batch_composition` 28, 250 more |
| core idml-viewer vitest (22) | `test/camera.test.ts` 11, `test/viewer.test.ts` 9, `test/api-catalog.test.ts` 2 |
| core vello on lavapipe (32) | `paged-gpu` 30, `paged-gpu::vello_effects` 1, `paged-gpu::vello_image_atlas` 1 |
| editor Playwright (79) | `command-when-gate.spec.ts` 18, `plugin-surface/sheet.spec.ts` 12, `plugin-surface/web.spec.ts` 8, `e2e/layers-retarget.spec.ts` 7, `e2e/gesture-cross-cutting.spec.ts` 6, `e2e/schema-list-panel.spec.ts` 5, `e2e/tables-v2.spec.ts` 4, `e2e/text-retarget.spec.ts` 4, `e2e/edit-context.spec.ts` 3, `e2e/swatches-retarget.spec.ts` 3, `plugin-surface/data-doc-publish.spec.ts` 3, `e2e/draw-schema-panel.spec.ts` 2, 3 more |
| extensions vitest (468) | `test/object-address.spec.ts` 79, `test/binding-provider.spec.ts` 38, `test/object-model-fixups.spec.ts` 19, `test/protocol-66-doors.spec.ts` 19, `test/object-model-v71.spec.ts` 18, `test/asset-store.spec.ts` 13, `test/document-change-events.spec.ts` 13, `test/documents-measure-doors.spec.ts` 13, `test/object-model.spec.ts` 13, `test/modules.spec.ts` 12, `test/script-bridge.spec.ts` 12, `test/journal.spec.ts` 11, 34 more |
| publish nextest (634) | `idml-import` 159, `idml-export` 144, `idml-export::paragraph_edits_saveback` 12, `idml-export::run_alignment_roundtrip` 12, `idml-export::tint_sentinel_roundtrip` 11, `idml-export::item_transform_precision` 9, `idml-export::label_roundtrip` 9, `idml-export::linked_image_roundtrip` 8, `idml-export::minted_inline_objects` 8, `idml-export::story_precision` 7, `idml-export::stroke_weight_precision` 7, `idml-export::tracked_insertion_edit` 7, 67 more |
| publish vitest (pdf-bundle) (4) | `test/idml-fallback.test.ts` 4 |
| image nextest (643) | `image-js` 215, `image-gpu` 96, `image-conformance::abr_reader` 41, `image-core` 38, `image-kernels::conv_shape` 26, `image-kernels::gen_pattern` 24, `image-conformance::abr_lane_a` 23, `image-js::ingest` 23, `image-kernels::geom_offset` 19, `image-graph` 16, `image-conformance::brush_stroke` 14, `image-conformance` 12, 13 more |
| image vitest (203) | `test/brush.spec.ts` 35, `test/selection.spec.ts` 21, `test/object-model.spec.ts` 16, `test/brushes.spec.ts` 14, `test/binding-provider.spec.ts` 13, `test/retouch.spec.ts` 13, `test/paths.spec.ts` 12, `test/adjust-ext.spec.ts` 11, `test/channels.spec.ts` 10, `test/crop.spec.ts` 10, `test/wasm-exec.spec.ts` 9, `test/quick-select.spec.ts` 8, 8 more |
| draw vitest (93) | `test/page-space/page-space.spec.ts` 47, `test/graphic-default.spec.ts` 12, `test/transform-group-frame.spec.ts` 10, `test/conformance/page-space.spec.ts` 8, `test/panels/panel-kit.spec.tsx` 7, `test/conformance/create-outlines.spec.ts` 5, `test/conformance/tool-graphic-default.spec.ts` 4 |
| sheet nextest (78) | `sheet-core` 40, `sheet-conformance::itercalc` 14, `sheet-conformance` 10, `sheet-conformance::bin/coverage-gate` 7, `sheet-conformance::calc_rewrite` 3, `sheet-conformance::js_surface` 2, `sheet-core::contract` 2 |
| sheet vitest (289) | `test/grid.spec.ts` 40, `test/palette.spec.ts` 23, `test/lower-to-mutations.spec.ts` 20, `test/lower-flow.spec.ts` 19, `test/binding.spec.ts` 19, `test/lower-to-table.spec.ts` 15, `test/chart.spec.ts` 14, `test/grid-panel.spec.ts` 12, `test/session-data-provider.spec.ts` 12, `test/completions.spec.ts` 12, `test/sort-find.spec.ts` 11, `test/cell-style.spec.ts` 10, 14 more |
| data nextest (1) | `data-js` 1 |
| data vitest (10) | `src/__tests__/module-door.test.ts` 10 |
| doc nextest (41) | `docx-export` 20, `docx-lower` 15, `paged-ooxml` 5, `docx-conformance::annual_report` 1 |
| doc vitest (4) | `test/grow-rules.spec.ts` 4 |
| slide nextest (20) | `pptx-export::roundtrip` 6, `paged-ooxml` 5, `slide-geom` 5, `slide-idml` 2, `slide-js::container_bytes` 2 |
| slide vitest (10) | `test/slides-model.spec.ts` 7, `test/export.spec.ts` 3 |
| web vitest (39) | `test/transform.spec.ts` 31, `test/activate.spec.ts` 5, `test/panel-reach.spec.tsx` 3 |

## What could not be measured

- **Monorepo editor Playwright:** still no run (missing `STATE_DISPATCH_TOKEN`); its numbers
  are the old repository's.
- **Per-test durations for `cargo test` lanes** (core `check + test`, image's three Rust lanes,
  draw `rust`, web's `cargo test` step): they write no JUnit. core and image have a nextest
  JUnit of the same tests (on Ubuntu, without a GPU for image).
- **Monorepo runs of core `gpu`, doc and image `publish-state`:** not in A5; only their wall
  time from the history is here.
- **Silent skips that loop over an empty corpus directory:** a test that iterates zero files
  passes with no early return. The scan can't see these; T3's `PAGED_REQUIRE_CORPUS` lane will.
- **Whether a silent skip actually skipped in a given run:** cargo and nextest capture the
  skip line of passing tests, so the counts above are what can skip, and the lane table says
  where.
- **Mapping for suites without test ids:** editor `checks` (23 node:test tests), draw `rust`
  (26), web `cargo test` (76).
- **Cockpit path ownership** (the third linking tier): no feature declares paths, so it adds
  nothing today.

## Reproduce

```sh
# 1. History: read-only gh api. Copying the parity_counts.py cache in first saves downloads.
python3 tooling/migration/test_inventory.py history --cache "$CACHE" --runs 30
# 2. The inventory. No network once the cache is filled.
#    NEXTEST_LISTS: test-ids.py dump output (before-<workspace>.json).
#    test-ids.py and test-binaries.json come from T4 (branch t4/test-binaries).
#    The four Cockpit inputs (test map, the map rewritten for merged binaries, the feature
#    registry, the Cockpit config) are private; only counts and test ids reach the JSON.
python3 tooling/migration/test_inventory.py report --cache "$CACHE" \
  --out docs/migration/test-inventory.json --nextest-lists "$NEXTEST_LISTS" \
  --test-map "$TEST_MAP" --test-map-after "$TEST_MAP_MERGED" \
  --test-ids "$T4/tooling/migration/test-ids.py" \
  --merge-report "$T4/docs/migration/test-binaries.json" \
  --features "$FEATURES" --cockpit-config "$COCKPIT_CONFIG"
# 3. The tables in this file.
python3 tooling/migration/test_inventory.py tables docs/migration/test-inventory.json --out tables.md
```

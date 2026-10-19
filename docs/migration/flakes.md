# Flake work (T6)

The editor's Playwright lane had never published a green result, and journey render polling
(`expectRenderChangesFrom`) was the suspected flake source. T6 measured the flakes locally
(the CI lane needs the corpus secret), fixed the ones it found, and replaced silent retries
with a quarantine that has an owner and an expiry
([ADR 228](../../apps/editor/docs/adr/228-flaky-tests-are-quarantined.md)).

## How it was measured

- Local, macOS arm64, headless bundled Chromium (the CPU path, as in CI), the Vite dev server,
  one worker, **`--retries=0`**, `--repeat-each` 2 to 5. A test is flaky when its attempts
  disagree; `apps/editor/scripts/flake-rate.mjs` does the count, judging each attempt against
  the test's expected status (a `test.fail()` that fails is a pass).
- The machine was shared with other builds the whole time (load average 15 to 50, an external
  disk under concurrent writes), so these are numbers under load, not on an idle machine.
- "before" = main at `aeadb24ca`, "after" = the T6 commits. Two worktrees ran at the same time,
  under the same load.

## Playwright

| Suite | Tests | Attempts | Before: flaky | After: flaky |
|---|---|---|---|---|
| smoke (`@level:smoke`, chromium + journeys) | 63 | 189 | 0 | 0 |
| plugin journeys (`--project=journeys tests/journey/plugins/`, 21 skip) | 74 | 222 | 0 | 0 |
| gesture, shell, panels-browser, UX-audit and plugin-surface specs | 412 | 797 / 724 | 1 | 3 |

The after column of the last row is the render-wait fix without the menu-driver fix; all four
flakes in the two runs are the same defect in `tests/plugin-surface/menu-driver.ts`, found
there and fixed in the T6 commit after:

- **Submenu trigger.** The driver addressed "the menu I am in" as `[role="menu"]` `.last()`,
  which Playwright re-resolves on every action. `sub.hover()` opens the submenu it points at,
  so `sub.press("ArrowRight")` could resolve `last()` to the new submenu, where the trigger is
  not, and wait out the 5-minute test timeout. A `describe.serial` file then skips the rest of
  its tests in that repeat.
- **Leaf item.** The returned `last().getByRole("menuitem").nth(i)` was clicked after the menu
  re-rendered and waited on a detached element until the timeout.

Targeted check of the fix, `menus-draw` + `menus-image`, `--repeat-each=5`, a 60 s test
timeout so a hang costs a minute:

| | Tests | Attempts run | Hangs in the driver | Flake rate |
|---|---|---|---|---|
| before | 126 | 289 | 6 (7 tests flaky, 1 failed) | 5.6 % |
| after (menus pinned by index) | 126 | 595 | 0 | 0 (*) |

(*) Two attempts after the fix and three before it failed in teardown, not in a test: the
serial file's `afterAll` (`context.close()`) and the trace fixture finalising the trace of a
whole serial file took longer than the 60 s cap of this check. At the suite's 300 s timeout
neither occurred in any run.

The render oracle itself did not flake in 411 journey and smoke attempts. Its one-sample uses
were still bets on machine speed: five assertions slept 500 to 1500 ms and two sampled right
after a click, each comparing one snapshot. All seven now poll `expectRenderChangesFrom`,
which waits on the engine's change counter.
Under an extra slowdown (the browser on efficiency cores only, `taskpolicy -b`) the two
paged.data lowering journeys still passed 10 of 10 before the change; the same slowdown made
paged.draw's symbol placement miss its 10 s poll once in the five repeats, which never
happened at normal speed and is not quarantined.

Quarantined: none. Every flake measured has a fix in the T6 commits, so
`apps/canvas/tests/quarantine.json` starts empty.

## bun test

21 package.json files (22 on current main) ran `bun test` on bun's 5 s default timeout. One
sweep of every package's bun test scripts under load, before and after `--timeout 30000`:

| | Tests over 5 s | Timeouts |
|---|---|---|
| before | 15 | web-conformance: 11 recording checks (5.0 to 13.3 s each, at the 5 s default); wasm-boot's source scan (38 s, at the default); the canvas contracts' pdf bundle (124 s cold, at its own 60 s); web-bundle's source hash (44 s, at its own 30 s) |
| after | 3 | none; the slowest, sheet-bundle's source-hash check at 20 s, was judged on its assertion |

The slow cases are I/O stalls on a shared disk (the same files read in 0.03 s on a quiet
moment), not slow code. The second sweep ran under lighter load, so it is not an exact
comparison; what the change removes is the 5 s ceiling the default put on a test that reads
the disk. Unrelated failures in both sweeps, not timing: four stale module wasm builds
(`SOURCE_HASH`, the sources changed after the copied build), the draw-bundle's local corpus
oracles, and `test:object-model` without a built plugin-sdk `dist/`.

## CI after T6

- `retries: 1` stays and `failOnFlakyTests` is on in CI: a flake turns its shard red instead
  of passing on the retry.
- The gating run takes `--grep-invert @quarantine`; an advisory step runs the quarantined
  tests with two retries.
- The `checks` job runs `bun run test:quarantine` (entries valid and not expired; the
  Playwright listing and the tags agree, checked without the corpus).
- The `publish` job writes the flake rate to the step summary and the
  `playwright-flake-rate` artifact.

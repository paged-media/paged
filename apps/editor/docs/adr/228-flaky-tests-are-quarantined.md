# ADR 228 — A flaky test is quarantined with an owner and an expiry, not retried until green

- **Status:** Accepted 2026-10-19.
- **Scope:** `apps/canvas/playwright.config.ts` (`retries`, `failOnFlakyTests`),
  `apps/canvas/tests/quarantine.json`, `scripts/quarantine-guard.mjs`,
  `scripts/flake-rate.mjs`, `.github/workflows/editor-tests.yml` (jobs `checks`, `playwright`,
  `publish`), `apps/canvas/tests/journey/driver/designer.ts`

## Context

The Playwright config retried every failed test once, for a GPU teardown race. A test that
failed and then passed counted as passed: in CI nothing reported it, and the evidence the
feature registry pulls read it as green. Nothing measured how often that happened. The
journeys' render oracle had the matching weakness: several specs slept a fixed time
(`waitForTimeout(500…1500)`) after an action and compared one snapshot, which is a bet on
the machine's speed, lost under load.

## Decision

1. **Retries detect, they do not absolve.** `retries: 1` stays, so a run can tell a flake
   (failed, then passed) from a failure (failed twice). In CI `failOnFlakyTests` makes a
   flake a red run. Locally Playwright prints it as `flaky` and the run passes.
2. **A known flake is quarantined**, never silently retried: an entry in
   `apps/canvas/tests/quarantine.json` (`id` as Playwright prints it, `owner` as a GitHub
   handle, `added`, `expires` at most 30 days later, `reason`) and `{ tag: "@quarantine" }` on
   the test. The gating CI run excludes the tag (`--grep-invert @quarantine`); an advisory
   step on shard 1 runs the quarantined tests with two retries, so they keep being measured.
3. **The quarantine expires.** `scripts/quarantine-guard.mjs` in the `checks` job fails an
   entry past its expiry, an entry without owner, reason or dates, a window longer than 30
   days, and, from the Playwright listing, an entry whose test does not exist or is not
   tagged and a tagged test with no entry.
4. **The flake rate is a number per run**: `scripts/flake-rate.mjs` classifies every test of
   the merged report (passed, failed, flaky, skipped), computes flaky ÷ ran for the gating
   tests and reports the quarantined ones apart. The `publish` job writes it to the step
   summary and to the `playwright-flake-rate` artifact (90 days), not into
   `playwright-results`, which the registry parses as a Playwright report. Locally the same
   script reads any `--reporter=json` output, including `--repeat-each` runs, where repeats
   that disagree count as flaky.
5. **Render assertions wait for the render, not for time.** A journey that asserts a page
   changed polls `expectRenderChangesFrom`, which snapshots again whenever the engine reports
   a change (a mutation, undo or redo, a committed gesture, a scene layer, a font) and at
   least once a second otherwise, instead of sleeping and sampling once.

## Evidence

Measured before and after, under load, with retries off:
[`docs/migration/flakes.md`](../../../../docs/migration/flakes.md). The one flake source it
found was the plugin menu driver (`tests/plugin-surface/menu-driver.ts`), which addressed the
open menu as `last()` and so lost its submenu trigger once the hover had opened the submenu:
6 hangs in 289 attempts before the fix, none in 595 after.

## Consequences

- An unknown flake turns CI red, once, and is then either fixed or quarantined by a person
  who puts their handle and a date on it.
- A quarantine cannot outlive its decision: it ends in at most 30 days, by a fix, a delete
  or a new decision with a new date.
- The flake rate is comparable across runs; a rising number is visible before it is a red
  run.

# ADR 273 — Trusted Types are enforced

- **Status:** Accepted 2026-10-21.
- **Scope:** `apps/canvas/public/_headers`, `apps/canvas/vite.config.ts` (the dev and preview
  servers), `apps/canvas/src/boot/trusted-types.ts`, `apps/canvas/functions/api/csp-report.ts`,
  `scripts/trusted-types.test.mjs`, `apps/canvas/tests/e2e/trusted-types.spec.ts`. Follows
  [ADR 240](240-react-19-features.md) §6, which sent the policy report-only.

## Context

ADR 240 put every HTML, script and worker sink the editor writes to behind a Trusted Types
policy and sent `require-trusted-types-for 'script'` as `Content-Security-Policy-Report-Only`,
to be enforced once the reports were clean.

Two sources of reports were planned: the test suites, and the deployed site. The deployed site's
report route (`functions/api/csp-report.ts`) writes one line per report to the Pages project's
live log and stores nothing, so there is no record of what the site reported since it shipped;
only a live tail shows reports, and only from the moment it starts. The test suites are the
record.

## Measurement

The dev server sent the policy enforced, with every report appended to a log
(`PAGED_CSP_REPORT_LOG`), and the editor's Playwright projects ran against it: `chromium` (the
behaviour suite, the plugin-surface specs, live scripts, the playground), `journeys` and
`integration`, lean as in CI, plus `showcase` (the all-plugins document).

| Run | Tests | Trusted Types reports |
|---|---|---|
| chromium + journeys + integration | 1,549 passed, 4 failed, 33 skipped | 3, all from the new spec's own probes |
| showcase | 19 passed, then the chapter chain stops at a colour chapter that needs a local ICC profile (30 failed after it) | 0 |
| production build (`vite build --mode demo`, `vite preview`): plugin-surface, journeys, live scripts, web plugin | 166 passed, 35 failed (specs that need the dev build's test hooks, the same fixture and baselines) | 0 |

The 4 failures fail the same way with the report-only policy (journey screenshot baselines of
another machine, and a capability-matrix fixture that is not a zip in this checkout); none is a
refused sink.

Chromium gates `eval`, `new Function` and string timers differently: a string handed to
`setTimeout` is refused, while `eval` and `new Function` run, because without a `script-src`
directive nothing restricts string compilation. The playground's `paged-demo-script` policy
and the default policy's `isApprovedScript` stay; they take effect if a `script-src` is ever
added.

## Decision

- The deployed site, the dev server and `vite preview` send
  `require-trusted-types-for 'script'; report-uri /api/csp-report` as an enforced
  `Content-Security-Policy`. It is a policy of its own, next to the `connect-src` wall
  (a second header line; Cloudflare Pages joins repeated `_headers` values with a comma, which
  the browser reads as two policies, each enforced). The build's `connect-src` rewrite
  (`PAGED_DATA_ORIGINS`) replaces the first line only, so it never drops this one.
- Reports keep going to `/api/csp-report`; a refused sink in production is a log line there.
- `tests/e2e/trusted-types.spec.ts` asserts the document is served with the policy enforced
  (and the wall still beside it), that a plain string is refused at `innerHTML`, a string timer
  and a foreign worker URL, and that booting, opening a document and driving the web plugin
  (code editor highlight, sandboxed preview, plugin glyphs) fires no violation.

## Consequences

- A new HTML, script or worker sink that does not go through a policy (`trustedHtml`,
  `trustedScript`, or a same-origin worker URL) now throws in the browser instead of being
  reported. The dev server enforces the same policy, so it fails in development and in the
  Playwright suites first.
- A third-party library that writes markup with `innerHTML` (or builds a worker from a foreign
  URL) has to be wrapped in a named policy before it is used.

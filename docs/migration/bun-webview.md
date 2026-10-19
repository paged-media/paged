# T7 — Bun.WebView against the Playwright library, inside bun test

Playwright stays the browser runner of Phase 1: the editor's ~400 specs, their projects,
screenshot baselines and sharding. T7 asks one narrower question: for a new browser check
written under `bun test`, which driver should run the browser, `Bun.WebView` or the
Playwright library? The checks chosen for the trial are the per-bundle **wasm boot parity**
checks (every wasm the editor ships, booted by V8), which B7 had written as a Playwright
spec (`apps/editor/apps/canvas/tests/e2e/wasm-boot-parity.spec.ts`).

**Outcome.** Both drivers run the checks reliably. The Playwright library (playwright-core's
`chromium.launch`, not Playwright's test runner) is the lane's driver: it is as reliable,
10–17% slower per process (more under heavy load), and it brings what `Bun.WebView` leaves to hand-written
DevTools-protocol calls (network interception, tracing, the browser's own log) and, on a Mac,
a WebGPU adapter by default. `Bun.WebView` stays selectable (`PAGED_WASM_BOOT_DRIVER=webview`) and the
trial stays runnable, so the comparison can be repeated when it leaves experimental.

## The checks

`tests/system/wasm-boot/` (the root tests' `system` category, `tests/README.md`):

- `wasm-files.ts`: the list. The engine's wasm (`engine/core/packages/canvas-wasm`: the
  canvas, `introspect/`, `repo/`) and every file a bundle's manifest declares, as the editor's
  module manifest lists them (`apps/canvas/scripts/module-index.mjs`, the editor's
  `virtual:paged-modules`). The eight bundles that ship wasm are pinned by name.
- `server.ts`: a `Bun.serve` page, cross-origin isolated (COOP `same-origin`, COEP
  `require-corp`), that serves the repository's files under `/@fs/<path>` as Vite does.
- `wasm-boot.test.ts`: 16 checks. The list holds the engine and exactly the eight bundles; the
  page is cross-origin isolated (`SharedArrayBuffer`); and per wasm (14), grouped by bundle:
  the page fetches it with its sha384 integrity, boots a wasm-bindgen module through its own
  glue (or compiles a plain module: DuckDB's engine and extensions), gets exports back, and
  logs no error. Without a Chromium the checks report `unavailable: browser` and skip;
  `PAGED_REQUIRE_BROWSER=1` (CI) makes that a failure.
- `drivers.ts`: the two drivers behind one interface (`open`, `evaluate` of an expression,
  `errors`, `close`). Both launch the **same** Chromium binary (`PAGED_CHROMIUM`, else
  playwright-core's), headless, so the trial compares drivers, not browsers.
- `trial.ts`: the trial below, `bun system/wasm-boot/trial.ts --runs N --json FILE` (in `tests/`).

The lane covers more than the Playwright spec did: 14 wasm files instead of 12 (the engine's
`introspect/` and `repo/` wasm, which the spec's top-level directory scan missed), and it runs
in CI (`tests / contracts + system`), where the editor's Playwright shards cannot run today
(the corpus checkout needs a missing secret). The Playwright spec is deleted (T5: the same
assertions twice; the system lane is their owner).

## Bun.WebView in Bun 1.4.3

The pinned Bun (`.prototools`, 1.4.3) has `Bun.WebView`, marked `@experimental`. Its methods:
`navigate`, `evaluate` (one expression, JSON in and out, one at a time per view), `screenshot`,
`click`/`type`/`press`/`scroll` (native input), `cdp(method, params)` and DevTools events
through `addEventListener` (Chrome backend only), `close`, `closeAll`. The backend defaults to
WKWebView on macOS, which runs JavaScriptCore: useless for a V8 parity check, so the driver
always asks for `backend: { type: "chrome", url: false, path }`. Chrome is spawned once per
process with Bun's default flags, `--headless --disable-gpu` among them; the first view's
flags win for the process.

## The trial

Fifty runs per driver of `wasm-boot.test.ts`, each a fresh `bun test` process (browser launch
included), the drivers alternating run by run so that load falls on both alike. Apple M-series
Mac, macOS, Bun 1.4.3, Chrome for Testing 156 (playwright-core 1.64.1's), on a machine shared
with other builds (run 2 under heavy load; the numbers are wall time per process).

| Run | Driver | Green runs | Checks per run | Failed checks | Wall time min / median / p90 / max |
| --- | --- | --- | --- | --- | --- |
| 1 | Playwright library | 40 / 50 | 16 | 10 | 1.16 / 1.41 / 1.65 / 3.01 s |
| 1 | Bun.WebView (Chrome) | 50 / 50 | 16 | 0 | 1.06 / 1.26 / 1.58 / 1.96 s |
| 2 (load average ≈ 35) | Playwright library | 50 / 50 | 16 | 0 | 1.22 / 7.30 / 16.48 / 22.36 s |
| 2 (load average ≈ 35) | Bun.WebView (Chrome) | 50 / 50 | 16 | 0 | 1.08 / 2.96 / 7.94 / 9.73 s |

Run 1's ten Playwright failures were all one check and one cause, and it was the harness's,
not the driver's: Chrome asks for `/favicon.ico` after the load, the page server answered 404,
and Chrome logs that as a console error, which landed in whichever check ran then. Playwright's
`console` event includes the browser's own log lines; `Bun.WebView`'s `console` option sees
only the page's `console.*` calls, so it never saw the 404. The page now declares an empty
icon, and the WebView driver subscribes to the protocol's `Log.entryAdded` (and
`Runtime.exceptionThrown` for uncaught errors), after which both drivers observe the same
errors (a deliberate 404 shows in both). Run 2 is after that fix.

Speed: in run 1 `Bun.WebView` is about 10% faster (median 1.26 s against 1.41 s for the whole
process). Under heavy load `Bun.WebView` degrades less (median 3.0 s against 7.3 s):
playwright-core is a large JavaScript client that runs its protocol handling in the test
process, and `Bun.WebView` is native.

### In CI

The `tests / contracts + system` workflow runs five runs per driver as an advisory step on every
push (Ubuntu runner, its preinstalled Google Chrome as `PAGED_CHROMIUM`, artifact `t7-trial`).
The first two pushes (`0d05666e1`, `3c97631f6`):

| Push | Driver | Green runs | Wall time min / median / max |
| --- | --- | --- | --- |
| `0d05666e1` | Playwright library | 5 / 5 | 2.08 / 2.16 / 2.25 s |
| `0d05666e1` | Bun.WebView (Chrome) | 5 / 5 | 1.77 / 1.79 / 1.96 s |
| `3c97631f6` | Playwright library | 5 / 5 | 2.10 / 2.11 / 2.16 s |
| `3c97631f6` | Bun.WebView (Chrome) | 5 / 5 | 1.79 / 1.79 / 1.86 s |

`Bun.WebView` is 15–17% faster per process there, and neither driver gets a WebGPU adapter
from the runner's Chrome.

### What else each one does

Probed once per driver by the trial script (same binary, same page):

| | Playwright library | Bun.WebView, Chrome backend |
| --- | --- | --- |
| Cross-origin isolation, `SharedArrayBuffer` | yes | yes |
| `console.error` from the page | yes | yes |
| Uncaught page error | yes (`pageerror`) | only through `cdp()`: `Runtime.enable` + `Runtime.exceptionThrown` |
| The browser's own log (a failed load) | yes (`console`) | only through `cdp()`: `Log.enable` + `Log.entryAdded` |
| Network interception | yes (`page.route`, fulfil a request) | works, hand-written: `Fetch.enable`, `Fetch.requestPaused`, `Fetch.fulfillRequest` |
| Tracing | yes (`context.tracing`, a trace-viewer zip) | raw trace events only (`Tracing.start` / `dataCollected` / `end`); no trace file, no viewer |
| Screenshot | yes | yes |
| WebGPU adapter (headless, macOS) | yes, by default | no by default (`--disable-gpu`); a SwiftShader adapter with `--enable-unsafe-webgpu --use-angle=swiftshader --enable-unsafe-swiftshader` |
| WebGPU adapter (headless, the Linux CI runner's Chrome) | no | no |
| Locators, auto-waiting, assertions | yes | `click(selector)` waits for actionability; nothing else |
| Stability of the API | stable, versioned with its browser | experimental |

Nothing broke in the Playwright library under `bun test`: launch, console and page errors,
`page.route`, tracing (`context.tracing.start`/`stop` wrote a zip) and screenshots all worked,
which answers the worry that interception and tracing are unreliable on Bun. In `Bun.WebView`
nothing broke either, but everything past navigate / evaluate / screenshot is the DevTools
protocol by hand: each capability above is a few lines of `cdp()` and event plumbing that
Playwright already has, tested.

## Decision

- **The lane's driver is the Playwright library.** Equal reliability (50 / 50 each once the
  harness was fixed, and it was Playwright that exposed the harness's defect), a speed cost of
  10–17% per process (about 0.15–0.35 s for this lane), WebGPU by default on a Mac, and first-class
  interception, tracing and logging if the checks grow. It is the library the editor's
  Playwright suite already depends on.
- **`Bun.WebView` does not grow yet.** Of the plan's conditions for growing it (cross-origin
  isolation, WebGPU, stability across 50 CI runs, comparable wall time) it meets isolation and
  wall time, meets WebGPU only with SwiftShader flags, and has 50 local runs and, so far, 10
  CI runs.
  The trial runs in CI as an advisory step (`tests / contracts + system`, five runs per driver
  per push, artifact `t7-trial`), so the CI count accumulates.
- **Revisit** when `Bun.WebView` leaves experimental: if its Chrome backend then logs what the
  browser logs and offers a GPU without flags, the speed under load is worth switching the lane
  (one environment variable) and running the trial again.

## Reproduce

```sh
cd tests
PAGED_REQUIRE_BROWSER=1 bun run test:system                       # the lane (Playwright library)
PAGED_WASM_BOOT_DRIVER=webview PAGED_REQUIRE_BROWSER=1 bun run test:system
bun system/wasm-boot/trial.ts --runs 50 --json trial.json          # the head-to-head
```

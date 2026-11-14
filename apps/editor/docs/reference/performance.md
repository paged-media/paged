# Performance: how it is measured, the numbers, the budgets

The editor's performance budgets ([ADR 1227](../adr/1227-performance-budgets.md)) and the
interaction specification's §20 (`UXI-PRF-001` to `PRF-007`). This page says how each number is
taken, what it was in the October audit, what it is now, which budget holds it, and which cache
owns which memory. The suite is `apps/canvas/tests/perf/budgets.perf.spec.ts` (the `perf`
Playwright project); the nightly workflow `editor-perf-nightly.yml` runs it on the production
build.

```sh
cd apps/editor/apps/canvas
PAGED_PERF_OUT=/tmp/perf.json bunx playwright test --project=perf tests/perf/budgets.perf.spec.ts
# a local large file, never committed:
PAGED_PERF_LARGE_IDML=/path/to/a.idml,/path/to/b.idml bunx playwright test --project=perf tests/perf/budgets.perf.spec.ts
# the budgets asserted, as the nightly does:
PAGED_PERF_BUDGETS=1 bunx playwright test --project=perf tests/perf/budgets.perf.spec.ts
```

## Method

Every latency is a set of samples reported as p50, p95, p99 and max (`percentiles`), never a
mean alone. A latency ends at the main thread's next frame after the engine answered (rAF and a
task); the worker presents on its own `OffscreenCanvas`, so the worker's present is not inside
the number (`UXI-PRF-006`).

| Measure     | Taken as                                                                                                                                                                                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Selection   | A real click (Playwright's mouse) on one of fixture A's objects, from nothing selected: from the `pointerdown` (a capture listener) until the selection mirror holds the object, then the next frame. 24 clicks over four objects.                                                       |
| Typing      | A caret in fixture A's text frame; `keyboard.type` of 88 characters with a delay between keys (150 ms: 6.7 characters a second; 18 ms: about 55 a second, the audit's burst). From each `keydown` (a capture listener installed before the app's) to the engine's reply to the insert that carried its character, then the next frame. |
| First paint | A document opened through the file input. `firstPaintWorkerMs`: the worker's own `worker.firstPaint` journal entry, from the layout's build to the first draw with every visible page on screen. `firstPaintScreenshotMs`: the audit's method, the first screenshot of the viewport with more than 20 % of its pixels lighter than the surround, polled every 250 ms from the file's choice. |
| Memory      | `performance.measureUserAgentSpecificMemory()` (the page and its workers; the editor is cross-origin isolated), idle on fixture A, and after a document opened and after twenty page-downs and four zoom-ins.                                                                            |

The stress suite's document is generated in the spec (`stressIdml`): 40 pages, each with 48
frames (a third of them filled) and a 12-paragraph story. Large real-world files are measured
locally only, through `PAGED_PERF_LARGE_IDML` (a path that is not there reports `unavailable`).

Numbers on a shared machine are noisy: each table gives the load average at the time, and a
change is judged by the same run's before and after, not against another day's numbers.

## Numbers

NUMBERS

## Budgets

The specification's targets (§20.2: a selection visible within one or two frames, typing that
never stalls, an inspector reflecting the selection in about 100 ms) are the direction. The
nightly fails only past these (`BUDGETS` in the spec), several times the measured numbers, so a
real regression fails and a loaded runner does not:

| Budget                                   | Limit  |
| ---------------------------------------- | ------ |
| Selection, p95                           | 250 ms |
| Typing at a normal pace, p95             | 300 ms |
| Typing in a burst (55 a second), p95     | 1 s    |
| Generated 40-page document, first paint  | 30 s   |
| Generated 40-page document, memory       | 3 GB   |

## Caches, their owners and their budgets

| Cache                                 | Owner                                                                 | Budget                                    | Eviction                                                                        |
| ------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------- |
| CPU page tiles (decoded bitmaps)      | `apps/canvas/src/worker/render.ts` (`TILE_BUDGET_BYTES`)               | 64 MB                                     | The tiles drawn longest ago first; never a tile on screen. All on a new layout. |
| GPU page scenes                       | `engine/core/crates/paged-canvas-wasm/src/scene_cache.rs`              | 200 page scenes                           | LRU; a page's scenes on its edit; all on a new document.                        |
| Page thumbnails (compressed PNG URLs) | `packages/shell/src/state/page-thumbnails.ts`, `document-loader.ts`    | One per page                              | Dropped and revoked with their page; re-taken after an edit.                    |
| Undo history                          | the engine's undo log (`MAX_APPLIED_LOG`), the History panel's depth   | 10,000 steps (the setting may lower it)   | The oldest step first.                                                          |
| Fonts                                 | the engine's font registry (`client.clearFontRegistry`)                | The document's own                        | With the document.                                                              |
| Decoded images                        | `engine/core/crates/paged-canvas/src/model.rs` (`image_decode_cache`)  | **None yet** (inventory exception EXC-003) | Kept while the document is open.                                                |

The decoded-image cache is the one without a budget, and the measured memory of large
documents is mostly there (the main thread's JS heap stays a fraction of it). Every rebuild
composes every page, so an image evicted would be decoded again on the next edit; a budget
that holds needs images decoded at the size they are shown and the visible pages composed
first, which is engine work with its own record.

## What makes it fast

- **The viewport first.** The CPU path renders one tile per tick, the visible page nearest the
  viewport's centre first, and plans every tick from the camera it then has, so nothing it
  renders was made stale by a camera move; the two pages either side follow while nothing on
  screen is missing. The GPU path builds the visible pages' scenes before its first present;
  the first-page fit of the progressive load (ADR 1208) keeps that to one page.
- **Typing folds.** While one insert is in flight, the characters behind it wait in one
  pending insert at the advancing caret and go as one mutation with the reply: one relayout per
  round trip however fast the keys come (`apps/canvas/src/ui/typing-coalescer.ts`).
- **Nudges fold** the same way (ADR 251), and an inspector scrub is one coalesced undo step
  (engine ADR 1304).

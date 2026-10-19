# @paged-media/test-kit

The internal test kit of the built-in modules and the editor: runner-agnostic
helpers (nothing here imports a test runner), never published. Community
plugins use the public subset that ships in `@paged-media/plugin-sdk`.

## The async shims

What vitest's `vi` had and bun:test's does not: `waitFor`, `stubGlobal` /
`unstubAllGlobals`, `importActual`, `advanceTimersByTimeAsync`, `settle`.

## covers(): the surface-conformance marker

`covers(...ids)` marks the surface ids a test ASSERTS, for the
surface-conformance gate (`apps/editor/scripts/surface-coverage.mjs`; the
overview is
[`apps/editor/docs/reference/surface-conformance.md`](../../../apps/editor/docs/reference/surface-conformance.md)).
It does nothing at run time; the gate reads the calls statically. Call it
inside the test body, next to the assertions it vouches for:

```ts
import { covers } from "@paged-media/test-kit";

it("undo restores the frame", async () => {
  covers("command:paged.undo");
  // ... the assertions
});
```

An id is `<kind>:<id>` (the `SurfaceId` type). The kinds (`SURFACE_KINDS`)
and their ids; plugin contributions use the same kinds with their own ids:

| Kind         | Id                                                                                                                                                                                                                                              |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command`    | the command id: `command:paged.editor.undo`; a bundle's manifest commands and typed object-model commands: `command:media.paged.slide.newSlide`                                                                                                 |
| `panel`      | the panel id, schema panels included: `panel:paged.layers`                                                                                                                                                                                      |
| `tool`       | the tool id: `tool:paged.tool.rectangle`                                                                                                                                                                                                        |
| `menu`       | the item's path as registered, the menu registry's own key: `menu:File/Export PDF…`. `menu:<command id>` is an accepted alias while exactly ONE item (host or plugin) invokes that command; the gate errors and lists the paths when several do |
| `keybinding` | `<key>→<command>`, the key as registered (lowercase combo): `keybinding:cmd+z→paged.editor.undo`; `->` is read as `→`                                                                                                                           |
| `setting`    | the configuration key; a tool option is `<toolId>.<key>`: `setting:paged.tool.polygon.sides`                                                                                                                                                    |
| `cli`        | the binary and the command path, one space apart: `cli:paged export-pdf`                                                                                                                                                                        |
| `script`     | the function's full name: `script:paged.document.pages`, `script:editor.select`                                                                                                                                                                 |
| `importer`   | a bundle's importer id (`contributes.importers`)                                                                                                                                                                                                |
| `exporter`   | a bundle's exporter id (`contributes.exporters`)                                                                                                                                                                                                |

**The forms the gate reads, and nothing else:**

| Where                                                                                           | Form                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript / JavaScript tests that may import the kit                                           | `covers("kind:id", …)` imported from `@paged-media/test-kit`.                                                                                                                       |
| TypeScript / JavaScript tests that may not (`platform/extensions/*`, community-facing packages) | the same call against a local no-op in the file: `const covers = (..._ids: string[]): void => {};`.                                                                                 |
| Rust tests                                                                                      | `covers!("kind:id", …)`: `paged_test_resources::covers` (a dev-dependency most workspaces already have) or a local no-op `macro_rules! covers { ($($id:literal),+ $(,)?) => {}; }`. |
| Rust tests, without a macro                                                                     | a line comment directly above the assertion: `// covers: kind:id, kind:id` (ids separated by commas).                                                                               |

The rules the gate enforces on them:

- The callee is the bare identifier `covers` (not `x.covers`); calls in
  comments and strings do not count.
- Every argument is a string literal (`"…"`, `'…'`, or a backtick literal
  without `${…}`). A variable, a spread or an interpolation is a gate
  ERROR: the gate cannot read it, and a call it cannot read must not pass
  silently. A table-driven test writes its ids out.
- Every id has a known kind and names a surface the gate enumerated; an
  unknown id (a typo, a renamed command) is an error, not a quiet zero.
- The call sits in a test file: `*.test.*`, `*.spec.*`, `*.film.ts`, or a
  file under `test/`, `tests/` or `__tests__/`; for Rust, a file under
  `tests/` or one with a `#[cfg(test)]` module. A call elsewhere is an error.

**The layer comes from the file's path**, never from the call:

| Layer       | Files                                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `unit`      | every TypeScript test file not matched below                                                                                         |
| `component` | `*.dom.test.ts(x)` (happy-dom)                                                                                                       |
| `headless`  | a `headless/` directory or `*.headless.test.ts` (the headless editor)                                                                |
| `e2e`       | Playwright: `apps/editor/apps/canvas/tests/**` (outside `headless/`) or an `e2e/` directory                                          |
| `rust`      | a Rust test                                                                                                                          |
| `golden`    | ALSO, in addition to the above: a path containing `golden` (`cli.golden.test.ts`, `tests/golden/…`, `tests/cli_golden.rs`)           |
| `script`    | ALSO: a file name with the word `script`, `scripts` or `scripting` (`script-console.spec.ts`, `scripting.test.ts`, `script_host.rs`) |
| `gesture`   | ALSO: a file that drives the gesture DSL (`gestures(…)`, `browserGestures(…)`, `createGestureDsl(…)`, `unitBackend(…)`)              |

## The gesture kit

How gestures are tested is in
[`apps/editor/docs/reference/gestures.md`](../../../apps/editor/docs/reference/gestures.md)
("How gestures are tested"). The kit has two halves.

**Public, in `@paged-media/plugin-sdk`** (also its own entry point,
`@paged-media/plugin-sdk/gesture-kit`, which loads nothing else of the SDK),
re-exported here:

| Export                                                        | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createFakeEditor(options)`                                   | A recording fake of the contract's `PagedEditor`. One ordered log (`events`) of registry calls, mutations, undo/redo, the gesture channel (begin / update / commit / cancel), every other `client.send`, overlay primitives, selection writes, tool switches and commands. Scripted replies with happy-path defaults (`createdId` per insert); `replies: "manual"` holds them for begin-before-resolve paths; a small undo stack (`undoDepth()`). Readers: `mutations()`, `gestureMessages()`, `previews()`, `currentPreview()`, `registered()`, `tools()`, `ofChannel()`, `mark()` / `since()`, `invokeCommand()`, `emit()`, `settle()`. |
| `gestures(fake)` / `createGestureDsl(backend)`                | The gesture DSL, in document points: `g.tool("rectangle").drag({ from: [72, 72], to: [216, 144], mods: ["shift"] })`, `click`, `dblclick`, `hover`, `down` / `move` / `up`, `key`, `wheel({ ctrl: true })`, `cancel()` (Escape), `pointerCancel()`, `zoom(scale)`, `settle()`, `do(fn)`, `cursorAt(point)`, `tape()`, `replay(tape)`. A drag takes `via`, `steps`, `keys` (pressed mid-drag), `modsAt` / `pressureAt` (per sample), `device` (`mouse` / `pen` / `touch`), `release: false`. A point is `[x, y]` in document pt or `{ page, at }`.                                                                                         |
| `unitBackend(target)`                                         | Drives a `GestureHandler` the way the editor's gesture spine and canvas do (switch deactivates, `maxDelta` in screen px at the zoom, hover moves at `maxDelta` 0, `pointercancel` reaches the handler as Escape, a double-click is two clicks). Over a fake editor or any `PagedEditor`, the headless engine's included.                                                                                                                                                                                                                                                                                                                  |
| `parseTape` / `validateTape` / `serializeTape` / `replayTape` | The pointer tape, v1 (gestures.md Appendix A): document points, timestamps, coalesced sub-samples, tool / zoom / key / wheel / double-click samples. Replay preserves order, never wall time.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `expectOneCommit` / `expectNoCommit` / `expectOneUndoStep`    | INV-1 / INV-2 on a fake editor's log.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `checkUndoRedo` / `checkCancel` / `engineModelChannel(send)`  | INV-1 / INV-2 / INV-4 against a real engine: model dumps (scene tree, every element's properties, document meta, pages, spreads, swatches, layers) compared byte for byte.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

**Internal, here:**

| Export                                                                | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createFakeShellEditor(options)`                                      | The editor's own handle, faked: the contract fake plus the members the built-in tools reach for (the CanvasClient's typed gesture methods, `camera.read()`, `marqueeHits`, `requestSnapshot`, tool settings, the content selection).                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `browserBackend(page)` / `browserGestures(page)`                      | The DSL's browser backend: real pointer events through the running editor's live camera (`client = host.left + doc · scale + tx`); a press off the middle of the viewport pans it into view first; pen through CDP `Input.dispatchMouseEvent` (`pointerType: "pen"`, pressure, tilt), touch through `Input.dispatchTouchEvent`; a pinch is ctrl + wheel; `zoom(scale)` is the editor's own ctrl-wheel zoom. `settle()` waits for the editor to go quiet (no request in flight for three animation frames, then a round trip through the worker, which answers in order) and never on a timer. `BrowserPage` is the structural slice of a Playwright `Page` it uses. |
| `commitsDuring(page, run)`                                            | The commits the engine reported while `run` ran.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `gestureFixture(name)` / `GESTURE_TARGETS` / `buildFixtureIdml(spec)` | IDML built in code (stored ZIP, no zlib): `targets` (a frame, a group, a rotated frame, a locked frame, a master item, an open path, empty space, a second page), `paths`, `dense`. No corpus needed.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `runGestureFuzz(options)` / `GESTURE_FUZZ_KNOWN`                      | The seeded gesture fuzzer over an engine channel: random begin / update / commit / cancel sequences with undo, redo and stale handles; invariants no-panic, no-error, finite bounds, INV-1 (a failed commit commits nothing), INV-2, INV-4 and the IDML save → load round trip (`compareDigests`: corners as a set, a 4-decimal precision drift told apart from a move). Findings on record are counted apart (`known`). `fuzzSequenceCount(env)`: `PAGED_GESTURE_FUZZ_N`.                                                                                                                                                                                          |
| `expandMatrix` / `matrixCoverage` / `validateMatrix`                  | The gesture matrix maths: the committed table (tool × modifier set × zoom × target type, rows with `*` and zooms) expanded into cells, the coverage against the registered tools.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

The DSL is a thenable: `await g.drag(…)` runs the queue. An async function
must not return it bare (the `await` of its caller would run it and get
`undefined`); return it inside an object, as `gestureEditor` does.

## The headless editor's engine half

`headlessEngineModule()` boots the editor's canvas-wasm once per process
(through the plugin SDK's Node loader, which refuses a protocol skew) and
hands out a fresh engine per editor. `createEngineWorker(engine)` is the
render worker in process: a `Worker`-shaped object the real `CanvasClient`
drives through `workerFactory`, mirroring `apps/canvas/src/worker/worker.ts`
(the JSON channel, the binary load and v66 doors, the measure shortcuts, the
gesture SAB drain, the resolver), with painting off. `modelDump(send)` is
the canonical model dump (meta, scene tree, every element's properties, the
document collections, every story's content), `canonicalJson` its stable
serialisation and `dumpDiff(a, b)` a readable difference. The editor itself
is `apps/editor/apps/canvas/tests/headless/harness.ts`
(`createHeadlessEditor`).

The fixture builder takes `stories` (paragraph lists) and a `textFrame`
helper for documents with text.

## Where it runs

- Unit, no engine: `apps/editor/packages/tools/test` (every built-in tool),
  `modules/draw/packages/draw-bundle/test/gestures.spec.ts`,
  `modules/image/glue/test/gestures.spec.ts`, the plugin-sdk's
  `test/gesture-kit.spec.ts`.
- The headless engine: `test/engine-gestures.test.ts` (transform maths as
  fast-check properties, the invariants per gesture kind, the findings as
  expected failures) and `test/gesture-fuzz.test.ts` (25 sequences a fixture
  in CI; `PAGED_GESTURE_FUZZ_N=200` locally; `PAGED_GESTURE_FUZZ_SEED=<n>`
  replays one). CI runs this package in the `extensions / bun test` job.
- The browser: `apps/editor/apps/canvas/tests/e2e/gesture-dsl.spec.ts`,
  `gesture-fuzz.spec.ts`, `gesture-matrix.spec.ts`,
  `ux-audit-gestures.spec.ts`, over `tests/e2e/harness/gesture-kit.ts`.

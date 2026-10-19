# Testing plugins

How a bundle's contributions, and the host surface a bundle stands on, are tested. The rule
that counts the tests (`covers()`, the layers, the clauses each kind needs) is the
repository's surface-conformance gate:
[`apps/editor/docs/reference/surface-conformance.md`](../../../apps/editor/docs/reference/surface-conformance.md).
This page is the plugin layer of it.

A plugin is tested in three places:

| Where                                                                                | What it proves                                                                                           | Runs in CI as                           |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| the module's own package (`modules/<m>/packages/<m>-bundle/test`, image `glue/test`) | each contribution's BEHAVIOUR: commands, tools, panels, importers, exporters, key bindings, tool options | the module's `<m> / bun test` workflow  |
| the repository's root tests (`tests/system/`, `tests/contracts/`)                    | the bundles inside the editor: all nine activate together, and the BundleHost contract                   | `tests / contracts + system`            |
| the editor's Playwright suite (`apps/editor/apps/canvas/tests/plugin-surface/`)      | what a user reaches in a browser: the manifest against the live registries, the menu entries             | `editor / tests`, the Playwright shards |

`tests/contracts/bundle-registrations.test.ts` sits beside them: the
two-way check of every manifest against what its bundle registers (plugin-sdk's
`checkManifestConformance`).

## The ids a plugin test covers

Plugin contributions use the gate's kinds with their own ids. Call `covers()` inside the test
body, next to the assertions, with string literals. A built-in module imports it from
`@paged-media/test-kit`; a package under `platform/extensions` defines the local no-op
(`const covers = (..._ids: string[]): void => {};`).

| Surface                                        | Id                                                         | Required layer (clause)                                          |
| ---------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------- |
| manifest `commands` and `objectModel.commands` | `command:media.paged.draw.command.outlineStroke`           | `unit` (unit, component) and `integration` (headless, e2e): both |
| manifest `tools`                               | `tool:media.paged.image.tool.brush`                        | `gesture`: a unit file that drives the gesture DSL               |
| manifest `panels`, schema panels included      | `panel:media.paged.slide.panel.deck`                       | `component`: a `*.dom.test.tsx` (happy-dom)                      |
| manifest `importers` / `exporters`             | `importer:media.paged.slide.importer.pptx`                 | `any`: unit, headless or e2e                                     |
| `contribute.menu({ path, command })`           | `menu:Sheet/Sort range…` (the path, exactly as registered) | `e2e`: Playwright                                                |
| `contribute.keybinding({ key, command })`      | `keybinding:cmd+c→media.paged.sheet.command.copySelection` | `any`: unit, component or e2e                                    |
| a tool's option fields                         | `setting:media.paged.draw.tool.paintbrush.size`            | `unit` (unit, component)                                         |

The layer comes from the file's path: `*.dom.test.tsx` is component, a file under a
`headless/` directory or named `*.headless.test.ts` is headless, anything under
`apps/editor/apps/canvas/tests/` outside `headless/` is e2e, every other TypeScript test is
unit. So a module puts its ENGINE-backed command tests (the SDK's `createHeadlessHost` with the
real wasm) under `test/headless/` or names them `*.headless.test.ts`, and its fake-editor and
pure tests anywhere else; a command needs one of each.

A table-driven test writes its ids out: one `test(...)` per id, each with its own literal
`covers(...)`. A variable, a spread or an interpolation is a gate error.

Uncovered plugin ids are acknowledged, with a reason, in
`apps/editor/scripts/surface-acknowledged/plugin.<kind>.<clause>.json`. After covering ids, run
`bun apps/editor/scripts/surface-coverage.mjs --prune` and commit what it removed with the
tests; `--list <kind>` shows every id and its state.

## What a test of each kind asserts

"Asserted" means the behaviour, not the registration (the two-way check already proves the
registration).

- **Command.** Run the REGISTERED handler, not a re-implementation: on the headless host
  (`createHeadlessHost`, `hh.loadBundle(bundle)`, the recorded `command` contribution's
  `handler`) against the real engine, or on the gesture kit's `createFakeEditor()` where no
  engine is needed. Assert what it emits (the mutations, or the model change read back), its
  enablement both ways (its `when`, or the refusal it reports), and that one undo restores the
  model (`checkUndoRedo`, or a model read before and after). The integration clause is the
  same handler on the real engine, or the editor's headless layer.
- **Tool.** Drive the tool's `gesture()` with the gesture DSL (`gestures(fake)` over
  `createFakeEditor()`, or `unitBackend(editor)` over the headless engine): a drag commits
  exactly once (`expectOneCommit`), Escape commits nothing (`expectNoCommit`), the commit is
  one undo step. See [`apps/editor/docs/reference/gestures.md`](../../../apps/editor/docs/reference/gestures.md).
- **Panel.** Mount the panel's component in happy-dom with `@testing-library/react` (16; it
  holds on React 18 and 19) against a headless host, and assert what it shows for a state and
  what an interaction does (the mutation, the command, the published binding). A schema panel
  renders through the SDK's widget fallback (`FALLBACK_WIDGETS`, `makeSchemaPanelComponent`);
  the host's own schema-panel renderer is tested in the editor
  ([testing-panels.md](../../../apps/editor/docs/reference/testing-panels.md)). The pattern
  is `modules/draw/packages/draw-bundle/test/panels/harness.tsx`: a `test:dom` script with the
  `test/happydom.ts` preload, the plain `test` script ignoring `**/*.dom.test.*`, and the
  module's workflow running both.
- **Importer.** Open a fixture built in code (or a small committed one, never the private
  corpus) through the REGISTERED importer, and assert the document it produced.
- **Exporter.** Export, assert the bytes (signature, structure), and round-trip through the
  importer where there is one.
- **Menu entry.** In Playwright, through the real menu bar: the entry is at its path, its
  enablement follows the state its command depends on, and clicking it runs the command.
- **Key binding.** The binding names the command, and the key runs it where its `when` holds.
- **Tool option.** The field the tool declares, and that the gesture reads the value the host's
  tool-options store holds (`host.tools.settings`, the harness's `toolSettings.set`).

## The harness

Everything a bundle test needs is public, in `@paged-media/plugin-sdk`, so a community plugin
tests the same way:

- `createHeadlessHost(options)`: a `BundleHost` over the real engine (canvas-wasm in Node),
  `loadBundle`, `load(idml)` / `newBlank`, the recorded contributions, in-memory stores
  (blob, clipboard, secrets, tool settings, will-save), the shared object, data-provider and
  binding-provider registries, `exportDocument`, `runScript`.
  The hosts it builds share one in-memory `host.storage` unless `storage` is given, so a
  re-activated bundle reads what it stored.
- `checkManifestConformance(bundle, options)`: the manifest against what the bundle registers.
- The gesture kit (`@paged-media/plugin-sdk/gesture-kit`): `createFakeEditor()`, the DSL,
  pointer tapes, the invariants. `createFakeEditor()` is also the editor an activation test
  passes to `loadBundle`: `fake.ids("commands")`, `fake.registered("panels")`,
  `fake.mutations()`, `fake.selection()` read back what the bundle did.
- `mapBacking()` and `silentConsole`: the `storage` and `console` of a host under test, so a
  suite hand-rolls neither:

  ```ts
  const fake = createFakeEditor();
  loadBundle(() => fake.editor, bundle, {
    console: silentConsole,
    storage: mapBacking(),
  });
  expect(fake.ids("commands")).toEqual(["com.example.hello.command.report"]);
  ```

Built-in modules also have `@paged-media/test-kit` (internal): the async shims, IDML fixtures
built in code (`buildFixtureIdml`, `rect`, `textFrame`, `gestureFixture`), the fuzzer.

**Wasm.** A bundle's tests run against its real engine wasm: `moon run <module>:wasm` builds it
into the gitignored output directory (`packages/<m>-bundle/bin/`, draw `wasm/`, image
`glue/wasm/`). A test that needs it and finds none says so: an honest skip with the reason
(`describe.skipIf(!built)("… (unavailable: <m> wasm: run moon run <m>:wasm)")`), and the lane
that built it sets the module's `REQUIRE_REAL_*` switch (`REQUIRE_REAL_WASM=1` for image) so
the skip becomes a failure there. Never an early `return` that passes; see
[`docs/development/testing.md`](../../../docs/development/testing.md).

**Findings.** A test that exposes a product bug is committed as an expected failure
(`test.failing(...)` in bun test, `test.fail(...)` in Playwright), named with a finding id,
and it must fail for that reason.

## The BundleHost contract

`tests/contracts/bundle-host/` asserts that every door of the contract
(`plugin-api`'s `BundleHost`) behaves as `plugin-api` documents it, on three adapters
(`hosts.ts`):

- `editor`: the headless editor (the shell's PagedEditor and registries over a real
  CanvasClient) loading a probe bundle through the SDK's `loadBundle` with the options the
  editor passes every bundle, `createEditorHostOptions` (`apps/canvas/src/plugin-host-options.ts`,
  the same factory `main.tsx` calls). The browser objects the editor's backends talk to (OPFS,
  the system clipboard, `localStorage`) are faked below the backend, so the backend's own code
  runs.
- `headless`: `createHeadlessHost`, the adapter a bundle's own tests use.
- `bare`: the SDK's adapter with no options, every door's documented no-backend answer.

A case that holds on one adapter and not on another is a finding: a bundle tested headlessly
would meet a different host in the editor. `supports.headless.test.ts` pins which features each
adapter answers; `storage`, `services`, `navigation`, `document` and `contribute` cover the doors.
`tests/system/built-in-bundles.headless.test.ts` activates all nine built-in bundles in the headless editor, slide
included, and checks every manifest declaration against the editor's registries.

Findings so far, each an expected failure in those files:

| Id     | Door                                  | What happens                                                                    | What the contract says                                                 |
| ------ | ------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| HOST-2 | `supports("storage.blob@1")` (editor) | true where OPFS is unavailable; every write then rejects                        | true means bytes persist                                               |
| HOST-3 | `host.clipboard` (headless)           | a grid copy reads back without its TSV text                                     | a grid copy carries both halves                                        |
| HOST-4 | `host.journal` (editor)               | inert: the editor keeps a journal but passes none to bundle hosts               | entries land in the host's journal; `supports("journal@1")`            |
| HOST-5 | `host.network` remembered grants      | a grant remembered for one document holds for every later one                   | remembered "for this document"                                         |
| HOST-6 | `host.parts`                          | an absolute path is accepted (relativised)                                      | `..` and absolute paths are rejected                                   |
| HOST-7 | `contribute.menu`                     | an entry onto a declared but unregistered command is accepted, and does nothing | the host refuses an entry onto a command the bundle has not registered |

## Findings on record

Every finding is an expected failure in the test named, and fails for the stated reason. The
host findings (HOST-2 to HOST-7; HOST-1 is fixed) are in the table above. All of the programme's findings, the
plugins' included, are indexed with severities and shared root causes in
[conformance-findings-2026-10.md](../../../docs/development/conformance-findings-2026-10.md).

| Id    | Surface                                                                                 | What happens                                                                           | Test                                                                          |
| ----- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| DRW-1 | draw gradient fill presets                                                              | four undo steps for one command                                                        | `modules/draw/packages/draw-bundle/test/headless/` (see `docs/testing.md`)    |
| DRW-2 | draw live-corner presets                                                                | two undo steps (the geometry, then the marker)                                         | same                                                                          |
| DRW-3 | draw dash presets, Outline stroke, Offset path, Simplify, Close path, style redefine    | one undo step per selected element                                                     | same                                                                          |
| DRW-4 | draw Add fill, Add stroke, Move layer                                                   | two undo steps (the stack, then its paint)                                             | same                                                                          |
| DRW-5 | draw bake appearance                                                                    | two undo steps                                                                         | same                                                                          |
| DRW-6 | draw Image Trace                                                                        | two undo steps                                                                         | same                                                                          |
| IMG-1 | image `rotateCw` / `rotateCcw`, undone                                                  | the pixels come back, the canvas size does not: a 4×2 image returns as a scrambled 2×4 | `modules/image/glue/test/commands.spec.ts`                                    |
| IMG-2 | image marquees, lasso, quick select, patch, brush, move, gradient, red eye              | Escape (or a lost pointer capture) mid-drag still commits on release                   | `modules/image/glue/test/tool-gestures.spec.ts`                               |
| SHT-1 | sheet typed `importXlsx`                                                                | bytes that are not a workbook resolve with a workbook address                          | `modules/sheet/packages/sheet-bundle/test/headless/commands.headless.test.ts` |
| SHT-2 | sheet typed `findReplace`                                                               | a replace that matches nothing writes a label, so the next undo undoes nothing         | same                                                                          |
| SHT-3 | sheet `.xlsx` importer                                                                  | after a failed import the workbook verbs are offered over an empty sheet               | `modules/sheet/packages/sheet-bundle/test/io.spec.ts`                         |
| DAT-1 | data typed `propertyBindings`                                                           | `{ address }` without a path is refused, though both filters are optional              | `modules/data/packages/data-bundle/test/headless/commands.headless.test.ts`   |
| DAT-2 | data `applyDataSet`                                                                     | a property and a visibility binding are written as two undo steps                      | same                                                                          |
| DOC-1 | doc typed `placeDoc`                                                                    | one undo removes the label and leaves the placed frame and its text                    | `modules/doc/packages/doc-bundle/test/headless/object-model.spec.ts`          |
| MNU-1 | 8 Sheet menu entries (Add sheet, Paginate, Insert/Delete rows and columns, Copy, Paste) | enabled without a workbook; the click is refused silently                              | `apps/editor/apps/canvas/tests/plugin-surface/menus-sheet.spec.ts`            |
| MNU-2 | Draw Corners, Appearance Add fill / Add stroke, Graphic style Save from selection       | one menu action takes four undo steps (Save from selection two)                        | `apps/editor/apps/canvas/tests/plugin-surface/menus-draw.spec.ts`             |

## Per module

Each module's documentation says where its tests are and what each layer asserts:
[draw](../../../modules/draw/docs/testing.md),
[image](../../../modules/image/docs/architecture.md#tests-of-the-editor-surface),
[sheet](../../../modules/sheet/docs/README.md#tests),
[data](../../../modules/data/docs/README.md#tests),
[doc](../../../modules/doc/docs/README.md#tests),
[slide](../../../modules/slide/docs/README.md#tests),
[web](../../../modules/web/docs/README.md#tests),
[publish and pdf](../../../modules/publish/docs/README.md#tests).
The runtime menu entries of every bundle are tested in the editor, in Playwright:
`apps/editor/apps/canvas/tests/plugin-surface/menus-<bundle>.spec.ts` over `menu-driver.ts`
(the entry at its path, greyed without a document, enabled with one, its command run once
with the effect checked). That lane needs the editor dev server
(`node node_modules/vite/bin/vite.js --port <p>`, `IDML_CANVAS_TEST_PORT=<p>`, then
`node node_modules/@playwright/test/cli.js test tests/plugin-surface`).

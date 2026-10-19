# Testing plugins

How a bundle's contributions, and the host surface a bundle stands on, are tested. The rule
that counts the tests (`covers()`, the layers, the clauses each kind needs) is the
repository's surface-conformance gate:
[`apps/editor/docs/reference/surface-conformance.md`](../../../apps/editor/docs/reference/surface-conformance.md).
This page is the plugin layer of it.

A plugin is tested in three places:

| Where                                                                                | What it proves                                                                                           | Runs in CI as                                  |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| the module's own package (`modules/<m>/packages/<m>-bundle/test`, image `glue/test`) | each contribution's BEHAVIOUR: commands, tools, panels, importers, exporters, key bindings, tool options | the module's `<m> / bun test` workflow         |
| the editor's headless layer (`apps/editor/apps/canvas/tests/headless/`)              | the bundles inside the editor: all nine activate together, and the BundleHost contract                   | `editor / tests`, step `bun run test:headless` |
| the editor's Playwright suite (`apps/editor/apps/canvas/tests/plugin-surface/`)      | what a user reaches in a browser: the manifest against the live registries, the menu entries             | `editor / tests`, the Playwright shards        |

`apps/editor/apps/canvas/test/contracts/bundle-registrations.test.ts` sits beside them: the
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
| a tool's option fields                         | `setting:media.paged.draw.tool.pencil.fidelity`            | `unit` (unit, component)                                         |

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
- `checkManifestConformance(bundle, options)`: the manifest against what the bundle registers.
- The gesture kit (`@paged-media/plugin-sdk/gesture-kit`): `createFakeEditor()`, the DSL,
  pointer tapes, the invariants.

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

`apps/editor/apps/canvas/tests/headless/bundle-host/` asserts that every door of the contract
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
would meet a different host in the editor. `supports.test.ts` pins which features each adapter
answers; `storage`, `services`, `navigation`, `document` and `contribute` cover the doors.
`built-in-bundles.test.ts` activates all nine built-in bundles in the headless editor, slide
included, and checks every manifest declaration against the editor's registries.

Findings so far, each an expected failure in those files:

| Id     | Door                                  | What happens                                                                    | What the contract says                                                 |
| ------ | ------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| HOST-1 | `host.storage` (headless)             | a re-activated bundle reads an empty store: a fresh in-memory map per host      | persistence, as in the editor (localStorage)                           |
| HOST-2 | `supports("storage.blob@1")` (editor) | true where OPFS is unavailable; every write then rejects                        | true means bytes persist                                               |
| HOST-3 | `host.clipboard` (headless)           | a grid copy reads back without its TSV text                                     | a grid copy carries both halves                                        |
| HOST-4 | `host.journal` (editor)               | inert: the editor keeps a journal but passes none to bundle hosts               | entries land in the host's journal; `supports("journal@1")`            |
| HOST-5 | `host.network` remembered grants      | a grant remembered for one document holds for every later one                   | remembered "for this document"                                         |
| HOST-6 | `host.parts`                          | an absolute path is accepted (relativised)                                      | `..` and absolute paths are rejected                                   |
| HOST-7 | `contribute.menu`                     | an entry onto a declared but unregistered command is accepted, and does nothing | the host refuses an entry onto a command the bundle has not registered |

## Per module

Each module's documentation says where its tests are and what each layer asserts:
[draw](../../../modules/draw/docs/README.md#tests),
[image](../../../modules/image/docs/README.md#tests),
[sheet](../../../modules/sheet/docs/README.md#tests),
[data](../../../modules/data/docs/README.md#tests),
[doc](../../../modules/doc/docs/README.md#tests),
[slide](../../../modules/slide/docs/README.md#tests),
[web](../../../modules/web/docs/README.md#tests),
[publish and pdf](../../../modules/publish/docs/README.md#tests).

# Status

What the plugin contract ships and what it does not, read from the code at commit `0dab296`
(`main`, 2026-10-14): `@paged-media/plugin-api` and `@paged-media/plugin-sdk`
0.2.55-canary.0, `@paged-media/plugin-cli` 0.1.6, `@paged-media/ai` 0.1.0-canary.4,
`@paged-media/cli` 0.1.0-canary.0, API version 0.2.0. The engine wire types and the
capability catalog are vendored from `@paged-media/canvas-wasm` and
`@paged-media/introspect-wasm` 0.71.8 (protocol 71); the engine has published later 0.71
patches since, with the same protocol. How the parts fit is in
[`architecture.md`](architecture.md).

## Shipped

- **Five packages, three of them on npm.** `plugin-api`, `plugin-sdk` and `plugin-cli` are
  published under the `canary` tag on a push to `main`. `ai` and `cli` are built and tested
  in the same workflow but are not on npm (see the limits below).
- **The contract** (`plugin-api`, types only): the manifest types and their JSON Schema
  (exported as `./manifest.schema.json`), `PagedBundle`, `BundleHost` with 31 members, the
  contribution shapes, the panel schema, binding providers, the object-model types, and the
  engine's wire types.
- **The loader.** `loadBundle` checks trust, id and `apiVersion`, builds the host, calls
  `activate` inside a guard, and returns a handle whose `dispose` removes what the bundle
  registered. `defineBundle`, `API_VERSION` and `satisfiesApiVersion` come with it.
- **The host adapter.** `createBundleHost` implements every door in the table in
  `architecture.md`, with the namespace rule and the capability gate (`enforce` by
  default). `supports()` knows 46 names that are always true and 42 that depend on what
  the host wires or, for `gpu@1`, on the manifest. In groups:
  - contributions: tools, React and schema panels, commands, key bindings, menu entries,
    overlays and tool previews, edit contexts with enter, exit, pointer, key, wheel, commit,
    cancel and undo/redo hooks, object types, binding providers, importers, exporters,
    scene layers and an object model;
  - document access: typed reads, one write path with engine-owned undo, the plugin's own
    metadata on an element and on the document, parts inside the document file, the
    engine's native document parts, the engine's point snapper, a page rendered as a PNG
    (`host.render.snapshot`), and change and open events;
  - services that are live when the host app passes a backend: file pick and save, a byte
    store, the clipboard, network consent, the data-provider registry, workers, credentials
    by reference, font and image bytes, image tiles, text measurement (one string or a
    batch) and the text caret, diagnostics, the journal, a code-editor, a colour-picker and
    a schema-driven property-field widget, the save hook, programmatic entry into the
    bundle's own edit context and the entering point of a pointer entry, its tools' option
    values, retained overlay layers, page navigation, taking the user to a range of text,
    exporting the document and opening one the bundle built, and the module door;
  - the binary lanes of protocol 66 for scene images and parts, with a JSON fallback the
    SDK keeps for older hosts ([ADR 320](adr/320-binary-lanes-for-scene-images-and-parts.md)).
- **The object model** ([ADR 329](adr/329-plugins-contribute-a-typed-object-model.md),
  DESIGN.md §21; on npm since 0.2.45-canary.0).
  `host.contribute.objectModel` and `host.objects`: one
  `query/get/getAll/set/batch/schema/kinds/commands/invoke/onDidChange` over core
  addresses and every plugin's contributed kinds, a batch landing as one engine mutation
  and one undo step. The address and selector grammar is a TypeScript mirror of core's,
  with core's protocol-71 escaping rules; a caret is an address (`storyRange:<id>@n..n`).
  On an engine at protocol 71 the core seam sends address strings straight to core's
  `Set` / `RequestGet` / `RequestQuery` (core evaluates selectors), its rows are the
  vendored catalog's `propertySchemas`, and core objects are created and deleted inside
  the same one-undo-step batch (swatch, gradient, colour group, the five style families,
  text variable, layer, page, text frame, rectangle, oval). Below 71 (feature-detected) the
  interim per-kind table over the protocol-70 wire still answers; there tables and cells
  need `noteTableStory`, and core creates answer `unmapped`. Creates report their new
  addresses in `created[]`, plugin creates included. Core's content and structure
  operations are 122 typed commands (`core.<op>`), generated from the vendored wire, that
  share a batch's single undo step; eight wire operations are excluded, each with a reason.
  The fix-ups from the first consumers (DESIGN.md §21.8) are in: a plugin-level `batch`,
  one label per plugin per host with merged sub-keys, page and document label hosts,
  optional and defaulted struct fields, heavy rows, indexed paths, async `hostOf`,
  container-scoped plugin selectors, and core rows typed by meaning. The host half of the
  script bridge (`runScriptWithObjects`) answers a suspended `paged.*` script's `get`,
  `batch`, `query`, `schema`, `invoke` and `commands` calls through the same registry and
  reports the engine writes it made (`committed`), so they join the script's undo step.
  Every first-party bundle manifest (nine) contributes an object model. Panel property
  rows (DESIGN.md §12.7, §12.8): a schema-panel row may be an object-model property field
  (`{ field: "property", address, path }`) the host renders with its `PropertyField`,
  list and struct values included; `host.widgets.PropertyField` / `PropertyFrame` for React
  panels; `validatePanelSchema` for bundle tests; `publishObjectList` feeds a list row from
  a selector.
- **Every committed change is reported (0.2.55-canary.0,
  [ADR 327](adr/327-every-committed-change-is-reported.md)).** `document.onDidChange`
  reports a canvas gesture's commit (`gestureCommitted`) and a script run (`scriptResult`,
  pages unknown) as well as mutations, undos and redos; the parent index, the core object
  model and the headless client follow the same set (`document.onDidChange@2`).
- **A face for the document where it has none (0.2.55-canary.0,
  [ADR 328](adr/328-a-face-for-the-document-where-it-has-none.md)).**
  `host.assets.registerDocumentFont` puts a face in the document registry when the document
  holds none for the family and style; it never replaces one (`assets.documentFont@1`).
- **Page navigation and page images (0.2.43-canary.0,
  [ADR 323](adr/323-page-navigation-and-page-images.md)).** `host.viewport.goToPage`,
  `activePage` and `onDidChangeActivePage` over a host `pages` backend (`viewport.pages@1`);
  `host.render.snapshot` renders a page to a PNG through the engine, optionally with items
  hidden (`render.snapshot@1`). `host.viewport.revealText` takes the user to a range of text
  where the host wires it (`viewport.revealText@1`).
- **Selection.** `host.selection.set` writes the engine's geometry for the applied ids to
  the host's selection mirror, so the selection box follows a selection a bundle makes
  (0.2.54-canary.0).
- **For bundle authors:** `DisposableStore`, the page-drag gesture helpers, the wasm
  fallbacks `resolveWasm` / `fetchWasm`, the object-model helpers (`applyDefaults`,
  `findRow`, `rowPathOf`, `ROW_PATH`), and `createHeadlessHost`, which runs bundles in Node
  against the real engine. The headless host loads several bundles at once (one per id),
  injects shared object, data-provider and binding-provider registries, runs `paged.*`
  scripts through the object bridge (`runScript`), opens a blank document (`newBlank`) and
  exports `.paged`, IDML and PDF (`exportDocument`).
- **Manifest validation.** `paged-plugin validate` checks the schema rules, the namespace
  rule, that `*.panel.json` files exist, wasm names, paths, sizes and integrity stamps, and
  `contributes.objectModel` (a kind with no rows, a row whose type is not a value type, or a
  typed command without `args` fails). Untyped commands are a shrink-only baseline shipped
  with the CLI (`untyped-commands.baseline.json`: draw 10, sheet 8, data 9; doc, image and
  web 0), so a plugin's `validate` fails a new one; `paged-plugin untyped` prints a
  baseline. `paged-plugin integrity` stamps sha384 into the declared wasm artifacts;
  `paged-plugin modules-upload` puts them on the module host
  ([ADR 326](adr/326-wasm-resolved-through-the-host.md)).
- **The module door.** `host.modules` resolves a declared wasm artifact to a URL the host
  serves, with Subresource Integrity; `resolveWasm` / `fetchWasm` fall back to the
  bundle-relative URL on a host without it (`modules@1`,
  [ADR 326](adr/326-wasm-resolved-through-the-host.md)).
- **The Node CLI** (`packages/cli`, bin `paged`,
  [ADR 324](adr/324-node-cli-over-the-headless-host.md), DESIGN.md §22). A host over
  `createHeadlessHost` on the canvas-wasm it finds (protocol 70 or later), with its own
  driver bundle and every discovered plugin bundle. Verbs from one table: `get`, `set`,
  `query`, `schema`, `batch`, `create`, `delete`, `commands`, `invoke`, `run`, `export`,
  `apply`, `merge`, `plugins`, `ai` and `describe`. Values are typed by their schema row
  before they are sent; `export --format pdf` prefers a typed exporter command.
- **The model package** (`packages/ai`,
  [ADR 325](adr/325-claude-agent-package.md)): the model and a per-mode table, the system
  prompt (an authoring guide and the engine catalog), the tools `run_script`, `lookup_api`
  and `render_page`, the loop, a direct and a proxy transport, the proxy's server half, the
  catalog as `./catalog`, and `paged.ai.complete`, a typed command a host registers so
  scripts can ask for text through the script bridge. The CLI's `paged ai` uses it.
- **Guards in CI:** the vendored wire types and catalog must match the published engine at
  the stamped version; a source change in `plugin-api` or `plugin-sdk` must carry a version
  bump; the untyped-command baseline may only shrink; the schema, the TypeScript unions
  and the CLI must agree on the closed vocabularies; the generated core commands must match
  the vendored wire, and every catalog operation must be a command or an exclusion with a
  reason; the built `plugin-sdk` must contain no static and no awaited import of React.

## Limits of what is shipped

- **In-process, first-party only.** `loadBundle` accepts no `trust` other than
  `"first-party"`. The code states that the capability gate prevents accidents and is not a
  security boundary, because `host.editor` hands a bundle the raw editor handle
  (`packages/plugin-sdk/src/host-impl.ts:311-313`). In `warn` mode a violation is logged.
- **Scope values are not interpreted.** The gate tests whether `document.read` and
  `document.write` are declared; the adapter treats `"scoped"` and `"broad"` alike. In
  `apiVersion` a range is `*`, an exact version or a caret; a caret on `0.x` fixes the minor.
- **Validated, but acted on by nothing in this repo:** `capabilities.editContext`, the
  `priority` of an edit-context declaration, `contributes.partTypes`, the `bakedFallback`
  of an object type, and `*.panel.json` panel paths (the CLI checks that the file exists).
- **One declared entry gesture.** An edit-context declaration's `entry` has the single value
  `"doubleClick"`. A bundle enters its own context from code through
  `host.shell.enterEditContext`, where the host wires it.
- **`host.parts` is scoped by path.** The adapter confines a bundle to
  `paged/<manifest.id>/` and, on a write, names the caller to the engine.
- **`loadBundleWasm` has no caller** in the editor or in any first-party plugin. Each plugin
  loads its wasm with its own generated glue, so the host grant, the load-time budget and
  the memory ceiling apply to no shipped module. The byte ceilings here are 100 MB each; the
  sum for the whole app is checked in the editor.
- **The headless host** wires no scene-layer or tile channel, and no shell, consent,
  worker, native-document, journal, widget, diagnostics, module, page-navigation, text-reveal
  or caret backend. The engine text shaper is opt-in (`engineShaper`). Menu entries are not
  recorded; gestures are not replayed.
- **Two packages are not on npm.** `@paged-media/ai` and `@paged-media/cli` have never been
  published. `publish.yml` publishes through trusted publishing, which cannot make a
  package's first publish: every run publishes the contract packages whose version changed
  and then fails at `@paged-media/ai` (`ENEEDAUTH`), so `@paged-media/cli` is never reached.
- **Gaps in the test and version gates.** The version-bump guard covers `plugin-api` and
  `plugin-sdk` only, so a change to `plugin-cli`, `ai` or `cli` without a bump publishes
  nothing. `vitest.yml` runs the `plugin-sdk` and `ai` suites on every pull request; the
  `cli` suite runs only in `publish.yml`, after a merge.
- **Doors without a first-party user.** None of the nine first-party bundle manifests
  declares `secrets`. The editor passes no `journal` option to `loadBundle`
  (`editor: apps/canvas/src/main.tsx:1579-1626`), so `host.journal` records nothing there.
- **Present but unused.** `scripts/assert-dist-tags.mjs` is run by no workflow.
  `PluginApiNotImplemented` is exported and never thrown. `plugin-cli` has no test suite of
  its own; specs in `plugin-sdk` run it as a subprocess. The vendored `catalog.json` is not
  in the published `plugin-api`; the `plugin-sdk` build inlines its `propertySchemas` and
  `pathAliases`.
- **Text in this repo that lags the code.**
  - The code under `packages/*/src`, the tests, the CLI's untyped baseline (`"adr": "323"`),
    `packages/plugin-cli/bin/paged-plugin.mjs`, two scripts and a `contract-guard` step name
    cite the object model as "ADR 323", its proposal number. The record is
    [ADR 329](adr/329-plugins-contribute-a-typed-object-model.md); 323 is page navigation
    and page images. A comment change under `packages/*/src` needs a version bump, so these
    change with the next contract release. Their "ADR 324" citations already name the CLI's
    record.
  - `docs/architecture.md` describes the code at `d90f727` apart from its package list and
    its decision-record citations: its door table counts 27 `BundleHost` members (31 now),
    and it counts 35 spec files in `packages/plugin-sdk/test` (66 now).
  - `DESIGN.md` §4 and `CLAUDE.md` say reserved members throw `PluginApiNotImplemented`,
    and the header of `packages/plugin-sdk/src/harness.ts` says so of edit contexts and
    object types; both doors register.
  - `DESIGN.md` §4.3a and §4.3c describe a wire stamped 0.51; it is 0.71.8 and has every
    operation listed there.
  - `DESIGN.md` §13.4 says the editor serves no font bytes; it answers from the engine
    (`editor: apps/canvas/src/plugin-asset-source.ts`).
  - `docs/reference/wasm-packaging.md` gives `engine` modules a 64 MiB ceiling in §1 and
    calls the loader `host.loadBundleWasm`.

## Not built

- A second host implementation. `createBundleHost` is the only one: there is no RPC or
  isolate proxy, no code that loads a bundle from a URL, and no signature check
  ([ADR 319](adr/319-trust-line.md)).
- Restriction of `mutate` to the subtree of the active edit context, in this adapter.
- The bake loop. `ObjectTypeBaker` and `BakeContext` are types; nothing registers or calls
  a baker ([ADR 316](adr/316-native-content-and-baking.md)).
- A GPU device door: `capabilities.gpu.realm: "shared"` is rejected. `DESIGN.md` §17.
- `secrets.get` and a host-side fetch, both absent on purpose (`DESIGN.md` §16, §4.6b).
- A packaging step in the CLI: `integrity` stamps checksums and `modules-upload` hosts the
  wasm, but `validate` / `integrity` / `modules-upload` are run by each plugin's own publish
  workflow, not by a `paged-plugin package`.
- A host-side loader for wasm-bindgen modules, and a `wasm.load@1` feature name.
- A release lane other than `canary`: `publish.yml` publishes with `--tag canary` only.

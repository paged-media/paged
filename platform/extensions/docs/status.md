# Status

What the plugin contract ships and what it does not, read from the code at commit `d90f727`:
`@paged-media/plugin-api` and `@paged-media/plugin-sdk` 0.2.37-canary.0,
`@paged-media/plugin-cli` 0.1.4, API version 0.2.0, engine wire types from
`@paged-media/canvas-wasm` 0.64.0. How the parts fit is in [`architecture.md`](architecture.md).

## Shipped

- **Three npm packages**, published under the `canary` tag on a push to `main`.
- **The contract** (`plugin-api`, types only): the manifest types and their JSON Schema
  (exported as `./manifest.schema.json`), `PagedBundle`, `BundleHost` with 26 members, the
  contribution shapes, the panel schema, binding providers, and the engine's wire types.
- **The loader.** `loadBundle` checks trust, id and `apiVersion`, builds the host, calls
  `activate` inside a guard, and returns a handle whose `dispose` removes what the bundle
  registered. `defineBundle`, `API_VERSION` and `satisfiesApiVersion` come with it.
- **The host adapter.** `createBundleHost` implements every door in the table in
  `architecture.md`, with the namespace rule and the capability gate (`enforce` by
  default). `supports()` knows 37 names that are always true and 23 that depend on what
  the host wires or, for `gpu@1`, on the manifest. In groups:
  - contributions: tools, React and schema panels, commands, key bindings, menu entries,
    overlays and tool previews, edit contexts with pointer, key, commit, cancel and undo
    hooks, object types, binding providers, importers, exporters and scene layers;
  - document access: typed reads, one write path with engine-owned undo, the plugin's own
    element metadata, parts inside the document file, the engine's native document parts;
  - services that are live when the host app passes a backend: file pick and save, a byte
    store, the clipboard, network consent, the data-provider registry, workers, credentials
    by reference, font and image bytes, image tiles, text measurement and the text caret,
    diagnostics, the journal, and a code-editor widget.
- **For bundle authors:** `DisposableStore`, the page-drag gesture helpers, and
  `createHeadlessHost`, which runs a bundle in Node against the real engine.
- **Manifest validation.** `paged-plugin validate` checks the schema rules, the namespace
  rule, that `*.panel.json` files exist, and wasm names, paths and sizes.
- **Guards in CI:** the vendored wire types and catalog must match the published engine; a
  source change in `plugin-api` or `plugin-sdk` must carry a version bump; the schema, the
  TypeScript unions and the CLI must agree on the closed vocabularies; the built
  `plugin-sdk` must contain no static and no awaited import of React.

## Limits of what is shipped

- **In-process, first-party only.** `loadBundle` accepts no `trust` other than
  `"first-party"`. The code states that the capability gate prevents accidents and is not a
  security boundary, because `host.editor` hands a bundle the raw editor handle
  (`packages/plugin-sdk/src/host-impl.ts:204-208`). In `warn` mode a violation is logged.
- **Scope values are not interpreted.** The gate tests whether `document.read` and
  `document.write` are declared; the adapter treats `"scoped"` and `"broad"` alike. In
  `apiVersion` a range is `*`, an exact version or a caret; a caret on `0.x` fixes the minor.
- **Validated, but acted on by nothing in this repo:** `capabilities.editContext`, the
  `priority` of an edit-context declaration, `contributes.partTypes`, the `bakedFallback`
  of an object type, and `*.panel.json` panel paths (the CLI checks that the file exists).
- **`host.parts` is scoped by path.** The adapter confines a bundle to
  `paged/<manifest.id>/` and, on a write, names the caller to the engine.
- **`loadBundleWasm` has no caller** in the editor or in any first-party plugin. Each plugin
  loads its wasm with its own generated glue, so the host grant, the load-time budget and
  the memory ceiling apply to no shipped module. The byte ceilings here are 100 MB each; the
  sum for the whole app is checked in the editor.
- **The headless host** loads one bundle at a time through its own `loadBundle` method, which
  checks the `apiVersion` range and calls `activate`. It wires no scene-layer or tile channel, no
  text shaper, and no shell, consent, data-provider, worker, native-document, journal, widget or
  diagnostics backend. Menu entries are not recorded; gestures are not replayed.
- **Doors without a first-party user.** None of the eight first-party bundle manifests
  declares `secrets` or `keybindings`. The editor passes no `journal` option to `loadBundle`
  (`editor: apps/canvas/src/main.tsx:1251-1285`), so `host.journal` records nothing there.
- **Present but unused.** The vendored `catalog.json` is checked in CI but is not in the
  published package and no source file imports it. `scripts/assert-dist-tags.mjs` is run by
  no workflow. `PluginApiNotImplemented` is exported and never thrown. `plugin-cli` has no
  test suite of its own; two specs in `plugin-sdk` run it as a subprocess.
- **Text in this repo that lags the code.** `README.md` says nothing is published and that
  a sibling editor checkout is required. `DESIGN.md` §4 and `CLAUDE.md` say reserved members
  throw `PluginApiNotImplemented`, and the header of `packages/plugin-sdk/src/harness.ts`
  says so of edit contexts and object types; both doors register. `DESIGN.md` §4.3a and
  §4.3c describe a wire stamped 0.51; it is 0.64.0 and has every operation listed there.
  `DESIGN.md` §13.4 says the editor serves no font bytes; it now answers from the engine
  (`editor: apps/canvas/src/plugin-asset-source.ts`). `docs/reference/wasm-packaging.md`
  gives `engine` modules a 64 MiB ceiling in §1 and calls the loader `host.loadBundleWasm`.

## Not built

- A second host implementation. `createBundleHost` is the only one: there is no RPC or
  isolate proxy, no code that loads a bundle from a URL, and no signature check
  ([ADR 319](adr/319-trust-line.md)).
- Restriction of `mutate` to the subtree of the active edit context, in this adapter.
- The bake loop. `ObjectTypeBaker` and `BakeContext` are types; nothing registers or calls
  a baker ([ADR 316](adr/316-native-content-and-baking.md)).
- A way for a bundle to enter an edit context itself (`entry` is only `"doubleClick"`), and
  a GPU device door (`capabilities.gpu.realm: "shared"` is rejected). `DESIGN.md` §19, §17.
- `secrets.get` and a host-side fetch, both absent on purpose (`DESIGN.md` §16, §4.6b).
- CLI commands other than `validate`: no packaging step and no artifact checksums.
- A host-side loader for wasm-bindgen modules, and a `wasm.load@1` feature name.
- A release lane other than `canary`: `publish.yml` publishes with `--tag canary` only.

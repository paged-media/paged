# Documentation

What this folder holds. The long description of the plugin contract, door by door, is not
here: it is [`../DESIGN.md`](../DESIGN.md) at the repository root.

- [`concept.md`](concept.md): why the repository exists, what it is for, and what it will
  never do.
- [`architecture.md`](architecture.md): how it is built. The three packages, the path from a
  manifest to a running bundle, what every door checks, a table of the doors the contract
  offers, where a plugin's data is kept, the engine boundary, the headless test host, and
  how it is built, tested and released.
- [`status.md`](status.md): what ships today, the limits of what ships, and what is not
  built.
- [`adr/`](adr/README.md): the decision records of this repository, 010, 012, 017 and
  300–319.
- [`design/credential-store.md`](design/credential-store.md): design note for the
  credential store behind `host.secrets`.
- [`design/data-provider.md`](design/data-provider.md): design note for the cross-plugin
  data-provider registry behind `host.dataProviders`.
- [`design/network-consent.md`](design/network-consent.md): design note for the network
  consent door, `host.network`.
- [`design/worker-capability.md`](design/worker-capability.md): design note for
  host-spawned workers, `host.workers`.
- [`reference/trust-gate.md`](reference/trust-gate.md): the conditions for loading bundles
  that are not first-party, and the reasoning behind them.
- [`reference/wasm-packaging.md`](reference/wasm-packaging.md): how a bundle declares and
  ships its own WebAssembly, with the budget table.

The four design notes were written before the code. Where a note and the code differ, the
ADRs and `status.md` say what was built.

## Decisions in other repositories that bind this one

These records live in other public paged-media repositories. The code here rests on each of
them. The last column says what the decision means for this repository.

| ADR | Repository | Decision | What it means here |
|---|---|---|---|
| [005](https://github.com/paged-media/core/blob/main/docs/adr/005-wire-recipe.md) | core | The wire recipe: every operation self-describing and invertible | `packages/plugin-api/src/mutations.ts` re-exports the engine's `Mutation`, `Operation`, `PropertyPath` and `Value` from the vendored wire types. `host.document.mutate` forwards a `Mutation` unchanged, and `undo` and `redo` call the engine: this repository keeps no inverse and no history of its own. |
| [006](https://github.com/paged-media/core/blob/main/docs/adr/006-protocol-coupled-versioning.md) | core | Protocol-coupled package versioning (`0.<protocol>.<patch>`) | `packages/plugin-sdk/src/wasm-loader.ts` reads the protocol number out of the engine package version stamped in `packages/plugin-api/src/wire.d.ts` and refuses to run a wasm that reports another. The devDependency on `@paged-media/canvas-wasm` and the stamp are both `0.64.0` at commit `d90f727`. The versions of the packages published from here are not coupled to the protocol. |
| [008](https://github.com/paged-media/core/blob/main/docs/adr/008-read-surfaces-first-class-wire-collections.md) | core | Read surfaces as first-class wire collections | `host.document.collection(name)` and `meta()` forward to the engine client and return what the engine serves; `CollectionName` and `DocumentMeta` are vendored types. `parentOf` is computed in the adapter, from the scene tree the engine returns. |
| [013](https://github.com/paged-media/core/blob/main/docs/adr/013-in-frame-scenelayer.md) | core | In-frame plugin rendering via `SceneLayer` | `host.contribute.sceneLayer()` (`packages/plugin-api/src/host.ts:472-495`) is the door to it, gated on `capabilities.rendering` including `sceneLayer`. The adapter forwards the layer to the editor's scene channel together with the manifest id of the submitting plugin. The `SceneLayer` item types are vendored. |
| [018](https://github.com/paged-media/core/blob/main/docs/adr/018-stage-b-gpu-texture-defer-record-only.md) | core | C-1 Stage B (shared GPUDevice + plugin GPUTexture): record-only deferral | `capabilities.gpu` accepts only `realm: "bundle"`; the schema and the CLI reject `"shared"`. `BundleHost` has no GPU member, and `supports("gpu@1")` reflects the declaration (`packages/plugin-sdk/src/host-impl.ts:3174-3182`). |
| [019](https://github.com/paged-media/core/blob/main/docs/adr/019-capability-catalog-one-contract.md) | core | Capability catalog: one generated contract, projected to every surface | `scripts/sync-catalog.mjs` vendors the engine's `catalog.json` into `packages/plugin-api/src/`, and `.github/workflows/publish.yml` fails when the copy differs from the published one without a reason recorded in `packages/plugin-api/catalog.provenance.json`. `packages/plugin-sdk/test/capability-vocabulary.spec.ts` applies the same rule to the manifest: the schema is the one source, and the TypeScript unions and the CLI are checked against it. |
| [113](https://github.com/paged-media/core/blob/main/docs/adr/113-one-typed-door.md) | core | One typed door drives every surface: wasm, CLI, session and scripts | The headless host sends JSON envelopes to the engine's `handleMessage` (`packages/plugin-sdk/src/harness.ts:332-340`), the door the editor's worker uses. That is why a bundle tested in Node exercises the engine path it meets in the editor. |
| [118](https://github.com/paged-media/core/blob/main/docs/adr/118-paged-file-is-a-valid-idml-package.md) | core | A `.paged` file is a ZIP that stays a valid IDML package | `host.parts` reads and writes bytes under `paged/<manifest.id>/` in that container through the engine's part messages (`packages/plugin-sdk/src/host-impl.ts:2665-2730`). `contributes.partTypes` declares the part types a plugin keeps there, and `host.nativeDocument` reads the engine's own parts under `paged/core/`. |
| [023](https://github.com/paged-media/editor/blob/main/docs/adr/023-shared-panels-binding-providers.md) | editor | Shared panels: the host owns the panel, plugins provide the values | The plugin half of that decision is in this repository: the types in `packages/plugin-api/src/binding-provider.ts`, the door `host.contribute.bindingProvider`, and `createBindingProviderRegistry`, which the host app creates once and passes to every bundle host. A provider is active only while its edit context is. |
| [024](https://github.com/paged-media/editor/blob/main/docs/adr/024-context-sensitivity-is-a-core-concept.md) | editor | Context-sensitivity is a core concept of paged | `EditContextContribution` (`packages/plugin-api/src/host.ts:118`) carries what the shell switches on entry: tool ids, panel ids and the hooks of the session. `entry` has the single value `"doubleClick"`, and a menu entry can be scoped to one edit context. The shell owns the context stack; the adapter stamps the plugin's metadata key on the contribution and hands it to the shell's registry. |
| [201](https://github.com/paged-media/editor/blob/main/docs/adr/201-plugins-as-pinned-packages.md) | editor | First-party plugins are compiled in as pinned published packages | `loadBundle` takes a bundle object the host app has already imported and accepts only `trust: "first-party"` (`packages/plugin-sdk/src/load.ts:44-71`). Nothing in this repository fetches or dynamically imports a bundle. The editor pins both packages to one exact version (`editor: apps/canvas/package.json:36-37`), which decides the host adapter every bundle runs against. |
| [203](https://github.com/paged-media/editor/blob/main/docs/adr/203-shell-is-a-registry-host.md) | editor | The shell is an app-agnostic registry host: the app declares, the shell renders | Each `host.contribute.*` call ends in `register` on a registry of the editor handle. `ShellRegistries` in `packages/plugin-api/src/editor.ts:440-463` names the registries the contract needs; five of them are optional there, so that a host without one stays valid and the door degrades. |

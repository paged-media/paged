# Architecture

How the plugin contract and its tooling are built, at commit `d90f727`. This page is an
orientation. The long description of the contract, door by door, is
[`../DESIGN.md`](../DESIGN.md), cited below by section (§); the reason behind each choice is
in an ADR under [`adr/`](adr/README.md). Where `DESIGN.md` and the code differ, this page
follows the code, and [`status.md`](status.md) lists the differences.

Three words are used throughout. A **bundle** is one plugin: a manifest plus an `activate`
function. The **host** is the object a bundle receives when it is activated. A **door** is
one member of that object. Within a package's paragraph, `src/…` is relative to that package.

## Packages

A pnpm workspace with three packages under `packages/`: two in TypeScript and a plain-JavaScript CLI. No wasm is built here.

**`packages/plugin-api`** — published as `@paged-media/plugin-api`. The contract, as types
only: every hand-written file exports only `type` and `interface` declarations, and the
build writes `export {};` as the package's only JavaScript
([ADR 300](adr/300-type-only-contract.md)). It holds the manifest (`src/manifest.ts`,
`src/manifest.schema.json`; [ADR 303](adr/303-manifest-schema.md)), the lifecycle
(`src/bundle.ts`), the host and its surfaces (`src/host.ts`, with `src/panel-schema.ts`,
`src/binding-provider.ts`, `src/assets.ts`, `src/clipboard.ts`, `src/widgets.ts`), the
hand-written, deliberately narrow editor handle and the contribution shapes
(`src/editor.ts`), and the engine wire types: `src/wire.d.ts` is a verbatim copy of the type
declarations of the published `@paged-media/canvas-wasm`, re-exported in curated form by
`src/mutations.ts` ([ADR 302](adr/302-vendored-wire-types.md)).

**`packages/plugin-sdk`** — published as `@paged-media/plugin-sdk`. Everything that exists
at run time. `src/host-impl.ts` is the whole host adapter in one file: `createBundleHost`
builds a `BundleHost` over a function that returns the editor handle
([ADR 301](adr/301-host-adapter-lives-in-plugin-sdk.md)). `src/load.ts` is `loadBundle`;
`src/version.ts` holds `API_VERSION` and the range check; `src/harness.ts` and
`src/wasm-loader.ts` are the headless test host; `src/wasm-bundle-loader.ts` is
`loadBundleWasm`; the remaining modules are small helpers for bundle authors. React is
imported at run time in one module, `src/react-optional.ts`, and the package loads without
it ([ADR 313](adr/313-no-react-at-load.md)).

**`packages/plugin-cli`** — published as `@paged-media/plugin-cli`. One file,
`bin/paged-plugin.mjs`, one command (`validate`), no dependencies and no build step.

`plugin-sdk` depends on `plugin-api` and takes React as an optional peer; `plugin-api`
depends only on `@types/react`. `plugin-cli` imports nothing from the other two: it repeats
the manifest rules by hand, and `packages/plugin-sdk/test/capability-vocabulary.spec.ts`
fails when its vocabularies or the TypeScript unions differ from `manifest.schema.json`. No
package depends on the editor or the engine at run time; the harness uses the devDependency
`@paged-media/canvas-wasm`.

## From manifest to a running bundle

```
manifest.json ── paged-plugin validate ──> errors, or "valid"            (author's build)

host app:  loadBundle(getEditor, bundle, options)          packages/plugin-sdk/src/load.ts
   1. options.trust must be "first-party" (the default)
   2. manifest.id must be reverse-DNS
   3. manifest.apiVersion must accept API_VERSION ("0.2.0")
   4. createBundleHost(getEditor, manifest, options) -> { host, dispose }
   5. bundle.activate(host), inside try/catch
   6. returns { id, active, activationError?, dispose }

bundle:    host.contribute.tool(c)                    packages/plugin-sdk/src/host-impl.ts
   namespace rule -> capability gate -> getEditor().registries.tools.register(c)
   -> the registration is added to the host's DisposableStore

bundle:    host.document.mutate(m)
   capability gate -> metadata-key check -> getEditor().client.mutate(m)
   -> { applied: true, createdId, pageIds }  or  { applied: false, error }
```

Steps 1 to 3 throw. Step 5 does not: when `activate` throws, `loadBundle` reports the
failure to the `journal` and `diagnosticsSink` options if the host app passed them, disposes
the host, and returns a handle with `active: false` and the error in `activationError`.
Disposing a loaded bundle calls the bundle's own disposer and then, in a `finally`, the
host's store, which undoes the registrations in reverse order
([ADR 304](adr/304-bundle-lifecycle.md), [ADR 319](adr/319-trust-line.md)). `activate` is
synchronous, and there is no global object: the host is what a bundle is given (§2, §8).

## What every door does

A door in `createBundleHost` applies up to three checks, in this order.

1. **Namespace.** An id a bundle registers (tool, panel, command, overlay, importer,
   exporter, journal code) must start with `<manifest.id>.`. Edit-context and object-type
   names are content-type names and are exempt.
2. **Capability.** The use must be declared in the manifest. Under the default
   `capabilityMode: "enforce"` an undeclared use throws `PluginCapabilityError`, except
   `document.mutate` and `setMetadata`, which return `{ applied: false, error }`. Under
   `"warn"` the adapter logs and proceeds. A `mutate` carrying a `setPluginMetadata` for
   another plugin's key is refused in both modes, also inside a batch
   ([ADR 010](adr/010-raw-mutate-gate-capability-enforcement.md), §11).
3. **Backend.** Many doors need something the host app passes in `CreateBundleHostOptions`
   or exposes on the editor handle. `BundleHost` has no optional members: without a backend
   the door still exists and answers `null`, `[]`, `false`, a rejected promise or a logged
   no-op. `host.supports("area.member@major")` answers from `HOST_FEATURES`, 37 names this
   SDK always implements, plus up to 23 names added only when the matching backend or
   declaration is present ([ADR 305](adr/305-doors-always-present.md), §4.8).

The adapter imports no editor code. From the handle `getEditor()` returns it uses
`registries` (where contributions go), `client` (the engine: `mutate`, `undo`, `redo`, `send`,
`subscribe`, typed reads), `selection`, `camera`, `overlaySignals`, and the optional `text`,
`sceneLayers` and `images`.

## The doors the contract offers

`BundleHost` (`packages/plugin-api/src/host.ts`) has 27 members. "Declaration" is what
the capability gate requires in the manifest. "Flag" is the `supports()` name that is true
only when the host wires the backend.

| Door | What it is for | Declaration | Flag | Detail |
|---|---|---|---|---|
| `manifest`, `log` | the bundle's own manifest; a logger prefixed with its id | none | | §4.1 |
| `contribute.tool`, `panel`, `command` | register a tool, a React panel, a command | id listed in `contributes.tools` / `panels` / `commands` | | §4.2 |
| `contribute.schemaPanel`, `bindings` | a panel described as data, and the named values its rows read | id listed in `contributes.panels` | `schemaPanel.renderer@1` | §12, [ADR 312](adr/312-panels-as-data.md) |
| `contribute.keybinding` | register a key binding | `capabilities.keybindings: true` | | §11 |
| `contribute.menu` | a menu entry for one of the bundle's commands, for the document or for one edit context | the command listed in `contributes.commands` | | `packages/plugin-api/src/host.ts:341` |
| `contribute.overlay`, `overlay.setToolPreview`, `setToolPreviews`, `layer` | an overlay, the preview shapes a tool draws while dragging, and retained data-only layers of the bundle's own | `rendering` includes `overlay` | `overlay.multiPreview@1`, `overlay.layers@1` | §4.5, §4.5a, §4.5d |
| `contribute.editContext`, `objectType` | claim a content type that is entered by double-click (the entering point included); recognise a frame as that type by its metadata | the type listed in `contributes.editContexts` / `objectTypes` | `editContext.enterPoint@1` | §4.2, §19, [ADR 012](adr/012-k1-modal-session-undo-coalescing.md) |
| `contribute.bindingProvider` | answer the values of host-owned panels while one of the bundle's edit contexts is active | that edit context's declaration | `bindings.provider@1` | §18 |
| `contribute.importer`, `exporter` | take the bytes of an opened file by extension; produce bytes for export | id listed in `contributes.importers` / `exporters` | | [ADR 017](adr/017-importer-exporter-door-shape.md) |
| `contribute.sceneLayer()` | submit or clear vector content drawn inside a frame (text in the face each item names, with the fallbacks reported); submit one image and patch tiles of it, as bytes where the host has the binary lane | `rendering` includes `sceneLayer` | `rendering.sceneLayer@1`, `rendering.sceneLayer.binary@1`, `rendering.sceneLayer.faces@1` | [ADR 320](adr/320-binary-lanes-for-scene-images-and-parts.md) |
| `document` reads | collections, meta, scene tree, parent, path anchors, geometry, properties, planar regions, placeholders, frame chain, story content, own metadata (on an element, and on the document: `getDocumentMetadata`, flag `document.documentMetadata@1`), change events; `onDidOpen` (a document became active, flag `document.onDidOpen@1`); `onWillSave` (awaited before a save, flag `document.onWillSave@1`, [ADR 322](adr/322-plugin-hooks-save-entry-tool-settings-undo-labels.md)) | `document.read`; `hitTest` also needs `rendering` includes `hitTest` | | §4.3, §4.3c, §4.3d |
| `document.mutate`, `mutateWithBytes`, `setMetadata`, `setDocumentMetadata`, `undo`, `redo` | the one write path (image bytes as a `Uint8Array` where the host has the binary lane), and the shared history | `document.write` | `document.mutateBinary@1` | §4.3, [ADR 310](adr/310-one-write-door.md), [ADR 320](adr/320-binary-lanes-for-scene-images-and-parts.md) |
| `selection`, `viewport` | read, observe and set the selection; camera snapshot, screen px to points | none; `selection.set` needs `document.write` | | §4.4 |
| `text` | measure a string; read the text caret | none | `text.measure@1`, `text.caret@1` | §4.5b |
| `shell` | open or close a panel; pick files in; hand bytes out to be saved; enter one of the bundle's own edit contexts | none | `shell.openPanel@1`, `shell.pickFile@1`, `shell.saveFile@1`, `shell.enterEditContext@1` | §4.5c, [ADR 322](adr/322-plugin-hooks-save-entry-tool-settings-undo-labels.md) |
| `storage` | JSON key-value per plugin | none | | §4.6 |
| `blob` | bytes per plugin, with a quota | `storage.blob: true` | `storage.blob@1` | `packages/plugin-api/src/host.ts:1254` |
| `parts` | bytes stored inside the document file; write, read, list, delete | scoped by path to `paged/<manifest.id>/` | `storage.parts@1`, `storage.parts@2` (delete) | `packages/plugin-api/src/host.ts:1281`, [ADR 311](adr/311-plugin-state-under-own-id.md) |
| `nativeDocument` | read the engine's own document parts; load a package as the active document | `document.readNative`; `open` needs `document.openNative` | `document.readNative@1`, `document.openNative@1` | §4.3b, [ADR 017](adr/017-importer-exporter-door-shape.md) |
| `network` | ask the user to allow origins; no fetch is offered | `network: true`, or `{ origins }` with a list or `"consent"` | `network.consent@1` | §4.6b |
| `dataProviders` | publish a dataset, or discover and read one, without the two plugins meeting | `dataProviders.publish` includes the category (to register); `dataProviders.consume` is declared (to discover or read) | `dataProviders@1` | §4.6c |
| `diagnostics` | findings per plugin, mirrored to the console | none | `diagnostics.publish@1` | §4.7 |
| `journal` | record a namespaced event or a timing | none | `journal@1` | `packages/plugin-api/src/host.ts:1486` |
| `widgets` | a code editor component and a colour picker; a plain textarea and a native colour input without a host catalog | none | `widgets.codeEditor@1`, `widgets.colorPicker@1` | [ADR 321](adr/321-host-colour-picker-widget.md) |
| `tools` | read the option values the host holds for the bundle's own tools, and observe changes | the tool id is namespaced under the manifest id | `tools.settings@1` | [ADR 322](adr/322-plugin-hooks-save-entry-tool-settings-undo-labels.md) |
| `assets` | bytes of a document font face; original bytes of a placed image; register a face that only scene-layer text resolves (`registerFont`, the one write) | `assets` includes `fonts` / `images` | `assets.fonts@1`, `assets.registerFont@1` | §13, §13.6 |
| `images` | serve tiles of a placed image to the renderer on request | `rendering` includes `resourceProvider` | `rendering.resourceProvider@1` | `packages/plugin-api/src/host.ts:497` |
| `workers` | spawn a worker through the host; allocate shared memory under a budget | `workers` | `workers@1` | §15, [ADR 318](adr/318-host-spawned-workers.md) |
| `secrets` | `set`, `exists`, `forget` a credential by reference; there is no `get` | `secrets.sources: true` | `secrets@1` | §16 |
| `clipboard` | read and write text and a cell grid | `clipboard: "full"`, or `"vector"` for text only | `clipboard@1` | §14 |
| `supports`, `editor` | the feature probe; the raw editor handle, kept as an escape hatch | none | | §4.8, §4.9 |

Three manifest capabilities have no door. `capabilities.wasm` lists the wasm modules a
bundle ships; it is checked by the CLI and by `loadBundleWasm`, a plain export of
`plugin-sdk` ([ADR 308](adr/308-plugin-wasm.md),
[`reference/wasm-packaging.md`](reference/wasm-packaging.md)). `capabilities.gpu` declares
that the bundle uses WebGPU in its own realm; `supports("gpu@1")` reflects it (§17).
`capabilities.editContext` is accepted by the schema and the CLI and read by nothing in the
adapter; the gate uses `contributes.editContexts`.

## Where a plugin's data is kept

Diagnostics and published bindings live in memory, per host. For data that lasts, the adapter
gives a bundle four places, each keyed by the full manifest id
([ADR 311](adr/311-plugin-state-under-own-id.md)):

- **Element metadata.** `document.setMetadata` sends a `setPluginMetadata` mutation with
  the key `x-paged:<manifest.id>`, through the same path as `mutate`; `getMetadata` reads
  it back from the element's properties.
- **Document metadata.** `document.setDocumentMetadata` sends a `setDocumentMetadata`
  mutation under the same key, for state that belongs to no frame; it is undoable and fires
  `onDidChange`. `getDocumentMetadata` reads it from the document meta. From protocol 70 an
  IDML export keeps it as a `Properties/Label` entry on the designmap's `Document`.
- **Container parts.** `host.parts` sends part messages to the engine with every path
  prefixed `paged/<manifest.id>/`. These bytes travel with the document file.
- **Key-value.** `host.storage` keeps JSON under `paged.plugin.<manifest.id>.` in the
  backing the host app passes, else `localStorage`, else an in-memory map.
- **Blobs.** `host.blob` goes to the store the host app passes. The quota is the smaller of
  64 MiB and the manifest's `storage.quotaBytes`.

## The engine boundary

The contract is written against two packages that `core` publishes, not against a checkout.
`scripts/sync-wire.mjs` copies the type declarations of the installed
`@paged-media/canvas-wasm` to `packages/plugin-api/src/wire.d.ts` and stamps the package
version in the header (`0.64.0` at this commit). With `--check` it fails when the content or
the stamp differ from the installed package, or when the package cannot be found.
`scripts/sync-catalog.mjs` vendors `catalog.json` from `@paged-media/introspect-wasm` and has
the same `--check`. An operation the engine has but the published types lack is accepted
through `PendingMutation` in `packages/plugin-api/src/mutations.ts`; at this commit every
member is already part of `Mutation`.

The engine package's minor version is the wire protocol number, a rule set in `core`
([ADR 006](https://github.com/paged-media/core/blob/main/docs/adr/006-protocol-coupled-versioning.md)).
`packages/plugin-sdk/src/wasm-loader.ts` derives the expected protocol from the stamp and
refuses to run a wasm that reports another.

## The headless host

`createHeadlessHost` (`packages/plugin-sdk/src/harness.ts`) lets a plugin repo test a bundle
in Node. It boots the installed `@paged-media/canvas-wasm` through the loader's synchronous
`initSync`, builds an editor handle whose `client` sends each request through the wasm's
`handleMessage`, and runs the same `createBundleHost` on top. Document, selection, undo and
metadata calls therefore reach a real engine, while recording registries keep what the
bundle contributes for a test to assert on. A loaded bundle is held to its manifest
([ADR 309](adr/309-conformance-against-real-engine.md), §5).

## The editor, the plugins and the documentation site

- **`editor`** (the host app). It calls `loadBundle` once per bundle and passes the
  backends: `shell`, `widgets`, `assetSource`, `blobStore`, `clipboard`, `textCaret`,
  `workers`, `dataProviders`, `bindingProviders`, `consent`, `secrets`, `nativeDocument`,
  `diagnosticsSink`, `schemaPanelRenderer` and a per-plugin `console`
  (`editor: apps/canvas/src/main.tsx:1251-1285`). `editor: apps/canvas/src/plugin-api-compat.ts`
  asserts at type level that the editor's real handle and registries satisfy
  `packages/plugin-api/src/editor.ts`.
- **Plugin repositories.** A bundle imports types from `plugin-api` and helpers from
  `plugin-sdk`, both as peer dependencies ([ADR 307](adr/307-contract-as-peer-dependency.md)).
- **`docs`.** `.github/workflows/notify-docs.yml` pings it when the manifest schema changes.

## Build, test, release

- `pnpm install && pnpm -r typecheck` checks all packages. `pnpm -r build` emits
  declarations for `plugin-api` (`tsc`) and an ES2020 ESM bundle for `plugin-sdk` (`tsup`).
  In development the packages resolve to `src`; `publishConfig` switches them to `dist`.
- Tests are vitest, all in `packages/plugin-sdk/test` (35 spec files): the adapter against
  a fake editor, the harness against the real engine, the CLI as a subprocess, the two sync
  scripts, and the built `dist`. `.github/workflows/vitest.yml` runs them.
- `.github/workflows/contract-guard.yml` requires that a change under
  `packages/plugin-api/src` or `packages/plugin-sdk/src` comes with a version change.
- `.github/workflows/publish.yml` runs on every push to `main`: typecheck, build, test, the
  two `--check` gates against a scratch install of the stamped engine version, then
  `npm publish --tag canary` for each package whose version is not on the registry yet
  ([ADR 306](adr/306-canary-releases.md)).

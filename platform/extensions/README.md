# paged-media/plugin-sdk

Plugin contract + tooling for the Paged editor. One public package,
`@paged-media/plugin-sdk`: the runtime (with the `paged-plugin` bin) and, as its
type-only `./api` entry, the contract. The contract's source is the private
`@paged-media/plugin-api` workspace package, which plugin-sdk's build inlines
([PM-0008, amendment 3](../../docs/adr/PM-0008-npm-packages-and-release.md)). An
extension imports its types from `@paged-media/plugin-sdk/api`, its values from
`@paged-media/plugin-sdk`, and depends on plugin-sdk alone (a peer dependency;
`paged-plugin init` writes one). The first-party packages built on them, `paged-node` (`@paged-media/cli`, now
`apps/cli`) and `@paged-media/ai` (now `platform/shared/ai`), lived here until
wave C.

| Package                                                                       | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Tier                      |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `@paged-media/plugin-sdk/api` (source: the private `@paged-media/plugin-api`) | the contract: manifest types + schema (`./api/manifest.schema.json`), bundle lifecycle (`PagedBundle` / `BundleHandle`), the full `BundleHost` surface, the object model's types, curated type re-exports of the contribution + wire surface. **Type-only.**                                                                                                                                                                                                                                                                                                                 | frozen at v1 (v0.2 today) |
| `@paged-media/plugin-sdk`                                                     | the runtime: `createBundleHost` (in-process host adapter), `loadBundle` (apiVersion negotiation + teardown), the object registry behind `host.objects`, the headless host `createHeadlessHost`, the gesture kit, the gesture TEST kit (`createFakeEditor`, the gesture DSL `gestures()`, pointer tapes, the gesture invariants), `DisposableStore`, `API_VERSION`, `defineBundle`; and the `paged-plugin` bin: `init [dir]` (a minimal extension), `validate <manifest.json>` (manifest schema, namespace and object-model checks), `untyped`, `integrity`, `modules-upload` | stable, faster-moving     |

**Declarations.** From 0.2.71 the published declarations of `plugin-api` and `plugin-sdk`
are emitted by TypeScript 7 (`tsc --emitDeclarationOnly`). `plugin-sdk` ships one `.d.ts`
per module instead of a single bundled `index.d.ts`, with the same exported types; its
JavaScript is bundled by `bun build`
([the migration note](../../docs/migration/typescript-7.md)).

**Testing a tool.** A tool's `gesture()` handler is tested without an editor:
`createFakeEditor()` records everything a handler does (registrations, mutations,
the gesture channel, overlay previews, selection, commands), and the gesture DSL
drives the handler in document points, as the editor's gesture spine would.
The same DSL drives the handler against the real engine through the headless
host (`gestures({ editor: headless.host.editor, pages })`), where
`checkUndoRedo` / `checkCancel` compare model dumps. Every DSL run is also a
replayable pointer tape (`g.tape()`, `replayTape`).

```ts
const fake = createFakeEditor();
const mark = fake.mark();
await gestures(fake)
  .tool(myTool)
  .drag({ from: [72, 72], to: [216, 144], mods: ["shift"] });
expectOneCommit(fake, mark); // INV-1: one gesture, one commit
```

The full API deliberation — tenets, area-by-area rationale, RPC-readiness
audit, rejected alternatives, freeze policy — is in **`DESIGN.md`**.

Note: the npm name `@paged-media/sdk` belonged to the **viewer session**
(`engine/core/crates/paged-sdk`, WebGPU read-only renderer), now
`@paged-media/viewer/session` — the plugin runtime is `plugin-sdk`,
deliberately.

## React 19

From 0.2.79 the contract is typed against React 19 ([PM-0008](../../docs/adr/PM-0008-npm-packages-and-release.md),
amendment 2): `plugin-api` depends on `@types/react` ^19.3, and `plugin-sdk`'s optional React
peer, like every built-in bundle's, is `react >=19.3`. The editor provides React 19.3.1. For an
extension with React panels:

- Declare `react` (and `react-dom`, if you use it) as a peer `>=19.3`, and develop against
  `@types/react` 19.
- `ref` is a plain prop of a function component; `forwardRef` still works but is no longer
  needed.
- `useRef` takes an argument (`useRef<HTMLDivElement>(null)`). A ref callback may return a
  cleanup function, so an arrow with an implicit return (`ref={(el) => (node = el)}`) is a type
  error: give it a block body.
- `ReactElement`'s props default to `unknown`, and the global `JSX` namespace is gone: write
  `React.JSX.Element`.
- `react-test-renderer` is deprecated: test panels with `@testing-library/react` in a DOM
  environment (happy-dom).

React's upgrade guide covers the rest: https://react.dev/blog/2024/04/25/react-19-upgrade-guide.

## Documentation

How the contract is designed and built is in [`docs/`](./docs/README.md) and in
[`DESIGN.md`](./DESIGN.md):

- [`docs/concept.md`](./docs/concept.md): what the plugin contract is for and what it will never do.
- [`docs/architecture.md`](./docs/architecture.md): the five packages and the doors the contract offers, with pointers into `DESIGN.md`.
- [`docs/status.md`](./docs/status.md): what ships today and what does not.
- [`docs/adr/`](./docs/adr/README.md): the architecture decisions, one per file, including those every plugin repository shares (314–319).

## Status

`plugin-sdk` is one of the three public npm packages of this repository
([PM-0008](../../docs/adr/PM-0008-npm-packages-and-release.md), amendment 3): a
release tag `v0.<protocol>.<patch>` publishes it, at the tag's version, with the
engine's `@paged-media/paged` and `@paged-media/viewer`
(`.github/workflows/release.yml`). It ships the `paged-plugin` bin, which was the
`@paged-media/plugin-cli` package, and the contract as `./api`, which was the
`@paged-media/plugin-api` package. The in-tree versions (`0.2.N-canary.0`) count
contract changes for the contract guard; they are not the published versions. A
change under `packages/plugin-api/src` or `packages/plugin-sdk/src` moves
plugin-sdk's version, the contract's one public number, and plugin-api's private
version moves with it to the same value (`scripts/assert-contract-bumped.mjs`).
The engine's wire types and capability catalog are vendored from the workspace's
`@paged-media/canvas-wasm` (its `./introspect/catalog.json`)
([ADR 302](./docs/adr/302-vendored-wire-types.md)). What ships and what does not
is in [`docs/status.md`](./docs/status.md).

```bash
bun install
bun run typecheck
node packages/plugin-sdk/bin/paged-plugin.mjs validate <path/to/manifest.json>
```

## License

Dual-licensed **AGPL-3.0-only OR the Paged Media Enterprise License (PMEL)**,
like the rest of the repository (ADR PM-0001). Versions published before the
relicense remain available under MPL-2.0 OR PMEL. See [`LICENSE.md`](./LICENSE.md),
the full AGPL-3.0 text in [`LICENSE`](../../LICENSE), and
[`CONTRIBUTING.md`](./CONTRIBUTING.md) (contributions under a CLA).

`SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-PMEL`

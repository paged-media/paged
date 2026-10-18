# paged-media/plugin-sdk

Plugin contract + tooling for the Paged editor. Five packages: the contract,
its runtime and the manifest CLI in three stability tiers, and two packages
built on them.

| Package                   | Contents                                                                                                                                                                                                                                                          | Tier                      |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `@paged-media/plugin-api` | the contract: manifest types + schema, bundle lifecycle (`PagedBundle` / `BundleHandle`), the full `BundleHost` surface, the object model's types, curated type re-exports of the contribution + wire surface. **Type-only.**                                     | frozen at v1 (v0.2 today) |
| `@paged-media/plugin-sdk` | the runtime: `createBundleHost` (in-process host adapter), `loadBundle` (apiVersion negotiation + teardown), the object registry behind `host.objects`, the headless host `createHeadlessHost`, the gesture kit, `DisposableStore`, `API_VERSION`, `defineBundle` | stable, faster-moving     |
| `@paged-media/plugin-cli` | `paged-plugin validate <manifest.json>` (manifest schema, namespace and object-model checks), `untyped`, `integrity`, `modules-upload`                                                                                                                            | tooling cadence           |
| `@paged-media/cli`        | `paged-node`: get, set, query, batch, export and more over core and every installed bundle, through the headless host ([ADR 324](./docs/adr/324-node-cli-over-the-headless-host.md)). A private workspace package (PM-0008).                                      | tooling cadence           |
| `@paged-media/ai`         | Claude for paged: the model, prompt, tools and loop behind `paged-node ai` ([ADR 325](./docs/adr/325-claude-agent-package.md)). A private workspace package (PM-0008).                                                                                            | tooling cadence           |

**Declarations.** From 0.2.71 the published declarations of `plugin-api` and `plugin-sdk`
are emitted by TypeScript 7 (`tsc --emitDeclarationOnly`). `plugin-sdk` ships one `.d.ts`
per module instead of a single bundled `index.d.ts`, with the same exported types; its
JavaScript is bundled by `bun build`
([the migration note](../../docs/migration/typescript-7.md)).

The full API deliberation — tenets, area-by-area rationale, RPC-readiness
audit, rejected alternatives, freeze policy — is in **`DESIGN.md`**.

Note: the npm name `@paged-media/sdk` belongs to the **viewer session**
(`core/crates/paged-sdk`, WebGPU read-only renderer) — the plugin runtime is
`plugin-sdk`, deliberately.

## Documentation

How the contract is designed and built is in [`docs/`](./docs/README.md) and in
[`DESIGN.md`](./DESIGN.md):

- [`docs/concept.md`](./docs/concept.md): what the plugin contract is for and what it will never do.
- [`docs/architecture.md`](./docs/architecture.md): the five packages and the doors the contract offers, with pointers into `DESIGN.md`.
- [`docs/status.md`](./docs/status.md): what ships today and what does not.
- [`docs/adr/`](./docs/adr/README.md): the architecture decisions, one per file, including those every plugin repository shares (314–319).

## Status

`plugin-api`, `plugin-sdk` and `plugin-cli` are published under the `canary`
dist-tag on every merge to `main` that bumps a version
([ADR 306](./docs/adr/306-canary-releases.md)). The workspace builds on its own:
the engine's wire types and capability catalog are vendored from the published
`@paged-media/canvas-wasm` and `@paged-media/introspect-wasm`
([ADR 302](./docs/adr/302-vendored-wire-types.md)), and the tests run against
the published engine. What ships and what does not is in
[`docs/status.md`](./docs/status.md).

```bash
bun install
bun run typecheck
node packages/plugin-cli/bin/paged-plugin.mjs validate <path/to/manifest.json>
```

## License

Dual-licensed **AGPL-3.0-only OR the Paged Media Enterprise License (PMEL)**,
like the rest of the repository (ADR PM-0001). Versions published before the
relicense remain available under MPL-2.0 OR PMEL. See [`LICENSE.md`](./LICENSE.md),
the full AGPL-3.0 text in [`LICENSE`](../../LICENSE), and
[`CONTRIBUTING.md`](./CONTRIBUTING.md) (contributions under a CLA).

`SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-PMEL`

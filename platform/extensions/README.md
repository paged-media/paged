# paged-media/plugin-sdk

Plugin contract + tooling for the Paged editor. Three packages, three
stability tiers (concept: `thoughts/docs/paged/plugin-draw/base-idea.md` §9,
reality: `thoughts/docs/paged/plugin-draw/reality-check.md`):

| Package | Contents | Tier |
|---|---|---|
| `@paged-media/plugin-api` | the contract: manifest types + schema, bundle lifecycle (`PagedBundle` / `BundleHandle`), the full `BundleHost` surface (contribute / document / selection / viewport / overlay / storage / diagnostics / supports), curated type re-exports of the contribution + wire surface. **Type-only.** | frozen at v1 (v0.2 today) |
| `@paged-media/plugin-sdk` | the runtime: `createBundleHost` (in-process host adapter), `loadBundle` (apiVersion negotiation + teardown), the gesture kit (`beginPageDrag` / `endLocalFor` / `pxToPt` / `commitAndSelect`), `DisposableStore`, `API_VERSION`, `defineBundle`; headless harness reserved | stable, faster-moving |
| `@paged-media/plugin-cli` | `paged-plugin validate <manifest.json>` — manifest schema + namespace checks | tooling cadence |

The full API deliberation — tenets, area-by-area rationale, RPC-readiness
audit, rejected alternatives, freeze policy — is in **`DESIGN.md`**.

Note: the npm name `@paged-media/sdk` belongs to the **viewer session**
(`core/crates/paged-sdk`, WebGPU read-only renderer) — the plugin runtime is
`plugin-sdk`, deliberately.

## Status: API v0 (incubation)

Nothing is published yet. During the instability window the **editor is the
source of truth** and `plugin-api` is a curated façade over
`@paged-media/shell` + `@paged-media/client`, consumed via pnpm `link:`
sibling deps. A sibling checkout layout is required:

```
~/paged/
├── editor/      ← link: targets resolve here (run `pnpm install` there first)
├── plugin-sdk/  ← this repo
└── plugin-draw/ (+ plugin-web/)
```

```bash
pnpm install
pnpm -r typecheck
node packages/plugin-cli/bin/paged-plugin.mjs validate <path/to/manifest.json>
```

First consumer: `paged-media/plugin-draw` (the paged.draw bundle). API gaps
found there land in its `BREAKAGE_LOG.md` — that log is the v1 punch list.

## License

Dual-licensed **MPL-2.0 OR the Paged Media Enterprise License (PMEL)** —
deliberately permissive (unlike the AGPL editor) so plugins built on this SDK
can carry any license. See [`LICENSE.md`](./LICENSE.md), [`LICENSE`](./LICENSE),
and [`CONTRIBUTING.md`](./CONTRIBUTING.md) (contributions under a CLA).

`SPDX-License-Identifier: MPL-2.0 OR LicenseRef-PMEL`

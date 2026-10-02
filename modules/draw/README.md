# paged-media/plugin-draw

**paged.draw** — the vector-illustration plugin for the Paged editor, and the
forcing function for the plugin platform. Concept:
`thoughts/docs/paged/plugin-draw/base-idea.md`; verified reality + strategy:
`thoughts/docs/paged/plugin-draw/reality-check.md`.

Strategy: **incubate-then-extract.** Draw capability grows as host-agnostic
packages here; the editor consumes the published bundle and wraps the
machines in thin gesture-handler shims. Gaps in the plugin surface are
recorded in the cross-repo RFI
(`thoughts/docs/paged/plugin-platform/rfi-core-sdk-gaps.md`); the full
state of the plugin against its concept is
`thoughts/docs/paged/plugin-draw/analysis-2026-10-02.md`. `CLAUDE.md` is
the detailed orientation for this repo.

## Packages

| Package | Contents |
|---|---|
| `@paged-media/draw-geometry` | pure path math, zero deps: Bézier split / closest-t / flatten, RDP, compound winding, arc-length placement, affine, SVG path / arc / document parsing |
| `@paged-media/draw-tools` | host-agnostic state machines (pen, anchor edit, pencil, curvature, brush, width, shape builder, live paint, measure, corner radius, repeat) — points in, snapshots and plans out |
| `@paged-media/draw` (`packages/draw-bundle`) | the published bundle: `manifest.json` (id `media.paged.draw` — 19 tools, 10 panels, 92 commands, SVG import/export, 7 `.paged` part types) + `activate(host)`, gesture handlers, commands, panels |
| `crates/draw-trace`, `crates/trace-js` | the Image Trace kernel (Rust → wasm, over `visioncortex`); the built artifact is committed in `packages/draw-bundle/wasm/` |

`panels/*.panel.json` are **design prototypes** (not interpreted by any
host).

## Setup

No sibling checkout is needed: the plugin contract
(`@paged-media/plugin-api`, `@paged-media/plugin-sdk`) and the engine
(`@paged-media/canvas-wasm`) are published packages, pinned in
`packages/draw-bundle/package.json`.

```bash
pnpm install
pnpm test           # contract-import lint + vitest in every package
pnpm typecheck      # includes the wire-compat assertions against plugin-api
pnpm bench          # geometry benches (trended, never gated)
node ../plugin-sdk/packages/plugin-cli/bin/paged-plugin.mjs validate packages/draw-bundle/manifest.json
```

## Tests

- **Machines and geometry** — unit specs beside each package; no host.
- **Conformance** (`packages/draw-bundle/test/conformance/`) — every spec
  boots the REAL engine wasm headlessly (`createHeadlessHost`) and drives
  the bundle's own handlers and commands against it, asserting the
  resulting document and that undo restores it. `test/engine-pin.spec.ts`
  pins the booted engine to the version `package.json` names.
- **Perf budgets** (`packages/draw-bundle/test/perf/`) — work COUNTED at
  the host doors (engine round trips, mutations, preview publishes), not
  timed. A budget is the measured value and only ever goes down.
- **Real artwork** — `PAGED_SVG_CORPUS=1 pnpm --filter @paged-media/draw test`
  parses the private corpus's SVGs and checks `.ai` / `.eps` are refused
  rather than half-read.

CI (`.github/workflows/vitest.yml`) runs all of it on every pull request
and fails on red; nothing publishes from a red suite.

## License

Dual-licensed **AGPL-3.0 OR the Paged Media Enterprise License (PMEL)** —
the same as the paged editor (a plugin is part of the editor app). The engine
(`paged-media/core`) and the plugin SDK (`paged-media/plugin-sdk`) it builds on
are MPL-2.0 OR PMEL. See [`LICENSE.md`](./LICENSE.md), [`LICENSE`](./LICENSE),
and [`CONTRIBUTING.md`](./CONTRIBUTING.md) (contributions under a CLA).

`SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-PMEL`

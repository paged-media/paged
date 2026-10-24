# paged-media/plugin-draw

**paged.draw** — the vector-illustration plugin for the Paged editor, and the
forcing function for the plugin platform. Concept:
[`docs/concept.md`](./docs/concept.md).

Strategy: **incubate-then-extract.** Draw capability grows as host-agnostic
packages here; the editor consumes the published bundle and wraps the
machines in thin gesture-handler shims. Gaps in the plugin surface are
recorded in the internal gap register. `CLAUDE.md` is the detailed
orientation for this repo.

## Documentation

Everything about how the plugin is designed and built is in [`docs/`](./docs/README.md):

- [`docs/concept.md`](./docs/concept.md): the capability specification, with notes on what was built.
- [`docs/architecture.md`](./docs/architecture.md): packages, how drawing reaches the document, host doors.
- [`docs/status.md`](./docs/status.md): what ships today and what does not.
- [`docs/adr/`](./docs/adr/README.md): the architecture decisions, one per file.

`docs/status.md` is the current record of what ships; the sections below are older in places.

## Packages

| Package                                      | Contents                                                                                                                                                                                                               |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@paged-media/draw-geometry`                 | pure path math, zero deps: Bézier split / closest-t / flatten, RDP, compound winding, arc-length placement, affine, SVG path / arc / document parsing                                                                  |
| `@paged-media/draw-tools`                    | host-agnostic state machines (pen, anchor edit, pencil, curvature, brush, width, shape builder, live paint, measure, corner radius, repeat, scrub, reflect, reshape, star, flare) — points in, snapshots and plans out |
| `@paged-media/draw` (`packages/draw-bundle`) | the published bundle: `manifest.json` (id `media.paged.draw` — 27 tools, 10 panels, 127 commands, SVG import/export, 7 `.paged` part types) + `activate(host)`, gesture handlers, commands, panels                     |
| `crates/draw-trace`, `crates/trace-js`       | the Image Trace kernel (Rust → wasm, over `visioncortex`); `scripts/build-wasm.sh` (`moon run draw:wasm`) builds it into `packages/draw-bundle/wasm/` (gitignored)                                                     |

`panels/*.panel.json` are **design prototypes** (not interpreted by any
host).

## Setup

No sibling checkout is needed: the plugin contract
(`@paged-media/plugin-api`, `@paged-media/plugin-sdk`) and the engine
(`@paged-media/canvas-wasm`) are workspace packages (`workspace:*` in
`packages/draw-bundle/package.json`). The module is built into the editor and is not
published to npm.

```bash
bun install
bun run test           # bun test in every package (+ draw-bundle's DOM task); the import rule is lint (root: bun run lint)
bun run typecheck      # the machines' wire shapes are the contract's Mutation variants
bun run bench          # geometry benches (trended, never gated)
node ../../platform/extensions/packages/plugin-cli/bin/paged-plugin.mjs validate packages/draw-bundle/manifest.json
```

## Tests

[`docs/testing.md`](docs/testing.md) has the layers and what each asserts, per
contribution.

- **Machines and geometry** — unit specs beside each package; no host.
- **Commands, tools, tool options** (`packages/draw-bundle/test/commands/`,
  `test/tool-gestures.spec.ts`, `test/tool-options.spec.ts`) — the real bundle over a
  fake document, no engine: what each sends, as how many undo steps, and what it refuses.
- **Conformance** (`packages/draw-bundle/test/headless/`) — every spec
  boots the REAL engine wasm headlessly (`createHeadlessHost`) and drives
  the bundle's own handlers and commands against it, asserting the
  resulting document and that undo restores it. `test/engine-pin.spec.ts`
  pins the booted engine to the version `package.json` names.
- **Perf budgets** (`packages/draw-bundle/test/perf/`) — work COUNTED at
  the host doors (engine round trips, mutations, preview publishes), not
  timed. A budget is the measured value and only ever goes down.
- **Real artwork** — `PAGED_SVG_CORPUS=1 bun run --filter @paged-media/draw test`
  parses the private corpus's SVGs and checks `.ai` / `.eps` are refused
  rather than half-read.

CI (`.github/workflows/draw-vitest.yml`) runs all of it on every pull request
and fails on red; nothing publishes from a red suite.

## License

Dual-licensed **AGPL-3.0 OR the Paged Media Enterprise License (PMEL)** —
the same as the paged editor (a plugin is part of the editor app), the engine
and the extension SDK it builds on (ADR PM-0001). See [`LICENSE.md`](./LICENSE.md), [`LICENSE`](./LICENSE),
and [`CONTRIBUTING.md`](./CONTRIBUTING.md) (contributions under a CLA).

`SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-PMEL`

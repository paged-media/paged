# paged-media/plugin-draw

**paged.draw** — the vector-illustration plugin for the Paged editor, and the
forcing function for the plugin platform. Concept:
`thoughts/docs/paged/plugin-draw/base-idea.md`; verified reality + strategy:
`thoughts/docs/paged/plugin-draw/reality-check.md`.

Strategy: **incubate-then-extract.** Draw capability grows as host-agnostic
packages here while the editor consumes them through thin gesture-handler
shims; the bundle (`activate(host)`) takes over registration at milestone D3.
`BREAKAGE_LOG.md` records every place the plugin surface fell short — it is
the API-v1 punch list.

## Packages

| Package | Contents |
|---|---|
| `@paged-media/draw-geometry` | pure path math, zero deps: RDP, de Casteljau split, closest-t, flatten, constrain, handle derivation, affine |
| `@paged-media/draw-tools` | host-agnostic state machines: `PenMachine` (full modifier matrix), anchor-edit planning (add/delete/convert incl. closing-edge subpath bookkeeping) |
| `@paged-media/draw-bundle` | `manifest.json` (id `media.paged.draw`) + `activate(host)` skeleton (registers at D3) |

`panels/*.panel.json` are **design prototypes** (not interpreted by any
host) — the paper's §8 schema rewritten against the catalog's real binding
ceiling; the P4 test corpus.

## Setup

Sibling checkout layout required (pnpm `link:` deps into `../plugin-sdk`, which
links into `../editor` — install order: editor → plugin-sdk → here):

```bash
cd ~/paged/editor && pnpm install
cd ~/paged/plugin-sdk && pnpm install
cd ~/paged/plugin-draw && pnpm install
pnpm -r test        # vitest — pure machines + the headless conformance corpus
pnpm -r typecheck   # includes the wire-compat assertions against plugin-api
node ../plugin-sdk/packages/plugin-cli/bin/paged-plugin.mjs validate packages/draw-bundle/manifest.json
```

### Conformance corpus (W4.15)

`draw-bundle/test/` carries a headless **conformance-fixture replay
harness** on the B-13 foundation (`@paged-media/plugin-sdk`'s
`createHeadlessHost` — the published engine wasm booted in Node):

- `fixtures/build-idml.ts` — a pure-TS IDML package builder (no `zip`
  CLI, deterministic bytes); `fixtures/corpus.ts` — named multi-shape
  documents (F1 rect + open polygon + line, F2 closed quad, F3
  curved-open).
- `replay.ts` — records a `GesturePlan` (`{ tool, click, tolerance }`,
  the anchor machines' deterministic output) and replays it through
  `host.document.mutate` using the bundle's OWN `mutationFor`, asserting
  the resulting anchor table **and** that one undo restores the baseline.
- `conformance/*.spec.ts` — per-fixture assertions (geometry round-trips;
  add / delete / convert plan shapes incl. closing-edge add + the delete
  floor; plugin-metadata persistence across mutate + undo + the namespace
  gate). One wasm boot per spec-file (the host supports reload).

Residuals + the corpus findings (rectangle-vs-polygon metadata carrier;
rectangles expose no `pathAnchors`) are tracked under **B-13** in
`BREAKAGE_LOG.md`. Pointer-event-level gesture replay stays gated on
**B-17**.

## Milestones

- **D1 — done** — geometry + machines extracted, tested standalone; the
  editor's pencil re-imports RDP from here.
- **D2 — done** — pen + add/delete/convert-anchor live in the editor as
  shims over `draw-tools` (E2E: editor `tests/e2e/draw-plugin.spec.ts`).
- **D3 — done** — `drawBundle.activate(host)` registers the three
  `media.paged.draw.tool.*` anchor-editing tools (with activation
  commands + guarded shortcuts via `contributeTool`) through
  `@paged-media/plugin-sdk` 0.2; the editor loads the bundle with one
  `loadBundle()` call and removing it removes draw cleanly (B-11
  resolved). The Pen itself is a built-in core-document tool (editor
  W2.5 division): built-ins author new paths, the bundle edits them.

## License

Dual-licensed **AGPL-3.0 OR the Paged Media Enterprise License (PMEL)** —
the same as the paged editor (a plugin is part of the editor app). The engine
(`paged-media/core`) and the plugin SDK (`paged-media/plugin-sdk`) it builds on
are MPL-2.0 OR PMEL. See [`LICENSE.md`](./LICENSE.md), [`LICENSE`](./LICENSE),
and [`CONTRIBUTING.md`](./CONTRIBUTING.md) (contributions under a CLA).

`SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-PMEL`

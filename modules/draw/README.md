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

Sibling checkout layout required (pnpm `link:` deps into `../sdk`, which
links into `../editor` — install order: editor → sdk → here):

```bash
cd ~/paged/editor && pnpm install
cd ~/paged/sdk && pnpm install
cd ~/paged/plugin-draw && pnpm install
pnpm -r test        # vitest — pure machines, no host needed
pnpm -r typecheck   # includes the wire-compat assertions against plugin-api
node ../sdk/packages/plugin-cli/bin/paged-plugin.mjs validate packages/draw-bundle/manifest.json
```

## Milestones

- **D1** — geometry + machines extracted, tested standalone; the editor's
  pencil re-imports RDP from here. *(this scaffold)*
- **D2** — pen + add/delete/convert-anchor live in the editor as shims over
  `draw-tools`.
- **D3** — registration moves to `drawBundle.activate(host)` under the
  `media.paged.draw.*` ids; removing the call removes draw cleanly. Gated on
  BREAKAGE_LOG B-11.

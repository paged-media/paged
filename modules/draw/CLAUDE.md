# CLAUDE.md

Orientation for Claude sessions in **paged-media/plugin-draw** — the
paged.draw vector plugin (private, proprietary, And The Next GmbH; no
license headers).

## What this is

The distillation repo for draw capability during the
incubate-then-extract window (strategy:
`thoughts/docs/paged/plugin-draw/reality-check.md`). Three packages:
`draw-geometry` (pure math), `draw-tools` (host-agnostic state machines),
`draw-bundle` (manifest + `activate(host)`). The editor consumes
geometry/tools via pnpm `link:` and wraps the machines in thin
`GestureHandler` shims.

## Hard rules

- **Host-agnostic means host-agnostic.** `draw-geometry` has zero deps;
  `draw-tools` may import ONLY `draw-geometry` + *types* from
  `@paged-media/plugin-api`. Never import `@paged-media/shell` /
  `@paged-media/client` / React here — that's the editor shim's job. If a
  machine seems to need host state, the missing piece is an event/option
  on the machine API or a `BREAKAGE_LOG.md` entry.
- **`@paged-media/plugin-api` is the only sanctioned contract import.**
  A need it can't meet goes to `BREAKAGE_LOG.md` (numbered `B-NN`); the
  log is the API-v1 punch list — keep it current, mark entries RESOLVED
  with a pointer when host/core work lands.
- **Machines stay pure + unit-tested.** Page-local pt in, snapshots/plans
  out; tolerances are passed in (the host converts px→pt at zoom). Every
  behavior change lands with a vitest case (`packages/*/test/`).
- **Wire compatibility is asserted, not assumed.**
  `draw-tools/src/wire-compat.ts` type-asserts machine output against the
  engine wire types; a protocol break fails `pnpm typecheck` here. Don't
  delete those assertions to make a build green — they're the §12.3 alarm.
- **`panels/*.panel.json` are design prototypes.** Not interpreted by any
  host; keep them honest against the catalog's binding ceiling (no
  invented conditionals).
- **Install order:** editor → plugin-sdk → plugin-draw (`link:` chain).

## Commands

```bash
pnpm install && pnpm -r test && pnpm -r typecheck
node ../plugin-sdk/packages/plugin-cli/bin/paged-plugin.mjs validate packages/draw-bundle/manifest.json
```

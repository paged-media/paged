# CLAUDE.md

Orientation for Claude sessions in **paged-media/editor** — the closed
commercial frontend for the `paged` IDML engine. Terse by design;
read the root `README.md` for the longer picture and
`apps/canvas/README.md` for canvas-app internals.

## What this is

Public, **dual-licensed AGPL-3.0 OR PMEL** (And The Next GmbH). The editor
is a networked app, so the open side is **AGPL** (§13 network copyleft).
The engine is under the same terms since the monorepo relicense (ADR
PM-0001; it was MPL-2.0 OR PMEL before). (This repo was proprietary / All-Rights-Reserved and private
until 2026-06-22, when it was opened.)

- **License headers apply to every source file** (AGPL Exhibit-style notice
  - PMEL, pointing at LICENSE.md). New source files carry it — copy it
    verbatim from the top of any existing source file, or see `CONTRIBUTING.md`.
- This repo consumes the engine **across a package boundary** — the
  published `@paged-media` wasm/SDK packages — **never** a Rust path
  dependency, and never reaches into core's source tree.

## Workspace layout (Bun)

`apps/*` + `packages/*`, members of the repository's root Bun workspace
(`/package.json` `workspaces`, one `/bun.lock`). React 18 + Vite + TS +
Tailwind.

- `apps/canvas` (`paged-canvas`) — the editor app. React shell →
  Web Worker → engine wasm on `OffscreenCanvas` (Vello/WebGPU, tiny-skia
  CPU fallback). Owns `src/panels/*`, the REPL (`src/repl/`), the
  script editor, and the Playwright suite (`tests/`).
- `apps/devtools` (`paged-devtools`) — standalone scene-graph
  inspector over `paged-introspect-wasm` (its own `build-wasm.sh`).
- `packages/client` (`@paged-media/client`) — **the only wasm/engine
  boundary.** `CanvasClient`, tsify wire types (`protocol.ts`), SAB
  primitives (`sab/camera`, `sab/gesture`). No React, no DOM beyond
  Worker + SAB.
- `packages/catalog` (`@paged-media/catalog`) — declarative
  command/panel catalog (bindings + composition nodes). Deps: client.
- `packages/shell` (`@paged-media/shell`) — editor shell: state
  contexts, registries, dockview docking substrate, overlays, command
  palette, `PagedShell`. Deps: client + catalog + ui, and the type-only
  `plugin-api`: its registry types extend the contract's contribution
  types instead of copying them (ADR 226).
- `packages/ui` (`@paged-media/ui`) — input primitives. Deps: shell.

Consumer→producer: `canvas → shell → catalog → client → [wasm]`;
`ui → shell`.

## Hard rules

### Workers must DEEP-IMPORT primitives — never the shell barrel

A web worker that imports through the `@paged-media/shell` barrel
**hangs at startup**: the barrel pulls in React, which a worker has no
business loading. This was a real bug. In worker code, import SAB /
protocol / primitive symbols directly from `@paged-media/client` (its
barrel is React-free by lint), or deep-import the specific module —
**never** route worker imports through `@paged-media/shell`.

### wasm / SDK boundary (workspace packages)

The engine's wasm packages are **workspace packages** of the root Bun
workspace: `packages/client` and `apps/canvas` depend on
`@paged-media/canvas-wasm`, `packages/repository` on its `./repo` entry and
`apps/devtools` on its `./introspect` entry, all through `workspace:*`
(`engine/core/packages/canvas-wasm`, engine/core ADR 185, PM-0008). Their generated files
(the glue, the `.d.ts`, the wasm) are gitignored and built from the engine
in the same checkout: `moon run core:wasm-pkg`, or
`bash engine/core/scripts/build-wasm-packages.sh --workspace`
(wasm-bindgen-cli at the Cargo.lock version and binaryen;
`tooling/bootstrap.sh` checks both). CI restores them with
`.github/actions/engine-wasm`.

- **Version convention**: the packages are versioned
  `0.<protocol>.0-dev`, with the protocol taken from
  `crates/paged-canvas/src/channel.rs`; `protocol.ts` READS
  `PROTOCOL_VERSION` from the package version's minor (no hand-kept copy).
  The worker handshake still refuses a wasm whose own protocol differs
  (`protocolMismatch`, fatal).
- **Engine changes** reach the editor in the same commit: change the
  engine, rebuild the packages, and the editor typechecks and runs against
  them. A protocol bump moves the package versions
  (`node engine/core/scripts/check-wasm-package-versions.mjs --write`)
  and `bun.lock`.
- **Plugin bundles** (`@paged-media/draw`, `image`, `sheet`, `data`,
  `web`, `doc`, `slide`, `pdf`, `publish`) and the contract
  (`plugin-api`, `plugin-sdk`) are workspace packages too, consumed from
  source. A bundle whose engine wasm is a build output (doc, slide, sheet,
  data, web) needs its module's `scripts/build-wasm.sh` before the app boots.
- The wasm asset loads in vite via explicit `?url` imports passed to
  the loader's `default({ module_or_path })` — don't revert to the
  bare loader default (it resolves relative to node_modules and
  breaks worker chunks).

### `paged.*` scripting global

The engine's `paged-script` crate registers a global `paged.*`
(`paged.set`, `paged.frame`, `paged.inspect`, …), evaluated inside the
worker's embedded **Boa** engine. Every script write lands as a
`Mutation` on the same Operation channel as gestures and panels, so
edits are undoable. The script-editor panel
(`apps/canvas/src/panels/script-editor.tsx`) and
`tests/script-editor.spec.ts` drive it end-to-end.

## Tests

Playwright lives in `apps/canvas/tests/`: per-panel behaviour specs +
an end-to-end **fidelity** suite (per-page PNG diff, ΔE2000/SSIM,
against InDesign reference PDFs).

```bash
cd apps/canvas                  # after `bun install` and `moon run core:wasm-pkg`
                                # (the engine wasm is built from the tree)
bun run test:fidelity              # full gate
BACKEND=gpu bun run test:fidelity  # WebGPU/Vello path (headed; CPU fallback)
```

The Vite dev server (spawned/reused by Playwright) sets the COOP/COEP
headers `SharedArrayBuffer` needs.

## Design system (the publishing cockpit)

The visual + UX source of truth is the **`paged-media/brand`** repo
(`~/paged/brand/editor` locally): tokens (`colors_and_type.css`),
content rules (sentence case, mono tabular values, **no emoji**),
the clean-room icon system, and the cockpit UI kit
(`ui_kits/editor/`). In this repo:

- **Tokens** live in `packages/shell/src/styles/theme.css` — the
  `--paged-*` shadcn channels plus resolved layers (`--chrome-*`,
  `--status-*`, `--overlay-*`, `--pg-*`, rhythm/motion). Never
  hardcode hexes in chrome/panels; swatch/ink CONTENT colours stay
  literal by design. **Dark is the default theme** (ThemeProvider,
  `paged.theme`); dockview bridges via `dockview-theme-paged`.
- **SVG overlays** author `stroke="var(--overlay-*)"` attributes;
  presentation attributes can't resolve `var()`, so globals.css
  re-applies each token through attribute-selector rules
  (`overlay-tokens.spec.ts` guards this). Selection = magenta,
  guides = violet — the DTP cues.
- **Fonts**: IBM Plex Sans/Mono self-hosted via fontsource;
  Cormorant only for the `paged.` wordmark (`.pg-wordmark`).
- **Icons**: three registries (`tool-`/`panel-`/`ui-*`) in
  `packages/shell/src/icons/` — 24×24 line SVG, currentColor,
  1.5–1.9 stroke. Author new glyphs to those rules; never emoji or
  third-party sets.
- **Workflow modes**: six cockpit modes registered through
  `registries/mode.ts` (apps declare `toolbarLeft` + `panelSet`;
  the shell renders ModeSwitcher/ContextToolbar/PanelRail and
  parks per-mode layouts under `paged.layout.mode.<id>`). New
  product surfaces without engine support ship as VISIBLE stubs
  (`ComingSoon` in `components/cockpit/kit.tsx`), never
  fake-interactive.

## Conventions

- **Don't loosen fidelity thresholds to hide a regression.** Thresholds
  (`corpus/envato/canvas-fidelity-thresholds.json`) are sized to
  measurements + headroom. Fix the regression; tighten after, never
  before.
- **`bun fmt` formats everything; CI checks it.** Run
  `tooling/js/fmt.sh` (or let the pre-commit hook format what you stage);
  `/.prettierignore` lists what it leaves alone, with the reasons.
- **Comments earn their place** — narrate the WHY for a non-obvious
  IDML/wasm/SAB constraint or a worked-around upstream bug; otherwise
  let the code speak.

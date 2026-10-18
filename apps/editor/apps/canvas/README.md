# `apps/canvas/` — IDML Web Canvas

Phase-1 viewer for IDML documents. React + Vite shell driving a Web
Worker that runs Vello on WebGPU through an `OffscreenCanvas`.

## Architecture (one paragraph)

The main thread owns the React UI, the camera transform (written via
`SharedArrayBuffer`), pointer events, and the navigator. It does no
rendering work. The dedicated worker (`src/worker/worker.ts`) owns
the `OffscreenCanvas`, the WASM bundle (`paged-canvas-wasm`), the
WebGPU device, the Vello renderer, and a per-page Vello scene cache
(LRU, 200-page default budget). The camera SAB is read once per
render-loop tick (`setTimeout`, 16 ms cadence) and the scene cache is
composed onto the surface via `Scene::append`. When WebGPU isn't
available the worker silently falls back to a tiny-skia CPU path
backed by a 2D `OffscreenCanvasRenderingContext2D`. Full architecture
spec lives at `core: docs/design/canvas.md`.

## Setup

The engine's wasm comes from `engine/core` in the same checkout, as the
workspace package `@paged-media/canvas-wasm` (engine/core ADR 185). One-time,
from the repository root:

```bash
tooling/bootstrap.sh --check   # wasm-bindgen-cli at the Cargo.lock version, binaryen
bun install
moon run core:wasm-pkg         # or: bash engine/core/scripts/build-wasm-packages.sh --workspace
```

Rebuild the packages after an engine change. `src/protocol.ts` reads the
wire protocol from the package version (`0.<protocol>.0-dev`), and the worker
refuses a wasm whose protocol differs.

## Run

```bash
cd apps/editor/apps/canvas
bun run dev
```

Opens at <http://localhost:5173/>. The Vite dev server sets the
COOP / COEP headers required by `SharedArrayBuffer`.

## Production build

```bash
bun run build
```

Emits `dist/`. The same COOP / COEP headers must be set in
production for the camera SAB to allocate — otherwise the
`CameraBuffer` falls back to a non-shared `ArrayBuffer` and the
worker may see torn reads under contention (spec §12.4).

## Shortcuts

| Key | Action |
|---|---|
| Pointer drag (LMB) | Pan |
| Ctrl/Cmd + wheel | Zoom-to-cursor |
| Wheel (no modifier) | Pan via deltaX/Y |
| Click | Hit-test → frame selection |
| Cmd/Ctrl + 0 | Fit-to-document (animated) |
| Cmd/Ctrl + 1 | 100 % zoom centred on viewport |
| Page Down | Next page (animated fit) |
| Page Up | Previous page (animated fit) |
| Home / End | First / last page |

## HUD

The bottom-right HUD shows:

| Field | Meaning |
|---|---|
| `GPU` / `CPU` badge | Renderer backend (green = WebGPU, amber = CPU fallback) |
| `N fps` | Main-thread rAF cadence (proxy for perceived smoothness) |
| `N pages` | Loaded page count |
| `XX%` | Camera scale |
| `tx, ty` | Camera translation in CSS pixels |
| `frame XXX` | Self attribute of the most recently clicked frame |

## File layout

```
src/
  channel/
    camera.ts        SAB camera contract (CameraBuffer)
    client.ts        CanvasClient — main-thread worker handle
    protocol.ts      Typed wire-format envelopes
  ui/
    CanvasApp.tsx    Shell — composes Navigator + ViewportCanvas
    ViewportCanvas.tsx  <canvas> + transferControlToOffscreen
    Navigator.tsx    Side panel thumbnails
    Overlay.tsx      SVG layer (selection chrome + page captions)
    layout.ts        Document-space page layout + camera math
    useAnimatedCamera.ts  rAF-driven camera tween
    useFps.ts        rAF-based FPS counter
    useKeyboardShortcuts.ts  Window-level keybindings
  worker/
    worker.ts        Worker entry — channel dispatch + canvas attach
    render.ts        WorkerRenderer — setTimeout loop + tile cache
  wasm/              build-wasm.sh output (gitignored)
  main.tsx           React root
```

## Known gaps (Phase 1 → Phase 2)

- **Text glyphs**: the fixture used for development has no fonts
  loaded; text won't render until a font resolver is wired through.
- **Tier 3 resolution**: anchor + field model + page-number assigner
  exist (`crates/paged-canvas/src/resolve.rs`) but aren't yet wired
  into the display list. Phase 2's parser-side work emits `Field`
  placeholders that the resolver substitutes.
- **Cross-page features**: footnotes, running headers, computed
  TOCs all depend on the Phase 2 parser work above.
- **Sub-page tile cache**: the Vello scene cache is per-page;
  Decision Checkpoint #1 (256 × 256 vs page-aligned) lands when
  perf data justifies it.

## Testing

```bash
# Rust unit tests on the canvas crates
cargo test -p paged-canvas -p paged-canvas-wasm -p paged-renderer -p paged-scene

# TypeScript typecheck
npx tsc --noEmit

# Production bundle
npx vite build
```

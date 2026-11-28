# @paged-media/viewer

Standalone IDML viewer for the browser — camera, pages, input lanes and
events over the engine's WebGPU `ViewerSession`, which ships in this package
as `@paged-media/viewer/session`. Rendering is WebGPU-only (the session
rejects without `navigator.gpu`).

```ts
import {
  createViewer,
  createSessionFromBundledWasm,
} from "@paged-media/viewer";

const viewer = await createViewer({
  canvas: document.querySelector("canvas")!,
  session: createSessionFromBundledWasm, // wasm ships inside this package
});

viewer.on("pageChanged", ({ page }) => console.log("page", page + 1));
await viewer.load("/files/brochure.idml"); // URL | ArrayBuffer | Uint8Array | Blob
```

## Surface

- **Load** — `load(source)`, repeatable; failures throw a `ViewerError`
  with `code: "PARSE_ERROR" | "UNSUPPORTED" | "GPU_UNAVAILABLE"` and the
  engine's structured diagnostics attached. A load still pending when the
  viewer is disposed, or when a later `load` starts, settles without effect.
- **Camera** — `zoom`, `setZoom(z, { anchor })`, `zoomIn/zoomOut`,
  `fit("page" | "width")`, `minZoom/maxZoom`, `scroll`, `scrollTo`,
  `scrollBy`. Zooming about an anchor keeps the document point under it
  fixed.
- **Pages** — `pageCount`, `currentPage`, `goToPage(n)`,
  `layoutMode("single" | "continuous")`,
  `renderPageThumbnail(n, { width })` (RGBA8 readback).
- **Events** — `on("loaded" | "pageChanged" | "zoomChanged" |
"scrollChanged" | "error", cb)` → unsubscribe function.
- **Input** — wheel and trackpad-pinch zoom-to-cursor, drag-pan (mouse,
  pen, one finger), two-finger pinch zoom on touch screens, double-click
  zoom, keyboard (`+`/`-`/`0`, arrows, PgUp/PgDn, Home/End); each lane
  disableable via `input: {...}`. While the pointer lanes are on, the
  canvas has `touch-action: none`.
- **Size** — the viewer follows the canvas's CSS size (`ResizeObserver`)
  and `window.devicePixelRatio` and presents again; `resize()` does the
  same on request. A `devicePixelRatio` option fixes the ratio.
- **Teardown** — `dispose()` detaches all listeners and frees the wasm
  session.

Fonts: register faces before `load` with
`viewer.registerFont(family, style, bytes)` — same contract as
`paged-inspect --font-family`.

Pages are drawn where the document places them: a vertical stack by
default, the pages of a spread side by side (`SessionPageRect.xPt`).

## Embedding your own session

`createViewer` takes any object satisfying `ViewerSessionLike` (the
typed contract of the wasm session), so you can init the wasm yourself
— e.g. from a custom URL or a worker — and hand it in. Tests do exactly
this with a fake.

The wasm exports most session methods under their Rust names
(`register_font`, `page_layout`, …). `ViewerSessionApi` is the same surface
in camelCase and `adaptSession(session)` returns it for either naming;
`createViewer` accepts both. The snake_case members of `ViewerSessionLike`
are marked `@deprecated` for direct calls and stay for as long as the wasm
exports them.

The session itself is the `./session` entry: the wasm-bindgen module of
the engine's `paged-sdk` crate, with its wasm at
`@paged-media/viewer/session/paged_sdk_bg.wasm`. It replaces the
`@paged-media/sdk` package (same API):

```ts
import init, { ViewerSession } from "@paged-media/viewer/session";
import wasmUrl from "@paged-media/viewer/session/paged_sdk_bg.wasm?url";

await init({ module_or_path: wasmUrl });
const session = await ViewerSession.new();
```

The session is renderer-core only: it links none of the engine's editing,
canvas, scripting or introspection crates. The release workflow checks
that (`engine/core/scripts/viewer-subset-audit.mjs`) before it publishes.

## In the repository

`dist/` (`bun run build`) and `wasm/` are build outputs. `wasm/` comes from
the engine: `bash engine/core/scripts/build-wasm-packages.sh --workspace
session` (or `moon run core:wasm-pkg`). The committed version is
`0.<protocol>.0-dev`; a release tag `v0.<protocol>.<patch>` publishes the
package at the tag's version.

## License

AGPL-3.0-only OR LicenseRef-PMEL — see `LICENSE.md` and `LICENSE` in this
package. Versions published before the relicense (ADR PM-0001) remain
available under MPL-2.0 OR LicenseRef-PMEL.

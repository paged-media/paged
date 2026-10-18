# @paged-media/idml-viewer

Standalone IDML viewer for the browser — camera, pages, input lanes and
events over the engine's WebGPU `ViewerSession`, which ships in this package
as `@paged-media/idml-viewer/session`. Rendering is WebGPU-only (the session
rejects without `navigator.gpu`).

```ts
import {
  createViewer,
  createSessionFromBundledWasm,
} from "@paged-media/idml-viewer";

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
  engine's structured diagnostics attached.
- **Camera** — `zoom`, `setZoom(z, { anchor })`, `zoomIn/zoomOut`,
  `fit("page" | "width")`, `minZoom/maxZoom`, `scroll`, `scrollTo`,
  `scrollBy`. Zooming about an anchor keeps the document point under it
  fixed.
- **Pages** — `pageCount`, `currentPage`, `goToPage(n)`,
  `layoutMode("single" | "continuous")`,
  `renderPageThumbnail(n, { width })` (RGBA8 readback).
- **Events** — `on("loaded" | "pageChanged" | "zoomChanged" |
"scrollChanged" | "error", cb)` → unsubscribe function.
- **Input** — wheel/pinch zoom-to-cursor, drag-pan, double-click zoom,
  keyboard (`+`/`-`/`0`, arrows, PgUp/PgDn, Home/End); each lane
  disableable via `input: {...}`.
- **Teardown** — `dispose()` detaches all listeners and frees the wasm
  session.

Fonts: register faces on the session before `load`
(`session.register_font(family, style, bytes)`) — same contract as
`paged-inspect --font-family`.

## Embedding your own session

`createViewer` takes any object satisfying `ViewerSessionLike` (the
typed contract of the wasm session), so you can init the wasm yourself
— e.g. from a custom URL or a worker — and hand it in. Tests do exactly
this with a fake.

The session itself is the `./session` entry: the wasm-bindgen module of
the engine's `paged-sdk` crate, with its wasm at
`@paged-media/idml-viewer/session/paged_sdk_bg.wasm`. It replaces the
`@paged-media/sdk` package (same API):

```ts
import init, { ViewerSession } from "@paged-media/idml-viewer/session";
import wasmUrl from "@paged-media/idml-viewer/session/paged_sdk_bg.wasm?url";

await init({ module_or_path: wasmUrl });
const session = await ViewerSession.new();
```

The session is renderer-core only: it links none of the engine's editing,
canvas, scripting or introspection crates. The release workflow checks
that (`engine/core/scripts/viewer-subset-audit.sh`) before it publishes.

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

# @paged-media/canvas-wasm

The paged engine for the browser, as wasm-bindgen modules. One package, three entry points,
each its own wasm module, so a page loads only the one it imports:

| Import                                | Crate                                                                                                              | What it is                                                                                                                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@paged-media/canvas-wasm`            | [`paged-canvas-wasm`](https://github.com/paged-media/paged/tree/main/engine/core/crates/paged-canvas-wasm)         | The editing canvas the editor's render worker runs: the wire types, the document model and WebGPU rendering.                                                                                   |
| `@paged-media/canvas-wasm/introspect` | [`paged-introspect-wasm`](https://github.com/paged-media/paged/tree/main/engine/core/crates/paged-introspect-wasm) | The engine's read-only introspection (`Inspector`). `@paged-media/canvas-wasm/introspect/catalog.json` is the static capability catalog; `describeCatalog()` returns the same data at runtime. |
| `@paged-media/canvas-wasm/repo`       | [`paged-repo-wasm`](https://github.com/paged-media/paged/tree/main/engine/core/crates/paged-repo-wasm)             | The document repository (`Repository`): a document kept in packs by its host. It has no engine and no wire.                                                                                    |

Each entry's wasm is importable on its own (`…/paged_canvas_wasm_bg.wasm`,
`…/introspect/paged_introspect_wasm_bg.wasm`, `…/repo/paged_repo_wasm_bg.wasm`), for bundlers
that take a wasm URL:

```ts
import init, { Repository } from "@paged-media/canvas-wasm/repo";
import repoWasmUrl from "@paged-media/canvas-wasm/repo/paged_repo_wasm_bg.wasm?url";

await init({ module_or_path: repoWasmUrl });
```

These replace `@paged-media/introspect-wasm` (now `./introspect`) and
`@paged-media/repo-wasm` (now `./repo`). The renderer-only viewer session is
`@paged-media/idml-viewer/session`.

The version is `0.<protocol>.<patch>`: its minor is the engine's wire protocol
(`PROTOCOL_VERSION` in `engine/core/crates/paged-canvas/src/channel.rs`). A release tag
`v0.<protocol>.<patch>` publishes it.

## In the repository

This directory is the package in the repository's Bun workspace. `package.json`, this
README and the licence files are committed, at the version `0.<protocol>.0-dev`. The
generated files (the glue, its `.d.ts` and the optimised wasm of each entry, and
`introspect/catalog.json`) are not; build them with Rust (rustup, the
`wasm32-unknown-unknown` target), wasm-bindgen-cli at the Cargo.lock version and binaryen
(`tooling/bootstrap.sh` installs the last two):

```sh
moon run core:wasm-pkg
# or, for one entry:
bash engine/core/scripts/build-wasm-packages.sh --workspace canvas   # or introspect, repo
```

Why the engine's wasm packages live here: [ADR 185](https://github.com/paged-media/paged/blob/main/engine/core/docs/adr/185-the-wasm-packages-are-workspace-packages.md).
Why one package: [PM-0008](https://github.com/paged-media/paged/blob/main/docs/adr/PM-0008-npm-packages-and-release.md).

## Licence

`AGPL-3.0-only OR LicenseRef-PMEL`; see [LICENSE.md](./LICENSE.md).

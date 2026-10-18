# @paged-media/repo-wasm

The wasm-bindgen package of [`paged-repo-wasm`](https://github.com/paged-media/paged/tree/main/engine/core/crates/paged-repo-wasm), the document repository: a document kept in packs by its host. It has no wire and no engine; it carries the engine's version for traceability, not its protocol.

The version is `0.<protocol>.<patch>`: its minor is the engine's wire protocol
(`PROTOCOL_VERSION` in `engine/core/crates/paged-canvas/src/channel.rs`). A release tag
`v0.<protocol>.<patch>` publishes it.

## In the repository

This directory is the package in the repository's Bun workspace. `package.json`, this
README and the licence files are committed, at the version `0.<protocol>.0-dev`. The
generated files (`paged_repo_wasm.js`, `paged_repo_wasm.d.ts`, `paged_repo_wasm_bg.wasm`) are not; build them
with Rust (rustup, the `wasm32-unknown-unknown` target), wasm-bindgen-cli at the
Cargo.lock version and binaryen (`tooling/bootstrap.sh` installs the last two):

```sh
moon run core:wasm-pkg
# or, for this package only:
bash engine/core/scripts/build-wasm-packages.sh --workspace repo-wasm
```

Why the engine's wasm packages live here: [ADR 185](https://github.com/paged-media/paged/blob/main/engine/core/docs/adr/185-the-wasm-packages-are-workspace-packages.md).

## Licence

`AGPL-3.0-only OR LicenseRef-PMEL`; see [LICENSE.md](./LICENSE.md).

# Contributing to plugin-publish

Thanks for your interest. This module holds the **foreign-format publishing
bundles** for [paged](https://paged.media) and the `pdf-import` mapper. The
IDML adapter it used to hold (`idml-import` / `idml-export`, ADR-022, and the
`idml-coverage` tool) is now part of the engine workspace,
`engine/core/crates/`. It is **open**
(AGPL-3.0-only OR PMEL), like the engine, the editor and the rest of the
repository (ADR PM-0001).

## License of contributions

`plugin-publish` is dual-licensed — **AGPL-3.0-only OR the Paged Media
Enterprise License (PMEL)**. By contributing you agree to the **Contributor
License Agreement** ([`CLA.md`](./CLA.md)), which allows And The Next GmbH
to distribute your contribution under **both** the open-source license
(AGPL-3.0) **and** the commercial license (PMEL). You retain copyright to
your contribution.

A CLA bot will ask you to sign on your first pull request.

New source files must carry the standard AGPL-3.0 OR PMEL header — copy it
verbatim from the top of any existing `crates/**/*.rs`.

## Building & testing

The toolchain is pinned in `rust-toolchain.toml`. `pdf-import` depends on the
Paged model crates (`paged-model`, `paged-scene`, `paged-store`) and, for its
round-trip test, on `idml-import`, all by path into `engine/core/crates/`:
it always builds against the engine at the same commit, and there is no pin
to move.

```bash
moon run publish:test    # nextest + doctests, then the bundle tests (from anywhere)
# without Moon:
cargo build --workspace --all-targets
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all --check
# the pdf-import mapper ships as wasm in the pdf bundle:
cargo build -p pdf-import --target wasm32-unknown-unknown
```

The IDML adapter's own build, tests and wasm32 lint run from `engine/core`
(`cargo nextest run -p idml-import -p idml-export -p idml-coverage`).

Do **not** run `cargo fmt --all` to _rewrite_ the tree if it drifts
unrelated files — format only the files you touched.

CI runs the same fmt + clippy + native/wasm32 build on every push and PR.

## Scope

This module is import/export **only** — it maps foreign formats to and from
the Paged native `Document`. The model itself, rendering, and mutation live in
the engine (`engine/core`); a change there that this module needs lands in the
same commit as the change here.

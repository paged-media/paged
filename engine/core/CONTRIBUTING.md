# Contributing to paged

Thanks for your interest in the **paged** engine. This repository is the
**open** render pipeline (AGPL-3.0-only OR PMEL, like the rest of the
repository); the editor and plugins live in separate, also-open
repositories under the same terms.

## License of contributions

`paged` is dual-licensed — **AGPL-3.0-only OR the Paged Media Enterprise
License (PMEL)**. By contributing you agree to the **Contributor License
Agreement** ([`CLA.md`](./CLA.md)), which allows And The Next GmbH to
distribute your contribution under **both** the open-source license
(AGPL-3.0) **and** the commercial license (PMEL). You retain copyright to
your contribution.

A CLA bot will ask you to sign on your first pull request.

New source files must carry the standard AGPL-3.0 OR PMEL header — copy it
verbatim from the top of any existing `crates/**/*.rs`.

## Building & testing

The toolchain is pinned in `rust-toolchain.toml`.

```bash
moon run core:test     # fixtures, nextest, doctests (from anywhere in the repository)
moon run core:lint     # clippy as CI runs it, native and wasm32
```

Without Moon:

```bash
cargo build --workspace
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```

Run `cargo fmt --all` before you push — the workspace is format-clean and CI
gates it. (This used to say the opposite, because the workspace had drifted;
the 9 remaining files were formatted in one pass on 2026-07-26.)

## Fidelity gate

Rendering changes are gated on visual fidelity against InDesign-exported
references. The **public golden set** lives in `corpus/generated/` and is
all you need to pass CI:

```bash
./corpus/generated/diff.sh   # needs pdftoppm (poppler-utils)
```

Don't loosen the per-fixture thresholds in
`corpus/generated/fidelity-thresholds.json` to make a regression pass —
fix the regression first, then tighten the threshold.

## Dependency licensing

CI runs `cargo deny check` (see [`deny.toml`](./deny.toml)). New
dependencies must be permissively licensed so the engine can be distributed
under both the AGPL-3.0 and the commercial PMEL.

## Scope note

The full Envato-backed fidelity corpus and the InDesign export harness are
internal (private) — you do **not** need them to contribute. The public
golden set above is sufficient.

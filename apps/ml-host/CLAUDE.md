# CLAUDE.md — apps/ml-host (paged-ml-host)

`apps/ml-host` of the monorepo `paged-media/paged`: the local generative-image sidecar, a
loopback-only HTTP host that runs image jobs through a stable-diffusion.cpp binary and model
files the user installed. Its own Cargo workspace (one crate, `crates/paged-ml-host`; own
`Cargo.lock`, `rust-toolchain.toml`, `deny.toml`), the Moon project `ml-host`. Read
[`README.md`](README.md) first.

## Rules

- It never opens an outbound connection and never bundles, downloads or builds
  stable-diffusion.cpp or model weights.
- A model configuration whose licence the user has not acknowledged is refused.
- Third-party notices are in `NOTICE`; keep it current with the dependencies.

## Commands

```bash
moon run ml-host:test                # also :check, :lint
cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings   # in apps/ml-host
cargo deny check
```

CI: `.github/workflows/ml-host.yml`.

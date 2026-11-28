# CLAUDE.md — apps/server (paged.server)

`apps/server` of the monorepo `paged-media/paged`: the optional remote for
repository-backed documents. Dual-licensed AGPL-3.0-only OR PMEL. Read
[`docs/concept.md`](docs/concept.md), [`docs/adr/`](docs/adr/README.md) (range 950–999) and
[`server/README.md`](server/README.md) first.

## Layout

- `server/` — its own Cargo workspace (own `Cargo.lock`, `rust-toolchain.toml`, `deny.toml`),
  the Moon project `server`: `crates/paged-server` and `crates/paged-sync`; `engine/` holds
  the headless engine lane's container files (ADR 953).

## Commands

```bash
moon run server:rust-check && moon run server:rust-lint && moon run server:rust-test
(cd server && cargo test --workspace)      # the same without Moon
(cd server && cargo deny check)
```

CI: `.github/workflows/server-rust.yml`.

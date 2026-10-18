# Contributing

Thanks for your interest in this **paged plugin**. It's open, dual-licensed
**AGPL-3.0 OR PMEL** — the same as the paged editor (a plugin is part of the
editor app). The engine and the extension SDK it builds on are under the
same terms (ADR PM-0001).

## License of contributions

By contributing you agree to the **Contributor License Agreement**
([`CLA.md`](./CLA.md)), which lets And The Next GmbH distribute your
contribution under **both** the AGPL-3.0 and the commercial PMEL. You retain
copyright to your contribution. A CLA bot will ask you to sign on your first PR.

New source files must carry the standard license header — copy it verbatim from
the top of any existing source file in this repo.

## Building & testing

See `CLAUDE.md` for the specifics. In general: Rust crates build/test with
`cargo build` / `cargo test` / `cargo clippy`; TypeScript packages with
`bun install` / `bun run test` / `bun run typecheck`. Format only the files you
touched.

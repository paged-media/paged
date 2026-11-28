# CLAUDE.md — platform/shared

Internal code shared by the built-in modules and the editor (PM-0002). None of it is
published, and none of it is part of the extension contract: an extension, and
`platform/extensions`, must not import it (`bun lint` enforces the boundary, `/bunfig.toml`).

- **TypeScript packages** (members of the root Bun workspace, one Moon project each): `ai`,
  `helpers`, `panel-kit`, `react-live`, `strings`, `test-kit`, `vector-geometry`,
  `vector-tools`, `wasm-boot`.
- **Rust crates** (members of `engine/core`'s Cargo workspace, PM-0017; run cargo there with
  `-p`): `ooxml` (`paged-ooxml`), `dml-chart`, `dml-geom`, `dml-native`, `test-resources`.

## Rules

- A new package needs its lint boundary and its `bun run lint:selftest` cases; the selftest
  fails until the config names it.
- Placement is by genericity (PM-0014, PM-0017): a capability the engine also needs belongs
  in the engine, one only a single module needs stays in that module.
- React sources ship compiled by the React Compiler (root `CLAUDE.md`, "React").

## Commands

```bash
moon run <package>:test              # for example helpers:test, ooxml:test
(cd <package> && bun run typecheck && bun run test)                  # a TypeScript package
(cd ../../engine/core && cargo nextest run -p paged-ooxml)           # a Rust crate
```

CI: `.github/workflows/shared-test.yml`, `.github/workflows/shared-rust.yml`.

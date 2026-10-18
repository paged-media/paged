# Contributing to Paged

Thanks for your interest in Paged. This repository holds the whole platform at
one revision: the engine (`engine/core`), the built-in modules (`modules/*`),
the extension SDK (`platform/extensions`) and the applications (`apps/*`).

## License of contributions

Paged is dual-licensed — **AGPL-3.0-only OR the Paged Media Enterprise License
(PMEL)**; see [`LICENSE.md`](./LICENSE.md). By contributing you agree to the
**Contributor License Agreement** ([`CLA.md`](./CLA.md)), which allows And The
Next GmbH to distribute your contribution under both licenses. You retain
copyright to your contribution. A CLA bot asks you to sign on your first pull
request.

## Setting up

Tool versions are pinned in [`.prototools`](./.prototools); install
[proto](https://moonrepo.dev/proto) and run `proto install`. Rust toolchains
come from each workspace's `rust-toolchain.toml` through rustup.

Every component's tasks run through [Moon](https://moonrepo.dev/moon) from
anywhere in the repository, with one project per Cargo or pnpm workspace
(`moon query projects` lists them):

```bash
moon run draw:test              # one project; also :fmt, :check, :lint, :build, :wasm
moon run :lint                  # every project
moon ci --base origin/main --head HEAD   # only what your branch affects
```

Moon installs each pnpm workspace with `--frozen-lockfile` before its JS
tasks and never rewrites package.json, lockfiles, tsconfig.json or
rust-toolchain.toml. Each component also documents its own build and test
commands (cargo, pnpm) in its README and `CLAUDE.md`; start there for the
directory you are changing.

## Rules that apply everywhere

- Rendering changes are gated on fidelity. Never loosen a fidelity threshold
  to make a regression pass — fix the regression first.
- The public repository must build and pass its gates without private
  resources (corpus, licensed fonts or color profiles). Optional resources are
  reached through environment variables and must report `unavailable`, never
  a silent pass.
- New dependencies must pass `cargo deny` / the JS license checks of the
  component they are added to.

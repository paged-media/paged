# Cargo: path dependencies instead of revision pins (migration step A6)

Before this step the three Rust workspaces that share code pinned each other by
git revision (publish ADR 650, "the two-repo rev-pin dance"):

- 11 engine crates (13 manifest entries) git-depended on
  `https://github.com/paged-media/plugin-publish` rev `05c57195` for
  `idml-import` / `idml-export`;
- `modules/publish` git-depended on `https://github.com/paged-media/core` rev
  `a47339cb` for `paged-model`, `paged-scene` and `paged-store`;
- `apps/server/server` git-depended on core rev `b612da5d` for `paged-repo` and
  `paged-mcp`;
- the engine carried a `[patch."https://github.com/paged-media/core"]` that sent
  the adapter's git dependencies on core's model crates back to its local paths,
  so both sides saw one `Document` type.

Those repositories are frozen and everything they held is in this tree, so the
pins are gone: the IDML adapter is an ordinary engine workspace member, and the
other two workspaces depend on engine crates by path. The policy itself is
recorded in `docs/adr/PM-0005-workspace-policy.md`.

The code that builds did not change. The in-tree adapter equals plugin-publish
`05c57195` apart from two corpus-path comments, and the engine crates publish
and the server use equal core `a47339cb` / `b612da5d` apart from the adapter
pin and one test-corpus path (`diff -r` against the cargo git checkouts).

## Moves (`git mv`, history follows)

| Was | Is now |
| --- | --- |
| `modules/publish/crates/idml-import` | `engine/core/crates/idml-import` |
| `modules/publish/crates/idml-export` | `engine/core/crates/idml-export` |
| `modules/publish/tools/idml-coverage` | `engine/core/crates/idml-coverage` |
| `modules/publish/docs/reference/idml-coverage.json` | `engine/core/docs/reference/idml-coverage.json` |
| `modules/publish/docs/reference/idml-coverage-ratchet.json` | `engine/core/docs/reference/idml-coverage-ratchet.json` |

The coverage tool goes to `crates/`, not `tools/`: every engine workspace member
is under `crates/` (or `spikes/`), the engine's binaries (`paged-cli`,
`paged-perf`, `paged-gen`) are crates there, and `engine/core/tools/` holds only
the InDesign probe scripts (`tools/indesign-export`), no Cargo package.
`git log --follow` reaches the files' pre-move history.

## Manifests

**engine/core**

- `Cargo.toml`: `crates/idml-import`, `crates/idml-export` and
  `crates/idml-coverage` join `[workspace] members`.
  `[workspace.dependencies]` gains the keys the moved crates name with
  `workspace = true` and the engine lacked: `serde_json = "1"`,
  `paged-model = { path = "crates/paged-model" }` and
  `paged-scene = { path = "crates/paged-scene" }`. All the others (thiserror,
  bytes, zip, flate2, quick-xml, serde, tracing, base64) were already declared
  with the same versions and features as in publish's workspace: zip
  `deflate-flate2` without default features, flate2 `rust_backend`, quick-xml
  `serialize`, serde `derive`. serde_json has no features on either side, and
  every engine crate already used plain `serde_json = "1"`, so feature
  unification changes nothing. The adapter needs no feature the engine does not
  enable. The self-`[patch."https://github.com/paged-media/core"]` and its
  comment are gone; `[patch.crates-io] flo_curves` stays, and so do the vello
  git dependency and the profiles.
- The 13 git entries in `paged-canvas` (2), `paged-cli`, `paged-export-pdf`,
  `paged-gen`, `paged-introspect`, `paged-introspect-wasm`, `paged-mutate`,
  `paged-renderer` (2), `paged-scene`, `paged-sdk` and `paged-store` are now
  `{ path = "../idml-import" }` / `{ path = "../idml-export" }`, the way these
  crates name every other engine crate. Two comments that pointed at the pin
  ("Same rev as paged-canvas pins", "Same git pin as … the cross-repo rev
  dance") are gone. `paged-scene` and `paged-store` keep `idml-import` as a
  dev-dependency, which makes a dev-dependency cycle (idml-import depends on
  paged-scene). That cycle existed before through the `[patch]`.
- `crates/idml-coverage`: `MANUAL`, `CENSUS` and the `tool` entry of
  `generatedFrom` are `crates/idml-coverage/…`. `repo_root()` (two levels above
  the crate) resolves to `engine/core`, where `crates/idml-import/src`,
  `crates/idml-export/src` and `docs/reference/` now are. Its README says the
  paths are relative to `engine/core` and that `paged-model` is a workspace
  member, not a pinned git dependency.

**modules/publish**

- `members = ["crates/pdf-import"]`.
- `[workspace.dependencies]`: `paged-model`, `paged-scene` and `paged-store` are
  `{ path = "../../engine/core/crates/<crate>" }` (relative to the workspace
  root), and a new `idml-import = { path = "../../engine/core/crates/idml-import" }`
  serves pdf-import's dev-dependency, which is now `{ workspace = true }`
  (written directly it would have been `../../../../engine/core/crates/idml-import`
  from the crate). `bytes`, `quick-xml` and `tracing` are dropped: only the
  adapter used them. The dangling "LOCAL ONLY — never commit" comment about a
  local `[patch]` at the end of the file is gone, and so is the rev-pin comment.

**apps/server/server**

- `paged-repo` and `paged-mcp` are `{ path = "../../../engine/core/crates/<crate>" }`.

Path dependencies that are members of another workspace inherit
`workspace = true` keys, lints and `rust-version` from their own workspace
(engine/core), as the git dependencies did.

## Lock files

Regenerated with `cargo metadata` (minimal resolution, nothing upgraded).

| Lock | Removed | Added | Source changes |
| --- | --- | --- | --- |
| `engine/core/Cargo.lock` | — | `idml-coverage`, `toml 0.8.23`, `toml_edit 0.22.27`, `toml_datetime 0.6.11`, `serde_spanned 0.6.9`, `toml_write 0.1.2`, `winnow 0.7.15` | `idml-import`, `idml-export`: git → path |
| `modules/publish/Cargo.lock` | `idml-export`, `idml-coverage`, `sha2`, `digest`, `block-buffer`, `crypto-common`, `generic-array`, `typenum`, `version_check`, `cpufeatures`, `toml`, `toml_edit`, `toml_datetime`, `serde_spanned`, `toml_write`, `winnow 0.7.15` | — | `paged-model`, `paged-scene`, `paged-store`, `paged-flow`, `paged-composition`: git → path |
| `apps/server/server/Cargo.lock` | — | — | `paged-repo`, `paged-mcp`: git → path |

`git diff --stat`: engine 82 lines (+76 −6), publish 165 (+1 −164), server 2 (−2).

The only non-paged changes are the coverage tool's own dependencies changing
workspace. The toml stack it brings into the engine is pinned at the versions
publish's lock already had, and it sits next to the engine's newer toml_edit
0.25, toml_datetime 1.1 and winnow 1.0 (from proc-macro-crate). That is three
new duplicate warnings under cargo-deny's `multiple-versions = "warn"`. The
packages that left publish were used only by the coverage tool. No version of
any package that stays in a lock changed.

## cargo-deny

Every `deny.toml` `[sources] allow-git` loses its paged-media entry:

- `engine/core/deny.toml`: `https://github.com/paged-media/plugin-publish` and
  its comment paragraph removed; vello and flo_curves stay.
- `modules/publish/deny.toml`: `https://github.com/paged-media/core` removed;
  `allow-git = []` (publish has no git source left). The header comment no
  longer names paged-media/core.
- `apps/server/server` has no deny.toml.

`cargo deny check` (all four checks):

| Workspace | Before | After |
| --- | --- | --- |
| engine/core | exit 0; advisories, bans, licenses, sources ok; 53 warnings | exit 0; all ok; 58 warnings |
| modules/publish | exit 0; all ok; 7 warnings | exit 0; all ok; 6 warnings |

The engine gains 5 warnings: duplicates of `toml_datetime`, `toml_edit` and
`winnow` (above), and wildcard warnings for the in-workspace path dependencies
on `idml-import` (2 entries) and `idml-export` (3), the same kind every other
engine path dependency already gets (`wildcards = "warn"`, no
`allow-wildcard-paths` in the engine's deny.toml). Publish loses the
`cpufeatures` duplicate, which came with the coverage tool's sha2.

## Docker

`apps/server/server/engine/Dockerfile` builds `paged` from `COPY engine/core/`
with the repository root as context. Everything `paged-cli` depends on, the
adapter included, is now inside `engine/core`, and its `include_bytes!` inputs
are in `engine/core/corpus` (not matched by the dockerignore's root-level
`corpus` entry). So the COPY already covers it, and the image no longer fetches
plugin-publish over git. Only the comment changed. The image itself was not
built (no Docker daemon here).

## CI

- **flo_curves guard.** The engine patches flo_curves, and a `[patch]` applies
  only in the workspace that declares it. A publish or server dependency that
  reached `paged-mutate` would build the unpatched crates.io release, whose
  boolean ops can panic. `publish-ci.yml` (job `check`) and the new
  `server-rust.yml` run:

  ```sh
  cargo tree --locked --target all > /dev/null          # any other error fails here
  if out=$(cargo tree --locked --target all -i flo_curves 2>/dev/null) && [ -n "$out" ]; then
    echo "::error …"; echo "$out"; exit 1
  fi
  ```

  `cargo tree -i` exits 101 with an empty stdout when the package is not in the
  graph. That is the passing case. Locally: publish and server pass (exit 0), and
  the same script run in `engine/core` as a control fails and prints the
  `paged-mutate` path.
- **server-rust.yml** (new; the server had no CI). Path filters:
  `apps/server/server/**`, `engine/core/Cargo.toml`, `engine/core/crates/**`, the
  workflow. Toolchain from `engine/core/scripts/rust-channel.sh`. Steps: guard,
  `cargo check --workspace --all-targets --locked`,
  `cargo check -p paged-server --target wasm32-unknown-unknown --locked`.
- **publish-ci.yml**:
  - It now also triggers on `engine/core/Cargo.toml` and `engine/core/crates/**`.
  - The wasm32 build is `-p pdf-import` only, because idml-export is no longer in
    publish's graph. The adapter's wasm32 lint moved to core.
  - The `cargo fetch` step, which existed for idml-coverage, is gone.
  - Path dependencies are not lint-capped the way registry and git dependencies
    are. Publish's `RUSTFLAGS: -Dwarnings` now fails the job on a warning in any
    engine crate it compiles: paged-model, paged-scene, paged-store, paged-flow,
    paged-composition and idml-import.
- **core-ci.yml**:
  - A `cargo fetch --locked` step runs before the tests in the `check` and
    `nextest` jobs. idml-coverage's tests run `cargo metadata --offline`, which
    needs the whole graph on disk, and `--locked` fails early on a stale lock.
  - The wasm32 clippy gains `-p idml-import -p idml-export`.
- `actionlint` (with shellcheck) on the three workflows: exit 0.

## Coverage inventory

Regenerated from `engine/core`:

```sh
cargo run -p idml-coverage > docs/reference/idml-coverage.json
cargo run -p idml-coverage -- --ratchet --allow-regression
```

The tool now reads the engine's own `idml-import`, `idml-export` and
`paged-model` sources. Before, paged-model came from the rev `a47339cb` git
checkout, and its sources are identical. Diff summary: `idml-coverage.json` 4
lines and the ratchet 1 line, all `tools/idml-coverage/…` → `crates/idml-coverage/…`
(`generatedFrom.census`, `.manual`, `.tool`, `census.file`). No count, metric
or row changed:

- weightedImport 21.06 % (133526 / 633952)
- impactImport 48.59 % (26564 / 54667)
- weightedExport 14.53 % (92130 / 633952)
- 30 misplaced, 405 unseen (0 unjustified), 0 unresolved

`--allow-regression` was needed. The ratchet compares the whole census record,
path included, so the moved census reads as "the census changed": same date,
same SHA-256 `7b2c1243971d…`, same 305 documents. Plain `--ratchet` refuses with
exit 1.

No other reader or writer of these files is in this tree. Outside it, the docs
site's `sources.pin` (entry `idml-coverage`) still fetches
`docs/reference/idml-coverage.json` from the plugin-publish repository at ref
`c6dc762`. When the docs site takes its sources from this repository, it should
read `engine/core/docs/reference/idml-coverage.json`.

## Docs

- `engine/core/CLAUDE.md`, "Layout": the adapter is a set of workspace members.
  The "13 Cargo.toml pins, move them together" instruction is replaced, and the
  bullet now names `crates/idml-coverage`.
- `modules/publish/README.md`: rewritten around pdf-import. It says where the
  adapter went, and the stale "Status: Phase 1" note is removed.
- `modules/publish/CONTRIBUTING.md`: the build commands are pdf-import's, the
  adapter commands are run from engine/core, and the "re-pin the git rev" scope
  rule is replaced.
- `apps/server/server/README.md`: the "pinned to a core rev (move both
  together)" note is replaced.
- Left as written: ADRs (publish 022, 650, 651, …), status, architecture and
  design records, and earlier migration records. Some describe the pins as
  current and are now stale:
  - `engine/core/docs/architecture.md:20,226`
  - `modules/publish/docs/architecture.md:48-62`
  - `modules/publish/docs/concept.md:15-16`
  - `modules/publish/docs/status.md:60-80` (the protocol-71 release order)
  - `engine/core/docs/reference/deferred-scope.md` (pointers written
    `plugin-publish: crates/idml-import/…`)
  - `engine/core/docs/design/plugin-metadata-and-baking.md`
  - `docs/migration/ci-port.md` item 11

  Mentions of `paged-media/core` / `paged-media/plugin-publish` elsewhere are
  history, links to the old repositories' ADRs, or "ported from" workflow
  headers. The only one left in a Cargo manifest, lock, deny.toml or Dockerfile
  is a comment in `engine/core/Cargo.toml`'s member list saying where the
  adapter came from.

## Verification

Run on the final tree. Each target dir is under `/Volumes/Dietz/paged-import/targets/a6-*`.

| Where | Command | Exit | Result |
| --- | --- | --- | --- |
| engine/core | `cargo check --workspace --all-targets --locked` | 0 | |
| engine/core | `cargo nextest run -p idml-import -p idml-export -p idml-coverage --locked` | 0 | 764 passed, 11 skipped |
| engine/core | `cargo clippy --target wasm32-unknown-unknown -p idml-import -p idml-export -- -D warnings` | 0 | also 0 with `--all-targets` |
| engine/core | `cargo clippy --all-targets -p idml-import -p idml-export -p idml-coverage -- -D warnings` | 0 | |
| engine/core | `cargo fmt --all --check` | 0 | |
| engine/core | core-ci's full wasm32 clippy invocation | 101 | pre-existing, see below |
| modules/publish | `cargo check --workspace --all-targets --locked` | 0 | |
| modules/publish | `cargo nextest run --workspace --locked` | 0 | 4 passed (pdf-import) |
| modules/publish | `cargo fmt --all --check` | 0 | also covers the engine path dependencies |
| modules/publish | `RUSTFLAGS=-Dwarnings cargo clippy --workspace --all-targets -- -D warnings` | 0 | |
| modules/publish | `RUSTFLAGS=-Dwarnings cargo build -p pdf-import --target wasm32-unknown-unknown` | 0 | |
| apps/server/server | `cargo check --workspace --all-targets --locked` | 0 | no warnings |
| apps/server/server | `cargo check -p paged-server --target wasm32-unknown-unknown --locked` | 0 | |
| modules/publish | `cargo tree --locked --target all -i flo_curves` | 101 | stdout empty: not in the graph |
| apps/server/server | `cargo tree --locked --target all -i flo_curves` | 101 | stdout empty: not in the graph |
| engine/core | `cargo deny check` | 0 | before: 0 |
| modules/publish | `cargo deny check` | 0 | before: 0 |

Test count against the base commit (`3bf8b292a`, publish workspace):
`cargo nextest run --workspace --locked` ran 768, all passed, 11 skipped. That
is 764 adapter tests and 4 pdf-import tests, the same 768 and 11 the two
workspaces run now.

**Pre-existing, not from this step.** core-ci's `clippy (wasm32)` invocation
fails on the base commit too (exit 101). `clippy::type_complexity` fires at
`crates/paged-export-pdf/src/writer.rs:460`, which that invocation lints as a
workspace member through paged-sdk. The adapter crates are clean on their own
(rows above).

## Open points

- `idml-coverage`'s ratchet treats a census move as a census change. Comparing
  `schema`, `generatedAt`, `sha256` and `documents` without `file` would let a
  future move go through without `--allow-regression`.
- `modules/publish` still declares `rust-version = "1.80"`. It now compiles
  engine crates that declare 1.92, so its effective minimum is 1.92.
- The docs site's `sources.pin` points at the frozen plugin-publish repository
  for the coverage file (above).
- The stale architecture, concept and status passages listed under Docs.

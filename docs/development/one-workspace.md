# One Cargo workspace

PM-0017 decided that the built-ins are built with the engine. This page is the plan and
the operating manual for the staged move of the Cargo workspaces into one: what moved,
in which order, how profiles, patches and lockfiles work in between, how to build one
module's wasm, and how to roll a step back.

The move is **staged, module by module**. Every step is its own commit, valid on its own,
checked on real CI, and reversible by reverting that commit.

## Where the workspace root is

`engine/core/Cargo.toml` is the root of the one workspace. A module joins it as a member:

- the module's own `[workspace]` table, `Cargo.lock`, `deny.toml` and `rust-toolchain.toml`
  go away (the toolchain file may stay while the module's directory builds standalone);
- its crates are listed in the root `members` by relative path
  (`../../modules/publish/crates/pdf-import`); a member outside the root's directory names
  its root with `workspace = "../../../../engine/core"` in its `[package]`;
- what the crates inherit (`version.workspace`, `lints.workspace`, `x = { workspace = true }`)
  now comes from the root, so the module's `[workspace.dependencies]` entries that the
  root does not have move into the root table.

Why not a new `/Cargo.toml` first: it would move `engine/core/Cargo.lock`, `.config/nextest.toml`,
the `target/` directory and some eighty references (workflows, Moon groups, scripts) in
one step, and every module would still have to join afterwards. Hoisting the root to the
repository is the **last** step, after the last module has joined; until then a module
directory has no `Cargo.toml`, so its commands run `cargo` in `engine/core` (or pass
`--manifest-path crates/<member>/Cargo.toml`) and select crates with `-p`.

## Rules that hold across the move

- **Features are never unified by hand.** The root `[workspace.dependencies]` shares a
  _version_ (and the features every user wants); a crate that needs a feature names it
  itself. Merging the module tables wholesale gives slide's wasm flate2's `zlib-rs` backend
  and `ooxmlsdk`, and `serde_json`'s `float_roundtrip` to crates that do not use it
  (PM-0017 spike). `paged-cli`'s `--features schema` changes `cli.json` goldens when other
  members turn it on, for the same reason.
- **Build per package.** `cargo build -p <crate>` resolves features for that package's
  graph only. `--workspace` selects every member and unifies their features: engine CI keeps
  it for lint and test (where unification does not change an artifact), and every shipped
  artifact is built with `-p`.
- **Two majors of a crate in one lockfile are fine.** Cargo resolves each dependent against
  its own requirement, and a build links only what its package reaches. The spike dependency
  splits are therefore not blockers (see the table below).
- **Wasm profiles are named, per artifact.** Profiles live only in the root manifest of a
  workspace. Each module's shipped wasm has its own profile and its build script passes it
  (`--profile wasm-<module>`):

  | profile                   | settings                                                                                        | used by                     |
  | ------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------- |
  | `wasm-release`            | inherits `release`, fat LTO, 1 codegen unit                                                     | engine packages, image, web |
  | `wasm-data`, `wasm-sheet` | `opt-level = "s"`, fat LTO, 1 codegen unit                                                      | data-js, sheet-js           |
  | `wasm-slide`              | as `wasm-sheet`, plus `opt-level = "z"` for paged-model, paged-scene, paged-store, slide-native | slide-js                    |
  | `wasm-doc`                | as `wasm-sheet`, plus `"z"` for ooxmlsdk, paged-model, paged-scene, paged-store                 | docx-js                     |
  | `wasm-draw`               | `opt-level = "z"`, fat LTO, 1 codegen unit, `panic = "abort"`, `strip = true`                   | trace-js                    |

  `release` itself stays the engine's (Cargo defaults): native binaries and tests of the
  modules no longer get a size-first `release`. publish's wasm has always used plain `release`
  and keeps doing so.

- **Patches apply to every member.** The engine's `[patch.crates-io]` (flo_curves,
  vello_shaders) now reaches the modules that joined. publish-ci's guard that kept
  `flo_curves` out of pdf-import's graph stays as a statement of what the mapper links.
- **Lockfiles.** A joined module has no `Cargo.lock`; `engine/core/Cargo.lock` is its lock.
  `cargo metadata --locked`, `cargo deny` and `cargo audit` run on it through the
  supply-chain job, which loops over every tracked lockfile. Regenerate with
  `cargo metadata --format-version 1 > /dev/null` rather than merging by hand.
- **The wasm-bindgen CLI** is the version in the root lockfile; `tooling/rust/build-wasm.sh`
  compares it with the lock of the module's workspace (`--manifest-path` for a member of
  another workspace). A module may keep an exact pin on the crate (draw: `=0.2.129`).

## Dependency splits found by the spike

| split                          | verdict                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| quick-xml 0.41 / 0.42          | Not a blocker, and not alignable today. ooxmlsdk (doc, slide, `paged-ooxml`'s `dom`) requires `^0.41` up to its newest release; `calamine` 0.37 (`paged-data-xlsx`) requires 0.42; the IDML reader and writer cannot move to 0.42 (docs/migration/rust-majors.md). The engine's lock already holds both. Only data's graph reaches 0.42, only the OOXML modules and IDML reach 0.41. |
| getrandom 0.3 / 0.4            | Not a blocker. The engine's lock holds 0.2, 0.3 and 0.4 already; each wasm links what its own crates reach.                                                                                                                                                                                                                                                                          |
| wasm-bindgen `=0.2.129` (draw) | Not a blocker. Every lock in the repository (bar the Blitz spike) already resolves 0.2.129, the CLI version `tooling/bootstrap.sh` installs.                                                                                                                                                                                                                                         |
| zip 9 / 9.0.4                  | Not a blocker. All requirements are `^9`, locks resolve 9.0.5 or 9.1.0; the version strings are aligned to `9.0.4`. zip 8.6 stays where ooxmlsdk's `parts` feature brings it.                                                                                                                                                                                                        |

## Order

Smallest and least coupled first; the evidence is the path dependencies of each module.

1. `modules/publish` (pdf-import): one crate; engine path dependencies only.
2. `modules/draw`: three crates; one engine path dependency (`paged-svg`); exercises a
   custom profile.
3. `modules/data`: four crates; its engine-level crates are already members;
   `tooling/js/source-hash.mjs` reads its workspace table.
4. `modules/image`.
5. `platform/shared/{test-resources,fmt,ooxml,dml-*}`, then `modules/sheet`, `modules/slide`,
   `modules/doc` (they path-depend on the shared crates).
6. `modules/web/packages/web-render` (the Blitz alpha line) and `apps/ml-host`,
   `apps/server`: decided on their own.
7. Hoist the root to `/Cargo.toml`, one `Cargo.lock`, one `deny.toml`, one `target/`.

## How to build one module's wasm

Unchanged for the user: `moon run <module>:wasm`, or `bash modules/<m>/scripts/build-wasm.sh`.
The script calls `tooling/rust/build-wasm.sh` with the module's package and profile; for a
joined module it also passes `--manifest-path`, and the output lands under
`engine/core/target/wasm32-unknown-unknown/<profile>/` (or `CARGO_TARGET_DIR`).

## Rollback

`git revert` the step's commit. A step touches only the module's `Cargo.toml` files, the
root `members` and `[workspace.dependencies]`, the module's CI workflow and Moon file, and
`engine/core/Cargo.lock` (regenerate it with `cargo metadata`). Nothing a step does depends
on a later step.

## Status and measurements

Dated 2026-11-02, origin/main `ec036079e`. Wasm sizes are the output of the module's own
`scripts/build-wasm.sh` (cargo, `wasm-bindgen --target web`, `wasm-opt -Oz`) with the
pinned toolchain, before and after the step, in the same checkout state otherwise.

| step        | what                                                          | wasm before                                                                                               | wasm after                                       |
| ----------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 1. profiles | named `wasm-data/-sheet/-slide/-doc/-draw`                    | data_js 22,498,028; sheet_js 8,624,276; slide_js 14,096,305; trace_js 1,977,642 (cargo output, `release`) | identical sizes under the named profile          |
| 2. publish  | `pdf-import` joins `engine/core`                              | pdf_import_bg 4,048,462                                                                                   | 4,048,677 (+215 B, longer embedded source paths) |
| 3. draw     | `draw-trace`, `draw-dxf`, `trace-js` join                     | trace_js_bg 1,387,237                                                                                     | 1,387,007 (−230 B)                               |
| 4. data     | `data-js`, `data-cli`, `data-script`, `data-conformance` join | data_js_bg 14,793,447 (CI, main)                                                                          | 14,794,761 (CI, +1,314 B)                        |
| 5. image    | the eight `image-*` crates join                               | resolved graph identical (cargo tree, 300 lines); wasm size not remeasured                                | same                                             |

What a step changes besides the manifests, learned on publish:

- **The module's workflow.** Cargo steps run in `engine/core` with `-p`; the rust-cache entry is
  `engine/core -> target`; the wasm-bindgen CLI version is read from `engine/core/Cargo.lock`;
  anything that looked in the module's own `target/` (publish-ci's "mold linked the test
  binaries") looks in `engine/core/target`.
- **Moon.** The inherited `rust-*` tasks run `cargo … --workspace` in the project root, where
  there is no manifest any more; the project overrides them with `cd ../../engine/core && cargo
… -p <crates>`. Its `rust-sources` groups name `/engine/core/Cargo.lock` instead of a lock of
  its own.
- **Nextest.** The engine's `.config/nextest.toml` (its `ci` profile, JUnit report name
  `paged-core-nextest`) replaces the module's.
- **Lock merge.** The module takes the engine lock's versions of shared transitive crates. For
  publish that moved smallvec and yoke by a patch release; for draw cc, crc32fast,
  find-msvc-tools and roxmltree. Features were checked identical (`cargo tree -e features`).
- **Engine CI grows.** `core / ci` runs `clippy --workspace` and `nextest --workspace`, so it now
  covers the joined crates too.
- **Rust-analyzer.** The module's `Cargo.toml` is dropped from `.vscode/settings.json` and
  `.serena/project.yml` `linkedProjects`; the engine's covers it.

# Relicense to AGPL-3.0-only OR PMEL (migration step A7)

ADR PM-0001 puts every first-party file under `AGPL-3.0-only OR LicenseRef-PMEL`. Three former
repositories were `MPL-2.0 OR LicenseRef-PMEL` (`engine/core`, `modules/publish`,
`platform/extensions`), and some files elsewhere carried the MPL notice. This step rewrites the
notices, the licence fields, the licence files and the cargo-deny policies. Versions published
before it stay available under MPL-2.0 OR PMEL.

## Source notices

Every notice of the form "This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0 … @license MPL-2.0 OR Paged Media Enterprise License (PMEL)" was rewritten in
place, keeping the file's comment syntax (`/* … */`, `/** … */`, `#`). The new notice is the
editor's, without its "the commercial editor" line. Where a file already carried the AGPL notice
above the MPL one, the MPL block was removed instead, so every file has exactly one notice.

| Component | Rewritten | Duplicate removed | Notes |
|---|---:|---:|---|
| `engine/core` | 812 | — | 689 `.rs`, 54 `.sh`, 51 `.jsx` (the InDesign ExtendScript probes in `tools/indesign-export`), 11 `.ts`, 5 `.py`, 2 `.wgsl`. Two `.py` files had lost the `@license` line; they got the full notice. Two `paged-gpu` tests carried a one-line SPDX MPL notice; they got the standard block. |
| `modules/image` | 20 | 214 | 233 `.rs`, 1 `.ts`. The WGSL that `image-kernels` generates said `// MPL-2.0 OR LicenseRef-PMEL` (56 places in `abi.rs` and `families/*.rs`; the string occurs 91 times in the wasm); it says AGPL-3.0-only now. |
| `modules/sheet` | — | 199 | including the three fuzz targets |
| `platform/extensions` | 156 | — | 154 `.ts`, 2 `.tsx`; plus the banner `sync-wire.mjs` writes over the vendored `wire.d.ts` (template and copy together) |
| `modules/publish` | 154 | — | 137 `.rs`, 17 `.ts` |
| `apps/editor` | 12 | — | the vendored `packages/ai` |
| `modules/doc` | 6 | — | `paged-ooxml` |
| `modules/slide` | 6 | — | `vendor/paged-ooxml`, re-vendored from `modules/doc` with `scripts/sync-ooxml.sh` |
| **Total** | **1,166** | **413** | 1,579 files, plus the two SPDX one-liners |

The count for `engine/core` is 51 higher than a count by source extension gives (761): the
ExtendScript probes are `.jsx` files, first-party, with the same MPL notice.

### File-and-line citations

The AGPL notice is four lines longer than the MPL one, and the image and sheet files lost a
14-line block, so every line of those files moved. 1,945 citations in 124 documents were moved
with them: 1,272 whose path resolves to a rewritten file from the citing document, its component
or the repository root (or through the former repository names: `core/` → `engine/core/`, and so
on), 131 that name a path suffix only one file in the repository has, and 542 `:LINE` shorthands
that cite the file named just before them in the same section. URLs pinned to a revision were
left alone. Citations into a file's notice were left alone (there were none).

Not moved, because the bare file name matches several files and the citing text does not say
which one:

| Document | Citations |
|---|---|
| `engine/core/crates/paged-canvas/src/gesture.rs` | `spread.rs:141` |
| `engine/core/crates/paged-mutate/src/apply/path_topology.rs` | `spread.rs:81` |
| `engine/core/docs/adr/005-wire-recipe.md` | `descriptor.rs:36-40` |
| `engine/core/docs/architecture.md` | `channel.rs:510`, `model.rs:8779` |
| `engine/core/docs/reference/deferred-scope.md` | `story.rs:2222`, `story.rs:2237` |
| `modules/web/docs/adr/011-web-rendering-fork-defer-to-scenelayer.md` | `engine.ts:22-31` |
| `modules/web/docs/adr/020-paged-web-native-engine-defer-frame-threading.md` | `flow.rs:493-496`, `flow.rs:732-735`, `lib.rs:80-81` |
| `modules/web/docs/adr/400-pure-lowering-and-capture-layer.md` | `lib.rs:116-122` |
| `modules/web/docs/adr/401-layout-engine-pinned.md` | `engine.ts:22-31`, `engine.ts:44-45` |
| `modules/web/docs/adr/402-text-crosses-as-strings.md` | `fonts.rs:30-32`, `fonts.rs:35-36` |
| `modules/web/docs/adr/403-json-wasm-boundary.md` | `engine-loader.ts:25-31`, `lib.rs:107-108`, `lib.rs:95-103` |
| `modules/web/docs/adr/404-fragmentation-by-relayout.md` | `flow.rs:19-37`, `flow.rs:79-118`, `flow.rs:127-133`, `flow.rs:219-224`, `flow.rs:278-280`, `flow.rs:455-468`, `flow.rs:494-496`, `flow.rs:614-617`, `lib.rs:80-81` |
| `modules/web/docs/adr/406-web-frame-and-source-storage.md` | `activate.ts:77-92`, `edit-context.ts:34-38` |
| `platform/extensions/docs/adr/012-k1-modal-session-undo-coalescing.md` | `activate.ts:161-192`, `host.ts:333`, `host.ts:395` (twice), `session.ts:611-663` (twice) |

Most of the `modules/web` ones probably mean web's own files, which did not change.

## Licence fields

- `Cargo.toml`: `engine/core` and `modules/publish` (`[workspace.package]`),
  `engine/core/spikes/blitz-wasm` (it said `MPL-2.0` alone), and `modules/doc/paged-ooxml`, which
  overrode its workspace's AGPL default with MPL and now inherits it (`license.workspace = true`;
  the slide copy follows). No manifest has a `license-file`.
- `package.json`: `engine/core/web/idml-viewer`, `modules/publish/packages/{pdf,publish}-bundle`,
  `platform/extensions` and its `packages/{ai,cli,plugin-api,plugin-cli,plugin-sdk}`,
  `apps/editor/packages/ai`.
- `.github/workflows/core-publish-wasm.yml`: the four package.json files it writes
  (canvas-wasm, introspect-wasm, repo-wasm, sdk).

## Licence files

- `engine/core`, `modules/publish`, `platform/extensions`: `LICENSE` (the MPL-2.0 text) is
  deleted; `LICENSE.md` is a short pointer to the root terms that records the earlier MPL
  licensing.
- Their packages had shipped those files only through `pnpm pack`, which adds the workspace
  root's licence files to a package that has none (`idml-viewer`, published with `npm publish`,
  shipped none). Each published package now has its own `LICENSE` (the AGPL-3.0 text, identical to
  the root `LICENSE`) and `LICENSE.md` (the dual licence, and that earlier versions stay under
  MPL-2.0): `idml-viewer`, `plugin-api`, `plugin-sdk`, `plugin-cli`, `cli`, `ai`, `pdf`,
  `publish`. `core-publish-wasm.yml` copies the same two files into the four packages it assembles
  in `dist/`.
- The root `LICENSE.md` transition note says the relicense has landed.

## cargo-deny

In each of the seven `deny.toml` files: `[licenses.private] ignore = true` (a workspace's own
unpublished crates are not checked against the dependency policy); `LicenseRef-PMEL` stays
allowed, for first-party crates reached from another workspace or by git revision from a former
repository (those carry `AGPL-3.0-only OR LicenseRef-PMEL`, or `MPL-2.0 OR LicenseRef-PMEL` for
revisions released before the relicense); `AGPL-3.0-only` leaves the doc and slide allow-lists,
where it let third-party AGPL code through; `MPL-2.0` stays everywhere for the dependencies that
need it.

`cargo deny check licenses` (cargo-deny 0.19.8):

| Workspace | Before | After |
|---|---:|---:|
| `engine/core` | 0 | 0 |
| `modules/data` | 0 | 0 |
| `modules/doc` | 0 | 0 |
| `modules/image` | 0 | 0 |
| `modules/publish` | 0 | 0 |
| `modules/sheet` | 0 | 0 |
| `modules/slide` | 0 | 0 |

Both runs print the same `license-not-encountered` warnings for unused allow-list entries.
"Before" was run on the tree of the step's base commit.

## The image wasm

`modules/image/glue/test/wasm-fresh.spec.ts` compares a hash of the Rust sources (and
`registry/*.yaml`) with the hash stamped into the committed `glue/wasm`. The header change moves
it, so the image commit rebuilds the wasm with `scripts/build-wasm.sh`: rustc 1.93.0
(`rust-toolchain.toml`), wasm-bindgen-cli 0.2.128 (`Cargo.lock`'s pin, checked by the script),
and `wasm-opt` from binaryen 126; `image-ci.yml` pins binaryen 119, and CI rebuilds the wasm
itself before the specs run. The generated `image_js.js` and `.d.ts` are unchanged; the wasm is
645 bytes larger (the longer licence line, 91 times).

No other module commits a wasm that a source-hash check covers: sheet, data and web build theirs
in CI (`bin/` is gitignored); draw's sources did not change; `modules/publish`'s committed
`pdf_import_bg.wasm` has no freshness check and no licence text in it, and was not rebuilt.

## What was left, and why

`git grep -n 'Mozilla Public License'` finds only this file, which quotes the command.
`git grep -n 'MPL-2.0'` finds only:

- statements that versions published before the relicense stay under MPL-2.0 (root
  `LICENSE.md`; the `LICENSE.md` of `engine/core`, `modules/publish`, `platform/extensions`, every
  module and every published package; the READMEs and orientation files of the engine, the
  viewer, the SDK, the editor, the server and the doc module);
- `deny.toml`: `MPL-2.0` in each allow-list, for third-party dependencies, and the comment on
  first-party revisions released before the relicense;
- `tooling/import/root/LICENSE.md`: the import's copy of the root commit's files. Re-running the
  import must reproduce that commit, so the template keeps the pre-relicense note; this step
  changes the root `LICENSE.md` after it;
- this file and ADR PM-0001.

Other MPL mentions are third-party: the Spanish hyphenation patterns in
`engine/core/crates/paged-text/patterns` are GPL-3+ / LGPL-3+ / MPL-1.1+ (we take MPL-1.1+), and
their licence files stay as they are. "Mozilla" also names Mozilla's `qcms` colour library and
appears in browser user-agent strings.

Not touched: OFL fonts, the Apache POI spreadsheet fixtures, DuckDB-WASM (MIT), PDFium, the
`flo_curves` crate, and everything else under a third-party licence or in a `vendor/` or
`third_party/` directory with another copyright holder. `modules/slide/vendor/paged-ooxml` is a
copy of the first-party crate in `modules/doc` and was relicensed with it.

## Verification

| Command | Where | Exit |
|---|---|---:|
| `git grep -n 'Mozilla Public License'` | root | 1 before this file was added (no match); 0 after, matching only the two lines of this file that quote the command |
| `git grep -n 'MPL-2.0'` | root | 0 (only the mentions above) |
| `cargo deny check licenses` | the seven workspaces | 0 each |
| `cargo fmt --all --check` | `engine/core`, `modules/{publish,doc,slide,sheet,image}`, `engine/core/spikes/{composer-calibration,vello-eval,wasm-size}` | 0 each |
| `cargo fmt --all --check` | `modules/sheet/fuzz`, `engine/core/spikes/blitz-wasm` | 1: the same diffs as before this step (4 and 5), none in a notice |
| `npm pack --dry-run` | `platform/extensions/packages/{plugin-api,plugin-sdk,plugin-cli}`, `engine/core/web/idml-viewer` | 0 each; licence field `AGPL-3.0-only OR LicenseRef-PMEL`, tarball has `LICENSE` and `LICENSE.md` |
| `pnpm pack` | `platform/extensions/packages/plugin-cli` | 0; the package's own `LICENSE` (AGPL-3.0 text) and `LICENSE.md` |
| `bash scripts/sync-ooxml.sh --check` | `modules/slide` | 0 |
| `buildHeader()` of `sync-wire.mjs` against `wire.d.ts` | `platform/extensions` | header matches; body unchanged |
| `vitest run test/wasm-fresh.spec.ts` | `modules/image/glue` | 0 (3 tests) |
| `vitest run` with `REQUIRE_REAL_WASM=1` | `modules/image/glue` | 0 (41 files, 353 tests) |
| `node scripts/assert-contract-bumped.mjs main` | `platform/extensions` | 0 |
| `node scripts/assert-contract-bumped.mjs <step A4 tip>` | `platform/extensions` | 1, see below |

## Open issues

- **Contract guard.** The headers changed `packages/plugin-api/src` and `packages/plugin-sdk/src`.
  Against `main` the guard passes (step A4 moved both to `0.2.64-canary.0`, which is not on npm);
  against step A4's tip alone it fails, since this step does not bump them again. If this step
  lands on its own after A4, plugin-api and plugin-sdk need a version change; landed with A4,
  `0.2.64-canary.0` is the first version published under AGPL-3.0-only OR PMEL.
- **The PMEL text.** `LicenseRef-PMEL` names the Paged Media Enterprise License, whose legal text
  is not yet published (ADR PM-0001).
- **Cross-repository git pins.** The engine still takes `idml-import`/`idml-export`, and
  `modules/publish` and `apps/server` still take engine crates, by git revision from the former
  repositories; cargo reads those crates' licence (MPL-2.0 OR PMEL) from the pinned revision.
  They pass through `LicenseRef-PMEL` until the pins become in-repository paths.
- **`SYNCED`.** `modules/slide/vendor/paged-ooxml/SYNCED` records the commit it was vendored
  from; after the final re-assembly of the import that SHA changes. The check uses the tree hash,
  which does not.

# Sibling-path rewiring (migration step A4)

The components of this repository used to be separate checkouts side by side
(`~/paged/core`, `~/paged/editor`, `~/paged/plugins/plugin-*`, `~/paged/corpus`,
`~/paged/state`). Their code, scripts and tests reached each other through
relative paths that assumed that layout. This step makes those paths correct in
the monorepo layout without changing behaviour otherwise.

| Was | Is now |
| --- | --- |
| `core` | `engine/core` |
| `editor` | `apps/editor` |
| `editor-server/server` | `apps/server/server` |
| `plugins/plugin-sdk` | `platform/extensions` |
| `plugins/plugin-{publish,image,draw,sheets,data,doc,slide,web}` | `modules/{publish,image,draw,sheet,data,doc,slide,web}` |
| `corpus` (private) | `<repo root>/corpus` — gitignored; a local symlink to the private corpus checkout |
| `state` (private feature registry) | not in this repository; `PAGED_FEATURE_REGISTRY` |

Depth matters: `apps/editor` and `engine/core` are one level deeper than
`editor` and `core` were, so their paths to anything outside them gained one
`..`. `modules/<m>` and `platform/extensions` sit at the same depth as
`plugins/plugin-<m>` did, so their `../../corpus`-style paths already reach the
repository root; only their references to `../plugin-sdk`, `../../editor` and
`../core` were wrong.

Conventions kept:

- Private resources stay optional. Every env override that existed still takes
  precedence (`PAGED_*_CORPUS`, `PAGED_CORPUS`, `PAGED_ENGINE_FROM`,
  `PAGED_CANVAS_WASM_FROM`, `PAGED_INTROSPECT_WASM_FROM`, `CORE_REPO`,
  `PAGED_BIN`, …). The default corpus is `<repo root>/corpus`.
- Corpus lanes keep their gating (`#[ignore]`, opt-in switches,
  `PAGED_REQUIRE_CORPUS`).
- The editor test suite keeps its own corpus convention: `apps/editor/corpus`
  (gitignored, a local symlink). To use the root corpus there:
  `ln -s ../../corpus apps/editor/corpus`.

## Changes

Line numbers are in the files as they now stand.

### apps/editor

| File:line | Old | New |
| --- | --- | --- |
| `package.json:39-40` | `@paged-media/doc`/`slide`: `link:../plugins/plugin-{doc,slide}/packages/*-bundle` | `link:../../modules/{doc,slide}/packages/*-bundle` |
| `pnpm-lock.yaml:9-10,47-48,74-75` (own commit) | the same links (`link:../../../plugins/…` in the `apps/canvas` importer) | `link:../../modules/…` / `link:../../../../modules/…` — exactly the lines pnpm 9.0.0 writes for the new overrides |
| `apps/canvas/vite.config.ts:33` | — | `MONOREPO_ROOT` = four levels up |
| `apps/canvas/vite.config.ts:41-42` | corpus candidates `editor/corpus/<x>`, `../corpus/<x>` (`~/paged/corpus`) | `apps/editor/corpus/<x>`, then `<repo root>/corpus/<x>` (fonts and `idml` both resolve through this) |
| `apps/canvas/vite.config.ts:74` | `DUCKDB_DIST` candidates `../../../plugins/plugin-data`, `../../../plugin-data` | `<repo root>/modules/data` |
| `apps/canvas/vite.config.ts:659` | `server.fs.allow` `resolve(__dirname, "..", "..", "..")` (`~/paged`; in the monorepo that is `apps/`) | `MONOREPO_ROOT` (covers `modules/`, the `link:` targets) |
| `apps/canvas/tests/showcase/chapter.ts:65-77` | `WORKSPACE` = 3 up; `CORE = WORKSPACE/core`; `REGISTRY = WORKSPACE/state/registry/features` | `REPO_ROOT` = 4 up; `CORE = REPO_ROOT/engine/core`; `REGISTRY = $PAGED_FEATURE_REGISTRY` or `null` |
| `apps/canvas/tests/showcase/chapter.ts:101-102` | error "core is not checked out … beside the editor" | names the in-repo engine |
| `apps/canvas/tests/showcase/coverage.ts:95-97,122,147` | `loadRegistry(dir: string)` | accepts `null` (unavailable); `generatedFrom: "unavailable"` |
| `apps/canvas/tests/showcase/chapters/900-assemble.spec.ts:55,74` | local `CORE = OUT/../../../../core` (resolved to `apps/core`) | imports `CORE` from `chapter.ts` (`engine/core`; fixes the `default_cmyk.icc` read at :351) |
| `apps/canvas/tests/showcase/chapters/900-assemble.spec.ts:507-524` | registry axis passed silently when `state` was absent | `REGISTRY === null` → logged, test annotation `unavailable`, report note; set but missing → assertion failure |
| `apps/canvas/tests/showcase/pages/210-darkroom/00-support.ts:62-73` | `WORKSPACE` 7 up + `plugins/plugin-image/registry/kernels.yaml` | `REPO_ROOT` 8 up + `modules/image/registry/kernels.yaml` |
| `apps/canvas/tests/showcase/pages/220-ledger/04-formulas.ts:73-82` | 7 up + `plugins/plugin-sheets/registry/functions` | 8 up + `modules/sheet/registry/functions` |
| `apps/canvas/tests/showcase/pages/240-catalog/00-support.ts:69-79` | 7 up + `plugins/plugin-data/registry/functions` | 8 up + `modules/data/registry/functions` |
| `apps/canvas/tests/showcase/pages/165-color/04-management.ts:76` | `CORE/corpus/profiles/default_cmyk.icc` with `CORE` = `~/paged/core` | unchanged line; `CORE` is now `engine/core` |
| `apps/canvas/tests/showcase/pages/{210-darkroom/02-contact-sheet.ts:36,463,467, 220-ledger/04-formulas.ts:33,224, 240-catalog/04-dsl.ts:121-122,127, 10-word.ts:41-44}` | notes/comments naming `plugin-image/…`, `plugin-sheets checkout`, `plugins/plugin-data/…`, `~/paged/plugins/plugin-doc` | `modules/image/…`, `modules/sheet/…`, `modules/data/…`, `modules/doc` |
| `apps/canvas/tests/showcase/{ledger.ts:32-34,75, driver.spec.ts:41-44}` | "core checkout beside the editor" | "the in-repo engine (`engine/core`)" |
| `apps/canvas/tests/films/narrated/{data,database-publishing,designers}.film.ts:39/42/42` | 6 up + `core/corpus/fonts` | 7 up + `engine/core/corpus/fonts` |
| `apps/canvas/tests/films/stills/stills.film.ts:44-48` | `WORKSPACE` 6 up; `core/corpus/fonts`; `editor/apps/canvas/showcase/showcase.paged` | `REPO_ROOT` 7 up; `engine/core/corpus/fonts`; `apps/editor/apps/canvas/showcase/showcase.paged` (`SHOWCASE_PAGED` still wins) |
| `apps/canvas/tests/showcase/assets/gen-cmyk-jpeg.py:16`, `gen-photo-formats.py:19` | `../../../../../../core/corpus/profiles/default_cmyk.icc` | `../../../../../../../engine/core/corpus/profiles/default_cmyk.icc` |
| `apps/canvas/tests/fidelity/diff.ts:49-50,62` | `paged-diff` at `apps/editor/target/release` (a symlink to the sibling core target); `cargo build` run in the editor root | `ENGINE_ROOT = <repo root>/engine/core`; binary at `engine/core/${CARGO_TARGET_DIR:-target}/release/paged-diff`; cargo runs there |
| `scripts/check-plugin-pins.mjs:26-29,45-60,103-105` | bundle repos probed under `../plugins/plugin-*` and `../plugin-*` | `<repo root>/modules/*` |
| `scripts/fidelity-thresholds-schema.test.mjs:19-32` | `apps/editor/corpus` only (comment: symlink to `~/paged/corpus`) | `apps/editor/corpus`, then `<repo root>/corpus` |
| `packages/client/package.json:9-10` | `repository.url` `paged-media/editor`, `directory: packages/client` | `paged-media/paged`, `apps/editor/packages/client` |
| `.gitignore:17-18`, `packages/ai/README.md:4-5` | `~/paged/...` comment; link to `paged-media/plugin-sdk` `packages/ai` | `<repo root>/corpus`, `engine/core/target`; relative link to `platform/extensions/packages/ai` |
| `apps/canvas/tests/e2e/harness/FIXTURES.md:16-21,27,31` | sources `plugin-sheets/…`, `plugin-doc/…`, `plugin-slide/…`; `cp ~/paged/plugins/plugin-sheets/corpus/…` | `modules/sheet/…`, `modules/doc/…`, `modules/slide/…`; `cp ../../modules/sheet/corpus/…` (run from `apps/editor`) |
| `apps/canvas/showcase/README.md:6,18`, `tests/showcase/README.md:7,18,116`, `tests/showcase/AUTHORING.md:66,97`, `tests/showcase/assets/README.md:4,11` | `cd ~/paged/editor/apps/canvas`, `state/registry/features`, `~/paged/corpus`, "core checkout" | `cd apps/editor/apps/canvas`, `PAGED_FEATURE_REGISTRY`, `<repo root>/corpus`, `engine/core` |

### platform/extensions

| File:line | Old | New |
| --- | --- | --- |
| `scripts/sync-wire.mjs:38-44` | `RESOLVE_CANDIDATES` `../../editor/packages/client`, `../editor/packages/client` | `../../apps/editor/packages/client` (`PAGED_CANVAS_WASM_FROM` still wins) |
| `scripts/sync-catalog.mjs:36-41` | the same two editor candidates | `../../apps/editor/packages/client` (`PAGED_INTROSPECT_WASM_FROM` still wins) |
| `scripts/sync-catalog.mjs:46-53` | `CORE_CANDIDATES` `../../core/…`, `../core/…` | `../../engine/core/crates/paged-introspect/catalog.json` (`CORE_REPO` still wins) |
| `packages/plugin-sdk/src/wasm-loader.ts:194-200` | anchor `../../../../editor/packages/client` | `../../../../../apps/editor/packages/client` |
| `scripts/assert-contract-bumped.mjs:56-62` | `git show <ref>:packages/<pkg>/package.json` — relative to the top of the git repository, so in the monorepo every lookup missed and every package silently counted as "bumped" | `git show <ref>:./packages/<pkg>/package.json` (relative to `platform/extensions`) |
| `packages/{ai,cli,plugin-api,plugin-cli,plugin-sdk}/package.json` (`repository`) | `paged-media/plugin-sdk`, `directory: packages/<p>` | `paged-media/paged`, `platform/extensions/packages/<p>` |

The dead candidates (`<repo root>/editor`, `platform/editor`, `<repo root>/core`,
`platform/core`) were dropped rather than kept behind the new ones: no checkout can
put anything there.

### modules

| File:line | Old | New |
| --- | --- | --- |
| `{data,doc,sheet}/package.json:12`, `slide/package.json:13`, `image/package.json:12` (`validate:manifest`) | `node ../plugin-sdk/packages/plugin-cli/bin/paged-plugin.mjs` | `node ../../platform/extensions/packages/plugin-cli/bin/paged-plugin.mjs` |
| `image/manifest/package.json:11-12` (`typecheck`, `test`) | `node ../../plugin-sdk/…` | `node ../../../platform/extensions/…` |
| `draw/README.md:48`, `draw/CLAUDE.md:592`, `sheet/README.md:72` | the same command with `../plugin-sdk` | `../../platform/extensions` |
| `draw/packages/draw-bundle/test/conformance/host.ts:52-58,83` | editor candidates `../../editor/packages/client`, `../editor/packages/client` (from `modules/draw`) | `../../apps/editor/packages/client` (`PAGED_ENGINE_FROM` and the bundle's own install still win) |
| `data/packages/data-bundle/test/real-core.ts:7-9,30,33,71` | walk-up probe for `<dir>/editor/packages/client` | `<dir>/apps/editor/packages/client` (`PAGED_ENGINE_FROM` and the package's own install still win) |
| `web/packages/web-conformance/indesign/run.sh:14-22` | `PAGED_BIN` default `$HOME/paged/core/target/debug/paged` | `${CARGO_TARGET_DIR:-$(git rev-parse --show-toplevel)/engine/core/target}/debug/paged` (`PAGED_BIN` still wins) |
| `slide/scripts/fidelity-local.py:21-27` | `--core ../../core` (from `modules/slide` that is `modules/core`), `--corpus ../../corpus` | `--core <repo root>/engine/core`, `--corpus <repo root>/corpus` |
| `sheet/sheet-conformance/oracle/recalc/classify.py:5-12,19-20` | default `~/paged/corpus/xlsx`; usage `PAGED_XLSX_CORPUS=~/paged/corpus` | default `<repo root>/corpus/xlsx` (argv still wins); usage `PAGED_XLSX_CORPUS=1` |
| `image/README.md:57-63`, `sheet/README.md:56-62`, `data/README.md:61` | sibling-checkout setup (`~/paged/{editor,plugin-sdk,plugin-*}`) | the monorepo components |
| comments: `doc/docx-conformance/tests/real_word_corpus.rs:61`, `publish/crates/idml-export/tests/support/corpus.rs:17,28,48`, `publish/crates/idml-export/examples/corpus_sweep.rs:216`, `sheet/sheet-js/benches/session.rs:40,81`, `slide/pptx-import/tests/corpus.rs:21`, `slide/slide-resolve/tests/oracle_geometry.rs:140`, `image/image-conformance/src/psd_corpus.rs:67`, `sheet/sheet-conformance/oracle/excel/drive.sh:14` | `~/paged/corpus`, "sibling checkout", "beside this repo" | `<repo root>/corpus` / the private corpus |
| `package.json` `repository` of `data/packages/data-bundle`, `draw/packages/draw-bundle`, `image/glue`, `publish/packages/{pdf,publish}-bundle`, `sheet/packages/sheet-bundle`, `web/packages/web-bundle` | `paged-media/plugin-<repo>`, `directory: <in-repo path>` | `paged-media/paged`, `modules/<m>/<in-repo path>` |

Verified unchanged (already `<repo root>/corpus` at the new depth, three levels
above a module crate or five above a module test directory):
`image/image-conformance/{src/psd_corpus.rs:79, tests/real_raster_corpus.rs:101, tests/real_png_corpus.rs:93, tests/real_jpeg_corpus.rs:95}`,
`doc/docx-conformance/tests/{poi_corpus.rs:90, real_word_corpus.rs:63}`,
`sheet/sheet-conformance/tests/{real_xlsx_corpus.rs:125, xlsx_recalc_corpus.rs:223}`,
`sheet/sheet-js/benches/session.rs:85`, `slide/pptx-import/tests/corpus.rs:35`,
`slide/pptx-export/tests/roundtrip.rs:35`, `slide/slide-resolve/tests/{oracle_charts.rs:63, oracle_geometry.rs:147}`,
`slide/scripts/ppt-record-corpus.sh:14`, `publish/crates/idml-export/{tests/support/corpus.rs:50, examples/corpus_sweep.rs:218}` (four up),
`draw/packages/draw-bundle/test/real-vector-corpus.spec.ts:81`, `web/packages/web-model/test/real-html-corpus.spec.ts:63`.
The `../corpus/...` paths in `modules/sheet` point at the module's own committed
`modules/sheet/corpus/` and are correct.

### engine/core

| File:line | Old | New |
| --- | --- | --- |
| `crates/paged-scene/tests/grid_matrix_corpus.rs:30-32,52-54` | `PAGED_GRID_CORPUS=1` → `../../../corpus` (was `~/paged/corpus`; in the monorepo `engine/corpus`) | `../../../../corpus` = `<repo root>/corpus` |
| `crates/paged-gen/src/samples/images.rs:92-95,335-342` | `PHOTO_URI = "file:/Users/drietsch/idml/corpus/samples/media/photo.webp"` (an absolute path into a pre-split checkout; resolved on no machine) | `"file:photo.webp"`, resolved by basename under `--links-dir` like `LINK_URI` |
| `crates/paged-cli/tests/package_folder.rs:39` | comment: "an absolute `photo.webp` that is on no machine" | "`file:photo.webp`, which is not beside it" |
| `web/idml-viewer/package.json:8-9` | `repository.url` `paged-media/core.git`, `directory: web/idml-viewer` | `paged-media/paged`, `engine/core/web/idml-viewer` |

`PHOTO_URI` is in no committed output: `corpus/generated/*.idml` is gitignored and
the committed InDesign reference `images.pdf` / `images.export.meta.json` do not
carry the string (and pin no IDML hash). The generated `images.idml` now carries
`LinkResourceURI="file:photo.webp"` on 18 placements; the photo variants render
their missing-link state, as they already did everywhere. The asset itself lives in
the private corpus (`idml/samples/media/photo.webp`); dropping it into
`corpus/generated/images-Links/` lets render-diff pick it up.

The `../../corpus/...` (and `include_bytes!("../../../corpus/…")`) paths in
`engine/core/crates/*` point at the engine's own committed `engine/core/corpus/` and
are correct.

### apps/server

| File:line | Old | New |
| --- | --- | --- |
| `server/engine/Dockerfile` | `git clone https://github.com/paged-media/core` at `CORE_REV`, build in `/core` | `COPY engine/core/ ./` with the repository root as build context: `docker build -f apps/server/server/engine/Dockerfile -t paged-engine .` |
| `server/engine/Dockerfile.dockerignore` (new) | — | keeps `**/target`, `**/node_modules`, `**/.git`, `corpus` out of the root context (BuildKit's per-Dockerfile ignore file) |
| `server/README.md:128,132-133` | wrangler snippet `"image": "../../engine/Dockerfile"` | adds `"image_build_context": "../../../../.."` (the repository root, from `crates/paged-server/wrangler.jsonc`) |

`apps/server/server/Cargo.toml`'s git dependencies on core (`paged-repo`, `paged-mcp`
at `b612da5d`) are left for step A6.

## Deliberately left

| Where | Why |
| --- | --- |
| Every `.github/` directory, root and nested: `apps/editor/.github/actions/plugin-{doc,slide}-from-source/action.yml` (checkout to `plugins/plugin-{doc,slide}`), `apps/editor/.github/workflows/{playground.yml:9,46, tests.yml:349}`, `modules/image/.github/workflows/{ci.yml:214,217,295, publish-state.yml:29}`, `modules/doc/.github/workflows/vitest.yml:32`, `platform/extensions/.github/workflows/publish.yml` | owned by the CI step in another worktree. The `from-source` actions must now build `modules/{doc,slide}` in place instead of checking them out. |
| Cargo git dependencies: `engine/core/Cargo.toml:83-93` (`[patch."https://github.com/paged-media/core"]`), `idml-import`/`idml-export` git deps on `paged-media/plugin-publish` in 13 `engine/core/crates/*/Cargo.toml` lines, `engine/core/deny.toml:79`, `modules/publish/deny.toml:46`, `apps/server/server/Cargo.toml`; `engine/core/CLAUDE.md:75` describes them | step A6 (Cargo git deps → path deps). After A6 the server Dockerfile may also need `COPY modules/publish/` (the engine's IDML adapter). |
| `apps/editor` test suite reading `${REPO_ROOT}/corpus/...` with `REPO_ROOT` = `apps/editor` (≈99 spec files, `tests/e2e/harness/fixtures.ts`, `tests/fidelity/fixtures.ts`, `perf-probe.mjs`) | the editor's own `apps/editor/corpus` symlink convention; rewriting 99 specs would change behaviour. `ln -s ../../corpus apps/editor/corpus` points it at the root corpus. |
| `~/paged/sync-wasm.sh` (`apps/editor/CLAUDE.md:74,79`), `~/paged/brand/editor` (`apps/editor/CLAUDE.md:116`), `~/paged/cockpit` (`modules/{data,doc,image,sheet,slide}/CLAUDE.md`), `~/paged/thoughts/…` (`modules/sheet/CLAUDE.md:20`) | local tools and private repositories outside this repository; no in-repo equivalent to point at yet. |
| Rendered showcase prose `apps/editor/apps/canvas/tests/showcase/pages/03-editorial.ts:284`, `12-layers.ts:122` (`~/paged/sync-wasm.sh`) | text printed into the showcase document (output, not instructions). |
| `apps/editor/apps/canvas/showcase/showcase.coverage.json:2` (`"generatedFrom": "/Users/drietsch/paged/state/registry/features"`) | generated artifact; the next showcase build rewrites it (`"unavailable"` without `PAGED_FEATURE_REGISTRY`). |
| `apps/editor/apps/canvas/src/worker/render.ts:33`, `engine/core/crates/paged-renderer/src/module/mod.rs:32` (`/Users/drietsch/.claude/plans/…`); `apps/editor/apps/canvas/perf-probe.mjs:13`, `apps/editor/apps/canvas/tests/fidelity/google-fonts.ts:235` (`/Users/drietsch/idml/…`) | code comments, not paths the code uses (the last two describe the pre-split history). Candidates for a publication pass. |
| `apps/editor/apps/canvas/src/app-commands.ts:88` (`https://github.com/paged-media/editor/issues/new`) | a runtime URL (product behaviour), not a path; switch to `paged-media/paged/issues` when the old repository stops taking issues. |
| GitHub links to the old repositories' documents: `engine/core/docs/{README.md:51-54, architecture.md:24-25, design/canvas.md:35, design/plugin-metadata-and-baking.md:22,150,152, reference/composition-format.md:127, reference/deferred-scope.md:15, reference/paged-file-format.md:13}`, `modules/doc/docs/concept.md:10,12,77,190,460`, `apps/editor/docs/README.md:58`, `modules/{draw/docs/status.md:94, sheet/docs/status.md:108}` | documentation links; they still resolve while the old repositories exist (read-only). Rewrite to in-repo relative links in a docs pass. |
| ADRs and status logs (`*/docs/adr/*`, `*/docs/status.md`, `engine/core/crates/paged-sdk/WEBGPU.md:133`, `apps/editor/packages/ai/README.md` "Source: plugin-sdk `df58d0e`") | historical records. |
| Titles naming the old repositories: `modules/web/README.md:1`, `modules/web/CLAUDE.md:3`, `platform/extensions/README.md:1` | descriptive, not paths. |
| `engine/core/.gitignore:50-51` (`/corpus/samples`, a local mount of the private corpus's fidelity engine) | machine-specific mount inside the engine, unaffected by the move. |
| `modules/slide/pptx-export/tests/roundtrip.rs:35` | already resolves to `<repo root>/corpus`; it has no env override and none was added. |

## Leftover grep hits

```sh
git grep -nIP '~/paged|\$HOME/paged|/Users/drietsch|\.\./plugin-[a-z]+/|plugins/plugin-|\.\./\.\./editor|\.\./editor/|\.\./core/|\.\./\.\./core/|(?<!@)paged-media/(plugin-[a-z]+|core|editor|editor-server|corpus|state|cockpit|thoughts|brand|viewer|docs|website)\b' \
  -- ':!*pnpm-lock.yaml' ':!*.lock' ':!docs/migration/*' \
  | grep -vE '"\.\./\.\./plugin-(api|sdk|cli)/|\.\./plugin-support|\.\./\.\./\.\./plugin-sdk/test'
```

(`-P` matters: with `-E`, `\b` is not a word boundary in git's regex on macOS.
`(?<!@)` skips npm scope names such as `@paged-media/plugin-sdk`; the excluded
imports are in-package paths.) After this step it reports 682 lines, none of them
a path the code resolves:

- 84 in nested `.github/` directories (CI step; includes `repository:
  paged-media/{core,corpus,plugin-doc,plugin-slide}` checkouts and the CLA links).
- 25 in `Cargo.toml` / `deny.toml` (git dependencies and their comments; A6).
- 203 in ADR files (historical records).
- 329 in other Markdown: the per-repository ADR registers in `*/docs/README.md`,
  concept/architecture/design notes, READMEs, `CLAUDE.md`, `LICENSE.md` and
  `CONTRIBUTING.md` naming the old repositories (230 of the non-ADR hits are
  `github.com/paged-media/<old repository>` links). The instruction-type ones
  (setup commands, `validate:manifest` commands, the showcase `cd`) were updated;
  the rest describe or link and are listed under "Deliberately left".
- 44 in other files, all comments or data, not resolved paths: the items in the
  table above (render.ts, mod.rs, perf-probe.mjs, google-fonts.ts,
  showcase.coverage.json, the showcase prose, app-commands.ts); references to old
  repositories' issues and evidence joins (`paged-media/core#58`/`#70` in draw and
  sheet tests, `paged-media/state` in `.config/nextest.toml` files,
  `modules/image/registry/*.yaml`, `capabilities.ts`, `scripting_feature_evidence.rs`;
  `paged-media/cockpit` in `apps/editor/scripts/feat-vocabulary{.json,-guard.mjs}`;
  `paged-media/corpus` in `engine/core/scripts/check-font-hashes.sh` and
  `corpus/generated/{diff,render-diff}.sh`); the generated banner of
  `platform/extensions/packages/plugin-api/src/wire.d.ts` and the
  `sync-wire.mjs` template that writes it ("tsify output from paged-media/core");
  `apps/editor/packages/ai/package.json`'s description and `client/src/protocol.ts`;
  `engine/core/Makefile:1`; `modules/publish/.../graphic_line_fill_roundtrip.rs:44`;
  the vendoring record `modules/slide/vendor/paged-ooxml/SYNCED` (`source =
  paged-media/plugin-doc`; `scripts/sync-ooxml.sh` takes the source checkout as
  an argument, which is now `modules/doc`); and
  `platform/extensions/packages/plugin-cli/bin/paged-plugin.mjs:6`, a false
  positive (`../../plugin-api/src/manifest.schema.json` inside the package).

## Open issues found on the way

- `platform/extensions`: `packages/plugin-sdk/src/wasm-loader.ts` changed, and the
  contract guard (now working) requires a plugin-sdk version bump for any
  `packages/plugin-sdk/src/**` change. `0.2.63-canary.0` is already on npm, so
  `node scripts/assert-contract-bumped.mjs d66d2347d` fails until plugin-sdk is
  bumped (a release decision, not made here).
- `platform/extensions`: with the engine in-repo, `sync-catalog.mjs --check` now
  compares against `engine/core`'s own `catalog.json` (the strict comparison) and
  fails: core main's `hostFunctions` and `operations` lead the vendored copy
  (provenance: `introspect-wasm@0.73.4`). `sync-wire.mjs --check` fails against
  the editor's installed `canvas-wasm@0.73.3` because the vendored wire was synced
  from `0.73.4`. Both are content drift, not path problems.
- `apps/editor` — redo on the final assembly: this worktree's editor is the
  pre-revert tree, whose `package.json` pins `@paged-media/repo-wasm@0.74.0` (not on
  npm) and whose committed `pnpm-lock.yaml` was already stale against it (no
  `packages/repository` importer), so `pnpm install --frozen-lockfile` fails before
  and after this step. The lockfile commit only moves the six doc/slide link lines
  and can be dropped; regenerate the editor lock, install and typecheck after the
  rebase onto the final editor tree.
- `apps/editor`: `node scripts/check-plugin-pins.mjs` (now reading `modules/`)
  reports real drift: `@paged-media/pdf` pinned `0.2.5-canary.0` vs `0.2.6-canary.0`
  in the module, `@paged-media/publish` `0.1.0-canary.0` vs `0.1.1-canary.0`.
- `apps/server`: the Dockerfile was not built here (Docker could not reach the
  registry from this environment).

## Verification run in this step

All in this worktree; exit codes as observed.

| Command | Exit |
| --- | --- |
| `corepack pnpm@9.0.0 install --lockfile-only` (apps/editor) | 1 — `ERR_PNPM_FETCH_404` for `@paged-media/repo-wasm` (pre-existing) |
| `corepack pnpm@9.0.0 install --frozen-lockfile` (apps/editor, at the base commit and after the change) | 1 both times — `ERR_PNPM_OUTDATED_LOCKFILE` on `packages/repository` (pre-existing) |
| `corepack pnpm@9.0.0 install --no-frozen-lockfile` (apps/editor, with a temporary uncommitted `file:` override of repo-wasm to a scratch copy of the local build, as ADR 225 describes; package.json and lockfile restored afterwards) | 0 — pnpm wrote the same doc/slide link lines as the committed lockfile |
| `pnpm install --frozen-lockfile` (pnpm 10.28.0) in modules/doc, modules/slide, modules/draw, modules/data, platform/extensions | 0 each |
| `corepack pnpm@9.0.0 typecheck` (apps/editor) | 0 |
| `pnpm run typecheck:showcase`, `pnpm run typecheck:tests` (apps/editor/apps/canvas; the second re-run after the diff.ts change) | 0, 0 (0) |
| `eslint` on the touched editor `.ts`/`.mjs` files | 0 |
| `node scripts/fidelity-thresholds-schema.test.mjs` (apps/editor; without corpus, and with a temporary root `corpus` symlink) | 0 (skip message), 0 (3/3 pass) |
| `node scripts/check-plugin-pins.mjs --warn-only` (apps/editor) | 0 (reports 2 real drifts, see above) |
| `pnpm typecheck` (platform/extensions) | 0 |
| `vitest run test/sync-catalog.spec.ts test/sync-wire.spec.ts`, `vitest run test/harness.spec.ts` (platform/extensions/packages/plugin-sdk) | 0 (18 tests), 0 (28 tests) |
| `node scripts/sync-wire.mjs --check`, `node scripts/sync-catalog.mjs --check` (platform/extensions) | 1, 1 — both resolve the new in-repo locations, then report content drift (see above) |
| `node scripts/assert-contract-bumped.mjs d66d2347d` (platform/extensions) | 1 — plugin-sdk src changed without a version bump (see above) |
| `pnpm typecheck` (modules/draw, modules/data) | 0, 0 |
| `vitest run test/conformance/corpus.spec.ts` (draw-bundle), `REQUIRE_REAL_CORE=1 vitest run test/barcode-paint-real-core.spec.ts` (data-bundle) | 0 (10 tests), 0 (1 test) |
| `validate:manifest` in modules/{sheet,data,doc,slide,image}; `test` in modules/image/manifest | 0 each |
| `bash -n` run.sh; `python3` parse of fidelity-local.py and classify.py; `fidelity-local.py --help` | 0 |
| `cargo check --workspace --tests` (engine/core) | 0 |
| `cargo run -p paged-gen -- emit-all`, then `cargo test -p paged-cli --test package_folder` (engine/core) | 0, 0 (2 tests; the photo link still reports `missing`) |
| `PAGED_GRID_CORPUS=1 cargo test -p paged-scene --test grid_matrix_corpus -- --ignored` (engine/core, root `corpus` symlink present) | 0 — 179 IDMLs read from `<repo root>/corpus` |
| `cargo check --workspace --all-targets` in modules/publish, modules/image, modules/doc, modules/slide, modules/sheet | 0 each |
| `PAGED_REQUIRE_CORPUS=1 cargo test -p pptx-import --test corpus` (modules/slide) | 0 — the default found `<repo root>/corpus` |
| `docker build --check -f apps/server/server/engine/Dockerfile .` | timed out — the daemon could not load base-image metadata ("only one connection allowed") |

Cargo targets were under `/Volumes/Dietz/paged-import/targets/<workspace>`. The
temporary root `corpus` symlink used for the corpus runs is gitignored and was
removed afterwards.

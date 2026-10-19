# Shared first-party foundations (wave C, TypeScript items)

Wave C moves code that every built-in module had its own copy of into one internal
implementation under `platform/shared/*` (PM-0002: importable by the built-ins and the
editor, never by `platform/extensions`), and slims what the public SDK carries. This page
records the TypeScript items C6–C9, C11 and C12, measured on 2026-10-19. C10 (`panel-kit`) and
the Rust items C1–C5 are separate.

How it was measured:

- **LOC:** `git show --shortstat` of each commit (renames detected).
- **Tests:** each touched package's `bun run test`, before and after, with the engine and
  module wasm built. Locally, four suites have the same failures before and after, and none of
  them comes from these changes:
  - draw-bundle's Illustrator and InDesign recordings: 8, which need the recording tools;
  - the `SOURCE_HASH` freshness checks in image, sheet, web and data, against wasm built from
    an earlier tree.
- **Bundle:** `vite build` of `apps/editor/apps/canvas`, summing the emitted `.js` files (raw,
  and gzip -9), plus `apps/editor/scripts/wasm-budget.mjs`.

## Summary

| Item | What changed                                                        | Duplicates before → after                                                                           |
| ---- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| C6   | `platform/shared/wasm-boot`: one single-flight wasm boot            | hand-rolled wasm-bindgen boots 9 → 0; unguarded boot paths 3 → 0                                     |
| C7   | root `tsconfig.base.json`, one source-hash, one build-wasm template | tsconfig bases 9 → 1 (15 inlined copies → 1); source-hash 4 → 1; build-wasm scripts 10 → 1 template |
| C8   | public test doubles beside the harness                              | `mapBacking` 25 → 0; silent loggers 108 → 5; generic fake editors 2 → 0                              |
| C9   | one snapper, one Pencil                                             | snappers 2 → 1 (TS fallbacks 2 → 0); Pencils 2 → 1                                                   |
| C11  | `platform/shared/helpers`                                           | sha256 5 → 1; base64 13 in 10 files → 1; colour 3 → 1; `asciiJson` 3 → 1; unit tables, see C11      |
| C12  | `ai` and `cli` leave `platform/extensions`; ADR 331                  | packages in the community-facing tree 4 → 2                                                          |

Canvas build, before wave C → after C6, C7, C8, C9, C11 and C12:

- **JS, raw:** 5,207,920 → 5,207,486 B (−434 B).
- **JS, gzip:** 1,467,276 → 1,466,853 B (−423 B).
- **Chunks:** 426 → 431. The shared packages are split into their own chunks, which costs more
  than the copies they replace: C11 alone was +2.7 KB raw and +1.3 KB gzip.
- **wasm:** 99,574,817 B emitted, unchanged; the app-wide budget is 99.6 of 100 MB.

## C6 — wasm-boot

- **Commits:** `788213db7` (+1199 / −571, of which the package and its tests are +647) and
  `3eb0ffdb5`.
- **The race.** A wasm-bindgen `--target web` glue holds one module-level instance, and its async
  `default()` checks "already initialised" before its first await. Two boots in flight both
  instantiate, and the second replaces the instance. An engine built on the first then reads the
  second's memory with its own pointers. This is how paged.sheet crashed with "memory access out
  of bounds", which is why sheet already had a guard.
- **What was unguarded:**
  - `DocEngine.boot()` in doc, which is called from six places;
  - image's `bootEngine`;
  - data's `bootEngine`.

  Slide reset its memo from every failed caller, so a stale failure could drop a newer flight.
  Trace, the pdf mapper, PDFium, web and image's decode worker were already memoized.
- **Now** every module declares one `wasmBindgenModule({ glue, wasmUrl, wasmFile, notBuilt })`
  at module scope:
  - the glue `import()` and the `?url` asset import stay literal in the module's own file, as
    thunks, so the bundler still rewrites them;
  - Node reads the bytes and calls `initSync`; a browser hands `default()` the asset URL;
  - a failed boot is forgotten, so the next call retries;
  - PDFium (an Emscripten module) uses `wasmBytes` and `singleFlight`;
  - data keeps its module door and runs it inside a `singleFlight`.
- **Tests:** wasm-boot has 14 tests.
  - The race is reproduced against a glue that has wasm-bindgen's init semantics: two
    instantiations without the guard, and one shared instance across eight concurrent boots
    with it.
  - Retry after `notBuilt`, the Node and browser paths, and `singleFlight`'s stale-failure
    rule.
  - A scan fails when any module source instantiates a glue outside wasm-boot. It flags all
    eight old wasm-bindgen loaders, and allows data's module door, with the reason recorded.

  The module suites are unchanged:

  | Suite         | Tests                   |
  | ------------- | ----------------------- |
  | doc           | 54                      |
  | slide         | 69                      |
  | image         | 477                     |
  | draw          | 1816                    |
  | pdf           | 36                      |
  | web           | 346                     |
  | sheet         | 405                     |
  | data          | 438 (173 skip)          |

- **CI:** `shared-test.yml` runs the package. The module workflows list
  `platform/shared/wasm-boot/**` in their paths.
- **Bundle:** −518 B raw, +68 B gzip.

## C7 — tooling

- **Commits:**
  - `c602bf718` root `tsconfig.base.json`: +69 / −263;
  - `4c7d4b5b8` one source-hash script: +279 / −413;
  - `2cfa40783` one build-wasm template: +331 / −464;
  - `ca431c1dd` the module workflows share `wasm-tools`: +55 / −56.
- **tsconfig.** One root base. Nine byte-identical copies are gone, and six editor configs
  that inlined the same block extend it too. `tsc --showConfig` is byte-identical for all 33
  configs, and plugin-sdk's declaration build still compiles at `module` ES2020.
- **source-hash.** `tooling/js/source-hash.mjs <module>` replaces the copies in data, image,
  sheet and web. It gives the same digest and the same input list as each copy did.
  `check-contract-imports` and `package-hash` no longer existed after wave D (the lint
  boundaries replaced them).
- **build-wasm.** `tooling/rust/build-wasm.sh` plus thin per-module wrappers: 633 lines in ten
  scripts → 462 lines.
  - All 11 builds produce byte-identical glue, wasm and `SOURCE_HASH`: 57 files compared.
  - Behaviour the copies had let drift is now the same everywhere: `CARGO_TARGET_DIR` and
    `WASM_BINDGEN` are honoured, the wasm-bindgen pin is checked before the build, and publish
    gets the size stop.
  - No tsup preset: tsup is not used anywhere.
- **Moon.** No workflow was replaced. `moon.yml` runs on pull requests only, while changes go
  straight to main. It builds no module wasm, runs no Rust task, and has no task for the
  modules' gates (dependency guards, coverage, cargo-deny). The evidence pull is also keyed to
  the workflow file names. The reasons are recorded in the `moon.yml` header.
- **Workflow dedupe.** Seven inline wasm-bindgen and binaryen installs → `.github/actions/wasm-tools`,
  which reads both pins from `tooling/bootstrap.sh`.

## C8 — test kit

The public SDK harness already had the conformance host (`createHeadlessHost`) and a recording
fake editor (`createFakeEditor`, the gesture kit). What suites still copied was measured on
main at `4be5f0eba`:

| Double                                                          | Before | After |
| --------------------------------------------------------------- | -----: | ----: |
| `mapBacking` definitions                                         |     25 |     0 |
| silent loggers in test files                                     |    108 |     5 |
| generic registry fake editors (draw and web activation specs)    |      2 |     0 |
| domain fake editors (image, sheet, plugin-sdk's adapter tests)   |      3 |     3 |
| test files casting a partial `BundleHost` stub                   |     89 |    89 |

- **Commit:** `2553b4d1b`, plugin-api and plugin-sdk 0.2.80-canary.0 (+527 / −735).
- **What changed:**
  - `mapBacking()` and `silentConsole` are public, in `src/testing.ts`, and the host's own
    fallback backing uses `mapBacking`.
  - `createFakeEditor()` gains `ids(registry)`, so it is the editor an activation test passes
    to `loadBundle`.
  - The harness's hosts share one in-memory `host.storage` unless `storage` is given. That
    fixes finding HOST-1: a re-activated bundle read an empty store. Its expected failure is an
    ordinary test now, and its rows are gone from `testing-plugins.md` and
    `conformance-findings-2026-10.md`.
- **Kept:**
  - The domain fakes: image's renderer resource channel and placed-image store (28 files),
    sheet's multi-document host, and plugin-sdk's own adapter-test editor (39 files, which
    script about 15 doors).
  - The partial `BundleHost` stubs. Each one says exactly which doors a unit touches. A stub
    with defaults filled in would change what a `host.x === undefined` or `supports()` probe
    sees.
  - The five remaining loggers have other shapes.
- **Tests:**
  - plugin-sdk 752 → 755: `testing.spec.ts`, an activation test over the three doubles.
  - The canvas headless tier: HOST-1 runs as an ordinary test now.
  - Every other suite keeps its count.
- **Release checks:**
  - `stage.mjs` and `verify-tarballs.mjs` pass at 0.74.99.
  - `consumer-test.sh` passes under npm and Bun, with nodenext and bundler resolution, on
    TypeScript 7.0.2 and 5.9.3.
  - The consumer test now also runs an activation test over `createFakeEditor`, `mapBacking`
    and `silentConsole`.

## C9 — tools

- **Commits:**
  - `f39c8bc43` one snapper for the Pen and Curvature: +533 / −432;
  - `b14ba47f2` one Pencil, the host's, over draw-tools' `PencilMachine`: +878 / −873;
  - `12ae7e02c` comment only.
- **Snapper.** `createSnapper(query)` in draw-tools is the only code that asks the engine to
  snap; the editor's snapper and draw's Curvature are adapters over it.
  - Both TypeScript fallback resolvers are gone: the engine owns snapping (engine ADR 125,
    amended), and the tools and engine ship at one revision.
  - Direct Selection keeps its local snap.
  - Recorded in modules/draw ADR 358.
- **Pencil.** `paged.tool.pencil` is a thin layer over `PencilMachine`, and draw's Pencil,
  handler and options are deleted, so paged.draw registers 20 tools.
  - It has draw's three options; the engine still fits the curve.
  - A click no longer commits a path, which fixes GT-2.
  - Recorded in modules/draw ADR 359, which amends ADR 352.
- **Eyedropper and Scissors** stay two modes each, as the plan asks.
- **Tests:**

  | Suite                    | Before | After | Why                                        |
  | ------------------------ | -----: | ----: | ------------------------------------------ |
  | editor tools             |    133 |   144 | option, closing and snapper tests added    |
  | draw-tools               |    337 |   342 | new snapper spec                           |
  | draw-geometry            |    681 |   680 | `pageTargets` removed                      |
  | draw-bundle              |   1816 |  1801 | the Pencil's tests moved to the host       |
  | headless `pencil.test.ts` |      — |     7 | new, against the real engine               |

- **Bundle:** −2,399 B raw.

## C11 — small helpers

- **Commit:** `f414fb9b5` (+932 / −422). The package and its tests are +681. In the module and
  editor sources: +155 / −393.
- `@paged-media/helpers` has one implementation each:

  | Helper                                                   | Copies replaced                                                                                   |
  | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
  | `sha256Hex` / `sha256HexPrefix`                          | slide, image, doc, sheet, data                                                                    |
  | base64, base64url and `data:` URLs                        | 13 functions in 10 files: web ×3, pdf ×2, data, image, the canvas live bridge, the repository sign-in, ai (moved in C12) |
  | `PT_PER_UNIT` / `parseLength`, `PX_PER_PT` / `PT_PER_PX` | the shell's copy of the SDK table, the length inputs' table, web's six constants                  |
  | `hexToRgb` / `rgbToHex` / naive CMYK                      | ui's colour space, draw-geometry, image's colour state                                            |
  | `labelKey`, `asciiJson`, the `{ v, data }` envelope       | see below                                                                                         |

  - **sha256.** paged.data's persisted 128-bit content address stays the 32-digit prefix of the
    full digest. `sha256Hex` takes one parameter, so `parts.map(sha256Hex)` stays safe.
  - **Units.** Three tables were the same apart from `px`. The shell's copy of the SDK table is
    gone; the length inputs build theirs from the shared one, keeping 1 px = 1 pt; the public
    SDK keeps its twin. web's six `96 / 72` constants are the shared `PX_PER_PT` / `PT_PER_PX`.
  - **Labels.** `labelKey` replaces eight `x-paged:${id}` derivations. `asciiJson` replaces
    three copies (slide, data, draw). The envelope codec serves slide, the shell's oid label and
    its edit-context reader, and data's `parseEnvelope`.
- **Behaviour now the same everywhere:**
  - `hexToRgb` reads `#rgb`;
  - `asciiJson` also escapes U+007F;
  - a label envelope decodes only with an integer `v` of at least 1, as the engine accepts.

  data's `makeEnvelope` keeps writing plain JSON, which leaves the persisted text of existing
  labels as it was.
- **Stays in the public SDK:** its own `parseLength` and `data:` URI encoder. An extension's
  contract cannot import `platform/shared`. A test holds `parseLength` and the shared table
  equal.
- **Tests:** helpers has 15, which compare against `node:crypto`, `Buffer` and the SDK. Every
  consumer suite keeps its count:

  | Suite                  | Tests     |
  | ---------------------- | --------- |
  | draw-geometry          | 681       |
  | web-model              | 299       |
  | data-host-model        | 53        |
  | shell                  | 196 + 95  |
  | repository             | 10        |
  | canvas unit            | 120       |
  | canvas DOM             | 1077      |
  | the module suites      | as in C6  |

## C12 — the public SDK

- **Commits:** `4be5f0eba` (+204 / −135, mostly renames) and `2553b4d1b`.
- **Moved out:** `@paged-media/ai` to `platform/shared/ai`, and paged-node (`@paged-media/cli`)
  to `apps/cli`.
  - `platform/extensions` holds the two public packages only, and its import boundary loses
    the `ai|cli` exception. The lint self-test now asserts both are refused there.
  - Moon has projects `ai` and `cli`.
  - The surface gate reads the verb table from `apps/cli`, with cli at 74/74 before and after.
  - Their tests keep their counts: ai 31, cli 80 (7 skip).
- **Stays (ADR 331):** the host adapter (`host-impl.ts`), `loadBundle`, `WASM_BUDGETS` and the
  core seam.
  - The public harness and `loadBundle` are built on the adapter, and are the community test
    entry (`plugin-template`, the release consumer test).
  - A published package cannot depend on a private one. Inlining one would need a declaration
    bundler and would create a run-time cycle with about ten SDK modules.
  - `WASM_BUDGETS` is the limit of the bundle-side `loadBundleWasm`.
  - `core-objects-v70.ts` is the table the protocol-71 seam delegates to, not only a fallback.
    The pre-71 dispatch (unreachable: the floor is the vendored wire's protocol, 74) stays until
    the seam next changes.

## Left, with reasons

- **The 89 partial `BundleHost` stubs:** see C8.
- **The domain fakes:** image, sheet and plugin-sdk keep theirs.
- **Moon:** it does not replace the per-module workflows (C7).
- **C9's open points:**
  - the View ▸ Snap to points toggle still does not reach draw's Curvature;
  - the graphic-default code is duplicated between the host and draw.
- **Test-only path dependencies:** `ai` and `cli` still read fixtures from
  `platform/extensions/packages/plugin-sdk/test` by path, and `ai` reads plugin-api's vendored
  catalog by path.
- **Outside this repository:** the cockpit feature registry maps some tests by path. The
  moved `ai` and `cli` suites and the retired draw Pencil tests need re-pointing there.

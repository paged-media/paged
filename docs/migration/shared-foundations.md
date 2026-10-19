# Shared first-party foundations (wave C, TypeScript items)

Wave C moves code that every built-in module had its own copy of into one internal
implementation under `platform/shared/*` (PM-0002: importable by the built-ins and the
editor, never by `platform/extensions`), and slims what the public SDK carries. This page
records the TypeScript items C6–C9, C11 and C12, measured on 2026-10-19, and after them the
Rust items as they land (C2, C5 and C4 at the end). C10 (`panel-kit`) is separate.

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
| C1   | `platform/shared/ooxml` (Rust): one OPC layer, with a memory budget | `paged-ooxml` copies 2 → 1; package readers 2 → 1 (unguarded 2 modules → 0); see C1                 |

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

## C2 — `platform/shared/fmt` (Rust)

`paged-fmt` holds the formatting facts more than one Rust formatter needs: the proleptic
Gregorian calendar, the locale table and digit grouping. It is standard library only and a
Cargo workspace of its own, like `test-resources`; every consumer takes it as a path
dependency, so it adds one line to each `Cargo.lock`. It has no number-format or date-format
grammar: each formatter keeps its own and reads its facts from here.

- **Consumers:** sheet-format, sheet-fn and sheet-js; data-core and data-expr; the engine's
  `paged-renderer` (the date variables); slide-chart through sheet-format.
- **Tests:** 11 of its own. Calendar: both directions for every date from 1600 to 2400, the
  fixed points of the sheet and data epochs, day 0 and day overflow, and the `i32` extremes of
  data's DuckDB range. A weekday test checks it against Sakamoto's formula, which two of the
  copies used, for every date of every seventh year from 1 to 10000, and 1899, 1900, 1904,
  2000 and 2100. Locale: unique tags and lookups. Digits: grouping and CLDR's minimum.
  `core / ci` runs its fmt, clippy (native and wasm32) and tests, as it does for
  `test-resources`.

### Duplicates found, before → after

The search covered every Cargo workspace (engine/core, the modules, web-render, the server):
civil-date arithmetic, weekday formulas, leap-year and month-length helpers, month and day
name tables, separator tables and digit grouping.

| What | Copies before | After |
| --- | --- | --- |
| `days_from_civil` (Hinnant) | 3: sheet-format `serial.rs`, sheet-fn `date2.rs` (inline), data-core `temporal.rs` | 1 |
| `civil_from_days` (Hinnant) | 2: sheet-format, data-core | 1 |
| weekday | 4: sheet-format `datetime.rs` and the engine's `datefmt.rs` (Sakamoto), sheet-fn `date2.rs` and data-expr `temporal.rs` (day count mod 7) | 1 |
| leap year, month length | 2 each: sheet-format, sheet-fn | 1 each |
| locale separator tables | 2: sheet-format (5 rows), data-core (9 rows) | 1 (9 rows) |
| month and day name arrays | 32: sheet-format 20, the engine 4 (English), sheet-js's fill 8 (English, German) | 20, plus the fill's one German exception |
| digit grouping | 3: sheet-format `number.rs`, data-expr `format.rs`, slide-chart | 1 (slide-chart through sheet-format, below) |

data-core and sheet-format keep one-line wrappers that convert to their own integer widths
(`i32` days and years); they hold no arithmetic.

### What stays with its formatter

- **paged.sheet:** Excel's own facts on top of the shared rows: the list separator, the
  default short-date code, the AM/PM ruling, Excel's French group separator (a space where
  CLDR has U+202F) and Excel's grouping from four digits in every locale (CLDR leaves Spanish
  `1234` ungrouped). Excel's `WEEKDAY` counts serials, phantom 1900-02-29 included
  (sheet-fn `date.rs`); that is Excel's rule, not calendar arithmetic, and stays.
- **paged.data:** the currency symbol and pattern and the `DATEFMT` default per locale, with
  the two rows kept for existing documents (ISO dates for `en`, an ASCII space before `€` for
  `de`). Its separators and grouping are the shared rows, which carry the values its table had.
- **sheet-js's fill:** its German short months say `Mär`, where the format names say `Mrz`.
  The fill keeps reading `Mär`, as before; whether Excel's German fill list does is not
  recorded.
- **Not merged:** the formula engines (modules/data ADR 550 D-9); sheet-chart's tick label
  (a placeholder until its number formats arrive, C3's area); web-model's digit grouping
  (TypeScript).

### Behaviour

The outputs are the same, by construction and by test:

- **sheet:** nextest 1501 passed / 5 skipped before and after, which includes the
  number-format, locale and date conformance corpora. The corpus lane
  (`--profile corpus`, the private XLSX corpus) passes with the same report.
- **data:** nextest 318 passed before and after, the locale and merge conformance included.
- **The engine:** its date-variable tests pass unchanged. Sakamoto's formula and the civil day
  count agree from year 1 on; before year 1, Sakamoto's truncating division was wrong, and the
  engine now counts those years right too. A month outside 1–12 still counts as the nearest
  valid one.

### slide-chart and sheet-format

slide-chart's `format_number` read a subset of Excel's format codes (`General`, `0.0…`,
`#,##0…`, a trailing `%`, the first section only) with its own grouping and Rust's rounding.
It is sheet-format's renderer now (slide ADR 710), so slide depends on modules/sheet's
sheet-format and sheet-core by path, and through them on paged-fmt; the digit-grouping copies
are 3 → 1.

- **Labels:** over 19 codes and the value grids slide-chart produces, `General` differs only
  for tiny values (`1E-11`, was `0`) and the 15-significant-digit rule (`1/3`); the other codes
  now round half away from zero, print no `-0`, and keep their literals, sections, locale
  tokens and dates. A value-axis tick that is zero up to rounding is labelled `0`. The corpus
  decks' four charts and the slide fixtures, all `General`, lay out byte for byte as before
  (every primitive of every chart, at two frame sizes).
- **wasm:** the format engine costs `slide_js_bg.wasm` 51,812 B. It landed together with
  slide's zip move (C5, below), which takes 124,223 B out, so the module never grew.

### The engine and `platform/shared`

PM-0002 names the built-ins and the editor as the users of `platform/shared/*`. The engine is
now one too, for this crate only: `paged-fmt` depends on nothing, so the engine, and the
public viewer built from it, gain no internal dependency beyond it. The amendment is in
PM-0002.

### wasm (wasm-release, `wasm-bindgen --target web`, `wasm-opt -Oz`)

| Artifact | Before | After C2 | Change |
| --- | ---: | ---: | ---: |
| `sheet_js_bg.wasm` | 1,695,106 | 1,692,360 | −2,746 |
| `data_js_bg.wasm` | 1,494,268 | 1,493,224 | −1,044 |
| `paged_canvas_wasm_bg.wasm` | 29,675,295 | 29,675,376 | +81 |
| `paged_sdk_bg.wasm` (the viewer's session) | 12,416,183 | 12,416,269 | +86 |

The month and day names sit beside the locale rows, not in them. A first version kept them in
the rows; paged.data, which prints no names, then linked all five name tables, and its wasm
grew by 6,987 B instead of shrinking.

## C5 — dependency alignment (Rust)

### zip and the deflate backend

Every workspace that reads or writes a package is on zip 9:

| Workspace | zip features | flate2 backend asked for | Backend in the shipped graph |
| --- | --- | --- | --- |
| engine/core | `deflate-flate2` | `rust_backend` | zlib-rs, see below |
| modules/publish | `deflate-flate2` | `rust_backend` | miniz_oxide |
| modules/sheet | `deflate-flate2` | `rust_backend` | miniz_oxide |
| apps/server | `deflate-flate2` | `rust_backend` | miniz_oxide |
| modules/doc | `deflate-flate2` (was `deflate`) | `rust_backend` | zlib-rs, through ooxmlsdk's zip 8 |
| modules/slide | `deflate-flate2` (was `deflate`) | `rust_backend` | miniz_oxide (was zlib-rs) |
| modules/data | through calamine (`deflate`) | none | zlib-rs; data only reads |

- **zlib-rs wins where it is on at all.** flate2 picks zlib-rs over miniz_oxide when both
  features are on. In engine/core, hayro-syntax (placed PDFs, through `hayro-interpret`, which
  enables its `unsafe` feature) turns `zlib-rs` on. Every build that includes paged-renderer
  (the canvas wasm, paged-cli, a workspace test run) deflates with zlib-rs; only a build
  without it (`-p idml-export` alone) uses miniz_oxide. hayro arrived on 2026-10-14, before
  the zip 9 change, so zip 9 changed no byte, as recorded; the workspace comment now says so.
- **zip 8 remains** in doc, through ooxmlsdk 0.12: its `parts` feature, which `mce` needs,
  depends on zip 8 with `deflate-flate2-zlib-rs`. That is why doc's packages are deflated by
  zlib-rs whatever its own zip line says (slide had the same until C1 took ooxmlsdk out of
  its graph).
- **doc and slide moved to `deflate-flate2`** after C1 and C4, on their own zip line and on
  the shared OOXML crate's feature, whose `deflate-flate2` now carries flate2's
  `rust_backend` itself (a crate that depends on it builds on its own; flate2 has no default
  backend under zip). zopfli serves only compression levels above 9, which nothing asks for.
  - **doc** keeps ooxmlsdk 0.12 (the `dom` feature) and with it zip 8's zlib-rs: its packages
    are deflated as before, byte for byte.
  - **slide** no longer compiles ooxmlsdk (C1), so nothing turns zlib-rs on: its packages are
    deflated by miniz_oxide, as engine/core declares. The parts inside are the same bytes; the
    deflated streams are not. No test pins deflate payloads (the container tests read zip
    header fields), and slide's export and corpus lanes pass.

| Artifact (after C1 and C4) | Before | After | Change |
| --- | ---: | ---: | ---: |
| `docx_js_bg.wasm` (zip move) | 6,828,821 | 6,748,906 | −79,915 |
| `slide_js_bg.wasm` (zip move) | 1,802,104 | 1,677,881 | −124,223 |
| `slide_js_bg.wasm` (zip move and slide-chart, C2) | 1,802,104 | 1,729,693 | −72,411 |

### harfrust

image was aligned by U3: image-js and engine/core's paged-text both require harfrust 0.14, the
newest release. engine/core's second copy (0.12, through usvg's text feature) left with usvg's
text feature on main. The one other copy is web-render's 0.8, which parley 0.10 requires
(Blitz 0.3.0-alpha.6, held: rust-majors.md).

### Other crates on different majors

The scan: `cargo metadata --no-deps` per workspace for every direct crates.io dependency and its
requirement, compared across the eleven workspaces and paged-fmt. Three crates differ, and
all three are the documented holds of [rust-majors.md](rust-majors.md):

| Crate | Versions | Hold |
| --- | --- | --- |
| quick-xml | 0.41 (core, doc, sheet, slide), 0.42 (data) | ooxmlsdk requires 0.41; core's move rewrites its IDML reader and writer and changes written bytes |
| kurbo | 0.11 (core), 0.13 (web-render; core's hayro as `kurbo13`) | 0.12+ rewrote the stroker and offsetter (draw's Illustrator oracle) |
| skrifa | 0.48 (image, slide), 0.42 (web-render) | the version parley 0.10 builds (Blitz) |

moxcms (0.8, held) and ooxmlsdk (0.12, held) are on one version wherever they are direct.
The transitive duplicates are third-party crates' own requirements, none of them ours to
move: in the engine, skrifa 0.42 (subsetter), 0.44 (vello) and 0.46 (hayro), and
miniz_oxide 0.8 beside 0.9 (png 0.18, also in image's dev graph).

## C4 — doc and slide build native documents (Rust)

paged.doc's standalone-open skeleton and paged.slide's deck are built as
`paged_scene::Document`s with the engine's model crates and packaged by core's one `.paged`
writer (`paged_store::package::wrap_document`), as the PDF mapper already did. The
hand-written IDML writers are gone: `docx-skeleton`'s IDML half (237 lines) and `slide-idml`
(1,363 lines), 1,600 lines in all. Decisions: doc ADR 606, slide ADR 708 (amending
doc ADR 603 and slide ADR 700).

### Equivalence

Before the writers were deleted, each module had a test that built the document both ways and
compared the IDML importer's model of the old package with the new document, serialised as
the model part (`paged_store::to_bytes`, maps in key order):

| Module | Compared | Result |
| --- | --- | --- |
| doc | 30 conformance builders, `annual-report.docx`, `merge-letter.docx`; the docx corpus lane (273 of 292 files import); each with span/split columns on and off | equal; one field differs on one corpus file (below) |
| slide | the 10 PowerPoint-authored fixtures, the 7 decks of the pptx corpus lane; also the report beside the package (stories, elements, diagnostics) and the package read back as the engine reads it | equal |

The tests are in the history (`docx-skeleton/tests/equivalence.rs`,
`slide-native/tests/equivalence.rs` at the commits that added the builders). Behaviour tests
stay: the skeleton's page, margin, frame, story and determinism checks now assert the native
document read back from the package; slide-idml's baselines test and unit tests moved to
`slide-native`, beside new package tests (pages, masters, stories, elements, a picture's
blob, crop transform and the not-a-picture diagnostic, determinism of the model).

### What the old path got wrong, and the new one does not

- **The document name kept its escapes.** idml-import reads the designmap's `Name`
  attribute raw, so `a&b.docx` opened as a document named `a&amp;b.docx` (one corpus file).
  The same raw read applies to ids and style names the writers escaped; no slide fixture or
  corpus deck has one.

### What the new path keeps from the old one

- Lengths to the thousandth of a point (the IDML writers' number format), names without line
  breaks (XML attribute normalisation), the `20.0` DOM version and the root XML tag, so a
  document opens as it did.

### Gaps recorded, not changed here

- **The model part is not byte-stable for map fields.** `paged-store` writes the model's
  `HashMap`s (a spread's labels and item names, master spreads) in iteration order, so two
  native builds of the same deck are the same document but not always the same bytes (the
  IDML writer's output was byte-stable). Sorting them is a core change. In wasm the hasher
  keys are fixed, so the editor's imports are stable.
- **The grow rule.** The model can carry a story's grow rule; the doc bundle still sets it on
  the wire after the open.

### wasm (wasm-release, `wasm-bindgen --target web`, `wasm-opt -Oz`)

The plan expected both artifacts to shrink; both grow. A module that produces a native
document carries the serializer of the whole engine model (the model part is JSON) and the
content hash of image blobs; the IDML writer it replaces was small string formatting.

| Artifact | Before | After C4 | Change |
| --- | ---: | ---: | ---: |
| `docx_js_bg.wasm` | 6,660,701 | 6,834,216 | +173,515 |
| `slide_js_bg.wasm` | 1,559,562 | 1,808,272 | +248,710 |

- Mitigations in the numbers: the model crates (and slide's builder) build at
  `opt-level = "z"` (doc −17 KB, slide −23 KB); the derived caches are not rebuilt before
  writing (doc −19 KB). The first doc build was +209,903.
- App total: CI measured 98,601,399 B at `3ce59f523`; with C4 that is 99,023,624 B
  (+422,225), under the 100,000,000 B budget by 976,376 B.
- The structural fix is one binary for doc, slide and the PDF mapper (each now carries the
  same serializer; deferred in the plan). The alternative, handing the engine an IR to build
  the document from, needs a new host door and puts module code in the engine.

## C1 — the OOXML foundation (Rust)

`paged-ooxml` moved from `modules/doc/paged-ooxml` to `platform/shared/ooxml`, a Cargo
workspace of its own (as `test-resources` is) that doc, slide and sheet take as a path
dependency. The record is modules/doc ADR 607, which supersedes slide ADR 701.

- **De-vendored.** slide's `vendor/paged-ooxml` (a byte-identical copy), its `SYNCED` stamp,
  `scripts/sync-ooxml.sh`, the `vendor-check` Moon task and the CI drift step are gone.
- **sheet's OPC layer folded in, with its budget.** One `read_zip(bytes, budget)` reads every
  package of the three modules, at 1 GiB uncompressed. It refuses a package whose entries
  declare more than the budget before inflating anything, never pre-allocates a declared size
  (at most 8 MiB, and what the compressed bytes could hold), and stops an entry that inflates
  past the budget still unspent. This is the security fix: doc and slide pre-allocated each
  entry at its claimed size and inflated without a limit.
- **Proved at the importers.** `docx-conformance/tests/zip_budget.rs` and
  `slide-js/tests/zip_budget.rs` feed a 1,100-entry bomb (about 1.1 MB, 1.07 GiB declared) and
  a streamed entry whose central directory claims 4 GiB for 64 KiB to every entry point (doc:
  `import_docx`, `import_docx_with_package`, `DocSession::load`; slide: `import_pptx`,
  `embedded_faces`, `slide_js::import`). Each is refused (or read at its real size), and no single
  allocation reaches 64 MiB. Against the old reader both tests fail: the 208-byte file made a
  4,294,967,295-byte allocation, and the bomb inflated in full before the import gave up on a
  missing main part.
- **One of each:** content-type table, `.rels` parser (`parse`, tolerant, for doc and slide;
  `try_parse`, strict, for sheet: each keeps its behaviour), `resolve_target` / `part_dir` /
  `rels_part_name`, legacy-container sniff, byte splicer, and the zip writer (`write_zip`; each
  module keeps its own entry options, which decide its container bytes).
- **The XML helpers** (`paged_ooxml::xml`): `attr` and `attr_raw`, `general_ref`,
  `local_name`, `prefix_of`, `escape_text`, `escape_attr`, `unescape`. They report quick-xml's
  own errors, and have `*_as` forms that build the caller's error type where the failure
  happens, so sheet's errors keep their variants and messages and its call sites carry no
  conversion.
- **DrawingML colour** (`paged_ooxml::colour`): HSL, SpreadsheetML's `tint` (`excel_tint`,
  HSL luminance) and DrawingML's `a:tint` / `a:shade` (`dml_tint`, `dml_shade`, linear
  light), kept apart.
- **`ooxmlsdk` behind the `dom` feature**, which only doc enables. slide's lock loses
  `ooxmlsdk` and zip 8, and with them its three zip-8 advisory ignores. The pins stay: ooxmlsdk
  0.12, quick-xml 0.41.
- **zip's deflate backend is the consumer's** (`deflate` for doc and slide, `deflate-flate2`
  for sheet), so no module's compressed bytes change.
- **The wasm builds name the shared crate relative to the repository**
  (`tooling/rust/build-wasm.sh` remaps `platform/shared/`). Cargo names a crate outside the
  module's workspace by its absolute path, which put the build machine's directory into the
  wasm's panic locations.

Duplicates before → after:

| What | Before | After |
| --- | --- | --- |
| `paged-ooxml` crate | 2 (doc, slide `vendor/`) | 1 |
| zip package readers | 2 (one with a budget) | 1, with the budget |
| `[Content_Types].xml` parsers, `.rels` parsers | 2 each | 1 each |
| `resolve_target`, `part_dir`, rels part name, legacy sniff | 2 each | 1 each |
| attribute-by-local-name readers | 3 | 1 (+ the raw form) |
| `local_name` | 2 | 1 |
| text escapes / attribute escapes | 3 / 4 | 1 / 1 |
| `rgb_to_hsl`, `hsl_to_rgb` | 2 each | 1 each |
| zip writer loops | 4 (doc+slide's `OpcPackage::write`, sheet's save, new workbook, CSV import) | 1 |
| peak-allocation counters in tests | 1 (sheet) | 1, shared by 3 test binaries |

Measured (wasm-release / release, `wasm-opt -Oz`, as CI builds them):

| Artifact | Before | After | Change |
| --- | ---: | ---: | ---: |
| `docx_js_bg.wasm` | 6,660,701 | 6,655,977 | −4,724 |
| `slide_js_bg.wasm` | 1,559,562 | 1,553,462 | −6,100 |
| `sheet_js_bg.wasm` | 1,695,106 | 1,673,464 | −21,642 |
| together | 9,915,369 | 9,882,903 | −32,466 |

sheet first grew (+14 KB) from the move alone: a helper returning `XmlError` added a
conversion at each of about 200 call sites, and a non-generic shared function instantiates its
own copies of the std generics it uses. The `*_as` forms removed the conversions, and the
shared zip writer collapsed sheet's three zip-writer instantiations into one, which is the
−21.6 KB.

Tests (nextest, before → after): doc 176 → 173 (+2 zip-budget, −5 moved to the shared crate),
slide 67 → 64 (+2, −5), sheet 1,501 → 1,495 (−6 moved: rels 3, splice 2, content types 1),
`paged-ooxml` 5 → 26. Corpus lanes unchanged (doc 5, slide 5, sheet 5, all pass). Bun suites
unchanged: doc 44 + 54, slide 69, sheet 193 + 404 (1 skip). A byte-identity harness over the
private corpus and the modules' fixtures (280 `.docx`, 817 `.xlsx`, 17 `.pptx`) hashed every
output before and after: doc's verbatim save, lowering and package rewrite; slide's IR, IDML,
report and package rewrite; sheet's session save, chart list and chart geometry, and
`XlsxDocument` save, error messages included. All identical.

## C3 — one DrawingML chart reader (Rust)

`platform/shared/dml-chart` (`dml-chart`) reads a chart part, `c:chartSpace`, once for both
modules that carry one; the record is slide ADR 709.

- **One reader, one model.** `dml_chart::chart(root, props)` reads the plots in file order
  (with each plot's element name, so a 3-D variant stays visible), the series with their cached
  names, categories and values and the `c:f` formulas they are bound to, the axes, the title
  and the legend. It is slide's reader (`pptx-import/src/chart.rs`), made generic over the
  paint and text types and taught the formulas.
- **The paints are the module's.** The reader hands every `c:spPr` and `a:rPr` / `a:defRPr` to
  the module's `Props`, in file order, so slide's diagnostics come out in the order they always
  did. slide reads them into `ShapeProps` / `RunProps` (`pptx-core::chart` is now type aliases
  of the shared model); sheet reads them into `()`.
- **The layout profiles stay in the modules.** `slide-chart` and `sheet-chart` are untouched.
- **sheet's streaming scanner is gone.** `sheet-xlsx/src/parts/chart.rs` folds the shared
  model into the frozen `ChartModel` with the rules the scanner had: the last plot of a
  curated kind decides, a bar plot's own direction and grouping pick the variant, every
  plot's series bind to their `c:f` ranges, a series' colour is its first `a:srgbClr`, and the
  title is the first non-empty text run of the first title that has one (the last two read
  the element tree, as the Excel profile's rules).
- **The element tree is shared.** slide's `pptx-import/src/xml.rs` moved to `paged_ooxml::tree`
  (slide ADR 702 amended). Two changes let it read what sheet's scanner read: the chart
  namespace also matches the strict one, and element text has its line ends normalised as XML
  1.0 requires (found by the harness: one corpus chart title written with CR LF).

Duplicates before → after: DrawingML chart readers 2 → 1; chart models 2 → 1 shared plus
sheet's frozen layout model (`ChartModel`, the Excel profile's input, unchanged).

Measured (release / wasm-release, `wasm-opt -Oz`, both builds in the same checkout, since a
crate outside a module's workspace is named by its absolute path):

| Artifact | Before C3 | After C3 | Change | C1 + C3 |
| --- | ---: | ---: | ---: | ---: |
| `slide_js_bg.wasm` | 1,802,264 | 1,796,284 | −5,980 | −12,080 |
| `sheet_js_bg.wasm` | 1,671,133 | 1,689,487 | +18,354 | −3,288 |
| `docx_js_bg.wasm` | 6,828,946 | 6,828,821 | 0 (path length only) | −4,724 |

sheet pays for reading charts with the element tree and the full reader (the namespace
resolver, the tree, the reader's plot and series code: +18.4 KB, after a table-driven namespace
lookup took 5.3 KB back and sheet's `Props` dropped the caches, axes and labels it never reads,
another 3.9 KB). Its streaming scanner was smaller because it read almost nothing. C1's
−21.6 KB covers it: across the two items no module grows. slide is smaller: its reader moved,
and the namespace table replaced a string `match`.

Tests (nextest, before → after C3): slide 67 → 65 (the element tree's 2 tests moved to
`paged-ooxml`), sheet 1,496 → 1,497 (+1: the Excel-profile title and colour rules),
`paged-ooxml` 26 → 29, `dml-chart` 0 → 4; bun suites unchanged (slide 69, sheet 193 + 404, 1
skip); corpus lanes unchanged (slide 5, sheet 5). The harness compared, over 817 `.xlsx` and
17 `.pptx`: sheet's chart lists, chart geometry and saves; slide's IR as JSON (without the two
new fields), the resolved deck with its chart layout, and the report. All identical, after one
fix the harness found (the line-end normalisation above).

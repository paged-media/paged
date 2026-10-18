# Testing: optional resources and honest skips

Some tests need something the public repository does not carry: a GPU adapter,
the private corpus, a CMYK profile, a licensed font, a generated fixture, an
external program or a running server. This page is the one convention for them.

Rust's test harness has no runtime skip. A test that cannot find its resource
returns early and reports **passed**, and nextest hides the output of passing
tests. Before this convention, 313 Rust tests passed that way without testing
anything (232 of them GPU tests on runners without an adapter); see
[`docs/migration/test-inventory.md`](../migration/test-inventory.md), section T3.

## The rules

1. **A skip says so.** Every skip prints `unavailable: <resource>: <reason>`
   and appends a line to `$PAGED_SKIP_LOG`. CI turns those lines into skipped
   JUnit rows and a job summary: skipped is not passed.
2. **A lane that claims a resource requires it.** `PAGED_REQUIRE_<X>=1` turns
   the skip into a failure. Every CI lane that has the resource sets it.
3. **A test that can never run without the resource is an opt-in lane**, not
   an early return: `#[ignore = "corpus: <lane>"]` plus a nextest profile.
4. **A lane that executed nothing fails.** nextest runs with
   `--no-tests=fail`, and `tooling/rust/skip-report.py` fails a lane whose
   executed count (run, minus reported unavailable) is zero.

## The helper (Rust)

`platform/shared/test-resources` (crate `paged-test-resources`, standard
library only) is a path **dev-dependency** of every Cargo workspace with such
tests (docs/adr/PM-0005), declared once in the workspace's
`[workspace.dependencies]`:

```toml
# <workspace>/Cargo.toml
[workspace.dependencies]
paged-test-resources = { path = "../../platform/shared/test-resources" }

# <crate>/Cargo.toml
[dev-dependencies]
paged-test-resources.workspace = true
```

The message and the REQUIRE check are one function, so they cannot drift apart:

```rust
use paged_test_resources::{skip, Resource};

#[test]
fn converts_through_the_working_profile() {
    let Some(icc) = paged_color::test_profiles::read_cmyk_profile(env!("CARGO_MANIFEST_DIR")) else {
        skip!(Resource::Icc, "no CMYK profile (PAGED_CMYK_PROFILE, scripts/fetch-profiles.sh)");
    };
    // …
}
```

| Item                             | What it does                                                                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `Resource`                       | `Gpu`, `Corpus`, `Icc`, `Fonts`, `Fixtures`, `Tools`, `Server`; `key()` is the `<X>` of `PAGED_REQUIRE_<X>`.                               |
| `skip!(res, "fmt", args…)`       | `unavailable(…)`, then `return`. `skip!(res => value, …)` returns `value` (for tests that return `Result`).                                |
| `unavailable(res, reason)`       | Prints `unavailable: <resource>: <reason>`, appends it to `$PAGED_SKIP_LOG`; **panics** when `PAGED_REQUIRE_<X>=1`.                        |
| `available(res, option, reason)` | `option`, or `None` after `unavailable`.                                                                                                   |
| `corpus(lane, legacy)`           | `<corpus root>/<lane>` as a directory, or `None` after `unavailable(Corpus, …)`. `legacy` lists the lane's old `PAGED_*_CORPUS` variables. |
| `corpus_root(legacy)`            | The corpus root alone, as a `Result`.                                                                                                      |
| `tool(name)`                     | The program's path on `PATH`, or `None` after `unavailable(Tools, …)`.                                                                     |
| `env_var(res, var)`              | A configuring variable's value (for example `PAGED_SERVER_URL`), or `None` after `unavailable(res, …)`.                                    |
| `required(res)`                  | Whether `PAGED_REQUIRE_<X>=1` is set.                                                                                                      |
| `gpu_forced_off()`               | Whether `PAGED_FORCE_NO_GPU=1` asks GPU tests to behave as if there were no adapter.                                                       |
| `repo_root()`                    | The repository root.                                                                                                                       |

GPU tests in each workspace go through one device helper that calls the crate:
`image_gpu::test_support::device_or_skip` (modules/image) and the Vello test
helper in `paged-gpu` (engine/core). Both honour `PAGED_FORCE_NO_GPU`.

## Environment variables

| Variable                 | Meaning                                                                                                                                                                                        | Set by                                                                                |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `PAGED_CORPUS_DIR`       | Root of the private corpus. Each lane reads its own subdirectory (`idml`, `psd`, `docx`, `xlsx`, `pptx`, `raster`, …). Unset: `<repo root>/corpus`, the gitignored local link, when it exists. | you                                                                                   |
| `PAGED_REQUIRE_GPU`      | A test without a GPU adapter fails.                                                                                                                                                            | core `vello on lavapipe`; image `rust GPU tests (lavapipe)`, `rust GPU tests (Metal)` |
| `PAGED_REQUIRE_CORPUS`   | A corpus lane without its corpus directory fails.                                                                                                                                              | you, when running a corpus lane                                                       |
| `PAGED_REQUIRE_ICC`      | A colour test without a CMYK profile fails.                                                                                                                                                    | core `check + test`, after `scripts/fetch-profiles.sh` succeeds                       |
| `PAGED_REQUIRE_FIXTURES` | A test without its generated fixture or build output fails.                                                                                                                                    | core `check + test`, after `scripts/regen-fixtures.sh`                                |
| `PAGED_REQUIRE_FONTS`    | A test without its (uncommitted) font fails.                                                                                                                                                   | you                                                                                   |
| `PAGED_REQUIRE_TOOLS`    | A test without its external program fails.                                                                                                                                                     | you                                                                                   |
| `PAGED_REQUIRE_SERVER`   | A server lane without `PAGED_SERVER_URL` fails.                                                                                                                                                | you, when running the server lane                                                     |
| `PAGED_REQUIRE_FOGRA39`  | The core fidelity pixel gate (`engine/core/corpus/generated/diff.sh`) fails instead of exiting 3 (unavailable) when it has no Coated FOGRA39 profile.                                          | a runner that has the profile (none today)                                            |
| `PAGED_SKIP_LOG`         | File every skip is appended to: `binary id`, `test name`, `resource`, `message`, tab-separated.                                                                                                | every Rust test lane                                                                  |
| `PAGED_FORCE_NO_GPU`     | GPU tests behave as if there were no adapter (proves the REQUIRE path on a machine that has one).                                                                                              | you                                                                                   |
| `PAGED_CMYK_PROFILE`     | The CMYK profile the colour tests and the fidelity scripts use (`paged_color::test_profiles`).                                                                                                 | the export-diff lane                                                                  |

`PAGED_REQUIRE_<X>` accepts `1`, `true` or `yes`.

### Old names, still read for one deprecation period

Reading one prints a `warning: … is deprecated` line once per test process.
No CI workflow or script sets them any more.

| Old                                                                                                                                                                                                        | New                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REQUIRE_GPU=1`                                                                                                                                                                                            | `PAGED_REQUIRE_GPU=1`                                                                                                                                                            |
| `PAGED_IDML_CORPUS`, `PAGED_GRID_CORPUS`, `PAGED_PSD_CORPUS`, `PAGED_JPEG_CORPUS`, `PAGED_PNG_CORPUS`, `PAGED_RASTER_CORPUS`, `PAGED_DOCX_CORPUS`, `PAGED_DOC_CORPUS`, `PAGED_XLSX_CORPUS`, `PAGED_CORPUS` | `PAGED_CORPUS_DIR=<corpus root>`. As `=1` they were a switch: the lane now runs when its ignored tests are asked for. As a path they named the corpus root, which they still do. |
| `PAGED_REPO_CORPUS=<dir>`                                                                                                                                                                                  | `PAGED_CORPUS_DIR` (the lane reads `<corpus>/idml/samples`); the old variable still overrides the directory.                                                                     |

`PAGED_ABR_CORPUS=1` and `PAGED_ABR_CORPUS_DIR` stay: the ABR lane reads a
separate clean-room mount, not the private corpus.

`PAGED_CORPUS_DIR` used to be the input directory of
`engine/core/tools/indesign-export/run-export.sh`; that is `PAGED_EXPORT_DIR`
now.

## Opt-in lanes

A test that can never run without its resource is `#[ignore = "<kind>: <lane>"]`
and belongs to a nextest profile in its workspace's `.config/nextest.toml`
whose `default-filter` lists exactly those tests. A plain run reports them as
skipped (ignored); the lane runs them:

```sh
cd engine/core   # or modules/image, modules/doc, modules/sheet, modules/slide
PAGED_CORPUS_DIR=~/path/to/corpus PAGED_REQUIRE_CORPUS=1 \
  cargo nextest run --profile corpus --run-ignored only
```

Without `--run-ignored only` the profile selects nothing and nextest fails
("no tests to run"). Without the corpus, each test prints
`unavailable: private corpus: …` and returns; with `PAGED_REQUIRE_CORPUS=1`
it fails.

| Workspace          | Profile  | Tests | Ignore reason                                                                                                                  | Needs                                                                                               |
| ------------------ | -------- | ----- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| engine/core        | `corpus` | 13    | `corpus: idml`, `corpus: idml/samples`                                                                                         | `<corpus>/idml` (idml-export round-trips, the grid matrix, ruler guides, the repository round-trip) |
| engine/core        | `lanes`  | 3     | `lane: annual (PAGED_DIGEST_GATE_ANNUAL)`, `lane: annual (PAGED_LATE_FONTS_ANNUAL)`, `lane: package diff (PAGED_DIFF_PACKAGE)` | the file the variable names                                                                         |
| modules/image      | `corpus` | 13    | `corpus: psd`, `corpus: jpeg (…)`, `corpus: png (…)`, `corpus: raster`                                                         | `<corpus>/psd`, the packs and `raster/`                                                             |
| modules/image      | `abr`    | 4     | `clean-room: abr (…)`                                                                                                          | the clean-room ABR mount (`PAGED_ABR_CORPUS=1`, `PAGED_ABR_CORPUS_DIR`)                             |
| modules/doc        | `corpus` | 5     | `corpus: docx`                                                                                                                 | `<corpus>/docx`                                                                                     |
| modules/sheet      | `corpus` | 5     | `corpus: xlsx`                                                                                                                 | `<corpus>/xlsx`                                                                                     |
| modules/slide      | `corpus` | 5     | `corpus: pptx`                                                                                                                 | `<corpus>/pptx`                                                                                     |
| apps/server/server | `server` | 14    | `server: a running paged.server (PAGED_SERVER_URL)`                                                                            | a running server (README.md); `PAGED_REQUIRE_SERVER=1`                                              |

A new lane test joins its profile's filter in the same change.

## Proving the REQUIRE paths locally

```sh
# GPU: this Mac has an adapter, so hide it. Passes, every device test unavailable:
PAGED_FORCE_NO_GPU=1 cargo nextest run --workspace          # modules/image
# … and fails, one failure per device test:
PAGED_FORCE_NO_GPU=1 PAGED_REQUIRE_GPU=1 cargo nextest run --workspace

# Corpus removed: fails, one failure per lane test.
mkdir -p /tmp/empty-corpus
PAGED_CORPUS_DIR=/tmp/empty-corpus PAGED_REQUIRE_CORPUS=1 \
  cargo nextest run --profile corpus --run-ignored only
```

Add `PAGED_SKIP_LOG=/tmp/skips.tsv` to see what reported unavailable, and
`python3 tooling/rust/skip-report.py --lane local --junit target/nextest/ci/junit.xml
--log /tmp/skips.tsv` after a `--profile ci` run for the lane report CI writes.

## CI

| Lane                                                  | Claims                                 | What it sets                                                                                                                                                                                     |
| ----------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| core `check + test` (Linux nextest, macOS cargo test) | a CMYK profile, the generated fixtures | `PAGED_REQUIRE_ICC=1` when the profile fetch worked, `PAGED_REQUIRE_FIXTURES=1` after the regeneration; `PAGED_SKIP_LOG`; lane report                                                            |
| core `vello on lavapipe`                              | a GPU adapter (Mesa lavapipe)          | `PAGED_REQUIRE_GPU=1` (and the vulkaninfo check); lane report                                                                                                                                    |
| core `corpus diff` (fidelity)                         | Coated FOGRA39 for the pixel gate      | nothing: no runner has the profile, so the gate reports `unavailable: FOGRA39 profile` in its step name, log, annotation and job summary; the golden snapshot and the text-layer gate still gate |
| image `rust engine`                                   | **no GPU**                             | named "test (CPU only; device tests are unavailable here)"; the lane report lists the device tests as unavailable                                                                                |
| image `nextest evidence` (publish-state)              | **no GPU**                             | the lane report marks the device tests `<skipped>` in the JUnit before the upload                                                                                                                |
| image `rust GPU tests (lavapipe)`, `(Metal)`          | a GPU adapter                          | `PAGED_REQUIRE_GPU=1`; lane report                                                                                                                                                               |
| slide, doc, sheet nextest                             | nothing optional                       | `PAGED_SKIP_LOG`, `--no-tests=fail`, lane report                                                                                                                                                 |
| data, publish, web nextest                            | nothing optional                       | `--no-tests=fail`                                                                                                                                                                                |

**The lane report** is `tooling/rust/skip-report.py`. Given nextest's JUnit
(`--junit`) it adds a `<skipped message="unavailable: …">` to every logged test
that did not fail, so the evidence read from the JUnit counts it as skipped;
given `cargo test` output (`--cargo-log`) it counts what ran. Either way it
writes the job summary and fails the lane when fewer than `--min-executed`
(default 1) tests executed.

## Not yet converted

- **TypeScript tests** keep their own switches (`REQUIRE_REAL_ENGINE`,
  `REQUIRE_REAL_DUCKDB`, `REQUIRE_REAL_WASM`, …) until the bun test migration
  (B7) lands. Nine TS tests still pass without running when a resource is
  missing (the T0 scan): `apps/editor/apps/canvas/tests/default-italic-face.spec.ts`
  (1, a font), `modules/image/glue/test/retouch-tools.spec.ts` (4, the real
  wasm), `modules/image/glue/test/type.spec.ts` (2, a font) and
  `platform/extensions/packages/plugin-sdk/test/react-free-import.spec.ts`
  (2, build output).
- **Corpus lanes in CI:** the corpus is private, so no CI lane runs them.
  Run them locally (above).

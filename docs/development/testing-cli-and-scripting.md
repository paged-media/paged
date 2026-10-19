# Testing the command lines and the scripting layer

Two layers of the surface-conformance programme
([overview](../../apps/editor/docs/reference/surface-conformance.md)):

- **Layer 4, CLI goldens.** Every command and subcommand of the command lines, run as a
  child process and compared with a committed transcript: `--help`, a usage error, an input
  error and the command's output on a fixture.
- **Layer 4b, scripting.** Every host function of the Boa `paged.*` bridge (the catalog's
  `hostFunctions`), table-driven against an engine model; then the editor's automation layer
  (`paged.run`, `editor.*`, `demo.*`) in the headless editor.

The gate (`apps/editor/scripts/surface-coverage.mjs`) counts a `cli:` id only in a GOLDEN
file (a path segment containing `golden`) and a `script:` id only in a SCRIPT file (a path
segment with the word `script`, `scripts` or `scripting`), each under a `covers(…)` /
`covers!(…)` call. The ids: `cli:paged <command path>` from `engine/core/crates/paged-cli/cli.json`
(groups and the root `cli:paged` included), `cli:paged-run`, `cli:paged-node <verb>` and
`cli:paged-plugin <subcommand>`; `script:<name>` for the catalog's host functions, plus the
automation's 19 functions.

| Surface                                  | Tests                                                                                                 | Run                                                    |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `paged` (Rust), `paged-run`, `paged mcp` | `engine/core/crates/paged-cli/tests/it/golden*.rs`, goldens in `tests/golden/`                        | `cargo nextest run -p paged-cli` (in `engine/core`)    |
| `paged-node`                             | `apps/cli/test/cli-golden.spec.ts`, goldens in `test/golden/`                                         | `bun test test/cli-golden.spec.ts` (in the package)    |
| `paged-plugin`                           | `platform/extensions/packages/plugin-sdk/test/paged-plugin-golden.spec.ts`, goldens in `test/golden/` | `bun run test` (in the package)                        |
| Boa `paged.*` / `console.*`              | `engine/core/crates/paged-script/tests/it/host_functions/`                                            | `cargo nextest run -p paged-script`                    |
| `paged.run`, `editor.*`, `demo.*`        | `apps/editor/apps/canvas/tests/headless/script-automation.test.ts`                                    | `bun run test:headless` (in `apps/editor/apps/canvas`) |

## Golden files

All three golden suites share the rules; only the file layout differs.

- **One transcript per case**: the command line, the exit code, stdout and stderr (and, for
  an export, a structure section). Commands run in a fresh directory with their documents
  given as relative names, so a transcript carries no machine path.
- **Normalised** before the comparison, and only for what is not the command's behaviour:
  the fixture directory (`<TMP>`) and the checkout (`<ENGINE>`, `<CLI>`); versions and the
  wire protocol (`<VERSION>`, `<PROTOCOL>`); byte counts of written files (a compressed
  container's size follows the deflate backend, a dependency); the OS errno, a panicking
  thread's id and a panic's source line; digests (`<DIGEST>`, `<HASH>`: the verification
  oracle's job); timestamps. JSON output is re-serialised with sorted keys and fractions
  rounded to three decimals, so a last-ulp difference between two platforms' maths libraries
  does not fail. Every word of `--help` and of every error message is compared exactly.
- **`PAGED_UPDATE_GOLDEN=1`** writes the files instead of comparing them. Review the diff
  like any other change; a golden that changed without a reason is the regression the file
  exists to catch.
- **Structure, not bytes, for exports**: a PNG's size from its header, a PDF's header, page
  objects and `%%EOF`, a ZIP container's entry names. Fidelity is the fidelity lane's job.
- **Content that belongs to another source is asserted in code and masked in the golden**:
  `paged ops` lists the catalog's operations, `paged describe` prints `catalog.json`,
  `paged gen emit` names `paged_gen::samples::SAMPLES`, and clap lists the invokable ops in an
  error. The test asserts each equal to its source; the golden keeps the shape, so a new op
  or sample does not churn a CLI golden.
- **Fixtures are built in code**: a blank document from `paged new`, the seeded document
  (`golden::SEED`, authored through `paged script`), `paged gen emit` for a generator
  sample, the SDK's minimal IDML for the TypeScript CLIs. Nothing reads the private corpus.

## The Rust `paged` command line

`tests/it/golden.rs` is the harness (`Fx`, a working directory per test; `Run`, one finished
command; the normalisers) and the gate. `golden_document.rs` holds the document commands,
`golden_read.rs` the `paged read` questions, `golden_hosts.rs` `parts`, `library`,
`session`, `mcp` and `engine-serve`. A golden lives at
`tests/golden/<command path with dots>/<case>.txt` (`paged read layers` →
`tests/golden/paged.read.layers/seeded.txt`).

`every_command_path_has_its_goldens` walks the clap tree (`paged_cli::cli::surface()`, the
source of `cli.json`) and fails for a command path that has

- no test calling `covers!("cli:<path>")`;
- no `help.txt`;
- no case with exit 2 (clap's usage error; for a group, the missing subcommand);
- for a command that runs: no case with exit 0, or no case with exit 1 (the CLI's own input
  error), unless `NO_INPUT_ERROR` / `NO_EXIT_ZERO` says why in a sentence (`ops` and
  `describe` read no input, `session` and `mcp` answer a bad request on the protocol,
  `engine-serve` serves until it is killed and its success golden is the HTTP exchange);

and for a golden directory no command produces, or a golden file no case names. So a new
subcommand fails until its tests exist, and a removed one fails until its goldens go.

`paged-run` must answer what `paged session` answers: `golden_hosts::paged_run` sends the
session golden's requests to both and compares each with the one golden. `paged-run` is
another package's binary, read beside `paged` in the target directory; when it is absent
or older than the engine sources (a `cargo test -p paged-cli` alone does not rebuild it)
the test reports `unavailable: generated fixtures` and returns. The workspace run, which CI
makes, builds both. `paged mcp` has a JSON-RPC transcript over stdio, the `tools/list`
answer and the whole MCP tool catalog (`paged_mcp::tools::catalog()`) as goldens.

To add a command: write its test in the file of its family (`covers!("cli:paged <path>")`,
`fx.help(…)`, a usage error, an input error, a success case, each `.golden(command, case)`),
run `PAGED_UPDATE_GOLDEN=1 cargo nextest run -p paged-cli -E 'test(/golden/)'`, read the new
files, regenerate `cli.json` (`cargo run -p paged-cli --example emit-cli-surface >
crates/paged-cli/cli.json`), commit both.

## The TypeScript command lines

The TypeScript CLIs have golden tests in `apps/cli/test/cli-golden.spec.ts`
(`paged-node`) and `platform/extensions/packages/plugin-sdk/test/paged-plugin-golden.spec.ts`
(`paged-plugin`), built on the shared kit `plugin-sdk/test/golden-kit.ts`. Each case runs one
command line and records a transcript in `test/golden/<binary>/<command>.<case>.txt`: the
command line, the exit code, stdout, stderr, and for exports a `# structure` section (ZIP
entry names, the PDF header and page count; never bytes). Transcripts are normalised before
comparison: temporary directories become `<TMP>`, the package directory `<CLI>`, the CLI and
engine versions `<CLI_VERSION>` / `<ENGINE_VERSION>`, the protocol `<PROTOCOL>`, file sizes
`<N>` and timestamps `<TIME>`. `PAGED_UPDATE_GOLDEN=1` rewrites the files and removes those
no case writes. A case's class is the prefix of its name (`help`, `usage`, `input`, `ok`,
`refused`), and the class fixes its exit code: for `paged-node` 0 / 2 / 2 / 0 / 1 (ADR 324
§3), for `paged-plugin` usage 2, input 1, ok 0, refused 1. The case table is checked against
the CLI's own definition before anything runs: `VERBS` for `paged-node`, the bin's dispatch
and usage text for `paged-plugin`. So a verb or subcommand without a help (`paged-node`
only), usage, input and ok case fails, and so does a golden file no case writes. To add a
verb, add its row to `CASES`, add a test that calls `covers("cli:paged-node <verb>")` and
`runVerb("<verb>")`, run once with `PAGED_UPDATE_GOLDEN=1`, and review the new files.
Outside resources are avoided or skipped honestly: `ai` runs against a local fake Messages
endpoint, and its no-credential case runs as a child process with an empty home;
`modules-upload` sees an unroutable module host and a fake `npx` on `PATH`; the `apply` and
`merge` successes need the paged.data engine wasm (`modules/data`: `scripts/build-wasm.sh`
and `scripts/vendor-duckdb.sh`), print `unavailable: <resource>: <reason>` without it, and
fail under `PAGED_REQUIRE_DATA_ENGINE=1`.

## The Boa `paged.*` bridge

`engine/core/crates/paged-script/tests/it/host_functions/` holds one `#[test]` per catalog
host function (`crates/paged-introspect/catalog.json` → `hostFunctions`, 181 with
`console.*`), one file per family (`console`, `document`, `frames`, `history`, `layers`,
`pages`, `paths`, `reads`, `selection`, `styles`, `swatches`, `tables`, `text`), each calling
`covers!("script:<name>")`. A row runs `paged_script::execute_script` against a
`CanvasModel` built in code (a blank document, or a `paged-gen` sample built once per process
and loaded fresh per test) and asserts, through the helpers in `mod.rs`:

- the argument validation: a missing and a wrong-typed argument, by the error text
  (`throws`), or the `false` / `null` the bridge answers with the document untouched
  (`refuses`);
- the result shape (`has_keys`, `mints`: a minted id's form);
- the effect on the document: the serialised scene plus `documentMeta` and the ink list,
  read before and after (`snapshot`; `changed_paths` names what differs);
- for a write, that `paged.undo()` restores the before-state and `paged.redo()` the
  after-state (`writes`, `mints`). Settings the engine keeps out of the undo log (colour
  management, proofing, document defaults, inks) assert that instead (`sets`).

`every_host_function_has_a_row` (in `mod.rs`) reads the catalog and the row files and fails
for a host function without a row, and for a row naming a function the catalog does not
list. To add a host function: add its row to the family's file with
`covers!("script:paged.<name>")`, through the helpers. `paged.frame`, the proxy the bridge's
bootstrap installs over `paged.set` / `paged.get`, is script rather than a native function and
not in the catalog; its row is `tests/it/script_frame_proxy.rs`.

## The editor's automation layer

`apps/editor/apps/canvas/tests/headless/script-automation.test.ts` drives the automation
the demo scripts, the docs playground and the films use
(`packages/shell/src/demo/automation.ts`) in the headless editor
(`tests/headless/harness.ts`): the real client, engine, command registry and object
registry behind the `__canvas` handle. One test per function asserts what it does (read
back through the engine: `editor.get`, the model dump, the engine's own selection), what it
answers, how it refuses bad input, and for a function that writes the document that one
undo restores the model byte for byte (`dumpDiff`). `demo.*` is tested both silent (the
harness builds the automation with `isSilent`, as replay and seeking do) and live (a
`buildAutomation(ed.canvas)` of the test's own, where `showInfo` and `pause` suspend until the
box goes). The first test holds the file's roster (`AUTOMATION_FUNCTIONS`) equal to the
functions `buildAutomation` installs, so a new automation function fails until it has a
test.

## Findings

A test that exposes a bug is committed as an expected failure and names its finding: in
Rust it asserts the current wrong behaviour under a `// finding <ID>` comment, in bun test it
is `test.failing(…)` asserting the right behaviour. Each fails for the finding's reason. When
the bug is fixed, the Rust assertion fails (flip it to the right behaviour) and the
`test.failing` passes (bun reports that, so make it a plain `test`).

| Id     | Surface                                                                                            | What happens                                                                                                                                                          | What should                                                         | Test                                                            |
| ------ | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------- |
| CLI-1  | `cli:paged render`                                                                                 | `--all` on a one-page document refuses an existing directory ("Is a directory") and writes a PNG FILE named after a path that does not exist                          | write `<dir>/page-001.png`, as it does for two pages                | `golden_document.rs::render_all_on_a_one_page_document`         |
| CLI-2  | `cli:paged read placed-asset`                                                                      | given the `kind:id` address (`rectangle:u5`) of a frame holding an image, answers `found: false` and exits 0; only the bare `u5` works                                | accept the address every other element argument takes, or refuse it | `golden_read.rs::placed_asset`                                  |
| CLI-3  | `cli:paged describe` (every command)                                                               | output into a pipe that closes early (`paged describe \| head`) panics, "failed printing to stdout: Broken pipe", exit 101                                            | end quietly                                                         | `golden_document.rs::a_closed_pipe_panics`                      |
| CLI-4  | `cli:paged read snap-point`                                                                        | with no `X Y`, panics (index out of bounds in `read.rs`), exit 101                                                                                                    | a usage error naming the missing point                              | `golden_read.rs::snap_point_without_a_point_panics`             |
| CLI-5  | `cli:paged place`, `cli:paged set`                                                                 | a write to an object that does not exist says "not implemented" (`Mutation::ReplaceImageBytes`; "frame mutation failed: node not found")                              | say the target does not exist, as `paged get` does (`notFound`)     | `golden_document.rs::writes_to_a_missing_object`                |
| CLI-6  | `cli:paged digest`                                                                                 | `stateHash` ("a second and independent equality signal") hashes only story text, text-frame and rectangle geometry and anchors: an oval's fill change leaves it equal | change with any change to the document                              | `golden_document.rs::digest_state_hash_misses_a_fill_change`    |
| CLI-7  | `cli:paged read snap-point`                                                                        | a flag written after the point is read as a third coordinate (`… usp 13 13 --grid`: "2 values required … but 3 were provided")                                        | take flags anywhere, as every other command does                    | `golden_read.rs::snap_point_swallows_a_trailing_flag`           |
| CLI-8  | `cli:paged package`                                                                                | a package that fails (a missing document) leaves its half-made folder (`Links/`) behind, so the retry is refused ("is not empty")                                     | leave no folder, or one the retry may use                           | `golden_document.rs::a_failed_package_leaves_its_folder_behind` |
| CLI-9  | `cli:paged engine-serve`                                                                           | a `POST /run` body that is not JSON gets no HTTP response: the connection closes without a status line                                                                | `400` with an error body                                            | `golden_hosts.rs::engine_serve`                                 |
| NCLI-1 | `cli:paged-node export`                                                                            | `export --help` says "(repeatable)" twice on the `--option` line                                                                                                      | once                                                                | `packages/cli/test/cli-golden.spec.ts`                          |
| NCLI-2 | `cli:paged-node schema`                                                                            | `schema --format text` prints the swatch `color` row as `record {  } (JSON)`                                                                                          | `SwatchColorSpec (JSON, checked by core)`, as `commands` prints it  | `packages/cli/test/cli-golden.spec.ts`                          |
| SCR-1  | `script:paged.insertText`, `layerInsert`, `layerSetName`, `renameBookmark`, the `rename*Style` fns | a missing text or name is stored as the word "undefined"                                                                                                              | refuse the call                                                     | `host_functions/{text,layers,document,styles}.rs`               |
| SCR-2  | `script:paged.pathfinder*` (the region verbs, `pathfinderFaces`)                                   | an id list keeps only the entries that parse, so a typo runs the verb on the rest                                                                                     | refuse the call, as `duplicateElements` does                        | `host_functions/paths.rs`                                       |
| SCR-3  | `script:paged.create*Style`                                                                        | a spec that is not an object (`createParagraphStyle('Body')`) is read as `{}` and mints an unnamed style                                                              | refuse it (`null`)                                                  | `host_functions/styles.rs`                                      |
| SCR-4  | `script:paged.placeImage`                                                                          | the address `insertFrame` answered is refused (handed to the engine unresolved)                                                                                       | place the image, as every other frame fn takes the address          | `host_functions/frames.rs::place_image`                         |
| SCR-5  | `script:paged.placeImage`                                                                          | undo leaves an empty fitting option (every field null) on a frame that had none                                                                                       | restore no fitting                                                  | `host_functions/frames.rs::place_image`                         |
| SCR-6  | `script:paged.linkFrames`                                                                          | the second frame's own empty story stays in the document, held by no frame                                                                                            | remove it                                                           | `host_functions/frames.rs::link_frames`                         |
| SCR-7  | `script:paged.deleteTableRow`, `script:paged.deleteTableColumn`                                    | undo brings every cell back in a different order                                                                                                                      | restore the table exactly                                           | `host_functions/tables.rs::delete_then_undo`                    |
| SCR-8  | `script:paged.setCellSpan`                                                                         | a span past the table's edge (9 columns of 3) is stored                                                                                                               | refuse it                                                           | `host_functions/tables.rs::set_cell_span`                       |
| SCR-9  | `script:paged.applyStyle`                                                                          | a style the document does not have is applied as a dangling reference                                                                                                 | refuse it                                                           | `host_functions/text.rs::apply_style`                           |
| SCR-10 | `script:paged.applyStyle`, `script:paged.insertHyperlink`                                          | undo leaves the text split into the runs the edit made                                                                                                                | restore the one run                                                 | `host_functions/text.rs`                                        |
| SCR-11 | `script:paged.collection`                                                                          | the generic read widens the engine's f32 numbers (`0.1` → `0.10000000149011612`) where `paged.links()` prints them as written                                         | print the same value as the typed read                              | `host_functions/reads.rs::links`                                |
| SCR-12 | `script:paged.frame`                                                                               | the proxy's set trap drops `paged.set`'s answer: a write to a path the frame lacks, or to a frame that does not exist, runs on as if it landed                        | throw, as a refused write does                                      | `tests/it/script_frame_proxy.rs`                                |
| SCR-13 | `script:paged.insertText`                                                                          | a `\r` in the text is stored as a literal character; only `\n` starts a paragraph                                                                                     | start a paragraph, as InDesign scripting's return does              | `tests/headless/script-findings.test.ts`                        |
| SCR-14 | `script:paged.placeImage`, `script:paged.links`                                                    | an image placed from a file that does not exist reports its link `ok`                                                                                                 | report it `missing`, as an imported missing link is                 | `tests/headless/script-findings.test.ts`                        |
| AUTO-1 | `script:editor.setProperty`                                                                        | discards the engine's reply: a write the engine refuses resolves as if it landed                                                                                      | reject with the engine's reason, as `editor.set` does               | `tests/headless/script-automation.test.ts`                      |
| AUTO-2 | `script:editor.query`                                                                              | a selector that does not parse resolves to `[]` (the registry logs "is not a selector")                                                                               | reject, as `paged query` on the command line does                   | `tests/headless/script-automation.test.ts`                      |

Every finding of every layer, with severities, shared root causes and fix waves:
[conformance-findings-2026-10.md](conformance-findings-2026-10.md).

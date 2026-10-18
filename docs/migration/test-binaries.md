# One integration-test binary per crate (wave T, T4)

`tooling/migration/merge-test-binaries.py` moved each crate's `tests/<name>.rs` to
`tests/it/<name>.rs`, declared as `mod <name>;` in a generated `tests/it/main.rs`. Cargo
builds that as one test target, `it`. Every crate saves one link and, on macOS, one first-run
malware scan per former file. nextest still runs every test in its own process. The full
report, with each file kept separate and why, is in [`test-binaries.json`](test-binaries.json).

**Kept as separate binaries:**
- explicit `[[test]]` targets (`harness = false`, `required-features`);
- wasm-bindgen tests;
- the one `#[global_allocator]` test;
- timing and allocation budget tests (`perf`/`budget` in the name);
- crates with fewer than two test files.

**Test ids change:**
- before: `<crate>::<file>` + `<test>`;
- after: `<crate>::it` + `<file>::<test>`.

Commands that named a binary (`cargo test -p <crate> --test <file> …`) now say `--test it` and
filter with `<file>::`.

Paths that named a moved file (`<crate>/tests/<file>.rs`) now name `<crate>/tests/it/<file>.rs`:
registry `tests:` pointers, docs, comments, and the fixtures that record which test or probe
generated them. `tooling/migration/rewrite-test-paths.py` made that change (254 files). Golden
files and this record were left as they were. data's coverage gate maps a `tests/it/<file>.rs`
pointer to the binary `<crate>::it` and to tests named `<file>::…`. sheet's gate checks only
that the file exists.

## Gate

`tooling/migration/test-ids.py`:
- `dump` takes `cargo nextest list --run-ignored all` before and after the merge.
- `compare` maps the old ids to the new ones and requires the same test set, ignored flags
  included.

| Workspace | Tests | Binaries before | Binaries after | Lost | Gained |
|---|---|---|---|---|---|
| engine/core | 3,814 | 420 | 49 | 0 | 0 |
| modules/image | 1,213 | 99 | 17 | 0 | 0 |
| modules/sheet | 1,501 | 82 | 20 | 0 | 0 |
| modules/data | 317 | 47 | 17 | 0 | 0 |
| modules/doc | 181 | 30 | 6 | 0 | 0 |
| modules/slide | 73 | 18 | 13 | 0 | 0 |
| apps/server/server | 14 | 7 | 1 | 0 | 0 |
| modules/publish | 4 | 1 | 1 | 0 | 0 |
| **total** | **7,117** | **704** | **124** | **0** | **0** |

Every touched test compiles with `RUSTFLAGS=-Dwarnings`, and every workspace is `cargo fmt`
clean.

**Cockpit:** `test-ids.py cockpit` rewrote the test map's keys that name merged binaries: 148
entries, plus one duplicated entry whose key matched both unit tests and merged files. Each
entry was then checked under the new ids: it matches exactly the tests it matched before, with
0 entries left unequal. The rewritten map belongs to the Cockpit repository and lands when its
lanes are pointed at this repository.

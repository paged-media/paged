# Rust builds

The repository has eleven Cargo workspaces (`engine/core`, `modules/*`,
`apps/server/server`, …). They share one root `.cargo/config.toml`, which Cargo
reads from the current directory upwards. This page covers what it sets, what to
install, and the macOS settings Cargo can't make for you.

## Check your tools

```sh
tooling/dev/check-tools.sh
```

It prints the install command for anything missing and exits 1 when a required
tool is absent.

| Tool                  | Needed for                                                                  | macOS                                                      | Linux                                  |
| --------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------- |
| rustup                | every build; each workspace's `rust-toolchain.toml` picks the toolchain     | <https://rustup.rs>                                        | <https://rustup.rs>                    |
| proto                 | Node, Bun and moon, pinned in `.prototools`                                 | `curl -fsSL https://moonrepo.dev/install/proto.sh \| bash` | same                                   |
| cargo-nextest         | running tests                                                               | `brew install cargo-nextest`                               | `cargo install --locked cargo-nextest` |
| Command Line Tools    | clang, the link driver                                                      | `xcode-select --install`                                   | your distribution's clang              |
| sccache (recommended) | reusing compiled dependencies across workspaces, worktrees and clean builds | `brew install sccache`                                     | `cargo install --locked sccache`       |

## What the repository configures

| Setting                                        | Effect                                                                                                                                                                                    | Opt out                     |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `[profile.dev]` `debug = 1`                    | Line tables and function names, no variable info: smaller binaries, faster links. Backtraces keep file and line.                                                                          | `CARGO_PROFILE_DEV_DEBUG=2` |
| `[profile.dev.package."*"]` `opt-level = 2`    | Dependencies are optimised once and then reused; tests that spend their time in dependencies (decoding, shaping, rasterising) run faster. The workspace's own crates stay at opt-level 0. | —                           |
| `rustc-wrapper = "tooling/rust/rustc-wrapper"` | Compiles through sccache when it is installed, plain rustc otherwise.                                                                                                                     | `PAGED_SCCACHE=0`           |
| macOS `linker = "tooling/rust/cc-macos"`       | Links with Apple's ld, which links faster here than the toolchain's own lld (`lib/rustlib/<host>/bin/gcc-ld/ld64.lld`; numbers in `docs/migration/ci-speed.md`, lever 5).                 | `PAGED_LINKER=lld` (opt in) |

Linkers and wrappers are set with `linker` and `rustc-wrapper`, never through
`rustflags`: a `RUSTFLAGS` environment variable (CI sets `-Dwarnings`) replaces
config rustflags instead of adding to them, and would drop them silently.

To see which linker produced a binary: `otool -l <binary> | grep -A8 LC_BUILD_VERSION`
shows `tool 4` for LLD and `tool 3` for Apple's ld.

sccache's local cache is 10 GiB by default; with several workspaces and
worktrees it fills quickly. Raise it with `SCCACHE_CACHE_SIZE` (for example
`export SCCACHE_CACHE_SIZE=40G` in your shell profile, then
`sccache --stop-server`). `sccache --show-stats` shows the hit rate.

## Tests

Run tests with nextest: each test runs in its own process, in parallel across
all cores.

```sh
cargo nextest run --workspace
cargo test --doc --workspace   # nextest does not run doctests
```

Most workspaces have a `.config/nextest.toml` with a `ci` profile.

## macOS: XProtect

macOS scans every new executable the first time it runs. A Rust build runs many
of them once: every build script, and every test binary after a rebuild. The
scans go through one system daemon, one at a time. On a dev Mac the first run
of a fresh binary took 0.4–1.3 s instead of about 10 ms.
`tooling/dev/xprotect-probe.sh` measures it on your machine:

```
run 1: 1293.9 ms   ← scanned
run 2: 12.7 ms
run 3: 9.8 ms
```

macOS can exclude a terminal from these scans (Developer Tools in Privacy &
Security). That turns off malware scanning for everything the terminal starts,
so this project does not recommend it. The repository cuts the cost by
producing fewer new executables instead. For example, a crate's integration
tests build into one test binary rather than one per file, which also saves a
link per file. Linux is not affected.

## RAM disk

Cargo writes a lot to `target/`. If your checkout sits on a slow or external
disk, a RAM disk for the build output can help:

```sh
tooling/dev/ramdisk.sh up 48      # mounts /Volumes/PagedTarget (48 GB)
export CARGO_TARGET_DIR=/Volumes/PagedTarget/core
tooling/dev/ramdisk.sh down       # eject; the contents are gone
```

Memory is used as Cargo writes, and is given back on `down`. The contents are
also gone after a reboot, so a shell profile should only point there while it
is mounted:
`[ -d /Volumes/PagedTarget ] && export CARGO_TARGET_DIR=/Volumes/PagedTarget/shared`.
One shared target directory works for all workspaces, but Cargo locks it per
build, so parallel builds wait for each other. Use one directory per workspace
or worktree if you build in parallel.

## Fast local wasm builds

`moon run core:wasm-pkg` builds the engine's wasm the way a release does: the
`wasm-release` profile (whole-program LTO, one codegen unit), then
`wasm-opt -Oz`, for all four parts (canvas, introspect, repo, session). The
LTO link of each part runs on one core and sccache cannot cache it. For local
work there is a faster, opt-in path:

```sh
moon run core:wasm-dev                    # canvas + repo, wasm-dev profile, no wasm-opt
moon run core:wasm-dev -- session         # other parts by name
PAGED_WASM_PROFILE=dev bash modules/doc/scripts/build-wasm.sh   # a module's wasm, likewise
```

| Setting                        | Where                                                                      | Effect                                                                                                                                      |
| ------------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `[profile.wasm-dev]`           | root `.cargo/config.toml`                                                  | inherits `release`; `opt-level = 2`, `lto = false`, `codegen-units = 16`, incremental. Output in `target/wasm32-unknown-unknown/wasm-dev/`. |
| `PAGED_WASM_PROFILE=dev`       | `engine/core/scripts/build-wasm-packages.sh`, `tooling/rust/build-wasm.sh` | builds with `wasm-dev` and skips `wasm-opt`; the module helper also skips the size gates (100 MB, the manifest's `maxBytes`).               |
| `PAGED_WASM_PARTS=canvas,repo` | `build-wasm-packages.sh`                                                   | the parts to build when none are named on the command line. Parts not built keep the files already there.                                   |

Dev wasm is larger and somewhat slower than a release build, renders the same,
and is never shipped: both scripts refuse `PAGED_WASM_PROFILE=dev` under CI,
and inside any moon task except `core:wasm-dev` (a cached `core:wasm-pkg` or
`<module>:wasm` would otherwise keep a dev build as the release one). That is
why a module's dev build runs its script directly. CI, `core:wasm-pkg`,
`core:wasm` and the release workflows are unchanged.

`core:wasm-dev` builds canvas and repo because that is what the editor loads:
the canvas worker loads `@paged-media/canvas-wasm`, the library worker its
`./repo` entry, and the module bundles' headless tests boot the canvas entry
in Bun. `./introspect` is read only by `apps/devtools`, and the session only by
the viewer (`web/idml-viewer`) and the docs live preview. A fresh worktree
still needs them for `bun check` (devtools imports the introspect types): build
them once (`moon run core:wasm-dev -- introspect session`) or copy a shared
build (below). After a dev build, `moon run core:wasm-pkg --force` goes back to
release wasm.

### One shared build for several worktrees

Worktrees whose engine sources match the same commit would all build the same
wasm. `tooling/dev/shared-wasm.sh` keeps one build per commit in a shared
directory, `PAGED_SHARED_WASM` (default `${XDG_CACHE_HOME:-$HOME/.cache}/paged/wasm`):

```sh
tooling/dev/shared-wasm.sh publish [--dev]   # build all four parts of HEAD, store them under <dir>/<sha>/
tooling/dev/shared-wasm.sh publish --no-build --dev   # store what is already built
tooling/dev/shared-wasm.sh use [<sha>]       # copy a matching build into this worktree
tooling/dev/shared-wasm.sh list
```

`publish` requires the worktree's engine sources to be HEAD's, and writes a
`README.txt` saying how the build was made (release or dev). `use` without a
commit picks the stored build whose engine sources equal the worktree's
(`engine/core` without docs, Markdown, `web/` and `spikes/`, plus
`platform/shared/fmt` and `.cargo/config.toml`, committed or not), and refuses
when none does: then the worktree has engine changes and must build.

## Not used

- `-Z share-generics=y` needs a nightly compiler. On stable it is already on
  for opt-level 0 and 1, so the workspace's own crates share generics anyway.
- A nightly toolchain for local work: CI and the fidelity gates build with the
  stable toolchains pinned in each `rust-toolchain.toml`, and local results
  should match them.

## Measurements

`tooling/dev/rust-build-bench.sh` times one workspace three ways: a clean build
of every test binary, a rebuild after touching one crate, and a nextest run
(whose summary must not change between configurations).

Measured on a 16-core Apple M3 Max (128 GB) with the checkout and `target/` on a USB SSD,
`engine/core`, 3,031 tests:

| Configuration                                  | Clean build | Touch rebuild | Test run |
| ---------------------------------------------- | ----------- | ------------- | -------- |
| Before (Apple ld, Cargo's default dev profile) | 400 s       | 400 s         | 139 s    |
| This config, Apple ld (`PAGED_LINKER=ld`)      | 408 s       | 343 s         | —        |
| This config, toolchain lld                     | n/a¹        | n/a¹          | 88 s     |

¹ Repeated: that run shared the machine with other heavy work.

- **Dependencies at opt-level 2 make the test run 37 % faster**, with the same results (same
  pass, fail and skip sets).
- **Compiling is the smaller part of a build.** Cargo finished compiling core's test binaries
  in 140–170 s. The rest of each build is nextest starting every new test binary once to list
  its tests: the first run of each binary waits for the malware scan (see XProtect above).
  This is why each crate's integration tests build into one binary.
- **Endpoint security software also scans what Cargo writes.** On the measuring machine,
  Microsoft Defender's real-time scanner used about four cores during a build. Exclusions are
  a decision for whoever manages that machine. This repository reduces what there is to scan
  instead: fewer binaries, smaller debug info, and fewer recompiles with sccache.

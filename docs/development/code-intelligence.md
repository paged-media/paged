# Code intelligence for agents: Serena and rust-analyzer

Agents working in this repository get two MCP servers from
[`.mcp.json`](../../.mcp.json):

- **moon** (`moon mcp`): the project and task graph, task details, changed
  files. See [PM-0006](../adr/PM-0006-proto-moon-mcp.md).
- **serena** (Serena 2.0.0): symbol-level navigation and editing for Rust and
  TypeScript/JavaScript, backed by language servers: rust-analyzer for `.rs`,
  typescript-language-server for `.ts`/`.tsx`/`.js`/`.mjs`.

**Status: configured; startup and workspace loading verified, the full
measurement not run yet** (see [Verified so far](#verified-so-far)). Nothing in
the build or CI depends on Serena.

## What is configured

| File                                                   | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`.serena/project.yml`](../../.serena/project.yml)     | Serena's project file: name `paged`, language servers `rust` and `typescript`, LSP backend, the `tools` agent interface, `encoding: utf-8`, ignored paths, no memories and no onboarding (`added_modes: ["no-memories"]`), no activation command, and the rust-analyzer options below. Keys as in Serena's `project.template.yml` for 2.0.0.                                                                                                                                                                                    |
| [`.mcp.json`](../../.mcp.json)                         | `serena start-mcp-server --context claude-code --project-from-cwd`. `--project-from-cwd` activates the nearest ancestor with `.serena/project.yml` (or `.git`), so every worktree is its own Serena project with its own language servers.                                                                                                                                                                                                                                                                                      |
| [`.claude/settings.json`](../../.claude/settings.json) | Serena's read tools (`initial_instructions`, `get_symbols_overview`, `find_symbol`, `find_referencing_symbols`, `find_implementations`, `find_declaration`, `get_diagnostics_for_file`) are allowed; its editing tools (`replace_content`, `replace_in_files`, `replace_symbol_body`, `insert_after_symbol`, `insert_before_symbol`, `rename_symbol`, `safe_delete_symbol`) ask first. Those 14 are what Serena 2.0.0 serves with this project file and the `claude-code` context, which removes Serena's file and shell tools. |
| [`.vscode/settings.json`](../../.vscode/settings.json) | The same `rust-analyzer.linkedProjects` and `rust-analyzer.cargo.targetDir` for VS Code.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `.gitignore`                                           | `.serena/*` except `project.yml`: Serena's cache, memories and `project.local.yml` stay local.                                                                                                                                                                                                                                                                                                                                                                                                                                  |

`.serena/project.yml` is the only file Serena reads from the repository.
Personal overrides go in `.serena/project.local.yml` (each top-level key there
replaces the one in `project.yml`); global settings (trusted paths, defaults)
in `~/.serena/serena_config.yml`. Serena writes `.serena/cache/` (document
symbol caches, about 13 MB here), `.serena/memories/` and its own
`.serena/.gitignore` into the worktree; the root `.gitignore` keeps all of them
local.

The project sets `agent_interface: "tools"`. Serena 2.0 defaults to the REPL
interface, which serves a single `serena_repl` tool that runs Python; that tool
can only be allowed or asked as a whole, so the read/edit split in
`.claude/settings.json` needs one tool per operation.

## Install (each developer)

```bash
uv tool install -p 3.13 serena-agent==2.0.0   # the version the project file is written for
rustup component add rust-analyzer            # for the default toolchain, see below
proto install                                 # node 24.22.0 (and npm) for the TypeScript server
```

- **rust-analyzer.** Serena 2.0.0 finds it with `rustup which rust-analyzer`,
  run in the repository root. The root has no `rust-toolchain.toml`, so that is
  the default toolchain's component, not the one the Cargo workspaces pin
  (1.99.1). If rustup is installed but the component is missing,
  Serena runs `rustup component add rust-analyzer` by itself; installing it
  first keeps that step explicit.
- **TypeScript.** Serena installs typescript-language-server and typescript
  into its own resource directory with npm on first use, so `node` and `npm`
  must be on `PATH` (proto provides both).
- **Trust the checkout (required).** Serena applies a project's
  `ls_specific_settings`, which carry the rust-analyzer options below, only to
  _trusted_ projects, and a new Serena 2.0.0 configuration trusts none
  (`trusted_project_path_patterns: []`). Untrusted, rust-analyzer falls back to
  auto-discovery and finds no Cargo workspace at all. The pattern is matched
  against the project root, so give a checkout's path as it is, or the
  directory that holds your worktrees followed by `/**`:

  ```yaml
  # ~/.serena/serena_config.yml
  trusted_project_path_patterns:
    - "/path/to/your/worktrees/**"
  ```

- **Dashboard.** Serena opens its web dashboard in the browser on every start
  by default (`web_dashboard_open_on_launch: true`), so every agent session in
  every worktree opens a tab. Set it to `false` in `~/.serena/serena_config.yml`
  if that is unwanted.
- **First start.** Approve the `moon` and `serena` servers when Claude Code asks
  (or list them in `enabledMcpjsonServers` in your user settings). Serena's
  first start installs the TypeScript server and lets rust-analyzer load ten
  workspaces; if Claude Code gives up waiting, start it with
  `MCP_TIMEOUT=60000` (for example `export MCP_TIMEOUT=60000` in the shell
  profile).

## rust-analyzer and the Cargo workspaces

There is no root `Cargo.toml`. The repository has ten Cargo workspaces with
members, plus two that are deliberately left out (`engine/core/spikes/blitz-wasm`,
excluded from the engine workspace, and `modules/sheet/fuzz`, the cargo-fuzz
workspace). Every other crate is a member of one of the ten; checked with
`cargo metadata --no-deps` against every tracked `Cargo.toml`.

```
engine/core   modules/{publish,image,draw,sheet,data,doc,slide}
modules/web/packages/web-render   apps/server/server
```

rust-analyzer only auto-discovers a `Cargo.toml` in the workspace root and one
level below, so it would find none of them. It has to be told:

- **`linkedProjects`** lists the ten `Cargo.toml` files (relative to the
  repository root, so the same list works in every worktree).
- **`cargo.targetDir: true`** makes rust-analyzer's own `cargo check` and
  build-script runs use `target/rust-analyzer` inside each workspace's target
  directory, so they never wait for, or hold, the lock of a build or test run
  in the same `target/`.

Where those settings can live (from rust-analyzer's `config.rs`):

- `linkedProjects` is a _global_ setting. rust-analyzer reads it from the
  client's settings (VS Code's `settings.json`, or the LSP `initializationOptions`)
  or from the user-level `rust-analyzer.toml` in the OS config directory
  (`~/.config/rust-analyzer/` on Linux, `~/Library/Application Support/rust-analyzer/`
  on macOS). A `rust-analyzer.toml` in a project cannot set it.
- `cargo.targetDir` is a _workspace_ setting. Besides the client's settings it
  can come from a `rust-analyzer.toml` at the root of a loaded Cargo workspace.
- rust-analyzer only reads project `rust-analyzer.toml` files at loaded
  workspace roots and inside crates. A file at this repository's root is
  neither, so **there is no root `rust-analyzer.toml`**: it would be ignored.

**Serena.** Serena 2.0.0 starts rust-analyzer with its own `initializationOptions`,
which set `linkedProjects: []` and `rust.analyzerTargetDir: null`. Serena
documents `ls_specific_settings.<language>.initializationOptions` as a
top-level override of those options, so `.serena/project.yml` replaces both
keys: `linkedProjects` with the ten manifests, and `rust: { analyzerTargetDir: true }`.
`rust.analyzerTargetDir` is rust-analyzer's alias of `cargo.targetDir`; it is
used because replacing Serena's top-level `cargo` key would drop its other
cargo options. Verified: rust-analyzer loads all ten workspaces this way (see
below). Keep `cargo.autoreload` at Serena's default (on): with it off,
rust-analyzer reported "Auto-reloading is disabled and the workspace has
changed, a manual workspace reload is required" right after loading and
answered every reference request with nothing.

With a shared Cargo target directory (a root `.cargo/config.toml` setting
`build.target-dir`), `cargo.targetDir: true` puts all ten workspaces'
rust-analyzer checks in one `<shared>/rust-analyzer` directory. They then
contend with each other, not with the build; measure it if that layout lands.

## Verified so far

2026-10-18, one worktree, Apple M3 Max (16 cores, 128 GB), macOS 26.4;
Serena 2.0.0, rust-analyzer 1.98.0 (stable toolchain), typescript-language-server
5.1.3 with typescript 5.9.3, node 24.22.0. Another long job was loading the
machine, so these runs used a `project.local.yml` that kept the ten
`linkedProjects` and the target dir but turned off rust-analyzer's build
scripts, proc macros and check-on-save: rust-analyzer loaded the workspaces with
`cargo metadata` and never ran `cargo check`. The numbers are therefore a lower
bound for memory and say nothing about the cost of build scripts.

| What                                     | Result                                                                                                                                                                        |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP `initialize` (protocol `2025-06-18`) | 0.7–2.8 s; `tools/list` immediate, 14 tools                                                                                                                                   |
| First start with a fresh Serena home     | 47 s to the first tool answer: Serena installs the TypeScript server with npm, rust-analyzer's first load took 46 s                                                           |
| Later starts                             | rust-analyzer ready (quiescent) after 4.4–7.7 s, TypeScript server after 0.1 s; first answer about 9 s after start                                                            |
| Workspaces loaded                        | all ten (722 source roots); none of ten sampled `lib.rs` files, one per workspace, was outside the crate graph                                                                |
| `find_symbol`                            | `Document` (engine/core, paged-scene), `CellValue` (modules/sheet, sheet-core), `PluginManifest` (platform/extensions, TypeScript): 0.1 s each once ready                     |
| `find_referencing_symbols`               | `CellValue`: 8.6 s, references across the sheet crates (766k characters of output); `Document`: 11.4 s, references across the engine crates (197k characters)                 |
| RSS                                      | rust-analyzer 0.9 GB after loading, 4.9 GB after the two reference searches; Serena 0.1–0.2 GB; tsserver 0.2–0.4 GB; typescript-language-server 0.06 GB; peak 5.4 GB in total |

Diagnostics in this mode were "proc-macro expansion is disabled" hints and
"`OUT_DIR` not set" errors (modules/data): artefacts of the switched-off build
scripts, not counted for M3.

Not measured yet: everything with build scripts and proc macros on (the
committed configuration, which runs rust-analyzer's `cargo check` of all ten
workspaces on start), more than one worktree, M3 and M4.

## Measurement protocol

Run it on an otherwise idle machine (no build, test or benchmark running), in a
fresh worktree, and record the machine (CPU, RAM, OS) and the versions:
`uv tool list` (serena-agent), `rust-analyzer --version`, the typescript-language-server
Serena installed, `node --version`.

**M1. Index time.** From starting the MCP server (`claude` in the worktree) to
rust-analyzer reporting quiescent (Serena's log, `~/.serena/logs/`), and to the
first successful `find_symbol` in each of the ten Cargo workspaces and in one
package of each pnpm workspace. Measure cold (no `target/rust-analyzer`) and
warm (second start), plus the duration of the first flycheck.

**M2. Memory and disk per worktree.** RSS of the Serena process,
rust-analyzer, its proc-macro server, and the TypeScript server, sampled every
5 s (`ps -o rss=,command= -p <pid>`) through indexing and after the tasks:
peak and settled. Repeat with two and three worktrees open at once (each runs
its own servers). Disk: `du -sh` of every `target/rust-analyzer`.

**M3. False "unresolved" diagnostics.** `get_diagnostics_for_file` on a
sample per workspace: each crate's `lib.rs`, files importing crates from
another workspace through Cargo git dependencies (modules/publish and
apps/server/server use engine crates; engine/core uses `idml-import` and
`idml-export`), and `#[cfg(target_arch = "wasm32")]` code in the wasm crates.
Count `unresolved-import` and other unresolved-name errors that `cargo check
-p <crate>` does not report. For TypeScript, record separately the expected
"cannot find module" errors for wasm glue that has not been built
(`../bin/*.js`).

**M4. Five navigation tasks, Serena against grep.** Each task twice, in a
fresh session with the same model and prompt: once with Serena, once with
Serena disabled (grep, glob and file reads only). Prepare the answer key by
hand first. Record tool calls, bytes of tool output read, wall time and
correctness against the key.

1. _Implementations in one workspace._ Every implementation of
   `AssetResolver` (`engine/core/crates/paged-renderer/src/asset.rs`) and
   where each is constructed.
2. _Across Cargo workspaces._ The functions in `modules/publish` that take or
   return `paged_scene::Document` (a git-dependency crate from another
   workspace).
3. _Readers behind cfg._ Every place in `engine/core` that reads
   `PROTOCOL_VERSION`, including the wasm-only crates.
4. _TypeScript across pnpm workspaces._ References to `PluginManifest`
   (`platform/extensions/packages/plugin-api/src/manifest.ts`) in
   `platform/extensions` and in `modules/*/packages`, which import it from the
   published npm package rather than the source.
5. _A rename._ Rename a helper that several files of one `modules/sheet` crate
   use, with `rename_symbol` against manual edits; check with
   `cargo check -p <crate>` and compare the diffs.

**Decision.** Keep Serena as the default for agents if, on at least three of
the five tasks, it is at least as correct as grep and needs at least 30% fewer
tool calls or tool-output bytes; settled RSS stays around 4 GB or less per
worktree with all ten workspaces linked; the cold index takes 10 minutes or
less; and M3 finds no false unresolved imports in workspace crates. If memory
or index time is the problem, try narrower `linkedProjects` per worktree (in
`.serena/project.local.yml`) before dropping it. Record the results here and
in a follow-up to PM-0006.

| Measure                           | 1 worktree | 2 worktrees | 3 worktrees |
| --------------------------------- | ---------- | ----------- | ----------- |
| Cold index (min)                  |            |             |             |
| Settled RSS, all servers (GB)     |            |             |             |
| `target/rust-analyzer` total (GB) |            |             |             |

| Task | Serena: calls / bytes / time / correct | grep: calls / bytes / time / correct |
| ---- | -------------------------------------- | ------------------------------------ |
| 1    |                                        |                                      |
| 2    |                                        |                                      |
| 3    |                                        |                                      |
| 4    |                                        |                                      |
| 5    |                                        |                                      |

# Code intelligence for agents: Serena and rust-analyzer

Agents working in this repository get two MCP servers from
[`.mcp.json`](../../.mcp.json):

- **moon** (`moon mcp`): the project and task graph, task details, changed
  files. See [PM-0006](../adr/PM-0006-proto-moon-mcp.md).
- **serena** (Serena 2.0.0): symbol-level navigation and editing for Rust and
  TypeScript/JavaScript, backed by language servers: rust-analyzer for `.rs`,
  typescript-language-server for `.ts`/`.tsx`/`.js`/`.mjs`.

**Status: configured, not measured yet.** Serena and the rust-analyzer
component were not installed on the machine that set this up, so the protocol
at the end of this page has not been run. Nothing in the build or CI depends on
Serena.

## What is configured

| File | What it does |
|---|---|
| [`.serena/project.yml`](../../.serena/project.yml) | Serena's project file: name `paged`, language servers `rust` and `typescript`, LSP backend, `encoding: utf-8`, ignored paths, no memories and no onboarding (`added_modes: ["no-memories"]`), no activation command, and the rust-analyzer options below. Keys as in Serena's `project.template.yml` for 2.0.0. |
| [`.mcp.json`](../../.mcp.json) | `serena start-mcp-server --context claude-code --project-from-cwd`. `--project-from-cwd` activates the nearest ancestor with `.serena/project.yml` (or `.git`), so every worktree is its own Serena project with its own language servers. |
| [`.claude/settings.json`](../../.claude/settings.json) | Serena's read tools (symbol overview, find symbol, references, implementations, declaration, diagnostics) are allowed; its editing tools ask first. The `claude-code` context already removes Serena's file and shell tools (`read_file`, `create_text_file`, `list_dir`, `find_file`, `search_for_pattern`, `execute_shell_command`). |
| [`.vscode/settings.json`](../../.vscode/settings.json) | The same `rust-analyzer.linkedProjects` and `rust-analyzer.cargo.targetDir` for VS Code. |
| `.gitignore` | `.serena/*` except `project.yml`: Serena's cache, memories and `project.local.yml` stay local. |

`.serena/project.yml` is the only file Serena reads from the repository.
Personal overrides go in `.serena/project.local.yml`; global settings (trusted
paths, defaults) in `~/.serena/serena_config.yml`.

## Install (each developer)

```bash
uv tool install -p 3.13 serena-agent==2.0.0   # the version the project file is written for
rustup component add rust-analyzer            # for the default toolchain, see below
proto install                                 # node 24.22.0 (and npm) for the TypeScript server
```

- **rust-analyzer.** Serena 2.0.0 finds it with `rustup which rust-analyzer`,
  run in the repository root. The root has no `rust-toolchain.toml`, so that is
  the default toolchain's component, not the one of `engine/core` (1.94.1) or
  the modules (1.93.0). If rustup is installed but the component is missing,
  Serena runs `rustup component add rust-analyzer` by itself; installing it
  first keeps that step explicit.
- **TypeScript.** Serena installs typescript-language-server and typescript
  into its own resource directory with npm on first use, so `node` and `npm`
  must be on `PATH` (proto provides both).
- **Trust the checkout.** Serena applies a project's `ls_specific_settings`,
  which carry the rust-analyzer options below, only to *trusted* projects. Add
  the path of every checkout and worktree (a glob such as `/path/to/worktrees/*`
  works) to `trusted_project_path_patterns` in `~/.serena/serena_config.yml`.
  Untrusted, rust-analyzer falls back to auto-discovery and finds no Cargo
  workspace at all.
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

- `linkedProjects` is a *global* setting. rust-analyzer reads it from the
  client's settings (VS Code's `settings.json`, or the LSP `initializationOptions`)
  or from the user-level `rust-analyzer.toml` in the OS config directory
  (`~/.config/rust-analyzer/` on Linux, `~/Library/Application Support/rust-analyzer/`
  on macOS). A `rust-analyzer.toml` in a project cannot set it.
- `cargo.targetDir` is a *workspace* setting. Besides the client's settings it
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
cargo options. **To be verified** in the measurement below: that rust-analyzer
loads all ten workspaces this way, and that the options survive rust-analyzer's
`workspace/configuration` request (Serena advertises that capability).

With a shared Cargo target directory (a root `.cargo/config.toml` setting
`build.target-dir`), `cargo.targetDir: true` puts all ten workspaces'
rust-analyzer checks in one `<shared>/rust-analyzer` directory. They then
contend with each other, not with the build; measure it if that layout lands.

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

1. *Implementations in one workspace.* Every implementation of
   `AssetResolver` (`engine/core/crates/paged-renderer/src/asset.rs`) and
   where each is constructed.
2. *Across Cargo workspaces.* The functions in `modules/publish` that take or
   return `paged_scene::Document` (a git-dependency crate from another
   workspace).
3. *Readers behind cfg.* Every place in `engine/core` that reads
   `PROTOCOL_VERSION`, including the wasm-only crates.
4. *TypeScript across pnpm workspaces.* References to `PluginManifest`
   (`platform/extensions/packages/plugin-api/src/manifest.ts`) in
   `platform/extensions` and in `modules/*/packages`, which import it from the
   published npm package rather than the source.
5. *A rename.* Rename a helper that several files of one `modules/sheet` crate
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

| Measure | 1 worktree | 2 worktrees | 3 worktrees |
|---|---|---|---|
| Cold index (min) | | | |
| Settled RSS, all servers (GB) | | | |
| `target/rust-analyzer` total (GB) | | | |

| Task | Serena: calls / bytes / time / correct | grep: calls / bytes / time / correct |
|---|---|---|
| 1 | | |
| 2 | | |
| 3 | | |
| 4 | | |
| 5 | | |

# ADR PM-0006 — Tool versions from proto, tasks through Moon, agent tools over MCP

- **Status:** Accepted 2026-10-18.
- **Scope:**
  - `.prototools`, `.protolock`.
  - `.moon/` (workspace, toolchains, shared tasks) and the `moon.yml` of every project.
  - `.github/workflows/moon.yml`, `.github/CODEOWNERS`.
  - `.mcp.json`, `.claude/settings.json`, `.serena/project.yml`, `.vscode/settings.json`.

## Context

The repository was assembled from separate component repositories and keeps
their build systems:

- Ten Cargo workspaces with members (`engine/core`, `modules/{publish,image,draw,sheet,data,doc,slide}`,
  `modules/web/packages/web-render`, `apps/server/server`) and two excluded ones
  (`engine/core/spikes/blitz-wasm`, `modules/sheet/fuzz`). There is no root `Cargo.toml`.
  Each workspace has its own lockfile, profiles and `deny.toml`; the engine and
  `modules/publish` pin Rust 1.94.1, the other modules 1.93.0, and `web-render` and the
  server pin nothing.
- Ten pnpm workspaces (the modules, `platform/extensions`, `apps/editor`) and one npm
  package (`engine/core/web/idml-viewer`). The editor declares pnpm 9.0.0, the modules use
  pnpm 10.
- CI is one set of path-filtered workflows per component
  ([`docs/migration/ci-port.md`](../migration/ci-port.md)).

Nothing ran a component's checks from the repository root, and nothing could say which
components a change affects. People and agents had to know each component's commands.

## Decision

### Tool versions: proto

`.prototools` pins moon 2.6.2, bun 1.4.3 and node 24.22.0 (`.protolock` carries the
checksums); `proto install` sets them up. Rust is not pinned by proto: every workspace keeps
its `rust-toolchain.toml`, which rustup honours per directory. pnpm is not in `.prototools`
either: Moon's pnpm toolchain pins it, 10.28.0 for the workspace and 9.0.0 for `apps/editor`
(its `packageManager`, set in `apps/editor/moon.yml`), until wave B replaces pnpm with Bun.

### Projects: one per Cargo or JS workspace

Moon v2 (`.moon/workspace.yml`) has one project per Cargo workspace and per JS workspace
root: `core`, `core-idml-viewer`, `publish`, `image`, `draw`, `sheet`, `data`, `doc`,
`slide`, `web`, `web-render`, `extensions`, `editor`, `server`. A module directory that
holds a Cargo workspace and a pnpm workspace is one project with both toolchains (tags
`rust` and `node`). The packages inside a pnpm workspace are not projects: their scripts
run through the workspace root, as the component CI runs them, and the component is the
unit that CI, ownership and `moon ci` reason about.

The Cargo workspaces stay separate. Merging them into one would change the resolution of
every lockfile and force one toolchain and one set of profiles; that is a decision of its
own. Each workspace is its own dependency root in Moon.

`dependsOn` records the build edges that exist today: `editor` → `doc`, `slide` (pnpm
`link:` overrides compile both bundles into the editor), `core` (test fixtures from
paged-gen, the fidelity lane's paged-diff), `data` (the dev-only DuckDB dist fallback);
`publish`, `server` → `core` (Cargo git dependencies); `extensions` → `core`
(`sync-catalog.mjs` reads the engine's catalog); `image`, `draw`, `sheet`, `data`, `doc`,
`slide` → `extensions` (the in-tree plugin-cli); `web` → `web-render`;
`core-idml-viewer` → `core`. `engine/core`'s git dependency on the old plugin-publish
repository reads nothing in `modules/publish` and is not an edge.

### Tasks: one vocabulary over two languages

- `.moon/tasks/rust.yml` (tag `rust`): `rust-fmt`, `rust-check`, `rust-lint`, `rust-test`,
  `rust-build`. `rust-test` is `cargo nextest run --workspace` followed by
  `cargo test --doc --workspace` (nextest does not run doctests), with the workspace's `ci`
  nextest profile under CI. `rust-lint` is clippy with the flags the component's workflow
  uses; `core`, `draw` and `web-render` override it with their workflow's exact invocations.
- `.moon/tasks/node.yml` (tag `node`): `js-check`, `js-test`, `js-build`, calling the
  workspace's own `typecheck`, `test` and `build` scripts through pnpm. (Amended 2026-10-18,
  TypeScript 7: `js-build` left `node.yml`; it is defined by the projects that still build,
  extensions, idml-viewer and the editor, `docs/migration/typescript-7.md`.) `js-lint` is
  defined where a component has a lint script.
- `.moon/tasks/all.yml`: the vocabulary `fmt`, `check`, `lint`, `test`, `build` for every
  project, as aggregates that depend on the Rust and JS halves the project has. `wasm` is
  defined per project and wraps the component's `scripts/build-wasm*.sh`, or
  `engine/core/scripts/build-wasm-packages.sh` for the engine's npm packages.
- Inputs decide what a change affects. Test tasks are not cached. Outputs are declared only
  for deterministic, gitignored artifacts (wasm package directories, tsup `dist/`); `target/`
  is never an output. (The wasm of draw, image and publish was committed when this was
  decided and so was not an output; since B3b it is build output like every other module's.)
- Moon does not modify tracked files: `syncPackageManagerField`,
  `syncProjectWorkspaceDependencies`, `dedupeOnLockfileChange`, the rust toolchain sync, VCS
  hooks and CODEOWNERS sync are off, the `typescript` toolchain is not enabled, and pnpm
  installs with `--frozen-lockfile`.

### CI: `moon ci` beside the component workflows

`.github/workflows/moon.yml` installs the `.prototools` tools with
`moonrepo/setup-toolchain` and runs `moon ci` against the pull request's base. It is
non-blocking (`continue-on-error`); the component workflows stay the gates. A later CI-speed
step compares the two (the workflow uploads `.moon/cache/ciReport.json`; the baseline is in
`ci-port.md`) before anything switches. Under `moon ci`, `rust-fmt`, `rust-lint`,
`rust-test`, `js-check`, `js-lint` and `js-test` run when affected, with the extra checks
the component workflows run (extensions' builds, `slide:vendor-check`,
`draw:manifest`, core's fixture generation);
the wasm builds are `runInCI: skip` (each needs its workspace's Cargo.lock version of
wasm-bindgen-cli), so JS suites skip their real-engine specs there; local-only tasks
(`rust-check`, `rust-build`, most `js-build`, `editor:e2e`, `core:wasm-test`) do not run.
`moon ci` selects by changed files only, without dependents: the dependents consume the
engine through git and npm pins today.

### No remote cache in Phase 1

Only Moon's local cache (`.moon/cache/`, gitignored). A remote cache needs write
credentials that pull requests from forks of a public repository must not hold, and a
cache-poisoning review; and caching first needs the inputs and outputs to be proven against
the component workflows. The CI-speed step decides with measurements.

### Agent tools over MCP

`.mcp.json` registers two servers, with no machine paths and no `MOON_WORKSPACE_ROOT`
(both find the workspace from the working directory):

- **`moon mcp`**: projects, tasks, changed files, templates. Moon 2.6 speaks the stateless
  MCP protocol `2026-07-28` (no `initialize`; `server/discover`; the protocol version in
  every request's `_meta`), so it needs a client that supports that protocol.
- **Serena 2.0.0** (`serena start-mcp-server --context claude-code --project-from-cwd`):
  the code-intelligence layer for agents, for Rust (rust-analyzer) and TypeScript/JavaScript
  (typescript-language-server). The version is pinned in the install command and the project
  file follows its 2.0.0 template, with the `tools` agent interface (one MCP tool per
  operation) instead of Serena 2.0's default REPL tool, so reads and edits can be permitted
  separately. `.serena/project.yml` passes rust-analyzer the ten
  workspaces as `linkedProjects` and a separate target directory; `.vscode/settings.json`
  does the same for VS Code. A root `rust-analyzer.toml` would not be read
  (`linkedProjects` is a client- or user-level setting). Setup, caveats and the measurement
  that decides whether Serena stays the default are in
  [`docs/development/code-intelligence.md`](../development/code-intelligence.md).
  rust-analyzer on its own, through an editor-agnostic LSP integration, was considered; it
  covers Rust only, and Serena covers both languages with one server.

`.claude/settings.json` allows the read tools of both servers and asks before anything that
writes (moon's `sync_projects`, `sync_workspace`, `generate`; Serena's editing tools).

### Protected configuration

`.github/CODEOWNERS` requires owner review for files that steer builds, CI or agents,
whoever changes them: `.github/`, `.moon/`, `.claude/`, `.mcp.json`, `.serena/`, `.vscode/`,
`.prototools`, `.protolock`, `.cargo/`, `tooling/`, `docs/adr/` and the lockfiles. Several
of them start processes: `.mcp.json` launches servers, `.serena/project.yml` can carry an
`activation_command`, and rust-analyzer settings can override its check command.

## Consequences

- `moon run <project>:test` (and the rest of the vocabulary) works from anywhere in the
  repository; the components' own cargo and pnpm commands keep working in their directories.
  The root `CLAUDE.md` and `CONTRIBUTING.md` say so.
- A new Cargo or JS workspace needs an entry in `.moon/workspace.yml` and a `moon.yml`; a
  new Cargo workspace also goes into `linkedProjects` in `.vscode/settings.json` and
  `.serena/project.yml`.
- Moving moon to another version means `.prototools`/`.protolock`, the `proto-version` of
  `moon.yml`'s setup step, and checking the MCP protocol it speaks.
- Known gaps, for the steps that own them:
  - `web-render` and `apps/server/server` have no `rust-toolchain.toml`, so Moon uses
    rustup's default toolchain there (web-rust pins 1.93.0 in the workflow).
  - The Cargo git-to-path step turns the engine ↔ publish git dependencies into in-repo
    edges in both directions; at workspace granularity that is a cycle, which Moon's project
    graph does not allow, so the step has to decide how to model it.
  - `apps/editor/pnpm-lock.yaml` was stale against its `package.json` when the paths were
    rewired ([`path-rewiring.md`](../migration/path-rewiring.md)); until it is regenerated,
    the frozen install before the editor's JS tasks fails.
  - The wasm tasks need wasm-bindgen-cli at each workspace's Cargo.lock version
    (0.2.122 to 0.2.129 across the workspaces) before they can run in `moon ci`.

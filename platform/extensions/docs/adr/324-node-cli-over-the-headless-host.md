# ADR 324 — A Node CLI, `@paged-media/cli`, over the headless host

- **Status:** Accepted. Recorded retroactively on 2026-10-15 from the code at `0dab296`. The
  package is `packages/cli` at 0.1.0-canary.0; it is not on npm yet (see Consequences). The
  design notes are [`DESIGN.md`](../../DESIGN.md) §22. Amended 2026-10-16: the bin is
  `paged-node` (see the amendment below; it supersedes §5).
- **Scope:** `packages/cli` (`src/session.ts`, `src/plugins.ts`, `src/verbs.ts`,
  `src/values.ts`, `src/errors.ts`, `src/data.ts`, `src/node-shims.ts`, `src/main.ts`,
  `src/bin.ts`), `HeadlessHost.exportDocument` in `packages/plugin-sdk/src/harness.ts`, and the
  package's entry in `.github/workflows/publish.yml`.

## Numbering

This record keeps the number its proposal had, and the code cites it by that number and by
section (§1 to §3 below). The object model it serves was proposed as "ADR 323" and is recorded
as [ADR 329](329-plugins-contribute-a-typed-object-model.md).

## Context

- The engine's Rust command line (core `crates/paged-cli`) cannot load plugins: it has no bundle
  host, so plugin objects such as image layers, sheet cells and draw symbols are out of its
  reach.
- `createHeadlessHost` in plugin-sdk already boots the published canvas-wasm in Node and loads
  bundles; plugin repositories test their bundles with it
  ([ADR 309](309-conformance-against-real-engine.md)).
- `host.objects` ([ADR 329](329-plugins-contribute-a-typed-object-model.md)) gives core and every
  plugin one typed read and write surface. A command line that injects it can get and set any
  property by address, with the same validation and the same undo step as the editor.

## Decision

### 1. The CLI is a host, and it lives in plugin-sdk

`@paged-media/cli` (bin `paged`) is the third host that injects `host.objects`, after the
editor and the headless harness. It reuses `createHeadlessHost` instead of copying it. It lives
in this repository so that a host change and its use in the CLI land in one commit, and it
publishes from the same workflow as the contract packages. A separate repository would pin
plugin-sdk by version and turn every host change into a cross-repository change.

### 2. Boot and bundle discovery

- `openSession` reads the canvas-wasm it finds (protocol 70 or later; the session's handshake
  follows that engine, not the vendored wire stamp), boots `createHeadlessHost`, opens the
  document (`.paged`, `.idml`, or none) and loads its own driver bundle, `media.paged.cli`,
  with broad document read and write. The driver is loaded first, so the doors the CLI uses do
  not depend on which plugins load.
- The CLI never depends on a plugin at build time. It finds bundles at run time: `--plugins
  a,b` loads exactly those (a miss is a usage error); otherwise it loads every first-party
  bundle resolvable from the working directory (`@paged-media/draw`, `image`, `sheet`, `data`,
  `web`, `doc`, `slide`, `publish`, `pdf`) and every dependency whose `package.json` carries a
  `"paged": { "manifest": … }` entry, and a miss is silent; `--no-plugins` loads none.
- The CLI registers `paged.ai.complete`, a typed command scripts can call to ask Claude for text
  ([ADR 325](325-claude-agent-package.md)); the client is built on the first call, so a run
  that never asks needs no key.

### 3. Verbs, values, output and exit codes

- The verbs come from one table, which also generates `--help`, checks arguments and feeds a
  spec that fails when a `host.objects` member is reached by no verb: `get`, `set`, `create`,
  `delete`, `query`, `schema`, `batch`, `commands`, `invoke`, `run`, `ai`, `export`, `apply`,
  `merge`, `plugins` and `describe`.
- A value on the command line is text until a schema row types it (`coerceValue`, then
  `validateValue`); a failure names the path and the expected type. `--json` parses the value
  as JSON instead. With no row, the text passes unconverted and its owner decides.
- `run` executes a JavaScript module with `paged` bound to `host.objects` plus the typed
  commands. It is not Boa; Boa scripts stay in core and reach plugin objects through the
  protocol-71 script bridge.
- Output is JSON on stdout unless `--text`; engine logs go to stderr.
- Exit codes: 0 ok, 1 a refused write or a failed check, 2 a usage or IO error.

### 4. Saving and export

- A write verb saves the document when it wrote, to `-o <file>` or back to the input; the
  format follows the extension. `--no-save` applies the change and writes nothing.
- `paged`, `idml` and `pdf` go through the engine's export (`HeadlessHost.exportDocument`);
  before `paged` and `idml`, the bundles' will-save hooks run, as File ▸ Save does. Any other
  format goes to a contributed exporter, chosen by id or extension. `export --format pdf`
  prefers a typed `exportPdf` command when one is installed and passes only the options given.
- `apply` and `merge` run the installed paged.data session in-process, with DuckDB-WASM's Node
  build as an optional peer dependency and narrow shims for the browser APIs the bundle expects.

### 5. The binary name

The npm bin is `paged`. The Rust binary is also named `paged`; the proposal renames it
`paged-core` at a later core release. That rename has not happened.

## Evidence

- `packages/cli/src/session.ts:15-19` — the CLI is a host; `:161-182` — boot on the engine it
  finds; `:204-220` — the driver bundle; `:265-296` — export and save
- `packages/cli/src/plugins.ts:15-24` — discovery; `:32-42` — the first-party bundles
- `packages/cli/src/verbs.ts:795` — the verb table; `:355-362` — `run` is a JavaScript module;
  `:484-500` — `export`
- `packages/cli/src/values.ts:75` — values typed by their schema row
- `packages/cli/src/errors.ts:15-17` — the exit codes
- `packages/cli/src/data.ts:74`, `:192` — the paged.data session and `apply`
- `packages/cli/package.json` — bin `paged`, Node 22 or later, `@duckdb/duckdb-wasm` an optional
  peer
- `packages/cli/test/cli-core.spec.ts:264-272` — every `host.objects` member is reached by a verb
- `.github/workflows/publish.yml` — `packages/cli` is in the publish loop

## Consequences

- The CLI reaches every property the object model publishes, for core and for every installed
  plugin, with the same validation and undo step as the editor.
- The CLI is not on npm. A package's first publish cannot go through trusted publishing, so it
  needs one manual publish. In `publish.yml` the loop reaches `@paged-media/ai` before
  `@paged-media/cli`, fails there on the same first-publish rule, and never attempts the CLI.
- The CLI's tests run in `publish.yml` only, after a merge to `main`; `vitest.yml` does not run
  them on pull requests.
- The version-bump guard covers `plugin-api` and `plugin-sdk` only
  ([ADR 306](306-canary-releases.md)), so a change to the CLI without a version bump publishes
  nothing.
- The Rust CLI stays for core-only work and CI.

## Amendment — 2026-10-16: the bin is `paged-node`

§5 is superseded. The npm bin is `paged-node`, and core's Rust CLI keeps the name `paged`; the
`paged-core` rename §5 recorded for core is withdrawn. Both commands install a binary, and one
`PATH` that holds both would run whichever comes first under the name `paged`. Renaming the Node
command touches one package that has never been published; renaming the Rust one would break
the scripts and CI that already call it.

- `packages/cli/package.json` — `"bin": { "paged-node": "./dist/bin.js" }`.
- `packages/cli/src/errors.ts` — `BIN`, the one place the name is spelled. The help text, a
  verb's help, the usage and error lines and the hints that name another verb read it.
- `packages/cli/test/cli-core.spec.ts` and `test/bin.spec.ts` — the bin key, the help text,
  the usage line and the error prefix, in-process and through the built `dist/bin.js`.

Every verb, option, output and exit code is unchanged: `paged get …` is now `paged-node get …`,
and `paged ai …` is `paged-node ai …` ([ADR 325](325-claude-agent-package.md)). The package is
still `@paged-media/cli` at 0.1.0-canary.0, and the `media.paged.cli` driver bundle keeps its
id. Text that names the Rust CLI keeps `paged`: `paged script`, and `paged describe` for the
engine's catalog (the Node CLI's own `describe` verb is `paged-node describe`).

## Related

- [ADR 329](329-plugins-contribute-a-typed-object-model.md) — the object model the CLI hosts
- [ADR 309](309-conformance-against-real-engine.md) — the headless host on the real published
  engine
- [ADR 325](325-claude-agent-package.md) — `paged ai` and `paged.ai.complete`
- Core [ADR 113](https://github.com/paged-media/core/blob/main/docs/adr/113-one-typed-door.md) —
  one typed door for wasm, CLI, session and scripts

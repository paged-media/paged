# ADR 185 — The engine's wasm packages are workspace packages

- **Status:** Accepted 2026-10-18.
- **Scope:**
  - `packages/{canvas-wasm,introspect-wasm,repo-wasm,sdk}/`: one directory per npm package,
    each a member of the repository's root Bun workspace.
  - `scripts/build-wasm-packages.sh --workspace` and Moon's `core:wasm-pkg`.
  - `scripts/check-wasm-package-versions.mjs`, run by `.github/workflows/core-ci.yml`
    (`protocol-tag-guard`) and by Moon's `core:wasm-pkg-version`.
  - `.github/workflows/core-publish-wasm.yml`.
  - No wire or protocol change.

## Context

The engine ships four wasm-bindgen packages to npm: `@paged-media/canvas-wasm`
(`paged-canvas-wasm`), `@paged-media/introspect-wasm` (`paged-introspect-wasm`),
`@paged-media/repo-wasm` (`paged-repo-wasm`) and `@paged-media/sdk` (`paged-sdk`). None of
them had a directory in the tree. The publish workflow built each into `dist/<pkg>/` and
wrote its `package.json` there, and the editor, the modules and the extension SDK took them
only at exact npm pins ([editor ADR 200](../../../../apps/editor/docs/adr/200-engine-as-npm-wasm-packages.md)).

The engine and its consumers are now one repository. Still, an engine change reached a
consumer only through a tag, a publish and a pin move in that consumer, because there was no
package in the tree for a consumer to depend on.

The editor reads the wire protocol from the minor of canvas-wasm's version
(`0.<protocol>.<patch>`, [ADR 006](006-protocol-coupled-versioning.md);
`apps/editor/packages/client/src/protocol.ts`). A package in the tree has to carry the
protocol in its version too.

## Decision

1. **Each package has a directory, `packages/<pkg>/`, in the root Bun workspace**
   (`/package.json` lists `engine/core/packages/*`). The directory commits `package.json`, a
   README and the licence files: `LICENSE` (the AGPL-3.0 text) and `LICENSE.md` (the dual
   licence). The generated files are gitignored beside them: `<stem>.js`, `<stem>.d.ts`,
   `<stem>_bg.wasm` and, for introspect-wasm, `catalog.json`.
2. **The manifests lay out the packages as the published ones do.** Each has `type: module`,
   `main` and `types` pointing at the wasm-bindgen glue, and `files` listing the glue, the
   wasm and, for introspect-wasm, `catalog.json`. There is no `exports`, because consumers
   import `package.json` and `<stem>_bg.wasm?url` by subpath. The manifests add a
   `description`, and a `repository` with its directory, which npm checks against the
   provenance of a trusted publish.
3. **The committed version is `0.<PROTOCOL_VERSION>.0-dev`**, with `PROTOCOL_VERSION` taken
   from `crates/paged-canvas/src/channel.rs`. A consumer that reads the protocol from the
   version gets the protocol of the engine in the tree. `-dev` marks a build from the tree,
   and semver orders it below the protocol's first release.
4. **A check keeps the versions on the protocol.**
   `scripts/check-wasm-package-versions.mjs` fails when a version differs, and `--write` sets
   the versions. The check runs in core-ci's `protocol-tag-guard` job on every pull request
   and every push to main, and in Moon as `core:wasm-pkg-version`, which `core:check` depends
   on. A protocol bump therefore moves the four versions. It also moves `bun.lock`, which
   records workspace versions.
5. **One script builds the packages, locally and in CI.**
   `scripts/build-wasm-packages.sh --workspace` writes the generated files into the
   directories and leaves the committed files unchanged. Moon's `core:wasm-pkg` runs it.
   Without `--workspace`, the script still writes standalone copies to `dist/<pkg>/` at
   `0.<protocol>.0-local`.
6. **The release version exists only in a staged copy.** The publish workflow runs the same
   build into the directories and copies each package to a staging directory. It sets the
   release version from the tag (`v0.<p>.<n>` becomes `0.<p>.<n>`) in the copy and publishes
   the copy. The run fails when the tag's protocol differs from the packages'. Release
   versions are never committed. Token authentication, the trusted-publishing advisory and
   the dist-tag rule are unchanged.

## Consequences

- A consumer can now depend on the packages as `workspace:*`. Until one does, nothing
  changes. Consumers keep their exact npm pins, Bun links a workspace package only for a
  `workspace:` specifier (`linkWorkspacePackages = false` in `/bunfig.toml`), and the
  in-tree version differs from every published one.
- Once the editor depends on them through the workspace, developing the editor builds the
  engine. That needs:
  - Rust through rustup, at the toolchain `rust-toolchain.toml` pins, with the
    `wasm32-unknown-unknown` target;
  - wasm-bindgen-cli at the `Cargo.lock` version, and binaryen's `wasm-opt`
    (`tooling/bootstrap.sh` installs both);
  - `moon run core:wasm-pkg`.

  A fresh checkout without these has package directories with no wasm in them.
- Fetching prebuilt artifacts could be a follow-up for contributors who do not change the
  engine: the generated files of an engine revision would be downloaded from CI instead of
  built. Nothing for this is built yet.
- Local builds and published packages now come from one script and one set of manifests. The
  workflow no longer writes a `package.json`.
- The published packages gain `README.md`, `LICENSE`, `LICENSE.md`, `description` and
  `repository`. Their file layout and entry points stay as they were. Their licence is
  `AGPL-3.0-only OR LicenseRef-PMEL`, as for every release since the relicense.

## Evidence

- `packages/*/package.json` — the manifests; `.gitignore` — what the directories commit
- `/package.json` (`workspaces`), `/bunfig.toml` (`linkWorkspacePackages`)
- `scripts/build-wasm-packages.sh`, `scripts/check-wasm-package-versions.mjs`
- `moon.yml` — `wasm-pkg`, `wasm-pkg-version`, `check`
- `.github/workflows/core-ci.yml` — `protocol-tag-guard`
- `.github/workflows/core-publish-wasm.yml` — build, stage, publish

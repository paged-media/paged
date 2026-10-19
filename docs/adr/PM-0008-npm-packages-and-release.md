# PM-0008 — Four public npm packages, one release workflow

- **Status:** Accepted 2026-10-18. Amended 2026-10-18 (amendment 1: one version for the four
  packages, and how a release is cut).
- **Supersedes:** apps/editor ADR 201 (first-party plugins compiled in as pinned published
  packages).
- **Amends:** apps/editor ADR 205 (the client packaged as the write SDK): the client is a
  private workspace package; the write surface ships in `@paged-media/canvas-wasm`.
- **Scope:** every `package.json` `private`/`publishConfig`, `.github/workflows/release.yml`,
  npm dist-tags and deprecations.

## Context

About 25 packages were on npm. Most existed only so one repository could pin another's build:
the nine module bundles, the editor client and shell packages, and the contract packages'
canaries. Their versions drifted apart (the editor pinned four different plugin-api canaries
at once), and each cross-repository change needed a publish and a re-pin. In one repository
none of that is needed: first-party code reaches first-party code through the workspace.

## Decision

- **Public, under `AGPL-3.0-only OR LicenseRef-PMEL` from their next version:**
  1. `@paged-media/idml-viewer`, with a `/session` subpath (absorbs `@paged-media/sdk`). A
     subset audit keeps mutation, canvas and introspection out of it.
  2. `@paged-media/canvas-wasm`, with `./introspect` (and its `catalog.json`) and `./repo`
     subpaths (absorbs `introspect-wasm` and `repo-wasm`). The wasm budget counts only the
     wasm a page loads.
  3. `@paged-media/plugin-api`: type-only, a peer dependency of extensions.
  4. `@paged-media/plugin-sdk`, with the `paged-plugin` bin (absorbs `plugin-cli`).
- **Everything else is a private workspace package:**
  - the nine bundles, `ai` and the CLI;
  - the editor's client, repository, host models, shell, UI, tools and catalog packages;
  - draw's geometry and tools, image's manifest, web's model and conformance.
- **Deprecated on npm** (by the package owner) with a message naming the replacement: the
  module bundles, the June leftovers, `sdk`, `introspect-wasm` and `plugin-cli`. Stale `latest`
  and `canary` dist-tags are corrected.
- **One release workflow** (`release.yml`):
  - **Tags:** engine and SDK releases stay tagged `v0.<protocol>.<patch>` at the repository
    root. Check the remote's tags and npm before naming a version: two releases have raced.
  - **Packing:** packages are packed with the workspace resolved (`workspace:`/`catalog:`
    rewritten).
  - **Publishing:** `npm publish --provenance` through npm trusted publishing (OIDC) from this
    repository. The token secret is retired after the first OIDC publish.
  - **Deploys:** the editor deploy (Cloudflare Pages) and the module upload move into the same
    workflow.

## Consequences

- An extension author depends on two packages, plus `canvas-wasm` or `idml-viewer` to embed
  the engine.
- First-party changes never wait for a publish.
- Already-published versions stay where they are, under the licence they were published with.

## Amendment 1 (2026-10-18): one version for the four, and how a release is cut

The decision above names the tag scheme for engine and SDK releases but not the version of the
two contract packages, nor what happens to the canary lane. Carrying it out needed both.

- **One version for the four packages: the tag's.** A tag `v0.<protocol>.<patch>` publishes
  `canvas-wasm`, `idml-viewer`, `plugin-api` and `plugin-sdk` all at `0.<protocol>.<patch>`, and
  `plugin-sdk` depends on exactly that `plugin-api`. `plugin-api` and `plugin-sdk` therefore move
  from their `0.2.N-canary.0` line to the engine's line at the first release (0.2.x to 0.74.x is
  allowed under 0.x semver). The plugin contract's own version, `API_VERSION` and a manifest's
  `apiVersion` (`^0.2`), is separate and unchanged.
- **The in-tree versions are not release versions.** `canvas-wasm` and `idml-viewer` commit
  `0.<protocol>.0-dev`, held to `PROTOCOL_VERSION`; `plugin-api` and `plugin-sdk` keep their
  `0.2.N-canary.0` counter, which the contract guard still requires to move with every change
  under their `src/`. `release.yml` sets the tag's version in its checkout only.
- **No canary channel.** First-party code takes every package from the workspace, so nothing
  needs a canary. A tag with a `-suffix` publishes under `next`; any other tag under `latest`.
  The first release under `latest` also corrects the stale `latest` of `plugin-api` and
  `plugin-sdk`; the leftover `canary` dist-tags are removed by the owner.
- **The tag's minor must be the engine's protocol.** The workflow refuses a tag whose
  `0.<protocol>` differs from the committed one. Two releases have raced before, and the tag
  `v0.74.0` already exists (imported with the engine's history, never published to npm), so the
  first release from this repository is `v0.74.1` unless the protocol has moved on by then.
- **Gates before a publish:** the engine wasm built fresh (no cache), the viewer subset audit
  (crate graph and packed files), the tarballs verified, and a clean-room install of the four
  under Node (npm) and Bun with a TypeScript consumer checked under `nodenext` and `bundler`.
- **The wasm budget** (`apps/editor/scripts/wasm-budget.mjs`) counts a package's wasm unless
  only entries the editor page does not import lead to it, so `./introspect` (devtools only)
  is not part of the editor's 100 MB.

The owner's steps (deprecations, dist-tags, trusted publishers, the first tag) are in
[docs/migration/npm-release-runbook.md](../migration/npm-release-runbook.md).

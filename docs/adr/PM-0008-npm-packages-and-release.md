# PM-0008 — Four public npm packages, one release workflow

- **Status:** Accepted 2026-10-18.
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

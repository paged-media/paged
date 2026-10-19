# PM-0008 — Four public npm packages, one release workflow

- **Status:** Accepted 2026-10-18. Amended 2026-10-18 (amendment 1: one version for the four
  packages, and how a release is cut), 2026-10-19 (amendment 2: the contract moves to
  React 19) and 2026-10-19 (amendment 3: three public packages, before the first release).
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

## Amendment 2 (2026-10-19): the contract moves to React 19

The workspace moved from React 18.3 to React 19.3.1 (one instance, from the root `catalog:`;
[the migration record](../migration/npm-latest.md#react-19)). React reaches the contract in two
places, and both move with it:

- **`@paged-media/plugin-api` depends on `@types/react` ^19.3** (it was ^18.3). The React types
  in the contract, such as the component a panel contribution carries, are React 19's.
- **React stays a peer of the extension, at `>=19.3`.** `plugin-sdk`'s optional React peer and
  every built-in bundle's peer move from `^18.3` to `>=19.3`; the editor provides React 19.3.1.
  A lower bound and no upper bound: a later React 19 or 20 is the host's to provide, as the
  contract's own peer range is (ADR 307).
- **The in-tree counters move together:** `plugin-api` and `plugin-sdk` 0.2.78-canary.0 →
  0.2.79-canary.0. The next release publishes both at the tag's version (amendment 1).

What an extension author changes is in
[platform/extensions/README.md](../../platform/extensions/README.md#react-19).

## Amendment 3 (2026-10-19): three public packages, before the first release

Nothing was published from the layout of the decision above. Before the first release the four
packages become three, and the engine package carries the command line.

| Package | Directory | Entries | Built from |
|---|---|---|---|
| `@paged-media/viewer` | `engine/core/web/idml-viewer` | `.`, `./session`, `./session/paged_sdk_bg.wasm` | the viewer and the `paged-sdk` session wasm |
| `@paged-media/paged` | `packages/paged` | `.`, `./introspect`, `./introspect/catalog.json`, `./repo`, each wasm by its own subpath; bin `paged` | the engine wasm of the private `@paged-media/canvas-wasm`, and the CLI of the private `@paged-media/cli` (`apps/cli`), bundled |
| `@paged-media/plugin-sdk` | `platform/extensions/packages/plugin-sdk` | `.`, `./gesture-kit`, `./api` (type-only), `./api/manifest.schema.json`; bin `paged-plugin` | the runtime, and the declarations of the private `@paged-media/plugin-api`, inlined |

- **`@paged-media/viewer` replaces `@paged-media/idml-viewer`**, unchanged otherwise: the
  `./session` entry and the subset audit (its wasm links no mutation, canvas, scripting or
  introspection crate) stay. The directory and the Moon project (`core-idml-viewer`) keep their
  names; the format stays `idml`, the package is the viewer.
- **`@paged-media/paged` replaces `@paged-media/canvas-wasm` on npm.** `canvas-wasm` stays the
  engine's workspace package (about a hundred files import it) and becomes private;
  `packages/paged` assembles the published package from its built files, so a consumer's
  imports change only in the package name (`@paged-media/paged/introspect`, `…/repo`). The
  package also ships the `paged` bin: the Node CLI of `apps/cli`, bundled into the package's
  `dist/` with every first-party module inlined, so it runs from the tarball under Node 24 and
  Bun with nothing native. In the repository the bin keeps the name `paged-node`
  ([ADR 324](../../platform/extensions/docs/adr/324-node-cli-over-the-headless-host.md), its
  amendment), so it does not shadow the engine's Rust `paged` in a checkout; the Rust CLI is not
  on npm. `paged mcp` serves the tools of the Rust `paged mcp` (`engine/core/crates/paged-mcp`)
  over stdio, with the same names and schemas, over the wasm engine.
- **`@paged-media/plugin-sdk` absorbs `@paged-media/plugin-api` as its type-only `./api`
  entry.** `plugin-api` stays the contract's source package in the workspace (about seven
  hundred files import it) and becomes private. plugin-sdk's build copies its declarations
  into `dist/api/` and points its own declarations there, so the published package depends on
  no private package
  ([ADR 331](../../platform/extensions/docs/adr/331-the-host-adapter-stays-public.md)). An
  extension takes its types from `@paged-media/plugin-sdk/api` and its runtime from
  `@paged-media/plugin-sdk`, and has one peer dependency: `@paged-media/plugin-sdk`. The
  `paged-plugin` bin gains `init`, which writes a minimal extension.
- **The contract has one public version: plugin-sdk's.** A change under `plugin-api/src` or
  `plugin-sdk/src` moves plugin-sdk's in-tree counter, and plugin-api's private counter moves
  with it to the same value (the contract guard checks both). A release publishes plugin-sdk at
  the tag's version, as amendment 1 says.
- **Why three and not two.** The viewer could be an entry of `@paged-media/paged`, but a
  script-tag or CDN user who wants to show a document would then install the full engine, with
  its editing canvas, introspection and CLI: the viewer stays a package of its own, a small one.
- **Built-in modules change nothing.** They are private workspace packages; their
  `workspace:` dependencies and peers on `plugin-api` and `plugin-sdk` stay as they are.
- **Deprecated on npm**, besides the list above, once the replacements are published:
  `idml-viewer` (use `@paged-media/viewer`), `canvas-wasm` (use `@paged-media/paged`) and
  `plugin-api` (use `@paged-media/plugin-sdk/api`). `sdk`, `introspect-wasm` and `plugin-cli`
  now point at `@paged-media/viewer/session`, `@paged-media/paged/introspect` and the
  `paged-plugin` bin of plugin-sdk. The commands, and the unpublishing of the retired packages
  where npm allows it, are in [the runbook](../migration/npm-release-runbook.md).

- **Retired without a replacement**, the seven module bundles and eleven internal packages:
  unpublished where npm's policy allows it (no dependents, fewer than 300 downloads a week, one
  owner; dependents first), deprecated otherwise. The six with a replacement are only ever
  deprecated. `tooling/release/retire-precheck.mjs` reads what the policy looks at, read-only.
- **The first release publishes with a token.** npm registers a Trusted Publisher for an
  existing package only, so the first publish of `paged` and `viewer` goes through `NPM_TOKEN`;
  the owner then registers the three entries and deletes the secret. The auth gate already
  accepts a token when trusted publishing is not ready for every package.

The release workflow assembles `packages/paged`, stages, verifies, installs in a clean room
(`npm` and Bun, TypeScript 7 and 5.9, `nodenext` and `bundler`, both bins, `paged mcp`'s
initialize and tools/list, `paged-plugin init` and the scaffold's own test) and publishes the
three, at the tag's version; the minor carries the protocol, read from `packages/paged`'s
committed `0.<protocol>.0-dev` (held to `PROTOCOL_VERSION` with canvas-wasm's and the viewer's).
At a test version on 2026-10-19 the tarballs were 15.8 MB (`paged`, 45.6 MB unpacked: the canvas
wasm 28.8 MB, the introspection 13.8 MB, the bundled CLI 1.5 MB), 4.6 MB (`viewer`, 11.7 MB) and
0.3 MB (`plugin-sdk`, 1.3 MB). paged.data is not in `paged`: its own wasm is 1.4 MiB, but it runs
on DuckDB-WASM (34 MiB), and it is built into the editor; `paged apply` and `merge` say so.

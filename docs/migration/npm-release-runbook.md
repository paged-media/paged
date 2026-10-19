# npm release runbook

What the package owner does on npm and GitHub to finish [PM-0008](../adr/PM-0008-npm-packages-and-release.md)
(four public packages, one release workflow) and to cut a release. The repository side is done:
`.github/workflows/release.yml` publishes, and nothing in the repository publishes anything else.
The inventory these steps act on is [npm.md](npm.md).

Every command below that changes the registry or the repository's tags is the owner's to run, in
the order given. The read-only checks can be run by anyone.

## The four packages

| Package | Entries | What it carries |
|---|---|---|
| `@paged-media/canvas-wasm` | `.`, `./introspect`, `./introspect/catalog.json`, `./repo`, each wasm by its own subpath | the engine: the editing canvas, the introspection (`Inspector`, the capability catalog), the document repository |
| `@paged-media/idml-viewer` | `.`, `./session`, `./session/paged_sdk_bg.wasm` | the viewer, and the renderer-only `ViewerSession` it wraps |
| `@paged-media/plugin-api` | `.`, `./manifest.schema.json` | the extension contract, type-only |
| `@paged-media/plugin-sdk` | `.`, bin `paged-plugin` | the extension runtime and the manifest CLI |

All four are `AGPL-3.0-only OR LicenseRef-PMEL`. A tag `v0.<protocol>.<patch>` publishes all four at
`0.<protocol>.<patch>` (PM-0008, amendment 1); a tag with a `-suffix` publishes under `next`.

## 0. Before anything: what is on the remote and on npm

Two releases have raced before. Check both, every time, before naming a version:

```sh
git fetch origin --tags
git ls-remote --tags origin 'v0.*' | grep -v '\^{}' | awk '{print $2}' | sed 's#refs/tags/##' | sort -V | tail -5
grep -oE 'ProtocolVersion\([0-9]+\)' engine/core/crates/paged-canvas/src/channel.rs | head -1
for p in canvas-wasm idml-viewer plugin-api plugin-sdk; do
  printf '%s: ' "$p"; npm view "@paged-media/$p" dist-tags --json | tr -d ' \n'; echo
done
node tooling/release/assert-dist-tags.mjs --audit   # read-only
```

On 2026-10-18 this showed: the tag `v0.74.0` exists (imported with the engine's history; nothing was
published from it), `PROTOCOL_VERSION` is 74, and npm's newest engine release is 0.73.4. So the first
release from this repository is **`v0.74.1`**, unless the protocol or the tags have moved on by the
time you run this. Use the next free `v0.<protocol>.<patch>`.

## 1. Register the trusted publishers (once per package)

For each of `@paged-media/canvas-wasm`, `@paged-media/idml-viewer`, `@paged-media/plugin-api` and
`@paged-media/plugin-sdk`, on npmjs.com: the package → **Settings** → **Trusted Publisher** →
**GitHub Actions**, with exactly:

| Field | Value |
|---|---|
| Organization or user | `paged-media` |
| Repository | `paged` |
| Workflow filename | `release.yml` |
| Environment | (empty) |

Entries registered for the old repositories (`core` / `publish-wasm.yml`, `plugin-sdk` /
`publish.yml`) or for `core-publish-wasm.yml` / `extensions-publish.yml` do not match and can be
removed. The release run's step "trusted publishing — readiness of the four packages" asks npm's
token exchange for each package and prints the claims it presented; `OK` for all four means the
entries are right.

Keep the `NPM_TOKEN` repository secret until step 3. The release's auth gate passes when trusted
publishing is ready for all four packages, or else when `NPM_TOKEN` authenticates; it fails before
building when neither holds.

## 2. Cut the release

On a commit of `main` that contains wave D (`release.yml` and the package changes), with step 0
re-checked:

```sh
git fetch origin
git tag -a v0.74.1 origin/main -m "v0.74.1: the first release from paged-media/paged (PM-0008): canvas-wasm with ./introspect and ./repo, idml-viewer with ./session, plugin-api and plugin-sdk (with the paged-plugin bin) at one version"
git push origin v0.74.1
gh run list -R paged-media/paged -w release.yml -L 3
gh run watch -R paged-media/paged <run id>
```

The run builds the engine wasm without a cache (about 20 to 30 minutes), checks, stages and verifies
the tarballs, installs them in a clean room under Node and Bun, keeps them as the
`npm-tarballs-<version>` artifact, publishes with `--provenance` and asserts the dist-tags.

A run that stops after publishing some packages is finished by **re-running the same tag**
(`gh run rerun <run id>`, or `gh workflow run release.yml -R paged-media/paged --ref v0.74.1`);
packages already on npm are skipped. Never re-tag a version that is partly on npm.

Then check what npm serves:

```sh
for p in canvas-wasm idml-viewer plugin-api plugin-sdk; do
  npm view "@paged-media/$p@0.74.1" version dist.attestations.provenance.predicateType
done
node tooling/release/assert-dist-tags.mjs 0.74.1 latest
```

Each should print the version and a provenance predicate. A release to `latest` also moves the
stale `latest` of `plugin-api` and `plugin-sdk` (June's `0.2.8-canary.0`) to the release.

## 3. Retire the token (after the first OIDC publish)

Only when the release run's readiness step showed `OK` for all four packages and npm shows provenance
for all four (step 2):

```sh
gh secret delete NPM_TOKEN -R paged-media/paged
```

and revoke the token itself on npmjs.com (Access Tokens). From then on trusted publishing is the
only way in, and the auth gate fails a run whose packages are not all ready. Optionally, set each
package's **Publishing access** to require two-factor authentication and disallow tokens.

## 4. Remove the leftover `canary` dist-tags

The canary lane is gone (PM-0008, amendment 1). After the first release:

```sh
npm dist-tag rm @paged-media/plugin-api canary
npm dist-tag rm @paged-media/plugin-sdk canary
npm dist-tag rm @paged-media/idml-viewer canary
node tooling/release/assert-dist-tags.mjs --audit
```

npm refuses to delete a `latest` tag; that is why step 2 corrects `latest` by publishing over it.

## 5. Deprecate the retired packages

Deprecating keeps every version installable and shows the message on install. The three with a
replacement wait until that replacement is on npm (step 2). Run from any directory, logged in as the
package owner (`npm whoami`):

```sh
src="Source: https://github.com/paged-media/paged"

# The replacements (after step 2).
npm deprecate @paged-media/sdk "Use @paged-media/idml-viewer/session (same API), from 0.74.1. $src"
npm deprecate @paged-media/introspect-wasm "Use @paged-media/canvas-wasm/introspect (and ./introspect/catalog.json), from 0.74.1. $src"
npm deprecate @paged-media/plugin-cli "Use the paged-plugin bin of @paged-media/plugin-sdk, from 0.74.1. $src"

# Built into the editor; never published separately again.
moved="Built into the paged editor; no longer published separately. $src"
for p in data draw image pdf publish sheet web; do
  npm deprecate "@paged-media/$p" "$moved"
done

# Earlier names of the bundles, and internal packages.
for p in data-bundle draw-bundle image-glue sheet-bundle web-bundle \
         data-host-model draw-geometry draw-tools image-manifest sheet-host-model web-model; do
  npm deprecate "@paged-media/$p" "$moved"
done
```

Check: `npm view @paged-media/sdk deprecated` (and so on) prints the message.
`@paged-media/repo-wasm` was never published, and `doc`, `slide`, `client`, `ai` and `cli` never were
either; there is nothing to deprecate for them.

## 6. Later releases

1. Step 0: the remote's tags, `PROTOCOL_VERSION` and npm's versions.
2. `git tag -a v0.<protocol>.<patch> <commit on main> -m "<what changed>"` and
   `git push origin v0.<protocol>.<patch>`.
3. Watch the run; re-run the tag to finish a partial release.

A protocol bump on `main` needs its tag in the same push (core-ci's `protocol-tag-guard`), so the
first release of a protocol is `v0.<new protocol>.0`.

## 7. Consumers outside this repository

None of these is changed by the repository; each needs its own change once `0.74.1` is on npm.

**The documentation site (docs.paged.media)**

- `package.json`: `@paged-media/idml-viewer` `0.73.4` → `0.74.1`.
- `scripts/prepare-preview-wasm.mjs`: still works (the package keeps `wasm/paged_sdk*`); resolving
  `@paged-media/idml-viewer/session` instead of walking up from `dist/` is cleaner, and the package
  now exports `./package.json`.
- `content/docs/paged/sdk/index.mdx`, `sdk/api-reference.mdx`, `sdk/viewer-session.mdx`,
  `sdk/embedding-guide.mdx`: `@paged-media/sdk` → `@paged-media/idml-viewer/session`,
  `@paged-media/introspect-wasm` → `@paged-media/canvas-wasm/introspect`;
  `scripts/generate/sdk-catalog.seed.json` and `gen-sdk.mjs` follow the viewer's `api-catalog.json`,
  whose section titles changed the same way.
- `content/docs/paged/plugin-sdk/index.mdx`: drop the `@paged-media/plugin-cli` row; the CLI is the
  `paged-plugin` bin of `@paged-media/plugin-sdk`; the install line is
  `npm install -D @paged-media/plugin-api @paged-media/plugin-sdk` (no `@canary`), and
  `npx paged-plugin validate manifest.json`.
- `content/docs/paged/plugins/template.mdx`, `plugins/publish.mdx`: no canary packages; built-in
  modules are not on npm.
- `content/docs/paged/repos/*.mdx`, `architecture.mdx`, `engine/the-renderer/index.mdx`,
  `engine/the-renderer/rendering-backends.mdx`: the engine ships as the two packages above, from
  `paged-media/paged`; the editor takes them from the workspace, not from npm.
- `core.pin` and the other `sources.pin` entries point at `paged-media/paged` (wave E).

**The paged.media website**

- `apps/site/src/site/Developers.tsx`: the viewer card stays `npm install @paged-media/idml-viewer`;
  the plugin card's `paged-plugin validate` now comes with `@paged-media/plugin-sdk`; name
  `@paged-media/idml-viewer/session` where the low-level session is meant.
- `apps/site/scripts/fetch-site-data.mjs`: the `PLUGINS` map names each module's npm bundle
  (`@paged-media/draw`, …); those are deprecated, so the plugin pages should say "built into the
  editor" instead of naming a package (and `released` no longer means "on npm").

**The plugin template**

- `package.json`: remove `@paged-media/plugin-cli`; `@paged-media/plugin-api` and
  `@paged-media/plugin-sdk` from `canary` to `^0.74.1` (devDependencies) and the peers to
  `>=0.74.1`. The `validate` script (`paged-plugin validate src/manifest.json`) is unchanged: the bin
  now comes with `@paged-media/plugin-sdk`.
- `.github/workflows/ci.yml`: the "report resolved canary versions" step drops
  `@paged-media/plugin-cli`; the job floats on `latest`, not `canary`.
- `README.md`, `docs/README.md`: the same.

**The feature registry's public export (`exports/public.json`)**

- Notes name `@paged-media/introspect-wasm` (the catalog source) and `plugin-cli` (the manifest
  validator); regenerate after the registry's feature files say `@paged-media/canvas-wasm/introspect`
  and "the `paged-plugin` bin of plugin-sdk". The template row's "canary" dependency note changes
  with the template.

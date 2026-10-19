# npm release runbook

What the package owner does on npm and GitHub to finish [PM-0008](../adr/PM-0008-npm-packages-and-release.md)
(three public packages since amendment 3, one release workflow) and to cut a release. The
repository side is done: `.github/workflows/release.yml` publishes, and nothing in the repository
publishes anything else. The inventory these steps act on is [npm.md](npm.md).

Every command below that changes the registry or the repository's tags is the owner's to run, in
the order given. The read-only checks can be run by anyone.

The packages live in the npm **organization** `paged-media`, which owns the `@paged-media` scope;
the owner's account is a member of it. Scoped packages publish as `restricted` unless told
otherwise, so every public package says `"publishConfig": { "access": "public" }` and
`release.yml` passes `--access public` (both are checked: `tooling/release/verify-tarballs.mjs`).

## The three packages

| Package | Directory | Entries | What it carries |
|---|---|---|---|
| `@paged-media/paged` | `packages/paged` | `.`, `./introspect`, `./introspect/catalog.json`, `./repo`, each wasm by its own subpath; bin `paged` | the engine (the editing canvas, the introspection, the document repository), assembled from the private `canvas-wasm`, and the `paged` command line (`apps/cli` bundled), with `paged mcp` |
| `@paged-media/viewer` | `engine/core/web/idml-viewer` | `.`, `./session`, `./session/paged_sdk_bg.wasm` | the viewer, and the renderer-only `ViewerSession` it wraps |
| `@paged-media/plugin-sdk` | `platform/extensions/packages/plugin-sdk` | `.`, `./gesture-kit`, `./api` (type-only), `./api/manifest.schema.json`; bin `paged-plugin` | the extension runtime, the contract (the private `plugin-api`, inlined) and the manifest CLI (`init`, `validate`, …) |

All three are `AGPL-3.0-only OR LicenseRef-PMEL`. A tag `v0.<protocol>.<patch>` publishes all three
at `0.<protocol>.<patch>` (PM-0008, amendment 1); a tag with a `-suffix` publishes under `next`.

Measured on 2026-10-19 at a test version (`bun tooling/release/stage.mjs 0.74.1 <dir>`, which
`npm pack --dry-run` and `bun pm pack --dry-run` agree with):

| Tarball | Files | Packed | Unpacked | The large files |
|---|---|---|---|---|
| `paged-media-paged-0.74.1.tgz` | 16 | 15.8 MB | 45.6 MB | `paged_canvas_wasm_bg.wasm` 28.8 MB, `introspect/paged_introspect_wasm_bg.wasm` 13.8 MB, `dist/paged.js` 1.5 MB, `repo/paged_repo_wasm_bg.wasm` 0.7 MB |
| `paged-media-viewer-0.74.1.tgz` | 21 | 4.6 MB | 11.7 MB | `wasm/paged_sdk_bg.wasm` 11.5 MB |
| `paged-media-plugin-sdk-0.74.1.tgz` | 62 | 0.3 MB | 1.3 MB | `dist/index.js` 0.6 MB, `dist/api/wire.d.ts` 0.2 MB |

## 0. Before anything: what is on the remote and on npm

Two releases have raced before. Check both, every time, before naming a version:

```sh
git fetch origin --tags
git ls-remote --tags origin 'v0.*' | grep -v '\^{}' | awk '{print $2}' | sed 's#refs/tags/##' | sort -V | tail -5
grep -oE 'ProtocolVersion\([0-9]+\)' engine/core/crates/paged-canvas/src/channel.rs | head -1
for p in paged viewer plugin-sdk; do
  printf '%s: ' "$p"; npm view "@paged-media/$p" dist-tags --json 2>/dev/null | tr -d ' \n' || printf '(not on npm)'; echo
done
node tooling/release/assert-dist-tags.mjs --audit   # read-only
```

On 2026-10-19 this showed: the tag `v0.74.0` exists (imported with the engine's history; nothing was
published from it), `PROTOCOL_VERSION` is 74, `@paged-media/paged` and `@paged-media/viewer` are not
on npm (both names free), and plugin-sdk's `latest` is June's `0.2.8-canary.0`. So the first release
from this repository is **`v0.74.1`**, unless the protocol or the tags have moved on by the time you
run this. Use the next free `v0.<protocol>.<patch>`.

## 1. The first release goes through a token

npm registers a Trusted Publisher for a package that exists, so the two new names cannot have one
before their first publish. The first release therefore authenticates with the `NPM_TOKEN`
repository secret, for all three packages:

1. On npmjs.com, as a member of the `paged-media` organization: **Access Tokens** → **Generate New
   Token** → **Granular Access Token**, with **Packages and scopes**: read and write, scope
   `@paged-media` (it covers the organization's packages and new ones under the scope), a short
   expiry (7 days is enough), and, if the account requires it, "bypass 2FA" for automation.
2. `gh secret set NPM_TOKEN -R paged-media/paged` and paste the token.

`release.yml`'s auth gate passes when trusted publishing is ready for all three packages, or else
when `NPM_TOKEN` authenticates (`npm whoami`); it fails before building when neither holds. Its step
"trusted publishing — readiness of the three packages" prints, for each package, whether npm's token
exchange accepts this run; for the first release it prints `NOT READY` for `paged` and `viewer`
(they do not exist yet), and the publish uses the token. npm tries OIDC first and falls back to the
token, so a plugin-sdk entry already registered does no harm.

## 2. Cut the release

On a commit of `main` that contains the restructure (amendment 3), with step 0 re-checked:

```sh
git fetch origin
git tag -a v0.74.1 origin/main -m "v0.74.1: the first release from paged-media/paged (PM-0008, amendment 3): @paged-media/paged (the engine with ./introspect and ./repo, and the paged bin with paged mcp), @paged-media/viewer (with ./session) and @paged-media/plugin-sdk (with the contract as ./api and the paged-plugin bin) at one version"
git push origin v0.74.1
gh run list -R paged-media/paged -w release.yml -L 3
gh run watch -R paged-media/paged <run id>
```

The run builds the engine wasm without a cache (about 20 to 30 minutes), checks the viewer subset,
builds plugin-sdk (with `./api` inlined), runs the CLI's `paged mcp` parity and bundle specs,
assembles `packages/paged`, stages and verifies the tarballs, installs them in a clean room under
Node and Bun (`tooling/release/consumer-test.sh`: every entry, both bins, `paged mcp` initialize and
tools/list, `paged-plugin init` and the plugin's own test, TypeScript 7 and 5.9 under `nodenext` and
`bundler`), keeps them as the `npm-tarballs-<version>` artifact, publishes with `--provenance
--access public` and asserts the dist-tags.

A run that stops after publishing some packages is finished by **re-running the same tag**
(`gh run rerun <run id>`, or `gh workflow run release.yml -R paged-media/paged --ref v0.74.1`);
packages already on npm are skipped. Never re-tag a version that is partly on npm.

Then check what npm serves:

```sh
for p in paged viewer plugin-sdk; do
  npm view "@paged-media/$p@0.74.1" version dist.attestations.provenance.predicateType
done
node tooling/release/assert-dist-tags.mjs 0.74.1 latest
npx -y @paged-media/paged@0.74.1 --version     # {"cli":"0.74.1","engine":"0.74.1"}
```

Each should print the version and a provenance predicate. A release to `latest` also moves the
stale `latest` of plugin-sdk (June's `0.2.8-canary.0`) to the release.

## 3. Trusted publishers, then retire the token

After the first release, for each of `@paged-media/paged`, `@paged-media/viewer` and
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
removed. Then delete the secret and revoke the token:

```sh
gh secret delete NPM_TOKEN -R paged-media/paged
```

and **Access Tokens** → revoke it on npmjs.com. The next release's readiness step prints `OK` for
all three; from then on trusted publishing is the only way in, and the auth gate fails a run whose
packages are not all ready. Optionally, set each package's **Publishing access** to require
two-factor authentication and disallow tokens.

## 4. Remove the leftover `canary` dist-tags

The canary lane is gone (PM-0008, amendment 1). After the first release:

```sh
npm dist-tag rm @paged-media/plugin-sdk canary
node tooling/release/assert-dist-tags.mjs --audit
```

npm refuses to delete a `latest` tag; that is why step 2 corrects plugin-sdk's `latest` by
publishing over it. The `canary` tags of the retired packages go with them (step 5).

## 5. Retire the other 22 packages

On 2026-10-19 the scope held 25 packages (with plugin-cli, which npm no longer serves, see below):
the four of wave D, `sdk`, `introspect-wasm`, `plugin-cli`, the seven bundles and eleven internal
packages. After the first release three are active: `plugin-sdk` (kept), `paged` and `viewer` (new).

### 5a. The six with a replacement: deprecate only, after the release

They have users and a successor, so they are never unpublished: deprecating keeps every version
installable and shows the message on install. Run after step 2, when the replacements are on npm,
logged in as an organization member with write access (`npm whoami`):

```sh
src="Source: https://github.com/paged-media/paged"
npm deprecate @paged-media/idml-viewer "Renamed: use @paged-media/viewer (same API), from 0.74.1. $src"
npm deprecate @paged-media/sdk "Use @paged-media/viewer/session (same API), from 0.74.1. $src"
npm deprecate @paged-media/canvas-wasm "Renamed: use @paged-media/paged (same entries: ./introspect, ./repo), from 0.74.1. $src"
npm deprecate @paged-media/introspect-wasm "Use @paged-media/paged/introspect (and ./introspect/catalog.json), from 0.74.1. $src"
npm deprecate @paged-media/plugin-api "Use @paged-media/plugin-sdk/api (type-only, the same contract), from 0.74.1; depend on @paged-media/plugin-sdk alone. $src"
npm deprecate @paged-media/plugin-cli "Use the paged-plugin bin of @paged-media/plugin-sdk, from 0.74.1. $src"
for p in idml-viewer sdk canvas-wasm introspect-wasm plugin-api plugin-cli; do
  printf '%s: ' "$p"; npm view "@paged-media/$p" deprecated
done
```

`@paged-media/plugin-cli` answered 404 to an anonymous `npm view` on 2026-10-19 (the inventory of
2026-10-18 listed 7 versions): it may have been unpublished, or be restricted. Logged in, `npm view
@paged-media/plugin-cli` says which; if npm has nothing, skip its line. Remove the old `canary`
dist-tags where they still point somewhere (`npm dist-tag rm @paged-media/idml-viewer canary`, and
the same for `plugin-api`).

### 5b. The 18 without one (the 7 bundles and 11 internal packages): unpublish where npm allows it

The bundles are built into the editor and the internal packages were only ever their dependencies;
nothing outside this repository is meant to install them. Two paths:

**Recommended: `npm unpublish`, where npm's policy allows it.** npm lets an owner unpublish a whole
package published more than 72 hours ago only if **no other public package depends on it**, it had
**fewer than 300 downloads in the last week**, and it has **a single owner**.
**Unpublishing is permanent:** the versions cannot be restored, and the name cannot be published
again for 24 hours (and never at a version that existed). Run the read-only pre-check first, and
again right before unpublishing:

```sh
node tooling/release/retire-precheck.mjs          # or --json
# the organization's grants per package (the owner's login, read-only):
for p in data draw image pdf publish sheet web data-bundle draw-bundle image-glue sheet-bundle web-bundle \
         data-host-model draw-geometry draw-tools image-manifest sheet-host-model web-model; do
  echo "== @paged-media/$p"; npm view "@paged-media/$p" maintainers; npm access list collaborators "@paged-media/$p"
done
```

What it showed on 2026-10-19 (registry and download API, anonymous; dependents are those within
the scope, in any published version):

| Package | Versions | Downloads last week | Maintainers | Depended on by (in the scope) | Unpublish |
|---|---|---|---|---|---|
| `data` | 18 | 603 | dietz | — | not now: ≥ 300 downloads |
| `draw` | 21 | 232 | dietz | — | allowed |
| `image` | 22 | 178 | dietz | — | allowed |
| `pdf` | 7 | 174 | dietz | — | allowed |
| `publish` | 1 | 174 | dietz | — | allowed |
| `sheet` | 21 | 734 | dietz | — | not now: ≥ 300 downloads |
| `web` | 19 | 469 | dietz | — | not now: ≥ 300 downloads |
| `data-bundle` | 1 | 1 | dietz | — | allowed |
| `draw-bundle` | 1 | 0 | dietz | — | allowed |
| `image-glue` | 1 | 0 | dietz | — | allowed |
| `sheet-bundle` | 1 | 0 | dietz | — | allowed |
| `web-bundle` | 1 | 1 | dietz | — | allowed |
| `draw-tools` | 1 | 4 | dietz | `draw-bundle` | after `draw-bundle` |
| `data-host-model` | 1 | 0 | dietz | `data-bundle` | after `data-bundle` |
| `draw-geometry` | 1 | 4 | dietz | `draw-bundle`, `draw-tools` | after both |
| `image-manifest` | 1 | 1 | dietz | `image-glue` | after `image-glue` |
| `sheet-host-model` | 1 | 1 | dietz | `sheet-bundle` | after `sheet-bundle` |
| `web-model` | 1 | 1 | dietz | `web-bundle` | after `web-bundle` |

The npm maintainer list names one account; for an organization package npm also counts the teams
with write access, which `npm access list collaborators` shows (it needs the owner's login: an
anonymous run gets E401). Dependents outside the scope are not visible from the registry API: each
package's **Dependents** tab on npmjs.com says; it must be empty. The download counts of a week
change: `data`, `sheet` and `web` may fall under 300 later (re-run the pre-check), or take the
fallback.

The order is **dependents before their dependencies**, so each one's dependents are gone when it is
unpublished:

```sh
# 1. the bundles and their earlier names (nothing depends on them)
for p in draw image pdf publish data-bundle draw-bundle image-glue sheet-bundle web-bundle; do
  npm unpublish "@paged-media/$p" --force
done
# 2. what only the bundles depended on
npm unpublish @paged-media/draw-tools --force
for p in data-host-model draw-geometry image-manifest sheet-host-model web-model; do
  npm unpublish "@paged-media/$p" --force
done
# 3. data, sheet and web, only when the pre-check says their downloads allow it
#    (otherwise: the fallback below)
for p in draw image pdf publish data-bundle draw-bundle image-glue sheet-bundle web-bundle \
         draw-tools data-host-model draw-geometry image-manifest sheet-host-model web-model; do
  printf '%s: ' "$p"; npm view "@paged-media/$p" version 2>&1 | tail -1
done   # each: a 404
```

`--force` is how npm takes a whole package; npm itself refuses a package its policy does not allow,
and says why.

**Fallback: `npm deprecate`**, for any of the 18 npm will not unpublish (on 2026-10-19: `data`,
`sheet` and `web`) or the owner prefers to keep:

```sh
src="Source: https://github.com/paged-media/paged"
moved="Built into the paged editor; no longer published separately. $src"
for p in data draw image pdf publish sheet web; do
  npm deprecate "@paged-media/$p" "$moved"
done
for p in data-bundle draw-bundle image-glue sheet-bundle web-bundle \
         data-host-model draw-geometry draw-tools image-manifest sheet-host-model web-model; do
  npm deprecate "@paged-media/$p" "$moved"
done
```

Check: `npm view @paged-media/<p> deprecated` prints the message. `@paged-media/repo-wasm` was never
published, and `doc`, `slide`, `client`, `ai` and `cli` never were either; there is nothing to do
for them.

## 6. Later releases

1. Step 0: the remote's tags, `PROTOCOL_VERSION` and npm's versions.
2. `git tag -a v0.<protocol>.<patch> <commit on main> -m "<what changed>"` and
   `git push origin v0.<protocol>.<patch>`.
3. Watch the run; re-run the tag to finish a partial release.

A protocol bump on `main` needs its tag in the same push (core-ci's `protocol-tag-guard`), so the
first release of a protocol is `v0.<new protocol>.0`.

## 7. Consumers outside this repository (wave E, after the release)

None of these is changed by the repository; each needs its own change once `0.74.1` is on npm.

**The documentation site (docs.paged.media)**

- `package.json`: `@paged-media/idml-viewer` `0.73.4` → `@paged-media/viewer` `0.74.1`; every
  import of `@paged-media/idml-viewer` → `@paged-media/viewer`.
- `scripts/prepare-preview-wasm.mjs`: resolve `@paged-media/viewer/session` (the package exports
  `./package.json` and keeps `wasm/paged_sdk*`), not `idml-viewer/dist`.
- `content/docs/paged/sdk/index.mdx`, `sdk/api-reference.mdx`, `sdk/viewer-session.mdx`,
  `sdk/embedding-guide.mdx`: `@paged-media/sdk` → `@paged-media/viewer/session`,
  `@paged-media/idml-viewer` → `@paged-media/viewer`, `@paged-media/introspect-wasm` and
  `@paged-media/canvas-wasm/introspect` → `@paged-media/paged/introspect`,
  `@paged-media/canvas-wasm` → `@paged-media/paged`; `scripts/generate/sdk-catalog.seed.json` and
  `gen-sdk.mjs` follow the viewer's `api-catalog.json`, whose `package` is now
  `@paged-media/viewer` and whose Inspector section names `@paged-media/paged/introspect`.
- `content/docs/paged/plugin-sdk/index.mdx` and the plugin tutorial pages: drop the
  `@paged-media/plugin-cli` and `@paged-media/plugin-api` rows; types come from
  `@paged-media/plugin-sdk/api`, values from `@paged-media/plugin-sdk`; the install line is
  `npm install -D @paged-media/plugin-sdk` (and the peer `@paged-media/plugin-sdk`), the scaffold
  `npx -p @paged-media/plugin-sdk paged-plugin init my-plugin`, the check `npx paged-plugin validate
  src/manifest.json`.
- A page for the `paged` command and `paged mcp` (`npx @paged-media/paged mcp`, the Claude Desktop
  / Claude Code entry), next to the Rust CLI's.
- `content/docs/paged/plugins/template.mdx`, `plugins/publish.mdx`: no canary packages; built-in
  modules are not on npm.
- `content/docs/paged/repos/*.mdx`, `architecture.mdx`, `engine/the-renderer/index.mdx`,
  `engine/the-renderer/rendering-backends.mdx`: the engine ships as `@paged-media/paged` and
  `@paged-media/viewer`, from `paged-media/paged`; the editor takes them from the workspace.
- `core.pin` and the other `sources.pin` entries point at `paged-media/paged`.

**The paged.media website**

- `apps/site/src/site/Developers.tsx`: the viewer card `npm install @paged-media/viewer`; the plugin
  card `npm install -D @paged-media/plugin-sdk` and `paged-plugin init`; an engine/CLI card for
  `@paged-media/paged` (`npx @paged-media/paged mcp`); name `@paged-media/viewer/session` where the
  low-level session is meant.
- `apps/site/scripts/fetch-site-data.mjs`: the `PLUGINS` map names each module's npm bundle
  (`@paged-media/draw`, …); those are retired, so the plugin pages say "built into the editor"
  instead of naming a package (and `released` no longer means "on npm").

**The plugin template** (or replace it by `paged-plugin init`)

- `package.json`: remove `@paged-media/plugin-cli` and `@paged-media/plugin-api`; one peer,
  `"@paged-media/plugin-sdk": ">=0.74.1"`, and `"^0.74.1"` in devDependencies.
- `src/index.ts`, `test/activate.spec.ts`: `import type … from "@paged-media/plugin-sdk/api"`;
  the test can use the SDK's `createFakeEditor`, `mapBacking` and `silentConsole`.
- `.github/workflows/ci.yml`: the "report resolved canary versions" step names plugin-sdk only;
  the job floats on `latest`, not `canary`.
- `README.md`, `docs/README.md`: the same.

**The feature registry's public export (`exports/public.json`)**

- Notes name `@paged-media/introspect-wasm` (the catalog source), `plugin-cli` (the manifest
  validator) and `plugin-api`; regenerate after the registry's feature files say
  `@paged-media/paged/introspect`, "the `paged-plugin` bin of plugin-sdk" and
  `@paged-media/plugin-sdk/api`. The template row's "canary" dependency note changes with the
  template.

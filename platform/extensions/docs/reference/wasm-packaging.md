# Plugin-shipped WebAssembly — packaging, capability, budgets

**2026-06-07 · status: DESIGN + minimal implementation in this repo ·
closes paged.web `BREAKAGE_LOG` W-07 (PARTIAL — editor serving wiring is
the residual).**

This is the deliberation record for how a Paged plugin **bundles and
ships its own WebAssembly module** through the plugin packaging pipeline.
The motivating consumer is paged.web's future HTML/CSS layout engine (a
Blitz-class renderer compiled to wasm — concept §9.1.3), but the contract
is content-neutral: any bundle may ship a `codec` or a pure `compute`
module under the same rules.

When this document and the code (`plugin-api/src/manifest.ts`,
`plugin-cli/bin/paged-plugin.mjs`, `plugin-sdk/src/wasm-bundle-loader.ts`)
disagree, fix one of them in the same change — the same rule DESIGN.md
carries.

---

## 1. The shape: a declared, budgeted manifest capability

A bundle declares every wasm module it intends to load under
`capabilities.wasm`. This is **not** a contribution (it registers nothing
in a shell registry) — it is a *capability*, so it lives beside
`document` / `rendering` / `network` / `clipboard`, the existing closed
vocabulary the host reasons about and (eventually) grants.

```jsonc
{
  "id": "media.paged.web",
  // …
  "capabilities": {
    "wasm": [
      {
        "name": "layout",            // logical handle for the loader
        "path": "engine/layout.wasm", // bundle-relative; no "/", no ".."
        "purpose": "layout",         // closed vocabulary (gates the grant)
        "maxBytes": 4194304,         // optional self-imposed ceiling (≤ host hard cap)
        "integrity": "sha384-…"      // optional; stamped at build time (§7)
      }
    ]
  }
}
```

Why a manifest **field** and not a `wasm.load@1` *capability string* (the
`host.supports()` form): `supports()` answers "can the host do X at
runtime"; this answers "what does the bundle SHIP". The two are different
questions (DESIGN tenet 6). The artifacts must be *enumerable from the
manifest alone* — the CLI validates them, the packager will checksum
them, and the loader enforces **declared-only** access against them — so
they belong in the static manifest, not behind a runtime probe. The host
*grant* (below) is the runtime gate; `host.supports("wasm.load@1")` can be
added later as the "does this host serve wasm at all" probe without
changing the manifest shape.

### `purpose` — a closed vocabulary

`layout | codec | compute | engine`. Closed (like `rendering`) so the
host can reason about what role a module plays before granting it — a
`layout` engine and a `compute` blob warrant different scrutiny and,
later, different host services. `engine` (D-07b) marks a vendored
data/query/DB engine whose release artifact legitimately exceeds the
100 MB app-wide ceiling (DuckDB-WASM ≈ 36 MiB; paged.data) — it earns the
**higher 64 MiB per-artifact ceiling** and is otherwise an ordinary
declared+budgeted module. Unknown purposes are **rejected at
validation**: a bundle cannot smuggle an unmodelled role past the gate.

- `layout` — a foreign-document layout/measure engine (paged.web's lane).
- `codec` — encode/decode (image, font transforms).
- `compute` — generic pure computation, no special host role.

---

## 2. Load mechanics in the sandboxed runtime

`@paged-media/plugin-sdk` exposes the host-side door:

```ts
loadBundleWasm(bundle, "layout", {
  assetSource,            // (path) => bytes — the bundle's asset base
  grant: "*" | Set<name>, // the host grant (ABSENT = refuse)
  imports?,               // exactly what the caller passes; nothing implicit
  provideMemory?,         // host owns a bounded, NON-shared memory (default)
}) => { module, instance, memory, byteLength, artifact }
```

The sequence:

1. **Resolve from the manifest.** The `name` must appear in
   `capabilities.wasm`. An undeclared name is refused — *declared-only* is
   the contract; the loader never loads a module the manifest didn't
   enumerate.
2. **Check the host grant.** Wasm is opt-in: with no grant the load is
   refused. This is the capability gate — the host decides, per bundle,
   which declared artifacts may instantiate (a UI can surface it the way
   "this plugin uses the network" is surfaced). The grant keys off the
   manifest declaration, so the user-facing prompt can name the `purpose`.
3. **Fetch through the bundle's asset base.** The host injects an
   `assetSource(path)` rooted at the bundle's asset root — a URL fetch in
   the browser (`new URL(path, bundleAssetBase)` → `fetch`), a file read
   in Node/tests. The loader passes **only the declared `path`**; it never
   composes a URL itself, so there is no path the bundle didn't declare.
   In the browser the production door is `WebAssembly.instantiateStreaming`
   over that fetch; the headless/Node door (and this v1 loader) reads bytes
   then `WebAssembly.compile` + `instantiate` — same budget gates.
4. **Budget gate** (§3).
5. **Instantiate with no ambient authority** (§4).

SharedArrayBuffer / threads are **OFF in v1**: the host-owned memory is
non-shared, and the loader never sets `shared: true`. (Cross-origin
isolation + a threads story is a later milestone.)

---

## 3. Budget rules (v1 numbers, with rationale)

| Budget | v1 value | Why |
|---|---|---|
| **App-wide wasm ceiling** | **100 MB** (whole editor + every plugin) | **THE budget since 2026-08-19** (maintainer decision). Every earlier ceiling was per-thing — one artifact, one bundle — so eight bundles could each pass their own gate while the app shipped a quarter of a gigabyte, and nothing in any repo measured the sum. What a user downloads is the sum. Enforced where the app is assembled: the editor's `scripts/wasm-budget.mjs`, run in its `checks` CI job, since only the app knows which bundles ship. It deduplicates **by real path** — pnpm links one store entry from many packages and a naive walk over-counts nearly 6x (286 MB reported for an app carrying 49). Measured 2026-08-19: **49.4 MB across 9 distinct artifacts**, ~50 MB headroom. |
| **Per-artifact byte ceiling** | **100 MB** — folded into the envelope | Was 8 MiB, briefly 25. A single artifact stopped being independently interesting once the sum is bounded, so this is now a hard upper stop rather than a policy: it keeps a manifest `maxBytes` something to **tighten**, and keeps the loader refusing an absurd module. The `purpose: "engine"` distinction (D-07b) survives for governance and telemetry, no longer for size. |
| **Total bundle wasm ceiling** | **100 MB** | Same number: one bundle may in principle spend the whole envelope. The app-wide check is what stops the app. |
| **Load-time budget** | **3000 ms** | Wall-clock for fetch + compile + instantiate. Protects the editor's main flow from a pathological module; the loader aborts with a clear stage-tagged error rather than hanging the host. |
| **Memory-growth ceiling** | **256 MiB** (4096 × 64 KiB pages) | Passed as `WebAssembly.Memory({ maximum })` when the host owns memory. A per-page layout pass should sit far under this; the cap turns "runaway `memory.grow`" into a trapped failure, not an OOM of the tab. |

These are **v1, deliberately conservative** — generous enough for the
first real layout engine, tight enough that the failure mode of a
mis-built or hostile bundle is a *clean rejection*, not a degraded
editor. They are revisited when a real engine measures against them
(that measurement is the residual the W0 spike produces). The numbers
live in exactly three places, kept in lockstep by comment:
`WASM_BUDGETS` (loader), `WASM_MAX_*` (CLI), and the schema's `maxBytes`
maximum.

---

## 4. The trust line: wasm gets NO ambient authority

The keystone. A loaded module is handed **only the imports the caller
passes**. The loader adds nothing implicitly except, optionally, a
host-owned bounded `WebAssembly.Memory` (when `provideMemory` and the
imports omit one). There is:

- **no implicit engine handle** — the wasm cannot call `mutate`,
  `hitTest`, or any `BundleHost` door;
- **no DOM, no network, no filesystem** — none are in the import object;
- **no `host.editor` reach** — that escape hatch is JS-side only.

The module therefore has exactly the authority the **bundle's JS** gives
it by wiring exports/imports — and that JS is *already* gated (namespace
rule, capability manifest, the facade surface). The wasm is strictly
*downstream* of the bundle's own sandbox: it can compute and hand results
back to the JS, which then goes through the same gated doors every other
bundle uses. Adding a wasm module grants the plugin **zero** new reach
into the host.

This is what makes the capability cheap to grant: "ship a wasm blob" is a
size/compute concern, not a privilege-escalation one.

---

## 5. Non-goals (v1)

- **No native plugins.** wasm only; no `.node`/dylib loading, ever.
- **No wasm-side direct engine access.** The module never gets a
  `BundleHost`/`CanvasClient`/`PagedEditor` handle. If a future engine
  wants a fast path to the document, that is a *new, separately-designed,
  separately-budgeted* host import — not an implicit grant.
- **No threads / SharedArrayBuffer.** Non-shared memory only.
- **No host-served fetch path the bundle didn't declare.** The loader
  resolves strictly the declared `path` through the injected asset base,
  and the module door (§7) resolves strictly a declared `name`.

---

## 6. What's implemented here vs design-only

**Implemented (minimal, tested headlessly):**

- `capabilities.wasm` manifest field + `WasmArtifact` / `WasmPurpose`
  types (`plugin-api`, additive).
- Schema + CLI validation: unknown purpose, path-traversal, over-budget
  `maxBytes`, unknown artifact key, and a present-file-over-ceiling check
  are all rejected; a valid declaration passes.
- `loadBundleWasm(bundle, name, opts)` in `plugin-sdk`: declared-only
  enforcement, host-grant gate, per-artifact + manifest `maxBytes` budget,
  load-time budget, host-owned non-shared memory with the page ceiling,
  no-ambient-authority instantiation. Tested against a hand-assembled wasm
  fixture (an `add` module importing `env.memory`, plus the 8-byte empty
  module) — no browser, no editor.

**Design-only (residuals):**

- **Editor-side serving wiring.** The editor must (a) provide the
  `assetSource` rooted at each bundle's asset base, (b) decide/surface the
  **grant** (probably auto-grant first-party, prompt third-party), and
  (c) use `instantiateStreaming` over the bundle URL in the browser path.
  `loadBundleWasm` is the door; the editor wiring is the open work.
- **Packager checksums.** DONE 2026-10-11 (§7): `paged-plugin integrity`
  stamps sha384 into each declared artifact and `validate` fails a stamp
  that does not match the file. There is still no single `package` step;
  each plugin's publish workflow runs `integrity` before it packs.
- **Real-engine budget calibration.** The v1 numbers are pre-measurement;
  the W0 Blitz/wasm spike re-tunes them.
- **`wasm.load@1` supports() probe** — superseded for the "where do I
  load it from" question by `modules@1` (§7); `loadBundleWasm`'s
  `assetSource` does not consult the module door yet (no caller loads
  through `loadBundleWasm` today).

---

## Two loaders, ratified (2026-06-09 — closes paged.sheet S-10 / paged.image I-07)

There are **two** sanctioned ways a bundle runs its own wasm, and which
one applies is decided by the module's *shape*, not by preference:

1. **Raw module → `host.loadBundleWasm`.** A hand-built / Blitz-class
   module with no JS glue (host-owned memory, only caller-passed imports,
   no ambient authority). This is the door `wasm-bundle-loader.ts`
   implements and everything above describes.

2. **wasm-bindgen module → the bundle's own JS glue (the canvas-wasm
   pattern).** A module produced by `wasm-bindgen --target web` (its
   `__wbindgen_*` imports, its own exported memory, its generated
   `.js`) **cannot** load through door (1) — the raw instantiation has
   none of that glue. It is instead loaded by the bundle itself, in the
   bundle's JS realm, by `import init, { … } from "./<name>.js"; await
   init(url)` — exactly how `@paged-media/sdk` / `idml-viewer` boot, and
   how `plugin-sheets`' `sheet-js` engine boots
   (`packages/sheet-bundle/src/engine.ts` `bootEngine`).

   The module is **still declared** under `capabilities.wasm[]` — the
   declaration is governance + the plugin-cli size gate, NOT the
   loader. `paged-sheet` (S-10) and `paged-image` (I-07) both ship this
   way. **This is the v1 contract**: there is no host-side wasm-bindgen
   loader and none is needed; the glue path is the answer. (If a future
   host *wants* to own wasm-bindgen instantiation — e.g. to share a
   `GPUDevice` import — that is the separate I-01/I-07 GPU-surface RFC,
   not this door.)

---

## 7. Resolved through the host: the module door (ADR 326, 2026-10-11)

A bundle used to load its wasm from a URL next to its own code (Vite
`?url`, `new URL("../bin/x.wasm", import.meta.url)`). The editor's deploy
then had to carry every module (Cloudflare Pages refuses files over
25 MiB) and every site cached its own copy. Editor ADR 220 moved the
modules to a first-party **module host**,
`https://modules.paged.media/<package>/<version>/<path in package>` —
immutable per version, `Content-Encoding: br`, `application/wasm`, a
year's immutable cache, CORS `*` — and redirected the old URLs to it.
This section is the contract that lets a bundle ask for the module
directly, like a shared library resolved by the loader.

**The door.** `host.modules.resolve(name)` answers a DECLARED
`capabilities.wasm` artifact with `{ url, integrity, artifact }`, or
`null` when the host does not serve it; `url(name)` and `fetch(name)`
are the two shorthands (`fetch` passes `{ integrity }`). An undeclared
name is refused (the capability gate; in `warn` mode it logs and answers
`null`). `supports("modules@1")` is true when the host wired a
`ModulesBackend`; without one every answer is `null`.

**The backend** (`CreateBundleHostOptions.modules`) is
`{ url(pluginId, artifact) → { url, integrity? } | null }`. It receives
the manifest's artifact, never a path the bundle typed. The editor answers
from a build-time module manifest (the declared artifacts of every
installed `@paged-media/*` bundle, hashed) and, in a deployed build,
points at the module host; in dev it answers `null`.

**Integrity.** The manifest's own `integrity` wins: the bundle vouches
for its bytes, wherever they are served. A host answer with a different
digest of the same algorithm is refused (logged, `null`), so a stale host
manifest cannot swap bytes silently; the bundle loads its own copy. SRI
is checked over the DECODED body, so brotli on the wire is fine. Stamp at
build time, after the wasm is built and before the bundle is packed:

```sh
paged-plugin integrity packages/<bundle>        # writes "integrity": "sha384-…"
paged-plugin integrity packages/<bundle> --check  # CI: fail on a missing/stale stamp
```

Stamp the PUBLISHED manifest only (in the publish job); a committed stamp
goes stale with every wasm rebuild, and `validate` fails a stale stamp.
Note that `plugin-cli` ≤ 0.1.5 rejects the `integrity` key as unknown;
validate a stamped manifest with 0.1.6 or later. The runtime (any
plugin-sdk) ignores keys it does not know.

**Bundle side.** `resolveWasm(host, name, fallbackUrl)` →
`{ url, integrity, source: "host" | "bundle" }`, `resolveWasmUrl(...)`,
and `fetchWasm(...)` → `Response` (fetched with the integrity when
known). They never reject on the host path: no door, an undeclared name
or a throwing backend all fall back to `fallbackUrl` — the URL the bundle
used before — with the manifest's stamp. A bundle whose plugin-sdk PEER
floor predates these exports inlines the same probe instead of importing
them (they would be a missing export on an older host):

```ts
const door = (host as { modules?: { resolve?(n: string): Promise<{ url: string; integrity: string | null } | null> } }).modules;
const hosted = host.supports("modules@1") && typeof door?.resolve === "function"
  ? await door.resolve(name).catch(() => null)
  : null;
const url = hosted?.url ?? bundleRelativeUrl;
```

Two shapes of consumer:

- **wasm-bindgen glue** takes a `Response`: `await init({ module_or_path:
  fetchWasm(host, "engine", new URL("../bin/x_bg.wasm", import.meta.url)) })`
  — streaming compile, with SRI.
- **An engine that fetches inside its own worker** (DuckDB-WASM's
  `instantiate(url)`) takes the URL only, so the integrity cannot reach
  that fetch. The worker SCRIPT stays same-origin (a cross-origin `Worker`
  is a SecurityError); only the wasm URL comes from the host.

**Uploading.** `paged-plugin modules-upload <bundle-dir>` puts each
declared artifact at `paged-modules/<package>/<version>/<path in package>`
(R2, via `npx wrangler@3 r2 object put`), brotli quality 10, with the
headers above. It HEADs first and skips what is hosted; without
`CLOUDFLARE_API_TOKEN` (and `CLOUDFLARE_ACCOUNT_ID`) it reports what is
missing and exits 0, so a publish workflow can carry the step before the
repo has the secret. `--dry-run` uploads nothing. `PAGED_MODULE_HOST` /
`PAGED_MODULE_BUCKET` override the host and bucket. A version is
immutable: upload after `npm publish` succeeded, never for a version that
is not on npm.

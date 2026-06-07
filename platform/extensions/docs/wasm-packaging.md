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
        "maxBytes": 4194304          // optional self-imposed ceiling (≤ host hard cap)
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

`layout | codec | compute`. Closed (like `rendering`) so the host can
reason about what role a module plays before granting it — a `layout`
engine and a `compute` blob warrant different scrutiny and, later,
different host services. Unknown purposes are **rejected at validation**:
a bundle cannot smuggle an unmodelled role past the gate.

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
| **Per-artifact byte ceiling** | **8 MiB** | A release-optimised wasm layout engine (Blitz-class, `-O`/`wasm-opt`) lands in the low single-digit MiB. 8 MiB fits one real engine with headroom while **rejecting an accidentally-bundled debug build** (tens of MiB) — the most common foot-gun. A manifest `maxBytes` may only **tighten** this; the loader enforces the stricter of the two. |
| **Total bundle wasm ceiling** | **16 MiB** | Sum across all declared artifacts. Bounds a bundle that ships several modules (engine + a codec). |
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
  resolves strictly the declared `path` through the injected asset base.

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
- **Packager checksums.** The `paged-plugin package` step (future) should
  hash each declared artifact into the bundle manifest; validation today
  checks size/shape, not integrity.
- **Real-engine budget calibration.** The v1 numbers are pre-measurement;
  the W0 Blitz/wasm spike re-tunes them.
- **`wasm.load@1` supports() probe** — add when a host needs to advertise
  "I serve wasm" without inspecting the manifest.

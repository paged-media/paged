# ADR 308 — Plugin wasm is a declared capability, loaded by the bundle, under one app-wide size budget

- **Status:** Accepted. Recorded retroactively on 2026-10-02 from the code at `d90f727`.
- **Scope:** `capabilities.wasm` in `packages/plugin-api`, its checks in `packages/plugin-cli`,
  `packages/plugin-sdk/src/wasm-bundle-loader.ts`, `docs/reference/wasm-packaging.md`

## Context

Seven of the eight shipped bundles carry a WebAssembly module. `docs/reference/wasm-packaging.md`
(2026-06-07) set the first shape: a manifest declaration, because the artifacts must be
"enumerable from the manifest alone", plus a host-side loader for a raw module,
`loadBundleWasm`. A module built by `wasm-bindgen --target web` needs its generated
JavaScript, which that loader does not supply, so on 2026-06-09 the document ratified a
second path.

Size was first capped per artifact and per bundle. Commit `93e7509` (2026-08-19) replaced
that: "What a user downloads is the sum, so the sum is what is governed".

## Decision

A bundle declares every wasm module it ships under `capabilities.wasm` and loads it with
its own glue in its own realm. The size limit is one number for the whole application,
100 MB, checked where the application is assembled.

- **Declaration.** Each entry has `name`, a bundle-relative `path` ending in `.wasm` with no
  leading slash and no `..`, a `purpose` from `layout | codec | compute | engine`, and an
  optional `maxBytes` of at most 100 000 000. `paged-plugin validate` repeats these checks,
  rejects a duplicate name, and measures the files that are present.
- **Loading, as the contract describes it.** `loadBundleWasm` refuses an undeclared name
  and a name the host did not grant, applies the byte ceiling and a 3000 ms load-time
  budget, and instantiates with only the caller's imports and, by default, a non-shared
  memory capped at 4096 pages.
- **Loading, as the bundles do it.** No shipped bundle calls `loadBundleWasm`, and the
  editor does not reference it. All seven import their `wasm-bindgen` glue with a relative
  dynamic `import()` and let it instantiate the module in the bundle's realm: from a bundler
  `?url` asset in six of them, by the glue's own fetch in plugin-data. The document calls
  this "the v1 contract"; the declaration "is governance + the plugin-cli size gate, NOT
  the loader".
- **Budget.** The editor's budget script sums every `.wasm` file reachable under the
  canvas app's `node_modules/@paged-media`, counted once per real path, and exits 1 above
  100 MB. It runs in the editor's `checks` CI job.

## Evidence

- `packages/plugin-api/src/manifest.schema.json:196-233`,
  `packages/plugin-cli/bin/paged-plugin.mjs:310-397` — the artifact schema; the mirrored checks
- `packages/plugin-sdk/src/wasm-bundle-loader.ts:44-86`, `:162-247` — `WASM_BUDGETS`; the
  loader (refusals at `:169-182`, ceiling at `:208-221`, memory at `:224-238`)
- `docs/reference/wasm-packaging.md:46-55`, `:208-235` — why a manifest field; the two load paths
- `plugin-sheets: packages/sheet-bundle/src/engine.ts:26-36`, `plugin-image: glue/src/engine.ts:25-36`,
  `plugin-draw: packages/draw-bundle/src/trace-engine.ts:35-42`,
  `plugin-data: packages/data-bundle/src/engine.ts:19-24`, `:120-139`,
  `plugin-doc: packages/doc-bundle/src/engine.ts:24-29` — each states that it does not use
  `loadBundleWasm`; plugin-data's boot
- `plugin-web: packages/web-bundle/src/engine-loader.ts:129-142`,
  `plugin-publish: packages/pdf-bundle/src/engine-loader.ts:73-86` — the glue-and-`?url` load
- `editor: scripts/wasm-budget.mjs:47`, `:79-120`, `:198-206`;
  `editor: .github/workflows/tests.yml:139-144` — the app-wide sum and where it runs

## Alternatives considered

A `wasm.load@1` capability string in place of the manifest field: the document keeps it
as a probe that "can be added later". A host-side `wasm-bindgen` loader: "there is no
host-side wasm-bindgen loader and none is needed" (`docs/reference/wasm-packaging.md:231-232`).

## Consequences

The grant, declared-only access, the load-time budget, the memory ceiling and the
caller-only imports belong to `loadBundleWasm`, which has no caller outside this repo's
tests. A glue-loaded module runs in the bundle's realm; plugin-image chose that path
because there "WebGPU is reachable".

Nothing compares what a bundle loads with what it declares. The PDF bundle loads
`bin/pdfium.esm.wasm`, and its manifest lists only `pdf-import`
(`plugin-publish: packages/pdf-bundle/src/pdfium.ts:86`,
`plugin-publish: packages/pdf-bundle/manifest.json:9-16`). plugin-data declares
`duckdb-engine` at one path as "the GOVERNANCE anchor" and at run time picks one of three
files from a vendored directory (`plugin-data: packages/data-bundle/src/query/duckdb.ts:29-35`, `:78-91`).

The 100 MB number is repeated, not shared: the editor script defines its own constant and
counts files, not declarations; nothing reads `WASM_BUDGETS.maxAppTotalBytes`.
Comments contradict the code: `docs/reference/wasm-packaging.md:62-66` and
`packages/plugin-api/src/manifest.ts:294-300` still say `engine` earns a higher ceiling;
in the code every ceiling is 100 MB. The document names the loader `host.loadBundleWasm`
(`:213`); it is an export of plugin-sdk, not a `BundleHost` member.

## Related

- [ADR 303](303-manifest-schema.md), [ADR 314](314-plugin-shape.md), [ADR 318](318-host-spawned-workers.md) — the manifest schema; one wasm module behind a thin bundle; the other declared compute capability
- [ADR 015](https://github.com/paged-media/plugin-data/blob/main/docs/adr/015-duckdb-wasm-vendored.md), [ADR 655](https://github.com/paged-media/plugin-publish/blob/main/docs/adr/655-pdfium-reader.md) — the two vendored engines named above

# ADR 326 — A bundle resolves its wasm through the host, with integrity

- **Status:** Accepted, 2026-10-11.
- **Scope:** `WasmArtifact.integrity` and `host.modules` in `packages/plugin-api`; the
  `modules` host option, `ModulesBackend` and `resolveWasm` / `resolveWasmUrl` / `fetchWasm`
  in `packages/plugin-sdk`; `paged-plugin integrity` and `paged-plugin modules-upload` in
  `packages/plugin-cli`.

## Context

Editor ADR 220 put the wasm modules on a first-party module host,
`https://modules.paged.media/<package>/<version>/<path in package>`: immutable per version,
brotli, cached for a year and shared across sites. The editor's deploy reaches it through
same-origin 302s, because every bundle still fetches a URL next to its own code. Nothing
checked the bytes, and a bundle had no way to ask the host where a module lives.

## Decision

The host resolves a bundle's declared wasm, and the bundle vouches for the bytes.

- **Door.** `host.modules.resolve(name)` answers a name declared in `capabilities.wasm`
  with `{ url, integrity, artifact }` or `null`; `url` and `fetch` are shorthands, and
  `fetch` passes `{ integrity }`. An undeclared name is refused. `supports("modules@1")` is
  true when the host injects a `ModulesBackend`, which is handed the manifest's artifact.
- **Integrity.** `WasmArtifact.integrity` is optional SRI (`sha384-…`). The manifest's
  stamp wins; a host answer with a different digest of the same algorithm is refused.
  `paged-plugin integrity` stamps it when the bundle is built for publishing, and
  `validate` fails a stamp that does not match the file.
- **Fallback.** `null` means "load your own copy". The SDK helpers take the old
  bundle-relative URL and fall back to it on any host-side failure, so a bundle works on
  hosts with and without the door.
- **Upload.** `paged-plugin modules-upload` puts a package's declared artifacts on the
  module host after it is published, skipping what is there and skipping cleanly without
  `CLOUDFLARE_API_TOKEN`.

## Consequences

- An editor answers from a build-time module manifest and may stop redirecting modules
  whose bundles adopt the door.
- A bundle that runs on hosts older than plugin-sdk 0.2.51 inlines the probe rather than
  importing the helpers; paged.data does.
- An engine that fetches inside its own worker (DuckDB-WASM) receives a URL only, so SRI
  does not reach that fetch.
- `plugin-cli` 0.1.5 and older reject the `integrity` key; stamped manifests are validated
  with 0.1.6 or later.

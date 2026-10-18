# ADR 309 — Conformance runs against the real published engine

- **Status:** Accepted. Recorded retroactively on 2026-10-02 from the code at `d90f727`.
- **Scope:** `packages/plugin-sdk/src/harness.ts` (`createHeadlessHost`) and
  `packages/plugin-sdk/src/wasm-loader.ts` (`loadHeadlessEngine`)

## Context

Testing a bundle needs a host. This repo tests its own adapter against a fake editor
(`packages/plugin-sdk/test/fake-editor.ts`), which scripts the replies a bundle would get.
For bundles, the harness was first a reserved member that threw. Commit `4587e0d`
(2026-06-07) replaced it. The reason is in the function's own comment: "the harness now
stands on a real engine, so a bundle can no longer "pass against fiction""
(`packages/plugin-sdk/src/harness.ts:523-525`). `DESIGN.md:614-635` says the same: "NOT a
mock".

## Decision

`createHeadlessHost` boots the published `@paged-media/canvas-wasm` in Node and puts the
ordinary `createBundleHost` adapter on top of it. The document side is answered by the
engine; the contribution side is recorded; a host with no engine behind it is refused.

- **Boot.** The loader resolves the installed package, reads its `_bg.wasm` from disk and
  calls the package's synchronous `initSync`: no fetch, no DOM, no GPU surface.
- **Dispatch.** Requests go through `handleMessage` as JSON envelopes, the form the
  editor's worker uses. A document is loaded through `loadDocumentDirect`.
- **Host.** A loaded bundle gets a host built by `createBundleHost` for its own manifest,
  with `capabilityMode` defaulting to `enforce`, so the namespace rule and the capability
  gate apply as in the editor.
- **Recorded doors.** Tools, panels, schema panels, commands, keybindings, overlays, edit
  contexts, object types, importers and exporters are appended to a `contributions` log.
- **Protocol pin.** The loader reads the `// Synced from @paged-media/canvas-wasm@<version>`
  stamp of the vendored wire types, takes the package minor as the protocol, and throws if
  the booted wasm reports another. It also throws when the engine package cannot be
  resolved: "No warn-skip".

## Evidence

- `packages/plugin-sdk/src/wasm-loader.ts:25-35`, `:234-249` — the Node boot through
  `initSync`, and what it does without
- `packages/plugin-sdk/src/wasm-loader.ts:148-171`, `:251-275`, `:190-226` — the stamp and
  the derived protocol; the mismatch error; the resolution anchors and the refusal
- `packages/plugin-sdk/src/harness.ts:336-344`, `:739-755` — the envelope dispatch; the load
- `packages/plugin-sdk/src/harness.ts:463-471`, `:584-644`, `:770-780` — recording
  registries; the shared adapter; the enforced host for a loaded bundle
- `packages/plugin-sdk/package.json:27-28`, `packages/plugin-api/src/wire.d.ts:4`,
  `.github/workflows/vitest.yml:58-59` — the engine as a devDependency at `0.64.0`, equal to
  the stamp; CI runs the harness suite
- `plugin-draw: packages/draw-bundle/test/conformance/host.ts:56-91`,
  `plugin-web: packages/web-bundle/test/conformance/host.ts:42-43` — the two consumers

## Alternatives considered

A mock host: the fake editor stays for adapter tests only. Skipping when no engine is
installed: the loader "Throws (never warn-skips)", because "a headless host with no engine
behind it is the exact fiction the harness exists to prevent"
(`packages/plugin-sdk/src/wasm-loader.ts:175-177`).

## Consequences

Two plugin repositories use the harness: plugin-draw (41 spec files) and plugin-web (five).
plugin-doc hand-rolls a recording host for its activation test because its assertions
"need no engine at all" (`plugin-doc: packages/doc-bundle/test/activate.spec.ts:42-49`).
plugin-image, plugin-sheets, plugin-data and plugin-publish do not call it. plugin-web
applies the same no-skip rule to its own wasm: under `REQUIRE_REAL_ENGINE=1` a missing
artifact fails its suites (`plugin-web: .github/workflows/vitest.yml:74-87`).

A consumer has to bring the engine, which plugin-sdk carries only as a devDependency.
plugin-draw declares its own (`plugin-draw: packages/draw-bundle/package.json:21`) and
passes `resolveFrom`. plugin-web passes none and no `package.json` in that repository
names the engine package, so resolution there rests on the loader's remaining anchors.

The protocol pin depends on a file path. The loader reads the stamp from
`../../plugin-api/src/wire.d.ts` relative to its own module
(`packages/plugin-sdk/src/wasm-loader.ts:136-143`). plugin-api's `files` list names `dist`
and `src/manifest.schema.json`, and its build copies the wire types to `dist/wire.d.ts`
(`packages/plugin-api/package.json:13-16`, `:41`). When the stamp file cannot be read the
reader returns `null`, and without a stamp or an `expectedProtocol` option the comparison is
not made (`packages/plugin-sdk/src/wasm-loader.ts:153-158`, `:251-259`). Neither consumer
passes `expectedProtocol`.

The harness does not replay a tool's gesture event by event and loads one bundle per host.
It activates through its own `loadBundle` method, which checks the `apiVersion` range and
calls `activate`; the exported `loadBundle` and its lifecycle are described in
[ADR 304](304-bundle-lifecycle.md). A comment contradicts the code:
`packages/plugin-sdk/src/harness.ts:49-50` lists edit contexts and object types as doors that
throw; they are recorded (`packages/plugin-sdk/src/harness.ts:620-644`).

## Related

- [ADR 301](301-host-adapter-lives-in-plugin-sdk.md), [ADR 302](302-vendored-wire-types.md), [ADR 305](305-doors-always-present.md) — the adapter the harness reuses; the stamp the pin reads; why recorded doors still answer
- [ADR 200](https://github.com/paged-media/editor/blob/main/docs/adr/200-engine-as-npm-wasm-packages.md), [ADR 006](https://github.com/paged-media/core/blob/main/docs/adr/006-protocol-coupled-versioning.md) — the published engine package and its version scheme

## Amendment, 2026-10-18

The comment noted above is corrected. The harness now lists edit contexts, object types,
importers, exporters and schema panels as recorded doors. It also gains the other half of the
manifest gate. `checkManifestConformance(bundle, options)` activates a bundle in `'warn'` mode
and returns, per contribution category, what the manifest declares that was never registered
and what was registered without being declared. Its `drive` step plays the trigger a lazy
registration waits on. An allowance excuses a gap only if it gives a reason, and an unused
allowance fails the check. `diffManifestContributions` exposes the comparison on its own.
`HarnessOptions` also gains `pages`, so a test can answer `viewport.pages@1`. The editor runs
the check over all nine built-in bundles (editor ADR 226).

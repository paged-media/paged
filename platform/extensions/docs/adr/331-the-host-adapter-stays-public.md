# ADR 331 — The host adapter stays in the public SDK; the first-party packages leave this tree

- **Status:** Accepted, 2026-10-19.
- **Scope:** `packages/plugin-sdk/src/host-impl.ts`, `load.ts`, `wasm-bundle-loader.ts`
  (`WASM_BUDGETS`), `core-objects-v70.ts`, `harness.ts`, the new `testing.ts`; the
  `@paged-media/ai` and `@paged-media/cli` packages that lived under `packages/`. Confirms
  [ADR 301](301-host-adapter-lives-in-plugin-sdk.md) and
  [ADR 309](309-conformance-against-real-engine.md) against the monorepo plan's wave C item
  12, and amends [ADR 324](324-node-cli-over-the-headless-host.md) and
  [ADR 325](325-claude-agent-package.md) (where the packages live).

## Context

Wave C of the monorepo plan proposed slimming the public SDK by moving its host-only code
(`host-impl.ts`, `WASM_BUDGETS`, and `core-objects-v70.ts` if the engine floor is at least
71) to an internal package under `platform/shared`, the public harness re-exporting what it
needs, and by moving `ai` and `cli` out of this tree.

Measured at `4be5f0eba`:

- **The public harness is built on the adapter.** `createHeadlessHost` activates a bundle
  through `createBundleHost`, so a conformance run gets the real namespace gates, capability
  checks and door answers (ADR 309). A community author's activation test calls
  `loadBundle(() => fake.editor, bundle, { console, storage })`, as `plugin-template`'s does
  and the release consumer test asserts.
- **A published package cannot depend on a private one.** `platform/shared/*` is never
  published (PM-0002, PM-0008). Inlining it into plugin-sdk's `dist/` at build time would also
  need a declaration bundler (the harness's option types are the adapter's), and it would
  create a run-time cycle: the adapter uses about ten of the SDK's own modules
  (`object-registry`, `object-schema`, `disposables`, `schema-panel`, `widgets-fallback`, the
  core seam), so either they move too, and the SDK becomes a shell over private code, or the
  private package imports the public one that inlines it. The boundary lint
  (`platform/extensions` imports only the public packages) says the same.
- **`WASM_BUDGETS` is bundle-side.** It is the limit `loadBundleWasm` applies when a bundle
  loads a raw wasm module, and the `paged-plugin` bin's manifest check mirrors it.
- **`core-objects-v70.ts` is not only a fallback.** The engine floor is the vendored wire's
  protocol (74; the harness refuses any other), so the pre-71 *dispatch* in
  `core-objects.ts` is unreachable in a supported configuration. But the file is the table the
  protocol-71 seam delegates to (kinds, labels, the query fallback, commit, change events), so
  it cannot move or go.
- **`ai` and `cli` are first-party.** Both are private (PM-0008), and the editor, the test kit
  and the Node CLI use them; only history put them in the community-facing tree, where they
  needed their own exception in the import boundary.

## Decision

1. **The host adapter, the loader, the budgets and the core seam stay in
   `@paged-media/plugin-sdk`.** ADR 301 and ADR 309 stand. Nothing moves to a host-runtime
   package.
2. **What community suites hand-rolled is public instead:** `mapBacking()` (an in-memory
   `StorageBacking`) and `silentConsole`, beside the harness in `src/testing.ts`; the gesture
   kit's `createFakeEditor()` gains `ids(registry)`, so it is the editor an activation test
   passes to `loadBundle`. The harness keeps one in-memory storage for all its hosts unless
   `storage` is given (it fell back to `localStorage`, shared between tests in a browser-like
   realm, and gave each host a fresh map otherwise: finding HOST-1).
3. **`@paged-media/ai` moves to `platform/shared/ai` and paged-node to `apps/cli`.** This tree
   holds the two public packages only, and its boundary allows the public `@paged-media`
   packages and nothing else.
4. **The pre-71 dispatch of the core seam stays for now.** Removing it (the probe and the v70
   selection in `core-objects.ts`, the `protocol < 71` guards) would delete a tested path and
   about 60 lines; it is worth doing with the next change to the seam, not on its own.

## Consequences

- The tarball keeps the adapter (about 4.6k lines); the harness and `loadBundle` keep working
  for community suites, and the editor still installs one adapter for every bundle.
- The suites of the built-ins import `mapBacking` and `silentConsole` from the SDK: 25 copies
  of the one and 103 of the other are gone. The generic fake editors of draw's and web's
  activation specs are the SDK's now; the domain fakes stay (image's resource channel and
  placed-image store, sheet's multi-document host, this package's own adapter-test editor).
- `ai` and `cli` may use the internal shared packages (`ai` takes `@paged-media/helpers`'
  base64). Their tests still read fixtures from `packages/plugin-sdk/test` by path, and `ai`
  reads plugin-api's vendored catalog by path.
- ADRs 324 and 325 stay in this directory, with a note on where the packages are.

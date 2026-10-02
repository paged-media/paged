# ADR 300 — The contract package is type-only; values reach a bundle through the host object

- **Status:** Accepted. Recorded retroactively on 2026-10-02 from the code at `d90f727`.
- **Scope:** `packages/plugin-api`, and the split between it and `packages/plugin-sdk`

## Context

A plugin bundle is built outside the editor's repository and compiles against a description
of what the host offers. If that description carried runtime code, importing it would pull
that code into every bundle.

`CLAUDE.md:19-22` states the concern: a value export would drag host code (React, the wasm
loader) into bundle module graphs and break host-free unit testing in plugin repos.
`DESIGN.md:30-35` adds a second one: the same bundle source is meant to run in-process today
and behind an isolate RPC later, and the "host object is the thing that gets proxied, not
the bundle".

## Decision

`@paged-media/plugin-api` exports types only. Every host value a bundle touches (facades,
registries, the logger, the document) is a member of the `BundleHost` object passed to
`activate(host)`.

- Every export statement in `src/index.ts` is `export type`. No hand-written `.ts` file
  under `packages/plugin-api/src` has a value export or a non-type import. The vendored
  declaration file `wire.d.ts` declares the engine package's class and functions; it emits
  no JavaScript and is re-exported only through `export type`.
- The build emits declarations only, copies the vendored `wire.d.ts`, and writes the literal
  `export {};` as the package's only JavaScript. The package's one dependency is
  `@types/react`.
- A bundle is `{ manifest, activate(host: BundleHost): BundleHandle }`. This repo defines no
  global through which a bundle could reach the host instead.
- What must exist at runtime lives in `@paged-media/plugin-sdk`: `API_VERSION`, `loadBundle`,
  the host adapter, helper functions. The one check inside plugin-api is a type-level
  assertion.

## Evidence

- `packages/plugin-api/src/index.ts:17-21` — the rule, stated at the package entry; `:34-186`
  the export statements, all `export type`
- `packages/plugin-api/package.json:37` — the build script: `tsc` declarations, copy of
  `wire.d.ts`, `export {};` written to `dist/index.js`; `:40-42` the single dependency
- `packages/plugin-api/tsconfig.build.json:5` — `emitDeclarationOnly`
- `packages/plugin-api/src/bundle.ts:33-36` — `PagedBundle`: a manifest and `activate(host)`
- `packages/plugin-api/src/host.ts:1553-1558` — `BundleHost`: types from the API package,
  values from this object
- `packages/plugin-sdk/src/version.ts:15-21` — `API_VERSION` lives in plugin-sdk because
  plugin-api "cannot carry a runtime constant"
- `packages/plugin-api/src/mutations.ts:391-397` — a drift check written as a type
  assertion, with the comment that even an unexported `const` would break the rule
- `DESIGN.md:30-35` — the tenet and its two stated consequences

## Alternatives considered

An ambient global (`paged.plugin.*`) was rejected: it "breaks multi-plugin teardown" and
isolate routing, while "handle-passing costs one parameter" (`DESIGN.md:710-711`).

## Consequences

A bundle can be type-checked and unit-tested with plugin-api installed and no host present;
the package adds nothing to a module graph at runtime.

plugin-api cannot hold a constant, a validator or a default. The repo shows the cost in
three places: `API_VERSION` sits in plugin-sdk; the manifest vocabularies exist as TypeScript
unions here and as runtime sets in the CLI, held together by a test
([ADR 303](303-manifest-schema.md)); the drift check in `mutations.ts` is a compile-time
assertion.

No test asserts the rule. What holds for consumers is the build: the published JavaScript is
`export {};` whatever the source contains.

Helper values are not received through the host. Bundles import `defineBundle`,
`contributeTool` and gesture helpers from `@paged-media/plugin-sdk` (for example
`plugin-draw: packages/draw-bundle/src/index.ts:21` and
`plugin-draw: packages/draw-bundle/src/activate.ts:61-65`). That package has one entry
point, which also contains the host adapter
([ADR 301](301-host-adapter-lives-in-plugin-sdk.md), [ADR 313](313-no-react-at-load.md)).

The host application has to construct the host object for each bundle
([ADR 301](301-host-adapter-lives-in-plugin-sdk.md)).

The RPC host the rule prepares for is not built in this repo. `DESIGN.md:682-695` lists
three `BundleHost` members that cannot cross such a boundary as they are: the `gesture()`
factory of `contribute.tool`, the React component of `contribute.panel`, and `host.editor`,
the raw editor handle (`packages/plugin-api/src/host.ts:1673-1679`).

## Related

- [ADR 301](301-host-adapter-lives-in-plugin-sdk.md) — where the host object is implemented
- [ADR 302](302-vendored-wire-types.md) — how the package came to own its types
- [ADR 304](304-bundle-lifecycle.md) — `activate(host)` and teardown
- [ADR 312](312-panels-as-data.md), [ADR 319](319-trust-line.md) — the panel form that can
  cross an isolate boundary; the boundary itself

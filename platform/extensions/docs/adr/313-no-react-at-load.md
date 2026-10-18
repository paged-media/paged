# ADR 313 — plugin-sdk loads without React; the build target is the gate

- **Status:** Accepted. Recorded retroactively on 2026-10-02 from the code at `d90f727`.
- **Scope:** `packages/plugin-sdk/src/react-optional.ts`, its two users (`schema-panel.tsx`,
  `widgets-fallback.tsx`) and the build script of `packages/plugin-sdk`

## Context

Two exports of plugin-sdk render: the fallback `CodeEditor` in `FALLBACK_WIDGETS` and the
component built by `makeSchemaPanelComponent`. Both sit on the static import graph of the
package's single entry (`index → host-impl → widgets-fallback / schema-panel`), so whatever
they import is loaded by every consumer, including one that only wants `loadBundle`.

Each of two requirements was broken once by a fix for the other. Both are recorded in
`packages/plugin-sdk/src/react-optional.ts:20-41` and `DESIGN.md:637-658`:

1. A static `import … from "react"` made the package fail with `ERR_MODULE_NOT_FOUND`
   wherever React is not installed. "That is what silently broke all 22 of plugin-draw's
   test files against the published canary". Fixed in commit `fc50fe9` (2026-07-26).
2. That fix resolved React with a top-level `await import("react")`. tsup emits it as
   written, and Vite's dependency optimiser compiles pre-bundled dependencies to an ES2020
   floor, "where top-level await does not exist — so pre-bundling the published package
   fails the consuming dev server outright". Fixed in commit `33e21d0` (2026-08-05).

## Decision

plugin-sdk must load where React is not installed, and its emitted bundle must contain no
top-level await. One internal module resolves React without awaiting it, and the build
target is pinned so that a top-level await cannot be emitted.

- React is a peer dependency marked optional.
- `react-optional.ts` calls `import("react")` at module scope with `void`, not `await`, and
  stores `createElement` when the promise settles. Module evaluation stays synchronous.
- The two render paths get `createElement` through `requireCreateElement(message)`, which
  reads the cached value and throws the caller's message when React is absent, with a
  suffix when the import has not settled yet. Neither file uses JSX.
- The build is `tsup … --target es2020`. `DESIGN.md:674-678` gives the reason: esbuild
  cannot lower a top-level await, so at that target one "fails `pnpm build` here instead of
  a consumer's dev server. That is the gate, not the fix".
- A test asserts on the built `dist/index.js` (no static React import, an `import("react")`
  present, no `await import("react")`) and on `package.json` (a build target that cannot
  represent top-level await, the optional peer).

## Evidence

- `packages/plugin-sdk/src/react-optional.ts:20-61`, `:65-80`, `:88-95` — the record; the
  cache and the floating import; `requireCreateElement`
- `packages/plugin-sdk/src/schema-panel.tsx:48-55`,
  `packages/plugin-sdk/src/widgets-fallback.tsx:36-46` — the two render paths
- `packages/plugin-sdk/package.json:13`, `:19-26` — `--target es2020`; the optional peer
- `packages/plugin-sdk/test/react-free-import.spec.ts:59-113` — the assertions on the
  built artifact and on the build script
- `.github/workflows/vitest.yml:50-56`, `.github/workflows/publish.yml:39-43` — both
  workflows build before running the suite
- `packages/plugin-sdk/src/index.ts:76`, `:83` — the two public exports that render
- `DESIGN.md:637-678`, `:721-740` — the section and the rejected alternatives

## Alternatives considered

Injecting `createElement` through `BundleHost`: "Rejected on cost, not on principle",
because both renderers are public exports and the change would break their signatures;
"Revisit if a THIRD renderer appears, or at the next major" (`DESIGN.md:721-731`). A
build-level answer alone, or a separate `@paged-media/plugin-sdk/react` entry: "cannot
work", since lowering the target only moves the error into this build and a subpath would
"relocate the top-level await rather than remove it" (`DESIGN.md:732-740`). The top-level
await itself shipped and is breakage 2 above.

## Consequences

A consumer without React can import the package: a plugin repository's Node test run, or
the headless harness ([ADR 309](309-conformance-against-real-engine.md)).

The render paths depend on a timing argument that the module states rather than enforces:
an `import()` of an already-loaded module settles before React renders a plugin panel
(`packages/plugin-sdk/src/react-optional.ts:48-57`). When that does not hold, the result is
a thrown error naming the cause, not a wrong render.

The gate is one flag in a build script. Raising the target to ES2022 or later removes it;
the test fails in that case (`packages/plugin-sdk/test/react-free-import.spec.ts:61`,
`:94-106`). The tests that read the built file return early when `dist` does not exist
(`:65-70`, `:80`), so a local run without a prior build passes without checking it. The
two workflows build first for that reason.

Type-only imports from React remain in plugin-api and in `schema-panel.tsx`. They produce
no runtime import.

## Related

- [ADR 300](300-type-only-contract.md) — values come from the host; the rejected alternative would have applied that rule here
- [ADR 312](312-panels-as-data.md), [ADR 306](306-canary-releases.md) — the schema panel whose component is one of the two renderers; the published artifact the test inspects
